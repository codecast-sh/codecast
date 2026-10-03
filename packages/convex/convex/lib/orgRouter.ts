// The semantic router (docs/architecture/org-staffing.md S35): when the
// routing rule reaches line 4 (no name, no task, no plan, no project), one
// model call reads the request against the workspace's roles and proposes
// the owner with its reason. It files only when confident; otherwise the
// caller gets the top choices. The request builder is exported so the evals
// replay the bytes prod posts (`./evals check route`).

import { CHEAP_MODEL, parseJsonBlock, type SurfaceRequest } from "./anthropic";

/** One role as the router reads it: who it is, what it is for, what it holds. */
export type RouterRole = {
  handle: string;
  name: string;
  given_name?: string;
  charter?: string;
  /** Project and plan titles with their goals, as the scope lists them. */
  areas: Array<{ kind: "project" | "plan"; title: string; goal?: string }>;
  /** The dated lines under the brief's "Where it stands", newest first. */
  standing: string[];
  /** Titles of what it holds now (sessions and open tasks), newest first. */
  holding: string[];
  /** The Head of People, which looks after what no narrower role covers. */
  whole_workspace?: boolean;
};

export type RouterRoster = {
  /** The workspace's name, so the model knows whose company this is. */
  workspace: string;
  roles: RouterRole[];
};

export type RouterReply = {
  handle: string | null;
  confidence: number;
  reason: string;
  alternatives: Array<{ handle: string; confidence: number; reason: string }>;
};

export const ROUTER_MODEL = CHEAP_MODEL;
export const ROUTER_MAX_TOKENS = 400;
/** Filing needs this much confidence, and the runner-up this far below (S35). */
export const ROUTER_CONFIDENT = 0.8;
export const ROUTER_MARGIN = 0.3;
const CHARTER_CHARS = 600;
const LINES_PER_ROLE = 6;

export const ROUTER_SYSTEM = `You place one incoming request with the role in a company of agents whose charter and current work it belongs to.

Read every role: its charter says what it is for, its areas say which projects and plans it looks after, "where it stands" says what it is doing now, and "holding" says what it has in hand. Name the one role the request belongs to. Say why in one sentence that cites the charter, an area or a line of current work, in the roster's own words. Say how sure you are as a number from 0 to 1: high only when one role's charter or area plainly covers the request and no other role's does; lower when two roles could each claim it, or when the request is vague.

A request that no role's charter or area covers belongs to the role marked as looking after the whole workspace, when there is one, with a low confidence; when there is none, name no role. Never invent a handle: use only handles from the roster.

Answer with JSON only, in this shape:
{"handle": "<handle or null>", "confidence": <0..1>, "reason": "<one sentence>", "alternatives": [{"handle": "<handle>", "confidence": <0..1>, "reason": "<one sentence>"}]}
List up to two alternatives, the next most plausible roles with how sure you are of each, or none.`;

const clip = (s: string | undefined, max: number) => {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

export function rosterText(roster: RouterRoster): string {
  const lines: string[] = [`Workspace: ${roster.workspace}`, ""];
  for (const r of roster.roles) {
    lines.push(`## @${r.handle}: ${r.given_name ? `${r.given_name}, ` : ""}${r.name}${r.whole_workspace ? " (looks after the whole workspace: whatever no narrower role covers)" : ""}`);
    if (r.charter) lines.push(`Charter: ${clip(r.charter, CHARTER_CHARS)}`);
    if (r.areas.length) lines.push(`Areas: ${r.areas.map((a) => `${a.kind} "${a.title}"${a.goal ? ` (goal: ${clip(a.goal, 160)})` : ""}`).join("; ")}`);
    else if (!r.whole_workspace) lines.push("Areas: none (a standing role that answers what it is asked)");
    if (r.standing.length) lines.push(`Where it stands: ${r.standing.slice(0, LINES_PER_ROLE).map((l) => clip(l, 200)).join(" | ")}`);
    if (r.holding.length) lines.push(`Holding: ${r.holding.slice(0, LINES_PER_ROLE).map((l) => clip(l, 120)).join(" | ")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function routerRequest(roster: RouterRoster, request: string): SurfaceRequest {
  return {
    model: ROUTER_MODEL,
    max_tokens: ROUTER_MAX_TOKENS,
    system: ROUTER_SYSTEM,
    prompt: `${rosterText(roster)}\n\n---\n\nThe request:\n\n${request.trim()}`,
  };
}

/** The reply as JSON, with every handle checked against the roster; null when unreadable. */
export function parseRouterReply(text: string, roster: RouterRoster): RouterReply | null {
  const raw = parseJsonBlock(text) as any;
  if (!raw || typeof raw !== "object") return null;
  const handles = new Set(roster.roles.map((r) => r.handle));
  const clean = (h: unknown): string | null => {
    const s = typeof h === "string" ? h.trim().replace(/^@/, "").toLowerCase() : "";
    return handles.has(s) ? s : null;
  };
  const conf = (c: unknown): number => { const n = typeof c === "number" ? c : Number(c); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
  const handle = clean(raw.handle);
  const alternatives = Array.isArray(raw.alternatives)
    ? raw.alternatives
        .map((a: any) => ({ handle: clean(a?.handle), confidence: conf(a?.confidence), reason: typeof a?.reason === "string" ? a.reason.trim() : "" }))
        .filter((a: any): a is RouterReply["alternatives"][number] => !!a.handle && a.handle !== handle)
        .sort((a: any, b: any) => b.confidence - a.confidence)
    : [];
  return { handle, confidence: handle ? conf(raw.confidence) : 0, reason: typeof raw.reason === "string" ? raw.reason.trim() : "", alternatives: alternatives.slice(0, 2) };
}

export type RouterDecision =
  | { kind: "file"; handle: string; confidence: number; reason: string }
  | { kind: "ask"; choices: Array<{ handle: string; confidence: number; reason: string }>; confidence: number; reason: string };

/** Files when the top choice is confident and clear of the runner-up (S35); otherwise the choices, best first. */
export function routerDecision(reply: RouterReply | null): RouterDecision {
  if (!reply || !reply.handle) return { kind: "ask", choices: reply?.alternatives ?? [], confidence: 0, reason: reply?.reason || "the router could not read the request" };
  const runnerUp = reply.alternatives[0]?.confidence ?? 0;
  // 1e-9: 0.9 - 0.6 is 0.30000000000000004 in floating point, which is the margin.
  if (reply.confidence >= ROUTER_CONFIDENT - 1e-9 && reply.confidence - runnerUp >= ROUTER_MARGIN - 1e-9) {
    return { kind: "file", handle: reply.handle, confidence: reply.confidence, reason: reply.reason };
  }
  return { kind: "ask", choices: [{ handle: reply.handle, confidence: reply.confidence, reason: reply.reason }, ...reply.alternatives], confidence: reply.confidence, reason: reply.reason };
}
