A coding agent starts every task cold. It reads the code, guesses at intent, and rediscovers what a teammate's agent settled last week: why the retry cap is 5 and not 3, why signatures are checked before parsing, which approach was tried and failed. The reasoning existed. It lived in a transcript on someone else's laptop, and when the session ended it was gone.

Codecast keeps every session your team runs, from any agent on any machine, and makes that history something agents and people can query. Four tools do the work: search by what a session *touched*, ask one session a question and get cited lines back, blame a line of code to the session that wrote it, and read the session id straight out of the commit.

![The codecast command palette with the query 'webhook retry': three session results by Alex Rivera (Retry failed webhooks, 6 matches; Try fixed backoff, 3 matches; Webhook API half, 2 matches), each with a one-line summary, and below them a Done task, ct-4182 Retry queue for failed webhooks](/blog/field-manual/memory-palette.webp "Three weeks later, a teammate searches the palette for &quot;webhook retry&quot;. The sessions come back with what they concluded, and the task they closed sits beneath them.")

## Search the work, not just the words

Every session records the files it edited, the commits it made, the pull requests it is linked to, the repository, who ran it and when. `cast search` turns each of those into an operator: `file:`, `commit:`, `pr:`, `label:`, `author:`, `repo:`, `after:`, `before:`. With no text, an operator lists the matching sessions, newest matching change first. With text, it narrows where the text is searched. The web search page reads the same query string.

So "which session made this commit?" is one command. Here it is against codecast's own repository:

```terminal
$ cast search commit:5831cb2e2
Found 1 session matching the filters

── Crosshatch refinement ───────────────────────────────────
jx7bbz2 | ○ idle killed | 11 hours ago | 81 msgs | /.../worktrees/cloud-54e335
worktree cloud-54e335 · on Linux
edits: …/web/components/sidebar/navPrimitives.tsx, packages/web/app/globals.css

To explore:
  cast read <id> <line>:<line>   # read message range
  cast summary <id>              # get session summary
  cast diff <id>                 # files a session changed
```

Note what came back: the session ran in a worktree on a Linux cloud host, not on this laptop, and was killed hours ago. It is still findable because the transcript is stored server side and indexed, not read off local disk. Search is hybrid (keyword and semantic both run by default; `--keyword` or `--semantic` forces one), `-C 3` shows the messages around each hit so a match arrives with its reasoning, and `-u` searches only what people typed, which is where the corrections and instructions live.

![The codecast memory feature page section 'Search the work, not just the words': a row of operator chips (file:, commit:, pr:, label:, author:, repo:, before:) above a terminal running cast search file:src/webhooks/retry.ts that lists three sessions with ids, dates, message counts and repo](/blog/field-manual/memory-search.webp "From the `/features/memory` page: the operators, and the familiar flags (`--mine`, `-m sam`, `-s 7d`) shown as aliases for them.")

## Ask one session, get cited lines and the later reversal

A 300 message session is a lot to page through when you want one fact. `cast read <id> --ask "<question>"` answers from that one session. It leads with the direct answer, backs each point with the message numbers it rests on, and prints the `cast read` ranges to open them. A small model runs it on the server, and the footer prints the model, tokens and cost of each answer. A real run:

```terminal
$ cast read jx7bbz2 --ask "why was the guide line dropped from the nav subsection?"
── Crosshatch refinement ───────────────────────────────────
   jx7bbz2 | 79 lines | why was the guide line dropped from the nav subsection?

The guide line was dropped because the human requested it: "i think we
don't need the left line" (msg 65). The agent then removed the vertical
border from the nested lists in the sidebar (msg 68, 72), compensating
by widening the indent by 1px to maintain the layout.

read: cast read jx7bbz2 65:68  cast read jx7bbz2 72
claude-haiku-4-5 · read 79 lines, 37 matched, showed 75 · 5.9k in / 196 out, $0.007 · 3.2s
```

The clever part is that it reads *past* the first relevant passage. People change their minds and agents try things that fail, so the first answer in a transcript is often wrong by the end. When a later message revised the answer, `--ask` gives you the later one and names the earlier one as history. A session too long to read whole is read end first, then start, and the answer names the stretch it skipped, since that stretch could change the answer. If the session does not hold the answer, it says so and points at the closest lines instead of guessing. With no id, `cast read --ask` asks the session you are in, past its own compactions, which is how an agent recovers what the user asked for in turn one after its context was summarized.

![The memory feature page section 'Ask a session a question. It cites its lines.': a message timeline for session jx7k2qa with msg 88 marked as the first answer and msg 139-141 as the later line that replaced it, above a terminal showing cast read jx7k2qa --ask 'what retry cap did we settle on?' answering five attempts, with citations](/blog/field-manual/memory-ask.webp "The timeline above the terminal is the idea in one picture: the first answer (msg 88, a cap of 3) and the later lines that replaced it (msg 139 to 141, a load test that raised it to 5).")

## `cast blame`: git blame with the session in the author column

When agents write the code, `git blame` names whoever committed it, which tells you nothing about why. `cast blame` is a drop-in replacement: the same output format, but the author column shows the session that wrote each line, with its short id and title. Lines no session wrote keep their git author. Because the output matches git blame's default and porcelain formats (porcelain adds `codecast-session`, `codecast-title`, `codecast-url` and related keys), an editor integration that shells out to `git blame` can call `cast blame` instead. On codecast's own repo:

```terminal
$ cast blame -L 41,46 packages/web/scripts/readme-shots.ts
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 11:23:15 -0400 41) const OUT_DIR = join(import.meta.dir, "..", "..", "..", "docs", "screenshots");
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 11:23:15 -0400 42) const OUT_WIDTH = 1920;
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 11:23:15 -0400 43) const SETTLE_MS = 9000;
497bc4e815 (Ashot Petrosian                               2026-10-05 11:23:15 -0400 44)
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 11:23:15 -0400 45) // Lift the film out of the page's column so it lays out at its native 1280x760
497bc4e815 (jx781zf Ashot Documentation audit and refresh 2026-10-05 11:23:15 -0400 46) // stage with no scale, then report where it sits in document coordinates.

$ cast blame --log packages/web/scripts/readme-shots.ts
Sessions that shaped ~/src/codecast/packages/web/scripts/readme-shots.ts  (82/98 lines attributed)

  jx781zf  Ashot   497bc4e81  Documentation audit and refresh             82 lines  2026-10-05

  <CR> opens the conversation · O opens the file at that session's commit (vim :Gslog)
  Newest: https://codecast.sh/conversation/jx781zf4kke2vawx9jkks2rcsx8fm4nw
```

Line 44 is blank, so no session is credited with it and it falls back to the git author. The attribution is per line, not per commit: a commit that mixes an agent's edits with a hand edit credits only the lines the session actually wrote. Blame also reaches uncommitted lines in the working tree: where git can only say `Not Committed Yet`, `cast blame` names the live session that wrote them when its edits were captured.

The rest of the family: `cast blame --log` lists the sessions that shaped a file, newest first; `--open src/x.ts:42` resolves a line to its session and opens the conversation in the browser; `--install-fugitive` installs a shim so vim-fugitive's `:Gblame` shows sessions; `--log --quickfix` feeds a vim quickfix list.

![The repo view of billing/src/billing/retry.ts in the product film: a header reading '94% by 2 sessions' with pills for 'Retry failed webhooks' (39) and 'Webhook API half' (9), and a gutter marking which lines the 'Retry failed webhooks' session wrote 20 and 21 days ago; line 42, the exponential backoff, is highlighted under a comment explaining why exponential beat fixed](/blog/field-manual/memory-blame.webp "The same idea in the web app's repo view: a gutter of sessions instead of authors, and a header that says 94% of the file came from two sessions.")
![The memory feature page section 'git blame, with the session in the author column': a cast blame -L 3,9 terminal where lines carry session ids jx7f9de, jx7k2qa and jx7m41c, line 9 keeps a human git author; below, a commit 4b1c9e2a1 with its Codecast-Session trailer linked to a card for the session, and panels for porcelain keys and cast blame --log](/blog/field-manual/memory-blame-page.webp "From `/features/memory`: the commit carries a `Codecast-Session:` trailer, and porcelain output adds `codecast-*` keys for editors.")

## The trailer: the commit names its session

How does blame know which session wrote a line? Codecast's hook in Claude Code appends a trailer to each `git commit` the agent runs:

```terminal
$ git show -s 5831cb2e2
commit 5831cb2e2
Author: Ashot Petrosian

    web: subtler nav subsection crosshatch, drop the guide line

    Codecast-Session: https://codecast.sh/conversation/jx7bbz2kqg507dp2mnjk0heegx8fjht7
```

The trailer is the session's own word, so it beats every heuristic. Commits without one (other agents, hand commits, a commit made before codecast was installed) are matched by hash, then by subject and time. That fallback is good but not certain; the trailer is. Three guardrails: the hook never fails a commit; only sessions your team can see get a trailer, so a private session never leaks a link into a public history; and it can be turned off per repo with `git config codecast.sessionTrailer false` or everywhere with `cast config session_trailer false`. On codecast's pull request page the trailer renders as a session pill rather than a URL.

> **Why it matters.** The chain is short and every link is a real command: a reviewer asks why the cap is 5, `cast blame src/retry.ts:5` names the session, `cast read <id> --ask "why 5?"` returns the message where 3 was chosen and the load test that changed it. No one has to remember, and the agent that wrote the code does not need to still be running. The same commands are in every agent's instructions (the installer writes a `## Memory` section into `CLAUDE.md`, `AGENTS.md` and the Cursor rules), so agents run them on their own before changing code someone else's agent wrote.

## Other ways in

- `cast context "implement auth"` or `cast context --auto` (reads your branch name and changed files): the sessions that already worked on what you are about to start, before the first message.
- `cast ask "how does X work"`: from a question to passages across several sessions, each with its session and message range.
- `cast diff <id>` and `cast summary <id>`: what a session actually changed (files, commits, tools) and its goal, approach and outcome. A session's state says who is paying attention now, not what it did, so this is the check before crediting work to it.
- `cast decisions add "title" --reason "why"`: conclusions that should not depend on anyone finding the right session, written to a log agents search before relitigating a choice.

Scope is the team's: sessions in a project shared with your team are searchable by the team, sessions in a private project only by you, and `-g` widens to every team you belong to, never past them. Message text is matched in full for the last 30 days; older sessions still surface by title and summary.
