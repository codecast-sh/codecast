import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { folderHash, unpackArchive } from "./contentStore.js";
import {
  findHomePaths,
  KitPublishError,
  locateKitItem,
  publishKitItem,
  readInstructionSection,
  runCapPublishCommand,
  type KitPublishDeps,
} from "./kitPublish.js";

const dirs: string[] = [];
function tmpHome(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-kitpub-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : {});
}

function skill(home: string, name: string, body = "Do the thing.\n") {
  const dir = path.join(home, ".claude", "skills", name);
  write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`);
  return dir;
}

/** A fake server: records calls, stores the uploaded archive, answers
 *  "unchanged" for a hash it has seen. */
function fakeServer() {
  const calls: Array<{ route: string; body: any }> = [];
  const seen = new Map<string, number>();
  let uploaded: Buffer | undefined;
  const post: KitPublishDeps["post"] = async (route, body) => {
    calls.push({ route, body });
    if (route === "/cli/cap/kit/upload-url") {
      expect(body).toEqual({});
      return { upload_url: "https://upload.test/x" };
    }
    if (route === "/cli/cap/kit/publish") {
      const key = `${body.team_id ?? "me"}|${body.kind}|${body.name}|${body.folder_hash}`;
      const v = seen.get(key);
      if (v) return { status: "unchanged", version: v };
      seen.set(key, seen.size + 1);
      return { status: "created", version: seen.size, surfaces: ["prose"] };
    }
    throw new Error(`unexpected route ${route}`);
  };
  const fetchImpl = (async (_url: string, init: any) => {
    uploaded = Buffer.from(init.body);
    return new Response(JSON.stringify({ storageId: "st_1" }));
  }) as unknown as typeof fetch;
  return { calls, post, fetchImpl, uploaded: () => uploaded };
}

describe("cast cap publish", () => {
  test("publishes a skill folder: slug, files, hash and archive agree", async () => {
    const home = tmpHome();
    const dir = skill(home, "deploy");
    write(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", 0o755);
    const server = fakeServer();
    const r = await publishKitItem({ name: "deploy" }, { home, workspace: { kind: "team", teamId: "team1" }, deviceId: "dev1", post: server.post, fetchImpl: server.fetchImpl, note: "first" });

    expect(r).toMatchObject({ status: "created", slug: "authored/team1/skill/deploy", version: 1, file_count: 2 });
    const pub = server.calls.find((c) => c.route === "/cli/cap/kit/publish")!.body;
    expect(pub).toMatchObject({ team_id: "team1", kind: "skill", name: "deploy", storage_id: "st_1", note: "first", device_id: "dev1" });
    expect(pub.slug).toBeUndefined();
    expect(pub.files).toEqual([
      { path: "SKILL.md", size: expect.any(Number), executable: false },
      { path: "scripts/run.sh", size: 18, executable: true },
    ]);
    expect(pub.main_body).toContain("Do the thing.");
    expect(folderHash(unpackArchive(server.uploaded()!))).toBe(pub.folder_hash);
  });

  test("a personal publish slugs under the user id and says personal on the wire", async () => {
    const home = tmpHome();
    skill(home, "notes");
    const server = fakeServer();
    const r = await publishKitItem({ name: "notes" }, { home, workspace: { kind: "personal", userId: "user9" }, deviceId: "d", post: server.post, fetchImpl: server.fetchImpl });
    expect(r.slug).toBe("authored/user9/skill/notes");
    expect(server.calls.find((c) => c.route === "/cli/cap/kit/publish")!.body.team_id).toBeUndefined();
  });

  test("republishing unchanged reports unchanged with the existing version", async () => {
    const home = tmpHome();
    skill(home, "deploy");
    const server = fakeServer();
    const deps = { home, workspace: { kind: "team" as const, teamId: "t" }, deviceId: "d", post: server.post, fetchImpl: server.fetchImpl };
    await publishKitItem({ name: "deploy" }, deps);
    const again = await publishKitItem({ name: "deploy" }, deps);
    expect(again).toMatchObject({ status: "unchanged", version: 1 });
  });

  test("a skill containing the publisher's home path is refused, naming the line", async () => {
    const home = tmpHome();
    const dir = skill(home, "leaky", `Step one.\nRun ${home}/bin/thing --fast\n`);
    write(path.join(dir, "ok.md"), "Use ~/bin/thing, which is portable.\n");
    const server = fakeServer();
    const err = await publishKitItem({ name: "leaky" }, { home, workspace: { kind: "team", teamId: "t" }, deviceId: "d", post: server.post, fetchImpl: server.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(KitPublishError);
    expect(err.message).toContain("SKILL.md:6");
    expect(err.message).toContain(`${home}/bin/thing`);
    expect(err.message).not.toContain("ok.md");
    expect(server.calls).toHaveLength(0);
  });

  test("a refusal from the server is an error, not a success", async () => {
    const home = tmpHome();
    skill(home, "deploy");
    const server = fakeServer();
    const post: KitPublishDeps["post"] = async (route, body) => (route.endsWith("/publish") ? { status: "rejected", reason: "slug_in_other_workspace" } : server.post(route, body));
    await expect(publishKitItem({ name: "deploy" }, { home, workspace: { kind: "team", teamId: "t" }, deviceId: "d", post, fetchImpl: server.fetchImpl })).rejects.toThrow(/slug_in_other_workspace/);
  });

  test("a home path that is only a prefix of another user's is not a match", () => {
    const files = [{ path: "a.md", bytes: Buffer.from("see /Users/anna/x\n"), executable: false }];
    expect(findHomePaths(files, "/Users/ann")).toEqual([]);
    expect(findHomePaths(files, "/Users/anna")).toHaveLength(1);
  });

  test("commands and subagents publish as one file; an ambiguous name asks for --kind", () => {
    const home = tmpHome();
    write(path.join(home, ".claude", "commands", "review.md"), "Review the diff.\n");
    write(path.join(home, ".claude", "agents", "review.md"), "---\nname: review\n---\nYou review.\n");
    expect(() => locateKitItem(home, "review")).toThrow(/--kind/);
    const cmd = locateKitItem(home, "review", "command");
    expect(cmd).toMatchObject({ kind: "command", name: "review", mainPath: "review.md" });
    expect(cmd.files.map((f) => f.path)).toEqual(["review.md"]);
    expect(locateKitItem(home, "review", "subagent").kind).toBe("subagent");
  });

  test("a copy the kit installer wrote is not a candidate to publish", () => {
    const home = tmpHome();
    skill(home, "deploy");
    const installed = path.join(home, ".agents", "skills", "deploy", "SKILL.md");
    write(installed, "---\nname: deploy\n---\nThe team's copy.\n");
    write(path.join(home, ".codecast", "capabilities", "kit-files.json"), JSON.stringify({ files: { "authored/t/skill/deploy": [installed] } }));
    const pkg = locateKitItem(home, "deploy");
    expect(pkg.files[0]!.bytes.toString()).toContain("Do the thing.");
  });

  test("--instructions takes one section, up to the next heading of its level", () => {
    const home = tmpHome();
    const file = path.join(home, "CLAUDE.md");
    write(file, "# Project\n\nIntro.\n\n## Release checklist\n\n1. Tag.\n\n### Detail\n\n```\n# not a heading\n```\n\n## Other\n\nNope.\n");
    const pkg = readInstructionSection(`${file}#Release checklist`);
    expect(pkg).toMatchObject({ kind: "instructions", name: "release-checklist" });
    const body = pkg.files[0]!.bytes.toString();
    expect(body).toStartWith("## Release checklist");
    expect(body).toContain("# not a heading");
    expect(body).not.toContain("Other");
    expect(() => readInstructionSection(`${file}#Missing`)).toThrow(/Headings:/);
  });

  test("the daemon's cap_publish runs the same publish and reports it on the command row", async () => {
    const home = tmpHome();
    skill(home, "deploy");
    const routes: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      routes.push(String(url).replace("https://site.test", ""));
      const body = init.headers?.["Content-Type"] === "application/json" ? JSON.parse(init.body) : null;
      if (String(url).endsWith("/upload-url")) {
        expect(body).toEqual({ api_token: "tok" });
        return new Response(JSON.stringify({ upload_url: "https://upload.test/x" }));
      }
      if (String(url).startsWith("https://upload.test")) return new Response(JSON.stringify({ storageId: "st" }));
      expect(body.team_id).toBeUndefined();
      return new Response(JSON.stringify({ status: "created", version: 1, slug: "authored/u1/skill/deploy" }));
    }) as unknown as typeof fetch;
    const ok = await runCapPublishCommand(JSON.stringify({ kind: "skill", name: "deploy" }), { siteUrl: "https://site.test", apiToken: "tok", userId: "u1", home, deviceId: "d", fetchImpl });
    expect("result" in ok && JSON.parse(ok.result)).toMatchObject({ status: "created", slug: "authored/u1/skill/deploy" });
    expect(routes).toEqual(["/cli/cap/kit/upload-url", "https://upload.test/x", "/cli/cap/kit/publish"]);
    expect(await runCapPublishCommand(JSON.stringify({ kind: "skill" }), { siteUrl: "x", apiToken: "t", userId: "u", home, deviceId: "d" })).toEqual({ error: "cap_publish needs a name" });
  });
});
