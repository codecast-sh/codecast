import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryMedia } from "../SummaryMedia";
import { pickMedia } from "../storyMedia";
import { story } from "./fixtures";

// A day or week summary shows its stories' screenshots, each captioned by
// the story it came from, the first one large when there are three or more.
test("screenshots render as a captioned grid, led by a wide one", () => {
  const stories = [1, 2, 3].map((n) => story(`s${n}`, { headline: `Story ${n}`, body: `Lead.\n\n![shot ${n}](https://convex.example/s${n}.png)` }));
  const html = renderToStaticMarkup(<SummaryMedia media={pickMedia(stories, 4)} onOpen={() => {}} />);
  expect((html.match(/<img /g) ?? []).length).toBe(3);
  for (const n of [1, 2, 3]) expect(html).toContain(`Story ${n}`);
  expect(html).toContain("col-span-2");
  expect(html).toContain("aspect-[16/9]");
});

test("no media, nothing", () => {
  expect(renderToStaticMarkup(<SummaryMedia media={[]} onOpen={() => {}} />)).toBe("");
});
