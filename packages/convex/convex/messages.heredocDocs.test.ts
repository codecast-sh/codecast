import { describe, expect, test } from "bun:test";
import { extractHeredocMarkdownWrites } from "./messages";

const BODY = "# Title\n\n" + "x".repeat(300);

describe("extractHeredocMarkdownWrites", () => {
  test("captures `cat > file.md <<'EOF' ... EOF` (redirect before heredoc)", () => {
    const cmd = `cat > backend/ROADMAP_EXPLAINED.md <<'EOF'\n${BODY}\nEOF`;
    expect(extractHeredocMarkdownWrites(cmd)).toEqual([
      { file_path: "backend/ROADMAP_EXPLAINED.md", content: BODY },
    ]);
  });

  test("captures `cat <<EOF > file.md` (redirect after heredoc)", () => {
    const cmd = `cat <<EOF > notes.md\n${BODY}\nEOF`;
    expect(extractHeredocMarkdownWrites(cmd)).toEqual([
      { file_path: "notes.md", content: BODY },
    ]);
  });

  test("captures tee, append (>>), and a quoted absolute path", () => {
    const cmd = `tee -a "/Users/me/docs/plan.md" <<MARK\n${BODY}\nMARK`;
    expect(extractHeredocMarkdownWrites(cmd)).toEqual([
      { file_path: "/Users/me/docs/plan.md", content: BODY },
    ]);
  });

  test("handles multiple heredocs in one command", () => {
    const cmd = `cat > a.md <<EOF\n${BODY}\nEOF\necho done\ncat > b.md <<EOF\n${BODY}\nEOF`;
    expect(extractHeredocMarkdownWrites(cmd)).toEqual([
      { file_path: "a.md", content: BODY },
      { file_path: "b.md", content: BODY },
    ]);
  });

  test("ignores heredocs that don't redirect to a .md file", () => {
    expect(extractHeredocMarkdownWrites(`cat > script.py <<EOF\nprint(1)\nEOF`)).toEqual([]);
    expect(extractHeredocMarkdownWrites(`psql <<EOF\nSELECT 1;\nEOF`)).toEqual([]);
  });

  test("ignores a .md redirect with no heredoc body", () => {
    expect(extractHeredocMarkdownWrites(`python build.py > ROADMAP_EXPLAINED.md`)).toEqual([]);
  });

  test("returns content verbatim even if a line merely contains the delimiter word", () => {
    const body = "line one\nEOF is mentioned here\nline three";
    const cmd = `cat > x.md <<'EOF'\n${body}\nEOF`;
    // padded so it clears the 200-char floor downstream; parser itself returns body as-is
    expect(extractHeredocMarkdownWrites(cmd)).toEqual([{ file_path: "x.md", content: body }]);
  });
});
