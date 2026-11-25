// What the editor core imports for language intelligence, and all it imports
// up front: the "lsp" feature slot and the language command ids. The client,
// its markdown renderer, the sanitizer and the UI (feature.ts) load the first
// time a file that could have a server opens (contract 3).
//
// Until then no editor can have a server attached, so the language commands
// decline and their fallbacks run (vim's `gd` word search); the outline picks
// work without a server and load the module themselves.

import { registerEditorFeature } from "../features";
import { registerCodeCommands, type CodeCommandHandler } from "../commands";

export type LspCommandId =
  | "lsp.definition"
  | "lsp.references"
  | "lsp.hover"
  | "lsp.rename"
  | "lsp.format"
  | "lsp.codeAction"
  | "diagnostic.next"
  | "diagnostic.prev"
  | "goto.symbol"
  | "goto.workspaceSymbol";

const IDS: LspCommandId[] = ["lsp.definition", "lsp.references", "lsp.hover", "lsp.rename", "lsp.format", "lsp.codeAction", "diagnostic.next", "diagnostic.prev", "goto.symbol", "goto.workspaceSymbol"];
/** Commands that work with no server (the Lezer outline). */
const SERVERLESS = new Set<LspCommandId>(["goto.symbol"]);

type FeatureModule = typeof import("./feature");
let loaded: FeatureModule | null = null;
let loading: Promise<FeatureModule> | null = null;

function load(): Promise<FeatureModule> {
  loading ??= import("./feature").then((m) => {
    loaded = m;
    m.activateLsp();
    return m;
  });
  return loading;
}

let registered = false;

export function registerLspFeature(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature(
    "lsp",
    async (ctx) => {
      if (ctx.largeFile || ctx.languageId === "plaintext") return null;
      return (await load()).lspExtension(ctx);
    },
    { needsVault: true },
  );
  const route =
    (id: LspCommandId): CodeCommandHandler =>
    (args, ctx) => {
      if (loaded) return loaded.lspCommandHandlers[id](args, ctx);
      if (!SERVERLESS.has(id)) return false;
      void load().then((m) => m.lspCommandHandlers[id](args, ctx));
      return true;
    };
  registerCodeCommands(Object.fromEntries(IDS.map((id) => [id, route(id)])));
}
