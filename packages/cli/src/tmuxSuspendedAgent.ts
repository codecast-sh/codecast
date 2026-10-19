import { execFileAsync } from "./proc.js";
import { isRecognizedAgentComm } from "./sessionProcessMatcher.js";

type Exec = (args: string[], options?: { timeout?: number; killSignal?: string }) => Promise<{ stdout: string }>;
type Process = { pid: number; ppid: number; pgid: number; foreground: number; state: string; command: string };

export function terminalProcesses(text: string): Process[] {
  return text.split("\n").flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], foreground: +m[4], state: m[5], command: m[6] }] : [];
  });
}

export function suspendedAgent(rows: Process[], shellPid: number, sessionId: string): Process | undefined {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) return;
  const shell = rows.find(row => row.pid === shellPid);
  if (!shell || shell.pgid !== shell.foreground || !/^-?(?:\S*\/)?(?:bash|zsh)(?:\s|$)/.test(shell.command)) return;
  const agents = rows.filter(row => row.ppid === shellPid && row.state.startsWith("T") &&
    row.foreground === shell.pgid && isRecognizedAgentComm(row.command.split(/\s+/)[0]) &&
    row.command.split(/\s+/).some((word, i, words) => word === sessionId && ["--resume", "--session-id", "resume"].includes(words[i - 1])));
  return agents.length === 1 ? agents[0] : undefined;
}

export async function restoreSuspendedAgent(target: string, exec: Exec): Promise<boolean> {
  const { stdout } = await exec(["display-message", "-p", "-t", target, "#{pane_pid}|#{pane_current_command}|#{pane_tty}|#{@codecast_session_id}"], { timeout: 3000 });
  const [pidText, command, tty, id] = stdout.trim().split("|");
  if (!/^(bash|zsh)$/.test(command)) return false;
  const shellPid = Number(pidText);
  if (!Number.isSafeInteger(shellPid) || shellPid <= 1 || !/^\/dev\/[\w/]+$/.test(tty ?? "") || !/^[a-f0-9-]{36}$/.test(id ?? "")) return false;
  const { stdout: children } = await execFileAsync("pgrep", ["-P", String(shellPid)], { timeout: 3000 }).catch(error => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  const pids = children.trim().split(/\s+/).filter(p => /^\d+$/.test(p));
  if (!pids.length) return false;
  const read = async () => terminalProcesses((await execFileAsync("ps", ["-ww", "-p", [pidText, ...pids].join(","), "-o", "pid=,ppid=,pgid=,tpgid=,stat=,command="], { timeout: 3000 })).stdout);
  const agent = suspendedAgent(await read(), shellPid, id);
  if (!agent) return false;
  const { stdout: pane } = await exec(["capture-pane", "-p", "-J", "-t", target, "-S", "-12"], { timeout: 3000 });
  if (!/[$%#>:]$/.test(pane.trimEnd()) || !pane.includes("Stopped") || !pane.includes(id)) {
    throw new Error("AGENT_STDIN_NOT_READY: agent is suspended; terminal is not at an empty shell prompt");
  }
  if (suspendedAgent(await read(), shellPid, id)?.pid !== agent.pid) throw new Error("AGENT_STDIN_NOT_READY: suspended agent changed before recovery");
  await exec(["send-keys", "-t", target, "-l", `fg '%?${id}'`]);
  await exec(["send-keys", "-t", target, "Enter"]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = (await read()).find(row => row.pid === agent.pid);
    if (current?.command === agent.command && current.ppid === shellPid && current.pgid === agent.pgid && current.foreground === agent.pgid && !current.state.startsWith("T")) {
      await execFileAsync("stty", [process.platform === "darwin" ? "-f" : "-F", tty, "raw", "-echo"], { timeout: 3000 });
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("AGENT_STDIN_NOT_READY: suspended agent has not regained its terminal");
}
