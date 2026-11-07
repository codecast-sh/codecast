/**
 * The Chrome profiles connected to one bridge host, one link each (an
 * extension's proven socket).
 *
 * Chrome numbers tabs per profile process tree, so two profiles can both
 * have tab 7. Every tab id the host works with is its own, translated at the
 * link's edge (messages in, requests out), and the rest of the host keeps
 * treating tab ids as unique. A tab keeps Chrome's own id unless another
 * profile already holds that number, so with one profile nothing changes,
 * and ids persisted before profiles existed still mean the same tab. A clash
 * gets an id from 0x40000000 up, far above the ids Chrome hands out.
 *
 * A link is named by its profile's short id (pairing.ts ProfileRecord.id),
 * which is stable across host restarts; persisted tab state names that id so
 * a restarted host maps every remembered tab back to the same host id.
 */

import type { BridgeSocket } from "./transport.js";

export interface LinkMeta {
  version?: string;
  protocol?: number;
  userAgent?: string;
  boot?: string;
  bootAt?: number;
}

export interface ExtLink {
  /** The profile's short id agents name ("ashot-default"). */
  id: string;
  /** The extension's profile key, or LEGACY_LINK_KEY for a build that predates profiles. */
  key: string;
  name: string;
  /** The Chrome profile directory, when pairing knew it. */
  dir?: string;
  ws: BridgeSocket;
  meta: LinkMeta;
  heardAt: number;
  /** Frames heard, counted: the incumbent probe asks "anything since the ping?". */
  framesHeard: number;
  connectedAt: number;
  /** The key hash this socket proved, so a revoke or re-pair cuts it off. Absent for the shared token. */
  hash?: string;
}

/** A store build from before profiles: it proves the shared token and carries no key. One such link at a time. */
export const LEGACY_LINK_KEY = "legacy";

/** The first id handed to a tab whose Chrome id another profile already holds. */
const CLASH_BASE = 0x40000000;

export class TabIds {
  private toHost = new Map<string, number>();
  private fromHost = new Map<number, { link: string; tab: number }>();
  private next = CLASH_BASE;

  /** The host's id for a profile's tab, allotted the first time it is seen. */
  host(link: string, tab: number): number {
    const k = `${link}:${tab}`;
    let id = this.toHost.get(k);
    if (id !== undefined) return id;
    id = this.fromHost.has(tab) ? this.next++ : tab;
    while (this.fromHost.has(id)) id = this.next++;
    this.seed(id, link, tab);
    return id;
  }

  /** A mapping a previous host persisted. Ignored when either side is already taken. */
  seed(id: number, link: string, tab: number): void {
    const k = `${link}:${tab}`;
    if (this.toHost.has(k) || this.fromHost.has(id)) return;
    this.toHost.set(k, id);
    this.fromHost.set(id, { link, tab });
    if (id >= this.next) this.next = id + 1;
  }

  /** The profile and Chrome tab a host id names. */
  chrome(id: number): { link: string; tab: number } | undefined {
    return this.fromHost.get(id);
  }

  drop(id: number): void {
    const e = this.fromHost.get(id);
    if (!e) return;
    this.fromHost.delete(id);
    this.toHost.delete(`${e.link}:${e.tab}`);
  }

  /** Every mapping of one profile, for when its link is gone for good (revoked). */
  dropLink(link: string): number[] {
    const ids = [...this.fromHost].filter(([, e]) => e.link === link).map(([id]) => id);
    for (const id of ids) this.drop(id);
    return ids;
  }
}

/** Connected profiles in the order they connected. */
export class Links {
  private byId = new Map<string, ExtLink>();

  list(): ExtLink[] {
    return [...this.byId.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  get(id: string): ExtLink | undefined {
    return this.byId.get(id);
  }

  ofSocket(ws: BridgeSocket): ExtLink | undefined {
    return this.list().find((l) => l.ws === ws);
  }

  ofKey(key: string): ExtLink | undefined {
    return this.list().find((l) => l.key === key);
  }

  /** Add or replace; returns the link it replaced (same profile reconnecting), if any. */
  set(link: ExtLink): ExtLink | undefined {
    const prev = this.byId.get(link.id) ?? this.ofKey(link.key);
    if (prev) this.byId.delete(prev.id);
    this.byId.set(link.id, link);
    return prev && prev.ws !== link.ws ? prev : undefined;
  }

  /** Remove this socket's link if it is still current; returns it. */
  remove(ws: BridgeSocket): ExtLink | undefined {
    const l = this.ofSocket(ws);
    if (l) this.byId.delete(l.id);
    return l;
  }

  /**
   * The profile agents use when they name none: the one setup paired last
   * (`--profile`, its Chrome directory), else the first that connected.
   */
  default(pinnedDir?: string): ExtLink | undefined {
    const all = this.list();
    return (pinnedDir ? all.find((l) => l.dir === pinnedDir) : undefined) ?? all[0];
  }
}
