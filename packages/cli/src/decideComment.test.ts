import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { commentWords } from "./decideComment";

// `cast decide comment <sd-N> "words"` (convex decisionThread.ts): from a plain
// shell the person's comment, from a session the session's, which the server
// tells apart by the session it names.
describe("cast decide comment on the wire", () => {
  const SITE = "https://x.test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  let logs: string[] = [];
  let session: string | null = null;
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => session } as any;

  beforeEach(() => {
    calls.length = 0;
    logs = [];
    session = null;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url).slice(SITE.length);
      const { api_token: _token, ...body } = JSON.parse(String(init.body));
      calls.push({ path, body });
      return new Response(JSON.stringify({ ok: true, short_id: "sd-7", asked: body.text.includes("@") ? ["conv1"] : [] }), { status: 200 });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  });

  async function run(...argv: string[]) {
    const { Command } = await import("commander");
    const { registerDecideCommand } = await import("./decideCommand.js");
    const program = new Command();
    program.exitOverride();
    registerDecideCommand(program, deps);
    await program.parseAsync(["node", "cast", "decide", ...argv]);
  }

  it("from a plain shell posts the words with no session, and says who hears", async () => {
    await run("comment", "sd-7", "@[Fix the cart jxask01] does this touch checkout?");
    expect(calls).toEqual([{ path: "/cli/decide/comment", body: { decision_id: "sd-7", text: "@[Fix the cart jxask01] does this touch checkout?" } }]);
    expect(logs.join("\n")).toContain("Commented: on sd-7");
    expect(logs.join("\n")).toContain("The session you named was asked");
  });

  it("from a session names it, so the server writes it as the session's", async () => {
    session = "sess-1";
    await run("comment", "sd-7", "Because", "the total was wrong.");
    expect(calls).toEqual([{ path: "/cli/decide/comment", body: { decision_id: "sd-7", text: "Because the total was wrong.", session_id: "sess-1" } }]);
  });

  it("with no words is refused before any request", async () => {
    await expect(run("comment", "sd-7")).rejects.toThrow("exit 1");
    expect(calls).toEqual([]);
  });

  it("reads the words from stdin for -", () => {
    expect(commentWords(["-"], () => "  from stdin\n")).toBe("from stdin");
    expect(commentWords(["a", "b"])).toBe("a b");
  });
});
