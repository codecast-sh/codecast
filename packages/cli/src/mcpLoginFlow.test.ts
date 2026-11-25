import { describe, expect, test } from "bun:test";
import { authorizationUrl, failureReason, refusalAfterPaste, mcpLoginPaneCommand, McpLoginFlow, paneExitCode, type McpLoginDeps } from "./mcpLoginFlow.js";
import { mcpLoginCallback } from "@codecast/shared/contracts";

// What the two CLIs print with --no-browser (claude 2.1.330, codex 0.169.0).
const CLAUDE_PANE = `Starting authentication for "linear-server"…
Visit this URL to authorize:
  https://mcp.linear.app/authorize?response_type=code&client_id=x&code_challenge=y&redirect_uri=http%3A%2F%2Flocalhost%3A54470%2Fcallback&state=z
Waiting for authorization… (^C to cancel)
Or paste the redirect URL here: `;
const CODEX_PANE = `Authorize the MCP server by opening this URL in your browser:
https://mcp.linear.app/authorize?response_type=code&client_id=c&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A60740%2Fcallback&scope=read
After signing in, copy the full URL from your browser's address bar.
Callback URL (input hidden):`;

describe("pane reading", () => {
  test("finds the authorization URL each CLI prints", () => {
    expect(authorizationUrl(CLAUDE_PANE)).toStartWith("https://mcp.linear.app/authorize?");
    expect(authorizationUrl(CODEX_PANE)).toContain("redirect_uri=http%3A%2F%2F127.0.0.1");
    expect(authorizationUrl("see https://example.com/docs")).toBeUndefined();
  });

  test("reads the exit status and the CLI's last words", () => {
    expect(paneExitCode(CLAUDE_PANE)).toBeUndefined();
    expect(paneExitCode(`${CLAUDE_PANE}\nError: invalid_grant\n__cast_mcp_login_exit:1`)).toBe(1);
    expect(failureReason(`${CLAUDE_PANE}\nError: invalid_grant\n__cast_mcp_login_exit:1\n`)).toBe("Error: invalid_grant");
    // claude 2.1.330 giving up at its prompt (seen on a cloud host).
    expect(failureReason(`${CLAUDE_PANE}Couldn't complete authentication for "linear-server": Authentication timeout\n__cast_mcp_login_exit:1`))
      .toBe(`Couldn't complete authentication for "linear-server": Authentication timeout`);
  });

  test("the pane command escapes its inputs and refuses odd server names", () => {
    const cmd = mcpLoginPaneCommand("codex", "sentry", "/usr/bin", "/w/my repo");
    expect(cmd).toContain("cd '/w/my repo' && ");
    expect(cmd).toContain("codex mcp login 'sentry' --no-browser");
    expect(() => mcpLoginPaneCommand("claude", "x; rm -rf ~", "/usr/bin")).toThrow();
  });
});

describe("a refused paste", () => {
  // What claude 2.1.330 printed for an address with the wrong state.
  const pasted = "http://localhost:54470/callback?code=fake&state=wrong";
  test("is read once the CLI answers and asks again", () => {
    expect(refusalAfterPaste(`${CLAUDE_PANE}${pasted}`, pasted)).toBeUndefined();
    expect(refusalAfterPaste(`${CLAUDE_PANE}${pasted}\nThat doesn't look like a redirect URL for this sign-in — paste the full address from the browser page this sign-in opened.\nOr paste the redirect URL here: `, pasted))
      .toStartWith("That doesn't look like a redirect URL");
  });
});

describe("pasted address", () => {
  test("accepts the loopback callback with a code and refuses anything else", () => {
    expect(mcpLoginCallback(" http://localhost:54470/callback?code=abc&state=z ")).toEqual({ url: "http://localhost:54470/callback?code=abc&state=z" });
    expect("url" in mcpLoginCallback("http://127.0.0.1:60740/callback?error=access_denied")).toBe(true);
    expect("error" in mcpLoginCallback("https://evil.example/callback?code=abc")).toBe(true);
    expect("error" in mcpLoginCallback("http://localhost:1/callback")).toBe(true);
    expect("error" in mcpLoginCallback("not a url")).toBe(true);
  });
});

function harness() {
  let pane = "";
  const calls: string[][] = [];
  const reports: Array<[string, ...unknown[]]> = [];
  let alive = false;
  const deps: McpLoginDeps = {
    tmux: async (args) => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        if (!alive) throw new Error("no session");
        return { stdout: pane };
      }
      if (args[0] === "has-session" && !alive) throw new Error("no session");
      return { stdout: "" };
    },
    killPane: async () => { alive = false; },
    startPane: async () => { alive = true; },
    agentPath: () => "/usr/bin",
    reportUrl: async (startedAt, url) => { reports.push(["url", startedAt, url]); },
    reportNotice: async (startedAt, notice) => { reports.push(["notice", startedAt, notice]); },
    complete: async (startedAt, status, reason) => { reports.push(["complete", startedAt, status, reason]); },
    log: () => {},
  };
  return { deps, calls, reports, setPane: (p: string) => { pane = p; } };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
  expect(check()).toBe(true);
}

describe("McpLoginFlow", () => {
  test("reports the URL, types the pasted address, and confirms on exit 0", async () => {
    const h = harness();
    const flow = new McpLoginFlow(h.deps);
    h.setPane(CLAUDE_PANE);
    expect(await flow.handle({ started_at: 1, client: "claude", server: "linear-server" })).toBe("mcp_login_started");
    await until(() => h.reports.some((r) => r[0] === "url"));
    expect(await flow.handle({ started_at: 1, callback: "http://localhost:54470/callback?code=abc&state=z" })).toBe("callback_submitted");
    expect(h.calls.some((c) => c[0] === "send-keys" && c.includes("Enter"))).toBe(true);
    h.setPane(`${CLAUDE_PANE}\nAuthenticated.\n__cast_mcp_login_exit:0`);
    await until(() => h.reports.some((r) => r[0] === "complete"));
    expect(h.reports.find((r) => r[0] === "complete")).toEqual(["complete", 1, "confirmed", undefined]);
  });

  test("a pasted address for an ended sign-in is refused, and closes the flow after a restart", async () => {
    const h = harness();
    const flow = new McpLoginFlow(h.deps);
    await expect(flow.handle({ started_at: 7, callback: "http://localhost:1/callback?code=a" })).rejects.toThrow("ended");
    expect(h.reports[0]?.slice(0, 3)).toEqual(["complete", 7, "rejected"]);
  });

  test("cancel stops the watcher without reporting an outcome", async () => {
    const h = harness();
    const flow = new McpLoginFlow(h.deps);
    h.setPane(CODEX_PANE);
    await flow.handle({ started_at: 2, client: "codex", server: "linear" });
    expect(await flow.handle({ started_at: 2, cancel: true })).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 2000));
    expect(h.reports.filter((r) => r[0] === "complete")).toEqual([]);
  });
});
