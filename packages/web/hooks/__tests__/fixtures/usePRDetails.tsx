import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../../test-helpers/globals";
import { useInboxStore } from "../../../store/inboxStore";
import { flushSyncPublishes } from "../../../store/syncTransaction";
import { usePullRequest } from "../../useSyncTimeline";
import { usePRDetails } from "../../usePRDetails";
import { PRCommits } from "../../../components/pr/PRCommits";
import { PRChecks } from "../../../components/pr/PRChecks";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document,
  navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.getElementById("root")!;
let root: Root;
let requests: Array<{ args: any; resolve: () => void; reject: (error: Error) => void }>;
const client: any = { action(ref: any, args: any) {
  expect(getFunctionName(ref)).toBe("prDetails:refresh");
  return new Promise<void>((resolve, reject) => requests.push({ args, resolve, reject }));
} };
const store = () => useInboxStore.getState();
const seed = { _id: "pr1", repository: "acme/repo", number: 42, title: "PR", head_sha: "head", commits_count: 2 };
const commits = [{ sha: "head", message: "Fix the missing details", author_name: "Ada" }];
const checks = [{ name: "Tests", status: "in_progress", external_id: "1", updated_at: 1 }];

function Probe({ tab }: { tab: "commits" | "checks" | null }) {
  const pr = usePullRequest("acme/repo", 42);
  const read = usePRDetails(pr?._id, pr?.head_sha, tab);
  return tab === "commits" ? <PRCommits repository="acme/repo" commits={pr?.commits} read={read} />
    : tab === "checks" ? <PRChecks checks={pr?.checks} read={read} /> : <p>Conversation</p>;
}
const render = async (tab: "commits" | "checks" | null) => {
  await act(async () => { root.render(<ConvexProvider client={client}><MemoryRouter><Probe tab={tab} /></MemoryRouter></ConvexProvider>); });
};
const sync = async (fields: Record<string, unknown>) => {
  await act(async () => {
    store().syncRecord("pullRequests", "pr1", { ...store().pullRequests.pr1, ...fields });
    flushSyncPublishes();
  });
};

beforeEach(() => {
  requests = [];
  store().syncTable("pullRequests", [seed], { isDelta: false });
  flushSyncPublishes();
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); });
afterAll(() => { dom.window.close(); restore(); });

test("opening Commits requests data and the synced rows replace loading", async () => {
  await render(null);
  expect(requests).toHaveLength(0);
  await render("commits");
  expect(requests[0].args).toEqual({ pr_id: "pr1", section: "commits" });
  expect(container.textContent).toContain("Loading commits");
  expect(container.textContent).not.toContain("No commits");
  await sync({ commits });
  await act(async () => { requests[0].resolve(); });
  expect(container.textContent).toContain("Fix the missing details");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/commit/acme/repo/head");
  expect(container.textContent).not.toContain("Loading commits");
});

test("a failed read shows retry, and retry can load checks", async () => {
  await render("checks");
  await act(async () => { requests[0].reject(new Error("GitHub returned 403")); });
  expect(container.querySelector("[role=alert]")?.textContent).toContain("GitHub returned 403");
  expect(container.textContent).not.toContain("No checks");
  await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
  expect(requests).toHaveLength(2);
  expect(container.textContent).toContain("Loading checks");
  await sync({ checks });
  await act(async () => { requests[1].resolve(); });
  expect(container.textContent).toContain("Tests");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

test("cached checks remain visible during refresh and same-count updates repaint", async () => {
  await sync({ checks, checks_state: "pending" });
  await render("checks");
  expect(container.textContent).toContain("Tests");
  expect(container.textContent).toContain("in progress");
  await sync({ checks: [{ ...checks[0], name: "Renamed test", status: "completed", conclusion: "success" }] });
  expect(container.textContent).toContain("Renamed test");
  expect(container.textContent).toContain("success");
  expect(container.textContent).not.toContain("in progress");
  await act(async () => { requests[0].reject(new Error("Offline")); });
  expect(container.textContent).toContain("Renamed test");
  expect(container.textContent).toContain("Offline");
});

test("switching tabs ignores a late error from the previous tab", async () => {
  await render("commits");
  await render("checks");
  await act(async () => { requests[0].reject(new Error("Old commit failure")); });
  expect(container.textContent).toContain("Loading checks");
  expect(container.textContent).not.toContain("Old commit failure");
  await sync({ checks: [] });
  await act(async () => { requests[1].resolve(); });
  expect(container.textContent).toContain("No checks on this pull request");
  expect(container.textContent).not.toContain("permission");
});

test("a new head refreshes the selected tab and same-count commits repaint", async () => {
  await sync({ commits });
  await render("commits");
  await act(async () => { requests[0].resolve(); });
  await sync({ head_sha: "new-head", commits: [{ ...commits[0], sha: "new-head", message: "Rebased fix" }] });
  expect(requests).toHaveLength(2);
  expect(container.textContent).toContain("Rebased fix");
  expect(container.textContent).not.toContain("Fix the missing details");
});
