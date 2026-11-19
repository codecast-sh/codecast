import * as fs from "node:fs";
import { safeFileName, type AttachedFileRef } from "@codecast/shared/contracts";

export const ATTACHED_FILES_DIR = "/tmp/codecast/files";

/** A file attached in the web composer (shared/contracts/fileAttachment),
 *  saved under its own name in a folder per upload so the agent sees the name
 *  the person picked. Null when the server reports it gone; a failed fetch
 *  throws so delivery re-pends rather than sending the text without it. */
export async function downloadAttachedFile(
  ref: AttachedFileRef,
  storageUrl: (storageId: string) => Promise<string | null>,
  log: (line: string) => void = () => {},
  root: string = ATTACHED_FILES_DIR,
): Promise<string | null> {
  const dir = `${root}/${ref.storageId}`;
  const destPath = `${dir}/${safeFileName(ref.name)}`;
  if (fs.existsSync(destPath)) return destPath;
  const url = await storageUrl(ref.storageId);
  if (!url) {
    log(`downloadAttachedFile: no URL for storage id ${ref.storageId} (auth rejected or file missing)`);
    return null;
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
  return destPath;
}
