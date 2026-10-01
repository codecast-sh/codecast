// Slack files on mirrored lines. An image the installation's token can read
// is copied into storage and becomes a chat attachment; anything else becomes
// a link line, which recoverLinkedFiles turns back into the image once a
// token can read it.
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ChatAttachment } from "./chatAttachment";
import { slackApi } from "./slackApi";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function mirrorFiles(ctx: ActionCtx, install: Doc<"slack_installations">, files: any[]): Promise<{ attachments: ChatAttachment[]; extra: string[] }> {
  const attachments: ChatAttachment[] = [];
  const extra: string[] = [];
  for (const f of files ?? []) {
    if (!f || f.mode === "tombstone" || f.mode === "hidden_by_limit") continue;
    const mime = String(f.mimetype ?? "");
    const isImage = mime.startsWith("image/");
    const size = Number(f.size ?? 0);
    const url = f.url_private_download || f.url_private;
    if (isImage && url && size > 0 && size <= MAX_FILE_BYTES) {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${install.bot_token}` } });
        // A token without access to the file gets Slack's sign-in page back,
        // often as a 200: only real image bytes become an attachment.
        if (resp.ok && (resp.headers.get("content-type") ?? "").startsWith("image/")) {
          const blob = await resp.blob();
          const storageId = await ctx.storage.store(new Blob([await blob.arrayBuffer()], { type: mime }));
          attachments.push({
            storage_id: storageId,
            name: f.name ? String(f.name).slice(0, 120) : undefined,
            mime,
            width: typeof f.original_w === "number" ? f.original_w : undefined,
            height: typeof f.original_h === "number" ? f.original_h : undefined,
          });
          continue;
        }
      } catch {
        // fall through to a link line
      }
    }
    const label = f.title || f.name || "file";
    if (f.permalink) extra.push(`📎 [${label}](${f.permalink})`);
  }
  return { attachments, extra };
}

// The link line mirrorFiles leaves when a file could not be read, with the
// Slack file id its permalink carries (…slack.com/files/<user>/<file>/<name>).
const FILE_LINK_LINE = /^📎 \[.*\]\(https:\/\/[^/\s)]+\.slack\.com\/files\/[^/\s)]+\/(F[A-Z0-9]+)\/[^\s)]*\)$/;

export function slackFileLinkLines(content: string): Array<{ line: string; file_id: string }> {
  const out: Array<{ line: string; file_id: string }> = [];
  for (const line of content.split("\n")) {
    const m = FILE_LINK_LINE.exec(line);
    if (m) out.push({ line, file_id: m[1] });
  }
  return out;
}

// Every link line in a mirrored line's content that the token can now read,
// as attachments, with those lines dropped from the content.
export async function recoverLinkedFiles(ctx: ActionCtx, install: Doc<"slack_installations">, content: string): Promise<{ attachments: ChatAttachment[]; content: string }> {
  const attachments: ChatAttachment[] = [];
  let rest = content;
  for (const { line, file_id } of slackFileLinkLines(content)) {
    const info = await slackApi(install.bot_token, "files.info", { file: file_id });
    if (!info.ok || !info.file) continue;
    const mirrored = await mirrorFiles(ctx, install, [info.file]);
    if (mirrored.attachments.length === 0) continue;
    attachments.push(...mirrored.attachments);
    rest = rest.split("\n").filter((l) => l !== line).join("\n");
  }
  return { attachments, content: rest.trim() };
}
