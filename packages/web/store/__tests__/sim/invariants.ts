// The invariant catalog (docs/architecture/multiplayer-sim-harness.md,
// section 3.7): the rules every settled sim world must satisfy, each checked
// against an oracle that is real code (a Convex query asked as the principal,
// a server helper, the shared projection), never a rule written here.
//
// A check reads the world through the structural view in
// sim/invariantReads.ts, with the helpers the rules share. The coverage guard
// (which store keys no rule compares) is sim/invariantCoverage.ts.
//
// A failure is data (InvariantFailure): the DSL turns the first one into a
// report through report.ts, and the self-tests format it to prove the report
// names the invariant and the row. Nothing here throws on a violation.
//
// Server reads go through `backend.clientFor(principal)`, the same auth path
// a window uses, except where the oracle is a plain server helper
// (heldKeysFor, accessStampFor, visibleAnchorsForUser, armedTriggerKindFor),
// which is called over the db directly. Those client reads are recorded in
// backend.calls like any other call, at the same points in every replay.
import { accessStampFor, authorizedFor, heldKeysFor } from "@codecast/convex/convex/lib/accessKeys";
import { hourBucket } from "@codecast/convex/convex/lib/chatQuota";
import { parseChatMentionClientId, parseChatRelayClientId } from "@codecast/convex/convex/lib/chatWakeIds";
import { armedTriggerKindFor } from "@codecast/convex/convex/dormancy";
import { visibleAnchorsForUser } from "@codecast/convex/convex/anchors";
import { MENTION_WAKES_PER_SENDER_HOUR, MENTION_WAKES_PER_TARGET_HOUR } from "@codecast/convex/convex/chat";
import { canonical } from "@codecast/shared/contracts/orgChange";
import { INBOX_FACT_FIELDS, isInboxRowField } from "@codecast/shared/contracts";
import { snapshotEntries } from "@platform/engine";
import { placeInboxRows, syncLogScopeMetaKey, useInboxStore } from "../../inboxStore";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../inboxOverlays";
import { REPLICATED_STORE_KEYS, isReplicatedCollectionKey } from "../../clientSyncRegistry";
import { isConvexId } from "../../../lib/entityLinks";
import { inWorkspace } from "../../../lib/workspaceScope";
import { activeWorkspaceKeyOf } from "../../../hooks/useWorkspaceCollection";
import { applyEntityIds, catchUp, emptyIdsByCollection } from "../../../hooks/useSyncChangeFeed";
import { teamInboxArgs } from "../../../hooks/useSyncTeamInboxSessions";
import type { FailureContext } from "./report";
import {
  FIXPOINT_FED_KEYS,
  LIVENESS_FEEDS,
  MAX_ROWS_PER_CHECK,
  WORKSPACE_TABLES,
  asUser,
  asyncFilter,
  canonicalMineProjection,
  createdAt,
  cursorLag,
  db,
  duplicateClientIds,
  firstId,
  mentionTarget,
  mentionWakes,
  notifiedWrites,
  overCap,
  placementOf,
  preview,
  scopeOf,
  scopeSweep,
  serverRow,
  serverTableOf,
  servesById,
  sharedFields,
  stable,
  tableRows,
  teamOf,
  userOf,
  writeOf,
  type CheckMode,
  type Invariant,
  type InvariantFailure,
  type InvariantWindow,
  type InvariantWorld,
  type Row,
  type StorePatch,
  type Violation,
} from "./invariantReads";

// ── The catalog ─────────────────────────────────────────────────────────────

// A sessions row holds what the base feeders write: the row's body
// (INBOX_ROW_FIELDS) and the facts.
const FACT_FIELD_SET: ReadonlySet<string> = new Set(INBOX_FACT_FIELDS);
const inRowShape = (k: string) => isInboxRowField(k) || FACT_FIELD_SET.has(k);

export const INVARIANTS: readonly Invariant[] = [
  {
    id: "INV-sessions-mine",
    meaning: "the window's mine digest, tally and placements equal the principal's canonical projection",
    keys: ["sessions", "liveInboxIdList"],
    on: "window",
    async check(world, w) {
      const { projection, placements: want } = await canonicalMineProjection(world, userOf(w!));
      if (!projection) return [{ message: "the server returned no projection for the principal" }];
      // Placed at the projection's own clock. The server places at the epoch
      // minute and a replica flips a stamp's stale_bucket on its raw clock
      // (computeBucketStale, C2), so inside a minute the two straddle a
      // deadline by design; comparing them at one instant is the convergence.
      const placed = await w!.run(() => placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: projection.epoch }));
      const got = new Map([...placed.placements].map(([id, p]) => [id, placementOf(p as any)]));
      const out: Violation[] = [];
      const sessions = w!.store.getState().sessions as Record<string, Row>;
      for (const id of [...new Set([...want.keys(), ...got.keys()])].sort()) {
        if (want.get(id) === got.get(id)) continue;
        if (process.env.TMPDBG) { const pl: any = await asUser(world, userOf(w!)).query("conversations:sessionsLiveness", {}); console.log("TMPDBG srv", id, JSON.stringify(pl.liveness[id]), "epoch", projection.epoch, "rep", JSON.stringify(placed.placements.get(id)), "stamp", JSON.stringify((w!.store.getState() as any).sessionsProjection?.mine?.stamps?.[id]), "pepoch", (w!.store.getState() as any).sessionsProjection?.mine?.epoch, "row", JSON.stringify(Object.fromEntries(Object.entries((w!.store.getState() as any).sessions[id] ?? {}).filter(([k]) => /agent_status|heartbeat|updated_at|daemon|idle/.test(k))))); }
        out.push({
          message: `placed ${got.get(id) ?? "(absent)"}, the server places ${want.get(id) ?? "(absent)"}`,
          row: { table: "conversations", id, server: await serverRow(world, id), replica: sessions[id] ?? null },
        });
        if (out.length >= MAX_ROWS_PER_CHECK) return out;
      }
      if (placed.set_digest !== projection.set_digest) {
        out.push({ message: `digest ${placed.set_digest ?? "(none)"}, the server's is ${projection.set_digest ?? "(none)"} at epoch ${projection.epoch}` });
      }
      if (stable(placed.tally) !== stable(projection.tally)) {
        out.push({ message: `tally ${stable(placed.tally)}, the server's is ${stable(projection.tally)}` });
      }
      return out;
    },
  },
  {
    // Host against follower, not against the server: the replicated slice.
    id: "INV-followers",
    meaning: "every follower holds the host's replicated slice byte for byte",
    keys: [],
    on: "window",
    when: (w) => w.role === "follower",
    async check(world, w) {
      const host = world.devices.find((d) => d.followers.includes(w!))?.host;
      if (!host) return [{ message: `follower ${w!.name} belongs to no device` }];
      const h = withoutWindowClocks(snapshotEntries(host.store.getState(), REPLICATED_STORE_KEYS));
      const f = withoutWindowClocks(snapshotEntries(w!.store.getState(), REPLICATED_STORE_KEYS));
      const out: Violation[] = [];
      for (const key of REPLICATED_STORE_KEYS) {
        if (stable(h[key]) === stable(f[key])) continue;
        if (!isReplicatedCollectionKey(key)) {
          out.push({ message: `${key} differs from host ${host.name}: host ${preview(h[key])}, follower ${preview(f[key])}` });
          continue;
        }
        const hr = (h[key] ?? {}) as Record<string, Row>;
        const fr = (f[key] ?? {}) as Record<string, Row>;
        for (const id of new Set([...Object.keys(hr), ...Object.keys(fr)])) {
          if (stable(hr[id]) === stable(fr[id])) continue;
          out.push({
            message: `${key} row differs from host ${host.name} (server column: host, replica column: follower)`,
            row: { table: serverTableOf(key), id, server: hr[id] ?? null, replica: fr[id] ?? null },
          });
          if (out.length >= MAX_ROWS_PER_CHECK) return out;
        }
      }
      return out;
    },
  },
  {
    id: "INV-team-inbox",
    meaning: "the team slot holds exactly the server's team list for the viewer, minus the viewer's own hides",
    keys: ["teamInboxIdSnapshot"],
    on: "window",
    when: (w) => teamOf(w.store.getState()) !== null,
    async check(world, w) {
      const state = w!.store.getState();
      const team = teamOf(state)!;
      const user = userOf(w!);
      const res: any = await asUser(world, user).query("conversations:listTeamInboxSessions", teamInboxArgs(team));
      const hidden = new Set(tableRows(world, "inbox_hides").filter((h) => h.user_id === user).map((h) => String(h.conversation_id)));
      const want = new Set<string>((res?.sessions ?? []).map((s: Row) => String(s._id)).filter((id: string) => !hidden.has(id)));
      const got = state.teamInboxIds as ReadonlySet<string>;
      const out: Violation[] = [];
      for (const id of [...new Set([...want, ...got])].sort()) {
        if (want.has(id) === got.has(id)) continue;
        out.push({
          message: got.has(id) ? "the team slot holds a row the server's team list leaves out" : "the team slot lacks a row the server's team list holds",
          row: { table: "conversations", id, server: await serverRow(world, id), replica: (state.sessions as Record<string, Row>)[id] ?? null },
        });
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-workspace-rows",
    meaning: "the window holds no task, doc, plan or project its principal cannot read, and each one it feeds matches the server in its workspace",
    keys: [...WORKSPACE_TABLES],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const user = userOf(w!);
      const ctx = { db: db(world) };
      const held = await heldKeysFor(ctx, user as any);
      const state = w!.store.getState() as any;
      const key = activeWorkspaceKeyOf(state);
      const out: Violation[] = [];
      for (const table of WORKSPACE_TABLES) {
        const replica = (state[table] ?? {}) as Record<string, Row>;
        const readable = new Map<string, Row>();
        for (const row of tableRows(world, table)) {
          if (authorizedFor(await accessStampFor(ctx, table, row), user, held)) readable.set(String(row._id), row);
        }
        // Every row the window holds must be one the principal may read,
        // whichever workspace it is filed under (the cache spans workspaces).
        for (const [id, row] of Object.entries(replica)) {
          if (!isConvexId(id) || readable.has(id)) continue;
          out.push({ message: `the window holds a ${table} row its principal cannot read`, row: { table, id, server: (await serverRow(world, id)) ?? null, replica: row } });
        }
        if (mode === "always" || !w!.feeds?.has(table)) continue;
        // A collection the window feeds holds, in the active workspace, the
        // same rows as the server, field for field.
        for (const [id, row] of readable) {
          if (!inWorkspace(row as any, key)) continue;
          const mine = replica[id];
          if (!mine) {
            out.push({ message: `the window lacks a readable ${table} row in its workspace ${key}`, row: { table, id, server: row, replica: null } });
            continue;
          }
          const [s, r] = sharedFields(table, row, mine);
          if (stable(s) !== stable(r)) out.push({ message: `a ${table} row disagrees with the server`, row: { table, id, server: row, replica: mine } });
        }
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      // A revocation reaches a window through its sync log, in a scope the
      // principal still holds (an item's new key, or scope_removed on the
      // user's own scope). Mid drain, a window with a held cursor behind its
      // head has not read it yet and holds the row as production would; once
      // caught up, an unreadable row is a leak. A settle has drained every catch-up.
      if (mode === "always" && out.length && (await cursorLag(world, w!)).some((l) => l.held)) return [];
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-sweep",
    meaning: "the team scope sweep finds no work item whose stored workspace key disagrees with its computed one",
    keys: [],
    on: "world",
    async check(world) {
      const { findings, missing, writes } = await scopeSweep(world.backend);
      const out: Violation[] = findings.map((f) => {
        const row = tableRows(world, f.table).find((r) => r.short_id === f.short_id || String(r._id) === f.short_id);
        return {
          message: `${f.table} stores workspace ${f.stored}, the sweep computes ${f.expected} (${f.reason})`,
          row: row ? { table: f.table, id: String(row._id), server: row, replica: null } : undefined,
        };
      });
      if (missing) out.push({ message: `${missing} work item(s) carry no stored workspace key` });
      if (writes) out.push({ message: `the sweep wrote ${writes} row(s) with apply false` });
      return out;
    },
  },
  {
    id: "INV-cursors",
    meaning: "each held sync-log scope's cursor stands at its head, and no unheld scope has a cursor",
    keys: ["syncMeta"],
    on: "window",
    async check(world, w) {
      return (await cursorLag(world, w!)).map(({ message }) => ({ message }));
    },
  },
  {
    id: "INV-pending-locks",
    meaning: "no acknowledged lock survives its cursor, and no field lock outlives the settle window",
    keys: ["pending"],
    on: "window",
    async check(world, w) {
      const state = w!.store.getState() as any;
      const out: Violation[] = [];
      for (const [key, entry] of Object.entries<any>(state.pending ?? {})) {
        const [coll] = key.split(":");
        const id = firstId(key);
        const row = async () => ({ table: serverTableOf(coll), id, server: await serverRow(world, id), replica: (state[coll] ?? {})[id] ?? null });
        const acked = (entry?.ack as { s: string; p: number }[] | undefined)?.find((a) => (state.syncMeta[syncLogScopeMetaKey(a.s)]?.cursor ?? 0) >= a.p);
        if (acked) {
          out.push({ message: `lock ${key} was acknowledged at ${acked.s}@${acked.p}, which the cursor has passed`, row: await row() });
        } else if (entry?.type === "field" && typeof entry.ts === "number" && Date.now() - entry.ts > HIDDEN_OVERRIDE_SETTLE_MS) {
          out.push({ message: `lock ${key} is ${Date.now() - entry.ts}ms old, past the ${HIDDEN_OVERRIDE_SETTLE_MS}ms settle window`, row: await row() });
        }
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-outbox",
    meaning: "every window's engine outbox is empty once the world settles",
    keys: [],
    on: "window",
    when: (w) => w.outbox !== undefined,
    async check(_world, w) {
      return [...w!.outbox!.values()].map((e) => ({ message: `outbox still holds ${e.action} (${e.id}) ${preview(e.args)}` }));
    },
  },
  {
    id: "INV-triggers",
    meaning: "the trigger replica equals agentTasks:webList, and each conversation's armed kind matches its live triggers",
    keys: ["agentTasks"],
    on: "window",
    async check(world, w) {
      const out: Violation[] = [];
      const user = userOf(w!);
      // The denormalized armed kind, for every conversation the principal runs.
      const tasks = tableRows(world, "agent_tasks");
      for (const conv of tableRows(world, "conversations")) {
        if (conv.user_id !== user) continue;
        const want = armedTriggerKindFor(tasks.filter((t) => t.originating_conversation_id === conv._id) as any);
        const got = (conv.armed_trigger_kind as string | undefined) ?? "none";
        if (got !== want) {
          out.push({ message: `armed_trigger_kind is ${got}, its triggers make it ${want}`, row: { table: "conversations", id: String(conv._id), server: conv, replica: null } });
        }
      }
      if (!w!.feeds?.has("agentTasks")) return out;
      const list: Row[] = (await asUser(world, user).query("agentTasks:webList", {})) ?? [];
      const want = new Map(list.map((t) => [String(t._id), t]));
      const replica = (w!.store.getState() as any).agentTasks as Record<string, Row>;
      for (const id of [...new Set([...want.keys(), ...Object.keys(replica ?? {}).filter(isConvexId)])].sort()) {
        const s = want.get(id);
        const r = replica?.[id];
        if (s && r && stable(sharedFields("agent_tasks", s, r)[0]) === stable(sharedFields("agent_tasks", s, r)[1])) continue;
        out.push({ message: s && r ? "a trigger disagrees with webList" : r ? "the replica holds a trigger webList does not return" : "the replica lacks a trigger webList returns", row: { table: "agent_tasks", id, server: s ?? null, replica: r ?? null } });
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-pending-sends",
    meaning: "every send bubble is echoed, settled or failed, and each client_id is on at most one pending_messages row",
    keys: ["pendingMessages", "queuedMessages"],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const pendingRows = tableRows(world, "pending_messages");
      // Mention wakes are INV-chat's to dedupe.
      const out = duplicateClientIds(pendingRows, (cid) => !parseChatMentionClientId(cid));
      if (mode === "always") return out;
      const state = w!.store.getState() as any;
      const echoed = new Set(tableRows(world, "messages").map((m) => m.client_id).filter(Boolean));
      for (const [convId, bubbles] of Object.entries<any[]>(state.pendingMessages ?? {})) {
        for (const b of bubbles ?? []) {
          if (b._isLocalQueue || b._isFailed || b._isSettled || (b._clientId && echoed.has(b._clientId))) continue;
          out.push({
            message: `send ${b._clientId ?? b._id} is still in flight: not echoed, settled or failed`,
            row: { table: "conversations", id: convId, server: await serverRow(world, convId), replica: state.sessions?.[convId] ?? null },
          });
        }
      }
      // A queued text waits on a conversation; one the server no longer has would never send.
      for (const [convId, texts] of Object.entries<string[]>(state.queuedMessages ?? {})) {
        if (!texts?.length || !isConvexId(convId) || (await serverRow(world, convId))) continue;
        out.push({ message: `${texts.length} queued text(s) wait on a conversation the server no longer has`, row: { table: "conversations", id: convId, server: null, replica: state.sessions?.[convId] ?? null } });
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-chat",
    meaning: "the chat replica equals chat:listMessages, each mention wakes its target once, and the hourly wake caps hold",
    keys: ["chatMessages"],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const wakes = mentionWakes(world);
      const out = duplicateClientIds(wakes, () => true);
      const hourOf = (r: Row) => hourBucket(createdAt(r));
      for (const [k, rs] of overCap(wakes, (r) => `${hourOf(r)} ${r.from_user_id}`, MENTION_WAKES_PER_SENDER_HOUR)) {
        out.push({ message: `${rs.length} mention wakes from one sender in hour ${k}, over the cap of ${MENTION_WAKES_PER_SENDER_HOUR}`, row: { table: "users", id: String(rs[0].from_user_id), server: null, replica: null } });
      }
      for (const [k, rs] of overCap(wakes, (r) => `${hourOf(r)} ${mentionTarget(r)}`, MENTION_WAKES_PER_TARGET_HOUR)) {
        const target = mentionTarget(rs[0]);
        out.push({ message: `${rs.length} mention wakes into one target in hour ${k}, over the cap of ${MENTION_WAKES_PER_TARGET_HOUR}`, row: { table: "conversations", id: target, server: await serverRow(world, target), replica: null } });
      }
      if (mode === "always") return out;
      // The replica's page of each channel it holds equals the server's newest page.
      const replica = ((w!.store.getState() as any).chatMessages ?? {}) as Record<string, Row>;
      const byChannel = new Map<string, Row[]>();
      for (const row of Object.values(replica)) {
        if (!isConvexId(String(row._id)) || !row.channel_id) continue;
        byChannel.set(String(row.channel_id), [...(byChannel.get(String(row.channel_id)) ?? []), row]);
      }
      for (const [channel, held] of byChannel) {
        if (!(await serverRow(world, channel))) {
          for (const r of held) out.push({ message: "the replica holds a chat line in a channel the server does not have", row: { table: "chat_messages", id: String(r._id), server: await serverRow(world, String(r._id)), replica: r } });
          continue;
        }
        const page: any = await asUser(world, userOf(w!)).query("chat:listMessages", { channel_id: channel, limit: 100 });
        const rows: Row[] = page?.messages ?? [];
        const want = new Map(rows.map((r) => [String(r._id), r]));
        const oldest = page?.has_more ? Math.min(...rows.map(createdAt)) : -Infinity;
        for (const r of held) {
          if (createdAt(r) < oldest || want.has(String(r._id))) continue;
          out.push({ message: `the replica holds a chat line the channel page does not return${page?.unavailable ? " (the channel is unavailable to the principal)" : ""}`, row: { table: "chat_messages", id: String(r._id), server: await serverRow(world, String(r._id)), replica: r } });
        }
        for (const [id, s] of want) {
          const r = replica[id];
          if (r && stable(sharedFields("chat_messages", s, r)[0]) === stable(sharedFields("chat_messages", s, r)[1])) continue;
          out.push({ message: r ? "a chat line disagrees with the channel page" : "the replica lacks a chat line of the channel page", row: { table: "chat_messages", id, server: s, replica: r ?? null } });
        }
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-roles",
    meaning: "each role's mention wake counter equals the wakes enqueued for it, and listAnchors equals visibleAnchorsForUser",
    keys: ["anchors"],
    on: "window",
    async check(world, w) {
      const out: Violation[] = [];
      // The counter takeQuota keeps per target and hour, against the rows that wake it.
      const roles = new Map(tableRows(world, "org_roles").map((r) => [String(r._id), r]));
      const wakes = mentionWakes(world);
      for (const q of tableRows(world, "chat_agent_quota")) {
        const key = String(q.key);
        if (!key.startsWith("mention_to:")) continue;
        const roleId = key.slice("mention_to:".length);
        if (!roles.has(roleId)) continue;
        const enqueued = wakes.filter((r) => mentionTarget(r) === roleId && hourBucket(createdAt(r)) === q.bucket).length;
        if (enqueued !== q.count) {
          out.push({ message: `the wake counter for hour ${q.bucket} reads ${q.count}, ${enqueued} wake(s) were enqueued`, row: { table: "org_roles", id: roleId, server: roles.get(roleId)!, replica: null } });
        }
      }
      const user = userOf(w!);
      const listed: Row[] = (await asUser(world, user).query("anchors:listAnchors", {})) ?? [];
      const visible: Row[] = await visibleAnchorsForUser({ db: db(world) }, user as any);
      const listedIds = new Set(listed.map((a) => String(a._id)));
      const visibleIds = new Set(visible.map((a) => String(a._id)));
      for (const id of new Set([...listedIds, ...visibleIds])) {
        if (listedIds.has(id) === visibleIds.has(id)) continue;
        out.push({ message: listedIds.has(id) ? "listAnchors returns an anchor the principal cannot see" : "listAnchors leaves out a visible anchor", row: { table: "anchors", id, server: await serverRow(world, id), replica: null } });
      }
      // The replica never holds an anchor its principal cannot see.
      const replica = ((w!.store.getState() as any).anchors ?? {}) as Record<string, Row>;
      for (const [id, row] of Object.entries(replica)) {
        if (!isConvexId(id) || visibleIds.has(id)) continue;
        out.push({ message: "the window holds an anchor its principal cannot see", row: { table: "anchors", id, server: await serverRow(world, id), replica: row } });
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-ping-pong",
    meaning: "agent to agent wakes per virtual hour stay under the mention caps, per sender and per target",
    keys: [],
    on: "world",
    async check(world) {
      const agentLines = new Map(tableRows(world, "chat_messages").filter((m) => m.origin === "agent").map((m) => [String(m._id), m]));
      // From a session: a session's own send, or a chat wake carrying an agent's
      // line, either its mention or its reply relayed to the session that
      // mentioned it (lib/chatWakeIds).
      const lineOf = (cid: string) => parseChatMentionClientId(cid)?.message ?? parseChatRelayClientId(cid) ?? "";
      const fromAgent = tableRows(world, "pending_messages").filter((r) =>
        r.from_conversation_id || (typeof r.client_id === "string" && agentLines.has(lineOf(r.client_id))));
      const hourOf = (r: Row) => hourBucket(createdAt(r));
      const out: Violation[] = [];
      for (const [k, rs] of overCap(fromAgent, (r) => `${hourOf(r)} ${r.conversation_id}`, MENTION_WAKES_PER_TARGET_HOUR)) {
        const id = String(rs[0].conversation_id);
        out.push({ message: `${rs.length} agent wakes into one session in hour ${k}, over ${MENTION_WAKES_PER_TARGET_HOUR}`, row: { table: "conversations", id, server: await serverRow(world, id), replica: null } });
      }
      // The sender the server charges (chat.ts reserveMentionWakeCaps): the
      // person for a mention, the replying session for a relayed reply.
      const senderOf = (r: Row) => {
        const relayed = typeof r.client_id === "string" ? agentLines.get(parseChatRelayClientId(r.client_id) ?? "") : undefined;
        return relayed?.origin_session_id ? `${r.from_user_id}:${relayed.origin_session_id}` : String(r.from_user_id);
      };
      for (const [k, rs] of overCap(fromAgent, (r) => `${hourOf(r)} ${senderOf(r)}`, MENTION_WAKES_PER_SENDER_HOUR)) {
        out.push({ message: `${rs.length} agent wakes from one sender in hour ${k}, over ${MENTION_WAKES_PER_SENDER_HOUR}`, row: { table: "users", id: String(rs[0].from_user_id), server: null, replica: null } });
      }
      return out;
    },
  },
  {
    // The row is an allowlist (sync-convergence C1 field ownership): a key no
    // base feeder writes can only have ridden in on cargo or a local write,
    // and the next list or byIds push removes it. A field under a pending
    // local write is the exception: an action may carry its server field on
    // the row until the write is acknowledged.
    id: "INV-row-shape",
    meaning: "every sessions row holds only the inbox row's fields (INBOX_ROW_FIELDS plus the facts), or a field a pending local write holds",
    keys: ["sessions"],
    on: "window",
    async check(_world, w) {
      const state = w!.store.getState() as any;
      const out: Violation[] = [];
      for (const [id, row] of Object.entries<Row>(state.sessions ?? {})) {
        if (!isConvexId(id)) continue;
        const extra = Object.keys(row).filter((k) => !inRowShape(k) && !state.pending?.[`sessions:${id}:${k}`]);
        if (!extra.length) continue;
        out.push({ message: `sessions[${id}] holds ${extra.sort().join(", ")}, outside the inbox row's fields`, row: { table: "conversations", id, server: null, replica: row } });
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-fixpoint",
    meaning: "re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing",
    keys: FIXPOINT_FED_KEYS,
    on: "window",
    when: (w) => w.role === "host",
    async check(world, w) {
      const direct = asUser(world, userOf(w!));
      // Bring the liveness overlays to the current epoch first, as
      // production's stale-payload probe does: they are the one writer of the
      // time-derived facts (C1), and a push from an earlier minute differs
      // from a fresh execution because time moved, not because two feeders
      // disagree.
      await w!.run(async () => { await w!.refeed?.(LIVENESS_FEEDS); });
      const before = w!.store.getState() as any;
      // Every write of the pass counts, the way the window's IDB tee sees it:
      // a row two feeders write two ways flaps and lands where it started. A
      // write of a whole collection is resolved to its rows against the value
      // the tap saw last.
      const writes = new Map<string, Set<string>>();
      const seen: Record<string, unknown> = { ...before };
      const record = (patches: readonly StorePatch[], state: any) => {
        for (const p of patches) {
          const key = String(p.path[0]);
          const rows = p.path.length === 1 && state ? notifiedWrites({ [key]: seen[key] }, { [key]: state[key] }) : [p];
          for (const r of rows.length ? rows : [p]) {
            const hit = writeOf(r);
            if (hit) writes.set(hit[0], (writes.get(hit[0]) ?? new Set()).add(hit[1]));
          }
          if (state) seen[key] = state[key];
        }
      };
      const untap = w!.onWrite
        ? w!.onWrite(record)
        : w!.store.subscribe((state: any, prev: any) => record(notifiedWrites(prev, state), null));
      try {
        await w!.run(async () => {
          await w!.refeed?.();
          await catchUp(direct);
          const held = emptyIdsByCollection();
          const s = useInboxStore.getState() as any;
          for (const coll of Object.keys(held) as (keyof typeof held)[]) {
            held[coll] = Object.keys(s[coll] ?? {}).filter(isConvexId);
          }
          // The inbox byIds serves the rows the principal runs or owns (its
          // contract); a teammate's row on the team board comes from the team
          // list, which the refeed re-ran.
          held.sessions = await asyncFilter(held.sessions, (id) => servesById(world, id, userOf(w!)));
          await applyEntityIds(direct, held);
        });
      } finally {
        untap();
      }
      const after = w!.store.getState() as any;
      const asRow = (v: unknown): Row | null => (v && typeof v === "object" ? (v as Row) : v === undefined || v === null ? null : { value: v });
      return [...writes].slice(0, MAX_ROWS_PER_CHECK).map(([where, what]) => {
        const [, key, sub] = where.match(/^([^[]+)(?:\[(.*)\])?$/)!;
        return {
          message: `${where} was written on a refeed: ${[...what].join(", ")}`,
          row: sub === undefined ? undefined : { table: serverTableOf(key), id: firstId(sub), server: asRow(after[key]?.[sub]), replica: asRow(before[key]?.[sub]) },
        };
      });
    },
  },
];

// A replicated slot's receive stamp is the receiving window's own monotonic
// clock (applyReplicatedProjection stamps it on apply), so a follower applying
// the host's slot later holds a different one by design.
function withoutWindowClocks(entries: Record<string, unknown>): Record<string, unknown> {
  const proj = entries.sessionsProjection as Record<string, Record<string, unknown>> | undefined;
  if (!proj || typeof proj !== "object") return entries;
  const slots = Object.fromEntries(Object.entries(proj).map(([k, slot]) => {
    if (!slot || typeof slot !== "object") return [k, slot];
    const { receivedAtMono: _r, ...rest } = slot;
    return [k, rest];
  }));
  return { ...entries, sessionsProjection: slots };
}

// ── Running the catalog ─────────────────────────────────────────────────────

export function allWindows(world: InvariantWorld): InvariantWindow[] {
  return world.devices.flatMap((d) => [d.host, ...d.followers]);
}

/**
 * Runs the catalog over the world and returns every failure, in catalog
 * order. The fixpoint pass runs last: it re-feeds the windows, and on a
 * failure its writes would otherwise reach the checks after it (a host it
 * moved no longer matches followers that nothing replicated to). "always"
 * mode runs only the rules marked always, over the windows given (the one a
 * delivery touched).
 */
export async function checkInvariants(
  world: InvariantWorld,
  opts: { mode?: CheckMode; ids?: readonly string[]; windows?: readonly InvariantWindow[] } = {},
): Promise<InvariantFailure[]> {
  const mode = opts.mode ?? "settle";
  const windows = opts.windows ?? allWindows(world);
  const failures: InvariantFailure[] = [];
  for (const inv of INVARIANTS) {
    if (opts.ids && !opts.ids.includes(inv.id)) continue;
    if (mode === "always" && !inv.always) continue;
    const invariant = { id: inv.id, meaning: inv.meaning };
    if (inv.on === "world") {
      for (const v of await inv.check(world, null, mode)) failures.push({ invariant, ...v });
      continue;
    }
    for (const w of windows) {
      if (inv.when && !inv.when(w)) continue;
      const window = windowContext(w);
      for (const v of await inv.check(world, w, mode)) failures.push({ invariant, window, ...v });
    }
  }
  return failures;
}

/** A window as a failure report names it: its name, principal and inbox scope. */
export function windowContext(w: InvariantWindow): NonNullable<FailureContext["window"]> {
  return { name: w.name, principal: userOf(w), scope: scopeOf(w.store.getState()) };
}

/** A failure as report.ts takes it, given the run's facts. */
export function failureContext(f: InvariantFailure, base: Omit<FailureContext, "invariant" | "message" | "window" | "row">): FailureContext {
  return { ...base, invariant: f.invariant, message: f.message, window: f.window, row: f.row };
}
