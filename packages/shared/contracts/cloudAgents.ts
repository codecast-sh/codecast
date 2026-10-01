/**
 * Cloud agent providers: agent sessions that run on a vendor's machines and
 * that codecast both mirrors and drives (start, follow-up, interrupt) through
 * the daemon: Cursor Cloud Agents, Codex Cloud, and OpenAI Agents API
 * sessions (the managed Codex harness on an API key). Each entry is what the web,
 * the daemon and the launch path need to tell a provider's sessions apart:
 * the agent type it runs under, the launch model keys that select it, the id
 * its sessions carry, where it opens, and how its setup cards read.
 *
 * The daemon's side (API client, mirror, delivery) lives in
 * packages/cli/src/cloudAgents; the web's in components/cloudAgents.
 */
import type { AgentClientId } from "./agentClients";
import type { CloudSessionSource } from "./cloudSessionSync";
import type { ModelOption } from "./modelOptions";

export interface CloudAgentProviderSpec {
  id: string;
  /** The agent type its sessions run under (conversations.agent_type). */
  agentType: AgentClientId;
  /** Short name for chips and toggles: "Cursor Cloud". */
  label: string;
  /**
   * The company whose machines run its agents: "Cursor", "OpenAI". A key's
   * check and its connect dialog name it, and when several providers of one
   * vendor run an agent type, the composer's switch does ("run in OpenAI's cloud").
   */
  vendor: string;
  /** The account's "sync this source" setting (CLOUD_SESSION_SOURCES). */
  syncSource: CloudSessionSource;
  /**
   * Launch model keys that pick this provider: `<prefix>` for the account's
   * default model, `<prefix>:<model id>` for one model.
   */
  modelPrefix: string;
  /** The id every session it runs carries (conversations.session_id). */
  sessionIdPrefix: string;
  /** The agent's page on the vendor's site, for its session id or a branch's (cloudAgentRootId); none when the vendor has no page per agent. */
  agentUrl?: (sessionId: string) => string;
  /** The daemon's mirror directory under ~/.codecast (transcripts, state, sessions). */
  mirrorDir: string;
  /**
   * The daemon's setup card copy for missing or refused credentials: the
   * daemon writes it and the web recognizes the card by it, so the card and
   * its connect control can never drift apart. `{machine}` is where the
   * daemon names the machine it runs on (CLOUD_AGENT_MACHINE).
   */
  credentialCards: {
    /** The card when the machine has no credentials. */
    missing: string;
    /** Opens the card when the provider refuses them (the provider's reason follows). */
    rejected: string;
    /** Opens the card when a sign-in codecast only reads ran out (its date follows); else it reads as rejected. */
    expired?: string;
    /** The held message's reason while any of them is the case. */
    holdReason: string;
  };
  /** The Provider Keys entry its credential is, when it is an API key. */
  keyProvider?: string;
  /** Where the person gives the provider access to a repository (named on the "can't reach the repository" card and in the connect dialog). */
  repoAccessUrl: string;
  /** That page's name, the text of every link to it ("Cursor → Integrations"). */
  repoAccessLabel: string;
  /** The vendor's page that lists the account's agents, where a person looks for one codecast could not confirm it started; none when the vendor has no such page. */
  agentList?: { url: string; label: string };
  /**
   * A sign-in based provider's own CLI sign-in: `argv` opens the machine's
   * browser; a machine with no browser (a cloud host) signs in with
   * `headlessArgv`, which prints a link to open on any device.
   */
  login?: { argv: string[]; headlessArgv: string[] };
  /** Tooltip on the composer's switch that runs a session on this provider. */
  toggleTitle: string;
  /**
   * When several providers run one agent type (Codex: Codex Cloud on the
   * ChatGPT plan, the Agents API on an API key), the composer's choice
   * between them: its name there, what a session costs on it and what it
   * cannot do in one short line the composer shows beside the choice, and
   * the whole of it (`detail`) for the choice's tooltip and the connect
   * dialog.
   */
  lane?: { label: string; cost: string; detail: string };
  /** The model a launch that names none runs on, for a provider with no account default of its own. */
  defaultModel?: string;
  /** Offered by the composer's "run in the cloud" switch (a provider can sync before codecast starts its agents). */
  composer: boolean;
  /**
   * What the composer offers beside its switch, carried in the launch model
   * key (cloudAgentLaunchKey): an ask mode that answers without changing
   * code, and how many attempts the agent makes at the first message.
   */
  launchOptions?: { ask: boolean; maxAttempts: number };
  /** What a session's header offers on the agent itself (CLOUD_AGENT_ACTIONS). */
  actions?: readonly CloudAgentActionName[];
}

/**
 * What a session's header can do to its cloud agent, run by the daemon that
 * hosts the session: open a draft pull request from the branch's changes,
 * apply them to this machine's checkout, archive the agent on the provider's
 * site or bring it back. `needsChanges`: nothing to act on when the agent
 * changed no code (an ask task).
 */
export const CLOUD_AGENT_ACTIONS = {
  create_pr: { label: "Create draft PR", title: "Open a draft pull request with this branch's changes", needsChanges: true },
  apply: { label: "Apply locally", title: "Apply this branch's changes to the repository's checkout on the machine that runs the session", needsChanges: true },
  archive: { label: "Archive", title: "Archive the task on the provider's site (it stays here)", needsChanges: false },
  unarchive: { label: "Unarchive", title: "Bring an archived task back on the provider's site", needsChanges: false },
} as const;
export type CloudAgentActionName = keyof typeof CLOUD_AGENT_ACTIONS;

/** The system row an action's result is said in (the session's thread shows it; no work state or summary reads it). */
export const CLOUD_AGENT_ACTION_SUBTYPE = "cloud_agent_action";

export function isCloudAgentActionName(value: unknown): value is CloudAgentActionName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLOUD_AGENT_ACTIONS, value);
}

export const CLOUD_AGENT_PROVIDERS = {
  cursor: {
    id: "cursor",
    agentType: "cursor",
    label: "Cursor Cloud",
    vendor: "Cursor",
    syncSource: "cursor",
    modelPrefix: "cloud",
    sessionIdPrefix: "bc-",
    agentUrl: (id: string) => `https://cursor.com/agents/${id}`,
    mirrorDir: "cursor-cloud",
    credentialCards: {
      missing: "Cursor Cloud needs a Cursor API key on {machine}.",
      rejected: "Cursor rejected the API key on {machine}",
      holdReason: "waiting for a Cursor API key on {machine}",
    },
    keyProvider: "cursor",
    repoAccessUrl: "https://cursor.com/dashboard/integrations",
    repoAccessLabel: "Cursor → Integrations",
    agentList: { url: "https://cursor.com/agents", label: "Cursor → Agents" },
    toggleTitle: "Run this session as a Cursor Cloud Agent: on Cursor's machines, on this repository's branch as it is on GitHub. Messages you send become its follow-ups.",
    composer: true,
  },
  // Codex Cloud (chatgpt.com/codex): tasks on OpenAI's machines, on the
  // person's ChatGPT plan, read and driven with the machine's own `codex
  // login` (never a key, never refreshed by codecast).
  codex: {
    id: "codex",
    agentType: "codex",
    label: "Codex Cloud",
    vendor: "OpenAI",
    syncSource: "codex",
    modelPrefix: "cloud",
    sessionIdPrefix: "task_",
    agentUrl: (id: string) => `https://chatgpt.com/codex/tasks/${cloudAgentRootId(id)}`,
    mirrorDir: "codex-cloud",
    credentialCards: {
      missing: "Codex Cloud needs a Codex sign-in on {machine}.",
      rejected: "Codex refused the sign-in on {machine}",
      expired: "The Codex sign-in on {machine} expired",
      holdReason: "waiting for a Codex sign-in on {machine}",
    },
    repoAccessUrl: "https://chatgpt.com/codex/settings/environments",
    repoAccessLabel: "Codex → Environments",
    agentList: { url: "https://chatgpt.com/codex", label: "Codex tasks" },
    login: { argv: ["codex", "login"], headlessArgv: ["codex", "login", "--device-auth"] },
    toggleTitle: "Run this session as a Codex Cloud task: on OpenAI's machines, in this repository's Codex environment, on your ChatGPT plan. Messages you send become its follow-ups.",
    composer: true,
    lane: {
      label: "ChatGPT plan",
      cost: "Counts toward your ChatGPT plan's Codex limits, no extra charge.",
      detail: "Counts toward your ChatGPT plan's Codex limits, with no extra charge. Runs in the repository's Codex environment, which reaches private repositories, and can open a pull request or apply its changes to your checkout.",
    },
    launchOptions: { ask: true, maxAttempts: 4 },
    actions: ["create_pr", "apply", "archive", "unarchive"],
  },
  // OpenAI Agents API (platform.openai.com): the public, managed Codex
  // harness, driven with an OpenAI API key from Provider Keys. Its sessions
  // run in an OpenAI-hosted sandbox that clones the session's repository, and
  // stream their progress live. The platform has no page per session.
  codex_api: {
    id: "codex_api",
    agentType: "codex",
    label: "OpenAI Agents API",
    vendor: "OpenAI",
    syncSource: "codex_api",
    modelPrefix: "api",
    sessionIdPrefix: "sess_",
    mirrorDir: "openai-agents",
    credentialCards: {
      missing: "OpenAI Agents API sessions need an OpenAI API key on {machine}.",
      rejected: "OpenAI rejected the API key on {machine}",
      holdReason: "waiting for an OpenAI API key on {machine}",
    },
    keyProvider: "openai",
    repoAccessUrl: "https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted",
    repoAccessLabel: "OpenAI-hosted sandboxes",
    toggleTitle: "Run this session through the OpenAI Agents API: on OpenAI's machines, in a sandbox with this repository cloned from GitHub, billed to your OpenAI API key. Messages you send become its follow-ups, and steer a turn that is still running.",
    composer: true,
    lane: {
      label: "API key",
      cost: "API rates plus sandbox time. Public GitHub repos only; no push.",
      detail: "Billed to your OpenAI API key at the model's API rates plus sandbox time. Every model call is billed, so a long command the agent keeps checking on costs more the longer it runs. The sandbox clones the repository from GitHub without credentials, so it reaches public repositories only. Work stays in the sandbox: there is no push, pull request or apply, and OpenAI can delete a sandbox after an hour without activity.",
    },
    defaultModel: "gpt-5.6-terra",
  },
} satisfies Record<string, CloudAgentProviderSpec>;

export type CloudAgentProviderId = keyof typeof CLOUD_AGENT_PROVIDERS;

const SPECS: CloudAgentProviderSpec[] = Object.values(CLOUD_AGENT_PROVIDERS);

/**
 * What a cloud launch asks for: the provider's model id ("" = the account's
 * default), ask mode (answer without changing code) and how many attempts it
 * makes at the first message. Options the provider does not offer read as off.
 */
export interface CloudAgentLaunch { model: string; ask: boolean; attempts: number }

const ASK_TOKEN = "ask";
const ATTEMPTS_TOKEN = /^x([1-9])$/;

/**
 * The provider a model key selects for an agent type, and the launch it
 * asks for. A key is `<prefix>` or `<prefix>:<token>+<token>...`: `ask`,
 * `x<n>` (attempts) and at most one model id.
 */
function parseCloudModel(agentType: string | undefined | null, key: string | undefined | null): { spec: CloudAgentProviderSpec; launch: CloudAgentLaunch } | null {
  if (!agentType || !key) return null;
  for (const spec of SPECS) {
    if (spec.agentType !== agentType) continue;
    if (key !== spec.modelPrefix && !key.startsWith(`${spec.modelPrefix}:`)) continue;
    const launch: CloudAgentLaunch = { model: "", ask: false, attempts: 1 };
    for (const token of key.slice(spec.modelPrefix.length + 1).split("+").filter(Boolean)) {
      const attempts = ATTEMPTS_TOKEN.exec(token);
      if (token === ASK_TOKEN && spec.launchOptions?.ask) launch.ask = true;
      else if (attempts && spec.launchOptions) launch.attempts = Math.min(Number(attempts[1]), spec.launchOptions.maxAttempts);
      else if (token !== ASK_TOKEN && !attempts) launch.model = token;
    }
    return { spec, launch };
  }
  return null;
}

/** The launch model key for a provider's launch: the inverse of cloudAgentLaunch. */
export function cloudAgentLaunchKey(spec: CloudAgentProviderSpec, launch: Partial<CloudAgentLaunch>): string {
  const tokens = [
    ...(launch.model ? [launch.model] : []),
    ...(launch.ask && spec.launchOptions?.ask ? [ASK_TOKEN] : []),
    ...(launch.attempts && launch.attempts > 1 && spec.launchOptions ? [`x${Math.min(launch.attempts, spec.launchOptions.maxAttempts)}`] : []),
  ];
  return tokens.length ? `${spec.modelPrefix}:${tokens.join("+")}` : spec.modelPrefix;
}

/** The launch a model key asks a cloud agent provider for, or null for a local launch. */
export function cloudAgentLaunch(agentType: string | undefined | null, key: string | undefined | null): CloudAgentLaunch | null {
  return parseCloudModel(agentType, key)?.launch ?? null;
}

/**
 * A launch model choice that runs on a cloud agent provider: "" for the
 * account's default model, else the provider's model id; null for a local
 * launch (the key then reaches the client's own `--model` flag).
 */
export function cloudAgentModel(agentType: string | undefined | null, model: string | undefined | null): string | null {
  return parseCloudModel(agentType, model)?.launch.model ?? null;
}

/** The provider a launch model key selects, or null for a local launch. */
export function cloudAgentProviderForLaunch(agentType: string | undefined | null, model: string | undefined | null): CloudAgentProviderSpec | null {
  return parseCloudModel(agentType, model)?.spec ?? null;
}

/** What a launch asks of its provider beyond running there, in words: "ask", "3 attempts". */
export function cloudAgentLaunchWords(launch: Partial<CloudAgentLaunch>): string[] {
  return [...(launch.ask ? ["ask"] : []), ...(launch.attempts && launch.attempts > 1 ? [`${launch.attempts} attempts`] : [])];
}

/**
 * The model catalog entries a provider's launch options make (the launch
 * path accepts only listed keys, and a stored stamp reads back through the
 * catalog). The plain key is the one a picker lists; the rest are hidden,
 * set by the composer's own controls. `models`: the provider's own models,
 * each a listed key of its own beside the plain one, named as the model.
 */
export function cloudAgentLaunchModelOptions(spec: CloudAgentProviderSpec, hint: string, models: ModelOption[] = []): ModelOption[] {
  const opts = spec.launchOptions;
  const out: ModelOption[] = [];
  for (const ask of opts?.ask ? [false, true] : [false]) {
    for (let attempts = 1; attempts <= (opts?.maxAttempts ?? 1); attempts++) {
      const key = cloudAgentLaunchKey(spec, { ask, attempts });
      const label = [spec.label, ...cloudAgentLaunchWords({ ask, attempts })].join(" · ");
      out.push({ key, label, hint, cliAlias: key, ...(key === spec.modelPrefix ? {} : { hidden: true }) });
    }
  }
  for (const m of models) {
    const key = cloudAgentLaunchKey(spec, { model: m.key });
    // The model's own name: the composer's lane already says which provider runs it.
    out.push({ key, label: m.label, hint: m.hint, cliAlias: key });
  }
  return out;
}

/** Providers an agent type can start on in the cloud (the composer's toggle). */
export function cloudAgentProvidersFor(agentType: string | undefined | null): CloudAgentProviderSpec[] {
  return agentType ? SPECS.filter((s) => s.agentType === agentType && s.composer) : [];
}

/** Joins an agent's id and a branch's own id in the branch's id (a Codex Cloud attempt: `<task id>~<turn id>`). */
export const CLOUD_AGENT_BRANCH_SEPARATOR = "~";

/** The agent an id belongs to: an agent's own id, or for a branch of one, the part before the separator. */
export function cloudAgentRootId(id: string): string {
  const at = id.indexOf(CLOUD_AGENT_BRANCH_SEPARATOR);
  return at < 0 ? id : id.slice(0, at);
}

/** Whether a session is a branch of a cloud agent (another attempt of a Codex Cloud task), not the agent's own line. */
export function isCloudAgentBranch(agentType: string | undefined | null, sessionId: string | undefined | null): boolean {
  return !!sessionId && sessionId.includes(CLOUD_AGENT_BRANCH_SEPARATOR) && !!cloudAgentProviderOfSession(agentType, sessionId);
}

/** Whether an id (a session id, a mirror directory name) is one of the provider's agents. */
export function isCloudAgentId(spec: CloudAgentProviderSpec, id: string): boolean {
  return id.startsWith(spec.sessionIdPrefix);
}

/** The provider a session runs on, from its agent type and session id; null for a local one. */
export function cloudAgentProviderOfSession(agentType: string | undefined | null, sessionId: string | undefined | null): CloudAgentProviderSpec | null {
  if (!agentType || !sessionId) return null;
  return SPECS.find((s) => s.agentType === agentType && isCloudAgentId(s, sessionId)) ?? null;
}

/**
 * The provider a conversation runs on: from its agent's id once the agent
 * exists, else from its launch stamp (a cloud session whose first message is
 * held for setup, or not yet sent, still has a local-looking session id).
 * Every rule that treats cloud sessions apart (no model or effort, no switch
 * agent, the provider chip) asks this; null for a local session.
 */
export function cloudAgentProviderOfConversation(agentType: string | undefined | null, sessionId: string | undefined | null, model: string | undefined | null): CloudAgentProviderSpec | null {
  return cloudAgentProviderOfSession(agentType, sessionId) ?? cloudAgentProviderForLaunch(agentType, model);
}

/** The provider behind an account sync source (CLOUD_SESSION_SOURCES), if one is. */
export function cloudAgentProviderForSyncSource(source: string): CloudAgentProviderSpec | null {
  return SPECS.find((s) => s.syncSource === source) ?? null;
}

/** The provider whose credential a Provider Keys entry is. */
export function cloudAgentProviderForKey(keyProvider: string): CloudAgentProviderSpec | null {
  return SPECS.find((s) => s.keyProvider === keyProvider) ?? null;
}

/** Where a card's copy names the machine the daemon runs on. */
export const CLOUD_AGENT_MACHINE = "{machine}";

/** A card's copy with the machine named. */
export function cloudAgentCardText(template: string, machine: string): string {
  return template.split(CLOUD_AGENT_MACHINE).join(machine);
}

const cardPatterns = new Map<string, RegExp>();
/** Matches the card's copy whatever machine it names (cards written before the slot said "this machine"). */
function cardPattern(template: string): RegExp {
  let re = cardPatterns.get(template);
  if (!re) cardPatterns.set(template, (re = new RegExp(template.split(CLOUD_AGENT_MACHINE).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?"))));
  return re;
}

function isCredentialCard(spec: CloudAgentProviderSpec, message: string): boolean {
  const { missing, rejected, expired } = spec.credentialCards;
  return [missing, rejected, expired].some((card) => !!card && cardPattern(card).test(message));
}

/** Whether a message is any provider's credential setup card: an auth banner, whatever its wording. */
export function isCloudAgentCredentialCard(message: string): boolean {
  return SPECS.some((s) => isCredentialCard(s, message));
}

/**
 * Whether a sign-in codecast only reads (never refreshes) has run out: its
 * access token's expiry is past. One rule for the daemon, which stops reading
 * the provider, and the web, which stops calling the machine connected.
 */
export function signInExpired(expiresAt: number | undefined | null, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt <= now;
}

/** How far back an account's cloud agents are read when its sync switch is on. */
export const CLOUD_AGENT_BACKFILL_DAYS = 30;

/** A sign-in's expiry as the daemon's cards and the web's notes both name it ("Sep 30"). */
export function cloudAgentExpiryDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Where a sign-in based provider's login on a machine stands (the daemon's live check, the connect dialog). */
export const CLOUD_AGENT_LOGIN_STATES = ["signed_in", "signed_out", "expired", "disabled", "unreachable"] as const;
export type CloudAgentLoginStateName = (typeof CLOUD_AGENT_LOGIN_STATES)[number];

export function isCloudAgentLoginState(value: unknown): value is CloudAgentLoginStateName {
  return (CLOUD_AGENT_LOGIN_STATES as readonly unknown[]).includes(value);
}

/**
 * What keeps a message from reaching a provider: no credentials, credentials
 * it refuses or that ran out, a repository it cannot reach, the account
 * itself refused (the product turned off for a workspace), the provider
 * answering in a shape codecast does not know (its API changed: the lane is
 * paused until a check passes), or a limit (the plan's usage used up, or
 * requests rate limited).
 */
export const CLOUD_AGENT_SETUP_KINDS = ["key_missing", "key_invalid", "repo", "access", "changed", "limit"] as const;
export type CloudAgentSetupKind = (typeof CLOUD_AGENT_SETUP_KINDS)[number];

/** What a setup problem that is not a credential's says, and what it waits for. */
interface CloudAgentProblemInfo {
  /**
   * "setup": the provider refuses the account or cannot reach a repository,
   * and someone fixes that on the provider's side. "hold": the provider
   * holds the whole lane (its API changed, or a limit); nothing on the
   * machine fixes it, and it lifts on its own.
   */
  group: "setup" | "hold";
  /** How its sentence opens after the provider's label, when the kind has its own wording: the daemon builds the sentence with it and the web tells the kind by it. */
  lead?: string;
  /** A card's heading, after the provider's label. */
  heading: string;
  /** The composer's word beside its switch while a machine reports it. */
  held: string;
  /** What a held message waits for. */
  until: (spec: CloudAgentProviderSpec) => string;
}

const SETUP_NEEDED: CloudAgentProblemInfo = { group: "setup", heading: "setup needed", held: "needs setup", until: () => "this is fixed" };

/**
 * Each setup kind's place and wording, the one table the daemon and the web
 * read. "credential": a new key or sign-in fixes it (its copy is the spec's
 * credentialCards); every other kind says what it is here.
 */
const CLOUD_AGENT_SETUP_KIND_INFO = {
  key_missing: "credential",
  key_invalid: "credential",
  repo: SETUP_NEEDED,
  access: { ...SETUP_NEEDED, held: "no access" },
  changed: { group: "hold", lead: "changed in a way codecast can't read yet", heading: "paused", held: "paused", until: (spec) => `codecast can read ${spec.label} again` },
  limit: { group: "hold", lead: "limit reached:", heading: "limit reached", held: "limited", until: () => "the limit resets" },
} as const satisfies Record<CloudAgentSetupKind, "credential" | CloudAgentProblemInfo>;

/** The kinds a new key or sign-in fixes: the daemon rechecks them every few seconds, the rest back off. */
export function isCloudAgentCredentialKind(kind: CloudAgentSetupKind): boolean {
  return CLOUD_AGENT_SETUP_KIND_INFO[kind] === "credential";
}

/** The kinds that hold the whole lane (the provider changed, a limit): no sign-in or setup fixes them, and they lift on their own. */
export function isCloudAgentLaneHold(kind: CloudAgentSetupKind): boolean {
  return cloudAgentProblemInfo(kind)?.group === "hold";
}

/**
 * What a setup problem that is not a credential's says (its heading, the
 * composer's word, what a held message waits for): by its kind, or "setup"
 * for a card whose sentence names no kind of its own (cloudAgentProblemKind).
 * Null for a credential kind.
 */
export function cloudAgentProblemInfo(kind: CloudAgentSetupKind | "setup"): CloudAgentProblemInfo | null {
  if (kind === "setup") return SETUP_NEEDED;
  const info = CLOUD_AGENT_SETUP_KIND_INFO[kind];
  return info === "credential" ? null : info;
}

/** What keeps a machine from reading a provider at all, as its heartbeat reports it (devices.cloud_agent_blocks). */
export interface CloudAgentSetupBlock {
  provider: string;
  kind: CloudAgentSetupKind;
  /** The provider's reason, or the vendor's sentence saying what to fix. */
  reason?: string;
  /** A limit's reset (ms since the epoch), when the provider named it: the web counts it down in the viewer's clock. */
  resets_at?: number;
}

/**
 * A setup problem in one sentence, as the daemon's cards and the web's notes
 * both say it, naming the machine: no credentials (`reason`: more to say),
 * refused credentials (`reason`: the provider's words), a sign-in that ran
 * out (`expiredAt`), and for a repository or an account the provider refuses,
 * `reason` is already the vendor's sentence.
 */
export function cloudAgentSetupSentence(spec: CloudAgentProviderSpec, problem: { kind: CloudAgentSetupKind; reason?: string; expiredAt?: number }, machine: string): string {
  const cards = spec.credentialCards;
  const text = (template: string) => cloudAgentCardText(template, machine);
  if (problem.expiredAt !== undefined) {
    const date = cloudAgentExpiryDate(problem.expiredAt);
    return cards.expired ? `${text(cards.expired)} ${date}.` : `${text(cards.rejected)} (it expired ${date}).`;
  }
  if (problem.kind === "key_missing") return problem.reason ? `${text(cards.missing)} ${problem.reason}` : text(cards.missing);
  if (problem.kind === "key_invalid") return `${text(cards.rejected)}${problem.reason ? ` (${problem.reason})` : ""}.`;
  return `${problem.reason ?? `${spec.label} can't be reached from ${machine}`}.`;
}

/**
 * How the daemon's setup cards that are not about credentials end (a
 * repository it cannot reach, an account the provider refuses): the message
 * is held and retried, and the web recognizes the card by it.
 */
export const CLOUD_AGENT_RETRIED_SUFFIX = "; the message retries on its own.";

/**
 * The provider answered in a shape codecast does not read, or kept giving
 * answers it does not expect: the lane on `machine` pauses until a later
 * check passes. Where it broke goes to the daemon's log, not here.
 */
export function cloudAgentChangedProblem(spec: CloudAgentProviderSpec, machine: string): string {
  return `${spec.label} ${CLOUD_AGENT_SETUP_KIND_INFO.changed.lead}, so syncing on ${machine} is paused. It checks again every few minutes`;
}

/** A limit the provider holds codecast to (`detail`: the plan's window used up, or the requests rate limited). */
export function cloudAgentLimitProblem(spec: CloudAgentProviderSpec, detail: string): string {
  return `${spec.label} ${CLOUD_AGENT_SETUP_KIND_INFO.limit.lead} ${detail}`;
}

/** Which setup kind a non-credential setup sentence (a card's, a machine's block) is, by how it opens: a kind with a lead of its own, or any other setup. */
export function cloudAgentProblemKind(spec: CloudAgentProviderSpec, sentence: string): "changed" | "limit" | "setup" {
  const body = sentence.trim();
  for (const kind of ["changed", "limit"] as const) if (body.startsWith(`${spec.label} ${CLOUD_AGENT_SETUP_KIND_INFO[kind].lead}`)) return kind;
  return "setup";
}

const UNSENT_LEAD = "may have started this, but codecast can't read its answer";

/**
 * A message the provider may have acted on though codecast could not read
 * its answer (`detail`: what could not be read). It is not sent again, since
 * that could start the agent twice: the person looks on the provider's site.
 */
export function cloudAgentUnsentProblem(spec: CloudAgentProviderSpec, detail: string): string {
  const where = spec.agentList ? `at ${spec.agentList.url}` : `on ${spec.vendor}'s site`;
  return `${spec.label} ${UNSENT_LEAD} (${detail}). So that it is not started twice, the message is not sent again: look for it ${where}, and send it again if it is not there.`;
}

/** The other ways to run the provider's agent type on its vendor's machines (Codex Cloud for the Agents API, and back): the composer's lanes but this one. */
export function cloudAgentOtherLanes(spec: CloudAgentProviderSpec): CloudAgentProviderSpec[] {
  return spec.lane ? cloudAgentProvidersFor(spec.agentType).filter((s) => s.id !== spec.id && s.lane) : [];
}

/**
 * Which of the daemon's cards a message in a session of `spec` is (the
 * session's provider comes from the conversation, never from the card): a
 * credential card, any other setup card (it ends with
 * CLOUD_AGENT_RETRIED_SUFFIX), a message that may have started the agent
 * and is not sent again (cloudAgentUnsentProblem), or null for none.
 */
export function cloudAgentCardKind(spec: CloudAgentProviderSpec, message: string): "credential" | "setup" | "unsent" | null {
  if (isCredentialCard(spec, message)) return "credential";
  const body = message.trim();
  if (body.endsWith(CLOUD_AGENT_RETRIED_SUFFIX)) return "setup";
  return body.startsWith(`${spec.label} ${UNSENT_LEAD}`) ? "unsent" : null;
}
