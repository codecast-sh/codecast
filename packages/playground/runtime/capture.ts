// The app's picture of itself, for the gallery (convex/stills.ts). The shell
// cannot read a sandboxed frame's pixels, so the app draws its own page and
// hands the image over. The drawing copies each element's computed style, so
// the picture is the page exactly as laid out now: the shell asks a frame
// that is already the gallery's size. The library loads only when a picture
// is asked for, so apps never pay for it otherwise.
//
// A sandboxed page is an opaque origin, so every stylesheet it links is
// another origin's and the library cannot read the fonts in them; the
// page's fonts are fetched here instead, or text would draw in a fallback
// face and wrap where the app's never does.
const LIBRARY = "https://esm.sh/modern-screenshot@4.7.0";
const QUALITY = 0.82;
const TIMEOUT_MS = 8_000;
/** Stylesheets followed through @import, so a sheet that imports Google
 *  Fonts gives up its faces. */
const IMPORT_DEPTH = 2;
/** Font files inlined at most; a page rarely uses more than a few faces. */
const MAX_FACES = 12;

type Screenshot = {
  createContext(node: Node, options: Record<string, unknown>): Promise<{ sandbox?: unknown }>;
  domToBlob(context: unknown): Promise<Blob>;
};

/** The page's top `width` x `height`, or null when it cannot be drawn. */
export async function capture(width: number, height: number): Promise<Blob | null> {
  await document.fonts.ready;
  const defaults = defaultStyles();
  try {
    const [{ createContext, domToBlob }, fonts] = await Promise.all([import(/* @vite-ignore */ LIBRARY) as Promise<Screenshot>, fontFaces()]);
    const context = await createContext(document.body, {
      width,
      height,
      scale: 1,
      type: "image/webp",
      quality: QUALITY,
      timeout: TIMEOUT_MS,
      backgroundColor: pageBackground(),
      font: { cssText: fonts },
      filter: (node: Node) => node !== defaults.host,
    });
    context.sandbox = defaults.sandbox;
    return await domToBlob(context);
  } catch {
    return null;
  } finally {
    defaults.host.remove();
  }
}

/** Where the library reads the browser's default style of each tag, so it
 *  writes only what the page changed. It would make an iframe for that, and
 *  a sandboxed page's child frame is another origin it cannot read, so it
 *  gets a shadow root instead: the browser's own styles apply there and the
 *  page's do not. */
function defaultStyles() {
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; width: 0; height: 0; overflow: hidden; visibility: hidden";
  const body = document.createElement("div");
  host.attachShadow({ mode: "open" }).appendChild(body);
  document.body.appendChild(host);
  const sandboxDocument = {
    body,
    createElement: (tag: string) => document.createElement(tag),
    createElementNS: (ns: string, tag: string) => document.createElementNS(ns, tag),
  };
  const contentWindow = { document: sandboxDocument, getComputedStyle: (el: Element, pseudo?: string) => getComputedStyle(el, pseudo) };
  return { host, sandbox: { contentWindow, remove: () => host.remove() } };
}

/** Every @font-face the page's stylesheets declare (linked sheets and
 *  <style> blocks, following @import), with its files inlined: a picture
 *  is drawn as an image, and an image loads nothing from the network. Only
 *  the faces that cover Latin text are kept, so a font with a dozen
 *  alphabets costs one or two files. */
async function fontFaces(): Promise<string> {
  const faces: string[] = [];
  const seen = new Set<string>();
  const read = async (css: string, base: string, depth: number): Promise<void> => {
    const absolute = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, q, url) => `url(${q}${new URL(url, base).href}${q})`);
    faces.push(...(absolute.match(/@font-face\s*{[^}]*}/g) ?? []).filter(coversLatin));
    if (depth >= IMPORT_DEPTH) return;
    const imports = [...absolute.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)].map((m) => m[1]);
    await Promise.all(imports.map((url) => sheet(url, depth + 1)));
  };
  const sheet = async (url: string, depth: number) => {
    if (seen.has(url)) return;
    seen.add(url);
    await read(await fetchText(url), url, depth);
  };
  await Promise.all([
    ...[...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].map((l) => sheet(l.href, 0)),
    ...[...document.querySelectorAll("style")].map((el) => read(el.textContent ?? "", location.href, 0)),
  ]);
  return (await Promise.all(faces.slice(0, MAX_FACES).map(inlineFace))).join("\n");
}

const fetchText = (url: string) => fetch(url).then((r) => (r.ok ? r.text() : ""), () => "");

/** No unicode-range, or one that starts at the basic Latin block. */
const coversLatin = (face: string) => !/unicode-range/.test(face) || /unicode-range:\s*U\+0000-00FF/i.test(face);

/** A face whose first source is a data: URL, or the face as it was when
 *  its file cannot be read. */
async function inlineFace(face: string): Promise<string> {
  const src = /src:\s*url\((['"]?)([^'")]+)\1\)(\s*format\([^)]*\))?/.exec(face);
  if (!src || src[2].startsWith("data:")) return face;
  try {
    const res = await fetch(src[2]);
    if (!res.ok) return face;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      void res.blob().then((b) => reader.readAsDataURL(b));
    });
    return face.replace(/src:[^;}]*/, `src: url(${data})${src[3] ?? ""}`);
  } catch {
    return face;
  }
}

/** What the page sits on: the body's color, else the root's, else white. */
function pageBackground(): string {
  const clear = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";
  for (const el of [document.body, document.documentElement]) {
    const color = el && getComputedStyle(el).backgroundColor;
    if (color && !clear(color)) return color;
  }
  return "#ffffff";
}
