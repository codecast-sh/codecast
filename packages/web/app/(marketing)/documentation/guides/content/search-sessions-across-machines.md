Claude Code keeps each conversation on the computer that ran it. Yesterday's session on your laptop isn't on your desktop, and a session on a cloud machine or a teammate's computer isn't on either. Codecast puts them in one place: every computer you connect sends its sessions to your account as they happen, so you can search all of them from any computer, from the web at codecast.sh, from the Mac app or from your iPhone.

![The search page with the query "Codecast-Session trailer", its Scope, Match in, Time and Sort filters, and sessions with the matching messages highlighted](/documentation/search-sessions-across-machines/search.webp "One search over every machine. Each result is a session, with the messages that matched and when they were said.")

## Set it up

Install codecast and sign in on each computer your agents run on ([Getting started](/documentation#getting-started) walks through it). There is nothing else to turn on. From then on, every session on that computer is recorded and searchable, whether it ran in Claude Code, Codex, Cursor, Gemini, pi or Grok.
## Search

Press **⌘K** anywhere in the app and start typing. Sessions with matching messages appear as you type, along with tasks and other things that match. Press **⌘↵** to open the full search page, where you can narrow the results:

| Filter | Choices |
|--------|---------|
| **Scope** | **Everyone** you share sessions with, or **Only mine** |
| **Match in** | **Everything** said in a session, or only **My prompts**, the lines you typed |
| **Time** | **All time**, the last **7d**, **30d** or **90d** |
| **Sort** | **Recent** first, or most **Relevant** first |

Put a phrase in quotes to match it exactly; words without quotes match anywhere in the session. To narrow further, type one of these into the search box (the empty search page lists them, and clicking one adds it):

| Type | To find |
|------|---------|
| `file:src/auth.ts` | Sessions that edited a file or folder |
| `commit:3f2a91c` | The session that made a commit |
| `pr:482` | Sessions linked to a pull request |
| `author:me` | Sessions a particular person ran |
| `repo:codecast` | Sessions in one repository |
| `label:api` | Sessions you filed under a label |
| `after:7d`, `before:2026-09-01` | Sessions active after or before a time |

Each result is a session. Under its title you see the matching messages, who said them (you or the agent) and when. Click a message to open the conversation at that point. When a session handed work to helper sessions, the result says how many of them matched too. Right click a result for more, such as copying a link to it.

The search page address keeps your whole query, so a narrowed search is a link you can bookmark or send to a teammate.

On your iPhone, the search at the top of the inbox searches the same history.

## Let your agents search it

With [Memory](/documentation/memory) on, your agents search this same history themselves, from whichever computer they run on. Ask "what did we decide about the schema in yesterday's session on my laptop?" and the agent finds it and answers with a link to the session.

## What it covers

- **Your sessions, and your team's shared ones.** A teammate's session appears only if it is shared with the team. Which folders are shared, and which stay private to you, is set per folder; see [Team sessions](/documentation/team-sessions).
- **Every message for the last 30 days, titles and summaries before that.** A search matches the full text of recent sessions. Older sessions match by their title and summary, and the search page says so above the results.
- **Only computers running codecast.** A computer that has never had codecast installed and signed in adds nothing to the history.

## If you only use one computer

Claude Code's own `claude --resume` lists recent sessions for the folder you are in, on that computer. Open source tools such as [search-sessions](https://github.com/sinzin91/search-sessions) and [LLMnesia](https://www.llmnesia.com/blog/search-claude-code-conversation-history) search the full text of the session files on one computer and keep everything on it. If your work lives on one machine and only you need it, those are less to set up. Codecast is for history spread across several computers, several agents or several people.
