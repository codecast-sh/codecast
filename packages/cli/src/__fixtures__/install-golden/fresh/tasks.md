
## Tasks & Plans

You operate within a structured work tracking system. A human monitors your progress through a dashboard — communicate status through the system, not through chat.

### When to create structure

**Create a task** when your work will change code, fix a bug, or produce a deliverable. Run `cast task create "Title" -p <priority>` before you start implementing. This is the default — skip it only for simple questions, explanations, or quick lookups that don't produce changes.

**Tasks you create are internal by default** — they track your own work and stay off the human's board in the dashboard. Add `--human` only when the human must see and manage the task outside this session: a decision only they can make, a manual step, follow-up work that outlives you. Use it rarely; when in doubt, leave it off.

**Nest execution work under the goal it serves.** When you split a task into steps you will actually file, create them with `--parent <task_id>` so they sit under the larger piece of work instead of competing with it in a flat list. Decompose in one command — `cast task create --parent <task_id> -` with one title per line on stdin. Keep trees shallow (the system caps depth at two below the top) and small — a handful of real steps, not a transcript of your thinking. Subtasks vs plans: a plan orchestrates work across sessions; subtasks decompose ONE task's scope inside your session. Never mirror a plan as a subtask tree.

**The decomposition loop: claim the parent once.** `cast task start` the parent, decompose under it, then advance subtasks with `cast task update/done <sub_id>` — never `task start` your own subtasks (that would unbind you from the parent). Open subtasks of a parent being actively worked are excluded from `cast task ready`, so no other session will grab them mid-flight. Closing a parent with open subtasks is refused: finish them, or pass `--cascade` (close them too) / `--only-parent` (leave them open) to `cast task done`.

**`--from-meeting` is for tasks people decided, not tasks you decided.** Use it when you transcribe a commitment out of a meeting or a conversation with humans in it. Such a task reaches the human's board on its own, because a person already agreed to it. Never use it for your own work.

**Create a plan** when the user describes work with multiple distinct parts — a feature with frontend and backend changes, a refactor that touches several subsystems, a bug that needs investigation then fixing. Run `cast plan create "Title" -g "goal"` and add tasks with `cast task create "Title" --plan <plan_id>`. Don't create plans for single-task work.

**Bind before you build.** Whatever this session is working on right now should be a task or plan with your session bound to it — `cast task start <id>` claims a task, `cast plan bind <plan_id>` attaches to a plan. Binding is one command and it keeps your session, its progress, and the work item connected in the dashboard; work done unbound is invisible to the human tracking it. When the session's focus moves to a different piece of work, move the binding with it — claim the task you are actually advancing, not the one the session started on.

**Check existing work first.** Your context includes an overview of active tasks and plans. Before creating new ones, check if your work already has a task or fits under an existing plan. When the user names a topic, search by it directly — `cast task ls -q "<topic>"` and `cast plan ls -q "<topic>"` filter by title/description so you don't have to scan a wall of IDs. Use `cast task ready` (optionally `-q`) for unclaimed work. Claim existing tasks with `cast task start <id>` rather than creating duplicates.

**File work under a project when one fits.** A project groups tasks, plans, and docs that belong to the same effort — it is how the human triages a board that spans many sessions. Run `cast project ls` to see what exists, then pass `--project "<name>"` on create, or `cast task update <id> --project "<name>"` for a task already filed. Name it in plain words: every `--project` flag takes an ID, a short ID, or a title substring, so `--project "Agent Quality"` is the normal form and you never need to look up an ID. Don't invent a project for one task — file under an existing one, or leave it unfiled.

### Working on tasks

Once you have a task:
1. `cast task start <id>` — claim it and bind your session
2. Work on the implementation
3. `cast task comment <id> "progress" -t progress` — log milestones as you go
4. `cast task done <id> -m "summary"` — mark complete with what you verified

**Keep the bound item current — content and status.** The task is the human's view of your work, so it must describe what you are actually doing, not what you assumed at the start. When scope or approach shifts, rewrite the title and description to match (`cast task update <id> -t "..." -d "..."`); comment when you pass a milestone or change direction; move status the moment it changes, and mark done only what you verified. A task that still describes an hour-old understanding misleads everyone who reads the board — updating it is part of the work, not paperwork after it.

If bound to a plan, keep the bigger picture coherent:
- Advanced part of it? Post progress with `cast plan comment <plan_id> "..."` so the plan reads true without opening your session.
- Task larger than expected? Suggest splitting it.
- Your work creates a dependency? Flag it.
- Making a directional decision? Record it with `cast plan comment <plan_id> "decision" -d -r "rationale"`.
- Acceptance criteria ambiguous? Ask before assuming.

If blocked, say so explicitly:
- **BLOCKED: <reason>** — flags for human intervention
- **NEEDS_CONTEXT: <what>** — escalates to the user
- **DONE_WITH_CONCERNS: <concern>** — completed but flagged for review

### After compaction

When your context gets compacted, re-read your task or plan context (`cast task context --current` / `cast plan context --current`) to reground yourself. Don't rely on memory of earlier conversation alone.

### Reading tasks

Filter on the server, not with grep: `--assignee me`, `--label <name>`, `-p "<project>"`, `-q "<text>"`, `-s <status>`, `-a` (closed too). Every read takes `--json`; `cast task show` takes several ids and lists each task's linked sessions by short id (`cast read <id>`).

### Commands

```bash
cast task ready                             # Find available work
cast task ready -q "<topic>"                # Filter ready tasks by title/description
cast task ls -q "<topic>"                   # Search all active tasks by title/description
cast task ls --assignee me --label <name>   # Server-side filters (also -p, -q, -s, -a); --json for full rows
cast task show ct-1 ct-2 --json             # Several ids; .sessions = linked sessions (short id + title)
cast plan ls -q "<topic>"                   # Search active plans by title/goal
cast project ls                             # Projects in your workspace (the triage unit)
cast project show <id>                      # A project and every task under it
cast task ls -p "<project>"                 # Tasks in one project (ID, short ID, or title text)
cast task create "Title" --project "<name>" # File a new task under a project
cast task update <id> --project "<name>"    # File an existing task (--project '' unfiles it)
cast task start/done/comment <id>           # Task lifecycle
cast task start <id> --spawn                # Claim it AND hand it to a fresh agent session
cast integrations ls|sources|import <provider> <ref>  # Linear teams/projects and GitHub repos as codecast projects; their issues are tasks, synced both ways
cast task update <id> -t "..." -d "..."     # Keep title/description matching what you're actually doing (-s for status)
cast task create "Title" -t task -p high    # Create task (internal to agent work by default)
cast task create "Title" --plan <plan_id>   # Create task bound to plan
cast task create "Title" --human            # Put it on the human's board (rare — see above)
cast task create "Title" --parent <task_id> # File it as a subtask of larger work
cast task create --parent <task_id> - <<'EOF'  # Bulk decomposition: one subtask per line
First step
Second step
EOF
cast task done <id> --cascade               # Close a parent and its open subtasks together
cast task create "Title" --from-meeting     # People decided this in a meeting; you only wrote it down
cast task update <id> --plan <plan_id>      # Bind existing task to plan
cast task update <id> --human               # Move an existing task onto the human's board
cast task update <id> --parent <task_id>    # Re-nest a task (--parent '' moves it back to the top level)
cast task context <id>                      # Full context for a task
cast task context --current                 # Context for session's current task
cast plan create "Title" -g "goal" -b "body"  # Create plan with inline body
cast plan create "Title" --body-file plan.md  # Create plan from file ('-' reads stdin)
cast task comment ct-123 - <<'EOF'           # any text arg takes '-' for a heredoc body
…multi-line progress note, exact newlines…
EOF
cast plan bind/unbind <plan_id>             # Bind/unbind session to plan
cast plan show/status <plan_id>            # Plan details
cast plan context <plan_id>                # Full context for a plan (for agents)
cast plan context --current                # Context for session's current plan
cast plan comment <plan_id> "note"         # Add comment (progress by default)
cast plan comment <plan_id> "x" -d -r "y" # Decision with rationale
cast plan done/drop <plan_id>             # Close or abandon a plan
cast doc create "Title" [-c content] [-t type]
cast doc ls/edit/comment
cast doc show <id>                          # paginates long docs (200 lines) + prints "next:" hint
cast doc show <id> -p 2 | 800:1000 | --full # page · line range · whole doc (-n = line gutter)
cast doc grep <id> '<text>'                 # search inside one doc (grep '^#' = outline)
cast doc search "<title>"                    # search doc TITLES across the corpus
cast doc delete <id> --yes                  # permanently delete a doc you created
```

A task can be backed by a Linear or GitHub issue. `cast task show` prints that issue's identifier (`LIN-123`, `owner/repo#482`) and its link, and `cast task ls` prints the identifier beside the title. The sync runs both ways: your `cast task comment` posts to the issue and `cast task done` closes it, so working the task in codecast is working the issue.
<!-- /codecast-work -->

## Referencing objects

Every codecast object has a short ID. Write one into your prose and it renders as a live reference: the object's title, its current state, and a link that opens it. This works anywhere you write — messages, summaries, task comments, doc bodies, trigger prompts.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

There are two forms. Write the bare ID by default — `Filed under ct-4102.` — it reads as a normal sentence and still renders the full reference. Write `@[Title id]` — `@[Fix the auth race ct-4102]` — when the reader needs the name in the sentence itself.

Never paste an object's 32-character internal ID into prose. It renders as an unreadable blob, and every command that accepts an ID accepts the short one.
<!-- /codecast-references -->
