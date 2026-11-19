import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAttachedFile } from "./attachedFileDownload";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-files-"));
let hits = 0;
const server = Bun.serve({ port: 0, fetch: (req) => (hits++, new URL(req.url).pathname === "/ok" ? new Response("bytes") : new Response("no", { status: 503 })) });
afterAll(() => { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); });

describe("downloadAttachedFile", () => {
  test("saves under the picked name in a folder per upload, then reuses it", async () => {
    const ref = { storageId: "kg2aaaaaaaaaaaa", name: "../notes.txt" };
    const url = async () => `http://localhost:${server.port}/ok`;
    const p = await downloadAttachedFile(ref, url, undefined, root);
    expect(p).toBe(`${root}/kg2aaaaaaaaaaaa/notes.txt`);
    expect(fs.readFileSync(p!, "utf8")).toBe("bytes");
    const before = hits;
    expect(await downloadAttachedFile(ref, url, undefined, root)).toBe(p);
    expect(hits).toBe(before);
  });

  test("a file the server reports gone is null; a failed fetch throws", async () => {
    expect(await downloadAttachedFile({ storageId: "kg2bbbbbbbbbbbb", name: "a" }, async () => null, undefined, root)).toBeNull();
    await expect(downloadAttachedFile({ storageId: "kg2cccccccccccc", name: "a" }, async () => `http://localhost:${server.port}/fail`, undefined, root)).rejects.toThrow("HTTP 503");
  });
});
