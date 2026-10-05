// Structural types, so the package needs no vite of its own: both shapes are
// assignable to vite's HtmlTagDescriptor and Plugin.
export interface TokensStyleTag {
  tag: "style";
  attrs: { "data-pd-tokens": "" };
  children: string;
  injectTo: "head";
}

/** The <style> tag that carries tokens.css. */
export function tokensStyleTag(): TokensStyleTag;

/** Vite plugin: injects tokensStyleTag() into every HTML entry. */
export function designTokens(): {
  name: string;
  transformIndexHtml: { order: "pre"; handler: () => TokensStyleTag[] };
};
