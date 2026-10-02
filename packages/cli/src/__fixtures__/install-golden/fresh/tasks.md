
## Tasks & Plans

A human tracks your work through a dashboard: report status through tasks and plans, not chat.

### When to create structure

**Tasks are selective.** Self-contained work you will finish in this session needs no task, even when it changes code or fixes a bug. File one (`cast task create "Title" -p <priority>`) when the work benefits from tracking, needs coordination or a handoff, will outlive this session, or the user asks. If small work grows, file it then.

**Tasks are internal by default** and stay off the human's board. Add `--human` rarely: only when the human must see and manage it outside this session (a decision only they can make, a manual step, follow-up that outlives you).

**Nest steps under the goal they serve.** File steps you will actually do with `--parent <task_id>` (in bulk: `cast task create --parent <task_id> -`, one title per line on stdin). Keep trees shallow (depth is capped at two below the top) and small: real steps, not your thinking. A plan orchestrates work across sessions; subtasks split ONE task inside your session. Never mirror a plan as a subtask tree.

**Claim the parent once.** `cast task start` the parent, decompose, then advance subtasks with `cast task update/done <sub_id>`; never `task start` your own subtask (it unbinds you from the parent). Open subtasks of an active parent are hidden from `cast task ready`. `cast task done` refuses a parent with open subtasks unless you pass `--cascade` (close them too) or `--only-parent` (leave them open).

**`--from-meeting` is for tasks people decided**, transcribed from a meeting or a conversation with humans in it; such a task reaches the human's board on its own. Never use it for your own work.

**Plans are for coordination** across multiple tasks or sessions. Many steps, frontend plus backend, or investigate-then-fix do not by themselves warrant one. `cast plan create "Title" -g "goal"`, then `cast task create "Title" --plan <plan_id>`.

**Bind before you build.** When work warrants a task or plan, bind to it (`cast task start <id>` or `cast plan bind <plan_id>`); unbound work is invisible to the human tracking it. When your focus moves, move the binding to the task you are actually advancing. A task has one owning session: starting one that another session is still working on is refused until you settle with that session who continues (`cast read`, `cast send`), and `--take` moves ownership when that is agreed or the owner is gone.

**Check existing work first.** Your context lists active tasks and plans. Search by topic (`cast task ls -q "<topic>"`, `cast plan ls -q "<topic>"`), use `cast task ready` for unclaimed work, and claim with `cast task start <id>` instead of creating a duplicate.

**File under a project when one fits.** Projects group an effort's tasks, plans and docs, and are how the human triages the board. `cast project ls`, then `--project "<name>"` on create or `cast task update <id> --project "<name>"`. Every `--project` flag takes an ID, a short ID or a title substring, so plain words work. Don't invent a project for one task.

### Working on tasks

1. `cast task start <id>`: claim it and bind your session
2. Do the work
3. `cast task comment <id> "progress" -t progress` at milestones. Progress and note comments reach nobody's inbox; to reach the task's followers post `-t blocker` (you are stuck), `-t review` (a handoff, a verdict), or name them with `@handle`. A choice only a human can make is a `cast decide`, never a comment.
4. `cast task done <id> -m "summary"` with what you verified

**Assignee is accountability, not permission.** An assignee is who answers for the task being done, never who may work on it: any session may work any task. Assign yourself or the role you work for so the board says who answers for it; another name on a task is never a reason to stop.

**Keep the bound item true.** When scope or approach shifts, rewrite the title and description (`cast task update <id> -t "..." -d "..."`), comment at milestones and changes of direction, move status the moment it changes, and mark done only what you verified. A task describing an hour-old understanding misleads everyone reading the board.

If bound to a plan: post progress with `cast plan comment <plan_id> "..."` so the plan reads true without opening your session; suggest splitting a task that grew; flag dependencies you create; record directional decisions with `cast plan comment <plan_id> "decision" -d -r "rationale"`; ask when acceptance criteria are ambiguous.

If blocked, say so: **BLOCKED: <reason>** (needs a human), **NEEDS_CONTEXT: <what>** (escalates to the user), **DONE_WITH_CONCERNS: <concern>** (finished, flagged for review).

After compaction, reground with `cast task context --current` / `cast plan context --current`, not memory.

### Commands

Filter on the server, not with grep: `--assignee me`, `--label <name>`, `-p "<project>"`, `-q "<text>"`, `-s <status>`, `-a` (closed too). Every read takes `--json`, and any text argument takes `-` for a heredoc body.

```bash
cast task ready [-q "<topic>"]              # unclaimed work
cast task ls -q "<topic>"                   # search active tasks (filters above)
cast task show ct-1 ct-2 --json             # several ids; .sessions = linked sessions (short id + title)
cast task context <id>                      # full context (--current for this session's task)
cast task start|done|comment <id>           # lifecycle
cast task start <id> --spawn                # claim it AND hand it to a fresh agent session
cast task create "Title" -t task -p high    # also --human, --plan <plan_id>, --parent <task_id>, --project "<name>", --from-meeting
cast task create --parent <task_id> - <<'EOF'   # bulk subtasks, one per line
First step
Second step
EOF
cast task update <id> -t "..." -d "..." -s <status>
cast task update <id> --plan <plan_id>      # also --human, --parent <task_id>, --project "<name>" ('' clears parent or project)
cast task done <id> --cascade               # close a parent and its open subtasks
cast task handoff <id> --status done --evidence - --page <slug|url>   # hand off with evidence; the page attaches to the task
cast project ls | show <id>                 # projects, and every task in one
cast integrations ls|sources|import <provider> <ref>   # Linear teams/projects and GitHub repos as projects; their issues are tasks, synced both ways
cast plan ls -q "<topic>"                   # search active plans by title/goal
cast plan show|status|context <plan_id>     # context --current for this session's plan
cast plan create "Title" -g "goal" -b "body"   # or --body-file plan.md ('-' reads stdin)
cast plan bind|unbind|done|drop <plan_id>
cast plan comment <plan_id> "note"          # progress; -d -r "why" records a decision
cast doc create "Title" [-c content] [-t type]
cast doc ls/edit/comment
cast doc show <id>                          # paginates at 200 lines, prints a "next:" hint; -p 2 | 800:1000 | --full, -n line gutter
cast doc grep <id> '<text>'                 # search inside one doc ('^#' = outline)
cast doc search "<title>"                   # doc TITLES across the corpus
cast doc delete <id> --yes                  # permanent; only docs you created
```

A task can be backed by a Linear or GitHub issue: `cast task show` prints its identifier (`LIN-123`, `owner/repo#482`) and link, `cast task ls` shows the identifier beside the title, and the sync runs both ways (`cast task comment` posts to the issue, `cast task done` closes it).
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
