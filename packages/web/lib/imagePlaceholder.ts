// Draft tokens for attached images.
//
// When a user pastes, drops, or picks an image, we also drop a `[Image N]`
// token into the draft text so they can point at a specific attachment in
// prose ("crop it the way [Image 2] is framed"). N is the attach position,
// which is the order the agent receives the images in — so the token is a
// real reference, not decoration.
//
// Shared by the web composer and the mobile composer.

const TOKEN_RE = /\[Image (\d+)\]/g;

export function imagePlaceholderToken(n: number): string {
  return `[Image ${n}]`;
}

/**
 * Insert the token for the nth attachment at `caret`, padding with single
 * spaces only where the surrounding text doesn't already supply them.
 * Returns the new text and where the caret should land after it.
 */
export function insertImagePlaceholder(
  text: string,
  caret: number,
  n: number
): { text: string; caret: number } {
  const token = imagePlaceholderToken(n);
  const pos = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const inserted = lead + token + trail;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/**
 * The user removed the nth attachment (1-based). Drop its token and renumber
 * every higher one down, so the remaining tokens keep pointing at the images
 * the agent will actually receive. Without this, removing image 2 of 3 leaves
 * `[Image 3]` referring to an attachment that is now number 2.
 */
export function dropImagePlaceholder(text: string, removed: number): string {
  // Close the sentence up around the removed token: keep one space only when
  // text sits on both sides. Scoped to this token, so the user's own spacing
  // and line breaks elsewhere are untouched.
  const dropped = text.replace(
    new RegExp(`([ \\t]*)\\[Image ${Math.floor(removed)}\\]([ \\t]*)`, "g"),
    (_match, before: string, after: string) => (before && after ? " " : "")
  );
  return dropped.replace(TOKEN_RE, (match, digits: string) => {
    const n = Number(digits);
    return n > removed ? imagePlaceholderToken(n - 1) : match;
  });
}
