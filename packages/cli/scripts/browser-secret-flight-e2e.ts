#!/usr/bin/env bun
/**
 * End to end for `type-secret` and `flight` on the isolated browser rig
 * (browser-rig.ts up --fixtures), through the real bridge and extension.
 *
 *   (source /tmp/cast-browser-rig/default/env && bun packages/cli/scripts/browser-secret-flight-e2e.ts)
 *
 * The secret is a throwaway held in this process (the rig's HOME has no Vault
 * login, and the human's Vault stays out of it); everything from the session's
 * tab onward is the product path: openSessionTab, cdpSecretPage, typeSecret,
 * and the flight verbs as the CLI runs them. The value is never printed: the
 * checks compare it inside this process and print true or false, then scan
 * the rig's logs and this run's output for it.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import type { PublishDeps } from "../src/castApi.ts";
import type { ReadSecret } from "../src/secrets/inject.ts";
import { openSessionTab } from "../src/browser/sessionTab.ts";
import { cdpSecretPage, typeSecret, type SecretTypeField } from "../src/browser/secretType.ts";
import { pageForRef } from "../src/browser/oopif.ts";

const A = process.env.CAST_RIG_FIXTURES;
const B = process.env.CAST_RIG_FIXTURES_B;
const RIG = process.env.CAST_RIG_DIR;
if (!A || !B || !RIG) throw new Error("source the rig's env first (browser-rig.ts up --fixtures)");
// Never the human's machine state: the rig swaps HOME and CODECAST_DIR to its own temp dir.
if (!process.env.HOME?.startsWith(RIG) || !process.env.CODECAST_DIR?.startsWith(RIG)) throw new Error(`HOME and CODECAST_DIR must be the rig's (under ${RIG}); refusing to run`);
const CLI = path.resolve(import.meta.dir, "../src/main.ts");
// The CLI names its session from CODECAST_SESSION_ID (sessionIdFromEnv), not the rig's CAST_SESSION_ID; pin both
// children and this process to one key, so the tab `open` makes is the tab type-secret attaches to.
process.env.CODECAST_SESSION_ID = process.env.CAST_SESSION_ID || "rig-e2e";
const deps = { detectCurrentSessionId: () => process.env.CODECAST_SESSION_ID ?? null } as unknown as PublishDeps;

const PASSWORD = `rig-pw-${Math.random().toString(36).slice(2, 10)}`;
const USERNAME = "ada@rig.test";
const hostA = new URL(A).host;
const secret = (sites: string[]): { meta: SecretMeta; read: ReadSecret } => ({
  meta: { _id: "x", short_id: "sc-rig", name: "zz-rig-login", kind: "login", status: "ready", workspace: "user:rig", sites, created_by: "rig", created_at: 0, updated_at: 0 } as SecretMeta,
  read: { id: "x", short_id: "sc-rig", name: "zz-rig-login", kind: "login", sites, payload: { username: USERNAME, password: PASSWORD } },
});

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const cast = (...args: string[]) => spawnSync("bun", [CLI, "browser", ...args], { encoding: "utf-8", env: process.env, timeout: 180_000 });
let output = "";
const castOut = (...args: string[]) => {
  const r = cast(...args);
  output += r.stdout + r.stderr;
  return r;
};

async function attempt(url: string, target: string, field: SecretTypeField, sites = [hostA], before?: string): Promise<{ ok: boolean; message: string; value?: string }> {
  const o = castOut("open", url);
  if (o.status !== 0) return { ok: false, message: `open failed: ${o.stderr.trim()}` };
  const tab = await openSessionTab({}, deps);
  try {
    if (before) await tab.conn.send("Runtime.evaluate", { expression: before }, tab.sessionId);
    const s = secret(sites);
    try {
      const res = await typeSecret("zz-rig-login", { field }, { meta: async () => s.meta, read: async () => s.read, policy: null, page: cdpSecretPage(tab.conn, tab.sessionId, target) });
      const { result } = await tab.conn.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(target)})?.value ?? ""`, returnByValue: true }, tab.sessionId);
      output += JSON.stringify(res);
      return { ok: true, message: JSON.stringify(res), value: result.value };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  } finally {
    tab.conn.close();
  }
}

// type-secret
{
  const r = await attempt(`${A}/login.html`, "#password", "password");
  check("password typed on its own origin", r.ok && r.value === PASSWORD, r.ok ? `${r.message}, field holds the value: ${r.value === PASSWORD}` : r.message);
  const u = await attempt(`${A}/login.html`, "#email", "username");
  check("username typed", u.ok && u.value === USERNAME, u.message);
  const again = await attempt(`${A}/login.html`, "#password", "password", [hostA], `document.querySelector("#password").value = "stale"`);
  check("replaces what the field held", again.ok && again.value === PASSWORD, again.ok ? "" : again.message);
}
{
  const r = await attempt(`${B}/login.html`, "#password", "password");
  check("other origin refused", !r.ok && /not a site of/.test(r.message), r.message);
}
{
  const r = await attempt(`${A}/login.html`, "#password", "password", []);
  check("secret with no site refused", !r.ok && /names no site/.test(r.message), r.message);
}
{
  const r = await attempt(`${A}/iframe.html`, "#child", "password", [hostA, new URL(B).host]);
  check("an iframe element with no field focused refused", !r.ok && /cross-origin iframe/.test(r.message), r.message);
}
// A field inside the other origin's frame, by its snapshot ref: typed only when the secret names the FRAME's site.
// Through localhost the frame is cross-site, so Chrome runs it out of process (a child session); through
// 127.0.0.1 it is same-site and shares the tab's renderer. Both are the frame's own origin, B.
for (const [kind, top] of [["out-of-process", A.replace("127.0.0.1", "localhost")], ["in-process", A]] as const) {
  const hostB = new URL(B).host;
  const inFrame = async (sites: string[]) => {
    if (castOut("open", `${top}/iframe.html`).status !== 0) return { ok: false, message: "open failed" };
    const snap = castOut("snapshot");
    const ref = /textbox "Password"[^\n]*#e(\d+)/.exec(snap.stdout)?.[1];
    if (!ref) return { ok: false, message: `no password ref in the frame: ${snap.stdout.slice(0, 400)}` };
    const tab = await openSessionTab({}, deps);
    try {
      const s = secret(sites);
      try {
        const res = await typeSecret("zz-rig-login", { field: "password" }, { meta: async () => s.meta, read: async () => s.read, policy: null, page: cdpSecretPage(tab.conn, tab.sessionId, `#e${ref}`, () => tab.focusRef(`#e${ref}`)) });
        const at = await pageForRef({ conn: tab.conn, sessionId: tab.sessionId, targetId: tab.targetId }, Number(ref));
        const { object } = await tab.conn.send<any>("DOM.resolveNode", { backendNodeId: at.ref }, at.page.sessionId);
        const { result } = await tab.conn.send<any>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { return this.value }", returnByValue: true }, at.page.sessionId);
        output += JSON.stringify(res);
        return { ok: true, message: JSON.stringify(res), value: result.value as string };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    } finally {
      tab.conn.close();
    }
  };
  const typed = await inFrame([hostB]);
  check(`${kind} frame: typed when the secret names the frame's site`, typed.ok && typed.value === PASSWORD && typed.message.includes(B), typed.ok ? `${typed.message}, field holds the value: ${typed.value === PASSWORD}` : typed.message);
  const top_ = await inFrame([hostA]);
  check(`${kind} frame: refused when the secret names only the top page's site`, !top_.ok && /not a site of/.test(top_.message), top_.message);
}
{
  // The field sends the page to the other origin the moment it takes focus.
  const r = await attempt(`${A}/login.html`, "#password", "password", [hostA, new URL(B).host], `document.querySelector("#password").addEventListener("focus", () => { location.href = ${JSON.stringify(`${B}/login.html`)} })`);
  check("redirect after focus refused", !r.ok && /moved from/.test(r.message), r.message);
}

// flight
{
  castOut("open", `${A}/index.html`);
  const start = castOut("flight", "start", "--seconds", "20");
  check("flight start", start.status === 0, start.stdout.trim() || start.stderr.trim());
  for (const page of ["login.html", "delete-list.html", "index.html"]) {
    castOut("open", `${A}/${page}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const status = castOut("flight", "status");
  check("flight status", status.status === 0 && /buffered/.test(status.stdout), status.stdout.trim());
  const save = castOut("flight", "save", "--seconds", "8", "--local", "--json");
  let saved: { file?: string; frames?: number; seconds?: number } = {};
  try {
    saved = JSON.parse(save.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {}
  const probe = saved.file ? spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", saved.file], { encoding: "utf-8" }) : null;
  const dur = probe ? parseFloat(probe.stdout) : NaN;
  check("flight save writes an mp4 of the time asked", !!saved.file && fs.existsSync(saved.file) && Math.abs(dur - 8) < 0.3, `${saved.file} ${saved.frames} frames, ${dur.toFixed(2)}s`);
  const stop = castOut("flight", "stop");
  check("flight stop", stop.status === 0 && /stopped/.test(stop.stdout), stop.stdout.trim());
  const after = castOut("flight", "status");
  check("no recorder after stop", /no flight recorder/.test(after.stdout), after.stdout.trim());
}

// The value went nowhere but the page.
{
  const leaks: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "profile") walk(p);
      } else if (e.isFile() && fs.statSync(p).size < 50_000_000 && fs.readFileSync(p).includes(PASSWORD)) leaks.push(p);
    }
  };
  walk(RIG);
  check("value in no rig log or state file", leaks.length === 0, leaks.join(", "));
  check("value in no command output", !output.includes(PASSWORD));
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
