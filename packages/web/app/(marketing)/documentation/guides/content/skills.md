A snippet teaches an agent that a command exists. It does not teach a procedure. "Hand this work over" is a procedure: write down the decisions, pin the state, file a doc, then fork, spawn or message the right session. An agent that rebuilds that sequence from memory each time does it differently each time, and skips steps.

A skill is a packaged set of instructions for one kind of task. It is a directory with a `SKILL.md` file: a name, a description that says when to use it, and the steps. Claude Code lists each skill by its description and loads the body only when the skill is invoked, as a slash command (`/cast-handoff`) or because the task matches the description. A skill you never invoke costs the description line and nothing more.

The `cast-*` skills are the procedures that need what one session cannot see: the task board, the team's session history, other live sessions, pull requests, calls and chat. Each one is a sequence of ordinary `cast` commands. A skill adds no capability of its own. It fixes the order, the checks, and what evidence to leave behind.

```bash
cast install skills             # write all 23 skills
cast install skills --disable   # remove them
ls ~/.claude/skills/            # cast-pickup/SKILL.md, cast-ship/SKILL.md, and the rest
```

```text
/cast-pickup ct-4102
/cast-why src/sync.ts:212 why is this debounced
/cast-bakeoff a queue table | an in memory buffer
```

## How the skills ship and install

The skill files are compiled into the CLI binary as text imports. A compiled binary has no source tree beside it, so an installer that looks for files next to the executable finds nothing on a release install. With the bytes inside the binary, a Homebrew install and a run from source write the same files.

The whole set installs as one catalog snippet named `skills` ([how snippets work](/documentation/agent-snippets)). The wizard, `cast install skills`, and the toggle on the web Settings page all reach the same installer. It writes each skill to `~/.claude/skills/<name>/SKILL.md`. An install with no interactive terminal turns skills on by default, the same as memory.

The installer compares each file byte for byte. A file that already matches is not touched. After a CLI update, the refresh of enabled snippets rewrites only the skills whose text changed, so a revised skill reaches the machine without a version bump. `--disable` removes the 23 `cast-*` directories and nothing else, so your own skills in `~/.claude/skills/` are safe. The orchestrate skill is separate: it belongs to the `orchestration` snippet, which also installs three agent types and two hooks ([orchestration](/documentation/orchestration)).

## The catalog

Start, stop, and hand over:

| Skill | What it does | Built on |
|-------|--------------|----------|
| `/cast-pickup` | Reads the bound task or plan, the pinned state, recent team work and the repository, then names the work and the next three actions | `cast task`, `cast plan`, `cast state`, `cast feed` |
| `/cast-handoff` | Writes decisions, verified work, open questions and ordered next steps as a shared doc, pins the state, and can fork, spawn or message a session | `cast doc`, `cast state`, `cast fork`, `cast spawn`, `cast send` |
| `/cast-pass` | Hands this session to a teammate: pins where it stands, adds them as an owner, sends the brief | `cast state`, `cast send`, `cast chat` |
| `/cast-ask-team` | Posts a question to the team channel, parks the session as dormant, and continues when an answer arrives | `cast chat`, `cast state`, `cast trigger` |
| `/cast-worktree` | Moves the work into an isolated worktree with its own env files, ports and setup | `cast ws` |

Plan and reconsider:

| Skill | What it does | Built on |
|-------|--------------|----------|
| `/cast-plan` | Explores the code, searches earlier sessions and decisions, interviews the user, then writes a plan with tasks and dependencies | `cast plan`, `cast task`, `cast search`, `cast decisions` |
| `/cast-rethink` | Rebuilds the history of a piece of work from sessions, decisions and tasks before touching code | `cast search`, `cast context`, `cast task`, `cast plan` |
| `/cast-bakeoff` | Forks the conversation once for each approach, waits for the branches, and compares diff, evidence and cost | `cast fork`, `cast sessions -w`, `cast diff`, `cast read` |
| `/cast-conflicts` | Finds live sessions on this repository that change the same files, shows what they changed, and warns them | `cast sessions`, `cast diff`, `cast send` |

Prove and ship:

| Skill | What it does | Built on |
|-------|--------------|----------|
| `/cast-verify` | Runs the repository's checks, exercises the change in the browser or on the command line, and attaches the evidence to the task | `cast browser`, `cast image`, `cast task comment` |
| `/cast-ship` | Commits in topical pieces, opens the pull request, and binds the session to it so reviews and failing checks wake it until merge | `cast pr shepherd`, `cast task`, `cast state` |
| `/cast-review` | Reviews another session from its transcript and diff, and sends findings with file and line | `cast read`, `cast diff`, `cast summary`, `cast send` |
| `/cast-second-opinion` | Gives a different model the intent, the plan and the diff in a fresh context, then verifies its findings | `cast exec --agent` |
| `/cast-why` | Traces a line of code to the session that wrote it and the message where it was decided | `cast blame`, `cast read`, `cast link` |

Run the fleet:

| Skill | What it does | Built on |
|-------|--------------|----------|
| `/cast-loop` | Arms a recurring trigger that spawns one fresh session for each ready task, with a precheck that skips the run when the queue is empty | `cast trigger add --every --spawn --precheck`, `cast task ready`, `cast decide` |
| `/cast-triage` | Reads every session by who acts next, stashes the finished, kills the dead, and surfaces the few that need a person | `cast sessions`, `cast stash`, `cast kill`, `cast send` |
| `/cast-morning` | Lists what waits on the human: sessions that need input, pull requests, ready tasks, overnight trigger runs, unread chat | `cast sessions`, `cast pr`, `cast task`, `cast trigger`, `cast chat` |
| `/cast-eod` | Checks each live session for an honest pinned state, writes handoffs, arms overnight follow ups, tidies the inbox | `cast state`, `cast trigger`, `cast stash`, `cast kill` |
| `/cast-standup` | Builds a digest for a time window from sessions, commits, tasks, pull requests, calls and chat | `cast feed`, `cast task`, `cast pr`, `cast calls`, `cast publish` |

Learn, and keep the records true:

| Skill | What it does | Built on |
|-------|--------------|----------|
| `/cast-learn` | Turns this session's corrections, decisions and gotchas into repository guidance, recorded decisions, or a doc | `cast decisions`, `cast doc` |
| `/cast-lessons` | Collects the corrections humans made across the team's sessions in a window and proposes the guidance that would have prevented each | `cast search`, `cast read`, `cast decisions` |
| `/cast-from-call` | Checks each action item of a call against the transcript and files it as a task marked as decided in a meeting | `cast call`, `cast task create --from-meeting` |
| `/cast-org` | Reads what the code and sessions show, proposes seats, scopes and record fixes with evidence, and posts the result for the person to accept | `cast org` |

## How a skill composes the primitives

`/cast-bakeoff` shows the pattern. It runs one `cast fork --tip --label bakeoff-<topic>` with one direction for each approach, so every branch keeps the whole thread ([forks and spawn](/documentation/forks-and-spawn)). It tells each branch to work in its own worktree. It then watches `cast sessions --label bakeoff-<topic> -w --json`, a stream that prints nothing until a branch changes state. When the branches settle it reads `cast diff` and `cast read` for each one, puts the results in a table, gives a verdict, and stashes the branches that lost.

`/cast-loop` is built on [triggers](/documentation/triggers) and [tasks](/documentation/tasks-and-plans). The task board is the queue. A recurring `--spawn` trigger starts a fresh session for each run, and the `--precheck` command exits with a failure when `cast task ready` returns nothing, so an idle loop spends no session. Each run claims one task, works in a worktree, runs `/cast-verify`, and opens a pull request with `/cast-ship`. It does not merge. The skill also states when to cancel the trigger: when the queue is empty, when two runs in a row fail the same way, or at the time limit given with `--for`.

`/cast-ask-team` combines three primitives so that a question does not block a session. It posts to a channel with `cast chat send` and mentions its own short session ID, so a reply on the thread arrives as a session message ([messaging](/documentation/messaging)). It declares `cast state --status dormant` and names the thread as the wake ([thread state](/documentation/thread-state)). When the default answer is safe to reverse, it arms a `cast trigger add --in <time>` that takes the default if nobody replies.

Skills call each other by name, as `/cast-loop` does with `/cast-verify` and `/cast-ship`. That works because every skill in the set installs together.
