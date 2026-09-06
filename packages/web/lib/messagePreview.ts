import { extractSessionImages } from "./sessionImages";

export type PromptImage = {
  media_type: string;
  storage_id?: string;
  data?: string;
  preview_url?: string;
  tool_use_id?: string;
};

export function messagePreview(content: string, images: PromptImage[] = [], isTrustedSrc: (src: string) => boolean) {
  const attachments = images.filter(image => !image.tool_use_id);
  const entries = extractSessionImages([{ content, images: attachments }], isTrustedSrc);
  for (const [index, image] of attachments.entries()) {
    if (!image.storage_id && !image.data && image.preview_url && isTrustedSrc(image.preview_url) && !entries.some(entry => entry.key === image.preview_url)) {
      entries.splice(index, 0, { key: image.preview_url, src: image.preview_url });
    }
  }
  const text = content
    .replace(/^\s*(?:\[Image\s+#?\d+\]\s*)+/i, prefix => entries.length ? "" : prefix)
    .replace(/\[Image\s+(?:\/|~\/)[^\]]+\]/gi, token => entries.length ? "" : token)
    .replace(/!\[([^\]]*)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g, (token, alt: string, src: string) =>
      entries.some(entry => entry.src === src) ? alt : token)
    .trim();
  return { text, images: entries };
}
