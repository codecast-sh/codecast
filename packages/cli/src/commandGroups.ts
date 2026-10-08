/**
 * The command groups that load only when you name them.
 *
 * fastPath.ts describes the shape of the problem: ES imports are hoisted, so a
 * static `import` in index.ts is paid by every invocation, including the ones
 * that never reach the command it registers. index.ts is 18k lines and its
 * static graph was 260 source files and 5.5 MB — `cast --help`, `cast state`
 * and a mistyped verb each loaded the browser engine, the worktree backends,
 * the ssh host plumbing and the capability walkers before printing anything.
 *
 * So a group is split in two. Here: the token, its aliases, the positional
 * terms the root help prints, and the description — enough to render
 * `cast --help` and to answer a typo, and nothing that imports anything. In the
 * group's own module: the real command with its options, its subcommands and
 * its actions, reached through `load()` at the moment argv names the group.
 *
 * The description lives HERE and the group module reads it back
 * (`commandGroup("state").description`), so the line a placeholder renders in
 * the root help and the line the real command renders are the same string
 * rather than two copies that drift. The rest of the help term — the arguments
 * and whether the command takes options — is held to the real registration by
 * commandGroups.test.ts.
 *
 * Two rules keep it lazy, both enforced by bench/bootGraph.guard.test.ts:
 *   - `load()` is a dynamic `import()`, never a static one. That is what keeps
 *     the group off the graph from source and in the compiled binary alike.
 *   - no module on index.ts's own graph may static-import a listed group
 *     either, or the group is back on every invocation's bill sideways.
 *
 * Adding a group is one entry: its token, its description moved here out of the
 * module, and a `load()` that imports the register function. That is also how a
 * group that used to be registered eagerly joins, in place of the
 * `registerXCommand(program)` line it had in index.ts — which is how
 * `cast computer` (ct-49521) and `cast guide` (ct-49544) are registered.
 * Nothing may reach those two any other way: a register function exported
 * under `computer/` or by `guide.ts` that index.ts also calls directly is a
 * failure of commandGroups.guard.test.ts. ct-49546, ct-49848, ct-49849.
 */

import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";

/** Everything any group's register function asks for: the backend deps every
 *  command needs, plus the one lookup `cast integrations` adds. A register
 *  function destructures the keys it uses, so a wider object is harmless.
 *  Type-only imports, so this stays a leaf at runtime. */
export interface GroupDeps extends PublishDeps {
  resolveProjectId: (ref: string) => Promise<string>;
}

export interface CommandGroup {
  /** The first token that names this group. */
  token: string;
  /** Alternate first tokens. The first also shows in the root help term. */
  aliases?: readonly string[];
  /** Hidden from the root help, as the real command is. */
  hidden?: boolean;
  /** Positional terms, exactly as the root help prints them. */
  args?: readonly string[];
  /** Whether the real command declares options, which the term shows. */
  hasOptions?: boolean;
  /** The group's description. The single copy; the group module reads it back. */
  description: string;
  /** The dynamic import of the real registration. Never make this static. */
  load: () => Promise<(program: Command, deps: GroupDeps) => void>;
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    token: "sharing",
    hasOptions: true,
    description: "See and change what syncs to codecast and what each team sees of it",
    load: () => import("./sharing/command.js").then((m) => m.registerSharingCommand),
  },
  {
    token: "review",
    description: "Collect review notes on files and lines, then hand the batch to a session",
    load: () => import("./reviewCommand.js").then((m) => m.registerReviewCommand),
  },
  {
    token: "workspace",
    aliases: ["ws"],
    description: `Manage isolated git worktrees for parallel agent work`,
    load: () => import("./workspace/cli.js").then((m) => m.registerWorkspaceCommand),
  },
  {
    token: "land",
    description: `Find the work every worktree and cloud host holds that main does not, release finished trees, and level a checkout onto its upstream`,
    load: () => import("./land/cli.js").then((m) => m.registerLandCommand),
  },
  {
    token: "dev",
    args: ["[service...]"],
    hasOptions: true,
    description: `Start (or reuse) this checkout's dev server on its own port and print the URL`,
    load: () => import("./workspace/devCli.js").then((m) => m.registerDevCommand),
  },
  {
    token: "remote",
    description: `Move sessions to and from cloud hosts, and mirror a cloud session's edits here`,
    load: () => import("./remote/cli.js").then((m) => m.registerRemoteCommand),
  },
  {
    token: "cloud",
    hidden: true,
    description: `Cloud host plumbing used by the daemon`,
    load: () => import("./cloud/cli.js").then((m) => m.registerCloudCommand),
  },
  {
    token: "git-credential",
    hidden: true,
    args: ["[operation]"],
    hasOptions: true,
    description: `Git credential helper: a GitHub App installation token for this cloud host`,
    load: () => import("./cloud/gitCredential.js").then((m) => m.registerGitCredentialCommand),
  },
  {
    token: "migrate",
    description: `Move many sessions between this machine and a cloud host at once`,
    load: () => import("./migrate/cli.js").then((m) => m.registerMigrateCommand),
  },
  {
    token: "hosts",
    description: `Remote machines: what runs on them, and what they cost`,
    load: () => import("./hosts/cli.js").then((m) => m.registerHostsCommand),
  },
  {
    token: "publish",
    args: ["[target]","[args...]"],
    hasOptions: true,
    description: `Publish an HTML/markdown file or a directory bundle to a shareable codecast.sh/a/<slug> URL

Re-publishing the same path updates the same URL (version history kept).

Subcommands:
  cast publish ls                          List your published pages
  cast publish rm <slug|path>              Unpublish
  cast publish rollback <slug|path> <n>    Restore version n as a new version
  cast publish open <slug|path>            Print + open the share URL
  cast publish versions <slug|path>        Version history (+ rollback/diff hints)
  cast publish comments <slug|path>        Read viewer comments; --resolve <id> | --resolve-all
  cast publish viewers <slug|path>         View count + who opened it (email gate)
  cast publish links <slug|path>           share / manage / edit / source / live URLs
  cast publish set <slug|path> [flags]     Change gates or title WITHOUT republishing`,
    load: () => import("./publish.js").then((m) => m.registerPublishCommand),
  },
  {
    token: "cap",
    description: `Capabilities across your machines: skills, plugins, MCP servers, hooks`,
    load: () => import("./capabilities/cli.js").then((m) => m.registerCapabilityCommand),
  },
  {
    token: "decide",
    args: ["[question]","[args...]"],
    hasOptions: true,
    description: `Hand your human one decision: question, options, and the context to choose

The decision appears in their queue and renders as a card in the conversation;
the answer arrives back in this session as a message. Default is blocking:
post it, then end your turn.

Subcommands:
  cast decide ls [--mine]             This session's decisions, with ids and answers; --mine: every pending decision you hold
  cast decide edit [id] [flags]       Change the open decision in place; every ask flag applies (question, -o, --context, --report, --doc, --kind, --task, --station, --stack, --category, --option-page, --advisory/--blocking)
  cast decide cancel [id]             Withdraw the open decision
  cast decide show <sd>               One decision with its document, ladder and holder
  cast decide recommend <sd> <n>      A role on the ladder recommends option n (within 5 minutes; --note -)
  cast decide answer <sd> <n>         Answer: n | "1,3" (multi) | "2>1>3" (rank) | --form k=v (form)
                                      --for-human: from a session, as your human, only at their explicit word

Ask flags: --task ct-N (default: the bound task) --station s --stack ds-N --category c
  --kind single|multi|rank|form --doc file.md|- --spec spec.json --option-body n=file.md
  --option-page n=file.html|slug|url   a page per option (a file publishes like --report); spec: "page" per option

Examples:
  cast decide "Which schema wins?" -o "Frontmatter wins" -o "Path wins" --context -  <<'EOF'
  The daemon writes note ids from the file path; the web index derives
  them from frontmatter. Renames keep one id and change the other, so
  the same note indexes twice. Either side can be authoritative.
  EOF
  cast decide "Approve dropping agent_runs_v1?" -o "Approve :: frees the last migration" -o "Hold" \\
    --context "Nothing wrote to it in 40 days. Not recoverable without a backup restore." \\
    --report drop-analysis.html
  cast decide "Back off or switch keys?" -o "Back off" -o "Switch keys" --advisory --default 1 \\
    --context "429s for 4m. Backing off costs ~20m of throughput."
  cast decide edit --context - <<'EOF'          # new facts: rewrite the open decision's context
  …
  EOF
  cast decide cancel                           # the question no longer applies`,
    load: () => import("./decideCommand.js").then((m) => m.registerDecideCommand),
  },
  {
    token: "stack",
    args: ["[sub]", "[args...]"],
    hasOptions: true,
    description: `Decision stacks: an ordered set of decisions your human clears in one sitting

  cast stack create "<title>" [--policy auto-default:24h] [--delegate @handle]
  cast stack ls [--all]
  cast stack show ds-N
  cast stack add ds-N sd-N
  cast stack remove ds-N sd-N
  cast stack reorder ds-N sd-a,sd-b      # every member, in the new order
  cast stack policy ds-N [--auto-default 24h | --no-auto-default] [--delegate @handle] [--due 3h|tomorrow|2026-09-20 | --no-due]
  cast stack delegate ds-N @handle       # the role answers every open category for the stack's members`,
    load: () => import("./stackCommand.js").then((m) => m.registerStackCommand),
  },
  {
    token: "signal",
    description: `Signals: file what a finder saw; each attaches to one cause task

  cast signal add --source <finder> --kind <kind> --fingerprint <key> --title "<one line>" [--detail -] [--url <url>] [--subject <ref>] [--goal-hint <metric>]
  cast signal ls [--task ct-N] [--source <finder>]
  cast signal show sg-N`,
    load: () => import("./signalCommand.js").then((m) => m.registerSignalCommand),
  },
  {
    token: "mod",
    aliases: ["mods"],
    description: `Mods: extend codecast with panes, commands and blocks agents can draw, written as one hooks module

  cast mod new <name>          scaffold one that already works
  cast mod dev                 push on every save, print its logs
  cast mod push | publish      one dev push | a numbered version with source
  cast mod inspect             what it hooks, calls and reads vs what it is granted
  cast mod ls | logs <name> | versions <name> | pull <name> | rollback <name> <v>
  cast mod enable | disable | rm <name>

codecast-mod.json declares what a mod adds and touches: permissions, panes,
commands, fences, sidebar, objects (new kinds like bug-14), local (a half the
daemon runs where you approve it) and agents (guidance cast mod guide prints).
The API, every element and every event are typed in codecast-mod.d.ts in the
mod's folder (cast mod types rewrites it).`,
    load: () => import("./modCommand.js").then((m) => m.registerModCommand),
  },
  {
    token: "obj",
    aliases: ["objects"],
    description: `Objects of the kinds mods declare (bug-14, inc-3): file them, list them, move them along

  cast obj kinds                         every kind, its statuses and fields
  cast obj ls <prefix> [--status s] [--all]
  cast obj create <prefix> "<title>" [--set field=value] [--body -]
  cast obj show <id> | set <id> [--status s] [--set field=value] | done <id> | archive <id>

Short ids render as live pills wherever codecast shows prose.`,
    load: () => import("./objCommand.js").then((m) => m.registerObjCommand),
  },
  {
    token: "goals",
    hasOptions: true,
    description: `Goals: the workspace's active initiatives with their metrics, project charters and principles, as one document

  cast goals [--brief] [--json] [--project <ref> | --task <ct>] [--team <name|id|personal>]

--brief is the compact shape a prompt reads. Each metric prints with its goal_ref
(in-N:key); a project's goal_ref is its short id. --task reads the brief a cause
is grounded against: its own project's, else its workspace's.`,
    load: () => import("./goalsCommand.js").then((m) => m.registerGoalsCommand),
  },
  {
    token: "expectations",
    description: `Expectations: how a project should behave, each line with its sources, versioned and changed only through proposals

  cast expectations show [--project <ref>] [--at <version>] [--brief] [--json]
  cast expectations propose <file|-> [--project <ref>] [--hold]
  cast expectations apply|drop <xp-N>
  cast expectations routine [--project <ref>]

--brief is what a judge reads: the active lines with ids under the version a
finding cites. A proposal that only adds lines, each in a person's quoted,
dated words, applies on its own; any other change waits for the project's person.`,
    load: () => import("./expectationsCommand.js").then((m) => m.registerExpectationsCommand),
  },
  {
    token: "card",
    description: `The change card: one change and its proof, the page a person answers Ship, Revise or Drop on

  cast card build --task ct-N [--eval-result eval-result.json] [--proof proof.json]
    [--wrong -] [--change -] [--recommend ship|revise|drop --why -] [--out card.json] [--publish] [--json]

Assembles the card from the task (cause, goal, verify, review, PR), the eval result, the
branch diff and the run cost; validates it and names every field that is missing or wrong;
writes card.json and card.html. --publish attaches the page to the task as evidence.`,
    load: () => import("./cardCommand.js").then((m) => m.registerCardCommand),
  },
  {
    token: "image",
    args: ["<target...>"],
    hasOptions: true,
    description: `Upload images (files or URLs) and print stable links that render inline in messages and canvas`,
    load: () => import("./imageCommand.js").then((m) => m.registerImageCommand),
  },
  {
    token: "state",
    args: ["[args...]"],
    hasOptions: true,
    description: `Pin the current state of this thread — the standing answer to "where does this stand?"

The text renders pinned above the composer in the dashboard and on the inbox
card, so the human sees the situation the moment they open the session instead
of reading back through it. First line: what this session is working on, plain
and unlabeled. You own it: rewrite it whenever the answer changes, and clear it
when it stops being true. The dashboard shows how many messages have passed
since you wrote it, so a stale state is visible as stale.

Subcommands:
  cast state                     Print the pinned state of this session
  cast state "<text>"            Pin (or replace) the state
  cast state clear               Remove it
  cast state show <session>      Print another session's state

--status is your answer to WHO ACTS NEXT, and it decides where the session
files in the inbox when your turn ends:
  working   still moving (default)
  blocked   a human must act to unblock you            → Needs Input
  done      delivered; nothing stalled, review at leisure → Done
  dormant   a machine wakes you — name the wake in the text → Dormant
done and dormant cover exactly the turn that declares them: after the next
wake, declare again or the session returns to Needs Input.

Examples:
  cast state --status dormant "Waiting on CI run 8841 — tr-42 re-checks at 3pm"
  cast state --status blocked - <<'EOF'
  Migrating the sync layer to wake signatures
  Status: rewrite done, tests green
  Blocked: needs a prod key before the last check
  EOF
  cast state --status done "Shipped — all four fixes verified in the browser"
  cast state clear               # the state no longer holds`,
    load: () => import("./stateCommand.js").then((m) => m.registerStateCommand),
  },
  {
    token: "integrations",
    aliases: ["integration"],
    description: `Connect Slack, GitHub, Linear, Gmail and Notion; sync issues into tasks`,
    load: () => import("./integrations.js").then((m) => m.registerIntegrationsCommand),
  },
  {
    token: "pr",
    description: `Pull requests: their state, their checks, their reviews, and the session shepherding each one

A pull request reference is a number (123), an owner and name with a number
(owner/repo#123), a GitHub or codecast URL, or nothing at all. Nothing means
the PR this session is bound to, and failing that the PR for the branch you
are standing on.

Subcommands:
  cast pr ls                     Open pull requests, newest change first
  cast pr show [ref]             Everything known about one
  cast pr events [ref]           Its timeline
  cast pr watch [ref]            Live state changes, one line each
  cast pr shepherd on|off|status Bind a session to a PR until it merges
  cast pr open [ref]             Its codecast page
  cast pr comment [ref] "text"   Comment on GitHub from here
  cast pr threads [ref]          Its review threads, open ones first
  cast pr resolve <thread> [ref] Settle a thread (unresolve reopens it)
  cast pr review [ref] --approve Approve, request changes, or just comment
  cast pr merge [ref]            Merge it (--squash by default)
  cast pr close [ref]            Close it without merging`,
    load: () => import("./prCommand.js").then((m) => m.registerPrCommand),
  },
  {
    token: "ship",
    description: `Ship: land a change the project's way, or record that a surface deployed

Subcommands:
  cast ship run --task ct-42            Ship a task's change: checks, PR, shepherd (same as the web's Ship)
  cast ship run --session <id>          Ship a session's diff
  cast ship run --pr 123                Ship a pull request; this one merges once green
  cast ship run --task ct-42 --dry-run  Print what Ship would do, start nothing
  cast ship checkout --dry-run          Plan shipping everything uncommitted in this shared checkout, by session
  cast ship checkout --plan             Ship that plan: commit, replay onto upstream, level, check, deploy, push
  cast ship mark --surface backend      Mark HEAD of this checkout as deployed
  cast ship mark --surface web --sha <sha> --version 1.2.3`,
    load: () => import("./shipCommand.js").then((m) => m.registerShipCommand),
  },
  {
    token: "sources",
    description: `Sources: the feeds of errors, jobs, checks and metrics from a running product

  cast sources ls
  cast sources add sdk|http <name>        Prints its ingest key and records it in codecast.json
  cast sources add sentry <name> --org <slug> [--projects a,b]
  cast sources add posthog <name> [--project-id <id>]
  cast sources add app <name> --base-url <url>   The product's connector (cast connector), no secret
  cast sources show|pause|resume|rm|test <source>
  cast sources key rotate <source>

add and key rotate record the source in the checkout's codecast.json (--write
<path>, --no-write), which the product commits and reads instead of env vars.
An app source is called with codecast's signature, so it needs no secret.
Sentry and PostHog read through the workspace's connection, which holds the
host and token: cast integrations connect <provider>`,
    load: () => import("./sourcesCommand.js").then((m) => m.registerSourcesCommand),
  },
  {
    token: "events",
    description: `Events: what a running product reported, grouped, with the transitions that wake triggers

  cast events ls [--source s] [--since 2h] [-w]     Transitions: new, regressed, spike, check failed...
  cast events groups [--status open] [--kind error]
  cast events show eg-N
  cast events resolve eg-N [--in <release>]
  cast events ignore eg-N`,
    load: () => import("./eventsCommand.js").then((m) => m.registerEventsCommand),
  },
  {
    token: "replay",
    description: `Replays: what a person did before something broke, as text, as frames of the page and as a repro

  cast replay ls [--source s] [--group eg-N]
  cast replay show rp-N [--at 1:23]
  cast replay snap rp-N@1:23 | rp-N@1:00-2:30 [--every 10s]
  cast replay repro rp-N [--base-url https://app] [--out file]
  cast replay import --source <posthog|sentry> [--since 30d|all] [--status|--stop]`,
    load: () => import("./replayCommand.js").then((m) => m.registerReplayCommand),
  },
  {
    token: "metrics",
    description: `Metrics: watched numbers that alert when they cross a line, and HogQL passthrough

  cast metrics ls
  cast metrics add <name> --source s --hogql "<q>" --above <n> [--every 1h]
  cast metrics show|rm mw-N
  cast metrics history [mw-N] [--source s]   past values from PostHog, now
  cast metrics query "<hogql>" --source s`,
    load: () => import("./metricsCommand.js").then((m) => m.registerMetricsCommand),
  },
  {
    token: "connector",
    description: `App connector: read and act through the readers and actions your product declares

  cast connector ls | readers|actions|calls|refresh <source>
  cast connector read <source> <reader> [--arg k=v] [--args -]
  cast connector do <source> <action> [--arg k=v] [--yes] [--idempotency-key k]
  cast connector grant|revoke <source> <action>   (a person grants in the browser; this prints where)`,
    load: () => import("./connectorCommand.js").then((m) => m.registerConnectorCommand),
  },
  {
    token: "switch",
    hasOptions: true,
    description: `Change the agent or model on this session without forking

Stays on the same conversation. A divider lands in the thread
("now using Codex"). A provider switch replaces this process.

Examples:
  cast switch --agent codex
  cast switch --model opus
  cast switch --agent claude --model sonnet
  cast switch --agent codex --fork     # optional: a new session instead`,
    load: () => import("./switchCommand.js").then((m) => m.registerSwitchCommand),
  },
  {
    token: "browser",
    aliases: ["br"],
    description: `Drive a real Chrome: snapshot pages, click, type, screenshot, read console`,
    load: () => import("./browser/cli.js").then((m) => m.registerBrowserCommand),
  },
  {
    token: "preview",
    args: ["<url>"],
    hasOptions: true,
    description: `Offer a page to your human as a pane beside this session (alias of cast browser pane)`,
    load: () => import("./browser/paneOffer.js").then((m) => m.registerPreviewCommand),
  },
  {
    token: "app",
    hasOptions: true,
    description: `Drive and verify the codecast app itself: doctor, goto, sweep, wait-settle, as-user`,
    load: () => import("./app/cli.js").then((m) => m.registerAppCommand),
  },
  {
    token: "computer",
    description: `Drive a native app (macOS, or Linux on X11) through its accessibility tree (cast browser is still the tool for web pages)`,
    load: () => import("./computer/cli.js").then((m) => (program: Command) => m.registerComputerCommand(program)),
  },
  {
    token: "sim",
    aliases: ["simulator"],
    description: `iOS simulators from this machine's pool, on a laptop or a cloud Mac: acquire, boot, install, launch, screenshot, tap, type, swipe`,
    load: () => import("./sim/cli.js").then((m) => m.registerSimCommand),
  },
  {
    token: "agent",
    aliases: ["agents"],
    hasOptions: false,
    description: `Agent definitions and chains: named roles every launch surface runs as

A definition binds a client, a model, an effort, a tool policy and a
system prompt under one name. \`cast exec --as reviewer\`, \`cast spawn --as
reviewer\`, \`cast trigger add --as reviewer\` and a workflow node's
\`definition=reviewer\` all resolve it. Definitions are workspace rows,
edited here or in Settings > Agent Library, and travel as markdown files
with frontmatter (the pi and Claude Code agents/*.md shape).

A chain runs definitions in order; each step's output feeds the next.

Examples:
  cast agent ls                              # definitions and chains
  cast agent show reviewer                   # the markdown form
  cast agent create reviewer --agent codex --model gpt-5.5 --effort high \\
    --tools Read,Grep,Bash --safe -d "Reviews a diff" - <<'EOF'
  You are a senior reviewer. ...
  EOF
  cast agent import ~/.claude/agents/*.md    # bring existing roles in
  cast agent export reviewer > reviewer.md
  cast agent rm reviewer
  cast agent chain create implement --step scout:"Find code for: {task}" \\
    --step planner:"Plan: {task}\\n{previous}" --step worker:"Do it: {previous}"
  cast agent run implement "add retries to the sync loop"   # = cast exec --chain`,
    load: () => import("./agentCommand.js").then((m) => m.registerAgentCommand),
  },
  {
    token: "exec",
    args: ["[prompt...]"],
    hasOptions: true,
    description: `Run a prompt on any agent harness, print the result, and exit

Print mode for every harness we launch. It is the scripting analog of \`claude -p\`.
Unified flags (agent, model, effort, permission, output format, resume) map
onto that client's native headless form. The process is the session: stdout
is the result, the exit code is the agent's, and there is no inbox card.

Not \`cast spawn\` (starts a session in your inbox and returns immediately).
Not \`cast ask\` (searches conversation history).
Not \`cast claude\` (raw pass-through to the Claude binary).

Examples:
  cast exec "summarize this repo"
  cast exec --agent grok --model grok-4.6 --effort high "review the diff"
  git diff | cast exec --agent claude --model sonnet "write a commit message"
  cast exec --output-format json --max-turns 4 "list the public API"
  cast exec --resume abc123 "continue from there"
  cast exec --dry-run --agent codex "what would run"
  cast exec - <<'EOF'
  Multi-line prompt, exact newlines preserved.
  EOF`,
    load: () => import("./execCommand.js").then((m) => m.registerExecCommand),
  },
  {
    token: "guide",
    args: ["[topic]"],
    hasOptions: true,
    description: `Print a capability guide from this binary (the one that will run the commands)

Same text \`cast install\` writes into CLAUDE.md, headed by this cast's version
and daemon build id — so a guide can never describe a different binary than
the one in your $PATH.

Examples:
  cast guide --list          Every topic, one line each
  cast guide browser         The full Browser guide
  cast guide tasks --json    Machine-readable {topic, version, build_id, body}`,
    load: () => import("./guide.js").then((m) => m.registerGuideCommand),
  },
];

const BY_TOKEN = new Map<string, CommandGroup>();
for (const group of COMMAND_GROUPS) {
  BY_TOKEN.set(group.token, group);
  for (const alias of group.aliases ?? []) BY_TOKEN.set(alias, group);
}

/** The group a first token names, by token or by alias. */
export function groupForToken(token: string | undefined): CommandGroup | undefined {
  return token === undefined ? undefined : BY_TOKEN.get(token);
}

/** One group's spec, for the group module reading its own description back. */
export function commandGroup(token: string): CommandGroup {
  const group = BY_TOKEN.get(token);
  if (!group) throw new Error(`no command group named "${token}"`);
  return group;
}

/**
 * The placeholder every group has in the tree until something names it.
 *
 * It carries exactly what `cast --help` and the typo suggester read. Argv that
 * names a group is activated before parsing starts, so a placeholder is never
 * the command that runs — and its action says so rather than exiting 0, because
 * a command group that silently did nothing would be far worse than one that
 * names the bug. Registered where the real registrations used to sit, so the
 * root help keeps its order.
 */
export function registerGroupStubs(program: Command): void {
  for (const group of COMMAND_GROUPS) {
    const cmd = program.command(group.token, { hidden: group.hidden === true }).description(group.description);
    for (const alias of group.aliases ?? []) cmd.alias(alias);
    for (const arg of group.args ?? []) cmd.argument(arg);
    // The help term reads "[options]" off the option COUNT, so a placeholder
    // for a command that takes options needs one to stand in for them.
    if (group.hasOptions) cmd.option("--placeholder", "placeholder");
    cmd.action(() => {
      console.error(`cast ${group.token} did not load (commandGroups.ts). Re-run it as the first word: cast ${group.token} …`);
      process.exit(1);
    });
  }
}

/**
 * Swaps a group's placeholder for the real registration, in place.
 *
 * Called before parsing, so commander only ever dispatches against the real
 * command: no double preAction, no second parse, and the group's own unknown
 * subcommand suggestions come from its real subcommand names. The real command
 * takes the placeholder's position so the root help keeps its order.
 */
export async function activateGroup(program: Command, token: string | undefined, deps: GroupDeps): Promise<boolean> {
  const group = groupForToken(token);
  if (!group) return false;
  const commands = program.commands as Command[];
  const at = commands.findIndex((cmd) => cmd.name() === group.token);
  if (at === -1) return false; // already activated, or stubs were never registered
  commands.splice(at, 1);
  const register = await group.load();
  register(program, deps);
  const registered = commands.pop();
  if (registered) commands.splice(at, 0, registered);
  return true;
}

/**
 * The token argv names, if any: `cast browser open` and `cast help browser`
 * both name the browser group, `cast --help` and `cast send` name none.
 *
 * Leading flags are skipped so this and commander pick the same word. That is
 * the whole point: `cast -- publish x` is still `publish` to commander, and a
 * token this missed would leave commander dispatching a placeholder.
 */
export function groupTokenInArgv(argv: readonly string[]): string | undefined {
  let at = 2;
  while (argv[at]?.startsWith("-")) at++;
  return argv[at] === "help" ? argv[at + 1] : argv[at];
}

/** Every group, loaded. For a caller that needs the whole command tree at once
 *  — a spec dump, a coverage test — and is willing to pay for all of it. */
export async function activateAllGroups(program: Command, deps: GroupDeps): Promise<void> {
  for (const group of COMMAND_GROUPS) await activateGroup(program, group.token, deps);
}
