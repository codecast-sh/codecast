import { open } from "node:fs/promises";

export async function readCodexModelBeforeOffset(filePath: string, offset: number): Promise<string | undefined> {
  if (offset === 0) return undefined;
  const file = await open(filePath, "r");
  let end = offset;
  let suffix = "";
  try {
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = (buffer.subarray(0, bytesRead).toString("utf8") + suffix).split("\n");
      suffix = start > 0 ? lines.shift()! : "";
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
