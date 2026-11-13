"Share this session" can mean three things. You want a teammate to read a conversation that already finished. You want someone to follow one that is still running. Or you want the team's sessions visible without anyone deciding to share each one. Codecast does all three, and each starts from the session itself.

![The share popover: What the team sees set to Full, Link access set to Restricted, and Copy link and Send to chat](/documentation/share-a-session/share-popover.webp "The share button at the right of a conversation's header.")

## Choose what the team sees

Open the session and click the share button at the right of its header. In a team workspace, **What the team sees** has three settings:

- **Hidden**: only you can see it, and it stays out of the team feed.
- **Summary**: the team feed shows the title and a summary of the work.
- **Full**: the team can read the whole conversation, live while it runs.

If the session lives in a repository you already share, the popover says *Shared automatically* and links to **Repo settings**. After you set a session to **Full**, the popover offers **Share all new sessions with** your team **in full**, so you don't have to do it one by one. Per-repository sharing lives in **Settings → Sync & Privacy**; [Team sessions](/documentation/team-sessions) covers it.

## Share a link

Under **Link access**:

- **Restricted**: only people who can already see the session can open the link. Use it to point a teammate at a session.
- **Anyone**: anyone with the link can read it, no sign in needed. The share button turns into a globe, so you can tell at a glance that the session is public.

Then click **Copy link**, or **Send to chat** to post it in a team chat channel. Someone who opens a public link sees the conversation read only, with no message box.

Before you make a session public, read it for anything private: tokens, customer names, internal links. Agents print what they see.

## Share a few messages

Often one answer is the part worth sending. Hover a message and click **Copy link to message**, or click **Share message** to pick several. Tick the messages you want, then **Copy share link** or **Send to chat**. Tick **Link full conversation** if the reader should be able to open the whole thing; that makes the conversation public.

![A conversation in selection mode: three messages ticked, with Link full conversation and Copy share link in the bar below](/documentation/share-a-session/share-messages.webp "Pick the messages to share, then copy the link.")

Whoever opens the link sees those messages, who shared them and when, and the session's title, with **View full conversation** when you linked it.

![The shared message page: Maya Ortiz's question, the agent's answer about webhook retry backoff, and when it was shared](/documentation/share-a-session/shared-messages-page.webp "What the reader sees when they open a message link.")

## Share from your phone

In a session on the phone, tap **More actions** in the header, then **Share**. The sheet sets what the team sees (**Private**, **Team sees the summary**, **Team sees everything**) and has **Copy share link**. Once the session has a link, **Share link via…** sends it through the iOS share sheet. Long press a message for **Copy link**, or **Share message** to send its text.

![The phone's share sheet over a session: Private, Team sees the summary, Team sees everything, Copy share link and Share link via…](/documentation/share-a-session/phone-share-sheet.webp "Sharing a session from the phone.")

## Watch a session while it runs

A session you can see in Codecast is live: new messages, commands and file changes appear as the agent writes them, on the web, in the Mac app and on your phone. So "watch this" is the same link as "read this". If the session needs input, the person who runs it can answer from any of those places.

## How this compares to other tools

```figure
ShareNeedsFigure
Three needs, four tools. Most tools answer one need well and leave the other two blank.
```

- **Claude Code's own sharing** works for sessions that ran in the cloud at claude.ai/code. You set a session to Team or Public and send the link; the reader sees it as it was when they opened it.
- **Lore** turns one conversation into a shareable thread, for Claude Code, Codex, Cowork and Amp.
- **Remote Control** lets you follow and steer one running Claude Code session from claude.ai or the Claude app, while it runs.
- **Codecast** records every session on every machine as it happens, for the folders you choose, and keeps them afterwards to search and link to.

They work together: a session you steer with Remote Control is still an ordinary Claude Code session on your machine, so Codecast records it like any other. See [Codecast vs Claude Code Remote Control](/compare/codecast-vs-claude-code-remote-control).
