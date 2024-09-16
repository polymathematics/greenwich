window.onload = () => {
    console.log('loading page');
    // Add a 2-second delay before calling the function
    setTimeout(() => {
        loadAndDisplayPostIts();
    }, 1000); // 2000 milliseconds = 2 seconds
};

// Inject CSS for post-it notes (only once)
const style = document.createElement('style');
style.textContent = `
    .post-it-note {
        background-color: #41ad38;
        border: 1px solid #333;
        padding: 10px;
        border-radius: 5px;
        box-shadow: 0 0 5px rgba(0, 0, 0, 0.3);
        max-width: 300px;
        z-index: 10000;
        overflow-wrap: break-word;
        color: white;
    }

    .post-it-header {
        font-weight: bold;
        margin-bottom: 5px;
    }

    .post-it-note a {
        color: #FFFF99;
        text-decoration: underline;
    }
`;
document.head.appendChild(style);

// Detect when text is selected
document.addEventListener('mouseup', function () {
    const selectedText = window.getSelection().toString().trim();
    if (selectedText.length > 0) {
        // Notify the background script about the selected text
        chrome.runtime.sendMessage({ type: "textSelected", text: selectedText });
        console.log(selectedText);
        chrome.storage.local.set({'currentSelectedText': selectedText});
    }
});

// Listen for messages from the popup.js script for when a user has submitted a suggestion
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "suggestLink") {
        // Create and display the post-it note with the suggested link
        createPostItNote(message.text, message.url);
    }
});
// this inserts notepage superscripts for existing suggestions from our database when a website loads
function createExistingNotes(section, url, description) {

    const superscript = document.createElement('sup');
    superscript.textContent = '📄'; // Or any other symbol you prefer
    superscript.id = 'post-it-note';
    superscript.style.color = 'green';
    superscript.style.cursor = 'pointer';
    superscript.style.fontSize = '0.8em';
    superscript.style.marginLeft = '5px';

    // Function to recursively search text nodes and insert superscript and adds an event listener for when they are clicked, which calls showPostItNote
    function searchAndInsert(rootNode) {
        if (rootNode.nodeType === Node.TEXT_NODE) {
            const textContent = rootNode.textContent;
            const sectionIndex = textContent.indexOf(section);
            if (sectionIndex !== -1) {
                // Split text content into three parts
                const beforeText = textContent.slice(0, sectionIndex);
                const sectionText = textContent.slice(sectionIndex, sectionIndex + section.length);
                const afterText = textContent.slice(sectionIndex + section.length);

                // Create new nodes
                const textBefore = document.createTextNode(beforeText);
                const textSection = document.createTextNode(sectionText);
                const textAfter = document.createTextNode(afterText);

                // Create a new document fragment to hold the new nodes
                const fragment = document.createDocumentFragment();
                fragment.appendChild(textBefore);
                fragment.appendChild(textSection);
                fragment.appendChild(superscript); // Add superscript after the section text
                fragment.appendChild(textAfter);

                // Replace the original text node with the new fragment
                rootNode.parentNode.replaceChild(fragment, rootNode);
                document.getElementById('post-it-note').addEventListener('click', () => showPostItNote(description, url, superscript));
                return true; // Stop searching as we have inserted the superscript
            }
        } else if (rootNode.nodeType === Node.ELEMENT_NODE) {
            // Recursively search child nodes
            for (let i = 0; i < rootNode.childNodes.length; i++) {
                if (searchAndInsert(rootNode.childNodes[i])) {
                    return true;
                }
            }
        }
        return false;
        
    }

    // Start searching from the body or a specific root element
    searchAndInsert(document.body);
}
 // Function to show the post-it note when a superscript is clicked and remove it when user clicks away
 function showPostItNote(selectedText, url, superscript) {
    // Remove existing post-it notes if any
document.querySelectorAll('.post-it-note').forEach(el => el.remove());
    // Create the post-it note element
    const postIt = document.createElement('div');
    postIt.className = 'post-it-note';
    postIt.innerHTML = `
        <div class="post-it-header">Suggested Link</div>
        <p>${selectedText}</p>
        <a href="${url}" target="_blank">${url}</a>
    `;
    
    // Position the post-it note near the superscript
    const rect = superscript.getBoundingClientRect();
    postIt.style.position = 'absolute';
    postIt.style.left = `${rect.left + window.scrollX}px`;
    postIt.style.top = `${rect.bottom + window.scrollY}px`;
    
    // Add post-it note to the document
    document.body.appendChild(postIt);
     // Function to handle clicks outside of the post-it note
     function handleClickOutside(event) {
        if (!postIt.contains(event.target) && event.target !== superscript) {
            postIt.remove();
            document.removeEventListener('click', handleClickOutside);
        }
    }

    // Add event listener to document
    document.addEventListener('click', handleClickOutside);
}

// this function is only called when a user first adds a link suggestion, it adds the notepage superscript to indicate a suggestion has been made
function createPostItNote(selectedText, url) {
    console.log('called create post it note function');
    
    // Create the superscript element
    const superscript = document.createElement('sup');
    superscript.textContent = '📄'; // Or any other symbol you prefer
    superscript.id = 'post-it-note';
    superscript.style.color = 'green';
    superscript.style.cursor = 'pointer';
    superscript.style.fontSize = '0.8em';
    superscript.style.marginLeft = '5px';
    
    // Detect when text is selected
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);

        // Insert the superscript element at the end of the selection
        const endContainer = range.endContainer;
        const endOffset = range.endOffset;

        // Create a new range to insert the superscript
        const newRange = document.createRange();
        newRange.setStart(endContainer, endOffset);
        newRange.collapse(true);
        
        // Create a fragment from the superscript's outerHTML
        const fragment = newRange.createContextualFragment(superscript.outerHTML);
        const insertedSup = fragment.querySelector('sup'); // Get the actual <sup> from the fragment

        // Add the event listener to the inserted <sup> element
        insertedSup.addEventListener('click', function () {
            console.log('post it note superscript was clicked!');
            showPostItNote(selectedText, url, insertedSup)
        });

        // Insert the fragment (with the event listener attached) into the DOM
        newRange.insertNode(superscript);
    }
}

// Function to load and display existing post-its
function loadAndDisplayPostIts() {
    console.log('running create post it function');
    chrome.storage.local.get('postIts', (result) => {
        console.log('Fetched post-its from storage:', result);
        const postIts = result.postIts || [];
        postIts.forEach(postIt => {
            createExistingNotes(postIt.highlighted_text, postIt.suggested_link, postIt.description);
        });
    });
    
}






