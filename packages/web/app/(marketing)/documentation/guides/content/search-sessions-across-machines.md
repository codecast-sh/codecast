Claude Code keeps each conversation on the computer that ran it. Yesterday's session on your laptop isn't on your desktop, and a session on a cloud machine or a teammate's computer isn't on either. Codecast puts them in one place: every computer you connect sends its sessions to your account as they happen, and you search all of them from the web at codecast.sh, the Mac app or your iPhone.

![The search page with the query "webhook retry", its Everyone, Any message, Any time and Recent filters, and sessions with the matching messages highlighted](/documentation/search-sessions-across-machines/search.webp "One search over every machine. Each result is a session, with the messages that matched.")

## Set it up

Install codecast and sign in on each computer your agents run on ([Getting started](/documentation#getting-started) walks through it). There is nothing else to turn on. From then on, every session on that computer is recorded and searchable, whether it ran in Claude Code, Codex, Cursor, Gemini, pi or Grok.

## Search from anywhere

Press **⌘K** anywhere in the app and start typing. Sessions with matching messages appear as you type, along with tasks, plans, docs and people that match.

![The command palette open over the inbox, with "webhook" typed and matching sessions and tasks listed](/documentation/search-sessions-across-machines/palette.webp "⌘K searches as you type. ⌘↵ opens the full search page.")

## Narrow it on the search page

Press **⌘↵** from the palette to open the full search page. Tabs across the top split results into **All**, **Sessions** and the other kinds that matched. Four menus on the right narrow sessions:

| Menu | Choices |
|------|---------|
| **Everyone** | Sessions from everyone you share with, or **Only mine** |
| **Any message** | Everything said in a session, or **My prompts**, only the lines you typed |
| **Any time** | **Past week**, **Past month** or **Past 3 months** |
| **Recent** | Newest first, or **Relevant** for best match first |

Put a phrase in quotes to match it exactly; words without quotes match anywhere in the session. The empty search page shows a row of filters you can add to the query by clicking them:

![The empty search page with a row of filter chips: file:, commit:, pr:, label:, author:, repo:, after:, before:](/documentation/search-sessions-across-machines/filters.webp "Click a chip to add it to the search, then type its value.")

| Type | To find |
|------|---------|
| `file:src/webhooks.ts` | Sessions that edited a file or folder |
| `commit:3f2a91c` | The session that made a commit |
| `pr:482` | Sessions linked to a pull request |
| `author:me` | Sessions a particular person ran |
| `repo:acme-api` | Sessions in one repository |
| `label:api` | Sessions you filed under a label |
| `after:7d`, `before:2026-09-01` | Sessions active after or before a time |

## Read the results

Each result is a session. Under its title you see the matching messages, who said them (you or the agent) and when. Click a message to open the conversation at that point. When a session handed work to helper sessions, the result says how many of them matched too. Right click a result to open it in a new tab or copy a link.

The page address keeps your whole query, so a narrowed search is a link you can bookmark or send to a teammate.

## On your iPhone

Pull the inbox down a little, or tap the search icon, and the search box appears above your sessions. It searches the same history and takes the same filters.

![The phone inbox with the search box open above the session list and "webhook" typed](/documentation/search-sessions-across-machines/phone-search.webp "The phone searches the same history. Pull the list down to reveal the box.")

## Let your agents search it

With [Memory](/documentation/memory) on, your agents search this same history themselves, from whichever computer they run on. Ask "what did we decide about the schema in yesterday's session on my laptop?" and the agent finds it and answers with a link to the session.

## What it covers

- **Your sessions, and your team's shared ones.** A teammate's session appears only if it is shared with the team. Which folders are shared, and which stay private to you, is set per folder; see [Team sessions](/documentation/team-sessions).
- **Every message for the last 30 days, titles and summaries before that.** Older sessions match by their title and summary, and the search page says so above the results.
- **Only computers running codecast.** A computer that has never had codecast installed and signed in adds nothing.

## If you only use one computer

Claude Code's own `claude --resume` lists recent sessions for the folder you are in, on that computer. Open source tools such as [search-sessions](https://github.com/sinzin91/search-sessions) and [LLMnesia](https://www.llmnesia.com/blog/search-claude-code-conversation-history) search the full text of the session files on one computer and keep everything on it. If your work lives on one machine and only you need it, those are less to set up. Codecast is for history spread across several computers, agents or people.

## For agents and scripts

`cast search` takes the same query, filters included, from a terminal. It is what agents run when Memory is on.
