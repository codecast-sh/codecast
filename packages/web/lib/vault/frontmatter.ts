/** How many leading lines the YAML frontmatter block occupies, fences included
 *  (0 when the note has none). This is the offset between the two line numbers
 *  the vault deals in: the renderer parses the body ALONE, so a source position
 *  it reports as line N is line N + offset in the file on disk. Writing back to
 *  the wrong line is silent corruption, so the offset comes from the same scan
 *  that does the split rather than from counting the returned block's newlines
 *  (an empty frontmatter would be off by one).
 *
 *  The closing fence must be a FULL line of `---` (or `...`), matching the
 *  index engine's parser — a value line containing "--- draft" is not a fence,
 *  and the two parsers disagreeing would render frontmatter as body. */
export function frontmatterLineOffset(content: string): number {
  // CRLF-authored notes open with "---\r\n" — the \r must not defeat the
  // fence check (review finding, R8: whole frontmatter rendered as body on
  // Windows-authored files). Splitting on "\n" leaves each line's \r attached,
  // which the \s* in the closing-fence test already tolerates, and rejoining
  // with "\n" preserves every original byte.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n") && content !== "---") return 0;
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  }
  return 0;
}

/** Split YAML frontmatter off a markdown body. Returns [frontmatter|null, rest]. */
export function splitFrontmatter(content: string): [string | null, string] {
  const offset = frontmatterLineOffset(content);
  if (!offset) return [null, content];
  const lines = content.split("\n");
  return [lines.slice(1, offset - 1).join("\n"), lines.slice(offset).join("\n")];
}
