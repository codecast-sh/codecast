// Sign in to a remote MCP server on this machine for a person on any device
// (shared/contracts/mcpLogin.ts has the round trip). The agent CLI's own login
// runs in a utility tmux pane with `--no-browser`: it prints the authorization
// URL and then waits for the OAuth redirect, either on its loopback callback
// (a browser on this machine finishes it alone) or pasted at its prompt. The
// pane reports the CLI's exit status on its last line, which is the outcome:
// both CLIs exit 0 only once the token is stored.
import { mcpLoginCallback, isMcpServerName, MCP_LOGIN_TIMEOUT_MS, type McpLoginClient } from "@codecast/shared/contracts";
import { pasteTextIntoPane } from "./tmuxPaste.js";
import { shellEscapeForSh } from "./supervision.js";

export const MCP_LOGIN_PANE = "mcp-login-flow";
const EXIT_MARK = "__cast_mcp_login_exit:";
const POLL_MS = 1500;

/** The pane's shell command. The trailing sleep keeps a finished CLI's last words capturable. */
export function mcpLoginPaneCommand(client: McpLoginClient, server: string, path: string, cwd?: string): string {
  if (!isMcpServerName(server)) throw new Error("That is not an MCP server name");
  const cd = cwd ? `cd ${shellEscapeForSh(cwd)} && ` : "";
  return `${cd}PATH=${shellEscapeForSh(path)} ${client} mcp login ${shellEscapeForSh(server)} --no-browser; echo "${EXIT_MARK}$?"; sleep 30`;
}

/** The authorization URL the CLI printed: the first https URL that carries an OAuth redirect. */
export function authorizationUrl(pane: string): string | undefined {
  for (const match of pane.matchAll(/https:\/\/\S+/g)) {
    if (/[?&]redirect_uri=/.test(match[0])) return match[0];
  }
  return undefined;
}

/** The CLI's exit status, once it has exited. */
export function paneExitCode(pane: string): number | undefined {
  const match = pane.match(new RegExp(`${EXIT_MARK}(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

/** The CLI's last meaningful line before it exited: the most honest reason a sign-in failed. */
export function failureReason(pane: string): string {
  const lines = pane
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !l.includes(EXIT_MARK) && !/^https?:\/\//.test(l) && !/(?:paste the redirect url here|callback url \(input hidden\)):\s*https?:\/\//i.test(l));
  // A CLI that gives up while waiting writes its error on the prompt's own line.
  const last = (lines[lines.length - 1] ?? "").replace(/^.*?(?:paste the redirect url here|callback url \(input hidden\)):\s*/i, "");
  return (last || "The sign-in stopped").slice(0, 200);
}

/**
 * What the CLI said after refusing a pasted address and asking for it again,
 * or undefined while it has not answered. Claude echoes the address and
 * re-prompts on a mismatch; a CLI that exits instead answers through its exit
 * status, and codex's hidden prompt never echoes, so it has no notice.
 */
export function refusalAfterPaste(pane: string, pasted: string): string | undefined {
  const at = pane.lastIndexOf(pasted);
  if (at < 0) return undefined;
  const lines = pane.slice(at + pasted.length).split("\n").map((l) => l.trim()).filter(Boolean);
  // A reply line, then the prompt again: the paste was read and refused.
  if (lines.length < 2 || !/paste|url/i.test(lines[lines.length - 1])) return undefined;
  return lines[0].slice(0, 200);
}

export interface McpLoginDeps {
  tmux: (args: string[]) => Promise<{ stdout: string }>;
  killPane: (name: string) => Promise<void>;
  startPane: (name: string, command: string) => Promise<void>;
  agentPath: () => string;
  reportUrl: (startedAt: number, url: string) => Promise<void>;
  reportNotice: (startedAt: number, notice: string) => Promise<void>;
  complete: (startedAt: number, status: "confirmed" | "rejected", reason?: string) => Promise<void>;
  log: (line: string) => void;
}

/** One machine runs one MCP sign-in at a time; a new one replaces the last. */
export class McpLoginFlow {
  private startedAt: number | undefined;
  /** The address last typed in, until the CLI answers it. */
  private pasted: string | undefined;

  constructor(private deps: McpLoginDeps) {}

  /** Handle one `mcp_login` command. Returns the command's result text. */
  async handle(args: Record<string, unknown>): Promise<string> {
    const startedAt = typeof args.started_at === "number" ? args.started_at : undefined;
    if (startedAt === undefined) throw new Error("mcp_login needs started_at");
    if (args.cancel === true) return this.cancel(startedAt);
    if (typeof args.callback === "string") return this.submit(startedAt, args.callback);
    const client = args.client === "claude" || args.client === "codex" ? args.client : undefined;
    if (!client || typeof args.server !== "string") throw new Error("mcp_login needs a client and a server");
    const cwd = typeof args.cwd === "string" && args.cwd.startsWith("/") ? args.cwd : undefined;
    return this.start(startedAt, client, args.server, cwd);
  }

  private async start(startedAt: number, client: McpLoginClient, server: string, cwd?: string): Promise<string> {
    if (this.startedAt !== undefined && startedAt < this.startedAt) return "superseded";
    this.startedAt = startedAt;
    this.pasted = undefined;
    try {
      await this.deps.startPane(MCP_LOGIN_PANE, mcpLoginPaneCommand(client, server, this.deps.agentPath(), cwd));
    } catch (err) {
      const reason = `Could not start the sign-in: ${err instanceof Error ? err.message : String(err)}`;
      await this.finish(startedAt, "rejected", reason);
      return reason;
    }
    this.deps.log(`[MCP-LOGIN] started \`${client} mcp login ${server}\` (tmux ${MCP_LOGIN_PANE})`);
    void this.watch(startedAt).catch((err) => this.deps.log(`[MCP-LOGIN] watcher failed: ${err instanceof Error ? err.message : String(err)}`));
    return "mcp_login_started";
  }

  private async submit(startedAt: number, callback: string): Promise<string> {
    if (startedAt !== this.startedAt) {
      // The daemon restarted under the sign-in: its CLI and watcher are gone.
      // Close the flow so the dialog says so instead of waiting out the clock.
      if (this.startedAt === undefined) await this.finish(startedAt, "rejected", "This machine restarted during the sign-in. Start again.");
      throw new Error("This sign-in has ended. Start again.");
    }
    const checked = mcpLoginCallback(callback);
    if ("error" in checked) throw new Error(checked.error);
    // Unbracketed: codex reads the address at a hidden-input prompt, where
    // paste markers would become part of it.
    await pasteTextIntoPane(this.deps.tmux, MCP_LOGIN_PANE, checked.url, false);
    await this.deps.tmux(["send-keys", "-t", MCP_LOGIN_PANE, "Enter"]);
    this.pasted = checked.url;
    return "callback_submitted";
  }

  private async cancel(startedAt: number): Promise<string> {
    if (startedAt !== this.startedAt) return "not_running";
    this.startedAt = undefined;
    await this.deps.killPane(MCP_LOGIN_PANE).catch(() => {});
    return "cancelled";
  }

  private async finish(startedAt: number, status: "confirmed" | "rejected", reason?: string): Promise<void> {
    this.deps.log(`[MCP-LOGIN] ${status}${reason ? `: ${reason}` : ""}`);
    if (this.startedAt === startedAt) this.startedAt = undefined;
    await this.deps.complete(startedAt, status, reason).catch((err) => this.deps.log(`[MCP-LOGIN] outcome report failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async watch(startedAt: number): Promise<void> {
    const deadline = Date.now() + MCP_LOGIN_TIMEOUT_MS;
    let reported = false;
    let pane = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      // Replaced by a newer sign-in or cancelled: the pane is not ours any more.
      if (this.startedAt !== startedAt) return;
      try {
        pane = (await this.deps.tmux(["capture-pane", "-p", "-J", "-S", "-200", "-t", MCP_LOGIN_PANE])).stdout;
      } catch {
        try {
          await this.deps.tmux(["has-session", "-t", MCP_LOGIN_PANE]);
          continue; // a slow tmux, not a dead pane
        } catch {
          return this.finish(startedAt, "rejected", pane ? failureReason(pane) : "The sign-in stopped");
        }
      }
      if (!reported) {
        const url = authorizationUrl(pane);
        if (url) {
          reported = true;
          await this.deps.reportUrl(startedAt, url).catch((err) => this.deps.log(`[MCP-LOGIN] url report failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      if (this.pasted) {
        const refusal = refusalAfterPaste(pane, this.pasted);
        if (refusal) {
          this.pasted = undefined;
          await this.deps.reportNotice(startedAt, refusal).catch((err) => this.deps.log(`[MCP-LOGIN] notice report failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      const code = paneExitCode(pane);
      if (code !== undefined) {
        await this.deps.killPane(MCP_LOGIN_PANE).catch(() => {});
        return this.finish(startedAt, code === 0 ? "confirmed" : "rejected", code === 0 ? undefined : failureReason(pane));
      }
    }
    if (this.startedAt !== startedAt) return;
    await this.deps.killPane(MCP_LOGIN_PANE).catch(() => {});
    return this.finish(startedAt, "rejected", "Timed out waiting for the sign-in");
  }
}
