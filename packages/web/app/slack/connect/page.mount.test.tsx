import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let auth = { isAuthenticated: false, isLoading: false };
let actionCalls: Array<{ code: string; state: string }> = [];
let answer: () => Promise<any>;
let providerOptions: any;
let providerStarts: string[];
const complete = async (args: { code: string; state: string }) => { actionCalls.push(args); return answer(); };
const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useConvexAuth: () => auth, useAction: () => complete }));
mock.module("next/navigation", () => ({
  useRouter: () => {
    const navigate = useNavigate();
    return React.useMemo(() => ({ replace: (url: string) => navigate(url, { replace: true }), push: (url: string) => navigate(url) }), [navigate]);
  },
  useSearchParams: () => new URLSearchParams(useLocation().search),
}));
mock.module("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
mock.module("../../../lib/localAuth", () => ({ useLocalAuth: () => false }));
const platform = await import("@platform/auth/web");
mock.module("@platform/auth/web", () => ({ ...platform, useProviderSignIn: (options: any) => {
  providerOptions = options;
  return { buttons: ["github", "apple"].map((id) => ({ id, label: id, iconPath: "" })), start: async (id: string) => { providerStarts.push(id); }, loading: false };
} }));
const authReact = await import("@convex-dev/auth/react");
mock.module("@convex-dev/auth/react", () => ({ ...authReact, useAuthActions: () => ({ signIn: async () => { auth = { isAuthenticated: true, isLoading: false }; return {}; } }) }));
const { default: SlackConnect } = await import("./page");
const { default: Login } = await import("../../login/page");
const { clearSlackReturn, readSlackReturn, stashSlackReturn, SLACK_RETURN_KEY, SLACK_SIGN_IN_URL } = await import("../../../lib/slackReturn");
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = () => act(async () => root.render(<React.StrictMode><BrowserRouter><Routes>
  <Route path="/slack/connect" element={<SlackConnect />} />
  <Route path="/login" element={<Login />} />
  <Route path="/settings/integrations" element={<h1>Integrations</h1>} />
</Routes></BrowserRouter></React.StrictMode>));
function arrive(search = "?code=slack-code&state=signed-state") {
  window.history.replaceState(null, "", "/slack/connect" + search);
  stashSlackReturn();
}

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  auth = { isAuthenticated: false, isLoading: false };
  actionCalls = [];
  providerStarts = [];
  answer = async () => ({ ok: true, return_to: "/settings/integrations" });
  arrive();
});
afterEach(async () => {
  await act(async () => root.unmount());
  const pending = readSlackReturn("");
  if (pending) clearSlackReturn(pending);
  sessionStorage.clear();
  localStorage.clear();
});

describe("Slack callback and sign-in", () => {
  test("waits for confirmed authentication and exchanges exactly once under StrictMode", async () => {
    auth = { isAuthenticated: false, isLoading: true };
    await render();
    expect(actionCalls).toEqual([]);
    expect(window.location.pathname).toBe("/slack/connect");
    auth = { isAuthenticated: true, isLoading: false };
    await render();
    await flush();
    expect(actionCalls).toEqual([{ code: "slack-code", state: "signed-state" }]);
    expect(window.location.pathname + window.location.search).toBe("/settings/integrations?slack=connected");
    expect(sessionStorage.getItem(SLACK_RETURN_KEY)).toBeNull();
  });

  test("signed-out return displays sign-in, keeps Slack data, then resumes after authentication", async () => {
    await render();
    await flush();
    expect(window.location.pathname + window.location.search).toBe(SLACK_SIGN_IN_URL);
    expect(document.body.textContent).toContain("account that started this Slack connection");
    expect(actionCalls).toEqual([]);
    expect(readSlackReturn("")?.code).toBe("slack-code");
    auth = { isAuthenticated: true, isLoading: false };
    await render();
    await flush();
    expect(actionCalls).toHaveLength(1);
    expect(window.location.pathname).toBe("/settings/integrations");
  });

  test("resumes a stored return after a full sign-in reload", async () => {
    const pending = readSlackReturn("")!;
    clearSlackReturn(pending, null);
    window.history.replaceState(null, "", "/slack/connect");
    auth = { isAuthenticated: true, isLoading: false };
    await render();
    await flush();
    expect(actionCalls).toEqual([{ code: "slack-code", state: "signed-state" }]);
    expect(sessionStorage.getItem(SLACK_RETURN_KEY)).toBeNull();
  });

  test("an authenticated return can finish with memory alone when storage is blocked", async () => {
    sessionStorage.removeItem(SLACK_RETURN_KEY);
    auth = { isAuthenticated: true, isLoading: false };
    await render();
    await flush();
    expect(actionCalls).toHaveLength(1);
    expect(window.location.pathname).toBe("/settings/integrations");
  });

  test("keeps existing return parameters and fragments", async () => {
    auth = { isAuthenticated: true, isLoading: false };
    answer = async () => ({ ok: true, return_to: "/settings/integrations?scope=team#slack" });
    await render();
    await flush();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/settings/integrations?scope=team&slack=connected#slack");
  });

  test.each(["github", "apple"])("%s sign-in returns through login so its code cannot replace Slack's", async (provider) => {
    await render();
    await flush();
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(`with ${provider}`))!;
    await act(async () => button.click());
    expect(providerStarts).toEqual([provider]);
    expect(providerOptions.redirectTo).toBe(SLACK_SIGN_IN_URL);
    window.history.replaceState(null, "", providerOptions.redirectTo + "&code=login-code");
    expect(stashSlackReturn()).toBeNull();
    expect(readSlackReturn("")?.code).toBe("slack-code");
    window.history.replaceState(null, "", SLACK_SIGN_IN_URL);
    auth = { isAuthenticated: true, isLoading: false };
    await render();
    await flush();
    expect(actionCalls).toEqual([{ code: "slack-code", state: "signed-state" }]);
  });

  test.each(["access_denied", "missing"])("shows %s without requiring login or sending an exchange", async (reason) => {
    if (reason === "access_denied") arrive("?error=access_denied&state=signed-state");
    else arrive("?code=slack-code");
    await render();
    expect(document.body.textContent).toContain("Slack was not connected");
    expect(actionCalls).toEqual([]);
    expect(window.location.pathname).toBe("/slack/connect");
    expect(sessionStorage.getItem(SLACK_RETURN_KEY)).toBeNull();
  });

  test.each(["bad_state", "wrong_user", "not_admin", "workspace_taken", "invalid_code", "code_already_used", "wrong_workspace", "no_user_token"])("shows server refusal %s without claiming success", async (error) => {
    auth = { isAuthenticated: true, isLoading: false };
    answer = async () => ({ ok: false, error, return_to: "/settings/integrations" });
    await render();
    await flush();
    expect(document.body.textContent).toContain("Slack was not connected");
    expect(actionCalls).toHaveLength(1);
    expect(window.location.pathname).toBe("/slack/connect");
    expect(sessionStorage.getItem(SLACK_RETURN_KEY)).toBeNull();
  });

  test("shows a transport failure with a path to restart", async () => {
    auth = { isAuthenticated: true, isLoading: false };
    answer = async () => { throw new Error("offline"); };
    await render();
    await flush();
    expect(document.body.textContent).toContain("Slack did not accept the install");
    await act(async () => document.querySelector("button")!.click());
    expect(window.location.pathname).toBe("/settings/integrations");
  });

  test("refuses external success destinations", async () => {
    auth = { isAuthenticated: true, isLoading: false };
    answer = async () => ({ ok: true, return_to: "https://other.test/steal" });
    await render();
    await flush();
    expect(window.location.href).toBe("https://codecast.test/settings/integrations?slack=connected");
  });

  test("explains unavailable storage instead of losing the request at sign-in", async () => {
    const pending = readSlackReturn("")!;
    sessionStorage.removeItem(SLACK_RETURN_KEY);
    await render();
    expect(document.body.textContent).toContain("browser could not save this connection");
    expect(actionCalls).toEqual([]);
    expect(window.location.pathname).toBe("/slack/connect");
    clearSlackReturn(pending);
  });
});
