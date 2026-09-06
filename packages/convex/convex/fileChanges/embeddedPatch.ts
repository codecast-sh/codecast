import { getApplyPatchInput } from "./applyPatchParser";

export const SHELL_TOOL_NAMES = new Set(["bash", "shell", "shell_command", "exec_command", "commandexecution", "run_shell_command"]);

export function getToolPatchInputs(tool: { name: string; input: string }): string[] {
  const name = tool.name.split(".").at(-1)!.toLowerCase();
  if (name === "apply_patch") return [getApplyPatchInput(tool.input)];
  if (name !== "exec" && !SHELL_TOOL_NAMES.has(name)) return [];
  let source = tool.input;
  try {
    const params = JSON.parse(tool.input);
    source = typeof params === "string" ? params : params?.input ?? params?.code ?? params?.script ?? params?.command ?? params?.cmd;
  } catch {}
  if (typeof source !== "string") return [];
  return name === "exec" ? embeddedApplyPatches(source) : shellApplyPatches(source);
}

export function embeddedApplyPatches(source: string): string[] {
  const patches: string[] = [];
  const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:tools|functions)\.apply_patch\s*\(\s*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g;
  let expectingPatch = false;
  let endOfCall = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (/^(?:tools|functions)\.apply_patch/.test(token)) {
      expectingPatch = true;
      endOfCall = match.index + token.length;
      continue;
    }
    if (expectingPatch && match.index === endOfCall && /^["'`]/.test(token) && /^\s*\)/.test(source.slice(match.index + token.length))) {
      const body = token.slice(1, -1);
      if (token[0] !== "`" || !/(^|[^\\])\$\{/.test(body)) {
        const decoded = body.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r?\n|[\s\S])/g, (_, escaped: string) => {
          if (/^[ux][\da-fA-F]+$/.test(escaped)) return String.fromCharCode(parseInt(escaped.slice(1), 16));
          return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r\n": "" } as Record<string, string>)[escaped] ?? escaped;
        });
        if (decoded.startsWith("*** Begin Patch")) patches.push(decoded);
      }
    }
    expectingPatch = false;
  }
  return patches;
}

export function shellApplyPatches(command: string): string[] {
  const patches: string[] = [];
  const heredoc = /(?:^|\n)([^\n]*?)<<\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\2(?=\s|$)/g;
  for (const match of command.matchAll(heredoc)) {
    const tool = match[1].split(/&&|\|\||;/).at(-1)?.trim();
    if (tool === "apply_patch" && match[3].startsWith("*** Begin Patch")) patches.push(match[3]);
  }
  return patches;
}
