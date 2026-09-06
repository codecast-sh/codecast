export const WORKER_KINDS = ["probe", "scan", "ingest"] as const;
export type WorkerKind = typeof WORKER_KINDS[number];
export type ProbeOperation = "ps" | "tmux" | "lsappinfo" | "launchctl" | "keychain";
export type ProbeOptions = { timeout?: number; maxBuffer?: number; killSignal?: string; encoding?: string; cwd?: string; env?: Record<string, string | undefined> };
export type ProbePayload = { operation: ProbeOperation; args: string[]; options: ProbeOptions };
export type ProbeResult = { status: number | null; signal: string | null; code?: string; killed: boolean; stdout: string; stderr: string };
const safeText = (s: unknown, max = 4096): s is string => typeof s === "string" && s.length <= max && !/[\0\r\n]/.test(s);
const target = (s: string) => /^=?[A-Za-z0-9_.$%:@/+-]+$/.test(s);
const fields = new Set(["pid", "session_name", "session_id", "session_created", "session_attached", "session_activity", "session_path", "session_windows", "window_index", "window_id", "window_name", "window_active", "window_panes", "pane_id", "pane_index", "pane_pid", "pane_tty", "pane_current_command", "pane_current_path", "pane_dead", "pane_active", "pane_width", "pane_height", "cursor_x", "cursor_y", "@codecast_session_id", "@codecast_conversation_id"]);
export function safeTmuxFormat(format: string): boolean {
  if (!safeText(format, 2048)) return false;
  const remainder = format.replace(/#\{([^{}]+)\}/g, (whole, field) => fields.has(field) ? "" : whole);
  return !/[#;\\]/.test(remainder);
}
export function validTmuxRead(args: string[]): boolean {
  const a = [...args];
  if (a[0] === "-L" || a[0] === "-S") {
    if (!a[1] || !target(a[1])) return false;
    a.splice(0, 2);
  }
  const op = a.shift();
  if (op === "-V") return a.length === 0;
  if (!op || !["list-sessions", "list-panes", "list-windows", "capture-pane", "display-message", "show-options", "has-session"].includes(op)) return false;
  const bools: Record<string, string> = { "list-sessions": "", "list-panes": "as", "list-windows": "a", "capture-pane": "peJqN", "display-message": "p", "show-options": "qvg", "has-session": "" };
  let printed = false;
  let positional = 0;
  const seen = new Set<string>();
  for (let i = 0; i < a.length; i++) {
    const token = a[i];
    if (token === "-t" || token === "-F" || token === "-S" || token === "-E") {
      if (seen.has(token)) return false;
      seen.add(token);
      const v = a[++i];
      if (!v) return false;
      if (token === "-t" && !target(v)) return false;
      if (token === "-F" && (!["list-sessions", "list-panes", "list-windows", "display-message"].includes(op) || !safeTmuxFormat(v))) return false;
      if ((token === "-S" || token === "-E") && (op !== "capture-pane" || !/^(?:-|[-+]?\d{1,7})$/.test(v))) return false;
    } else if (/^-[A-Za-z]+$/.test(token) && [...token.slice(1)].every(c => bools[op].includes(c))) {
      if (token.includes("p")) printed = true;
    } else if (op === "display-message" && !positional++ && safeTmuxFormat(token)) {
      if (seen.has("-F")) return false;
    } else if (op === "show-options" && !positional++ && /^@codecast_[a-z_]+$/.test(token)) {
      continue;
    } else return false;
  }
  if (op === "capture-pane" || op === "display-message") return printed;
  if (op === "show-options") return positional === 1;
  return true;
}
const psShapes = new Set([
  JSON.stringify(["aux"]), JSON.stringify(["-axo", "pid=,ppid="]), JSON.stringify(["-axo", "pid=,ppid=,args="]),
  JSON.stringify(["-eo", "pid=,ppid=,pcpu=,rss=,etime="]), JSON.stringify(["-axww", "-o", "pid=,ppid=,uid=,command="]),
]);
export function validProbePayload(value: unknown): value is ProbePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as ProbePayload;
  if (Object.keys(p).some(k => !["operation", "args", "options"].includes(k))) return false;
  if (!Array.isArray(p.args) || p.args.length > 32 || !p.args.every(a => safeText(a))) return false;
  const a = p.args;
  let valid = false;
  switch (p.operation) {
    case "ps": valid = psShapes.has(JSON.stringify(a)) || (a.length === 4 && a[0] === "-p" && /^\d{1,10}$/.test(a[1]) && a[2] === "-o" && ["command=", "comm=", "pid=,ppid=", "pid=,ppid=,command=", "lstart=,uid=,command="].includes(a[3])); break;
    case "tmux": valid = validTmuxRead(a); break;
    case "lsappinfo": valid = (a.length === 1 && a[0] === "front") || (a.length === 4 && a[0] === "info" && a[1] === "-only" && a[2] === "pid" && /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(a[3])); break;
    case "launchctl": valid = a.length === 2 && a[0] === "print" && /^(?:gui|user)\/\d+\/[A-Za-z0-9_.-]+$/.test(a[1]); break;
    case "keychain": valid = a.length === 4 && a[0] === "find-generic-password" && a[1] === "-s" && safeText(a[2], 256) && a[2].length > 0 && a[3] === "-w"; break;
  }
  const o = p.options;
  if (!valid || !o || typeof o !== "object" || Array.isArray(o)) return false;
  if (Object.keys(o).some(k => !["timeout", "maxBuffer", "killSignal", "encoding", "cwd", "env"].includes(k))) return false;
  if (o.timeout !== undefined && (!Number.isInteger(o.timeout) || o.timeout <= 0 || o.timeout > 60_000)) return false;
  if (o.maxBuffer !== undefined && (!Number.isInteger(o.maxBuffer) || o.maxBuffer <= 0 || o.maxBuffer > 64 * 1024 * 1024)) return false;
  if (o.killSignal !== undefined && !["SIGKILL", "SIGTERM"].includes(o.killSignal)) return false;
  if (o.encoding !== undefined && !["utf-8", "utf8"].includes(o.encoding)) return false;
  if (o.cwd !== undefined && !safeText(o.cwd)) return false;
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== "object" || Array.isArray(o.env) || Object.keys(o.env).length > 512) return false;
    if (!Object.entries(o.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (v === undefined || typeof v === "string" && v.length <= 32768 && !v.includes("\0")))) return false;
    if (JSON.stringify(o.env).length > 131072) return false;
  }
  return true;
}
export function probeForExec(file: string, args: string[], options: unknown): ProbePayload | null {
  const operation = ({ ps: "ps", tmux: "tmux", lsappinfo: "lsappinfo", launchctl: "launchctl", security: "keychain" } as const)[file];
  if (!operation) return null;
  const payload = { operation, args, options: options ?? {} };
  return validProbePayload(payload) ? payload : null;
}
export function validProbeResult(r: unknown): r is ProbeResult {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const p = r as ProbeResult;
  return Object.keys(p).every(k => ["status", "signal", "code", "killed", "stdout", "stderr"].includes(k)) &&
    (p.status === null || Number.isInteger(p.status) && p.status >= 0 && p.status <= 255) &&
    (p.signal === null || typeof p.signal === "string" && /^SIG[A-Z0-9]+$/.test(p.signal)) &&
    (p.code === undefined || typeof p.code === "string" && /^[A-Z0-9_]+$/.test(p.code)) &&
    typeof p.killed === "boolean" && typeof p.stdout === "string" && typeof p.stderr === "string";
}
