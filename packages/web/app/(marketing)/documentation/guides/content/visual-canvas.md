Some answers are easier to see than to read: a comparison, a before and after, a breakdown, a flow. With the Visual Canvas on, an agent can answer with a small designed panel right in the conversation, with charts, cards, tables and diagrams, instead of a wall of text or ASCII art. Plain text stays the default. The agent reaches for a canvas only when the shape of the answer carries the meaning.

![A conversation where the agent answered with a canvas: a bar chart of build times and three comparison cards](/documentation/visual-canvas/conversation.webp "Asked to compare three static site generators. The answer is one canvas, a chart and a row of cards, and one sentence of recommendation under it.")

## Turn it on

1. Open **Agent features** from your account menu and pick the computer your agents run on.
2. Switch on **Visual Canvas**, under *Showing the work*.

That's all. Agents started from then on know how to draw one. Click **How it works** on the card to see what it adds and a request to try.

![The Visual Canvas detail in Agent features](/documentation/visual-canvas/visual-feature.webp "The Visual Canvas detail. The switch at the top right turns it on for the selected computer.")

## Ask for it in plain words

Say what you want to see. Mentioning a visual helps, but agents also choose one on their own when it fits:

- "Compare the three caching options as a visual."
- "Show me the error rate by hour, before and after the fix."
- "Draw the flow of a webhook from the provider to our database."
- "Lay out the open pull requests by status."

## What you see

```figure
CanvasThemesFigure
Real canvases, drawn by the same component the app uses. Pick an example or a theme: a canvas follows whichever theme you use.
```

- **It matches the app.** A canvas uses the app's fonts and colors, and follows you when you switch between light and dark themes.
- **Controls in its header.** The header shows the canvas's title, a button to see the source behind it, a copy button, and a fullscreen button. Press **Esc** to leave fullscreen.
- **Long ones fold.** A tall canvas folds behind a **Show all** button so it never swallows the conversation.
- **Small interactions work.** Tabs, tables you sort by clicking a header, tooltips on hover, and charts with hover labels.
- **Pictures, not file paths.** When an agent wants to show you a screenshot or a chart it rendered, it uploads the image, and the picture appears in the message instead of a path on its machine that your browser can't open.

A canvas is part of the message. It stays in the transcript, appears for teammates reading the session, and shows in shared links and in [decisions](/documentation/decisions), where an agent can lay options side by side. On the iPhone app a canvas shows as a card with its title; tap it to open it full screen.

## What it will and won't do

Conversations sync across your team, so a canvas is something other people see without having written it. It is built to be safe to look at:

- **No code runs.** Scripts, forms, embedded frames and anything that reacts to clicks are removed before the canvas appears. Tabs, sorting and charts are codecast's own, not the agent's.
- **Nothing phones home.** Images from other websites are dropped, so a canvas can't track who opened it. Images an agent uploaded to codecast, and images drawn inside the canvas, show normally.
- **It stays in its box.** A canvas can't restyle the app around it, and links in it open in a new tab (links to codecast's own sessions and tasks open in the app).

## Canvas or page?

A canvas lives inside the conversation. When the result is something you will send to other people by link, a report for a stakeholder or a dashboard that should run its own code, ask for a [published page](/documentation/publish) instead.
