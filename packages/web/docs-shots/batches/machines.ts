// Machines, browser, computer, vault, skills, typecheck, cloud and usage-limit
// images ("machines" in ../shots-desktop.json), over lib/acmeWorld/machines.ts
// and the parts beside it.
import type { Shot } from "../manifest";
import { MS } from "../../lib/acmeWorld/machineSessions";
import { SESSIONS } from "../../lib/acmeWorld/world";

const card = (slug: string) => ({ selector: `[data-feature-card="${slug}"]`, pad: 12 });
const dialog = { selector: "[role=dialog][data-state=open]", pad: 0 };
const feed = { selector: "[data-sv-feed]", pad: 0 };
/** Sessions open from the inbox: the route lands there and `open` moves to the session. */
const conv = (_id: string) => "/inbox";
/** A world scene, once the page (reloaded by anyone's edit) has installed them. */
const scene = (call: string) => ({
  js: `new Promise((done) => { const go = () => (window.__acmeScene ? done(__acmeScene.${call}) : setTimeout(go, 200)); go(); })`,
});
/** Puts one of the machine sessions in the inbox (its pane draws a transcript only
 *  for a session the inbox holds), then opens it at its address. */
const open = (id: string) =>
  scene(`open(${JSON.stringify(id)}), history.pushState(null, "", "/inbox?s=${id}"), dispatchEvent(new PopStateEvent("popstate"))`);
/** The Stripe test key a person pastes: built here so no whole key literal sits in the source. */
const FAKE_KEY = ["sk", "test", "51AcmeFixtureOnlyNotARealKey00"].join("_");
/** A transcript shot: the conversation's feed column, once its rows painted. */
const transcript = (name: string, id: string, waitText: string, out: string, extra: Partial<Shot> = {}): Shot => ({
  name,
  route: conv(id),
  viewport: { width: 1100, height: 1000 },
  steps: [open(id), { wait: "[data-sv-feed]", text: waitText }, { sleep: 1200 }],
  crop: feed,
  frame: "element",
  out,
  ...extra,
});
/** A feature's detail on Alex's laptop. */
const feature = (name: string, slug: string, out: string): Shot => ({
  name,
  route: "/agent-features",
  viewport: { width: 1280, height: 1300 },
  steps: [{ wait: `[data-feature-card="${slug}"]` }, { js: `document.querySelector('[data-feature-card="${slug}"]').click()` }, { wait: "[role=dialog][data-state=open]" }, { sleep: 900 }],
  crop: { selector: "[role=dialog][data-state=open]", pad: 0 },
  frame: "element",
  out,
});

export const MACHINES_SHOTS: Shot[] = [
  // First, while the laptop's setup check still answers "not granted" (?acme-setup=pending).
  {
    name: "computer/permissions-card",
    route: "/agent-features?acme-setup=pending",
    viewport: { width: 1280, height: 900 },
    steps: [{ wait: '[data-feature-card="computer"]', text: "Screen Recording" }, { js: `document.querySelector('[data-feature-card="computer"]').scrollIntoView({ block: "center" })` }, { sleep: 600 }],
    crop: card("computer"),
    frame: "element",
    out: "public/documentation/computer/permissions-card.webp",
  },
  {
    name: "browser/agent-features",
    route: "/agent-features",
    viewport: { width: 1280, height: 1100 },
    steps: [{ wait: '[data-feature-card="browser"]', text: "Chrome connected" }, { js: `document.getElementById("af-hands").scrollIntoView({ block: "start" })` }, { sleep: 600 }],
    crop: { selector: "#af-hands", pad: 24 },
    frame: "element",
    out: "public/documentation/browser/agent-features.webp",
  },
  {
    name: "typecheck/typecheck-feature",
    route: "/agent-features",
    viewport: { width: 1280, height: 900 },
    steps: [{ wait: '[data-feature-card="check"]' }, { js: `document.querySelector('[data-feature-card="check"]').scrollIntoView({ block: "center" })` }, { sleep: 600 }],
    crop: card("check"),
    frame: "element",
    out: "public/documentation/typecheck/typecheck-feature.webp",
  },
  feature("browser/browser-feature", "browser", "public/documentation/browser/browser-feature.webp"),
  feature("computer/computer-feature", "computer", "public/documentation/computer/computer-feature.webp"),
  feature("skills/skills-feature", "skills", "public/documentation/skills/skills-feature.webp"),
  feature("usage-limits/limits-feature", "limits", "public/documentation/usage-limits/limits-feature.webp"),

  /* ── Transcripts ── */
  transcript("browser/conversation", MS.browser._id, "Retries are on for the Stripe endpoint", "public/documentation/browser/conversation.webp", { viewport: { width: 1100, height: 760 } }),
  transcript("browser/setup-card", MS.browserSetup._id, "Pair", "public/documentation/browser/setup-card.webp", { viewport: { width: 1100, height: 800 } }),
  {
    name: "browser/watch-live",
    route: conv(MS.watch._id),
    viewport: { width: 1440, height: 900 },
    steps: [open(MS.watch._id), { wait: "[data-sv-feed]", text: "evt_1Q8 landed" }, { sleep: 1200 }],
    frame: "window",
    out: "public/documentation/browser/watch-live.webp",
  },
  transcript("computer/conversation", MS.computer._id, "nothing else was changed", "public/documentation/computer/conversation.webp", { viewport: { width: 1100, height: 820 } }),
  transcript("skills/conversation", MS.skills._id, "judgment calls", "public/documentation/skills/conversation.webp", { viewport: { width: 1100, height: 1040 } }),
  transcript("typecheck/conversation", MS.check._id, "typechecks clean", "public/documentation/typecheck/conversation.webp", { viewport: { width: 1100, height: 940 } }),
  transcript("vault/request-card", MS.vault._id, "stripe-test", "public/documentation/vault/request-card.webp", { crop: { selector: "[data-vault-request-card]", pad: 6 } }),
  transcript("usage-limits/limit-card", MS.limit._id, "resolved", "public/documentation/usage-limits/limit-card.webp"),
  {
    name: "vault/composer-catch",
    route: conv(MS.check._id),
    viewport: { width: 1100, height: 900 },
    steps: [open(MS.check._id), { wait: "[data-composer-field]" }, { click: "[data-composer-field]" }, { type: `Here's the Stripe test key for the retry tests: ${FAKE_KEY}` }, { key: "Enter" }, { wait: "body", text: "Save to Vault and send" }, { sleep: 800 }],
    crop: { selector: "[data-composer-shell]", pad: 16 },
    frame: "element",
    out: "public/documentation/vault/composer-catch.webp",
  },
  {
    name: "skills/slash-menu",
    route: `/conversation/${SESSIONS.lead._id}`,
    viewport: { width: 1100, height: 900 },
    steps: [{ wait: "[data-composer-field]" }, { click: "[data-composer-field]" }, { type: "/cast-" }, { wait: "body", text: "cast-second-opinion" }, { sleep: 800 }],
    crop: { selector: "[data-composer-shell]", pad: 16 },
    frame: "element",
    out: "public/documentation/skills/slash-menu.webp",
  },

  /* ── Vault ── */
  {
    name: "vault/vault-page",
    route: "/vault",
    viewport: { width: 1440, height: 900 },
    steps: [{ wait: "body", text: "staging-db" }, { sleep: 1000 }],
    frame: "window",
    out: "public/documentation/vault/vault-page.webp",
  },
  {
    name: "vault/secret-detail",
    route: "/vault?s=sec-412",
    viewport: { width: 1440, height: 900 },
    steps: [{ wait: "body", text: "Activity" }, { sleep: 1000 }],
    frame: "window",
    out: "public/documentation/vault/secret-detail.webp",
  },
  {
    name: "vault/add-secret",
    route: "/vault",
    viewport: { width: 1280, height: 900 },
    steps: [{ click: "[data-vault-add-menu]" }, { click: "[role=menuitem]", text: "Key" }, { wait: "[role=dialog]" }, { sleep: 600 }],
    crop: dialog,
    frame: "element",
    out: "public/documentation/vault/add-secret.webp",
  },
  {
    name: "vault/save-signin",
    route: "/vault",
    viewport: { width: 1280, height: 900 },
    steps: [{ click: "[data-vault-add-menu]" }, { click: "[role=menuitem]", text: "Browser sign-in" }, { wait: "[role=dialog]" }, { sleep: 600 }],
    crop: dialog,
    frame: "element",
    out: "public/documentation/vault/save-signin.webp",
  },
  {
    name: "vault/ask-first-decision",
    route: "/decisions/sd-4120",
    viewport: { width: 1280, height: 900 },
    steps: [scene("askFirst()"), { wait: "body", text: "Approve for this session" }, { sleep: 1000 }],
    crop: { selector: "[data-decision-card]", pad: 16 },
    frame: "element",
    out: "public/documentation/vault/ask-first-decision.webp",
  },

  /* ── Codex Cloud ── */
  {
    name: "codex-cloud/provider-row",
    route: "/settings/provider-keys",
    viewport: { width: 1280, height: 900 },
    steps: [{ wait: "button", text: "Codex connected" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/codex-cloud/provider-row.webp",
  },
  {
    name: "codex-cloud/connect-codex",
    route: "/settings/provider-keys",
    viewport: { width: 1280, height: 900 },
    steps: [{ click: "button", text: "Codex connected" }, { wait: "[role=dialog]", text: "alex@acme.dev" }, { sleep: 600 }],
    crop: dialog,
    frame: "element",
    out: "public/documentation/codex-cloud/connect-codex.webp",
  },
  {
    name: "codex-cloud/composer",
    route: conv(MS.codexNew._id),
    viewport: { width: 1100, height: 900 },
    steps: [open(MS.codexNew._id), { wait: "[data-composer-field]" }, { click: "[data-composer-field]" }, { type: "Add jitter to webhook retries in acme/webhooks so a burst of failures doesn't retry in lockstep." }, { sleep: 800 }],
    crop: { selector: "[data-composer-shell]", pad: 16 },
    frame: "element",
    out: "public/documentation/codex-cloud/composer.webp",
  },
  {
    name: "codex-cloud/chip-menu",
    route: conv(MS.codexCloud._id),
    viewport: { width: 1280, height: 800 },
    steps: [open(MS.codexCloud._id), { wait: "[data-sv-convhead]" }, { sleep: 1500 }, { click: "button[title^='This session runs as a Codex Cloud agent']" }, { wait: "[role=menu]", text: "Apply locally" }, { sleep: 600 }],
    frame: "window",
    out: "public/documentation/codex-cloud/chip-menu.webp",
  },

  /* ── Remote and cloud sessions ── */
  {
    name: "remote-and-cloud-sessions/cloud-worker",
    route: conv(MS.cloud._id),
    viewport: { width: 1440, height: 900 },
    rail: true,
    steps: [open(MS.cloud._id), scene("machinesAwake()"), { wait: "[data-sv-feed]", text: "96% of failed deliveries" }, { sleep: 1200 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/cloud-worker.webp",
  },
  {
    name: "remote-and-cloud-sessions/placement-menu",
    route: conv(MS.placeNew._id),
    viewport: { width: 1100, height: 900 },
    steps: [open(MS.placeNew._id), scene("machinesAwake()"), { wait: "[data-sv-convhead]" }, { sleep: 1500 }, { click: "button[title='Where this session runs']" }, { wait: "[role=menu]", text: "Start from" }, { sleep: 600 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/placement-menu.webp",
  },
  {
    name: "remote-and-cloud-sessions/machine-menu",
    route: conv(MS.check._id),
    viewport: { width: 1280, height: 800 },
    steps: [open(MS.check._id), scene("machinesAwake()"), { wait: "[data-sv-convhead]" }, { sleep: 1500 }, { click: "button[data-runner-device]" }, { wait: "[role=menu]", text: "acme-mac" }, { sleep: 600 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/machine-menu.webp",
  },
  {
    name: "remote-and-cloud-sessions/sync-chip",
    route: conv(MS.cloud._id),
    viewport: { width: 1280, height: 800 },
    steps: [open(MS.cloud._id), scene("machinesAwake()"), { wait: "[data-sv-convhead]" }, { sleep: 1500 }, { click: "button[data-local-mirror]" }, { wait: "[role=menu]", text: "Stop syncing" }, { sleep: 600 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/sync-chip.webp",
  },

  /* ── Usage limits ── */
  {
    name: "usage-limits/accounts",
    route: "/settings/claude-accounts",
    viewport: { width: 1280, height: 900 },
    steps: [{ wait: "body", text: "personal" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/usage-limits/accounts.webp",
  },
  {
    name: "usage-limits/recovery-mode",
    route: "/settings/claude-accounts",
    viewport: { width: 1280, height: 900 },
    steps: [{ wait: "body", text: "ask before switching" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/usage-limits/recovery-mode.webp",
  },

  /* ── Last: these put acme-linux to sleep ── */
  {
    name: "remote-and-cloud-sessions/devices",
    route: "/settings/devices",
    viewport: { width: 1280, height: 1000 },
    steps: [scene("linuxAsleep()"), { wait: "body", text: "Asleep" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/devices.webp",
  },
  {
    name: "remote-and-cloud-sessions/add-cloud-machine",
    route: "/settings/devices",
    viewport: { width: 1280, height: 1000 },
    steps: [{ click: "button", text: "Add a cloud machine" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/remote-and-cloud-sessions/add-cloud-machine.webp",
  },
  // Very last: the main page's setup card. It empties the inbox for the rest of the page's life: a fresh account in the Mac app (__acmeScene.fresh empties the inbox and stands in for the shell).
  {
    name: "app/connect",
    route: "/inbox",
    viewport: { width: 1280, height: 860 },
    steps: [scene("fresh()"), { wait: "button", text: "Set up this machine" }, { sleep: 900 }],
    crop: { selector: ".rounded-2xl.backdrop-blur-xl", pad: 32 },
    frame: "element",
    out: "public/docs/app/connect.webp",
  },
];
