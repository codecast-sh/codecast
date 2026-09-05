import { open } from "node:fs/promises";

export async function readCodexModelBeforeOffset(filePath: string, offset: number, maxLineBytes = Infinity): Promise<string | undefined> {
  if (offset === 0) return undefined;
  const file = await open(filePath, "r");
  let end = offset;
  let suffix = Buffer.alloc(0);
  try {
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      if (bytesRead + suffix.length > maxLineBytes) throw new Error('Codex model line resource limit');
      const joined = Buffer.concat([buffer.subarray(0, bytesRead),suffix]);
      const cut = start > 0 ? joined.indexOf(10) : -1;
      if (start > 0 && cut < 0) { suffix = joined; end = start; continue; }
      const lines = joined.subarray(cut + 1).toString("utf8").split("\n");
      suffix = start > 0 ? Buffer.from(joined.subarray(0,cut)) : Buffer.alloc(0);
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index].includes('"turn_context"')) continue;
        let entry;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        if (entry.type === "turn_context") return typeof entry.payload?.model === "string" ? entry.payload.model : undefined;
      }
      end = start;
    }
    return undefined;
  } finally {
    await file.close();
  }
}
