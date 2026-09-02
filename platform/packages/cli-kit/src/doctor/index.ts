// A small framework for `<cli> doctor`. Ported from the shape of codecast's
// packages/cli/src/doctor.ts: each check records a name, a status, a one line
// detail, and an optional timing; the runner collects them and the formatter
// prints one line per check plus a verdict. The product supplies the checks.
// Codecast's own checks (auth, device, daemon, convex, sync backlog, cursor
// sync, client self tests, the tmux end to end loop) stay in codecast.

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  ok: boolean;
  /** One line a human can act on. Name the fix when there is one. */
  detail: string;
  /** The command or action that repairs the problem. */
  fix?: string;
  /** Downgrade a failure to a warning (ok=false, still healthy overall). */
  warn?: boolean;
  /** Record a skipped check (ok is ignored). */
  skip?: boolean;
}

export interface DoctorCheck {
  name: string;
  run: () => CheckResult | Promise<CheckResult>;
  /** Skip this check when an earlier one named here failed. */
  dependsOn?: string[];
  /** Milliseconds before the check is recorded as failed. */
  timeoutMs?: number;
}

export interface DoctorCheckRecord {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  elapsedMs: number;
}

export interface DoctorReport {
  ok: boolean;
  product: string;
  version: string;
  checks: DoctorCheckRecord[];
}

export interface RunDoctorOptions {
  product: string;
  version: string;
  /** Called as each check completes, for streaming output. */
  onCheck?: (record: DoctorCheckRecord) => void;
  now?: () => number;
}

function statusOf(result: CheckResult): CheckStatus {
  if (result.skip) return "skip";
  if (result.ok) return "pass";
  return result.warn ? "warn" : "fail";
}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined, name: string): Promise<T> {
  if (!ms) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run checks in order. A thrown error is a failure with the message as the
 *  detail. A check whose dependency failed is skipped, not run. */
export async function runDoctor(checks: DoctorCheck[], opts: RunDoctorOptions): Promise<DoctorReport> {
  const now = opts.now ?? (() => Date.now());
  const records: DoctorCheckRecord[] = [];
  const failed = new Set<string>();
  for (const check of checks) {
    const blocker = check.dependsOn?.find((d) => failed.has(d));
    const start = now();
    let record: DoctorCheckRecord;
    if (blocker) {
      record = { name: check.name, status: "skip", detail: `skipped: ${blocker} failed`, elapsedMs: 0 };
    } else {
      try {
        const result = await withTimeout(Promise.resolve(check.run()), check.timeoutMs, check.name);
        record = {
          name: check.name,
          status: statusOf(result),
          detail: result.detail,
          fix: result.fix,
          elapsedMs: now() - start,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record = { name: check.name, status: "fail", detail: msg, elapsedMs: now() - start };
      }
    }
    if (record.status === "fail") failed.add(check.name);
    records.push(record);
    opts.onCheck?.(record);
  }
  return {
    ok: !records.some((r) => r.status === "fail"),
    product: opts.product,
    version: opts.version,
    checks: records,
  };
}

export interface FormatOptions {
  /** Wrap glyphs and muted text in color. Default: identity. */
  color?: {
    success?: (s: string) => string;
    warning?: (s: string) => string;
    error?: (s: string) => string;
    muted?: (s: string) => string;
  };
  /** Show timings at or above this many milliseconds. Default 1000. */
  timingThresholdMs?: number;
  nameWidth?: number;
}

const GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatCheckLine(record: DoctorCheckRecord, opts: FormatOptions = {}): string {
  const id = (s: string) => s;
  const c = { success: id, warning: id, error: id, muted: id, ...opts.color };
  const paint = { pass: c.success, warn: c.warning, fail: c.error, skip: c.muted }[record.status];
  const width = opts.nameWidth ?? 22;
  const threshold = opts.timingThresholdMs ?? 1000;
  const timing = record.elapsedMs >= threshold ? c.muted(`  ${(record.elapsedMs / 1000).toFixed(1)}s`) : "";
  const fix = record.fix && record.status !== "pass" && record.status !== "skip" ? c.muted(` — ${record.fix}`) : "";
  return `  ${paint(GLYPH[record.status])} ${record.name.padEnd(width)} ${record.detail}${fix}${timing}`;
}

/** The whole report as text: a header, one line per check, a verdict. */
export function formatDoctorReport(report: DoctorReport, opts: FormatOptions = {}): string {
  const id = (s: string) => s;
  const c = { success: id, warning: id, error: id, muted: id, ...opts.color };
  const lines = [
    "",
    c.muted(`  ${report.product} Doctor  (v${report.version})`),
    "",
    ...report.checks.map((r) => formatCheckLine(r, opts)),
    "",
    report.ok
      ? `  ${c.success(`✓ ${report.product.toLowerCase()} is healthy`)}`
      : `  ${c.error("✗ problems found")} ${c.muted("— details above")}`,
    "",
  ];
  return lines.join("\n");
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
