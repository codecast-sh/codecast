import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConvexHttpClient } from "convex/browser";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const INBOX_DIR = path.join(CONFIG_DIR, "inbox");
const CONVEX_URL = process.env.CONVEX_URL || "https://marvelous-meerkat-539.convex.cloud";

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

export async function runClaudeWrapper(args: string[]): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token) {
    console.error("Error: Not authenticated. Run 'codecast auth' first.");
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

  try {
    await client.mutation("managedSessions:registerManagedSession" as any, {
      session_id: sessionId,
      pid: process.pid,
      api_token: config.auth_token,
    });
    log(`Registered managed session`);
  } catch (err) {
    log(`Warning: Failed to register managed session: ${err}`);
  }

  const ttyPath = getTtyPath();
  log(`TTY path: ${ttyPath || "none"}`);

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

  const injectMessage = (content: string): boolean => {
    if (!ttyPath) {
      log("No TTY path available for injection");
      return false;
    }

    try {
      const fd = fs.openSync(ttyPath, "w");
      fs.writeSync(fd, content + "\n");
      fs.closeSync(fd);
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

        if (injectMessage(msg.content)) {
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

  const sendHeartbeat = async () => {
    try {
      await client.mutation("managedSessions:heartbeat" as any, {
        session_id: sessionId,
        api_token: config.auth_token,
      });
    } catch {
      // Ignore heartbeat errors
    }
  };

  pollInterval = setInterval(pollForMessages, 2000);
  heartbeatInterval = setInterval(sendHeartbeat, 30000);

  const linkConversation = async (claudeSessionId: string) => {
    if (conversationId) return;

    try {
      const result = await client.query("managedSessions:getConversationBySessionId" as any, {
        claude_session_id: claudeSessionId,
        api_token: config.auth_token,
      });

      if (result?.conversation_id) {
        conversationId = result.conversation_id;
        log(`Found conversation: ${conversationId}`);

        await client.mutation("managedSessions:updateSessionConversation" as any, {
          session_id: sessionId,
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
        session_id: sessionId,
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
