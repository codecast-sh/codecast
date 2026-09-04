const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const port = readArg("--port", "9333");
const targetMatch = readArg("--target", "codecast.sh");
const settleMs = Number(readArg("--settle-ms", "5000"));
const output = readArg("--output", "/tmp/codecast-boot-profile.json");
const screenshot = readArg("--screenshot", "");
const offline = args.includes("--offline");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes(targetMatch));
if (!target?.webSocketDebuggerUrl) throw new Error(`No page matching ${targetMatch} on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const listeners = new Map();
const consoleMessages = [];
let nextId = 1;

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    consoleMessages.push({
      level: message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
      at: message.params.timestamp,
    });
  } else if (message.method === "Runtime.exceptionThrown") {
    consoleMessages.push({
      level: "exception",
      text: message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "",
      at: message.params.timestamp,
    });
  }
  const waiting = listeners.get(message.method);
  if (!waiting?.length) return;
  listeners.delete(message.method);
  for (const resolve of waiting) resolve(message.params);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const once = (method) =>
  new Promise((resolve) => listeners.set(method, [...(listeners.get(method) ?? []), resolve]));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

const probeSource = `(() => {
  const profile = window.__codecastBootProfile = { states: [], marks: {} };
  let last = "";
  let loaderWasGone = false;
  const mark = (name, condition, now) => {
    if (condition && profile.marks[name] == null) profile.marks[name] = now;
  };
  const read = () => {
    const now = performance.now();
    const root = document.getElementById("root");
    const rootText = root?.textContent || "";
    const rootCommitted = !!root?.firstElementChild;
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const visibleLoaders = [...(root?.querySelectorAll(".app-loader-bar") || [])].filter(visible);
    const reactLoader = visibleLoaders.length > 0;
    const sessionRows = root?.querySelectorAll("[data-session-id]").length || 0;
    const messageRows = root?.querySelectorAll("[data-cc-message]").length || 0;
    const composer = !!root?.querySelector('textarea[placeholder="Send a message..."]');
    const shell = rootText.includes("Inbox") && rootText.includes("Projects");
    const useful = shell && (sessionRows > 0 || composer);
    const staticBoot = document.getElementById("boot-shell");
    const staticBootVisible = visible(staticBoot);
    mark("rootCommit", rootCommitted, now);
    mark("shell", shell, now);
    mark("cachedContent", useful, now);
    mark("conversationRows", messageRows > 0, now);
    mark("conversationContent", composer, now);
    const loaderGone = rootCommitted && !reactLoader && !staticBootVisible;
    mark("loaderGone", loaderGone, now);
    if (loaderGone) loaderWasGone = true;
    mark("loaderReappeared", loaderWasGone && reactLoader, now);
    const loaderContexts = visibleLoaders.map((loader) => {
      const status = loader.closest('[role="status"]');
      return {
        label: status?.getAttribute("aria-label") || "",
        className: status?.className || "",
        parentClassName: status?.parentElement?.className || "",
      };
    });
    const state = { at: now, rootCommitted, staticBootVisible, reactLoader, loaderContexts, shell, useful, composer, sessionRows, messageRows, textLength: rootText.length };
    const key = JSON.stringify(Object.values(state).slice(1));
    if (key !== last) {
      last = key;
      profile.states.push(state);
    }
  };
  new MutationObserver(() => requestAnimationFrame(read)).observe(document, { subtree: true, childList: true, attributes: true });
  addEventListener("DOMContentLoaded", read, { once: true });
  addEventListener("load", read, { once: true });
  let frames = 0;
  const sample = () => {
    read();
    if (++frames < 600) requestAnimationFrame(sample);
  };
  const timer = setInterval(read, 8);
  setTimeout(() => clearInterval(timer), 10_000);
  requestAnimationFrame(sample);
})()`;

const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: probeSource });
await send("Page.bringToFront");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
if (offline) {
  await send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
} else {
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
}

const loaded = once("Page.loadEventFired");
await send("Page.reload", { ignoreCache: false });
let timeout;
await Promise.race([
  loaded,
  new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for Page.loadEventFired")), 30_000);
  }),
]);
clearTimeout(timeout);
await delay(settleMs);

const evaluated = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    url: location.href,
    title: document.title,
    visibility: document.visibilityState,
    navigation: performance.getEntriesByType("navigation")[0],
    paints: performance.getEntriesByType("paint"),
    profile: window.__codecastBootProfile,
    rootTextLength: document.getElementById("root")?.textContent?.length || 0,
    sessionRows: document.querySelectorAll("[data-session-id]").length,
    loaderVisible: [...document.querySelectorAll("#root .app-loader-bar")].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    }),
    authStorageKeys: Object.keys(localStorage).filter((key) => key.startsWith("__convexAuth")),
    hasStoredAuthJwt: Object.keys(localStorage).some((key) => key.startsWith("__convexAuthJWT") && localStorage.getItem(key))
  })`,
  returnByValue: true,
});
const page = JSON.parse(evaluated.result.value);

if (screenshot) {
  const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await Bun.write(screenshot, Buffer.from(capture.data, "base64"));
}

if (offline) {
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
}
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
socket.close();

const result = {
  output,
  screenshot: screenshot || undefined,
  offline,
  measuredAt: new Date().toISOString(),
  page,
  console: consoleMessages,
};
await Bun.write(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
