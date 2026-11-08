/**
 * Seeded fuzzer for the `cast browser` bridge host: its HTTP routes, its CDP
 * WebSocket face and the extension socket, run against ONE rig.
 *
 * The bridge is the one process every client of the human's Chrome goes
 * through, so this checks what it must never do, whatever it is sent:
 *
 *   - crash or wedge (the host pid stays the same and /healthz answers after
 *     every batch);
 *   - answer an unauthenticated or foreign-Host request with data;
 *   - let a refused method through (cookie and cache wipes, browser close,
 *     permission changes, navigation to file:/chrome:/devtools: pages), by any
 *     spelling, wrapper or smuggled parameter;
 *   - hand a client cookies of a host none of its tabs is on;
 *   - let one client drive a tab through another client's session id;
 *   - accept an extension socket that never proved the key.
 *
 * Refusals are judged by the bridge's answer AND by an oracle outside it: the
 * rig Chrome's own DevTools socket, which sees the real cookie jar and the
 * real tab list whatever the bridge claimed.
 *
 * Usage (rig first: bun packages/cli/scripts/browser-rig.ts up --fixtures --name <n>):
 *   bun packages/cli/scripts/browser-stress/fuzz.ts --rig <n> [--seed 7] [--rounds 400] [--max-load 300] [--force]
 * Exit 0 when every invariant held; 1 with the violations listed (also in
 * the run directory it prints, replayable with the same --seed).
 */

import { args, CdpClient, CdpError, checkLoad, die, oneLine, requireRig, Rng, rigBridge, RunLog, sleep, alive } from "./lib.ts";

const a = args();
const rig = requireRig(a.opt("rig"));
const seed = a.num("seed", Date.now() % 100_000);
const rounds = a.num("rounds", 400);
checkLoad(a.num("max-load", 300), a.flag("force"));
if (!rig.fixtures) die(`rig "${rig.name}" has no fixtures; bring it up with --fixtures`);
const originA = rig.fixtures[0];
// Cookies are scoped by host, not port, so the second origin goes through
// localhost when the rig serves both fixtures on 127.0.0.1.
const originB = (() => {
  const b = new URL(rig.fixtures[1]);
  if (b.hostname === new URL(originA).hostname) b.hostname = b.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return b.origin;
})();
const hostA = new URL(originA).hostname;
const hostB = new URL(originB).hostname;

const rng = new Rng(seed);
const log = new RunLog("fuzz", seed);
const violations: string[] = [];
const violate = (what: string, detail: Record<string, unknown> = {}) => {
  violations.push(what);
  log.write("violations.jsonl", { what, ...detail });
  console.log(`  VIOLATION ${what}`);
};

const bridge = () => rigBridge(rig);
const base = () => `http://127.0.0.1:${bridge().port}`;
const startPid = bridge().hostPid;

// ---------------------------------------------------------------------------
// Liveness: the host must survive every batch
// ---------------------------------------------------------------------------

async function hostAlive(after: string): Promise<boolean> {
  const pid = bridge().hostPid;
  if (startPid && pid !== startPid) {
    violate(`host restarted during ${after} (pid ${startPid} -> ${pid})`);
    return false;
  }
  if (pid && !alive(pid)) {
    violate(`host pid ${pid} died during ${after}`);
    return false;
  }
  try {
    const r = await fetch(`${base()}/healthz`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok || !(await r.text()).startsWith("cast-bridge")) throw new Error(`status ${r.status}`);
    return true;
  } catch (e) {
    violate(`host stopped answering /healthz after ${after}: ${(e as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const ROUTES = ["/json", "/json/list", "/json/version", "/json/new", "/json/close/x", "/status", "/grant", "/retire", "/reload", "/tokens", "/pair", "/ext", "/devtools/browser", "/", "/healthz/../status", "/%2e%2e/status", "//status", "/status/", "/STATUS"];
const FOREIGN_HOSTS = ["evil.example", "evil.example:" + 0, "127.0.0.1.evil.example", "localhost.evil.example", "[::1]:1", "0.0.0.0", "127.0.0.2", "", "127.0.0.1:1"];

function junk(r: Rng, max = 64): string {
  // Whole code points: half a surrogate pair is not a string a client can send.
  const alphabet = Array.from("abcdefABCDEF0123456789-_.~%/?#&=:;@!$'()*+, \t\n\u0000\u00ff\u2028\u{1F600}");
  let s = "";
  const n = r.int(max);
  for (let i = 0; i < n; i++) s += alphabet[r.int(alphabet.length)];
  return s;
}

/** Ways to spell a URL whose scheme a tab must never reach. */
function blockedUrls(r: Rng): string[] {
  const schemes = ["file", "chrome", "chrome-extension", "chrome-untrusted", "devtools", "view-source"];
  const s = r.pick(schemes);
  const tail = s === "file" ? "///etc/hosts" : s === "view-source" ? `:${originA}` : "://settings";
  const mid = (str: string) => {
    const i = 1 + r.int(Math.max(1, str.length - 1));
    return str.slice(0, i) + r.pick(["\t", "\n", "\r"]) + str.slice(i);
  };
  const upper = s.toUpperCase();
  return [
    `${s}:${tail.replace(/^:/, "")}`,
    `${upper}:${tail.replace(/^:/, "")}`,
    ` \t${s}:${tail.replace(/^:/, "")}`,
    `${mid(s)}:${tail.replace(/^:/, "")}`, // the URL parser strips tab/newline anywhere
    `\u0000${s}:${tail.replace(/^:/, "")}`,
    `${s}\t:${tail.replace(/^:/, "")}`,
    `\u001f${s}:${tail.replace(/^:/, "")}`, // C0 controls and spaces are trimmed from the ends
  ];
}

/** Every spelling of a refused method we can think of, plus wrappers that would carry it. */
const WIPES = ["Network.clearBrowserCookies", "Storage.clearCookies", "Network.clearBrowserCache", "Storage.clearDataForOrigin"];

// ---------------------------------------------------------------------------
// Oracle: the rig Chrome itself
// ---------------------------------------------------------------------------

let oracle: CdpClient;
async function jar(): Promise<Array<{ name: string; domain: string }>> {
  const r = await oracle.send("Storage.getCookies", {});
  return r.cookies ?? [];
}
const onHost = (cookies: Array<{ domain: string }>, host: string) => cookies.filter((c) => c.domain.replace(/^\./, "") === host);

async function chromeTabs(): Promise<string[]> {
  const r = await oracle.send("Target.getTargets", {});
  return (r.targetInfos ?? []).filter((t: any) => t.type === "page").map((t: any) => String(t.url));
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function fuzzHttp(r: Rng, n: number): Promise<void> {
  const { token } = bridge();
  for (let i = 0; i < n; i++) {
    const route = r.chance(0.8) ? r.pick(ROUTES) : `/${junk(r, 24)}`;
    const tokenCase = r.int(6);
    const presented =
      tokenCase === 0 ? "" : tokenCase === 1 ? junk(r, 40) : tokenCase === 2 ? token.slice(0, -1) : tokenCase === 3 ? token.toUpperCase() : tokenCase === 4 ? `${token} ` : token;
    const foreign = r.chance(0.5);
    const hostHeader = foreign ? r.pick(FOREIGN_HOSTS) : `127.0.0.1:${bridge().port}`;
    const qs = presented ? `?token=${encodeURIComponent(presented)}${r.chance(0.3) ? `&token=${encodeURIComponent(junk(r, 8))}` : ""}` : r.chance(0.3) ? `?${junk(r, 30)}` : "";
    const method = r.pick(["GET", "GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"]);
    const headers: Record<string, string> = { host: hostHeader };
    if (r.chance(0.3)) headers.origin = r.pick(["https://evil.example", "null", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", originA]);
    let status = 0;
    let body = "";
    try {
      const res = await fetch(`${base()}${route}${qs}`, {
        method,
        headers,
        body: method === "POST" || method === "PUT" ? (r.chance(0.5) ? junk(r, 2000) : JSON.stringify({ tabId: r.int(1e9), session: junk(r, 10) })) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      body = method === "HEAD" ? "" : await res.text();
    } catch (e) {
      // A refused connection or a reset is a fine answer; a hang is not.
      if ((e as Error).name === "TimeoutError") violate(`HTTP ${method} ${route} hung 15s`, { hostHeader });
      continue;
    }
    const authed = presented === token && !foreign;
    const isHealth = route === "/healthz";
    if (!authed && !isHealth && status >= 200 && status < 300) {
      violate(`HTTP ${method} ${oneLine(route, 60)} answered ${status} without a valid token and loopback Host`, {
        tokenCase, hostHeader, body: oneLine(body, 200),
      });
    }
    if (!authed && body.includes(token)) violate(`HTTP ${method} ${oneLine(route, 60)} leaked the token in its body`, { tokenCase, hostHeader });
  }
}

async function fuzzExtensionSocket(r: Rng, n: number): Promise<void> {
  const { port } = bridge();
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { origin: "chrome-extension://odfpgkdaibmjhhnbndgbjlhdbciciifd" } } as any);
    const welcomed = await new Promise<boolean>((resolve) => {
      let accepted = false;
      const done = () => resolve(accepted);
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        done();
      }, 4_000);
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data));
          if (m?.op === "welcome") accepted = true;
        } catch {}
      };
      ws.onclose = () => {
        clearTimeout(t);
        done();
      };
      ws.onopen = () => {
        const kind = r.int(6);
        const frames =
          kind === 0 ? [junk(r, 300)]
          : kind === 1 ? ["x".repeat(256 * 1024)]
          : kind === 2 ? [JSON.stringify({ op: "hello", protocol: r.int(10), proof: junk(r, 64), nonce: junk(r, 32), version: "9.9.9" })]
          : kind === 3 ? [JSON.stringify({ op: "hello", key: junk(r, 40), profile: "../../etc", proof: "0".repeat(64) })]
          : kind === 4 ? [JSON.stringify({ op: "pair", code: `${junk(r, 4)}-${junk(r, 4)}` })]
          : Array.from({ length: 50 }, () => JSON.stringify({ op: r.pick(["cdp", "event", "tabs", "result"]), id: r.int(1e6), tabId: r.int(1e9), method: r.pick(WIPES), params: {} }));
        for (const f of frames) {
          try {
            ws.send(f);
          } catch {}
        }
      };
    });
    if (welcomed) violate("extension socket got a welcome without proving the key");
  }
  // Many unproven sockets at once must be capped, and must not lock out the real extension.
  const flood = Array.from({ length: 40 }, () => new WebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { origin: "chrome-extension://odfpgkdaibmjhhnbndgbjlhdbciciifd" } } as any));
  await sleep(2_000);
  for (const w of flood) {
    try {
      w.close();
    } catch {}
  }
}

interface Agent {
  c: CdpClient;
  session: string;
  targetId: string;
  sessionId: string;
}

async function agentOn(origin: string, label: string): Promise<Agent> {
  const { port, token } = bridge();
  const session = `fuzz-${label}-${seed}`;
  const c = await CdpClient.bridge(port, token, session);
  const { targetId } = await c.send("Target.createTarget", { url: `${origin}/cookies.html` }, undefined, 45_000);
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true }, undefined, 45_000);
  await c.send("Page.enable", {}, sessionId).catch(() => {});
  await sleep(1_500);
  return { c, session, targetId, sessionId };
}

async function expectRefused(agent: Agent, method: string, params: unknown, sessionId: string | undefined, label: string): Promise<boolean> {
  try {
    const res = await agent.c.send(method, params, sessionId, 20_000);
    log.write("cdp.jsonl", { label, method, ok: true, res: oneLine(JSON.stringify(res ?? {}), 300) });
    return false;
  } catch (e) {
    log.write("cdp.jsonl", { label, method, ok: false, err: oneLine((e as Error).message, 200) });
    return true;
  }
}

async function fuzzCdp(r: Rng, n: number): Promise<void> {
  const a1 = await agentOn(originA, "a");
  const a2 = await agentOn(originB, "b");
  try {
    const before = await jar();
    if (onHost(before, hostA).length === 0 || onHost(before, hostB).length === 0) {
      die(`the cookie fixture did not set cookies on both hosts (${hostA}: ${onHost(before, hostA).length}, ${hostB}: ${onHost(before, hostB).length})`);
    }

    // 1. Wipes, by every spelling and wrapper. Judged by the jar afterwards.
    for (const m of WIPES) {
      const spellings = [m, m.toLowerCase(), m.toUpperCase(), ` ${m}`, `${m} `, `${m}\u0000`, m.replace(".", ".​"), m.replace(".", "..")];
      for (const s of spellings) {
        for (const sid of [undefined, a1.sessionId]) await expectRefused(a1, s, { origin: originB, storageTypes: "all" }, sid, `wipe ${JSON.stringify(s)}`);
      }
      // The old message-in-a-message channel carries any inner command to a target.
      const inner = JSON.stringify({ id: 1, method: m, params: { origin: originB, storageTypes: "all" } });
      await expectRefused(a1, "Target.sendMessageToTarget", { message: inner, targetId: a1.targetId }, undefined, `wrapped ${m}`);
      await expectRefused(a1, "Target.sendMessageToTarget", { message: inner, sessionId: a1.sessionId }, undefined, `wrapped ${m} by session`);
    }
    await sleep(500);
    const after = await jar();
    if (onHost(after, hostB).length < onHost(before, hostB).length) violate(`a wipe got through: ${hostB} cookies ${onHost(before, hostB).length} -> ${onHost(after, hostB).length}`);
    if (onHost(after, hostA).length < onHost(before, hostA).length) violate(`a wipe got through: ${hostA} cookies ${onHost(before, hostA).length} -> ${onHost(after, hostA).length}`);

    // 2. Cookie reads: a client on host A must never see host B's cookies, however it asks.
    const reads: Array<[string, unknown]> = [
      ["Network.getAllCookies", {}],
      ["Storage.getCookies", {}],
      ["Storage.getCookies", { browserContextId: junk(r, 8) }],
      ["Network.getCookies", {}],
      ["Network.getCookies", { urls: [originB] }],
      ["Network.getCookies", { urls: [`${originA}`, `${originB}/x`] }],
      ["Network.getCookies", { urls: [originB.replace("http://", "HTTP://")] }],
      ["Network.getCookies", { urls: [`${originB}@${hostA}`] }],
      ["Network.getCookies", { urls: [`http://${hostA}@${new URL(originB).host}/`] }],
    ];
    for (const [method, params] of reads) {
      for (const sid of [undefined, a1.sessionId]) {
        try {
          const res = await a1.c.send(method, params, sid, 20_000);
          const leaked = onHost(res?.cookies ?? [], hostB);
          if (leaked.length) violate(`${method} ${JSON.stringify(params)} returned ${leaked.length} cookie(s) of ${hostB} to a client on ${hostA}`);
        } catch {
          /* a refusal is fine */
        }
      }
    }

    // 3. Cookie writes and deletes on the other host.
    await expectRefused(a1, "Network.deleteCookies", { name: "rig_pref", domain: hostB }, a1.sessionId, "delete other host");
    await expectRefused(a1, "Network.deleteCookies", { name: "rig_pref", url: originB }, a1.sessionId, "delete other host by url");
    await expectRefused(a1, "Network.setCookie", { name: "fuzz_planted", value: "1", domain: hostB, path: "/" }, a1.sessionId, "plant on other host");
    await expectRefused(a1, "Storage.setCookies", { cookies: [{ name: "fuzz_planted", value: "1", domain: hostB, path: "/" }] }, undefined, "plant on other host (Storage)");
    const afterWrites = await jar();
    if (onHost(afterWrites, hostB).some((c) => c.name === "fuzz_planted")) violate(`a client on ${hostA} planted a cookie on ${hostB}`);
    if (onHost(afterWrites, hostB).length < onHost(before, hostB).length) violate(`a client on ${hostA} deleted cookies of ${hostB}`);

    // 4. Navigation to blocked schemes, by every spelling, on both faces.
    for (let i = 0; i < Math.max(4, Math.floor(n / 20)); i++) {
      for (const url of blockedUrls(r)) {
        await expectRefused(a1, "Page.navigate", { url }, a1.sessionId, `navigate ${JSON.stringify(url)}`);
        await expectRefused(a1, "Target.createTarget", { url }, undefined, `createTarget ${JSON.stringify(url)}`);
      }
    }
    await sleep(1_000);
    const bad = (await chromeTabs()).filter((u) => /^(file|chrome|chrome-extension|chrome-untrusted|devtools|view-source):/i.test(u) && !u.startsWith("chrome-extension://") && u !== "chrome://newtab/");
    if (bad.length) violate(`a tab reached a blocked page: ${bad.join(", ")}`);

    // 5. Session confusion: client 1 drives client 2's tab through its session id or target id.
    const marker = `fuzz-${seed}-${r.int(1e6)}`;
    const crossCalls: Array<[string, unknown, string | undefined]> = [
      ["Runtime.evaluate", { expression: `document.title = ${JSON.stringify(marker)}` }, a2.sessionId],
      ["Page.navigate", { url: `${originA}/index.html#${marker}` }, a2.sessionId],
      ["Target.attachToTarget", { targetId: a2.targetId, flatten: true }, undefined],
      ["Target.activateTarget", { targetId: a2.targetId }, undefined],
      ["Target.closeTarget", { targetId: a2.targetId }, undefined],
    ];
    for (const [method, params, sid] of crossCalls) {
      try {
        const res = await a1.c.send(method, params, sid, 20_000);
        if (method === "Target.attachToTarget" && res?.sessionId) {
          // Attaching succeeded: the attached session must not reach the tab's page.
          await a1.c.send("Runtime.evaluate", { expression: `document.title = ${JSON.stringify(marker)}` }, res.sessionId, 10_000).catch(() => {});
        }
      } catch {
        /* refused is right */
      }
    }
    await sleep(800);
    // The bridge names tabs with its own target ids, so the oracle finds
    // client 2's tab by the page it was left on.
    const pages = ((await oracle.send("Target.getTargets", {})).targetInfos ?? []).filter((t: any) => t.type === "page");
    if (!pages.some((t: any) => String(t.url).startsWith(`${originB}/cookies.html`))) violate("client 1 closed client 2's tab");
    if (pages.some((t: any) => String(t.url).startsWith(originB) && (String(t.title).includes(marker) || String(t.url).includes(marker)))) violate("client 1 drove client 2's tab");

    // 6. Malformed and random frames on the CDP socket, then a sanity call.
    const raw = a1.c.ws;
    for (let i = 0; i < n; i++) {
      const kind = r.int(8);
      const frame =
        kind === 0 ? junk(r, 200)
        : kind === 1 ? JSON.stringify({ id: r.int(1e9), method: junk(r, 30), params: junk(r, 20) })
        : kind === 2 ? JSON.stringify({ id: "x", method: "Runtime.evaluate", params: { expression: "1" } })
        : kind === 3 ? JSON.stringify({ id: r.int(1e9), method: "Runtime.evaluate", params: { expression: "1" }, sessionId: junk(r, 32) })
        : kind === 4 ? JSON.stringify({ id: r.int(1e9), method: r.pick(WIPES), params: null, sessionId: r.chance(0.5) ? a1.sessionId : undefined })
        : kind === 5 ? JSON.stringify({ id: r.int(1e9), method: "Target.sendMessageToTarget", params: { message: junk(r, 100), targetId: a1.targetId } })
        : kind === 6 ? "[" .repeat(5000)
        : JSON.stringify({ id: r.int(1e9), method: "Runtime.evaluate", params: { expression: "'x'.repeat(10)" }, extra: "y".repeat(r.int(200_000)) });
      try {
        raw.send(frame);
      } catch {}
    }
    try {
      raw.send("z".repeat(32 * 1024 * 1024));
    } catch {}
    await sleep(2_000);
    // The client may have been dropped for the 32 MB frame; a fresh one must work.
    const fresh = await CdpClient.bridge(bridge().port, bridge().token, `fuzz-sanity-${seed}`);
    try {
      const v = await fresh.send("Target.getTargets", {}, undefined, 20_000);
      if (!Array.isArray(v?.targetInfos)) violate("a fresh client got no tab list after the frame fuzz");
    } finally {
      fresh.close();
    }
    const finalJar = await jar();
    if (onHost(finalJar, hostB).length < onHost(before, hostB).length) violate(`cookies of ${hostB} were lost during the frame fuzz`);
  } finally {
    for (const ag of [a1, a2]) {
      await ag.c.send("Target.closeTarget", { targetId: ag.targetId }, undefined, 10_000).catch(() => {});
      ag.c.close();
    }
  }
}

// ---------------------------------------------------------------------------

console.log(`fuzz: rig ${rig.name}, seed ${seed}, ${rounds} rounds; log in ${log.dir}`);
oracle = await CdpClient.chrome(rig.cdpPort);
const t0 = Date.now();
try {
  console.log("  http");
  await fuzzHttp(rng.fork(1), rounds);
  await hostAlive("the HTTP fuzz");
  console.log("  extension socket");
  await fuzzExtensionSocket(rng.fork(2), Math.max(10, Math.floor(rounds / 10)));
  await hostAlive("the extension-socket fuzz");
  console.log("  cdp");
  await fuzzCdp(rng.fork(3), rounds);
  await hostAlive("the CDP fuzz");
} catch (e) {
  violate(`the fuzz run itself failed: ${(e as CdpError).message}`);
} finally {
  oracle.close();
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
log.text("summary.txt", `seed ${seed}\nrounds ${rounds}\n${secs}s\nviolations ${violations.length}\n${violations.join("\n")}\n`);
if (violations.length) {
  console.log(`\nFAIL: ${violations.length} violation(s) in ${secs}s (seed ${seed}); ${log.dir}`);
  for (const v of violations) console.log(`  - ${v}`);
  process.exit(1);
}
console.log(`\nPASS: every invariant held in ${secs}s (seed ${seed}); ${log.dir}`);
