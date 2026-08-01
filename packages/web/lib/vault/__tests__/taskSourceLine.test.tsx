// The one arithmetic that turns a checkbox click into a file write: the
// renderer reports positions in the BODY it was handed, the file has
// frontmatter above that body, and a wrong offset silently checks off the wrong
// line of somebody's note.
//
// This runs the real chain — vault remark plugins, react-markdown, the vault's
// frontmatter split, the toggle — rather than trusting that hast keeps mdast
// positions. It also pins that the wiki-link plugin doesn't strip them.

import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { vaultRemarkPlugins } from "../remarkWikiLink";
import { frontmatterLineOffset, splitFrontmatter } from "../frontmatter";
import { toggleTaskInContent } from "../taskToggle";

const NOTE = [
  "---",
  "title: Chores",
  "aliases: [todo]",
  "---",
  "",
  "# Chores",
  "",
  "- [ ] buy milk",
  "- [x] call [[Someone]]",
  "  - [ ] nested",
  "",
  "Done.",
].join("\n");

/** Every task item the renderer produced: its body line and checked state. */
function renderedTasks(content: string) {
  const [, body] = splitFrontmatter(content);
  const found: { line: number; checked: boolean }[] = [];
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={vaultRemarkPlugins}
      components={{
        li: ({ node, children }: any) => {
          const className = node?.properties?.className;
          if (Array.isArray(className) && className.includes("task-list-item")) {
            found.push({
              line: node.position.start.line,
              checked: !!node.children?.find((c: any) => c.tagName === "input")?.properties?.checked,
            });
          }
          return <li>{children}</li>;
        },
      }}
    >
      {body}
    </ReactMarkdown>,
  );
  return found;
}

describe("checkbox click → source line", () => {
  const tasks = renderedTasks(NOTE);
  const offset = frontmatterLineOffset(NOTE);

  test("the renderer reports a position for every task item", () => {
    expect(tasks).toHaveLength(3);
    for (const t of tasks) expect(typeof t.line).toBe("number");
  });

  test("body line + frontmatter offset is the file line", () => {
    const lines = NOTE.split("\n");
    expect(lines[tasks[0].line + offset - 1]).toBe("- [ ] buy milk");
    expect(lines[tasks[1].line + offset - 1]).toBe("- [x] call [[Someone]]");
    expect(lines[tasks[2].line + offset - 1]).toBe("  - [ ] nested");
  });

  test("checked state matches the source", () => {
    expect(tasks.map((t) => t.checked)).toEqual([false, true, false]);
  });

  test("clicking each checkbox flips that line and nothing else", () => {
    for (const task of tasks) {
      const next = toggleTaskInContent(NOTE, task.line + offset, !task.checked)!;
      expect(next).not.toBeNull();
      const before = NOTE.split("\n");
      next.split("\n").forEach((line, i) => {
        if (i === task.line + offset - 1) expect(line).not.toBe(before[i]);
        else expect(line).toBe(before[i]);
      });
    }
  });

  test("a note with no frontmatter needs no offset", () => {
    const plain = "# Title\n\n- [ ] only task\n";
    const [found] = renderedTasks(plain);
    expect(frontmatterLineOffset(plain)).toBe(0);
    expect(plain.split("\n")[found.line - 1]).toBe("- [ ] only task");
  });
});
