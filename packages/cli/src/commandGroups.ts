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
 * group that used to be registered eagerly joins — `cast computer` (ct-49521)
 * and `cast guide` (ct-49544) each become one entry when they land, in place of
 * the `registerXCommand(program)` line they add to index.ts today. ct-49546.
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
    token: "workspace",
    aliases: ["ws"],
    description: `Manage isolated git worktrees for parallel agent work`,
    load: () => import("./workspace/cli.js").then((m) => m.registerWorkspaceCommand),
  },
  {
    token: "remote",
    description: `Move a Claude Code session to/from a remote Mac`,
    load: () => import("./remote/cli.js").then((m) => m.registerRemoteCommand),
  },
  {
    token: "cloud",
    hidden: true,
    description: `Cloud host plumbing used by the daemon`,
    load: () => import("./cloud/cli.js").then((m) => m.registerCloudCommand),
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
  cast decide ls                      This session's decisions, with ids and answers
  cast decide edit [id] [flags]       Change the open decision in place (question, -o, --context, --report, --advisory/--blocking)
  cast decide cancel [id]             Withdraw the open decision

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
    token: "app",
    hasOptions: true,
    description: `Drive and verify the codecast app itself: doctor, goto, sweep, wait-settle, as-user`,
    load: () => import("./app/cli.js").then((m) => m.registerAppCommand),
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
