# greenwich
Suggest related links for any webpage and view existing suggestions from other users. Suggestions appear as superscripts to the relevant sentences and clicking them shows the link to the suggested related link. We call this collective contextualization!

# API endpoints
/getPostIts
GET endpoint for grabbing all existing suggested links for a given webpage.

/addPostIt
POST endpoint for adding a new suggested link for a given webpage.

Requires:
source_url (the url of the webpage a suggestion is being made for)
suggestion_id (a randomized unique id)
highlighted_text (the portion of text a suggestion is being added to, the superscript will appear on this section)
suggested_link (the related link being suggested)
description (a brief description of why a suggested link is being added)
timestamp (optional, time of suggestion)
