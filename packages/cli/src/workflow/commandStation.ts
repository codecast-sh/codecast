// A command station: a script the run's shell expands and runs, and the
// record every node's result lands in.
import { spawn } from "../proc.js";
import { lineCommandEnv } from "../lineProfile.js";
import { c } from "../colors.js";
import { extractJsonOutput, lookupContextVar } from "./condition";
import { keepEnds } from "./keepEnds";
import type { NodeOutcome, WorkflowNode } from "./types";

export function contextVar(context: Record<string, string>, key: string): string | undefined {
  if (key === "human_message") return context["human.message"] ?? "";
  if (key.endsWith(".output")) return lookupContextVar(context, key) ?? "";
  return lookupContextVar(context, key);
}


// Every node's result lands under `<id>.output` (capped for prompts, both ends kept). When the
// result is JSON, or ends in a fenced json block, the parsed value is kept
// whole under `<id>.json` so `$<id>.json.<path>` and conditions can read its
// fields past the output cap.
const NODE_JSON_CAP = 64_000;
export function recordNodeOutput(context: Record<string, string>, nodeId: string, text: string, jsonSource = text): void {
  context[`${nodeId}.output`] = keepEnds(text, 4000);
  const parsed = extractJsonOutput(jsonSource);
  const json = parsed === undefined ? undefined : JSON.stringify(parsed);
  if (json !== undefined && json.length <= NODE_JSON_CAP) context[`${nodeId}.json`] = json;
  else delete context[`${nodeId}.json`];
}

// $var in a script expands like $var in a prompt, but each value is quoted
// for the place it lands, so a task title with shell metacharacters stays
// data: single-quoted in bare words, backslash-escaped inside "...", and
// with its own quotes escaped inside '...'. A single-quoted value inside
// double quotes would keep its quotes ("origin/$default_branch" read as the
// ref origin/'main', and the line's red check fell back to a stale local
// main). `$(` and `${` are left to the shell (no \w follows the `$`).
// A dotted name ($scan.json.count) expands when the whole name resolves;
// otherwise only its first word does and the rest stays literal text.
export function expandScriptVars(script: string, context: Record<string, string>): string {
  const resolve = (key: string): { value: string; rest: string } | null => {
    const parts = key.split(".");
    for (let n = parts.length; n >= 1; n--) {
      const value = contextVar(context, parts.slice(0, n).join("."));
      if (value !== undefined) return { value, rest: parts.slice(n).map(p => `.${p}`).join("") };
    }
    return null;
  };
  // The shell's quoting as it stands at each `$`: a stack of bare (the top
  // level and every `$(`, counting its own parentheses), "..." and '...'.
  type Frame = { q: "bare"; parens: number } | { q: "dq" } | { q: "sq" };
  const stack: Frame[] = [{ q: "bare", parens: 0 }];
  const quoted = (q: Frame["q"], value: string) =>
    q === "dq" ? value.replace(/[\\"$`]/g, "\\$&")
    : q === "sq" ? value.replace(/'/g, `'\\''`)
    : `'${value.replace(/'/g, `'\\''`)}'`;
  let out = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const top = stack[stack.length - 1];
    if (top.q === "sq") {
      if (ch === "'") stack.pop();
    } else if (ch === "\\") {
      out += script.slice(i, i + 2);
      i++;
      continue;
    } else if (ch === "$" && script[i + 1] === "(") {
      stack.push({ q: "bare", parens: 0 });
      out += "$(";
      i++;
      continue;
    } else if (ch === '"') {
      if (top.q === "dq") stack.pop();
      else stack.push({ q: "dq" });
    } else if (top.q === "bare") {
      if (ch === "'") stack.push({ q: "sq" });
      else if (ch === "(") top.parens++;
      else if (ch === ")" && stack.length > 1 && top.parens-- === 0) stack.pop();
      else if (ch === "#" && (i === 0 || /\s/.test(script[i - 1]))) {
        const end = script.indexOf("\n", i);
        out += script.slice(i, end === -1 ? undefined : end);
        i = end === -1 ? script.length : end - 1;
        continue;
      }
    }
    if (ch === "$") {
      const name = /^\w+(?:\.\w+)*/.exec(script.slice(i + 1))?.[0];
      const hit = name ? resolve(name) : null;
      if (hit) {
        out += quoted(top.q, hit.value) + hit.rest;
        i += name!.length;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export async function executeCommand(
  node: WorkflowNode,
  context: Record<string, string>,
  cwd: string
): Promise<NodeOutcome> {
  const script = expandScriptVars(node.script!, context);
  console.log(`${c.dim}  $ ${script.split('\n')[0]}${script.includes('\n') ? '...' : ''}${c.reset}`);

  try {
    // A repo's check command (the line's verify station) outruns the old two
    // minute cap on most repos; a timeout read as a failed check and burned an
    // implement visit. Per node, in seconds.
    const timeoutMs = (node.timeout ?? 120) * 1000;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn("bash", ["-c", script], {
        cwd,
        // A project's line command (line-profile.md LP2) names run values
        // ($run_dir, $task_id, ...) that its own shell expands.
        env: { ...process.env, ...lineCommandEnv(context) },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so the timeout takes the script's children
        // with it. spawnSync's timeout sent one SIGTERM to bash alone, and on
        // CI the script sometimes ran to its end and passed anyway.
        detached: process.platform !== "win32",
      });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, timeoutMs);
      child.stdout!.on("data", (d) => { stdout += d; });
      child.stderr!.on("data", (d) => { stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
    });

    const output = result.stdout + result.stderr + (result.timedOut ? `\ntimed out after ${timeoutMs / 1000}s` : "");
    if (output.trim()) {
      console.log(c.dim + keepEnds(output, 2000) + c.reset);
    }

    recordNodeOutput(context, node.id, output.trim(), result.stdout);
    context[`${node.id}.exit_code`] = String(result.status ?? 0);

    if (result.status === 0 && !result.timedOut) {
      console.log(`  ${c.green}✓ success${c.reset}`);
      return "success";
    } else {
      console.log(`  ${c.red}✗ failed (${result.timedOut ? "timed out" : `exit ${result.status}`})${c.reset}`);
      context["last_error"] = keepEnds(output.trim(), 2000);
      return "failure";
    }
  } catch (err: any) {
    console.log(`  ${c.red}✗ error: ${err.message}${c.reset}`);
    recordNodeOutput(context, node.id, err.message);
    return "failure";
  }
}
