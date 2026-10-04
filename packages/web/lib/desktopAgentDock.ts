import { bridge, isElectron } from "./desktop";

// ---------------------------------------------------------------------------
// The agent dock (desktop shell: main.js "The agent dock", agentDock.js).
//
// A pill on the screen's edge with one dot per live agent, and beside it a
// card for whichever one needs you. Opt-in PER MACHINE, kept in the shell's
// settings.json: a dock is a fixture of one screen.
//
// Everything rides the bridge's generic app channel (`call` / `subscribe`,
// "app:agentDock.*" on the wire), so the web half needs no preload surface of
// its own. On a shell older than the dock `call` rejects, which reads as "not
// supported" and the setting is simply not offered.
// ---------------------------------------------------------------------------

export type AgentDockEdge = "left" | "right";
export type AgentDockConfig = { enabled: boolean; edge: AgentDockEdge; offset: number; minimized: boolean; supported: boolean };

function call<T>(name: string, ...args: unknown[]): Promise<T | null> {
  const fn = bridge("call");
  if (!fn) return Promise.resolve(null);
  return fn<T>(`agentDock.${name}`, ...args).catch(() => null);
}

export function getAgentDock(): Promise<AgentDockConfig | null> {
  if (!isElectron()) return Promise.resolve(null);
  return call<AgentDockConfig>("get");
}

export function setAgentDock(patch: Partial<Pick<AgentDockConfig, "enabled" | "edge" | "offset" | "minimized">>): Promise<AgentDockConfig | null> {
  return call<AgentDockConfig>("set", patch);
}

// The see-through switches (registerSeeThroughIpc): take the mouse only over
// the pill and the card, and stay exactly as big as they are.
export const agentDockInteractive = (on: boolean) => void call("interactive", on);
export const agentDockContentSize = (size: { width: number; height: number }) => void call("content-size", size);
export const agentDockFocus = (on: boolean) => void call("focus", on);
export const agentDockOpen = (navPath: string) => void call("open", navPath);
/** The system's region picker; a PNG data URL, or null when cancelled. */
export const agentDockCapture = () => call<string>("capture");

/** The dock's global shortcut was pressed. Returns the unsubscribe. */
export function onAgentDockSummon(cb: () => void): () => void {
  return bridge("subscribe")?.("agentDock.summon", () => cb()) ?? (() => {});
}

/** The setting changed (Settings → Desktop). Returns the unsubscribe. */
export function onAgentDockConfig(cb: (cfg: AgentDockConfig) => void): () => void {
  return bridge("subscribe")?.("agentDock.config", (cfg) => cb({ ...(cfg as AgentDockConfig), supported: true })) ?? (() => {});
}

/** The floating new-session popup, the one the newSession shortcut opens. */
export const agentDockCompose = () => void call("compose");
