// Single source of truth for translating a conversation's convex agent_type
// spelling into the daemon-side client id it must launch/resume with.
//
// The convex schema stores agent_type as one of
// "claude_code" | "codex" | "cursor" | "gemini" | "cowork" (convex/schema.ts),
// while the daemon speaks a narrower set: it launches/resumes claude, codex,
// cursor, or gemini. Every mutation that enqueues a resume_session /
// start_session / move_to_device command must map convex -> daemon the same
// way, or a real agent (cursor) silently launches as claude. Before this
// helper the mapping was an inline ternary duplicated across users.ts,
// devices.ts, dispatch.ts and conversations.ts, and several copies had drifted
// to a 2-branch codex/gemini form that collapsed "cursor" to "claude".
//
// Rule: only codex/cursor/gemini map to themselves; everything else
// (claude_code, cowork, undefined, or any future/unknown value) maps to claude.
// This matches the daemon's own fall-through (daemon.ts start_session/
// resume_session parse to codex/cursor/gemini else default claude), so an older
// daemon that predates cursor support treats a "cursor" payload as unknown ->
// claude, i.e. no worse than the pre-fix behavior.
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon,
// and the browser.
export const AGENT_CLIENT_IDS = ["claude", "codex", "cursor", "gemini"] as const;

export type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];

export function fromConvexAgentType(agentType: string | null | undefined): AgentClientId {
  return agentType === "codex" || agentType === "cursor" || agentType === "gemini"
    ? agentType
    : "claude";
}
