// The coworker banner and the admin's Coworkers section, over the four states
// convex/teamDiscovery.ts answers: nothing to show, an unproven address (code
// flow), a team to ask into, and a request already pending; plus the admin
// switch and a request to let in.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "HTMLInputElement", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { getFunctionName } = await import("convex/server");
let answers: Record<string, any> = {};
const calls: Array<[string, any]> = [];
mock.module("../../hooks/useQueryNoThrow", () => ({
  useQueryNoThrow: (ref: any) => ({ data: answers[getFunctionName(ref)], error: undefined, retry() {} }),
}));
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: (ref: any) => async (args: any) => { const name = getFunctionName(ref); calls.push([name, args]); return answers[`${name}:result`] ?? {}; },
  // The admin section asks for its coworkers line once, as a one-shot query.
  useConvex: () => ({ query: async (ref: any) => answers[getFunctionName(ref)] ?? null }),
}));

const { TeamDomainBanner } = await import("../TeamDomainBanner");
const { TeamDomainAccess } = await import("../settings/TeamDomainAccess");

let root: Root;
const render = (el: any) => act(async () => root.render(el));
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const click = (label: string) => act(async () => { button(label)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  answers = {};
  calls.length = 0;
});
afterEach(async () => { await act(async () => root.unmount()); });

test("nothing to show renders nothing", async () => {
  answers["teamDiscovery:teamsForMyDomain"] = null;
  await render(<TeamDomainBanner />);
  expect(text()).toBe("");
});

test("an unproven address is offered a code, then proves it", async () => {
  answers["teamDiscovery:teamsForMyDomain"] = { domain: "acme.dev", needs_proof: true, teams: [] };
  await render(<TeamDomainBanner />);
  expect(text()).toContain("Someone at @acme.dev may already be on codecast");
  expect(text()).not.toContain("Acme");
  await click("Email me a code");
  expect(calls.map(([n]) => n)).toEqual(["teamDiscovery:sendWorkEmailCode"]);
  const input = document.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "123456");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await click("Confirm");
  expect(calls[1]).toEqual(["teamDiscovery:confirmWorkEmailCode", { code: "123456" }]);
});

test("a proven coworker sees the team and asks to join", async () => {
  answers["teamDiscovery:teamsForMyDomain"] = { domain: "acme.dev", needs_proof: false, teams: [{ _id: "t1", name: "Acme", member_count: 5, request: "none" }] };
  await render(<TeamDomainBanner />);
  expect(text()).toContain("Acme is on codecast (5 people from @acme.dev)");
  await click("Ask to join");
  expect(calls).toEqual([["teamDiscovery:requestToJoin", { team_id: "t1" }]]);
});

test("a pending request says an admin will let them in", async () => {
  answers["teamDiscovery:teamsForMyDomain"] = { domain: "acme.dev", needs_proof: false, teams: [{ _id: "t1", name: "Acme", member_count: 5, request: "pending" }] };
  await render(<TeamDomainBanner />);
  expect(text()).toContain("Asked. An admin will let you in.");
  expect(button("Ask to join")).toBeUndefined();
});

test("the admin turns finding on and lets a request in", async () => {
  answers["teamDiscovery:discoverySettings"] = { enabled_domain: null, admin_domain: "acme.dev", admin_domain_proven: true };
  answers["teamDiscovery:pendingRequests"] = [{ _id: "r1", user_id: "u2", name: "Cy", email: "cy@acme.dev", image: null, created_at: 1 }];
  await render(<TeamDomainAccess teamId={"t1" as any} />);
  expect(text()).toContain("Let @acme.dev coworkers find this team");
  expect(text()).toContain("cy@acme.dev asked to join");
  const sw = document.querySelector("[role=switch]")!;
  await act(async () => { sw.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
  await click("Let in");
  expect(calls).toEqual([
    ["teamDiscovery:setDiscoverable", { team_id: "t1", enabled: true }],
    ["teamDiscovery:decideRequest", { request_id: "r1", approve: true }],
  ]);
});

test("an admin on a personal address cannot open the team", async () => {
  answers["teamDiscovery:discoverySettings"] = { enabled_domain: null, admin_domain: null, admin_domain_proven: false };
  answers["teamDiscovery:pendingRequests"] = [];
  await render(<TeamDomainAccess teamId={"t1" as any} />);
  expect(text()).toContain("personal address");
  expect(document.querySelector("[role=switch]")!.hasAttribute("disabled") || document.querySelector("[role=switch]")!.getAttribute("data-disabled") !== null).toBe(true);
});
