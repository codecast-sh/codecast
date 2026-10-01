import { describe, expect, test } from "bun:test";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { MD_REMARK_PLUGINS } from "../markdownPlugins";
import { addAlternatives, ghostText, flagText } from "@codecast/shared/docs";

const render = (md: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS}>{md}</ReactMarkdown>);

describe("drafting markup in read-only markdown", () => {
  test("alternatives and flags read as the text showing; ghosts dim", () => {
    let md = addAlternatives("Much of the tension, for example, is **real**.", "tension", ["pressure"]);
    md = ghostText(md, ", for example");
    md = flagText(md, "is **real**", "weak");
    expect(render(md)).toBe('<p>Much of the tension<span class="md-draft-ghost">, for example</span>, is <strong>real</strong>.</p>');
  });

  test("other inline HTML is left as it was", () => {
    expect(render("a <b>b</b> c")).toBe("<p>a &lt;b&gt;b&lt;/b&gt; c</p>");
  });
});
