// The Vault an agent's tab shows in place of the person's (lib/agentTabGuard):
// a fixed sample with every kind, health state and panel section, held in
// this tab's memory only. Reveal, copy and 2FA read its fake values; every
// write changes only this copy. Nothing here reaches the server, the store or
// IndexedDB, which the agent's tab shares with the person's tabs.

import { createContext, useContext } from "react";
import { DAY_MS, SECRET_VERSION_TTL_MS, cleanSecretEdit, payloadFingerprint, signinExpiresAt, type LoginPayload, type SecretEventKind, type SecretKind, type SecretMeta, type SecretMetaEdit, type SecretPayload, type SecretVersionMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import type { EntityFixture } from "../../lib/entityDisplay";
import type { VaultScope } from "../../hooks/useSyncSecrets";
import { stagedSwap, type Swap } from "./vaultModel";

const HOUR = DAY_MS / 24;
const ME = "Sample Person";
const AGENT = "Sample agent";

export const SAMPLE_SCOPE: VaultScope = { team: { key: "team:sample", id: "sample-team", name: "Sample team" }, personal: "user:sample" };

const SESSIONS = [
  { id: "sample-session-1", short_id: "jx7samp1", title: "Run the checkout tests" },
  { id: "sample-session-2", short_id: "jx7samp2", title: "Deploy staging" },
  { id: "sample-session-3", short_id: "jx7samp3", title: "Refund a test order" },
] as const;

/** The sample's session pills resolve here, so none of them asks the server. */
export const SAMPLE_ENTITIES: Record<string, EntityFixture> = Object.fromEntries(
  SESSIONS.map((s) => [s.id, { type: "session", entity: { _id: s.id, short_id: s.short_id, title: s.title, agent_type: "claude_code", project_path: "~/src/sample", status: "completed" } }]),
);

export type SampleEvent = { _id: string; kind: SecretEventKind; at: number; actor_name?: string; purpose?: string; conversation_id?: string; session_short_id?: string; session_title?: string };

type Seed = {
  meta: Omit<SecretMeta, "_id" | "short_id" | "workspace" | "created_by" | "updated_at"> & { personal?: boolean };
  payload?: SecretPayload;
  events: [kind: SecretEventKind, agoMs: number, session?: number, purpose?: string][];
  versions?: number;
};

const cookie = (name: string, domain: string, expires: number) => ({ name, value: "sample-cookie-not-real", domain, path: "/", secure: true, httpOnly: true, expires: Math.floor(expires / 1000) });

function signin(host: string, expiresAt: number, account: string): SigninPayload {
  return { cookies: [cookie("session", `.${host}`, expiresAt), cookie("remember", `.${host}`, expiresAt)], captured_from: "chrome", account_hint: account };
}

function seeds(now: number): Seed[] {
  return [
    {
      meta: { name: "openai-staging", kind: "key", status: "requested", env: ["OPENAI_API_KEY"], created_at: now - 20 * 60_000, requested_by_name: AGENT, requested_from_conversation: SESSIONS[1].id, request_why: "Run the staging eval suite" },
      events: [["requested", 20 * 60_000, 1]],
    },
    {
      meta: { name: "stripe-test", kind: "key", status: "ready", env: ["STRIPE_SECRET_KEY"], note: "Test mode, checkout tests", created_at: now - 40 * DAY_MS, last_used_at: now - 2 * HOUR, last_used_by_conversation: SESSIONS[0].id, use_count: 41 },
      payload: { value: "sample-stripe-test-not-a-real-key" },
      events: [["injected", 2 * HOUR, 0, "cast vault run"], ["read", 26 * HOUR, 2, "cast vault get"], ["rotated", 3 * DAY_MS], ["revealed", 3 * DAY_MS + HOUR], ["created", 40 * DAY_MS]],
      versions: 2,
    },
    {
      meta: { name: "stripe-live", kind: "key", status: "ready", env: ["STRIPE_SECRET_KEY"], note: "Live payments", ask_first: true, created_at: now - 60 * DAY_MS, last_used_at: now - 3 * DAY_MS, last_used_by_conversation: SESSIONS[2].id, use_count: 4 },
      payload: { value: "sample-stripe-live-not-a-real-key" },
      events: [["read", 3 * DAY_MS, 2, "refund a test order"], ["approved", 3 * DAY_MS + 60_000, 2], ["approval_requested", 3 * DAY_MS + 120_000, 2], ["ask_first_on", 50 * DAY_MS], ["created", 60 * DAY_MS]],
    },
    {
      meta: { name: "github-bot", kind: "login", status: "ready", sites: ["github.com"], has_otp: true, created_at: now - 30 * DAY_MS, last_used_at: now - 5 * HOUR, last_used_by_conversation: SESSIONS[1].id, use_count: 12 },
      payload: { username: "sample-bot", password: "sample-password-not-real", totp_seed: "SAMPLESEEDNOTREALSAMPLESEED" },
      events: [["read", 5 * HOUR, 1, "cast vault otp"], ["signed_in", 5 * HOUR + 60_000, 1], ["created", 30 * DAY_MS]],
    },
    {
      meta: { name: "gcp-service-account", kind: "file", status: "ready", env: ["GOOGLE_APPLICATION_CREDENTIALS"], created_at: now - 9 * DAY_MS },
      payload: { filename: "service-account.json", content: '{\n  "type": "service_account",\n  "project_id": "sample-project",\n  "private_key": "sample-not-a-real-key"\n}' },
      events: [["created", 9 * DAY_MS]],
    },
    {
      meta: { name: "vercel", kind: "signin", status: "ready", sites: ["vercel.com"], created_at: now - 12 * DAY_MS, signin_expires_at: now + 20 * DAY_MS, last_used_at: now - 1 * HOUR, last_used_by_conversation: SESSIONS[1].id, use_count: 23 },
      payload: signin("vercel.com", now + 20 * DAY_MS, "sample@example.test"),
      events: [["refreshed", HOUR, 1], ["signed_in", HOUR + 30_000, 1], ["created", 12 * DAY_MS]],
    },
    {
      meta: { name: "figma", kind: "signin", status: "ready", sites: ["figma.com"], created_at: now - 45 * DAY_MS, signin_expires_at: now - 2 * DAY_MS, last_used_at: now - 9 * DAY_MS, use_count: 6 },
      payload: signin("figma.com", now - 2 * DAY_MS, "design@example.test"),
      events: [["signed_in", 9 * DAY_MS, 0], ["created", 45 * DAY_MS]],
    },
    {
      meta: { name: "linear", kind: "signin", status: "ready", personal: true, sites: ["linear.app"], created_at: now - 25 * DAY_MS, signin_expires_at: now + 20 * HOUR, last_used_at: now - 2 * DAY_MS, use_count: 3 },
      payload: signin("linear.app", now + 20 * HOUR, "sample@example.test"),
      events: [["signed_in", 2 * DAY_MS, 0], ["created", 25 * DAY_MS]],
    },
    {
      meta: { name: "openrouter", kind: "key", status: "ready", personal: true, env: ["OPENROUTER_API_KEY"], created_at: now - 200 * DAY_MS, last_used_at: now - 120 * DAY_MS, use_count: 9 },
      payload: { value: "sample-openrouter-not-a-real-key" },
      events: [["read", 120 * DAY_MS, 0], ["created", 200 * DAY_MS]],
    },
    {
      meta: { name: "staging-admin", kind: "login", status: "ready", personal: true, ask_first: true, sites: ["staging.example.test"], has_otp: false, created_at: now - 14 * DAY_MS, last_used_at: now - 4 * DAY_MS, last_used_by_conversation: SESSIONS[1].id, use_count: 2 },
      payload: { username: "admin@example.test", password: "sample-admin-not-real" },
      events: [["read", 4 * DAY_MS, 1, "seed staging"], ["approved", 4 * DAY_MS + 60_000, 1], ["created", 14 * DAY_MS]],
    },
  ];
}

const sessionFields = (i: number | undefined) => {
  const s = i === undefined ? undefined : SESSIONS[i];
  return s ? { conversation_id: s.id, session_short_id: s.short_id, session_title: s.title } : {};
};

const ACTOR_IS_AGENT = new Set<SecretEventKind>(["read", "injected", "signed_in", "refreshed", "requested", "approval_requested"]);

type State = {
  rows: Record<string, SecretMeta>;
  /** `events:<id>` and `versions:<id>`, as useSecretHistory keys them. */
  history: Record<string, unknown[]>;
  payloads: Record<string, SecretPayload>;
};

export type SampleVault = ReturnType<typeof createSampleVault>;

export function createSampleVault(now = Date.now()) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const state: State = { rows: {}, history: {}, payloads: {} };
  for (const [i, { meta, payload, events, versions = 0 }] of seeds(now).entries()) {
    const { personal, ...fields } = meta;
    const team = personal ? null : SAMPLE_SCOPE.team!;
    const id = `sample-secret-${i + 1}`;
    state.rows[id] = {
      ...fields,
      _id: id,
      short_id: `sec-${901 + i}`,
      workspace: team ? team.key : SAMPLE_SCOPE.personal!,
      team_id: team?.id,
      created_by: "sample-user",
      created_by_name: ME,
      updated_at: fields.created_at,
      value_updated_at: fields.created_at,
      fingerprint: payload ? payloadFingerprint(fields.kind, payload) : undefined,
      version_count: versions,
    };
    if (payload) state.payloads[id] = payload;
    state.history[`events:${id}`] = events.map(([kind, ago, session, purpose]) => ({ _id: nextId("sample-event"), kind, at: now - ago, actor_name: ACTOR_IS_AGENT.has(kind) ? AGENT : ME, purpose, ...sessionFields(session) }));
    state.history[`versions:${id}`] = Array.from({ length: versions }, (_, v) => {
      const at = now - (v + 1) * 3 * DAY_MS;
      const vid = nextId("sample-version");
      state.payloads[vid] = { value: `sample-earlier-value-${"abcdef"[v]}-not-real` };
      return { _id: vid, rotated_at: at, rotated_by_name: ME, fingerprint: payloadFingerprint("key", state.payloads[vid]!), expires_at: at + SECRET_VERSION_TTL_MS };
    });
  }

  let rowsSnapshot: SecretMeta[] = Object.values(state.rows);
  const listeners = new Set<() => void>();
  const changed = () => {
    rowsSnapshot = Object.values(state.rows);
    for (const l of listeners) l();
  };
  const putRow = (row: SecretMeta) => {
    state.rows = { ...state.rows, [row._id]: row };
  };
  const logEvent = (id: string, kind: SecretEventKind) => {
    const key = `events:${id}`;
    state.history = { ...state.history, [key]: [{ _id: nextId("sample-event"), kind, at: Date.now(), actor_name: ME }, ...(state.history[key] ?? [])] };
  };
  const valueFields = (kind: SecretKind, payload: SecretPayload) => ({
    fingerprint: payloadFingerprint(kind, payload),
    has_otp: kind === "login" ? !!(payload as LoginPayload).totp_seed : undefined,
    signin_expires_at: kind === "signin" ? signinExpiresAt(payload as SigninPayload) : undefined,
  });

  const vault = {
    scope: SAMPLE_SCOPE,
    me: ME,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    rows: () => rowsSnapshot,
    row: (id: string): SecretMeta | undefined => state.rows[id],
    history: (key: string): unknown[] | undefined => state.history[key],

    reveal(id: string): { payload: SecretPayload } | { error: string } {
      const payload = state.payloads[id];
      if (!payload) return { error: "No value in the sample" };
      logEvent(id, "revealed");
      changed();
      return { payload };
    },

    create(where: "team" | "personal", fields: { name: string; kind: SecretKind; payload: unknown; env?: string[]; sites?: string[]; note?: string }): null {
      const at = Date.now();
      const id = nextId("sample-new");
      const team = where === "team" ? SAMPLE_SCOPE.team! : null;
      const { payload, ...meta } = fields;
      putRow({
        _id: id,
        short_id: `sec-${950 + seq}`,
        status: "ready",
        workspace: team ? team.key : SAMPLE_SCOPE.personal!,
        team_id: team?.id,
        created_by: "sample-user",
        created_by_name: ME,
        created_at: at,
        updated_at: at,
        value_updated_at: at,
        ...meta,
        ...cleanSecretEdit(meta),
        ...valueFields(fields.kind, payload as SecretPayload),
      });
      state.payloads[id] = payload as SecretPayload;
      logEvent(id, "created");
      changed();
      return null;
    },

    fill(row: SecretMeta, payload: SecretPayload): { delivered: boolean } {
      const at = Date.now();
      putRow({ ...row, status: "ready", updated_at: at, value_updated_at: at, ...valueFields(row.kind, payload) });
      state.payloads[row._id] = payload;
      logEvent(row._id, "fulfilled");
      changed();
      return { delivered: !!row.requested_from_conversation };
    },

    swap(row: SecretMeta, swap: { kind: "rotated"; payload: SecretPayload } | { kind: "restored"; version: SecretVersionMeta }): null {
      const keys = { events: `events:${row._id}`, versions: `versions:${row._id}` };
      const model: Swap = swap.kind === "rotated" ? { kind: "rotated", fingerprint: payloadFingerprint(row.kind, swap.payload) } : swap;
      const staged = stagedSwap(row, model, { me: ME, now: Date.now(), events: state.history[keys.events] as object[] | undefined, versions: (state.history[keys.versions] ?? []) as SecretVersionMeta[] });
      // What the server would answer: the staged lines, recorded.
      const recorded = (line: object) => {
        const { pending: _pending, ...rest } = line as { pending?: true; _id: string };
        return rest._id.startsWith("pending:") ? { ...rest, _id: nextId("sample-line") } : rest;
      };
      const [kept, ...rest] = staged.versions!.map(recorded) as SecretVersionMeta[];
      state.payloads[kept!._id] = state.payloads[row._id]!;
      state.payloads[row._id] = swap.kind === "rotated" ? swap.payload : state.payloads[swap.version._id]!;
      putRow(staged.row);
      state.history = { ...state.history, [keys.events]: staged.events.map(recorded), [keys.versions]: [kept, ...rest] };
      changed();
      return null;
    },

    setAskFirst(id: string, on: boolean) {
      const row = state.rows[id];
      if (!row) return;
      putRow({ ...row, ask_first: on || undefined, updated_at: Date.now() });
      logEvent(id, on ? "ask_first_on" : "ask_first_off");
      changed();
    },

    updateMeta(id: string, fields: SecretMetaEdit) {
      const row = state.rows[id];
      if (!row) return;
      putRow({ ...row, ...cleanSecretEdit(fields), updated_at: Date.now() });
      logEvent(id, "updated");
      changed();
    },

    /** `only: "requested"` keeps a row filled since, as secrets.remove does. */
    remove(id: string, only?: "requested") {
      const row = state.rows[id];
      if (!row || (only === "requested" && row.status !== "requested")) return;
      const { [id]: _gone, ...rest } = state.rows;
      state.rows = rest;
      changed();
    },

    /** A sign-in saved "from Chrome": a fresh sample jar for the site, created or replacing the one of that name. */
    saveSignin(args: { site: string; name: string; team: { id: string } | null }) {
      const payload = signin(args.site, Date.now() + 30 * DAY_MS, "sample@example.test");
      const workspace = args.team ? SAMPLE_SCOPE.team!.key : SAMPLE_SCOPE.personal!;
      const existing = rowsSnapshot.find((r) => r.workspace === workspace && r.name === args.name);
      if (existing?.status === "requested") vault.fill(existing, payload);
      else if (existing) vault.swap(existing, { kind: "rotated", payload });
      else vault.create(args.team ? "team" : "personal", { name: args.name, kind: "signin", payload, sites: [args.site] });
      const row = rowsSnapshot.find((r) => r.workspace === workspace && r.name === args.name)!;
      return { short_id: row.short_id, name: row.name, host: args.site, cookies: payload.cookies.length, action: existing ? (existing.status === "requested" ? "filled" : "rotated") : "created", account_hint: payload.account_hint } as const;
    },
  };
  return vault;
}

/** The sample this tree shows in place of the person's Vault, or null for the real one. */
export const SampleVaultContext = createContext<SampleVault | null>(null);

export const useSampleVault = () => useContext(SampleVaultContext);
