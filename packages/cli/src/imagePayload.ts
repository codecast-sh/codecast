import { createHash } from "node:crypto";

export function detectImageMediaType(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    data.length >= 4 &&
    (
      (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) ||
      (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a)
    )
  ) {
    return "image/tiff";
  }
  if (
    data.length >= 12 &&
    data.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(data.subarray(8, 12).toString("ascii"))
  ) {
    return "image/avif";
  }
  const textPrefix = data.subarray(0, Math.min(data.length, 1024)).toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(textPrefix)) {
    return "image/svg+xml";
  }
  return null;
}

export function decodeImageBase64(base64Data: string): { data: Buffer; mediaType: string } | null {
  const normalized = base64Data.replace(/\s/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return null;
  }
  const data = Buffer.from(normalized, "base64");
  const roundTrip = data.toString("base64").replace(/=+$/, "");
  if (roundTrip !== normalized.replace(/=+$/, "")) return null;
  const mediaType = detectImageMediaType(data);
  return mediaType ? { data, mediaType } : null;
}

export function hashImageBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
