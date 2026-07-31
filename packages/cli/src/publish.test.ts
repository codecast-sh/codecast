import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPublishPayload, findChrome, walkBundleDir } from "./publish";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-publish-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, content: string | Buffer) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

describe("walkBundleDir", () => {
  it("walks recursively and applies the skip rules", () => {
    write("index.html", "<title>Hi</title>");
    write("assets/app.js", "js");
    write("assets/app.js.map", "map");
    write("assets/deep/style.css", "css");
    write(".env", "secret");
    write(".git/config", "git");
    write("node_modules/pkg/index.js", "dep");
    expect(walkBundleDir(dir)).toEqual(["assets/app.js", "assets/deep/style.css", "index.html"]);
  });
});

describe("buildPublishPayload", () => {
  it("html file: content + title from <title>", () => {
    write("page.html", "<title>My Page</title><h1>hi</h1>");
    const p = buildPublishPayload(path.join(dir, "page.html"));
    expect(p.kind).toBeUndefined();
    expect(p.title).toBe("My Page");
    expect(p.content).toContain("<h1>hi</h1>");
    expect(p.source_path).toBe(path.join(dir, "page.html"));
    expect(p.entryHtmlPath).toBe(path.join(dir, "page.html"));
  });

  it("markdown file: kind=markdown, raw md as content, heading title, no thumb entry", () => {
    write("notes.md", "# Launch Notes\n\nbody");
    const p = buildPublishPayload(path.join(dir, "notes.md"));
    expect(p.kind).toBe("markdown");
    expect(p.content).toBe("# Launch Notes\n\nbody");
    expect(p.title).toBe("Launch Notes");
    expect(p.entryHtmlPath).toBeUndefined();
  });

  it("directory: kind=bundle with b64 files and the entry html for the thumbnail", () => {
    write("index.html", "<title>Bundle</title>");
    write("app.js", "console.log(1)");
    write(".DS_Store", "junk");
    const p = buildPublishPayload(dir);
    expect(p.kind).toBe("bundle");
    expect(p.title).toBe("Bundle");
    expect(p.entryHtmlPath).toBe(path.join(dir, "index.html"));
    const paths = p.files!.map((f) => f.path).sort();
    expect(paths).toEqual(["app.js", "index.html"]);
    const appJs = p.files!.find((f) => f.path === "app.js")!;
    expect(Buffer.from(appJs.content_b64, "base64").toString("utf-8")).toBe("console.log(1)");
  });

  it("directory without an entry page throws the entry error", () => {
    write("style.css", "body{}");
    expect(() => buildPublishPayload(dir)).toThrow(/index\.html/);
  });

  it("directory over the size cap throws naming the biggest files", () => {
    write("index.html", "<title>Big</title>");
    write("huge.bin", Buffer.alloc(9 * 1024 * 1024));
    expect(() => buildPublishPayload(dir)).toThrow(/huge\.bin/);
  });

  it("rejects unsupported file types", () => {
    write("data.csv", "a,b");
    expect(() => buildPublishPayload(path.join(dir, "data.csv"))).toThrow(/\.html or \.md/);
  });

  it("honors the --title override everywhere", () => {
    write("index.html", "<title>Ignored</title>");
    expect(buildPublishPayload(dir, "Override").title).toBe("Override");
  });
});

describe("findChrome", () => {
  it("prefers an existing CHROME_PATH", () => {
    const fake = path.join(dir, "fake-chrome");
    fs.writeFileSync(fake, "#!/bin/sh\n");
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = fake;
    try {
      expect(findChrome()).toBe(fake);
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = prev;
    }
  });

  it("never throws when CHROME_PATH is missing", () => {
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = path.join(dir, "does-not-exist");
    try {
      expect(() => findChrome()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = prev;
    }
  });
});
