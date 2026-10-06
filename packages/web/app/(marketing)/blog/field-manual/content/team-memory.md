A coding agent starts every task cold. It reads the code, guesses at intent, and rediscovers what a teammate's agent settled last week: why the retry cap is 5 and not 3, why signatures are checked before parsing, which approach was tried and failed. The reasoning existed. It lived in a transcript on someone else's laptop, and when the session ended it was gone.

Codecast keeps every session your team runs, from any agent on any machine, and makes that history something people and agents can query. Three things do the work: search by what a session *touched*, ask one session a question and get cited lines back, and see which session wrote each line of a file.

![The codecast command palette with the query 'webhook retry': three session results by Alex Rivera (Retry failed webhooks, 6 matches; Try fixed backoff, 3 matches; Webhook API half, 2 matches), each with a one-line summary, and below them a Done task, ct-4182 Retry queue for failed webhooks](/blog/field-manual/memory-palette.webp "Three weeks later, a teammate searches the palette for &quot;webhook retry&quot;. The sessions come back with what they concluded, and the task they closed sits beneath them.")

## Search the work, not just the words

The quickest way in is the command palette (<kbd>Cmd</kbd> <kbd>K</kbd>): type a few words and sessions come back beside tasks and docs, each with its summary and how many messages matched. <kbd>Cmd</kbd> <kbd>Enter</kbd> takes the same query to the full search page (also <kbd>Cmd</kbd> <kbd>/</kbd>), which searches titles and full message text across your team's sessions, or only yours with one toggle.

The search page understands more than words. Every session records the files it edited, the commits it made, the pull requests it is linked to, the repository, who ran it and when, and each of those is an operator you can type or click from the chips under the box: `file:`, `commit:`, `pr:`, `label:`, `author:`, `repo:`, `after:`, `before:`. So "which session made this commit?" is `commit:5831cb2e2` and one result. "Who has been in this file?" is `file:src/webhooks/retry.ts`, newest change first. Words alongside an operator narrow where the words are searched, and the URL keeps the whole query, so a narrowed view is a link you can paste to a teammate.

A result is still findable after the session that produced it is long gone. A session killed hours ago, run in a worktree on a cloud host, comes back the same as one from your own laptop, because transcripts are stored and indexed on the server, not read off anyone's disk. Search runs keyword and semantic matching together, so a question phrased differently from the transcript still lands.

![The codecast memory feature page section 'Search the work, not just the words': a row of operator chips (file:, commit:, pr:, label:, author:, repo:, before:) above a search listing three sessions with ids, dates, message counts and repo for file:src/webhooks/retry.ts](/blog/field-manual/memory-search.webp "From the `/features/memory` page: the operators, and three sessions that touched one file.")

## Ask a session, get cited lines and the later reversal

A 300 message session is a lot to page through for one fact. In any conversation, press <kbd>A</kbd> (or pick **Ask this session** from its menu) and a panel opens beside the transcript: "What did this session decide about…". The answer leads with the direct reply and backs each point with the messages it rests on. Each citation is a chip; click it and the transcript jumps to that message. Ask a follow-up in the same panel.

The clever part is that it reads *past* the first relevant passage. People change their minds and agents try things that fail, so the first answer in a transcript is often wrong by the end. When a later message revised the answer, you get the later one, with the earlier one named as history. A session too long to read whole is read end first, then start, and the answer says which stretch it skipped, since that stretch could change the answer. If the session does not hold the answer, it says so and points at the closest lines instead of guessing.

Agents use the same thing on themselves. An agent whose context was summarized can ask its own session what the user wanted in turn one, past every compaction.

![The memory feature page section 'Ask a session a question. It cites its lines.': a message timeline for session jx7k2qa with msg 88 marked as the first answer and msg 139-141 as the later line that replaced it, above the answer to 'what retry cap did we settle on?': five attempts, with citations](/blog/field-manual/memory-ask.webp "The idea in one picture: the first answer (msg 88, a cap of 3) and the later lines that replaced it (msg 139 to 141, a load test that raised it to 5).")

## Blame, with the session in the author column

When agents write the code, `git blame` names whoever committed it, which tells you nothing about why. Open a file in codecast's repo view and the gutter names the *session* behind each line instead: a colour that runs the height of each range, and on its first line the person, the session and how long ago. A strip above the file lists the sessions that shaped it, most lines first, with a header like "94% by 2 sessions". Hover a session and its lines light up wherever they fall; click it to jump to its first line, or open the conversation that wrote them.

Attribution is per line, not per commit. A commit that mixes an agent's edits with a hand edit credits only the lines the session actually wrote; the rest keep their git author.

![The repo view of billing/src/billing/retry.ts in the product film: a header reading '94% by 2 sessions' with pills for 'Retry failed webhooks' (39) and 'Webhook API half' (9), and a gutter marking which lines the 'Retry failed webhooks' session wrote 20 and 21 days ago; line 42, the exponential backoff, is highlighted under a comment explaining why exponential beat fixed](/blog/field-manual/memory-blame.webp "The repo view: a gutter of sessions instead of authors, and a header that says 94% of the file came from two sessions.")
![The memory feature page section 'git blame, with the session in the author column': a blame listing where lines carry session ids jx7f9de, jx7k2qa and jx7m41c, line 9 keeps a human git author; below, a commit 4b1c9e2a1 with its Codecast-Session trailer linked to a card for the session](/blog/field-manual/memory-blame-page.webp "From `/features/memory`: the commit carries a `Codecast-Session:` trailer that links it to the session that made it.")

### How it knows

When an agent commits, codecast adds one line to the commit message, a `Codecast-Session:` trailer pointing at the conversation. That is the session's own word, so it beats every heuristic; on codecast's pull request and commit pages it renders as a session pill rather than a URL. Commits without one (another tool, a hand commit, a commit from before codecast was installed) are matched by hash, then by subject and time, which is good but not certain. The trailer never blocks a commit, only sessions your team can see get one (a private session never leaks a link into a shared history), and it can be turned off per repository.

The same blame is there for people who live in a terminal or an editor, in git blame's own format, so a vim or editor integration can show sessions where it showed authors:

```terminal
$ cast blame -L 41,44 packages/web/scripts/readme-shots.ts
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 41) const OUT_DIR = join(…);
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 42) const OUT_WIDTH = 1920;
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 43) const SETTLE_MS = 9000;
497bc4e815 (Ashot Petrosian                               2026-10-05 44)
```

Line 44 is blank, so no session is credited with it and it falls back to the git author.

> **Why it matters.** The chain is short: a reviewer wonders why the cap is 5, the repo view names the session that wrote the line, and asking that session "why 5?" returns the message where 3 was chosen and the load test that changed it. No one has to remember, and the agent that wrote the code does not need to still be running. Your agents get the same tools in their instructions, so they look up who settled a question before they change code someone else's agent wrote.

## Who sees what

Memory follows the team. Sessions in a project shared with your team are searchable by the team; sessions in a private project only by you. Message text is matched in full for the last 30 days; older sessions still surface by title and summary. For conclusions that should not depend on anyone finding the right session, agents also keep a decisions log, which they check before reopening a settled choice.
