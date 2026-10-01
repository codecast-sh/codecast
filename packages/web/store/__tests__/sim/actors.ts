// The sim's actors: the people, daemons, agents and admins who act on the
// world (docs/architecture/multiplayer-sim-harness.md, section 3.6).
//
// Every verb only enqueues a delivery on `actor:<name>` and returns its seq;
// nothing drains here. Each one takes the path production takes:
//
//   human   a store action in the window (the same calls a component makes),
//           which reaches dispatch:dispatch through the window's _dispatch
//   daemon  the mutation names packages/cli/src/syncService.ts sends, under
//           the user's api token (token principal)
//   agent   chat:sendMessage with origin "agent", as `cast chat send` from a session
//   admin   teams:removeMember as the team's admin
//   clock   moves the virtual clock; what comes due runs at the next step
//
// A server refusal is an outcome, not a harness failure: it is kept in `log`
// (and in backend.calls) and the delivery succeeds. An error the sim itself
// raises ("sim client: ...", "sim server: ...", "sim ctx: ...") is a harness
// gap and propagates.

import type { SimClient } from "@codecast/convex/convex/simBackend.testing";
import type { AgentStatus } from "@codecast/shared/contracts";
import type { RealmWindow } from "./realm";
import { daemonDeviceFor, sessionIdFor, type SimWorld } from "./world";

/** What a human actor needs of a window: its name, its store, and a turn. */
export interface ActorWindow extends RealmWindow {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

export interface ActorLogEntry {
  actor: string;
  verb: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const SIM_ERROR = /^sim (client|server|ctx|world|realm|net)\b/;

export interface HumanActor {
  kill(session: string): number;
  stash(session: string): number;
  restore(session: string): number;
  pin(session: string): number;
  revive(session: string, text?: string): number;
  send(session: string, text: string): number;
  setPrivacy(session: string, to: "private" | "team"): number;
  chat(channel: string, text: string): number;
  tellRole(role: string, text: string): number;
}

export interface DaemonActor {
  settles(session: string, status?: AgentStatus): number;
  heartbeat(session: string, status?: AgentStatus): number;
  restart(sessions: string[]): number;
  claimPending(session?: string): number;
  ack(session: string): number;
  resume(session: string): number;
  claimTask(trigger?: string): number;
  /** pending_messages ids claimed and not yet acked, by conversation id. */
  readonly claimed: Map<string, string[]>;
  /** agent_tasks ids this daemon holds a lease on. */
  readonly leases: string[];
}

export interface AgentActor {
  /** `thread`: the label of the root to reply under, as `cast chat send --thread <root>` does. */
  says(channel: string, text: string, mentions?: string[], opts?: { thread?: string }): number;
}

export interface AdminActor {
  remove(team: string, user: string): number;
}

export interface ClockActor {
  advance(ms: number): number;
}

export interface Actors {
  human(win: ActorWindow): HumanActor;
  daemon(user: string): DaemonActor;
  agent(session: string): AgentActor;
  admin(user: string): AdminActor;
  clock: ClockActor;
  /** Every verb that ran, in order, with the server's answer or refusal. */
  log: ActorLogEntry[];
}

/**
 * What the actors need of a world. SimWorld is one; the legacy suites'
 * SimServer (inboxSimHarness.ts) is another, so both drive one copy of the verbs.
 */
export type ActorWorld = Pick<SimWorld, "net" | "start" | "row" | "labels" | "idOf" | "clientAs" | "daemonClientAs" | "realm">;

export function makeActors(world: ActorWorld): Actors {
  const log: ActorLogEntry[] = [];
  const daemons = new Map<string, DaemonActor>();

  // One verb: a delivery on actor:<name> that runs `body` and records the outcome.
  function verb(actor: string, name: string, subject: string, body: () => Promise<unknown>): number {
    return world.net.enqueue(`actor:${actor}`, {
      label: `${actor} ${name}${subject ? ` ${subject}` : ""}`,
      producer: `actor:${actor} ${name}`,
      run: async () => {
        await world.start();
        try {
          log.push({ actor, verb: name, ok: true, result: await body() });
        } catch (error: any) {
          const message = String(error?.message ?? error);
          if (SIM_ERROR.test(message)) throw error;
          log.push({ actor, verb: name, ok: false, error: message });
        }
      },
    });
  }

  const ownerOf = async (session: string): Promise<string> => {
    const row = await world.row(session);
    if (!row) throw new Error(`sim world: no server row for "${session}"`);
    return world.labels.label(String(row.user_id));
  };

  // The team default channel a chat label names ("acme/general").
  const channelId = (channel: string) => world.idOf(`chan:${channel}`);

  function human(win: ActorWindow): HumanActor {
    const act = (name: string, subject: string, fn: (s: any) => unknown) =>
      verb(win.name, name, subject, () => win.run(() => fn(win.store.getState())));
    // A composer send: paint the bubble, then the durable send under its client id.
    const send = (s: any, id: string, text: string) => {
      const clientId = s.addOptimisticMessage(id, text);
      s.sendMessage(id, text, undefined, clientId);
      return clientId;
    };
    const chat = (channel: string, text: string) =>
      act("chat", channel, (s) => s.sendChatMessage(channelId(channel), text));
    return {
      kill: (session) => act("kill", session, (s) => s.killSession(world.idOf(session))),
      stash: (session) => act("stash", session, (s) => s.stashSession(world.idOf(session))),
      restore: (session) => act("restore", session, (s) => s.restoreSession(world.idOf(session))),
      pin: (session) => act("pin", session, (s) => s.pinSession(world.idOf(session))),
      // The context-park revive: the turn goes out, and the row is stamped
      // revive-in-flight so it leaves the blocked set at once.
      revive: (session, text = "continue") =>
        act("revive", session, (s) => {
          const id = world.idOf(session);
          const clientId = send(s, id, text);
          s.markBlockedReviveRequested([id]);
          return clientId;
        }),
      send: (session, text) => act("send", session, (s) => send(s, world.idOf(session), text)),
      setPrivacy: (session, to) => act("setPrivacy", `${session} ${to}`, (s) => s.setPrivacy(world.idOf(session), to === "private")),
      chat,
      // `@handle` in the role's team channel, as a person addresses a role.
      tellRole: (role, text) => {
        const [team, handle] = roleParts(role);
        return chat(`${team}/general`, `@${handle} ${text}`);
      },
    };
  }

  function daemon(user: string): DaemonActor {
    const existing = daemons.get(user);
    if (existing) return existing;
    const actor = `${user}.daemon`;
    const device_id = daemonDeviceFor(user);
    const cli = (): SimClient => world.daemonClientAs(user);
    const claimed = new Map<string, string[]>();
    // What each claimed row says: the text the paste puts in the pane, and so what the transcript echoes.
    const pasted = new Map<string, string>();
    const leases: string[] = [];
    const d: DaemonActor = {
      claimed,
      leases,
      settles: (session, status = "idle") =>
        verb(actor, "settles", `${session} ${status}`, () =>
          cli().mutation("managedSessions:updateAgentStatus", {
            conversation_id: world.idOf(session),
            agent_status: status,
            client_ts: world.realm.now(),
          }),
        ),
      heartbeat: (session, status) =>
        verb(actor, "heartbeat", session, () =>
          cli().mutation("managedSessions:heartbeat", {
            session_id: sessionIdFor(world.idOf(session)),
            ...(status ? { agent_status: status, client_ts: world.realm.now() } : {}),
          }),
        ),
      // A restarted daemon re-registers every session it recovers from tmux.
      restart: (sessions) =>
        verb(actor, "restart", sessions.join(","), async () => {
          const out = [];
          for (const session of sessions) {
            const conversation_id = world.idOf(session);
            out.push(await cli().mutation("managedSessions:registerManagedSession", {
              session_id: sessionIdFor(conversation_id),
              pid: 4242,
              conversation_id,
              device_id,
            }));
          }
          return out;
        }),
      // The delivery poll: every message waiting for this device, claimed one by one.
      claimPending: (session) =>
        verb(actor, "claimPending", session ?? "", async () => {
          const only = session ? world.idOf(session) : undefined;
          const pending: any[] = await cli().query("pendingMessages:getPendingMessagesForDaemon", { device_id });
          const got = [];
          for (const msg of pending) {
            const conv = String(msg.conversation_id);
            if (only && conv !== only) continue;
            const row = await cli().mutation("pendingMessages:claimPendingMessageForDelivery", {
              message_id: msg._id,
              conversation_id: conv,
              device_id,
            });
            if (!row) continue;
            pasted.set(String(msg._id), String(row.content ?? ""));
            claimed.set(conv, [...(claimed.get(conv) ?? []), String(msg._id)]);
            got.push(String(msg._id));
          }
          return got;
        }),
      // The paste landed: each claimed row goes to injected (paste verified),
      // the transcript sync uploads the user line it echoed (which the server
      // matches to the row, stamping its client_id, as the web's bubble needs),
      // then the daemon acks what it pasted.
      ack: (session) =>
        verb(actor, "ack", session, async () => {
          const conversation_id = world.idOf(session);
          const ids = claimed.get(conversation_id) ?? [];
          claimed.delete(conversation_id);
          for (const message_id of ids) {
            await cli().mutation("pendingMessages:updateMessageStatus", { message_id, status: "injected", paste_verified: true, device_id });
          }
          if (ids.length) {
            await cli().mutation("messages:addMessages", {
              conversation_id,
              messages: ids.map((id) => ({ message_uuid: `sim-echo-${id}`, role: "user", content: pasted.get(id) ?? "", timestamp: world.realm.now() })),
            });
          }
          return cli().mutation("pendingMessages:ackInjectedMessages", { conversation_id, device_id, message_ids: ids });
        }),
      // Resuming a parked session goes through resumeConversationSession, as
      // the user it runs for.
      resume: (session) =>
        verb(actor, "resume", session, () =>
          world.clientAs(user).mutation("users:resumeSession", { conversation_id: world.idOf(session) }),
        ),
      // The scheduler poll: due triggers, each claimed under a lease.
      claimTask: (trigger) =>
        verb(actor, "claimTask", trigger ?? "", async () => {
          const only = trigger ? world.idOf(trigger) : undefined;
          const due: any[] = await cli().query("agentTasks:getDueTasks", { limit: 5 });
          const got = [];
          for (const task of due) {
            if (only && String(task._id) !== only) continue;
            const run = await cli().mutation("agentTasks:claimTask", { task_id: task._id, daemon_id: device_id });
            if (!run) continue;
            leases.push(String(task._id));
            got.push(String(task._id));
          }
          return got;
        }),
    };
    daemons.set(user, d);
    return d;
  }

  function agent(session: string): AgentActor {
    const actor = `agent.${session}`;
    return {
      says: (channel, text, mentions = [], opts = {}) =>
        verb(actor, "says", opts.thread ? `${channel} ${opts.thread}` : channel, async () => {
          const owner = await ownerOf(session);
          return world.daemonClientAs(owner).mutation("chat:sendMessage", {
            channel_id: channelId(channel),
            ...(opts.thread ? { thread_root_id: world.idOf(opts.thread) } : {}),
            content: [...mentions.map((m) => `@${m}`), text].join(" "),
            origin: "agent",
            origin_session_id: sessionIdFor(world.idOf(session)),
          });
        }),
    };
  }

  function admin(user: string): AdminActor {
    const actor = `${user}.admin`;
    return {
      remove: (team, member) =>
        verb(actor, "remove", `${team} ${member}`, () =>
          world.clientAs(user).mutation("teams:removeMember", { team_id: world.idOf(team), member_user_id: world.idOf(member) }),
        ),
    };
  }

  const clock: ClockActor = {
    advance: (ms) =>
      verb("clock", "advance", `${ms}ms`, async () => {
        world.realm.advance(ms);
      }),
  };

  return { human, daemon, agent, admin, clock, log };
}

function roleParts(role: string): [team: string, handle: string] {
  const m = /^role:([^/]+)\/(.+)$/.exec(role);
  if (!m) throw new Error(`sim world: "${role}" is not a role label (role:<team>/<handle>)`);
  return [m[1], m[2]];
}
