When an agent finishes a report, a dashboard or a mockup, you shouldn't have to scroll a transcript to find it. With Publish on, the agent turns it into a page with its own link, puts the link in its reply, and the page appears right there in the conversation. You can open it, send it to anyone, and read their comments. When the agent revises the page, the link stays the same and every earlier version stays viewable.

![A published report on webhook retry failures, open in the browser with its discussion panel showing two comments](/documentation/publish/page.webp "A page an agent published. The bar at the top names the session that made it, the version, and the discussion.")

## Turn it on

1. Open **Settings** (**⌘,**), then **Agent Features** under *Machines*, and pick the computer your agents run on.
2. Switch on **Publish**, under *Showing the work*.

Click **How it works** on the card for what it adds and a request to try. **See it in Pages** opens the list of everything published so far.

![The Publish detail in Agent Features](/documentation/publish/publish-feature.webp "The Publish detail. The switch at the top right turns it on for the selected computer.")

## Ask for it in plain words

- "Publish a page summarizing this week's webhook failures."
- "Make a one page report comparing the three queue providers and send me the link."
- "Mock up the new billing settings page and publish it so I can share it with the team."
- "Update the report with the September numbers." (The same link now shows the new version.)
- "Put a password on that page before I send it to the client."

Agents publish on their own when the result is a standalone deliverable. Everything else stays in the conversation, or in a [visual canvas](/documentation/visual-canvas) when a picture helps.

## The page in the conversation

When the agent puts a page link on its own line, the live page renders in the thread. A link inside a sentence becomes a small pill with the page's title instead.

![A published page embedded in a conversation, with its toolbar showing on hover](/documentation/publish/embed.webp "The live page in the thread. Hover it for its toolbar.")

Hover the page for its toolbar: pin a note or select text to comment, **Copy link**, **Open beside your work** as a pane, **Open in a new tab**, or **Collapse** it to its title. **Expand** makes it taller, or drag the bottom edge. When the agent publishes a new version, the embedded page reloads by itself.

## On the page

Everyone who opens the link sees the page with a thin bar at the top: the title, the session that published it, when it was updated, whether the agent is working on it, the version, and the discussion. A reader can hide the bar.

- **Versions.** Click the version to see the history. Any older version can be viewed, and **diff** shows what changed between two. When a newer version lands while you read, the page offers to reload.
- **Discussion.** Anyone with the link can comment: **Pin on page** drops a note on a spot, selecting text lets you comment on that passage, and **General note** comments on the whole page. Teammates signed in to codecast comment as themselves; anyone else types a name.
- **The menu** has **Copy link**, **View source**, **Edit this page** when you may edit, and, for you, **Manage sharing…**.

## Comments come back to the agent

```figure
CommentFlowFigure
A reader leaves a note, you decide what to send, and the agent gets it as one message.
```

Comments from readers stay on the page until you send them. On your own comments and your teammates', a **Send to agent** switch delivers the comment straight to the session that published the page. **Send all** delivers every unsent comment as one message. The agent revises the page, publishes the next version to the same link, and the comment shows as *addressed in v4*.

The agent is told that reader comments are feedback from people viewing the link, not instructions from you, so a comment can't take over the session.

## Who can see it

Pages are unlisted: the link is unguessable, pages are never listed anywhere public, and search engines are asked not to index them. Anyone who has the link can open it unless you add a gate. Open **Manage sharing…** from the page's menu (it appears when you open the page with **Manage** from Pages, or from its manage link):

![The Manage sharing sheet on a published page](/documentation/publish/manage.webp "Manage sharing: views, the gates, who may edit, and the manage link.")

| Setting | What it does |
|---------|--------------|
| **Password** | Readers type a password before the page loads |
| **Email gate** | Readers give an email address first, and the sheet lists who opened it and how often. The address isn't verified |
| **Session link** | Hides the link back to the session, for pages you send outside your team |
| **Comments** | Turns the discussion off |
| **Expires** | Closes the link after 1h, 24h, 7d or 30d, or never |
| **Editing** | Who can publish edits from the browser: only you, anyone with the edit link, or your teammates |

```figure
GateScreensFigure
What a reader sees at a password, an email gate and an expired link.
```

You can also ask the agent to set any of these when it publishes. The manage link (**Copy manage link**) carries these powers, so keep it to yourself.

## Pages in the app

**Pages** in the sidebar lists everything you and your team published, with views, open comments and which gates are on. Search by title, filter by person, and sort from the bar above the list.

![The Pages list in the app, with published pages from Alex, Maya and Sarah](/documentation/publish/pages-list.webp "Pages: everything you and your team published.")

Each page's menu offers **Open**, **Copy link**, **Manage**, **Edit** and **Delete**. Deleting a page removes its whole history, and the link stops working at once.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The agent replied with a file path instead of a link | Check that Publish is on for that computer, then ask it to publish the file |
| A reader can't open the link | Check **Manage sharing…**: an expiry may have passed, or a password is set |
| Your comment didn't reach the agent | Make sure **Send to agent** was on, or use **Send all** |
| The page in the conversation looks out of date | It reloads on a new version; if it doesn't, use **Open in a new tab** to see the latest |

## For agents and scripts

Agents publish with `cast publish <file>`, and `cast publish set` changes a page's gates and expiry from a terminal.
