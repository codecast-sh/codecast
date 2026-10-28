import { describe, expect, test } from "bun:test";
import { mirrorFiles, slackFileLinkLines } from "./slackFiles";

describe("files shared in Slack", () => {
  test("a shared image comes over as an attachment; a sign-in page in its place stays a link", async () => {
    const stored: Blob[] = [];
    const ctx: any = { storage: { store: async (b: Blob) => { stored.push(b); return `storage_${stored.length}`; } } };
    const install: any = { bot_token: "xoxp-owner" };
    const file = (id: string) => ({ id, name: `${id}.png`, title: `${id}.png`, mimetype: "image/png", size: 10, url_private: `https://files.slack.com/${id}`, permalink: `https://union.slack.com/files/${id}` });
    const auths: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      auths.push(init.headers.Authorization);
      return String(url).endsWith("F1")
        ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
        : new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } });
    }) as any;
    try {
      const r = await mirrorFiles(ctx, install, [file("F1"), file("F2")]);
      expect(r.attachments).toEqual([expect.objectContaining({ storage_id: "storage_1", mime: "image/png", name: "F1.png" })]);
      expect(r.extra).toEqual(["📎 [F2.png](https://union.slack.com/files/F2)"]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(stored).toHaveLength(1);
    expect(auths).toEqual(["Bearer xoxp-owner", "Bearer xoxp-owner"]);
  });
  test("a shared video comes over as an attachment; one past the size cap stays a link", async () => {
    const ctx: any = { storage: { store: async () => "storage_1" } };
    const video = (id: string, size: number) => ({ id, name: `${id}.MOV`, title: id, mimetype: "video/mp4", size, url_private: `https://files.slack.com/${id}`, permalink: `https://union.slack.com/files/${id}` });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4" } })) as any;
    try {
      const r = await mirrorFiles(ctx, { bot_token: "xoxb" } as any, [video("V1", 9_000_000), video("V2", 30 * 1024 * 1024)]);
      expect(r.attachments).toEqual([expect.objectContaining({ storage_id: "storage_1", mime: "video/mp4", name: "V1.MOV" })]);
      expect(r.extra).toEqual(["📎 [V2](https://union.slack.com/files/V2)"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  test("a file link names its Slack file id; a link elsewhere is not one", () => {
    const link = "📎 [image.png](https://union-app.slack.com/files/U05J1KXRSHX/F0C5UMXCA1Y/image.png)";
    expect(slackFileLinkLines(`oh i know him\n\n${link}`)).toEqual([{ line: link, file_id: "F0C5UMXCA1Y" }]);
    expect(slackFileLinkLines("📎 [x](https://example.com/files/U1/F1/x)")).toEqual([]);
  });
});
