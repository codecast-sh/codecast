// Pure logic for the agent dock: the pill on the screen's edge that shows one
// dot per live agent and opens a card for whichever needs you. Kept free of
// electron imports so it is unit-testable (agentDock.test.js); main.js owns
// the window and the I/O.
//
// The setting is PER MACHINE (settings.json), like meeting detection: a dock
// is a fixture of one screen. It is off until this machine turns it on: the
// dock is unreleased, and the web side (AGENT_DOCK_RELEASED in
// lib/desktopAgentDock.ts) decides whether it is offered at all.

const DEFAULT_AGENT_DOCK = { enabled: false, edge: "right", offset: 0.28, minimized: false };

// Persisted `agentDock` (may be undefined or hand-edited) → the effective
// setting. Unknown keys are dropped so a stale field cannot ride along.
function mergeAgentDock(persisted) {
  const p = persisted && typeof persisted === "object" ? persisted : {};
  const edge = p.edge === "left" ? "left" : "right";
  const offset = Number.isFinite(p.offset) ? Math.min(0.9, Math.max(0, p.offset)) : DEFAULT_AGENT_DOCK.offset;
  return { enabled: p.enabled === true, edge, offset, minimized: p.minimized === true };
}

// Where the window goes on a display: flush against the chosen edge, its top
// at `offset` of the work area's height, and never off the bottom. The window
// is the pill plus whatever card is open beside it, so it grows AWAY from the
// edge; the pill's side stays put.
function placeAgentDock(area, size, setting) {
  const width = Math.min(Math.round(size.width), area.width);
  const height = Math.min(Math.round(size.height), area.height);
  const x = setting.edge === "left" ? area.x : area.x + area.width - width;
  const top = area.y + Math.round(area.height * setting.offset);
  const y = Math.max(area.y, Math.min(top, area.y + area.height - height));
  return { x, y, width, height };
}

module.exports = { DEFAULT_AGENT_DOCK, mergeAgentDock, placeAgentDock };
