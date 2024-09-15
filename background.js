// Create a context menu item for suggesting a hyperlink
chrome.contextMenus.create({
    id: "suggestLink",
    title: "Suggest a Hyperlink",
    contexts: ["selection"]
});

// Handle clicks on the context menu item
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "suggestLink") {
        const url = tab.url;
        chrome.storage.local.set({'source_url': url}, () => {
            console.log('Stored source URL:', url);
        });

        chrome.action.openPopup(); // Open the popup defined in the manifest
        // No message to content script here since we want the popup to handle it
        // The popup will send the message to the content script after submission
    }
});

// Listener for when a new site is loaded
chrome.webNavigation.onCommitted.addListener(function(details) {
    if (details.frameId === 0) { // Ensure it's the main frame
        chrome.storage.local.get(['source_url'], (result) => {
            
            const url = result.source_url || '';
            fetchPostIts(url);
        })
          }
        
    });

// Function to fetch post-it notes from the server
function fetchPostIts(url) {
    fetch(`https://greenwich-for-chrome.replit.app/getPostIts?sourceUrl=${encodeURIComponent(url)}`)
        .then(response => response.json())
        .then(data => {
            // Handle the data (e.g., store it or send it to contentScript.js)
            console.log('Fetched post-its:', data);
            // Save data to chrome.storage.local
            chrome.storage.local.set({ 'postIts': data });
            console.log('saved existing post its to local storage');
        })
        .catch(error => {
            console.error('Error fetching post-its:', error);
        });
}
