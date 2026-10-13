import * as crypto from "crypto";
import * as path from "path";

export function hashPath(inputPath: string): string {
  const normalized = path.normalize(inputPath);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function projectHash(inputPath: string): string {
  return hashPath(inputPath).substring(0, 12);
}

export function sessionHash(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}
