/**
 * `cast browser type-secret`: type a Vault value into a page field without the
 * agent ever holding it.
 *
 * The value goes from the Vault read straight into CDP `Input.insertText` on
 * the session's tab. It is never printed, logged, written to a file or put in
 * an argument; what the command reports is `{typed, name, origin, field}`.
 *
 * Where it may go is the secret's own Sites (set by a person when the secret
 * was stored, `cast vault add --site`, or on the Vault page), matched the way
 * the session's site allowlist matches (policy.ts patterns), and the session
 * allowlist too when one is set. A secret with no site is refused: a value
 * with nowhere it belongs could be typed anywhere a page steers the agent.
 *
 * The origin is the browser's, never the page's word for it: a frame's URL
 * and security origin come from `Page.getFrameTree`, and the focused field is
 * found from an isolated world, whose DOM prototypes the page cannot patch.
 * The origin checked is that of the document holding the field. For a field
 * inside a cross-origin iframe (a payment or sign-in frame) it is the frame's
 * own: the frame holding focus is found by probing each cross-origin frame in
 * a world of its own (an out-of-process one through its child session,
 * oopif.ts), and the value goes in only when the secret's Sites name that
 * frame's origin; the top page must still be inside the session allowlist.
 * Any change of the top page's origin or the field's between the first check
 * and the insert (a redirect, or a page that navigated when the field took
 * focus) is refused. The checks run again right before the value is inserted.
 *
 * Only values the transcript redaction knows (redactionValuesOf: a key, a
 * login's password) are typed as secrets, so if one ever shows up in output
 * (a snapshot of a text field, a page echoing it) the daemon's known-value
 * redaction scrubs it before the transcript syncs. A login's username is not
 * secret and a 2FA code is single use; both are typed the same way.
 */

import {
  SECRET_REDACTION_MIN,
  redactionValuesOf,
  type LoginPayload,
  type SecretKind,
  type SecretMeta,
} from "@codecast/shared/contracts/secrets";
import { freshTotp, type ReadSecret } from "../secrets/inject.js";
import { checkUrl, isInternalUrl, loadSitePolicy, parsePattern, type SitePolicy } from "./policy.js";
import type { CdpClient } from "./cdp.js";
import { childFrames } from "./oopif.js";
import type { Command } from "commander";
import type { PublishDeps } from "../castApi.js";
import { fmt, icons } from "../colors.js";
import { fail } from "../externalDataCli.js";
import { metasOnce, readSecrets } from "../secrets/command.js";
import { targetFlags } from "./bridge/commands.js";
import type { TargetChoice } from "./cliEngine.js";
import { openSessionTab, type SessionTab } from "./sessionTab.js";

/** What `type-secret --field` takes. The default is the one value a kind is about. */
export const SECRET_TYPE_FIELDS = ["value", "password", "username", "otp"] as const;
export type SecretTypeField = (typeof SECRET_TYPE_FIELDS)[number];

export interface SecretTypeResult {
  typed: true;
  name: string;
  origin: string;
  field: SecretTypeField;
}

/** A refusal: nothing was typed. `hint` is the one thing to do about it. */
export class SecretTypeRefusal extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "SecretTypeRefusal";
  }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** `https://host[:port]` of a URL, or null for one with no web origin (about:, data:, file:). */
export function webOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A secret's site as patterns: a named host and its subdomains; an IP, a port or a `*.` pattern as written. */
export function withSubdomains(site: string): string[] {
  const p = parsePattern(site);
  if (!p || p.wildcard || p.port !== null || p.scheme || !/[a-z]/i.test(p.host.split(".").pop() ?? "") || !p.host.includes(".")) return [site];
  return [site, `*.${p.host}`];
}

/** The field a kind types by default, or why `field` does not fit it. */
export function fieldFor(kind: SecretKind, field: SecretTypeField | undefined, name: string): SecretTypeField {
  if (kind === "signin") throw new SecretTypeRefusal(`${name} is a saved sign-in: cast browser open <site> loads it, there is no value to type`);
  if (kind === "file") throw new SecretTypeRefusal(`${name} is a file secret: type-secret types a key or a login`);
  const fits = kind === "key" ? ["value"] : ["password", "username", "otp"];
  const chosen = field ?? (kind === "key" ? "value" : "password");
  if (!fits.includes(chosen)) throw new SecretTypeRefusal(`${name} is a ${kind}: use --field ${fits.join(", ")}`);
  return chosen;
}

/**
 * May `name`'s value go to `url`? Its Sites as policy patterns, a named host
 * covering its subdomains too (`example.com` takes `www.example.com` and
 * `sso.example.com`, never `example.com.evil.test`), an IP or `host:port`
 * site exact; https only except on loopback, then the session allowlist when
 * there is one.
 */
export function originVerdict(
  secret: Pick<SecretMeta, "name" | "sites">,
  url: string,
  session: SitePolicy | null,
): { origin: string } {
  const name = secret.name;
  const sites = (secret.sites ?? []).filter((s) => {
    const p = parsePattern(s);
    return p && !p.matchAll;
  });
  if (!sites.length) {
    throw new SecretTypeRefusal(
      `${name} names no site it belongs to, so it is typed nowhere`,
      `A person adds the site on the Vault page (Sites), or stores it with \`cast vault add ${name} --site <host>\``,
    );
  }
  const origin = webOrigin(url);
  if (!origin || isInternalUrl(url)) throw new SecretTypeRefusal(`the page is ${url || "blank"}, which is no site ${name} belongs to`);
  const u = new URL(url);
  if (u.protocol !== "https:" && !LOOPBACK.test(u.hostname)) {
    throw new SecretTypeRefusal(`${origin} is not https, so ${name} is not typed there`);
  }
  if (!checkUrl({ sources: [{ file: "the Vault", key: name, patterns: sites.flatMap(withSubdomains) }], errors: [] }, url).allowed) {
    throw new SecretTypeRefusal(`${origin} is not a site of ${name} (${sites.join(", ")})`, "Open the secret's own site, or ask a person to add this one to its Sites");
  }
  const allow = checkUrl(session, url);
  if (!allow.allowed) throw new SecretTypeRefusal(`${origin} is outside this session's site allowlist: ${allow.reason}`);
  return { origin };
}

/**
 * The text to insert for `field`. A key's value or a login's password must be
 * one the transcript redaction holds (redactionValuesOf), so it is scrubbed
 * wherever it might surface later; a shorter one than SECRET_REDACTION_MIN is
 * refused for that reason.
 */
export async function valueFor(s: ReadSecret, field: SecretTypeField, otp = freshTotp): Promise<string> {
  const p = s.payload as LoginPayload & { value?: string };
  if (field === "otp") {
    if (!p.totp_seed) throw new SecretTypeRefusal(`${s.name} has no 2FA seed`, `A person adds one with \`cast vault rotate ${s.name} --totp\``);
    return (await otp(p.totp_seed)).code;
  }
  if (field === "username") {
    if (!p.username) throw new SecretTypeRefusal(`${s.name} has no username`);
    return p.username;
  }
  const value = field === "value" ? p.value : p.password;
  if (!value) throw new SecretTypeRefusal(`${s.name} has no ${field}`);
  if (value.length < SECRET_REDACTION_MIN || !redactionValuesOf(s.kind, s.payload).includes(value)) {
    throw new SecretTypeRefusal(`${s.name}'s ${field} is too short to redact from transcripts, so it is not typed`, `Store one of at least ${SECRET_REDACTION_MIN} characters`);
  }
  return value;
}

// ── The page ────────────────────────────────────────────────────────────────

/** What has focus, as seen from an isolated world. */
export interface FocusProbe {
  /** top: a field in the top document; same: inside a same-origin iframe; cross: inside a frame the top cannot read. */
  frame: "top" | "same" | "cross";
  editable: boolean;
  /** The origin of the document holding the field. */
  docOrigin?: string;
  /** Enough to tell one field from another between two probes. */
  key?: string;
}

/** The focus probe. Runs in an isolated world, so a page cannot fake activeElement or contentDocument. */
export const FOCUS_PROBE = `(() => {
  let doc = document, el = doc.activeElement, frame = "top";
  while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) {}
    if (!inner) return { frame: "cross", editable: false };
    doc = inner; el = inner.activeElement; frame = "same";
  }
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const docOrigin = doc.location.origin;
  if (!el || el === doc.body || el === doc.documentElement) return { frame, editable: false, docOrigin };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const texty = ["", "text", "password", "email", "tel", "number", "search", "url"].includes(type);
  const editable = !!el.isContentEditable || ((tag === "textarea" || (tag === "input" && texty)) && !el.readOnly && !el.disabled);
  const key = [frame, tag, type, el.id || "", el.getAttribute("name") || "", el.getAttribute("autocomplete") || ""].join("|");
  return { frame, editable, docOrigin, key };
})()`;

/** Select whatever the focused field holds, so the insert replaces it. */
export const SELECT_FOCUSED = `(() => {
  let doc = document, el = doc.activeElement;
  while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME") && el.contentDocument) { doc = el.contentDocument; el = doc.activeElement; }
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  if (typeof el.select === "function") { el.select(); return true; }
  if (el.isContentEditable) { const sel = doc.getSelection(); sel && sel.selectAllChildren(el); return true; }
  return false;
})()`;

/** A document type-secret can probe and type into: the top page, or the cross-origin frame holding focus. */
export interface SecretTypeDoc {
  /** The document's URL, from the browser's frame tree ("" once it is gone). */
  url(): Promise<string>;
  probe(): Promise<FocusProbe>;
  selectAll(): Promise<void>;
  insertText(text: string): Promise<void>;
}

/** The page operations type-secret needs; injectable so the flow is tested without Chrome. */
export interface SecretTypePage extends Omit<SecretTypeDoc, "url"> {
  /** The top frame's URL, from the browser's frame tree. */
  topUrl(): Promise<string>;
  /** Give the target field focus (a snapshot ref or a CSS selector). */
  focus(): Promise<void>;
  /** The cross-origin frame whose document holds focus on an editable field, or null when none does. */
  focusedFrame?(): Promise<SecretTypeDoc | null>;
}

export interface SecretTypeDeps {
  /** The secret's metadata (sites, kind), read without its value. */
  meta(name: string): Promise<SecretMeta | null>;
  /** The value: a recorded Vault read. Only called once every check has passed. */
  read(name: string, field: SecretTypeField): Promise<ReadSecret>;
  policy: SitePolicy | null;
  page: SecretTypePage;
  otp?: typeof freshTotp;
}

/** The checks on what has focus: an editable field, in a document of the checked origin. */
function checkFocus(probe: FocusProbe, origin: string): void {
  if (probe.frame === "cross") throw new SecretTypeRefusal("the field is inside a cross-origin iframe, so nothing is typed there");
  if (probe.docOrigin !== origin) throw new SecretTypeRefusal(`the field's frame is ${probe.docOrigin ?? "unknown"}, not ${origin}`);
  requireEditable(probe);
}

function requireEditable(probe: FocusProbe): void {
  if (!probe.editable) throw new SecretTypeRefusal("the target is not an editable text field (or did not take focus)", "Point it at the input itself: a ref from `cast browser snapshot -i`, or a CSS selector");
}

/**
 * Put a value the caller already holds (`type`/`fill --stdin`) into the
 * target, by the same CDP insert as a Vault value, so it never becomes an
 * engine argument. No Sites check: the value is not the Vault's.
 */
export async function typeText(text: string, opts: { append?: boolean }, page: SecretTypePage): Promise<{ typed: true; origin: string }> {
  await page.focus();
  const frame = (await page.probe()).frame === "cross" ? await focusedFrame(page) : null;
  const target: SecretTypeDoc = frame ?? { ...page, url: page.topUrl };
  const probe = await target.probe();
  if (probe.frame === "cross") throw new SecretTypeRefusal("the field is inside a cross-origin iframe, so nothing is typed there");
  requireEditable(probe);
  if (!opts.append) await target.selectAll();
  await target.insertText(text);
  return { typed: true, origin: probe.docOrigin ?? webOrigin(await target.url()) ?? "" };
}

/** Type `name` into the target. Every refusal is thrown before the value is read or inserted. */
export async function typeSecret(name: string, opts: { field?: SecretTypeField; append?: boolean }, d: SecretTypeDeps): Promise<SecretTypeResult> {
  const meta = await d.meta(name);
  if (!meta) throw new SecretTypeRefusal(`no secret named ${name}`, "cast vault ls lists the ones you can use");
  if (meta.status !== "ready") throw new SecretTypeRefusal(`${name} is requested and has no value yet`);
  const field = fieldFor(meta.kind, opts.field, name);
  const first = await d.page.topUrl();
  const top = webOrigin(first) ?? first;

  await d.page.focus();
  // The top frame first: a page that navigated on focus would otherwise read as a field in a foreign frame.
  const afterFocus = await d.page.topUrl();
  if ((webOrigin(afterFocus) ?? afterFocus) !== top) throw new SecretTypeRefusal(`the page moved from ${top} to ${webOrigin(afterFocus) ?? afterFocus} when the field took focus, so nothing is typed`);
  // The document holding the field: the top page, or the cross-origin frame that has focus.
  const frame = (await d.page.probe()).frame === "cross" ? await focusedFrame(d.page) : null;
  // Sites guard every field, the username included: they say which account, on which site.
  const fieldUrl = frame ? await frame.url() : afterFocus;
  const { origin } = originVerdict(meta, fieldUrl, d.policy);
  if (frame) inAllowlist(first, d.policy);
  const target: SecretTypeDoc = frame ?? { ...d.page, url: d.page.topUrl };
  checkFocus(await target.probe(), origin);

  const secret = await d.read(name, field);
  const text = await valueFor(secret, field, d.otp);

  // Again, right before the insert: the read and a 2FA wait take time a page can use.
  const last = await d.page.topUrl();
  if ((webOrigin(last) ?? last) !== top) throw new SecretTypeRefusal(`the page moved from ${top} to ${webOrigin(last) ?? last} before the value went in, so nothing is typed`);
  const lastField = frame ? await frame.url() : last;
  if (webOrigin(lastField) !== origin) throw new SecretTypeRefusal(`the field's frame moved from ${origin} to ${webOrigin(lastField) ?? (lastField || "nowhere")} before the value went in, so nothing is typed`);
  originVerdict(secret, lastField, d.policy);
  // Focus must still sit inside that frame, seen from the top as well as from the frame.
  if (frame && (await d.page.probe()).frame !== "cross") throw new SecretTypeRefusal("focus left the frame before the value went in, so nothing is typed");
  checkFocus(await target.probe(), origin);
  if (!opts.append) await target.selectAll();
  await target.insertText(text);
  return { typed: true, name: meta.name, origin, field };
}

/** The cross-origin frame holding focus, or the refusal for a field the browser shows in no frame we can read. */
async function focusedFrame(page: SecretTypePage): Promise<SecretTypeDoc> {
  const frame = page.focusedFrame ? await page.focusedFrame() : null;
  if (!frame) throw new SecretTypeRefusal("the field is inside a cross-origin iframe whose document could not be read, so nothing is typed there");
  return frame;
}

/** A field in a frame still lives on the top page, which answers to the session allowlist. */
function inAllowlist(topUrl: string, session: SitePolicy | null): void {
  const allow = checkUrl(session, topUrl);
  if (!allow.allowed) throw new SecretTypeRefusal(`the page ${webOrigin(topUrl) ?? topUrl} is outside this session's site allowlist: ${allow.reason}`);
}

// ── CDP ─────────────────────────────────────────────────────────────────────

interface FrameNode {
  id: string;
  url: string;
  urlFragment?: string;
  securityOrigin?: string;
}
interface FrameTree {
  frame: FrameNode;
  childFrames?: FrameTree[];
}

/** A frame's URL as the browser knows it; a document whose security origin disagrees with its URL (opaque, sandboxed) is no site. */
function browserUrl(f: FrameNode): string {
  if (f.securityOrigin && webOrigin(f.url) !== f.securityOrigin) return f.securityOrigin === "null" ? "about:blank" : f.securityOrigin;
  return f.url;
}

const treeOf = async (conn: CdpClient, sessionId: string) => (await conn.send<{ frameTree: FrameTree }>("Page.getFrameTree", {}, sessionId)).frameTree;
const flatten = (t: FrameTree): FrameNode[] => [t.frame, ...(t.childFrames ?? []).flatMap(flatten)];

/**
 * Script in an isolated world of one frame (found by `frame` each call), made
 * once and made again if the frame navigated.
 */
function frameWorld(conn: CdpClient, sessionId: string, frame: () => Promise<FrameNode | undefined>) {
  let world: { frameId: string; contextId: number } | null = null;
  const run = async (expression: string, retried = false): Promise<any> => {
    const f = await frame();
    if (!f) throw new SecretTypeRefusal("the field's frame is gone from the page, so nothing is typed");
    if (!world || world.frameId !== f.id) {
      const { executionContextId } = await conn.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: f.id, worldName: "cast-secret-type" }, sessionId);
      world = { frameId: f.id, contextId: executionContextId };
    }
    const ev = async () => conn.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>(
      "Runtime.evaluate", { expression, contextId: world!.contextId, returnByValue: true }, sessionId,
    );
    let res;
    try {
      res = await ev();
    } catch (err) {
      // The context went with a navigation: make a fresh world, once.
      world = null;
      if (retried) throw err;
      return run(expression, true);
    }
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "the page probe failed");
    return res.result.value;
  };
  return run;
}

/** The focus probe, plus whether this document is where the browser's focus is. */
const FRAME_FOCUS = `(() => document.hasFocus() ? ${FOCUS_PROBE} : { frame: "top", editable: false })()`;

/**
 * Every cross-origin frame of the tab, each with a world of its own: frames in
 * the tab's renderer through the tab's session, out-of-process ones through
 * their child sessions (oopif.ts).
 */
async function crossFrames(conn: CdpClient, sessionId: string): Promise<SecretTypeDoc[]> {
  const docs: SecretTypeDoc[] = [];
  const add = (sid: string, frameId: string) => {
    const frame = async () => flatten(await treeOf(conn, sid)).find((f) => f.id === frameId);
    const run = frameWorld(conn, sid, frame);
    docs.push({
      url: async () => {
        const f = await frame().catch(() => undefined);
        return f ? browserUrl(f) : "";
      },
      probe: async () => (await run(FRAME_FOCUS)) as FocusProbe,
      selectAll: async () => void (await run(SELECT_FOCUSED)),
      insertText: async (text) => void (await conn.send("Input.insertText", { text }, sid)),
    });
  };
  const top = await treeOf(conn, sessionId);
  const children = await childFrames({ conn, sessionId, targetId: "" }).catch(() => []);
  const remote = new Set(children.map((c) => c.targetId));
  // An out-of-process frame shows in the tab's tree too, but only its own session can run script in it.
  for (const f of flatten(top).slice(1)) if (!remote.has(f.id)) add(sessionId, f.id);
  for (const c of children) {
    const own = await treeOf(conn, c.sessionId).catch(() => null);
    if (own) for (const f of flatten(own)) add(c.sessionId, f.id);
  }
  return docs;
}

/**
 * SecretTypePage over a CDP session on the tab. `focus` is the caller's
 * (the engine resolves a ref; a CSS selector is focused here when it passes
 * none). The probe and the select run in an isolated world of the top frame,
 * or of the cross-origin frame that holds focus.
 */
export function cdpSecretPage(conn: CdpClient, sessionId: string, target: string, focus?: () => Promise<void>): SecretTypePage {
  const run = frameWorld(conn, sessionId, async () => (await treeOf(conn, sessionId)).frame);
  return {
    topUrl: async () => browserUrl((await treeOf(conn, sessionId)).frame),
    focus: focus ?? (async () => {
      const ok = await run(`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return false; el.focus(); return true; })()`);
      if (!ok) throw new SecretTypeRefusal(`nothing on the page matches ${target}`);
    }),
    probe: async () => (await run(FOCUS_PROBE)) as FocusProbe,
    selectAll: async () => void (await run(SELECT_FOCUSED)),
    insertText: async (text) => void (await conn.send("Input.insertText", { text }, sessionId)),
    focusedFrame: async () => {
      const held: SecretTypeDoc[] = [];
      for (const doc of await crossFrames(conn, sessionId)) {
        const p = await doc.probe().catch(() => null);
        if (p && p.frame !== "cross" && p.editable) held.push(doc);
      }
      // One document has focus; two claiming it is a page playing games.
      return held.length === 1 ? held[0] : null;
    },
  };
}

// ── The verb ────────────────────────────────────────────────────────────────

/** `cast browser type-secret <target> <secret>`. */
export function registerTypeSecretCommand(br: Command, deps: PublishDeps): void {
  targetFlags(br.command("type-secret <target> <secret>"))
    .description("Type a Vault secret into a field without seeing it, only on a site the secret names (target: #e12 ref or CSS selector)")
    .option("--field <field>", `Which value: ${SECRET_TYPE_FIELDS.join(", ")} (default: a key's value, a login's password)`)
    .option("--append", "Insert at the caret instead of replacing what the field holds")
    .option("--why <text>", "The task, as a verb phrase; an Ask first secret shows it to the person who approves")
    .option("--json", "Print {typed, name, origin, field}")
    .addHelpText(
      "after",
      `
The value goes from the Vault into the page and nowhere else: not to stdout,
logs or files. It is typed only when the page's origin, read from the
browser's frame tree, is one of the secret's Sites (set when it was stored:
cast vault add <name> --site <host>, or on the Vault page) and within this
session's site allowlist. A field inside a cross-origin iframe is typed only
when the secret's Sites name the frame's own origin; a page or frame that
moved to another origin before the insert is refused.

  cast browser type-secret #e14 acme-login                 # the password
  cast browser type-secret '#email' acme-login --field username
  cast browser type-secret #e20 acme-login --field otp     # the current 2FA code`,
    )
    .action(async (target: string, name: string, o: TargetChoice & { field?: string; append?: boolean; why?: string; json?: boolean }) => {
      if (o.field && !(SECRET_TYPE_FIELDS as readonly string[]).includes(o.field)) fail(`--field takes ${SECRET_TYPE_FIELDS.join(", ")}`);
      let tab: SessionTab | null = null;
      try {
        tab = await openSessionTab(o, deps);
        const res = await typeSecret(name, { field: o.field as SecretTypeField | undefined, append: o.append }, {
          ...vaultReads(deps, o.why),
          policy: loadSitePolicy(),
          page: secretPageFor(tab, target),
        });
        if (o.json) console.log(JSON.stringify(res));
        else console.log(typedLine(res));
      } catch (err) {
        fail(refusalText(err));
      } finally {
        tab?.conn.close();
      }
    });
}

/** The page typeSecret drives for `target` on a session tab: a snapshot ref is focused by the driver that made it, a CSS selector here. */
export function secretPageFor(tab: SessionTab, target: string): SecretTypePage {
  const ref = /^[#@]?e\d+$/i.test(target) ? `#${target.replace(/^[#@]/, "")}` : null;
  return cdpSecretPage(tab.conn, tab.sessionId, target, ref ? () => tab.focusRef(ref) : undefined);
}

/** typeSecret's Vault reads for this session; `why` words an Ask first question. */
export function vaultReads(deps: PublishDeps, why?: string): Pick<SecretTypeDeps, "meta" | "read"> {
  const metas = metasOnce(deps);
  return {
    meta: async (n) => (await metas()).find((m) => m.name === n || m.short_id === n) ?? null,
    read: async (n, field) => (await readSecrets(deps, [n], field === "otp" ? "otp" : "get", why))[0],
  };
}

/** What a typed Vault value reports: its name and field, never the value. */
export function typedLine(res: SecretTypeResult): string {
  return `${fmt.success(icons.check)} typed ${res.name} (${res.field}) on ${res.origin}`;
}

/** A failure as one line plus its hint; a refusal says nothing was typed. */
export function refusalText(err: unknown): string {
  const hint = (err as { hint?: string }).hint;
  return `${(err as Error).message}${err instanceof SecretTypeRefusal ? ". Nothing was typed" : ""}${hint ? `\n  ${hint}` : ""}`;
}
