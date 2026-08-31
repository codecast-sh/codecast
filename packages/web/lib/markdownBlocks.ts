// Split markdown at blank-line runs, but never inside a ``` / ~~~ fence.
// A body with no blank lines outside fences (one giant code fence, a long
// stack trace) comes back as ONE block equal to the input. A caller that
// recurses per block must therefore only recurse when the split made
// progress (blocks.length > 1) — each block is then strictly shorter than
// the input, so the recursion terminates. Recursing on a single-block
// result re-enters with the identical string and overflows the stack.
export function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let fenceMark = "";
  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) inFence = false;
    }
    if (!inFence && line.trim() === "" && cur.length > 0) {
      blocks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length > 0) blocks.push(cur.join("\n"));
  return blocks;
}
