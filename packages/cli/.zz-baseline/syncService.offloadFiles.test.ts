import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncService } from "./syncService.js";
import { MAX_USER_FILE_SIZE } from "@codecast/shared/files";
import type { SyncFile } from "./userFiles.js";

function makeService(): SyncService {
  return new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
}

// One message carrying these files, in the exact shape offloadFiles takes, so
// the assertions below are checked against the real fields.
function batch(...files: SyncFile[]): Array<{ files: SyncFile[] }> {
  return [{ files }];
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "sentfiles-"));
}

describe("SyncService.offloadFiles", () => {
  it("uploads a sent file and hands back what the card needs", async () => {
    const dir = await tempDir();
    const path = join(dir, "report.pdf");
    await writeFile(path, "%PDF-1.4 body");
    const sync = makeService();
    let uploadedType = "";
    (sync as any).uploadBytes = async (_bytes: Uint8Array, mediaType: string) => { uploadedType = mediaType; return "sid-1"; };

    const messages = batch({ localPath: path, name: "report.pdf", toolUseId: "t1", caption: "sign page 2" });
    await sync.offloadFiles(messages);

    expect(uploadedType).toBe("application/pdf");
    expect(messages[0].files[0]).toMatchObject({
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 13,
      storageId: "sid-1",
      toolUseId: "t1",
      caption: "sign page 2",
    });
    await rm(dir, { recursive: true, force: true });
  });

  // The agent already told the human it sent something, so a delivery that
  // cannot be carried keeps its row and says why.
  it("keeps a file that is too large, and never uploads it", async () => {
    const dir = await tempDir();
    const path = join(dir, "huge.bin");
    await writeFile(path, "x");
    await truncate(path, MAX_USER_FILE_SIZE + 1);
    const sync = makeService();
    let uploads = 0;
    (sync as any).uploadBytes = async () => { uploads++; return "sid"; };

    const messages = batch({ localPath: path, name: "huge.bin", toolUseId: "t1" });
    await sync.offloadFiles(messages);

    expect(uploads).toBe(0);
    expect(messages[0].files[0]).toMatchObject({ error: "too_large", size: MAX_USER_FILE_SIZE + 1 });
    expect(messages[0].files[0].storageId).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a file that has gone away", async () => {
    const sync = makeService();
    (sync as any).uploadBytes = async () => "sid";
    const messages = batch({ localPath: "/nope/gone.docx", name: "gone.docx", toolUseId: "t1" });
    await sync.offloadFiles(messages);
    expect(messages[0].files[0]).toMatchObject({ error: "missing", mediaType: expect.stringContaining("wordprocessingml") });
  });

  it("records a failed upload rather than dropping the file", async () => {
    const dir = await tempDir();
    const path = join(dir, "notes.txt");
    await writeFile(path, "hello");
    const sync = makeService();
    (sync as any).uploadBytes = async () => null;
    const messages = batch({ localPath: path, name: "notes.txt", toolUseId: "t1" });
    await sync.offloadFiles(messages);
    expect(messages[0].files[0]).toMatchObject({ error: "upload_failed" });
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads one path once, however often a live turn re-materializes it", async () => {
    const dir = await tempDir();
    const path = join(dir, "plan.md");
    await writeFile(path, "# plan");
    const sync = makeService();
    let uploads = 0;
    (sync as any).uploadBytes = async () => { uploads++; return `sid-${uploads}`; };

    const first = batch({ localPath: path, name: "plan.md", toolUseId: "t1" });
    const second = batch({ localPath: path, name: "plan.md", toolUseId: "t1" });
    await sync.offloadFiles(first);
    await sync.offloadFiles(second);

    expect(uploads).toBe(1);
    expect(second[0].files[0].storageId).toBe("sid-1");
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves an already-uploaded file alone", async () => {
    const sync = makeService();
    let uploads = 0;
    (sync as any).uploadBytes = async () => { uploads++; return "sid"; };
    const messages = batch({ name: "a.pdf", mediaType: "application/pdf", storageId: "sid-old", toolUseId: "t1" });
    await sync.offloadFiles(messages);
    expect(uploads).toBe(0);
    expect(messages[0].files[0].storageId).toBe("sid-old");
  });
});
