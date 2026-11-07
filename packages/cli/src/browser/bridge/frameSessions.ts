/**
 * Child sessions on the bridge: cross-origin iframes (out-of-process frames)
 * reached as their own CDP sessions, the way a client of a real Chrome
 * reaches them with `Target.setAutoAttach {flatten: true}`.
 *
 * Chrome owns the real child sessions. The extension turns auto-attach on for
 * every tab it drives (background.js enableFrames), and each child arrives at
 * the host as a `Target.attachedToTarget` event carrying Chrome's own session
 * id; events and commands for the child carry that id between extension and
 * host. Chrome's id never reaches a client. Each client that asked for
 * auto-attach on a session gets its own minted id for each child, stamped
 * with the client's id of the parent, so one client can never name another
 * client's child, and a child shows up only below a session the client holds.
 *
 * Two maps. Per tab, the children Chrome reported (`chrome id → parent chrome
 * id or null for the tab itself, targetInfo`), kept whether or not a client
 * has asked yet, so a later `Target.setAutoAttach` replays them as real Chrome
 * does. Per client, its minted ids (`client id → tab, chrome id, the client's
 * parent id`) and the set of its sessions that asked for auto-attach.
 *
 * `admit` decides whether a child is offered at all: the host passes the site
 * policy of the tab's sessions, applied to the FRAME's own URL, so a frame
 * from a site off the allowlist stays out of reach the way a tab there does.
 * A child attaches before its URL commits (url "" or about:blank); the host
 * admits that, and checks every command against the URL the frame has then.
 */

/** The one browser context the bridge reports for every target (host.ts targetInfo). */
const BRIDGE_CONTEXT_ID = "cast-real-chrome";

export interface FrameRoute {
  tabId: number;
  /** Chrome's session id for the child, which the extension routes by. */
  chrome: string;
  /** The client's id of the parent session (the tab's, or another child's). */
  parent: string;
}

export interface FrameOut<C> {
  client: C;
  msg: Record<string, unknown>;
}

interface Target {
  /** Chrome's session id of the parent child, null when the parent is the tab itself. */
  parent: string | null;
  targetInfo: Record<string, unknown>;
}

interface ClientFrames {
  routes: Map<string, FrameRoute>;
  /** Sessions (the client's ids, tab or child) that asked for auto-attach. */
  auto: Set<string>;
}

export interface FrameSessionsDeps<C> {
  /** The client's ids of its sessions on the tab itself. */
  rootSessions(tabId: number): Array<[C, string]>;
  mint(): string;
  admit(tabId: number, url: string): boolean;
}

export class FrameSessions<C> {
  private tabs = new Map<number, Map<string, Target>>();
  private clients = new Map<C, ClientFrames>();

  constructor(private deps: FrameSessionsDeps<C>) {}

  private of(client: C): ClientFrames {
    let f = this.clients.get(client);
    if (!f) this.clients.set(client, (f = { routes: new Map(), auto: new Set() }));
    return f;
  }

  route(client: C, sessionId: string): FrameRoute | undefined {
    return this.clients.get(client)?.routes.get(sessionId);
  }

  /** The frame's current URL, from what Chrome last reported for it. */
  url(route: FrameRoute): string {
    return String(this.tabs.get(route.tabId)?.get(route.chrome)?.targetInfo.url ?? "");
  }

  /** Where an event from Chrome's session `chrome` on `tabId` goes: each client's id for it. */
  eventTargets(tabId: number, chrome: string): Array<[C, string]> {
    const out: Array<[C, string]> = [];
    for (const [client, f] of this.clients) {
      for (const [id, r] of f.routes) if (r.tabId === tabId && r.chrome === chrome) out.push([client, id]);
    }
    return out;
  }

  /** The client's sessions that are the Chrome session `parent` on `tabId` (null: the tab itself). */
  private holdersOf(tabId: number, parent: string | null): Array<[C, string]> {
    if (parent === null) return this.deps.rootSessions(tabId);
    return this.eventTargets(tabId, parent);
  }

  private offer(client: C, parentId: string, tabId: number, chrome: string, t: Target): FrameOut<C> | null {
    const f = this.of(client);
    for (const r of f.routes.values()) if (r.tabId === tabId && r.chrome === chrome && r.parent === parentId) return null;
    const url = String(t.targetInfo.url ?? "");
    if (!this.deps.admit(tabId, url)) return null;
    const id = this.deps.mint();
    f.routes.set(id, { tabId, chrome, parent: parentId });
    return {
      client,
      msg: { method: "Target.attachedToTarget", params: { sessionId: id, targetInfo: { ...t.targetInfo, attached: true, browserContextId: BRIDGE_CONTEXT_ID }, waitingForDebugger: false }, sessionId: parentId },
    };
  }

  /** Chrome attached a child (`params` of its Target.attachedToTarget) under `parent` on `tabId`. */
  attached(tabId: number, parent: string | null, params: any): FrameOut<C>[] {
    const chrome = typeof params?.sessionId === "string" ? params.sessionId : "";
    if (!chrome || !params?.targetInfo) return [];
    let tab = this.tabs.get(tabId);
    if (!tab) this.tabs.set(tabId, (tab = new Map()));
    const t: Target = { parent, targetInfo: params.targetInfo };
    tab.set(chrome, t);
    return this.offerToHolders(tabId, chrome, t);
  }

  /** Offer a child to every client that asked for auto-attach on a session holding its parent. */
  private offerToHolders(tabId: number, chrome: string, t: Target): FrameOut<C>[] {
    const out: FrameOut<C>[] = [];
    for (const [client, parentId] of this.holdersOf(tabId, t.parent)) {
      if (!this.clients.get(client)?.auto.has(parentId)) continue;
      const o = this.offer(client, parentId, tabId, chrome, t);
      if (o) out.push(o);
    }
    return out;
  }

  /**
   * A child's main frame moved (its Page.frameNavigated without a parentId).
   * A child attaches before its first URL commits, so this is also where one
   * that was not admitted yet is offered once it lands on an allowed site.
   */
  navigated(tabId: number, chrome: string, url: string): FrameOut<C>[] {
    const t = this.tabs.get(tabId)?.get(chrome);
    if (!t) return [];
    t.targetInfo = { ...t.targetInfo, url };
    return this.offerToHolders(tabId, chrome, t);
  }

  /** Chrome detached child `chrome` on `tabId`: it and every child below it are gone. */
  detached(tabId: number, chrome: string): FrameOut<C>[] {
    const tab = this.tabs.get(tabId);
    if (!tab) return [];
    const gone = new Set<string>([chrome]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [id, t] of tab) if (t.parent && gone.has(t.parent) && !gone.has(id)) gone.add(id), (grew = true);
    }
    const out = this.dropRoutes((r) => r.tabId === tabId && gone.has(r.chrome));
    for (const id of gone) tab.delete(id);
    return out;
  }

  /**
   * A client's session asked for auto-attach (or turned it off). Turning it
   * on replays the children Chrome already reported under it, as Chrome does.
   */
  setAutoAttach(client: C, sessionId: string, tabId: number, chrome: string | null, on: boolean): FrameOut<C>[] {
    const f = this.of(client);
    if (!on) {
      f.auto.delete(sessionId);
      return [];
    }
    f.auto.add(sessionId);
    const out: FrameOut<C>[] = [];
    for (const [id, t] of this.tabs.get(tabId) ?? []) {
      if (t.parent !== chrome) continue;
      const o = this.offer(client, sessionId, tabId, id, t);
      if (o) out.push(o);
    }
    return out;
  }

  /** A client let go of one of its sessions (tab or child): it and every child below it go, silently (the client saw its own detach). */
  dropSession(client: C, sessionId: string): void {
    const f = this.clients.get(client);
    if (!f) return;
    const gone = new Set<string>([sessionId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [id, r] of f.routes) if (gone.has(r.parent) && !gone.has(id)) gone.add(id), (grew = true);
    }
    for (const id of gone) {
      f.routes.delete(id);
      f.auto.delete(id);
    }
  }

  /** The tab's debugger session ended (closed, detached, cancelled): Chrome's children went with it. */
  dropTab(tabId: number): FrameOut<C>[] {
    const out = this.dropRoutes((r) => r.tabId === tabId);
    this.tabs.delete(tabId);
    return out;
  }

  dropClient(client: C): void {
    this.clients.delete(client);
  }

  clear(): void {
    this.tabs.clear();
    this.clients.clear();
  }

  /** Remove matching routes, telling each client its child detached, on the parent's session unless the parent leaves too. */
  private dropRoutes(match: (r: FrameRoute) => boolean): FrameOut<C>[] {
    const out: FrameOut<C>[] = [];
    for (const [client, f] of this.clients) {
      const gone = [...f.routes].filter(([, r]) => match(r));
      const ids = new Set(gone.map(([id]) => id));
      for (const [id, r] of gone) {
        f.routes.delete(id);
        f.auto.delete(id);
        if (ids.has(r.parent)) continue;
        const targetId = this.tabs.get(r.tabId)?.get(r.chrome)?.targetInfo.targetId;
        out.push({ client, msg: { method: "Target.detachedFromTarget", params: { sessionId: id, ...(typeof targetId === "string" ? { targetId } : {}) }, sessionId: r.parent } });
      }
    }
    return out;
  }
}
