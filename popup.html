document.addEventListener('DOMContentLoaded', () => {
    // Handle form submission
    document.getElementById('submit-btn').addEventListener('click', () => {
        // Retrieve values from the form
        const url = document.getElementById('link-url').value;
        const description = document.getElementById('description').value;

        // Retrieve stored values from session storage
        chrome.storage.local.get(['currentSelectedText', 'source_url'], (result) => {
            const selectedText = result.currentSelectedText || '';
            const source_url = result.source_url || '';

            console.log('Selected Text:', selectedText);
            console.log('Source URL:', source_url);

            if (url && description && selectedText && source_url) {
                // Send message to content script to create the post-it note
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        type: "suggestLink",
                        text: description,
                        url: url
                    });
                });

                // Prepare the new suggested link for our API call
                const postData = {
                    source_url: source_url,
                    highlighted_text: selectedText,
                    suggested_link: url,
                    description: description
                };

                // Send the POST request to the backend API
                fetch('https://greenwich-for-chrome.replit.app/addPostIt', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(postData)
                })
                .then(response => response.json())
                .then(data => {
                    console.log('Post-it note saved:', data);
                })
                .catch(error => {
                    console.error('Error saving post-it note:', error);
                });
            } else {
                alert('Please fill in all required fields.');
            }
        });
    });

    
});
