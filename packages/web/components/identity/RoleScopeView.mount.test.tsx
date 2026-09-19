// RoleScopeView at its two sizes (docs/architecture/org-roles-run-work.md R3),
// mounted in jsdom against the REAL store, so what is proven is what a person
// sees: the hover card's scope section and the role page's Scope tab are one
// rendering, both paint from the store's slices (the org tree, projects, plans,
// tasks, sessions) and follow an optimistic edit in the same tick, the card is
// one link with nothing clickable inside it, and the card still says something
// honest when the tree, or the enrichment, or both are missing.
// Run: bun components/identity/RoleScopeView.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { OrgRole, OrgTree } from "../org/orgTypes";

import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyRoleScopeView() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // The enrichment is the one thing not in the store: the test switches it.
  const env = { card: undefined as any };
  mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: env.card }) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));

  const { ORG_FIXTURE } = await import("../org/orgFixture");
  const { useInboxStore } = await import("../../store/inboxStore");
  const { createRoot } = await import("react-dom/client");
  const { RoleHoverContent } = await import("./RoleHoverCard");
  const { RoleScopeView } = await import("./RoleScopeView");
  const { useRoleScope } = await import("../../hooks/useRoleScope");

  const TEAM = "fixture-team";
  const WS = `team:${TEAM}`;
  const today = new Date().toISOString().slice(0, 10);
  const growth = ORG_FIXTURE.roles[0];
  const seo: OrgRole = {
    ...growth, _id: "fixture-role-seo", short_id: "or-2", name: "SEO lead", handle: "seo",
    scope: { project_ids: [], plan_ids: ["fixture-plan-seo"] }, reports_to: { kind: "role", role_id: growth._id },
    scope_names: { projects: [], plans: [{ id: "fixture-plan-seo", title: "SEO and AI citations", short_id: "pl-88" }] },
  };
  const tree: OrgTree = {
    ...ORG_FIXTURE,
    roles: [{ ...growth, scope: { ...growth.scope, plan_ids: [...growth.scope.plan_ids, "fixture-plan-loose"] }, scope_names: { ...growth.scope_names, plans: [...growth.scope_names.plans, { id: "fixture-plan-loose", title: "Pricing page rewrite", short_id: "pl-91" }] }, charter: "Owns organic search and paid search. Writes the weekly growth review.\n\nNever touches billing.", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 }, counters: { day: today, hands: 1, wakes: 3, tokens: 0 } }, seo],
  };
  const row = (r: any) => ({ workspace: WS, team_id: TEAM, updated_at: 1, ...r });
  const seed = async (patch: Record<string, unknown>) => act(async () => { useInboxStore.setState(patch as never); });
  await seed({
    currentUser: { _id: "fixture-user-me" },
    clientState: { ...(useInboxStore.getState().clientState as object), ui: { active_team_id: TEAM } },
    orgTree: tree,
    projects: { "fixture-project-growth": row({ _id: "fixture-project-growth", title: "Growth", short_id: "pr-4", status: "active", task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0 }) },
    plans: {
      "fixture-plan-seo": row({ _id: "fixture-plan-seo", title: "SEO and AI citations", short_id: "pl-88", status: "active", project_id: "fixture-project-growth" }),
      // In scope through nothing but the role naming it, and in no project.
      "fixture-plan-loose": row({ _id: "fixture-plan-loose", title: "Pricing page rewrite", short_id: "pl-91", status: "active" }),
    },
    tasks: {
      t1: row({ _id: "t1", short_id: "ct-1", title: "A", status: "open", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo", assignee: growth._id }),
      t2: row({ _id: "t2", short_id: "ct-2", title: "B", status: "in_progress", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo" }),
      t3: row({ _id: "t3", short_id: "ct-3", title: "C", status: "done", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo" }),
      // Another workspace's task on the same project id must never be counted.
      leak: { _id: "leak", short_id: "ct-9", title: "X", status: "open", project_id: "fixture-project-growth", workspace: "team:someone-else", team_id: "someone-else", updated_at: 1 },
    },
  });

  let root = createRoot(document.getElementById("root")!);
  const mount = async (node: React.ReactNode) => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(node as never));
  };
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const snapshot = { short_id: "or-1", name: "Head of Growth", handle: "growth" };

  // ── the card: painted from the store, no enrichment at all ──
  await mount(<RoleHoverContent role={snapshot} />);
  assert.ok(q('[data-role-scope="card"]'), "the hover card carries the scope view at card size");
  assert.deepEqual(qa("[data-scope-label]").map((el) => el.textContent), ["Projects", "Sessions", "Its job", "Reports to", "Under it", "Owns", "Daily limit"], "the sections, projects first");
  assert.equal(q('[data-scope-project="pr-4"] [data-scope-project-line]')!.textContent, "Growth · 2 open tasks · 1 done · lead", "a project by name, with its state, and that this role leads it");
  assert.equal(q('[data-scope-project="pr-4"] [data-scope-plan="pl-88"]')!.textContent, "SEO and AI citations · 1 of 3 done", "a plan sits inside its project, with live progress");
  assert.equal(qa('[data-scope-plan="pl-88"]').length, 1, "and nowhere beside it");
  assert.match(q("[data-scope-loose]")!.textContent!, /^Not in a projectPricing page rewrite/, "a plan in no project goes last, under its own heading");
  assert.match(q("[data-scope-sessions-line]")!.textContent!, /waiting on a person/, "sessions by who acts next, in plain words");
  assert.equal(q("[data-scope-charter]")!.textContent, "Owns organic search and paid search.", "the charter's first sentence only");
  assert.match(q('[data-scope-section="reports-to"]')!.textContent!, /Ashot Petrosian/);
  assert.match(q('[data-scope-section="reports"]')!.textContent!, /SEO lead/, "the roles under it");
  assert.equal(q("[data-scope-owned]")!.textContent, "1 open task: 1 open");
  assert.equal(q("[data-scope-limit]")!.textContent, "woke 3 of 40 times today · started 1 of 6 sessions", "today's use against the daily limit, never caps or hands");
  assert.ok(!/\bcaps?\b|\bhands?\b/i.test(q("[data-role-card]")!.textContent!), "the card never says caps or hands");
  // A click anywhere on the card opens the role: the card IS the link, so
  // nothing inside it may be a link, a button, or another card's trigger.
  const cardLink = q("[data-role-card]")!;
  assert.equal(cardLink.tagName, "A");
  assert.equal(cardLink.getAttribute("href"), "/org/or-1");
  assert.equal(cardLink.querySelectorAll("a, button").length, 0, "nothing clickable nests inside the card");

  // ── local first: an optimistic task edit moves the card in the same tick ──
  await seed({ tasks: { ...useInboxStore.getState().tasks, t2: { ...(useInboxStore.getState().tasks as any).t2, status: "done", updated_at: 2 } } });
  assert.equal(q('[data-scope-project="pr-4"] [data-scope-project-line]')!.textContent, "Growth · 1 open task · 2 done · lead");
  assert.equal(q('[data-scope-plan="pl-88"]')!.textContent, "SEO and AI citations · 2 of 3 done");

  // ── a session bound to a task in the project shows in that project's card ──
  const bound = growth.sessions.find((x) => x.state === "working") ?? growth.sessions[0];
  await seed({ tasks: { ...useInboxStore.getState().tasks, t1: { ...(useInboxStore.getState().tasks as any).t1, conversation_ids: [bound._id], updated_at: 3 } } });
  assert.match(q('[data-scope-project="pr-4"] [data-scope-project-sessions]')!.textContent!, /^1 /, "the sessions at work in the project, by who acts next");

  // ── a session the role put in front of the person leads the Sessions line ──
  const first = growth.sessions[0];
  await seed({ sessions: { ...useInboxStore.getState().sessions, [first._id]: { _id: first._id, session_id: first._id, updated_at: 1, escalated_by_role: { role_id: growth._id, line: "the pricing copy needs your eye", at: 1 } } } });
  assert.equal(q("[data-scope-escalated]")!.textContent, "1 in front of you: the pricing copy needs your eye");

  // ── the page: the same view at full size ──
  const opened: string[] = [];
  function Page() {
    const { model, escalated } = useRoleScope("or-1");
    return model ? (
      <RoleScopeView
        model={model}
        density="page"
        escalated={escalated}
        renderLead={(id) => <span data-test-lead={id} />}
        renderInitiative={(id) => <span data-test-initiative={id} />}
        onFilePlan={(planRef, projectId) => { opened.push(`file:${planRef}:${projectId}`); useInboxStore.getState().updatePlan(planRef, { project_id: projectId }); }}
        sessions={<div data-test-sessions />}
        onTab={(t) => opened.push(`tab:${t}`)}
        onOpenSession={(s) => opened.push(`open:${s._id}`)}
      />
    ) : null;
  }
  await mount(<Page />);
  assert.ok(q('[data-role-scope="page"]'));
  assert.deepEqual(qa("[data-scope-label]").map((el) => el.textContent), ["Projects", "Sessions", "Its job", "Reports to", "Under it", "Owns", "Daily limit"], "the page asks the same questions as the card");
  const projectCard = q('article[data-scope-project="pr-4"]')!;
  assert.equal(projectCard.querySelector("header a")!.getAttribute("href"), "/projects/pr-4", "a project card opens the project");
  assert.ok(projectCard.querySelector('[data-test-lead="fixture-project-growth"]'), "and carries the project's lead chip");
  assert.ok(projectCard.querySelector('[data-scope-project-initiative] [data-test-initiative="fixture-project-growth"]'), "and the initiative it belongs to");
  assert.equal(projectCard.querySelector("[data-scope-project-line]")!.textContent, "1 open task · 2 done", "open and done tasks");
  assert.ok(projectCard.querySelector("[data-scope-project-sessions]"), "the sessions active in it");
  assert.equal(projectCard.querySelector('[data-scope-plan="pl-88"] a')!.getAttribute("href"), "/plans/pl-88", "its plans are inside the card");
  // The last card: plans in no project, and the one gesture that files them.
  const loose = q("article[data-scope-loose]")!;
  assert.match(loose.textContent!, /Not in a project/);
  assert.ok(loose.querySelector('[data-scope-plan="pl-91"]'));
  assert.ok(loose.querySelector('[data-scope-file-plan="pl-91"]'), "each offers File under a project");
  assert.ok(loose.compareDocumentPosition(projectCard) & 2, "and it comes after the projects");
  assert.equal(q("[data-scope-charter]")!.textContent, "Owns organic search and paid search. Writes the weekly growth review.", "the page reads the whole first paragraph");
  // Escalated first, then the grouped sessions the page hands in.
  const sessionsSection = q('[data-scope-section="sessions"]')!;
  assert.ok(sessionsSection.querySelector("[data-scope-escalated]")!.compareDocumentPosition(sessionsSection.querySelector("[data-test-sessions]")!) & 4, "the escalated sessions come first");
  await click(sessionsSection.querySelector("[data-scope-escalated] button"));
  assert.equal(opened.pop(), `open:${first._id}`);
  await click(qa("button").find((b) => /^All \d+ sessions/.test(b.textContent ?? "")) ?? null);
  assert.equal(opened.pop(), "tab:sessions");
  await click(qa("button").find((b) => /Read the whole charter/.test(b.textContent ?? "")) ?? null);
  assert.equal(opened.pop(), "tab:charter");
  await click(q('[data-scope-owned-status="open"]'));
  assert.equal(opened.pop(), "tab:tasks");
  // A role named inside another role's scope opens its own page (and card).
  assert.equal(q('[data-scope-section="reports"] a')!.getAttribute("href"), "/org/or-2");

  // ── no tree: the enrichment stands in, and the rows still count ──
  await seed({ orgTree: null });
  env.card = {
    _id: growth._id, short_id: "or-1", name: "Head of Growth", handle: "growth", avatar: "fox", status: "active", trust: "decide", tenure: { kind: "standing" },
    charter: "Owns organic search.", reports_to: { kind: "user", name: "Ashot Petrosian" },
    scope: { projects: [{ id: "fixture-project-growth", title: "Growth", short_id: "pr-4" }], plans: [] },
    caps: null, counters: null, last_wake_at: null,
  };
  await mount(<RoleHoverContent role={snapshot} />);
  assert.match(q('[data-scope-project="pr-4"]')!.textContent!, /^Growth · 1 open task/, "the card names the project; the store still counts its tasks");
  assert.equal(q('[data-scope-section="sessions"]'), null, "sessions are the tree's to say: without it the card says nothing rather than zero");
  assert.match(q("[data-role-card]")!.textContent!, /decides in its area/);

  // ── neither: a face and a name, never an error ──
  env.card = undefined;
  await mount(<RoleHoverContent role={snapshot} />);
  assert.equal(q("[data-role-scope]"), null);
  assert.match(q("[data-role-card]")!.textContent!, /Head of Growth@growth/);
  assert.ok(q("[data-role-card] img"), "the face is there");

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("role scope view, both densities: ok");
}

test("the role scope view mounts", verifyRoleScopeView, 600_000);
