/**
 * The connection as a person reads it, shared by the options page and the
 * toolbar popup so the two never describe one state in two ways. The worker
 * reports a state name and the tabs it holds; this turns that into a class
 * for the dot, a title, and one sentence that says what is true and, when
 * something is needed, the one command that provides it.
 */
const CAST_DEFAULT_PORT = 41729;

/** Hex for chrome.tabGroups.Color, matched by eye to Chrome's own group swatches. */
const GROUP_COLOR_HEX = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
};

function describeBridge(s, port) {
  const n = s.attached ? s.attached.length : 0;
  const driving = n ? `Driving ${n} tab${n === 1 ? "" : "s"} right now.` : "";
  switch (s.state) {
    case "connected":
      return { cls: "state-ok", title: "Connected", text: `Paired with cast on port ${port}. ${driving || "Agents can open tabs here when a session asks for your Chrome."}` };
    case "connecting":
    case "disconnected":
      return { cls: "state-wait", title: "Waiting for cast", text: `Paired. The bridge host on port ${port} starts with the next cast browser command in real mode.` };
    case "bad-token":
      return { cls: "state-bad", title: "Token rejected", text: "This pairing is stale. Run cast browser extension setup again; it hands this page the current token." };
    default:
      return { cls: "state-none", title: "Not paired", text: "Run cast browser extension setup in a terminal on this machine. It opens this page with the token filled in." };
  }
}

/** Ask the worker; a silent worker is itself a state worth showing. */
async function readBridgeStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ op: "status" });
    if (s) return s;
  } catch {}
  return { state: "dead", attached: [] };
}

/** Paint one status block: a root with the state class, #dot, #state-title, #state-text. */
function renderBridgeStatus(root, s, port) {
  const d = s.state === "dead"
    ? { cls: "state-bad", title: "Extension asleep", text: "The service worker is not answering. Reload the extension from chrome://extensions." }
    : describeBridge(s, port);
  root.classList.remove("state-ok", "state-wait", "state-bad", "state-none");
  root.classList.add(d.cls);
  root.querySelector("[data-title]").textContent = d.title;
  root.querySelector("[data-text]").textContent = d.text;
  return d;
}
