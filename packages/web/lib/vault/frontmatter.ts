/** Split YAML frontmatter off a markdown body. Returns [frontmatter|null, rest].
 *  The closing fence must be a FULL line of `---` (or `...`), matching the
 *  index engine's parser — a value line containing "--- draft" is not a fence,
 *  and the two parsers disagreeing would render frontmatter as body. */
export function splitFrontmatter(content: string): [string | null, string] {
  if (!content.startsWith("---\n") && content !== "---") return [null, content];
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
      return [lines.slice(1, i).join("\n"), lines.slice(i + 1).join("\n")];
    }
  }
  return [null, content];
}
