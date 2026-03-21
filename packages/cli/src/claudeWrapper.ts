import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConvexHttpClient } from "convex/browser";
import { hasTmux } from "./tmux.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const INBOX_DIR = path.join(CONFIG_DIR, "inbox");
const CONVEX_URL = process.env.CONVEX_URL || "https://convex.codecast.sh";

interface Config {
  auth_token?: string;
  user_id?: string;
  convex_url?: string;
}

function readConfig(): Config | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    return null;
  }
  return null;
}

function ensureInboxDir(): void {
  if (!fs.existsSync(INBOX_DIR)) {
    fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  }
}

const LOG_FILE = "/tmp/codecast-claude.log";

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[codecast-claude ${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function getTtyPath(): string | null {
  try {
    const tty = execSync("tty", { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] }).trim();
    if (tty && tty !== "not a tty" && fs.existsSync(tty)) {
      return tty;
    }
  } catch {
    // Fall through to alternative methods
  }

  if (process.stdin.isTTY) {
    try {
      const psOutput = execSync(`ps -p ${process.pid} -o tty=`, { encoding: "utf-8" }).trim();
      if (psOutput && psOutput !== "?" && psOutput !== "??") {
        const ttyPath = psOutput.startsWith("/dev/") ? psOutput : `/dev/${psOutput}`;
        if (fs.existsSync(ttyPath)) {
          return ttyPath;
        }
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

function getTmuxPane(): string | null {
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    return tmuxPane;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePollMessage(content: string): { keys?: string[]; steps?: Array<{ key: string; text?: string }>; text?: string; display?: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps))) return parsed;
  } catch {}
  return null;
}

export async function runClaudeWrapper(args: string[]): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token) {
    console.error("Error: Not authenticated. Run 'cast auth' first.");
    process.exit(1);
  }

  ensureInboxDir();

  const claudePath = findClaudeBinary();
  if (!claudePath) {
    console.error("Error: Could not find 'claude' binary in PATH");
    process.exit(1);
  }

  log(`Starting managed Claude session`);
  log(`Claude binary: ${claudePath}`);
  log(`Args: ${args.join(" ")}`);

  const sessionId = extractSessionIdFromArgs(args) || generateSessionId();
  log(`Session ID: ${sessionId}`);

  const client = new ConvexHttpClient(config.convex_url || CONVEX_URL);

  let tmuxSessionName: string | undefined;
  if (process.env.TMUX) {
    try {
      tmuxSessionName = execSync("tmux display-message -p '#{session_name}'", { timeout: 2000 }).toString().trim();
    } catch {}
  }

  try {
    await client.mutation("managedSessions:registerManagedSession" as any, {
      session_id: sessionId,
      pid: process.pid,
      tmux_session: tmuxSessionName,
      api_token: config.auth_token,
    });
    log(`Registered managed session${tmuxSessionName ? ` (tmux: ${tmuxSessionName})` : ""}`);
  } catch (err) {
    log(`Warning: Failed to register managed session: ${err}`);
  }

  const ttyPath = getTtyPath();
  log(`TTY path: ${ttyPath || "none"}`);

  // Check if we're already in tmux
  const existingTmuxPane = getTmuxPane();
  tmuxSessionName = null;

  // If not in tmux, create a tmux session for reliable message injection
  if (!existingTmuxPane && process.stdin.isTTY && hasTmux()) {
    tmuxSessionName = `codecast-${sessionId.slice(0, 8)}`;
    log(`Not in tmux, creating session: ${tmuxSessionName}`);

    // Create tmux session and run claude inside it
    const tmuxCmd = [
      "tmux", "new-session", "-d", "-s", tmuxSessionName, "-n", "claude",
      claudePath, ...args
    ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");

    try {
      execSync(`tmux new-session -d -s '${tmuxSessionName}' -n claude -x 200 -y 50`, { stdio: "ignore" });
      const envVars = `CODECAST_MANAGED_SESSION='${sessionId}' CODECAST_SESSION_ID='${sessionId}'`;
      execSync(`tmux send-keys -t '${tmuxSessionName}' "${envVars} ${claudePath} ${args.map(a => `'${a}'`).join(' ')}" Enter`, { stdio: "ignore" });
      log(`Created tmux session and started Claude`);

      // Attach to the tmux session
      const attach = spawn("tmux", ["attach-session", "-t", tmuxSessionName], {
        stdio: "inherit",
      });

      attach.on("exit", async (code) => {
        log(`Tmux attach exited with code ${code}`);
        // Clean up tmux session
        try {
          execSync(`tmux kill-session -t '${tmuxSessionName}'`, { stdio: "ignore" });
        } catch {}
        process.exit(code ?? 0);
      });

      // Set up message polling with tmux injection
      const pollForMessages = async () => {
        try {
          const messages = await client.query("managedSessions:getPendingMessagesForSession" as any, {
            session_id: sessionId,
            api_token: config.auth_token,
          });

          for (const msg of messages as any[]) {
            log(`Delivering message: ${msg.content.slice(0, 50)}...`);
            try {
              const poll = parsePollMessage(msg.content);
              if (poll) {
                const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
                for (const step of steps) {
                  if (step.text) {
                    execSync(`tmux send-keys -t '${tmuxSessionName}' Escape`, { stdio: "ignore" });
                    await sleep(500);
                    const escapedText = step.text.replace(/'/g, "'\\''");
                    execSync(`tmux send-keys -t '${tmuxSessionName}' -l '${escapedText}'`, { stdio: "ignore" });
                    await sleep(150);
                    execSync(`tmux send-keys -t '${tmuxSessionName}' Enter`, { stdio: "ignore" });
                    await sleep(500);
                  } else {
                    execSync(`tmux send-keys -t '${tmuxSessionName}' '${step.key}'`, { stdio: "ignore" });
                    await sleep(500);
                  }
                }
                if (poll.text) {
                  await sleep(300);
                  const escapedText = poll.text.replace(/'/g, "'\\''");
                  execSync(`tmux send-keys -t '${tmuxSessionName}' -l '${escapedText}'`, { stdio: "ignore" });
                  await sleep(150);
                  execSync(`tmux send-keys -t '${tmuxSessionName}' Enter`, { stdio: "ignore" });
                }
                log(`Injected poll response via tmux to session ${tmuxSessionName}`);
              } else {
                const escapedContent = msg.content.replace(/'/g, "'\\''");
                execSync(`tmux send-keys -t '${tmuxSessionName}' '${escapedContent}'`, { stdio: "ignore" });
                await sleep(100);
                execSync(`tmux send-keys -t '${tmuxSessionName}' Enter`, { stdio: "ignore" });
                log(`Injected via tmux send-keys to session ${tmuxSessionName}`);
              }

              await client.mutation("managedSessions:markMessageDelivered" as any, {
                message_id: msg._id,
                api_token: config.auth_token,
              });
              log(`Message delivered and marked`);
            } catch (err) {
              log(`Failed to inject: ${err}`);
            }
          }
        } catch {}
      };

      let activeSessionId = sessionId;

      const sendHeartbeat = async () => {
        try {
          await client.mutation("managedSessions:heartbeat" as any, {
            session_id: activeSessionId,
            api_token: config.auth_token,
          });
        } catch {}
      };

      setInterval(pollForMessages, 2000);
      setInterval(sendHeartbeat, 30000);

      // Watch for conversation ID and discover real session ID
      const claudeDir = path.join(os.homedir(), ".claude", "projects");
      if (fs.existsSync(claudeDir)) {
        let conversationId: string | null = null;
        let realSessionDiscovered = false;
        const watcher = fs.watch(claudeDir, { recursive: true }, async (_eventType, filename) => {
          if (!filename || !filename.endsWith(".jsonl") || conversationId) return;
          const match = filename.match(/([0-9a-f-]{36})\.jsonl$/);
          if (match) {
            const claudeSessionId = match[1];
            log(`Session file detected: ${claudeSessionId}`);

            // Rename tmux session to use real session ID
            if (!realSessionDiscovered && claudeSessionId !== sessionId && tmuxSessionName) {
              realSessionDiscovered = true;
              const newTmuxName = `codecast-${claudeSessionId.slice(0, 8)}`;
              try {
                execSync(`tmux rename-session -t '${tmuxSessionName}' '${newTmuxName}' 2>/dev/null`, { stdio: "ignore" });
                log(`Renamed tmux session ${tmuxSessionName} -> ${newTmuxName}`);
                tmuxSessionName = newTmuxName;
              } catch (err) {
                log(`Failed to rename tmux session: ${err}`);
              }

              // Re-register managed session with real ID
              try {
                await client.mutation("managedSessions:updateManagedSessionId" as any, {
                  old_session_id: sessionId,
                  new_session_id: claudeSessionId,
                  api_token: config.auth_token,
                });
                activeSessionId = claudeSessionId;
                log(`Updated managed session ID: ${sessionId.slice(0, 8)} -> ${claudeSessionId.slice(0, 8)}`);
              } catch (err) {
                log(`Failed to update managed session ID: ${err}`);
              }
            }

            setTimeout(async () => {
              try {
                const result = await client.query("managedSessions:getConversationBySessionId" as any, {
                  claude_session_id: claudeSessionId,
                  api_token: config.auth_token,
                });
                if (result?.conversation_id && !conversationId) {
                  conversationId = result.conversation_id;
                  log(`Found conversation: ${conversationId}`);
                  const activeSessionId = realSessionDiscovered ? claudeSessionId : sessionId;
                  await client.mutation("managedSessions:updateSessionConversation" as any, {
                    session_id: activeSessionId,
                    conversation_id: conversationId,
                    api_token: config.auth_token,
                  });
                  log(`Linked managed session to conversation`);
                }
              } catch {}
            }, 2000);
          }
        });
        attach.on("exit", () => watcher.close());
      }

      return; // Early return - tmux handles everything
    } catch (err) {
      log(`Failed to create tmux session: ${err}`);
      // Fall through to direct spawn
    }
  }

  const claude = spawn(claudePath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CODECAST_MANAGED_SESSION: sessionId,
      CODECAST_SESSION_ID: sessionId,
    },
  });

  let conversationId: string | null = null;
  let pollInterval: NodeJS.Timeout | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;

  const tmuxPane = getTmuxPane();
  log(`Tmux pane: ${tmuxPane || "none"}`);

  const injectMessage = async (content: string): Promise<boolean> => {
    if (tmuxPane) {
      try {
        const poll = parsePollMessage(content);
        if (poll) {
          const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
          for (const step of steps) {
            if (step.text) {
              execSync(`tmux send-keys -t ${tmuxPane} Escape`, { stdio: "ignore" });
              await sleep(500);
              const escapedText = step.text.replace(/'/g, "'\\''");
              execSync(`tmux send-keys -t ${tmuxPane} -l '${escapedText}'`, { stdio: "ignore" });
              await sleep(150);
              execSync(`tmux send-keys -t ${tmuxPane} Enter`, { stdio: "ignore" });
              await sleep(500);
            } else {
              execSync(`tmux send-keys -t ${tmuxPane} '${step.key}'`, { stdio: "ignore" });
              await sleep(500);
            }
          }
          if (poll.text) {
            await sleep(300);
            const escapedText = poll.text.replace(/'/g, "'\\''");
            execSync(`tmux send-keys -t ${tmuxPane} -l '${escapedText}'`, { stdio: "ignore" });
            await sleep(150);
            execSync(`tmux send-keys -t ${tmuxPane} Enter`, { stdio: "ignore" });
          }
          log(`Injected poll response via tmux to pane ${tmuxPane}`);
        } else {
          const escapedContent = content.replace(/'/g, "'\\''");
          execSync(`tmux send-keys -t ${tmuxPane} '${escapedContent}'`, { stdio: "ignore" });
          await sleep(100);
          execSync(`tmux send-keys -t ${tmuxPane} Enter`, { stdio: "ignore" });
          log(`Injected via tmux send-keys to pane ${tmuxPane}`);
        }
        return true;
      } catch (err) {
        log(`Failed to inject via tmux: ${err}`);
        return false;
      }
    }

    if (!ttyPath) {
      log("No TTY path or tmux pane available for injection");
      return false;
    }

    try {
      const fd = fs.openSync(ttyPath, "w");
      fs.writeSync(fd, content + "\n");
      fs.closeSync(fd);
      log("Injected via TTY file write");
      return true;
    } catch (err) {
      log(`Failed to inject message: ${err}`);
      return false;
    }
  };

  const pollForMessages = async () => {
    try {
      const messages = await client.query("managedSessions:getPendingMessagesForSession" as any, {
        session_id: sessionId,
        api_token: config.auth_token,
      });

      for (const msg of messages as any[]) {
        log(`Delivering message: ${msg.content.slice(0, 50)}...`);

        if (await injectMessage(msg.content)) {
          await client.mutation("managedSessions:markMessageDelivered" as any, {
            message_id: msg._id,
            api_token: config.auth_token,
          });
          log(`Message delivered and marked`);
        }
      }
    } catch {
      // Ignore errors during polling
    }
  };

  let activeSessionId = sessionId;

  const sendHeartbeat = async () => {
    try {
      await client.mutation("managedSessions:heartbeat" as any, {
        session_id: activeSessionId,
        api_token: config.auth_token,
      });
    } catch {
      // Ignore heartbeat errors
    }
  };

  pollInterval = setInterval(pollForMessages, 2000);
  heartbeatInterval = setInterval(sendHeartbeat, 30000);

  const updateSessionIdIfNeeded = async (claudeSessionId: string) => {
    if (claudeSessionId === sessionId || activeSessionId !== sessionId) return;
    try {
      await client.mutation("managedSessions:updateManagedSessionId" as any, {
        old_session_id: sessionId,
        new_session_id: claudeSessionId,
        api_token: config.auth_token,
      });
      activeSessionId = claudeSessionId;
      log(`Updated managed session ID: ${sessionId.slice(0, 8)} -> ${claudeSessionId.slice(0, 8)}`);
    } catch (err) {
      log(`Failed to update managed session ID: ${err}`);
    }
  };

  const linkConversation = async (claudeSessionId: string) => {
    if (conversationId) return;

    await updateSessionIdIfNeeded(claudeSessionId);

    try {
      const result = await client.query("managedSessions:getConversationBySessionId" as any, {
        claude_session_id: claudeSessionId,
        api_token: config.auth_token,
      });

      if (result?.conversation_id) {
        conversationId = result.conversation_id;
        log(`Found conversation: ${conversationId}`);

        await client.mutation("managedSessions:updateSessionConversation" as any, {
          session_id: activeSessionId,
          conversation_id: conversationId,
          api_token: config.auth_token,
        });
        log(`Linked managed session to conversation`);
      }
    } catch (err) {
      log(`Failed to link conversation: ${err}`);
    }
  };

  const watchForConversationId = () => {
    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeDir)) return;

    const watcher = fs.watch(claudeDir, { recursive: true }, async (_eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl") || conversationId) return;

      const match = filename.match(/([0-9a-f-]{36})\.jsonl$/);
      if (match) {
        const claudeSessionId = match[1];
        log(`Session file detected: ${claudeSessionId}`);

        setTimeout(() => linkConversation(claudeSessionId), 2000);
      }
    });

    claude.on("exit", () => watcher.close());
  };

  watchForConversationId();

  process.on("SIGINT", () => {
    log("Received SIGINT, forwarding to Claude");
    claude.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    log("Received SIGTERM, forwarding to Claude");
    claude.kill("SIGTERM");
  });

  claude.on("exit", async (code, signal) => {
    log(`Claude exited with code ${code}, signal ${signal}`);

    if (pollInterval) clearInterval(pollInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    try {
      await client.mutation("managedSessions:unregisterManagedSession" as any, {
        session_id: activeSessionId,
        api_token: config.auth_token,
      });
      log(`Unregistered managed session`);
    } catch (err) {
      log(`Warning: Failed to unregister session: ${err}`);
    }

    process.exit(code ?? 0);
  });

  claude.on("error", (err) => {
    console.error(`Failed to start Claude: ${err.message}`);
    process.exit(1);
  });
}

function findClaudeBinary(): string | null {
  const pathEnv = process.env.PATH || "";
  const paths = pathEnv.split(path.delimiter);

  for (const p of paths) {
    const candidate = path.join(p, "claude");
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  const commonPaths = [
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    path.join(os.homedir(), ".local/bin/claude"),
    path.join(os.homedir(), ".npm/bin/claude"),
  ];

  for (const candidate of commonPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractSessionIdFromArgs(args: string[]): string | null {
  const resumeIndex = args.indexOf("--resume");
  if (resumeIndex !== -1 && args[resumeIndex + 1]) {
    return args[resumeIndex + 1];
  }

  for (const arg of args) {
    if (arg.startsWith("--resume=")) {
      return arg.split("=")[1];
    }
  }

  return null;
}

function generateSessionId(): string {
  const hex = () => Math.random().toString(16).slice(2, 10);
  return `${hex()}${hex()}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex()}${hex()}${hex().slice(0, 4)}`;
}
