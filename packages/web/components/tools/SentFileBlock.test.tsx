import { test, expect, describe, mock } from "bun:test";

// What a person sees when an agent sends them a file.
//
// The bug this whole path fixes was silence: the tool reported "1 file
// delivered" and the conversation showed nothing an agent could point at. So
// these assertions are about what reaches the reader — the file's real name,
// what kind of thing it is, how big, and, when it could not be carried, why.

const STORAGE_URL = "https://convex.codecast.sh/api/storage/abc-123";

mock.module("../../hooks/useStorageImageUrl", () => ({
  useStorageImageUrl: (storageId?: string | null) => (storageId ? STORAGE_URL : undefined),
  useStorageImageUrls: () => ({}),
  useStorageImageSrc: () => STORAGE_URL,
  prefetchStorageImageUrls: () => {},
  setGuestImageScope: () => {},
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { SentFileBlock } = await import("./SentFileBlock");

const file = (over: Record<string, unknown> = {}) => ({
  name: "report.pdf",
  media_type: "application/pdf",
  size: 15_304,
  storage_id: "st_1",
  tool_use_id: "toolu_1",
  ...over,
});

function render(files: any[]): string {
  return renderToStaticMarkup(<SentFileBlock files={files} />);
}

// Tag soup out, reading text in — with spaces where the markup implied them.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&middot;|&#xB7;/g, "·").replace(/\s+/g, " ").trim();
}

describe("SentFileBlock", () => {
  test("names the file, its type and its size", () => {
    const out = text(render([file()]));
    expect(out).toContain("report.pdf");
    expect(out).toContain("PDF");
    expect(out).toContain("15 KB");
  });

  test("says how many files arrived, and shows the sender's caption once", () => {
    const out = text(render([
      file({ caption: "before vs after" }),
      file({ name: "chart.png", media_type: "image/png", storage_id: "st_2", caption: "before vs after" }),
    ]));
    expect(out).toContain("Sent you 2 files");
    expect(out.match(/before vs after/g)).toHaveLength(1);
  });

  test("offers a download for anything delivered", () => {
    expect(render([file({ name: "bundle.zip", media_type: "application/zip" })])).toContain("Download");
  });

  test("offers a preview only for what the thread can show", () => {
    expect(render([file()])).toContain("Preview");
    expect(render([file({ name: "bundle.zip", media_type: "application/zip" })])).not.toContain("Preview");
  });

  test("a single file sent to be read opens with its card; several stay closed", () => {
    expect(render([file({ display: "render" })])).toContain("<object");
    expect(render([file({ display: "render" }), file({ name: "b.pdf", storage_id: "st_2", display: "render" })]))
      .not.toContain("<object");
  });

  test("a delivery that could not be carried still says so", () => {
    const tooBig = text(render([file({ name: "huge-export.bin", media_type: "application/octet-stream", size: 31_457_280, storage_id: undefined, error: "too_large" })]));
    expect(tooBig).toContain("huge-export.bin");
    expect(tooBig).toContain("31 MB");
    expect(tooBig).toContain("too large to attach");

    const gone = text(render([file({ name: "packet.docx", storage_id: undefined, error: "missing" })]));
    expect(gone).toContain("the file was gone when this synced");
    expect(gone).not.toContain("Download");
  });

  test("an image card carries the picture itself", () => {
    const html = render([file({ name: "chart.png", media_type: "image/png" })]);
    expect(html).toContain(`src="${STORAGE_URL}"`);
    expect(html).toContain('alt="chart.png"');
  });

  test("nothing renders when nothing was sent", () => {
    expect(render([])).toBe("");
  });
});
