// What a delivered file IS — media type, display kind, human-readable size.
//
// Four runtimes need the same answer and must not disagree: the daemon decides
// what to upload and stamps the media type, convex validates the stamp, and web
// and mobile pick the card, the icon and the preview from it. Deriving the kind
// twice is how a PDF ends up previewable on one surface and a download on the
// other.
//
// PURE isomorphic data — no Node or DOM APIs.

/** Largest file the daemon will carry into a conversation. */
export const MAX_USER_FILE_SIZE = 25_000_000;

/** Extension -> media type. Lowercase, no leading dot. */
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  toml: "text/x-toml",
  ini: "text/plain",
  patch: "text/x-diff",
  diff: "text/x-diff",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pages: "application/x-iwork-pages-sffpages",
  numbers: "application/x-iwork-numbers-sffnumbers",
  key: "application/x-iwork-keynote-sffkey",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  dmg: "application/x-apple-diskimage",
  ipa: "application/octet-stream",
  apk: "application/vnd.android.package-archive",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  ics: "text/calendar",
  eml: "message/rfc822",
};

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileBasename(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).filter(Boolean).pop() ?? pathOrName;
}

/** Media type from the file name. Unknown extensions are opaque bytes. */
export function mediaTypeForFile(pathOrName: string): string {
  return MEDIA_TYPES[fileExtension(pathOrName)] ?? "application/octet-stream";
}

/**
 * How a surface should present the file.
 *
 * `image`, `pdf`, `video` and `audio` have a preview the browser renders on its
 * own. `text` covers everything a plain text pane can show — prose, code, data.
 * The rest are handed to the operating system, so they get a download and an
 * icon, never a preview pane.
 */
export type FileKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "sheet"
  | "doc"
  | "archive"
  | "binary";

const SHEET_TYPES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-iwork-numbers-sffnumbers",
]);

const DOC_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-iwork-pages-sffpages",
  "application/x-iwork-keynote-sffkey",
]);

const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-7z-compressed",
  "application/x-apple-diskimage",
  "application/vnd.android.package-archive",
]);

export function fileKind(mediaType: string | undefined, name?: string): FileKind {
  const type = mediaType && mediaType !== "application/octet-stream"
    ? mediaType
    : name
      ? mediaTypeForFile(name)
      : (mediaType ?? "application/octet-stream");
  // SVG is text the browser will happily execute from our storage origin, so it
  // is never previewed as an image — it reads as a download like any document.
  if (type === "image/svg+xml") return "binary";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (SHEET_TYPES.has(type)) return type.startsWith("text/") ? "text" : "sheet";
  if (DOC_TYPES.has(type)) return "doc";
  if (ARCHIVE_TYPES.has(type)) return "archive";
  if (type.startsWith("text/") || type === "application/json" || type === "application/yaml" || type === "application/xml") {
    return "text";
  }
  return "binary";
}

/** Kinds the conversation can show inline without leaving the page. */
export function isPreviewableKind(kind: FileKind): boolean {
  return kind === "image" || kind === "pdf" || kind === "video" || kind === "audio" || kind === "text";
}

/** Short size for a card: "812 B", "24 KB", "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The label a card shows where a type belongs: "PDF", "DOCX", "PNG". */
export function fileTypeLabel(name: string, mediaType?: string): string {
  const ext = fileExtension(name);
  if (ext) return ext.toUpperCase();
  const type = mediaType ?? "";
  const sub = type.split("/")[1];
  return sub ? sub.toUpperCase() : "FILE";
}
