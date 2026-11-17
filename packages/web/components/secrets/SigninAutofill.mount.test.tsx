// The Vault's Sign-ins from Chrome switch: off, a press opens the review and
// its confirm turns it on for the laptop picked there; on, one press turns it
// off. Run: cd packages/web && bun test components/secrets/SigninAutofill.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost:3200/vault", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "FocusEvent", "sessionStorage", "localStorage", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const sets: unknown[] = [];
let grant: { device_id: string } | null = null;
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: () => async (args: unknown) => (sets.push(args), { ok: true }),
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, grant])),
}));
const laptops = [
  { device_id: "main", label: "Ashot Main Mac", online: true },
  { device_id: "second", label: "Ashot Second Mac", online: true },
];
const deviceBadge = await import("../DeviceBadge");
mock.module("../DeviceBadge", () => ({ ...deviceBadge, useDevices: () => ({ onlineLocals: laptops, devices: laptops }) }));

const { SigninAutofill } = await import("./SaveSignin");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");
afterAll(() => closeDomWindow(dom.window as any));

const team = { id: "team-1", name: "Union" };
const trigger = () => document.querySelector<HTMLButtonElement>("[data-vault-signin-autofill] button")!;
const press = (el: Element) => act(async () => (el as HTMLElement).click());

test("off: the review names who signs in as you and on which laptop; its confirm turns it on there", async () => {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<SigninAutofill team={team} asked={40} />));
  expect(trigger().textContent).toBe("Sign-ins from Chrome");
  await press(trigger());
  const review = document.querySelector("[data-switch-review]")!;
  expect(review.textContent).toContain("40");
  expect(review.textContent).toContain("Any an agent asks for");
  const second = [...review.querySelectorAll("button")].find((b) => b.textContent === "Ashot Second Mac");
  expect(second).toBeDefined();
  await press(second!);
  await press([...review.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Turn on"))!);
  expect(sets).toEqual([{ team_id: "team-1", device_id: "second" }]);
  await act(async () => root.unmount());
});

test("on: it names the laptop, and one press turns it off with no review", async () => {
  sets.length = 0;
  grant = { device_id: "main" };
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<SigninAutofill team={team} asked={0} />));
  expect(trigger().textContent).toBe("Sign-ins from Chrome on Ashot Main Mac");
  await press(trigger());
  expect(document.querySelector("[data-switch-review]")).toBeNull();
  expect(sets).toEqual([{ team_id: "team-1" }]);
  await act(async () => root.unmount());
});
