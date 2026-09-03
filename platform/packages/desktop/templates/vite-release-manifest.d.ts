import type { Plugin } from "vite";

export interface ReleaseManifest {
  release: string;
  commit: string | null;
  builtAt: string;
  files: Record<string, string>;
}
export interface ManifestOptions {
  fileName?: string;
  /** Override git HEAD; null writes no commit. */
  commit?: string | null;
}
/** Vite plugin: writes release.json into the build output after the bundle closes. */
export function releaseManifest(opts?: ManifestOptions): Plugin;
export function buildManifest(outDir: string, opts?: ManifestOptions): ReleaseManifest;
export function writeManifest(outDir: string, opts?: ManifestOptions): ReleaseManifest;
