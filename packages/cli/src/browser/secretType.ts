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
 * The origin is the browser's, never the page's word for it: the top frame's
 * URL and security origin come from `Page.getFrameTree`, and the focused field
 * is found from an isolated world, whose DOM prototypes the page cannot patch.
 * A field inside a cross-origin iframe is refused, and so is any change of the
 * top frame's origin between the first check and the insert (a redirect, or a
 * page that navigated when the field took focus). The checks run again right
 * before the value is inserted.
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
 * May `name`'s value go to `url`? Its Sites as policy patterns (`example.com`
 * exact host, `*.example.com` subdomains too, `host:port`), https only except
 * on loopback, then the session allowlist when there is one.
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
  if (!checkUrl({ sources: [{ file: "the Vault", key: name, patterns: sites }], errors: [] }, url).allowed) {
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

/** The page operations type-secret needs; injectable so the flow is tested without Chrome. */
export interface SecretTypePage {
  /** The top frame's URL, from the browser's frame tree. */
  topUrl(): Promise<string>;
  /** Give the target field focus (a snapshot ref or a CSS selector). */
  focus(): Promise<void>;
  probe(): Promise<FocusProbe>;
  selectAll(): Promise<void>;
  insertText(text: string): Promise<void>;
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

/** The checks on what has focus: an editable field, in a frame of the top's origin. */
function checkFocus(probe: FocusProbe, origin: string): void {
  if (probe.frame === "cross") throw new SecretTypeRefusal("the field is inside a cross-origin iframe, so nothing is typed there");
  if (probe.docOrigin !== origin) throw new SecretTypeRefusal(`the field's frame is ${probe.docOrigin ?? "unknown"}, not ${origin}`);
  if (!probe.editable) throw new SecretTypeRefusal("the target is not an editable text field (or did not take focus)", "Point it at the input itself: a ref from `cast browser snapshot -i`, or a CSS selector");
}

/** Type `name` into the target. Every refusal is thrown before the value is read or inserted. */
export async function typeSecret(name: string, opts: { field?: SecretTypeField; append?: boolean }, d: SecretTypeDeps): Promise<SecretTypeResult> {
  const meta = await d.meta(name);
  if (!meta) throw new SecretTypeRefusal(`no secret named ${name}`, "cast vault ls lists the ones you can use");
  if (meta.status !== "ready") throw new SecretTypeRefusal(`${name} is requested and has no value yet`);
  const field = fieldFor(meta.kind, opts.field, name);
  // Sites guard every field, the username included: it says which account, on which site.
  const first = await d.page.topUrl();
  const { origin } = originVerdict(meta, first, d.policy);

  await d.page.focus();
  // The top frame first: a page that navigated on focus would otherwise read as a field in a foreign frame.
  const afterFocus = await d.page.topUrl();
  if (webOrigin(afterFocus) !== origin) throw new SecretTypeRefusal(`the page moved from ${origin} to ${webOrigin(afterFocus) ?? afterFocus} when the field took focus, so nothing is typed`);
  checkFocus(await d.page.probe(), origin);

  const secret = await d.read(name, field);
  const text = await valueFor(secret, field, d.otp);

  // Again, right before the insert: the read and a 2FA wait take time a page can use.
  const last = await d.page.topUrl();
  if (webOrigin(last) !== origin) throw new SecretTypeRefusal(`the page moved from ${origin} to ${webOrigin(last) ?? last} before the value went in, so nothing is typed`);
  originVerdict(secret, last, d.policy);
  const probe = await d.page.probe();
  checkFocus(probe, origin);
  if (!opts.append) await d.page.selectAll();
  await d.page.insertText(text);
  return { typed: true, name: meta.name, origin, field };
}

// ── CDP ─────────────────────────────────────────────────────────────────────

interface FrameTree {
  frame: { id: string; url: string; urlFragment?: string; securityOrigin?: string };
}

/**
 * SecretTypePage over a CDP session on the tab. `focus` is the caller's
 * (the engine resolves a ref; a CSS selector is focused here when it passes
 * none). The probe and the select run in an isolated world of the top frame,
 * made once and made again if the page navigated.
 */
export function cdpSecretPage(conn: CdpClient, sessionId: string, target: string, focus?: () => Promise<void>): SecretTypePage {
  let world: { frameId: string; contextId: number } | null = null;
  const tree = async () => (await conn.send<{ frameTree: FrameTree }>("Page.getFrameTree", {}, sessionId)).frameTree;
  const isolated = async (expression: string, retried = false): Promise<any> => {
    const top = (await tree()).frame;
    if (!world || world.frameId !== top.id) {
      const { executionContextId } = await conn.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: top.id, worldName: "cast-secret-type" }, sessionId);
      world = { frameId: top.id, contextId: executionContextId };
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
      return isolated(expression, true);
    }
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "the page probe failed");
    return res.result.value;
  };
  return {
    topUrl: async () => {
      const top = (await tree()).frame;
      // The security origin is the browser's; a URL whose origin disagrees with it (an opaque, sandboxed document) is no site.
      if (top.securityOrigin && webOrigin(top.url) !== top.securityOrigin) return top.securityOrigin === "null" ? "about:blank" : top.securityOrigin;
      return top.url;
    },
    focus: focus ?? (async () => {
      const ok = await isolated(`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return false; el.focus(); return true; })()`);
      if (!ok) throw new SecretTypeRefusal(`nothing on the page matches ${target}`);
    }),
    probe: async () => (await isolated(FOCUS_PROBE)) as FocusProbe,
    selectAll: async () => void (await isolated(SELECT_FOCUSED)),
    insertText: async (text) => void (await conn.send("Input.insertText", { text }, sessionId)),
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
session's site allowlist. A field inside a cross-origin iframe, or a page
that moved to another origin before the insert, is refused.

  cast browser type-secret #e14 acme-login                 # the password
  cast browser type-secret '#email' acme-login --field username
  cast browser type-secret #e20 acme-login --field otp     # the current 2FA code`,
    )
    .action(async (target: string, name: string, o: TargetChoice & { field?: string; append?: boolean; why?: string; json?: boolean }) => {
      if (o.field && !(SECRET_TYPE_FIELDS as readonly string[]).includes(o.field)) fail(`--field takes ${SECRET_TYPE_FIELDS.join(", ")}`);
      let tab: SessionTab | null = null;
      try {
        tab = await openSessionTab(o, deps);
        const t = tab;
        const metas = metasOnce(deps);
        const res = await typeSecret(name, { field: o.field as SecretTypeField | undefined, append: o.append }, {
          meta: async (n) => (await metas()).find((m) => m.name === n || m.short_id === n) ?? null,
          read: async (n, field) => (await readSecrets(deps, [n], field === "otp" ? "otp" : "get", o.why))[0],
          policy: loadSitePolicy(),
          page: cdpSecretPage(t.conn, t.sessionId, target, /^#?e\d+$/i.test(target) ? () => t.focusRef(target) : undefined),
        });
        if (o.json) console.log(JSON.stringify(res));
        else console.log(`${fmt.success(icons.check)} typed ${res.name} (${res.field}) on ${res.origin}`);
      } catch (err) {
        const hint = (err as { hint?: string }).hint;
        fail(`${(err as Error).message}${err instanceof SecretTypeRefusal ? ". Nothing was typed" : ""}${hint ? `\n  ${hint}` : ""}`);
      } finally {
        tab?.conn.close();
      }
    });
}
