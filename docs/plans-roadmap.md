# Codecast Plans: Roadmap & Design Document

A comprehensive design for a persistent plan/project/task structure that enables human-agent collaboration, living in parallel with and connected to codecast sessions. This document encodes all research, design decisions, and implementation details accumulated across multiple sessions and external references.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [First Principles](#first-principles)
3. [Industry Research & Landscape](#industry-research--landscape)
4. [Reference Implementations](#reference-implementations)
5. [Current Codecast State](#current-codecast-state)
6. [Design Decisions & Rationale](#design-decisions--rationale)
7. [Architecture](#architecture)
8. [Data Model](#data-model)
9. [CLI Commands](#cli-commands)
10. [Session-Plan Integration](#session-plan-integration)
11. [Web UI Surfaces](#web-ui-surfaces)
12. [Mining Pipeline Evolution](#mining-pipeline-evolution)
13. [Orchestration](#orchestration)
14. [Implementation Phases](#implementation-phases)
15. [Open Questions & Future Work](#open-questions--future-work)

---

## Problem Statement

Codecast sessions are the lifeblood of the system -- they capture everything an agent does, mine insights, feed the inbox. But sessions are ephemeral streams. They compact, they end, they lose context. There is no durable, structured layer where a human and an agent can collaborate on multi-session work.

The gap manifests in several ways:

- **Sessions and tasks live in separate worlds.** A session doesn't know what task it's working on unless the agent manually calls `codecast task start`. There's no structural link from "I'm in this session" to "I'm working on this plan."
- **Plans don't persist.** The existing `/drive` command writes `.claude/drive.md` locally but it's not in the database, not visible to other agents, not visible in the web UI. Context compaction destroys it.
- **Projects are hollow shells.** CRUD exists but no planning, no progress tracking, no timeline.
- **Mining creates noise.** Every session spawns 1-3 draft tasks via `taskMining.ts`. Without curation, this becomes a junk drawer of disconnected items.
- **No continuity across sessions.** When an agent crashes or a session ends, the next agent starts from scratch. There's no structured state to resume from.
- **No orchestration backbone.** The `/orchestrate` and `/start` slash commands exist but operate on ad-hoc local files, not on a shared data layer.

### The Goal

Build a parallel, stable plan/project/task structure that:
- Both humans and agents can read, write, and collaborate on
- Lives in parallel with and connects to sessions
- Supports both top-down planning (human defines, agents execute) and bottom-up emergence (agent works, plan crystallizes)
- Enables fluid entry points: start from UI, CLI, orchestrator, or within an existing session
- Persists across sessions, context compactions, and machine restarts
- Is the connective tissue between ephemeral session work and durable project state

---

## First Principles

### 1. Sessions Are Streams. Plans Are Structures.

Sessions are chronological -- a conversation that flows. Plans are hierarchical -- goals decompose into tasks, tasks have dependencies. The system needs both, connected but not conflated. A plan is not a session. A session is not a plan. But they reference each other.

### 2. Bottom-Up vs Top-Down

Sometimes you start with a plan and execute it (top-down). Sometimes you're hacking and the plan emerges from what you did (bottom-up). The system must support both directions naturally. This means plans can be created by humans in the UI, by agents mid-session, or promoted from mined insights.

### 3. Human Tempo vs Agent Tempo

Agents can spawn 5 tasks in 30 seconds. Humans need time to think. The system must buffer agent output without overwhelming humans (draft status, triage inbox), and let humans set direction without blocking agents (async plan creation, priority ordering).

### 4. Durability vs Ephemerality

Sessions are ephemeral (they compact, they end). Plans need to survive across sessions, across days, across agents. But they also need to stay alive and current, not become stale artifacts. The plan IS the continuation state -- when a session dies, the plan remembers where things stand.

### 5. Visibility

Both humans and agents need to see the same picture. The web UI is the human's view. The CLI is the agent's view. They must be projections of the same underlying Convex state.

### 6. Progressive Structure

Plans should not require rigid structure from the start. They grow organically: a draft plan might just have a goal and a couple tasks. An active plan accumulates progress logs and decisions as work happens. Structure is aspirational, not enforced at creation time.

### 7. Fluid Entry Points

Starting work should not require a specific ceremony. You can start from:
- A task in the web UI ("Start" button spawns a session)
- A CLI command (`cast task start ct-a3f8`)
- Within an existing session ("this is getting complex, let me create a plan")
- An orchestrator polling for ready work
- A mined insight that gets promoted

All paths converge on the same Convex state.

---

## Industry Research & Landscape

### Multi-Agent Coding Frameworks (2024-2026)

**Claude Code Agent Teams** (Feb 2026, experimental): Fully independent Claude Code instances with a shared task list, direct inter-agent messaging, and a team lead that orchestrates. Tasks are JSON files stored at `~/.claude/tasks/{team_name}/` with status fields, claimed via file locking. Communication through a mailbox system. Teams of 3-5 recommended, 5-6 tasks per teammate. Key limitation: no session resumption for in-process teammates, no nested teams.

**Cursor 2.0** (Oct 2025): Agent-first architecture with proprietary "Composer" model. Runs up to 8 agents in parallel using git worktrees or remote VMs. Background agents run in isolated Ubuntu VMs with internet access, create PRs autonomously. AGENTS.md configuration for custom agent roles.

**Devin** (Cognition): Compound AI system -- not a single model but a swarm of specialized models: Planner (high-reasoning), Coder (code-specialized), Critic (adversarial reviewer), Browser (documentation scraper). Interactive planning where users review/tweak plans before autonomous execution. PR merge rate improved from 34% to 67% year-over-year. Excels at junior-scope tasks with clear requirements (4-8hr human equivalent). Cannot independently tackle ambiguous projects end-to-end.

**OpenAI Codex CLI**: Terminal-first, open-source. Native `/plan` mode for task decomposition. Can be exposed as an MCP server and orchestrated via the Agents SDK. The Project Manager pattern creates three root documents (`REQUIREMENTS.md`, `AGENT_TASKS.md`, `TEST.md`) and gates handoffs between specialized agents.

**GitHub Copilot Coding Agent** (GA Sept 2025): Runs autonomously in GitHub Actions environments, triggered from issues or chat. Creates PRs with results. Agent HQ manages all agents in one place. Can be triggered from Slack, Teams, Linear.

### Framework-Level Orchestrators

**LangGraph** (v1.0 late 2025): Graph-based workflow engine. Treats agent interactions as nodes in a directed graph with conditional logic, branching, and dynamic adaptation. State persistence via reducer logic for merging concurrent updates. Checkpointing, thread-local memory, cross-session persistence. Winning enterprise market.

**CrewAI**: Role-based orchestration. Agents assigned to tasks in sequential/parallel workflows. Clear object structure (Agent, Crew, Task). Dominates business/rapid-prototyping workflows.

**MCO (Multi-CLI Orchestrator)**: Neutral orchestration layer that dispatches prompts to multiple agent CLIs (Claude Code, Codex, Gemini CLI) in parallel, aggregates results, returns structured output.

**Gas Town** (Steve Yegge): Multi-agent workspace manager enabling 20-30 parallel agents, paired with Beads memory system.

### The Key Architectural Insight

Mike Mason's analysis: "Human orchestration, not agent autonomy, creates production coherence." The systems that work in production use hierarchical coordination -- planners create tasks, workers execute independently on separate git branches, judges evaluate progress. Equal-status agents with locking mechanisms became bottlenecks; optimistic concurrency made agents risk-averse. The solution everywhere is hierarchy.

### Plan/Task Structures for Agents

**The Dominant Pattern: File-Based Plans in Markdown**

Three independent projects converged on this:

**Manus** (acquired for $2B): Three-file system -- `task_plan.md` for goals/progress, `notes.md` for research, deliverable output file.

**OpenAI Codex PLANS.md**: Comprehensive "ExecPlan" documents for multi-hour problem solving. Has enabled Codex to work for 7+ hours from a single prompt. Mandatory sections: Progress (timestamped checkboxes), Surprises & Discoveries (with evidence), Decision Log (rationale + date), Outcomes & Retrospective. Key principle: every plan must be fully self-contained -- "contains all knowledge and instructions needed for a novice to succeed." Plans are living documents that evolve during implementation. Idempotent steps that can be rerun safely.

**Claude Code**: Hierarchical structure with `.claude/MEMORY.md`, Skills system. Agent Teams use JSON task files at `~/.claude/tasks/{team_name}/`.

**Beads** (Steve Yegge): Issues stored as JSONL in `.beads/beads.jsonl`, cached locally in SQLite for fast queries, hash-based IDs (`bd-a1b2`). Git is the persistence layer. Naturally distributed across multiple machines/agents sharing the same beads database via git.

**AGENTS.md as a Standard**: Cross-platform standard from OpenAI Codex, Google Jules, Cursor, and Factory. Machine-readable instructions covering build steps, test commands, coding conventions. GitHub's analysis of 2,500+ repositories identified six core areas: commands, testing, project structure, code style, git workflow, and boundaries. Hierarchical: large repos benefit from AGENTS.md in each subdirectory.

### Human-Agent Collaboration Patterns

**Three Paradigms (Martin Fowler / Thoughtworks):**

- **Outside the Loop (fails)**: Humans specify requirements, agents handle everything. Produces slower, costlier systems.
- **In the Loop (bottleneck)**: Humans manually inspect and fix agent code line-by-line. Agents work faster than humans can review.
- **On the Loop (recommended)**: Humans engineer the "harness" (specs, quality checks, workflow guidance), agents execute within it. Agents self-improve through built-in evaluations. The "agentic flywheel" -- feed agents performance signals (tests, metrics, production data), agents recommend harness improvements, progressively automate low-risk approvals.

**The Collaboration Paradox (Anthropic Research):** While engineers use AI in roughly 60% of their work, they report being able to "fully delegate" only 0-20% of tasks. AI serves as a constant collaborator, not an autonomous replacement. The shift is from writing code to reviewing, directing, and validating AI-generated code.

**What's Actually Working:**
- Plan-first workflows: explore files, request comprehensive plan, document in markdown before implementation. One practitioner called this "waterfall in 15 minutes."
- Quality gates with hooks: Claude Code's `TeammateIdle` and `TaskCompleted` hooks enforce rules when teammates finish work.
- Clear delegation criteria: easily verifiable + low-stakes = delegate. Conceptually difficult + design-dependent = collaborate or keep.

**What's Failing:**
- 67.3% of AI-generated PRs get rejected vs 15.6% for manually written code (LinearB data)
- METR study: experienced maintainers were 19% slower with AI tools while believing they were 20% faster -- a 39-percentage-point perception gap
- Google DORA Report 2025: 90% AI adoption correlates with 9% rises in bug rates, 91% increases in code review time, 154% increases in PR size
- Thoughtworks experience: autonomous agents "haven't actually worked a single time yet" -- brute-force fixes (raising memory limits instead of diagnosing root causes)

### Emerging Standards

**MCP (Model Context Protocol)**: November 2025 specification expanded into long-running, governed workflows. New Tasks feature introduces "call-now, fetch-later" pattern.

**A2A (Agent-to-Agent Protocol)**: Google-originated, now Linux Foundation (v0.3). Communication over HTTPS with JSON-RPC 2.0. Agent Cards (JSON capability advertisements), task lifecycle management.

### Real-World Failures and Lessons

**The 17x Error Trap**: The "Bag of Agents" anti-pattern -- accumulating agents without proper structural organization leads to error amplification. Performance gains saturate beyond the 4-agent threshold without structured topology.

**Silent Failures Are the Real Killer**: An agent timed out mid-refactor, on retry silently applied edits twice in one file, once in another. "Nothing crashed. Nothing threw an error." Solution: treat outputs as proposals, not actions. Durably store agent results separately from their interpretation. Implement explicit ownership through leases with heartbeats.

**Inter-Agent Misalignment**: The single most common failure mode. Capable models "talk past each other, duplicate effort, or forget their responsibilities." Sequential chains compress earlier messages, eroding information fidelity with each hop.

**Code Quality Degradation**: GitClear analysis of 211M lines: code churn doubled 2021-2023, refactoring dropped from 25% to under 10%.

**Practical Guardrails That Work**: Cyclomatic complexity thresholds, length limits, duplication detection, cheap/fast models as safety screening layers. 27% of AI-assisted work consists of tasks that wouldn't have been done otherwise.

---

## Reference Implementations

### OpenAI Codex Team: Building with 0 Human-Written Code

The OpenAI team built and shipped an internal beta product with 0 lines of manually-written code over 5 months. ~1M lines of code, ~1,500 PRs merged, 3 engineers initially scaling to 7. Key takeaways relevant to our design:

#### Repository Knowledge as System of Record

They tried the "one big AGENTS.md" approach and it failed:
- Context is scarce. Giant instruction files crowd out the task and code.
- Too much guidance becomes non-guidance. When everything is "important," nothing is.
- It rots instantly. Monolithic manuals become graveyards of stale rules.
- It's hard to verify. A single blob doesn't lend itself to mechanical checks.

Their solution: **AGENTS.md as table of contents (~100 lines), pointing to structured `docs/` directory.** Progressive disclosure -- agents start with a small, stable entry point and are taught where to look next.

```
AGENTS.md          (map, ~100 lines)
ARCHITECTURE.md    (domain + package layering)
docs/
  design-docs/     (indexed, verification status tracked)
  exec-plans/
    active/        (living execution plans)
    completed/     (historical reference)
    tech-debt-tracker.md
  product-specs/
  references/      (llms.txt files for dependencies)
  PLANS.md         (plan index)
  QUALITY_SCORE.md (grades each domain + layer)
```

#### Exec-Plans as First-Class Artifacts

Ephemeral lightweight plans for small changes. Complex work captured in **execution plans** with:
- Progress log (timestamped checkboxes)
- Surprises & Discoveries (with evidence)
- Decision Log (rationale + date)
- Outcomes & Retrospective

Plans checked into the repository, versioned, co-located. Active plans, completed plans, and known technical debt all versioned.

#### Agent Legibility Over Human Legibility

"From the agent's point of view, anything it can't access in-context while running effectively doesn't exist." Knowledge in Google Docs, chat threads, or people's heads is invisible. Only repository-local, versioned artifacts matter.

They favored "boring" technologies that are easier for agents to model (composable, stable APIs, well-represented in training data). Sometimes cheaper to reimplement functionality than work around opaque upstream behavior.

#### Enforcing Architecture Mechanically

Built rigid architectural model: each business domain divided into fixed layers (Types -> Config -> Repo -> Service -> Runtime -> UI) with strictly validated dependency directions. Enforced via custom linters and structural tests. "This is the kind of architecture you usually postpone until you have hundreds of engineers. With coding agents, it's an early prerequisite."

Custom lint error messages inject remediation instructions into agent context.

#### Entropy and Garbage Collection

Full agent autonomy introduces drift -- agents replicate patterns that already exist, even suboptimal ones. Initially spent 20% of the week cleaning up "AI slop." That didn't scale.

Solution: "Golden principles" encoded in the repo + recurring cleanup process. Background Codex tasks scan for deviations, update quality grades, and open targeted refactoring PRs. Most reviewable in under a minute and auto-mergeable. Functions like garbage collection -- continuous small debt payments vs. painful bursts.

#### Throughput Changes Merge Philosophy

Minimal blocking merge gates. Short-lived PRs. Test flakes addressed with follow-up runs rather than blocking progress. "In a system where agent throughput far exceeds human attention, corrections are cheap, and waiting is expensive."

#### Increasing Levels of Autonomy

Made the application bootable per git worktree so Codex could launch and drive one instance per change. Wired Chrome DevTools Protocol into agent runtime. Exposed observability (logs, metrics, traces) via local stack that's ephemeral per worktree. Single Codex runs regularly work 6+ hours.

The full autonomous loop: validate codebase -> reproduce bug -> record video of failure -> implement fix -> validate fix -> record video of resolution -> open PR -> respond to feedback -> detect and remediate build failures -> escalate only when judgment required -> merge.

### Symphony: Autonomous Issue Orchestration

Symphony is an Elixir/OTP system that turns Linear into a continuous integration system for code changes, spawning isolated Codex agent workers to handle parallel independent tasks.

#### Architecture

- **Orchestrator** (1,655 lines): Continuous polling daemon monitoring a Linear project. State machine: Backlog -> Todo -> In Progress -> Human Review -> Merging -> Done (with Rework for feedback loops). Maintains concurrent agent pool with configurable limits per state. Records session completion totals (token usage, execution time). Publishes state to dashboard via PubSub.

- **Agent Runner** (228 lines): Executes individual Linear issues in isolated workspaces. Multi-host deployment (local + SSH workers). Turn-based execution with continuation: runs N turns, checks issue state, continues or yields. Max turns limit prevents infinite loops.

- **Codex App-Server Bridge** (1,087 lines): JSON-RPC 2.0 protocol client for Codex. Session lifecycle: start_session -> run_turn -> stop_session. Token accounting, auto-approval logic, sandbox isolation.

- **Workspace Isolation**: Per-issue directories (`~/.symphony-workspaces/<ISSUE_ID>`). Lifecycle hooks (after_create for git clone, before_remove). Path safety validation.

#### WORKFLOW.md as Configuration

Single document (YAML front matter + markdown body) defines entire agent behavior:

```yaml
tracker:
  kind: linear | memory
  active_states: [Todo, In Progress, Merging, Rework]
  terminal_states: [Closed, Done, Cancelled, Duplicate]
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  approval_policy: never
  thread_sandbox: workspace-write
workspace:
  root: ~/code/symphony-workspaces
hooks:
  after_create: |
    git clone https://github.com/... .
```

#### The Single Persistent Workpad Pattern

Each agent maintains one comment on the Linear issue as its running log. Agent posture:
1. Determine ticket state, route to matching flow
2. Move Todo -> In Progress immediately
3. Create/find `## Codex Workpad` comment (single persistent comment per issue)
4. Build hierarchical plan with checklist
5. Reproduce issue first, capture signal
6. Implement against plan, keep workpad current
7. Run validation before state transition
8. Address every PR review comment
9. Confirm checks green + acceptance criteria met
10. Move to Human Review, stop coding
11. On human approval -> Merging, use `land` skill
12. After merge -> Done

#### Key Patterns We Should Adopt

- **Turn-based continuation**: When session hits limits, task stays in_progress, next session picks up with full plan context. The plan IS the continuation state.
- **State-based concurrency limits**: Max N agents in each state simultaneously. Prevents resource contention.
- **Orchestrator as polling loop**: Simple, robust. Every N seconds, check for ready tasks, spawn agents up to concurrency limit. No complex event-driven machinery.
- **Skills as repository-local agent behaviors**: commit, push, pull, land, linear, debug -- each a focused skill file.
- **Rework flow**: On feedback, close old PR, delete old workpad, create fresh branch from main, restart clean. Don't try to patch a bad approach.

#### Critical Insight for Codecast

Symphony treats Linear as the external source of truth and the agent reads/writes to it. **Codecast IS the source of truth -- we don't need Linear.** We are the orchestrator AND the tracker. This is a massive advantage if we get the design right. We can have tighter integration, lower latency, and richer data than Symphony achieves by bridging to Linear.

---

## Current Codecast State

### What Exists and Works

**Convex Tables (fully defined, mature schemas):**
- `tasks` table: short hash IDs (`ct-a3f8`), task_type, status (draft/open/in_progress/in_review/done/dropped), priority, assignee, `blocked_by`/`blocks` arrays, session linkage (conversations array, created_from_conversation, attempt_count), drive state (current_round, rounds array), `source` field (human/agent/insight/import), team_id
- `docs` table: doc_type (doc/plan/decision/spec), content, team_id, project_id
- `projects` table: title, description, status, project_path, team_id, lead

**CLI Commands (complete):**
- `codecast task create/ls/show/start/done/comment/ready/context`
- `codecast project ls/create`
- `codecast doc create/ls/show`

**Task Mining Pipeline:**
- `taskMining.ts` mines tasks from session insights
- Runs via cron, creates draft tasks from blockers/next_actions in insights
- Currently creates disconnected tasks (the noise problem)

**Web Pages:**
- `/docs`, `/docs/[id]` -- document list and detail
- `/tasks`, `/tasks/[id]` -- task list and detail
- Basic list+detail UI, functional but not a planning surface

**Slash Commands:**
- `/drive` -- persistent plan file + iterative polish loop (writes to local `.claude/drive.md`)
- `/orchestrate` -- multi-agent coordinator, spawns implementers via tmux
- `/start` -- project initializer, creates spec, decomposes into features
- All operate on local files, not connected to Convex

**Agent Infrastructure:**
- tmux-based agent spawning (`agent-spawn.sh`, `agent-status.sh`, etc.)
- Worktree management (`wt`, `wtl`, `wtm`, `wtd`, `wts`, `wtc`)
- Resource locking (sim-acquire/release, port allocation by agent index)
- Implementor agent definition at `~/.claude/agents/implementor.md`

### What's Missing / Disconnected

- **No plan entity** connecting sessions to tasks to goals
- **No session-task binding** (sessions don't know what task they're working on structurally)
- **No plan persistence** across sessions (drive writes local file that dies with session)
- **No orchestration backbone** connected to the database (slash commands operate on local state)
- **Mining creates noise** -- 3 disconnected tasks instead of 1 coherent plan
- **Web UI is basic** -- list+detail, not a planning surface
- **Projects are empty containers** -- no planning, no progress, no timeline

### Earlier Design Work (Session jx7dkxt)

A massive 5600+ message session designed the task/doc/project system. Key outputs:
- Renamed `codecast task` (old scheduler) to `codecast schedule`
- Created new `task`, `project`, `doc` CLI commands
- Created `tasks` and `docs` Convex tables
- Built `taskMining.ts`
- Built web pages for docs, tasks, roadmap

User feedback from that session:
- Tasks/docs need team segregation (achieved later)
- Should use plan titles in UI
- Should be local-first across tasks and docs
- Plans should have "a very clear ability to reread the plans that the session is currently focused on"
- Docs page needs project filter pills
- Roadmap needed more timeline feel

The `/roadmap` page was later replaced with a redirect to `/team/activity` (session jx70f5d) because it was too similar to the Team Activity Feed.

---

## Design Decisions & Rationale

### Decision 1: Plans in Convex Only, Not Files

**Decision**: Plans live exclusively in Convex. Agents access them via CLI (`cast plan show`), not via materialized files.

**Rationale**: The file-based approach (materializing `.codecast/plans/ct-a3f8.md` into the working directory) was considered and rejected. It works for Codex because their agents run in sandboxed VMs without persistent CLI access. Claude Code agents have full CLI access -- they can call `cast plan show ct-a3f8` anytime. File sync introduces complexity (bidirectional sync, conflict resolution, stale files) without proportional benefit. Single source of truth in Convex is simpler and more reliable.

**Trade-off acknowledged**: Agents need to make a CLI call to read the plan rather than just reading a file. This is acceptable because (a) CLI calls are fast, (b) the plan context gets injected on session bind anyway, and (c) it eliminates an entire class of sync bugs.

### Decision 2: Plans Grow Organically from Ad-Hoc Agent Plans

**Decision**: Plans are not a rigid template imposed from the start. They grow from ad-hoc session plans via promotion.

**Rationale**: Claude Code agents already generate plan documents organically during sessions. The agent thinks through a problem, writes a plan, executes against it. This behavior is valuable and shouldn't be replaced. Instead, the system captures and promotes these organic plans into durable plan objects.

The lifecycle:
```
Ad-hoc agent plan (ephemeral, in session context)
    |  cast plan promote  or  cast plan create --from-session
    v
Draft plan (goal + rough tasks, in Convex)
    |  human activates or agent binds
    v
Active plan (structured, accumulating progress/decisions/discoveries)
    |  all tasks complete + criteria met
    v
Done plan (full history, searchable, referenceable)
```

A draft plan might just have a title and a goal. An active plan accumulates the exec-plan sections (progress log, decision log, discoveries, context pointers) as work happens. The structure is aspirational -- it emerges from use, not from enforcement.

### Decision 3: Structured Plan Sections (Inspired by OpenAI Exec-Plans)

**Decision**: Plans have defined sections that accumulate over time: Goal, Acceptance Criteria, Tasks, Progress Log, Decision Log, Discoveries, Context Pointers.

**Rationale**: The OpenAI exec-plan structure (Progress, Surprises & Discoveries, Decision Log, Outcomes) is proven to work for multi-hour agent work. These sections serve specific purposes:

- **Goal + Acceptance Criteria**: What we're trying to achieve and how we know we're done. The briefing.
- **Tasks**: Ordered, decomposed work items linked to the `tasks` table. The work breakdown.
- **Progress Log**: Timestamped entries of what happened. The workpad (Symphony's "single persistent workpad" pattern). This is gold for debugging, handoffs, and continuation.
- **Decision Log**: What was decided and why. Critical for preventing future agents from re-litigating settled questions.
- **Discoveries**: Things learned during execution that weren't in the original plan. Surprises, findings, insights.
- **Context Pointers**: Where to look for deeper information (file paths, PR links, doc references). Progressive disclosure.

These sections are not enforced at creation time. They accumulate naturally as agents and humans update the plan via CLI commands (`cast plan update --log`, `cast plan decide`, `cast plan discover`).

### Decision 4: Every Entry Point Converges on Same State

**Decision**: Whether work starts from the web UI, CLI, an orchestrator, or within an existing session, all paths read and write the same Convex plan/task state.

**Rationale**: This is the core architectural principle. If the UI shows one state and the CLI shows another, the system is broken. Convex provides real-time sync and subscriptions, making this natural.

Entry points:
- **Web UI**: Click "Start" on a task -> spawns a new agent session bound to that task's plan
- **CLI**: `cast task start ct-a3f8` -> current session binds to the task and its plan
- **Within a session**: Agent realizes work is complex, creates plan mid-stream
- **Orchestrator**: Polls for ready tasks, spawns sessions automatically
- **Mining**: Session insight gets promoted to a draft plan

### Decision 5: No Workflow Table, Simple State Machine

**Decision**: Keep task states simple (draft/open/in_progress/in_review/done/dropped) and handle orchestration logic in CLI/slash commands, not in a configurable workflow table.

**Rationale**: Symphony's configurable WORKFLOW.md with YAML state machine definitions is powerful but overkill for our current needs. We're not building a generic orchestration platform -- we're building codecast's planning layer. Adding workflow configuration adds complexity without clear benefit right now. If we need configurable workflows later, we can add them. For now, the state machine is simple and hardcoded.

---

## Architecture

```
+-------------------------------------------------------------+
|                      CONVEX (Cloud DB)                       |
|                                                              |
|  projects --+-- plans --+-- tasks                            |
|             |           |                                    |
|             |           +-- plan_sessions (via plan.sessions) |
|             |                                                |
|  conversations ---- active_plan_id                           |
|                ---- active_task_id                            |
|                                                              |
|  session_insights ---> plan mining pipeline                  |
+------------------------------+-------------------------------+
                               | CLI reads/writes
                               v
+-------------------------------------------------------------+
|                    CLI (cast command)                         |
|                                                              |
|  cast plan create/ls/show/bind/update/promote/orchestrate    |
|  cast task create/start/done (enhanced with --plan)          |
|                                                              |
|  On plan bind:                                               |
|    - Sets conversation.active_plan_id                        |
|    - Injects plan context into agent via snippet mechanism   |
|    - Agent can read full plan via cast plan show              |
|    - Progress updates via cast plan update --log             |
+-------------------------------------------------------------+

+-------------------------------------------------------------+
|                        WEB UI                                |
|                                                              |
|  Plan Board:  [Active Plans] [Draft Plans] [Done]            |
|    - Column view, cards with progress bars                   |
|    - Active session indicators                               |
|    - Quick actions: activate, pause, assign                  |
|                                                              |
|  Plan Detail:                                                |
|    - Header: title, status, owner, project                   |
|    - Tabs: Tasks | Progress | Decisions | Sessions           |
|    - Inline task management, drag to reorder                 |
|                                                              |
|  Inbox Enhancement:                                          |
|    - Sessions show bound plan name                           |
|    - "Draft Plans" section for triage                        |
|    - Task ready count badge                                  |
|                                                              |
|  Session View Enhancement:                                   |
|    - Plan context panel when session has active_plan_id      |
|    - "Promote to Plan" button for ad-hoc plans               |
+-------------------------------------------------------------+

+-------------------------------------------------------------+
|                     ORCHESTRATION                             |
|                                                              |
|  cast plan orchestrate <plan_id>:                            |
|    - Read plan, identify ready tasks                         |
|    - Spawn worker per task in worktree                       |
|    - Each worker binds to plan, claims task                  |
|    - Workers run with plan context injected                  |
|    - On completion: sync to Convex, cleanup                  |
|    - Monitor plan.progress for overall status                |
|                                                              |
|  Daemon mode (future):                                       |
|    - Poll Convex every 5s for ready tasks                    |
|    - Spawn agents up to concurrency limit                    |
|    - Handle turn continuation on max_turns                   |
|    - Symphony-style robust polling loop                      |
+-------------------------------------------------------------+
```

---

## Data Model

### New Table: `plans`

```typescript
plans: defineTable({
  // Identity
  short_id: v.string(),        // ct-xxx format, human-friendly
  title: v.string(),

  // Content
  goal: v.optional(v.string()),
  acceptance_criteria: v.optional(v.array(v.string())),

  // Status
  status: v.union(
    v.literal("draft"),       // Created but not yet activated
    v.literal("active"),      // Being worked on
    v.literal("paused"),      // Temporarily stopped
    v.literal("done"),        // All criteria met
    v.literal("abandoned"),   // Won't complete
  ),

  // Provenance
  source: v.union(
    v.literal("human"),       // Created by human in UI or CLI
    v.literal("agent"),       // Created by agent mid-session
    v.literal("insight"),     // Auto-created from session insight mining
    v.literal("promoted"),    // Promoted from ad-hoc session plan
  ),

  // Ownership
  owner_id: v.optional(v.id("users")),
  team_id: v.id("teams"),
  project_id: v.optional(v.id("projects")),

  // Task ordering
  task_ids: v.array(v.string()),  // Ordered list of task short_ids

  // Progress (auto-calculated from linked tasks)
  progress: v.object({
    total: v.number(),
    done: v.number(),
    in_progress: v.number(),
    blocked: v.number(),
  }),

  // Structured logs (the exec-plan sections)
  progress_log: v.array(v.object({
    timestamp: v.number(),
    entry: v.string(),
    session_id: v.optional(v.string()),
  })),

  decision_log: v.array(v.object({
    timestamp: v.number(),
    decision: v.string(),
    rationale: v.string(),
    session_id: v.optional(v.string()),
  })),

  discoveries: v.array(v.object({
    timestamp: v.number(),
    finding: v.string(),
    session_id: v.optional(v.string()),
  })),

  context_pointers: v.array(v.object({
    label: v.string(),
    path_or_url: v.string(),
  })),

  // Session linkage
  session_ids: v.array(v.string()),        // All conversations that worked on this
  current_session_id: v.optional(v.string()), // Currently active session

  // Provenance links
  created_from_conversation_id: v.optional(v.string()),
  created_from_insight_id: v.optional(v.id("session_insights")),
})
  .index("by_team_id", ["team_id"])
  .index("by_project_id", ["project_id"])
  .index("by_status", ["status"])
  .index("by_short_id", ["short_id"])
  .index("by_team_and_status", ["team_id", "status"])
```

### Modifications to Existing Tables

**tasks table -- add field:**
```typescript
plan_id: v.optional(v.id("plans")),  // Links task to parent plan
```

**conversations table -- add fields:**
```typescript
active_plan_id: v.optional(v.id("plans")),   // Plan this session is working on
active_task_id: v.optional(v.string()),       // Specific task (short_id)
```

### Why This Model

- **`plan_id` on tasks is optional**: Tasks can exist independently (standalone work items) or as part of a plan. This preserves backward compatibility and supports the bottom-up pattern where tasks exist before a plan does.
- **`task_ids` on plans is an ordered array**: Defines execution order. Not a join table -- the plan owns the ordering.
- **Progress is denormalized**: Calculated from linked tasks but stored on the plan for fast reads. Updated on task status changes via Convex mutation triggers.
- **Structured logs are arrays, not markdown**: Each entry has a timestamp and optional session_id. This enables filtering, sorting, and rich display in the web UI. The CLI can render them as markdown.
- **`session_ids` vs `current_session_id`**: History (all sessions that ever worked on this) vs. present (who's working on it now). `current_session_id` clears when a session ends.
- **`source` field**: Enables different UI treatment. Draft plans from mining show as "triage needed." Human-created plans show as "ready to work."

---

## CLI Commands

### Plan Commands

```bash
# Create a plan
cast plan create "Refactor auth to JWT"
cast plan create "Add real-time collab" -g "Enable multiple users to edit simultaneously" -a "Cursor presence works" -a "Conflict resolution tested"
cast plan create --from-session    # Promote current session's ad-hoc plan

# List plans
cast plan ls                       # Active plans (default)
cast plan ls --all                 # All statuses
cast plan ls --draft               # Draft plans needing triage
cast plan ls --project <project>   # Filter by project

# Show plan detail
cast plan show <plan_id>           # Full plan with all sections rendered
cast plan show <plan_id> --tasks   # Just the task list
cast plan show <plan_id> --log     # Just the progress log

# Bind/unbind current session to plan
cast plan bind <plan_id>           # Bind session, inject context
cast plan unbind                   # Unbind session

# Update plan (append to structured logs)
cast plan update <plan_id> --log "Completed auth module refactor"
cast plan update <plan_id> --goal "Updated goal text"
cast plan decide <plan_id> "Use jose for JWT" --rationale "Stable, well-documented, in training set"
cast plan discover <plan_id> "Rate limiting middleware already exists but isn't wired to auth routes"
cast plan pointer <plan_id> "Auth module" "packages/api/src/auth/"

# Status transitions
cast plan activate <plan_id>       # draft -> active
cast plan pause <plan_id>          # active -> paused
cast plan done <plan_id>           # active -> done
cast plan drop <plan_id>           # any -> abandoned

# Promote ad-hoc plan from session
cast plan promote                  # Interactive: extracts plan from current session context

# Orchestrate
cast plan orchestrate <plan_id>    # Spawn workers for ready tasks
```

### Enhanced Task Commands

```bash
# Create task within a plan
cast task create "Write JWT middleware" --plan <plan_id>
cast task create "Add refresh token rotation" --plan <plan_id> --after ct-a3f8

# Start task (binds session to task AND its plan)
cast task start <task_id>          # Claims task, binds to plan, injects context

# Existing commands unchanged
cast task done <task_id>
cast task ready
cast task ready --plan <plan_id>   # Ready tasks for specific plan
```

---

## Session-Plan Integration

### Binding a Session to a Plan

When a session binds to a plan (via `cast plan bind`, `cast task start`, or orchestrator spawn):

1. **`conversation.active_plan_id`** set in Convex
2. **`conversation.active_task_id`** set if starting a specific task
3. **Plan context injected** into the agent's context via the existing snippet mechanism (the same way session insights are injected today). This includes: title, goal, acceptance criteria, task list with statuses, recent progress log entries, context pointers.
4. **Agent can read full plan** via `cast plan show` at any time
5. **Progress updates** via `cast plan update --log "..."` -- the agent calls this naturally as it works
6. **Decision/discovery logging** via `cast plan decide` and `cast plan discover`
7. **When session ends**, `plan.current_session_id` clears but the session is retained in `plan.session_ids`
8. **Next session** can bind to same plan and pick up with full context from Convex

### Context Injection Format

When plan context is injected into a session, it should be concise and actionable:

```
## Active Plan: Refactor auth to JWT (ct-a3f8)
Status: active | 3/7 tasks done | 2 in progress

Goal: Migrate from session-based auth to JWT tokens with refresh rotation.

Current tasks:
- [x] ct-b2c4: Design token schema
- [x] ct-d5e6: Implement JWT signing
- [x] ct-f7g8: Add token validation middleware
- [ ] ct-h9i0: Implement refresh token rotation (in_progress)
- [ ] ct-j1k2: Wire rate limiting to auth routes (open)
- [ ] ct-l3m4: Migration script for existing sessions (open, blocked by ct-h9i0)
- [ ] ct-n5o6: E2E auth flow tests (open, blocked by ct-j1k2)

Recent progress:
- 2026-03-11 15:45: Token validation middleware passing all tests
- 2026-03-11 14:30: JWT signing module uses jose library

Context: packages/api/src/auth/ | PR #142 | docs/specs/auth-v2.md

Run `cast plan show ct-a3f8` for full detail.
```

This follows the progressive disclosure principle -- enough context to orient the agent, with a pointer to the full plan.

### Plan as Continuation State

This is the key insight from Symphony applied to our architecture. When a session ends (crashes, compacts, user closes it), the plan retains:
- What tasks are done vs. in progress vs. blocked
- The progress log of what happened
- Decisions that were made and why
- Discoveries about the codebase
- Pointers to relevant code and docs

The next session that binds to this plan gets all of this injected as context. The plan IS the continuation state. No more starting from scratch.

---

## Web UI Surfaces

### Plan Board (New Page: `/plans`)

Column-based view (not kanban -- simpler):

**Left sidebar**: Plan list grouped by status
- Active plans (sorted by last activity)
- Draft plans (needs triage badge)
- Paused plans
- Done plans (collapsed by default)

**Main area**: Selected plan detail
- Header: title, status badge, progress bar, owner, project
- Action buttons: Activate/Pause/Done, Spawn Agent, Edit
- Tabbed content:

**Tasks Tab:**
- Ordered task list with inline status indicators
- Drag to reorder
- Add new task inline
- Click task to expand detail (or link to task detail page)
- Blocked-by indicators
- "Start" button per task (spawns agent session)

**Progress Tab:**
- Timestamped log entries (the workpad)
- Session links on entries (click to jump to the session message)
- Newest first, with date separators

**Decisions Tab:**
- Decision + rationale pairs
- Timestamped, with session links

**Sessions Tab:**
- All sessions that worked on this plan
- Active session highlighted
- Session summary/title with link to session view

### Plan Detail Page (`/plans/[id]`)

Same content as the main area in the board view, but standalone. Useful for deep-linking and sharing.

### Inbox Enhancement

The existing inbox should show plan context:
- Sessions display their bound plan name as a tag/badge
- "Draft Plans" section appears when there are plans needing triage
- Each draft plan shows: title, source (agent/insight), creation context
- Quick actions: Activate, Drop, Merge into existing plan

### Session View Enhancement

When viewing a session that has `active_plan_id`:
- Plan context panel (collapsible) showing current plan state
- Link to plan detail
- If session created an ad-hoc plan (detected from session content), show "Promote to Plan" button

### Task Detail Enhancement

When viewing a task that has `plan_id`:
- Link to parent plan
- Plan progress context (where this task sits in the overall plan)
- Other tasks in the plan listed as related items

---

## Mining Pipeline Evolution

### Current Behavior

Session ends -> `taskMining.ts` runs -> creates 1-3 draft tasks from insight fields (blockers, next_action, unresolved_issues). These tasks are disconnected, creating noise.

### New Behavior

The mining pipeline should create plans when appropriate:

**Step 1: Analyze the insight**
- Does it have a coherent goal (from `plan_title` or `summary`)?
- Does it have multiple related action items (blockers + next_actions)?
- Is the work multi-step (more than one task)?

**Step 2: Check existing plans**
- Do any active plans relate to this insight's topic?
- Would these tasks fit naturally into an existing plan?

**Step 3: Route appropriately**
- **Single atomic task**: Create standalone draft task (current behavior)
- **Multi-step effort, no existing plan**: Create draft plan with grouped tasks
- **Related to existing plan**: Add tasks to existing plan, append to progress log

**Step 4: Reduce noise**
- Draft plans appear as a single triage item, not N disconnected tasks
- Human sees "Draft Plan: Refactor auth (3 tasks)" instead of 3 unrelated items
- One-click to activate, drop, or merge

### Implementation Notes

The mining logic in `taskMining.ts` needs to:
1. Check for existing plans by team + project before creating new ones (fuzzy match on title/goal)
2. Group related tasks from the same insight into a plan
3. Set `source: "insight"` on auto-created plans
4. Link `created_from_insight_id` for traceability

---

## Orchestration

### From-Session Orchestration

The most natural entry point. You're in a session, you have a plan, you want to parallelize:

```
You: "Spawn workers for the remaining tasks on this plan"

Agent:
  1. Reads plan via cast plan show
  2. Identifies ready tasks (open, not blocked)
  3. For each ready task (up to concurrency limit):
     a. Creates worktree: wt <task-short-id>
     b. Spawns implementer: agent-spawn.sh implementor impl-<task-id> .conductor/<task-id> "Work on task ct-xxx. Plan context: ..."
     c. Implementer binds to plan + task on startup
  4. Monitors progress via cast plan show (progress auto-updates)
  5. When all tasks done, verifies acceptance criteria
```

### From-CLI Orchestration

```bash
cast plan orchestrate ct-a3f8
# Equivalent to the above but non-interactive
# Spawns workers, monitors, reports
```

### From-UI Orchestration (Future)

"Start All" button on a plan. Creates a daemon process that:
- Spawns agent sessions for ready tasks
- Monitors progress
- Reports back to the UI in real-time

### Daemon Mode (Future, Symphony-Style)

A background process that continuously:
1. Polls Convex every 5s for plans with ready tasks
2. Spawns agents up to configured concurrency limit
3. Handles turn continuation when agents hit max turns
4. Records token usage and throughput
5. Exposes status via web dashboard

This is essentially Symphony but with Convex as the tracker instead of Linear. The existing `codecast schedule` infrastructure could host this.

### Concurrency Management

- **Per-plan concurrency**: Max N agents working on tasks in the same plan simultaneously (default 3)
- **Global concurrency**: Max M agents running across all plans (default 5)
- **State-based limits** (Symphony pattern): Limit how many tasks can be in each state. E.g., max 1 in `in_review` (prevents overwhelming the reviewer).
- **Resource allocation**: Agents use existing port allocation (8081-8084) and simulator pool (sim-acquire/release) by agent index.

---

## Implementation Phases

### Phase 1: Foundation (Plan Table + CLI)

**Goal**: Plans are a first-class entity that agents and humans can create, read, and update.

**Deliverables:**
1. Add `plans` table to Convex schema
2. Add `plan_id` to `tasks` table
3. Add `active_plan_id` and `active_task_id` to `conversations` table
4. Convex mutations: `createPlan`, `updatePlan`, `updatePlanStatus`, `addPlanLogEntry`, `addPlanDecision`, `addPlanDiscovery`, `addPlanPointer`, `bindSessionToPlan`, `unbindSessionFromPlan`
5. Convex queries: `getPlan`, `listPlans`, `getPlansByTeam`, `getPlansByProject`, `getPlanWithTasks`
6. Progress auto-calculation: when task status changes, recalculate parent plan's progress
7. CLI commands: `cast plan create`, `cast plan ls`, `cast plan show`, `cast plan bind`, `cast plan unbind`, `cast plan update --log`, `cast plan decide`, `cast plan discover`, `cast plan pointer`, `cast plan activate`, `cast plan pause`, `cast plan done`, `cast plan drop`, `cast plan promote`
8. Enhanced `cast task create --plan` and `cast task start` (auto-binds to plan)
9. Plan context injection into sessions on bind

**Validation**: Create a plan via CLI, bind a session, update progress, verify state persists across session restarts.

### Phase 2: Web UI

**Goal**: Humans can see, manage, and interact with plans in the web interface.

**Deliverables:**
1. Plan board page (`/plans`) with column view
2. Plan detail page (`/plans/[id]`) with tabs
3. Inbox integration (plan name on sessions, draft plans section)
4. Session view enhancement (plan context panel)
5. Task detail enhancement (parent plan link)
6. "Promote to Plan" flow (from session or insight)
7. Plan creation form in UI
8. Task management within plan (add, reorder, assign)

**Validation**: Create plan in UI, see tasks and progress, observe live updates from agent sessions.

### Phase 3: Smart Mining

**Goal**: Session insights produce coherent plans instead of disconnected task noise.

**Deliverables:**
1. Mining pipeline checks existing plans before creating new tasks
2. Multi-step insights create draft plans with grouped tasks
3. Single-step insights create standalone tasks (current behavior)
4. Related insights append to existing plans
5. Draft plan triage in inbox (single item instead of N tasks)

**Validation**: End a multi-step session, verify mining creates a draft plan with grouped tasks instead of 3 disconnected tasks.

### Phase 4: Orchestration Integration

**Goal**: Spawn and manage parallel agent workers from within a session, via CLI, or from the UI.

**Deliverables:**
1. `cast plan orchestrate <plan_id>` command
2. Integration with existing tmux agent infrastructure
3. Worktree-per-task isolation
4. Worker agents auto-bind to plan + task
5. Concurrency limits (per-plan and global)
6. Progress monitoring and reporting
7. Turn-based continuation (task stays in_progress when session ends, next session picks up)
8. Update `/orchestrate` and `/drive` slash commands to use plan state from Convex

**Validation**: Create plan with 3 tasks, run `cast plan orchestrate`, verify 3 parallel workers spawn, each working on a task, progress updates flowing to plan.

### Phase 5: Daemon Mode (Future)

**Goal**: Continuous autonomous orchestration loop, Symphony-style.

**Deliverables:**
1. Background polling daemon (integrated into `codecast schedule` or standalone)
2. Polls Convex for plans with ready tasks
3. Spawns agents up to concurrency limit
4. Handles continuation, retries, exponential backoff
5. Token accounting and throughput tracking
6. Web dashboard for daemon status
7. Configurable via workflow definitions

**Validation**: Start daemon, create plan with tasks, observe automatic agent spawning, task completion, and plan progress without human intervention.

---

## Open Questions & Future Work

### Questions to Resolve During Implementation

1. **Plan short_id format**: Should plans use the same `ct-xxx` format as tasks, or a distinct prefix like `cp-xxx` to distinguish them visually?

2. **Plan-to-plan relationships**: Should plans be nestable (sub-plans)? For now, no -- keep it flat. Plans group tasks. Projects group plans. Two levels is enough.

3. **Plan archiving/cleanup**: How long do done/abandoned plans persist? Do we need an archiving mechanism or is Convex storage cheap enough to keep everything?

4. **Conflict resolution**: What happens when two agents try to update the same plan simultaneously? Convex handles this at the mutation level, but we need to think about semantic conflicts (two agents both claiming the same task).

5. **Plan templates**: Should we support plan templates for common patterns (e.g., "Feature Implementation Plan" with standard tasks like design, implement, test, deploy)? Defer to Phase 5+.

6. **Integration with Claude Code Agent Teams**: When Agent Teams matures, should our plans map to their task format? Worth monitoring but not designing for now.

### Future Directions

- **Plan analytics**: Which plans complete fastest? Which tasks are most commonly blocked? Where do agents struggle? Feed this back into process improvement.
- **Cross-project plans**: Plans that span multiple repositories/projects. Requires cross-project task linking.
- **Plan diffing**: Compare plan state at two points in time. What changed, what was decided, what was discovered.
- **Agent performance tracking**: Per-agent success rates, token efficiency, task completion rates. Tied to plan/task data.
- **Plan sharing**: Share a plan (read-only or collaborative) with external stakeholders via a public URL.
- **Plan import/export**: Import from Linear, GitHub Issues, Notion. Export as markdown or structured formats.
- **Automated plan decomposition**: Given a high-level goal, use an LLM to decompose into tasks with dependencies. The `/start` command already does a version of this.
- **Quality scoring**: Per the OpenAI team's QUALITY_SCORE.md pattern, track quality grades per domain/layer and tie them to plans.
- **Doc gardening**: Periodic agent that scans for stale plans, updates progress, closes abandoned work.

---

## Appendix: Key Sources

- OpenAI Codex Team: "Building software with a team of agents" (2026) -- 0 human-written code experiment
- Symphony (~/src/symphony) -- Elixir/OTP autonomous issue orchestration using Linear + Codex
- Claude Code Agent Teams documentation (Feb 2026)
- Anthropic 2026 Agentic Coding Trends Report
- Mike Mason: "AI Coding Agents in 2026: Coherence Through Orchestration"
- Martin Fowler / Thoughtworks: "Humans and Agents in Software Engineering Loops"
- Steve Yegge: Beads memory system + Gas Town multi-agent workspace
- OpenAI Codex CLI: PLANS.md exec-plan pattern
- METR Study: AI tool productivity perception gap
- Google DORA Report 2025: AI adoption impact on software delivery
- LinearB: AI-generated PR rejection rates
- Session jx7dkxt: Original codecast task/doc/project design session (5600+ messages)
- Session jx70f5d: Roadmap page removal, team scoping fixes
- Session jx73qx3: Drive system research session
