const deadlineKey = "CODECAST_HIBERNATION_TEST_DEADLINE_MS";

export async function runHibernationChild(args: string[], timeoutMs: number) {
  const parentDeadline = Number(process.env[deadlineKey] ?? Infinity);
  const now = Date.now();
  const deadlineMs = Math.min(now + timeoutMs, parentDeadline - 2_000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error("Hibernation child deadline exhausted before spawn");
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    env: { ...process.env, [deadlineKey]: String(deadlineMs) },
    stdout: "pipe",
    stderr: "pipe",
    timeout: deadlineMs - now,
    killSignal: "SIGKILL",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { pid: child.pid, code, signalCode: child.signalCode, stdout, stderr, deadlineMs };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
