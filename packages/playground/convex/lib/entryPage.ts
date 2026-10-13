// An app's index.html as it is served (http.ts): the boot catcher first, the
// import map pointed at where its modules really land (esm.sh's built files,
// the SDK at its build's URL), and a preload for every module the page will
// ask for. Without them the browser finds each module only once the one that
// imports it has arrived, five round trips deep before the app can start.
import { withBootCatcher } from "./bootCatcher";
import { ESM_RESOLVED, SDK_PATH } from "./runtime";

const MODULE_FILE = /\.(m?js|jsx|tsx?)$/;
export const isModulePath = (path: string) => MODULE_FILE.test(path);
const IMPORT_MAP = /(<script\b[^>]*\btype=["']?importmap["']?[^>]*>)([\s\S]*?)(<\/script>)/i;
const HEAD = /<head[^>]*>/i;

export type EntryFile = { path: string; text: string | null };

export function servedEntry(html: string, files: readonly EntryFile[], sdkPath: string): string {
  const modules = files.filter((f) => isModulePath(f.path));
  const sources = modules.map((f) => f.text ?? "").join("\n");
  const imported = (specifier: string) => sources.includes(`"${specifier}"`) || sources.includes(`'${specifier}'`);
  const preloads = modules.map((f) => `./${f.path}`);

  const map = IMPORT_MAP.exec(html);
  const parsed = map ? parseMap(map[2]) : null;
  if (!map || !parsed) return withBootCatcher(insertAfter(html, HEAD, links(preloads, false)));
  const imports = parsed.imports;

  for (const [specifier, url] of Object.entries(imports)) {
    // The SDK imports React itself.
    const resolved = url === SDK_PATH ? { url: sdkPath, imports: imports.react ? [ESM_RESOLVED[imports.react]?.url ?? imports.react] : [] } : ESM_RESOLVED[url];
    if (!resolved) continue;
    imports[specifier] = resolved.url;
    if (imported(specifier)) preloads.push(resolved.url, ...resolved.imports);
  }
  const usesEsm = Object.values(imports).some((url) => url.startsWith("https://esm.sh/"));
  const tag = `${map[1]}${JSON.stringify(parsed).replace(/</g, "\\u003c")}${map[3]}`;
  const page = html.slice(0, map.index) + tag + links(preloads, usesEsm) + html.slice(map.index + map[0].length);
  return withBootCatcher(page);
}

/** An import map's JSON with string-valued imports, or null when it is not one. */
function parseMap(json: string): { imports: Record<string, string> } | null {
  try {
    const map = JSON.parse(json) as { imports?: unknown };
    if (!map.imports || typeof map.imports !== "object") return null;
    return { ...map, imports: Object.fromEntries(Object.entries(map.imports).filter((e): e is [string, string] => typeof e[1] === "string")) };
  } catch {
    return null;
  }
}

function links(preloads: string[], esm: boolean): string {
  const preconnect = esm ? `<link rel="preconnect" href="https://esm.sh" crossorigin>` : "";
  return preconnect + [...new Set(preloads)].map((href) => `<link rel="modulepreload" href="${href.replace(/"/g, "&quot;")}">`).join("");
}

function insertAfter(html: string, at: RegExp, text: string): string {
  const m = at.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + text + html.slice(m.index + m[0].length) : text + html;
}
