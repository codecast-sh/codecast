
## Tasks & Plans

A human tracks your work through a dashboard: report status through tasks and plans, not chat. Your harness's todo list is for steps inside this session; anything meant to outlive the session or show on the board is a task.

**Tasks are selective.** Self-contained work you finish in this session needs no task, even when it changes code or fixes a bug. File one when the work needs tracking, coordination or a handoff, will outlive this session, or the user asks. Tasks are internal by default: `--human` only when the human must see and manage it themselves (a decision only they can make, a manual step, follow-up that outlives you), `--ephemeral` for bookkeeping of your own (a checklist, a probe) the board never carries. `--from-meeting` is only for tasks people decided in a meeting or conversation, never your own work; `--from-call cl-42` links it to that call too, so it shows on the call's page.

**Plans are for coordination** across several tasks or sessions; many steps alone do not warrant one. Split one task's real steps into subtasks with `--parent`, shallow and small, and never mirror a plan as a subtask tree. Check for existing work first (`cast task ls -q "<topic>"`, `cast plan ls -q`, `cast task ready`), and file under a project when one fits (`cast project ls`).

**Record what work waits on.** Work waiting on a task, a PR to merge (`#42:checks`: green CI), a decision or time gets a blocker, not a comment: `cast task dep ct-200 --blocked-by "#42"` keeps it off the ready list. To park, block the task you hold, then `cast state --status dormant "<what it waits on>"` and end your turn: the last blocker clearing wakes you.

**Bind before you build.** `cast task start <id>` (or `cast plan bind <id>`) claims the work and binds this session; unbound work is invisible to the human tracking it. Move the binding when your focus moves. Claim a parent once and advance its subtasks with `update` and `done`; never `task start` your own subtask.

**Keep the bound item true.** When scope or approach shifts, rewrite the title and description, comment at milestones and changes of direction, move status the moment it changes, and mark done only what you verified. Progress comments (`-t progress`) reach nobody's inbox; `-t blocker`, `-t review` or an `@handle` reach followers. A choice only a human can make is a `cast decide`, never a comment. An assignee is who answers for the task being done, never who may work on it: any session may work any task. Another name on a task is never a reason to stop.

**Hand a code change off with a guide.** The reviewer sees only a diff. With `--guide -` on `cast task handoff`, walk them through the change in the order that explains it best (not file order): one heading per step with its `file:start-end` on the heading line, and why that piece exists under it. It reaches the review, the pull request and the Changes story.

If bound to a plan, post progress and directional decisions there (`cast plan comment <plan_id> "…"`, `-d -r "why"` for a decision). If blocked, say so: **BLOCKED: <reason>** (needs a human), **NEEDS_CONTEXT: <what>** (escalates to the user), **DONE_WITH_CONCERNS: <concern>** (finished, flagged for review). After compaction, reground with `cast task context --current` / `cast plan context --current`, not memory.

```bash
cast task create "Title" -p high               # --plan <id>, --parent <id>, --project "<name>", --human
cast task start <id> | done <id> -m "what you verified"
cast task comment <id> "…" -t progress
cast task update <id> -t "…" -d "…" -s <status>
cast task handoff <id> --status done --evidence "<what you verified>" [--guide -]
cast plan create "Title" -g "goal" --steps -  # "Step :: done means" per line; a blank line starts a wave needing the one before; order by need: Review needs Build, never what comes first
cast doc create "Title" -c - | show <id> | search "<title>"
```

`cast guide tasks` has the full command reference.
<!-- cast @VERSION@ -->
<!-- /codecast-work -->

## Referencing objects

Every codecast object has a short ID. Written anywhere (messages, summaries, task comments, doc bodies, trigger prompts), it renders as a live reference: title, current state, and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |
| Call    | `cl-42`   | `cast calls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->
