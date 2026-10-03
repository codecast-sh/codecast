// Everything that runs at build time, in Node rather than in the browser.
// Keep this file free of relative imports: an app that resolves the package
// from a sibling checkout (Averil) imports it straight into Node, which strips
// the types but will not resolve an extensionless "./x".

import { readFileSync, writeFileSync } from "node:fs";

// release-prompt.json: the one file that decides whether a deploy asks open
// windows to reload now. Bump it, with the line the card should show, and
// commit it with the change it announces. Every window running a bundle older
// than the new generation shows the card once; routine deploys (no bump) stay
// silent and apply when the window next hides.

export type ReleasePrompt = { generation: number; message: string };

export function readReleasePrompt(file: string): ReleasePrompt {
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  return { generation: Number(raw.generation) || 0, message: String(raw.message ?? "") };
}

export function bumpReleasePrompt(file: string, message: string): ReleasePrompt {
  const line = message.trim();
  if (!line) throw new Error("a release prompt needs the one line its card shows");
  const next = { generation: readReleasePrompt(file).generation + 1, message: line };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Bakes the release prompt into the bundle and publishes it beside the bundle,
// so a running window can compare what it was built with against what is
// deployed now:
//
//   define      <name> = { promptGeneration, promptMessage, ...identity(mode) }
//   build only  /version.json with the same object
//
//   import { updatePromptVite } from "@platform/update-prompt/build";
//   plugins: [updatePromptVite({ releaseFile: path.resolve(__dirname, "release-prompt.json"), define: "__APP_BUILD__" })]
//
// The plugin is typed structurally so the package needs no vite dependency;
// any Vite from 5 on accepts it.

export type BuildIdentity = { promptGeneration: number; promptMessage: string } & Record<string, unknown>;

export type UpdatePromptViteOptions = {
  /** Absolute path to release-prompt.json. */
  releaseFile: string;
  /** The global the bundle reads its identity from, e.g. "__APP_BUILD__". */
  define: string;
  /** More fields for the identity (a commit, a build time). Called once per mode. */
  identity?: (mode: string) => Record<string, unknown>;
  fileName?: string;
};

type EmitContext = { emitFile(file: { type: "asset"; fileName: string; source: string }): string };

export type UpdatePromptVitePlugin = {
  name: string;
  config(config: unknown, env: { mode: string }): { define: Record<string, string> };
  generateBundle(this: EmitContext): void;
};

/** The identity for one mode: the app's fields plus the release prompt. */
export function buildIdentity(opts: Pick<UpdatePromptViteOptions, "releaseFile" | "identity">, mode: string): BuildIdentity {
  const prompt = readReleasePrompt(opts.releaseFile);
  return { ...opts.identity?.(mode), promptGeneration: prompt.generation, promptMessage: prompt.message };
}

export function updatePromptVite(opts: UpdatePromptViteOptions): UpdatePromptVitePlugin {
  // One identity per build, so the bundle and the manifest never disagree.
  let identity: BuildIdentity | null = null;
  return {
    name: "platform-update-prompt",
    config(_config, env) {
      identity = buildIdentity(opts, env.mode);
      return { define: { [opts.define]: JSON.stringify(identity) } };
    },
    generateBundle() {
      if (!identity) return;
      this.emitFile({ type: "asset", fileName: opts.fileName ?? "version.json", source: JSON.stringify(identity) });
    },
  };
}
