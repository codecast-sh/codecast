/**
 * The in-page half of the bridge, injected by the worker (chrome.scripting,
 * top frame only) into tabs agents use, never into the human's other tabs.
 * Runs in this extension's isolated world: a page cannot read its variables,
 * wrap its functions or see its listeners.
 *
 * Two jobs, keyed on the state the worker sends:
 *
 * - "running": an agent holds the tab. Other extensions' injected frames and
 *   password-manager hosts make Chrome refuse debugger commands ("Cannot
 *   access a chrome-extension:// URL of different extension") or drop the
 *   session, so they are removed now and as they reappear.
 *
 * - "waiting": an agent handed the page to the human (a sign-in, a 2FA code,
 *   a payment). A card says what to do, with one Continue button. Nothing is
 *   evicted then, so the human's password manager works. The card lives in a
 *   closed shadow root on an element with no id, class or data attribute, in
 *   the top layer (a manual popover), and is put back when the page removes,
 *   hides or restyles it. Only a click the browser marks isTrusted completes
 *   the handoff: a page can neither reach the button nor forge the click.
 *
 * Any other state removes everything this script added.
 */
(() => {
  if (globalThis.__castPage) return;
  globalThis.__castPage = true;

  let state = { state: "idle" };
  let host = null;
  let root = null;
  let observer = null;
  let completing = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.op === "page-state") {
      state = msg.status || { state: "idle" };
      completing = null;
      render();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.op === "evict") {
      sendResponse({ removed: state.state === "waiting" ? 0 : evict(document) });
      return false;
    }
    return false;
  });
  // A navigation reloaded this script: ask what the tab is doing now.
  chrome.runtime.sendMessage({ op: "page-ready" }).catch(() => {});

  function render() {
    if (state.state === "waiting" && state.handoff) showCard();
    else removeCard();
    if (state.state === "running") evict(document);
    watch();
  }

  /** One observer for both jobs; it sees only this world's view and the page cannot disconnect it. */
  function watch() {
    const needed = state.state === "running" || (state.state === "waiting" && host);
    if (!needed) {
      if (observer) observer.disconnect();
      observer = null;
      return;
    }
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      if (state.state === "running") evict(document);
      else if (state.state === "waiting" && host) raise();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "popover", "open"] });
  }

  // ------------------------------------------------------------ eviction

  /**
   * Removes other extensions' frames and password-manager hosts from the
   * document and the open shadow roots inside it. 1Password keeps its UI in
   * closed shadow roots under its own custom elements, so the host goes.
   */
  function evict(start) {
    const own = `chrome-extension://${chrome.runtime.id}`;
    const foreign = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag.startsWith("com-1password-") || el.hasAttribute("data-onepassword-extension") || el.hasAttribute("data-lastpass-root") || (el.id || "").startsWith("bitwarden-")) return true;
      if (tag !== "iframe" && tag !== "frame" && tag !== "object" && tag !== "embed") return false;
      const src = el.getAttribute("src") || el.getAttribute("data") || "";
      return /^chrome-extension:\/\//i.test(src) && !src.startsWith(own);
    };
    let removed = 0;
    const visit = (node) => {
      for (const el of Array.from(node.querySelectorAll("*"))) {
        if (el === host || !node.contains(el)) continue;
        if (foreign(el)) {
          el.remove();
          removed++;
        } else if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (start && start.querySelectorAll) visit(start);
    return removed;
  }

  // ---------------------------------------------------------------- card

  function showCard() {
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", render, { once: true });
      return;
    }
    if (!host) create();
    root.getElementById("message").textContent = state.handoff.text || "Finish this step, then continue.";
    root.getElementById("origin").textContent = location.host || location.href;
    const button = root.getElementById("continue");
    const busy = completing === state.handoff.id;
    button.disabled = busy;
    button.textContent = busy ? "Continuing" : "Continue";
    raise();
  }

  function removeCard() {
    if (host) host.remove();
    host = null;
    root = null;
  }

  /** Back in the document and the top layer, with nothing the page set on it. */
  function raise() {
    if (!host || !document.documentElement) return;
    for (const name of host.getAttributeNames()) if (name !== "popover") host.removeAttribute(name);
    if (host.getAttribute("popover") !== "manual") host.setAttribute("popover", "manual");
    if (host.parentNode !== document.documentElement) document.documentElement.append(host);
    try {
      if (!host.matches(":popover-open")) host.showPopover();
    } catch {
      // A modal dialog can refuse the top layer; the card still sits above the page.
    }
  }

  function create() {
    host = document.createElement("div");
    host.setAttribute("popover", "manual");
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style>
      <div id="card" role="dialog" aria-labelledby="title" aria-describedby="message">
        <div id="head"><span id="dot"></span><span id="title">Your turn</span><span id="from">codecast</span></div>
        <p id="message"></p>
        <div id="foot"><span id="origin"></span><button id="continue" type="button">Continue</button></div>
      </div>`;
    root.getElementById("continue").addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const id = state.handoff && state.handoff.id;
      if (!id || completing === id) return;
      completing = id;
      showCard();
      chrome.runtime.sendMessage({ op: "handoff-done", id }).catch(() => {
        completing = null;
        showCard();
      });
    });
    // The page can close the popover (hidePopover); open it again while the handoff waits.
    host.addEventListener("toggle", () => {
      if (state.state === "waiting" && host) setTimeout(raise, 0);
    });
  }

  const STYLE = `
    :host { all: initial !important; position: fixed !important; inset: auto 16px 16px auto !important; margin: 0 !important;
      padding: 0 !important; border: 0 !important; background: transparent !important; overflow: visible !important;
      display: block !important; visibility: visible !important; opacity: 1 !important; transform: none !important;
      width: auto !important; height: auto !important; max-width: none !important; max-height: none !important; z-index: 2147483647 !important; }
    #card { box-sizing: border-box; width: 320px; padding: 14px 16px 14px; border-radius: 12px;
      background: #fffdf9; color: #1d1b18; border: 1px solid #e7e0d6;
      box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 18px 40px -16px rgba(40,30,20,.35);
      font: 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    #dot { width: 8px; height: 8px; border-radius: 50%; background: #e2553d; box-shadow: 0 0 0 3px rgba(226,85,61,.18); }
    #from { margin-left: auto; font-weight: 500; font-size: 11px; color: #8a8178; }
    #message { margin: 8px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    #foot { display: flex; align-items: center; gap: 10px; }
    #origin { flex: 1; min-width: 0; font-size: 11px; color: #8a8178; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 8px; background: #e2553d; color: #fff; font-weight: 600; font-size: 12.5px; }
    button:hover { background: #cf4630; }
    button:focus-visible { outline: 2px solid #1d1b18; outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    @media (prefers-color-scheme: dark) {
      #card { background: #1f1d1a; color: #f1ece4; border-color: #3a352f; }
      #from, #origin { color: #a39a8f; }
      button:focus-visible { outline-color: #f1ece4; }
    }`;
})();
