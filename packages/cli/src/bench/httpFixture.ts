import { spawn, type ChildProcessWithoutNullStreams } from "../proc.js";
import { fileURLToPath } from "node:url";

export async function startFakeHttp(root: string, socket: string, options: { entrypoint?: string; startupTimeoutMs?: number; onSpawn?: (child: ChildProcessWithoutNullStreams) => void } = {}) {
  const child = spawn("node", [options.entrypoint ?? fileURLToPath(new URL("./fixtures/http.cjs", import.meta.url)), root, socket], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let port: number;
  try {
    options.onSpawn?.(child);
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`fake HTTP startup failed: ${stderr}`)); }, options.startupTimeoutMs ?? 5000);
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); if (/^\d+\n$/.test(output)) { clearTimeout(timer); resolve(Number(output.trim())); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`fake HTTP exited ${code}: ${stderr}`)); });
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw error;
  }
  return { port, child, async close() { child.stdin.end(); await exited; if (child.exitCode !== 0) throw new Error(`fake HTTP shutdown ${child.exitCode}`); } };
}
