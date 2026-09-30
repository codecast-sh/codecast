import { describe, expect, test } from "bun:test";
import { parseSessionQuery } from "@codecast/shared/search";
import { commitPath, prPath } from "../externalEvents";
import { fileSessionsLink, sessionsLinkForAppPath } from "../sessionSearchLinks";

const q = (href: string) => parseSessionQuery(new URLSearchParams(href.split("?")[1]).get("q") ?? "");

describe("session search links", () => {
  test("a file is searched repo-relative under its checkout, absolute outside it", () => {
    expect(q(fileSessionsLink("/src/app/web/a b.ts", "/src/app").href).files).toEqual(["web/a b.ts"]);
    expect(q(fileSessionsLink("/tmp/x.ts", "/src/app").href).files).toEqual(["/tmp/x.ts"]);
    expect(q(fileSessionsLink("/tmp/x.ts").href).files).toEqual(["/tmp/x.ts"]);
  });

  test("commit and pull request pages read back into their filters", () => {
    const sha = "3f2a91cdeadbeef3f2a91cdeadbeef3f2a91cde";
    expect(q(sessionsLinkForAppPath(commitPath({ repository: "acme/web", sha })!)!.href).commits).toEqual([sha]);
    expect(q(sessionsLinkForAppPath(prPath({ repository: "acme/web", number: 42 })! + "?tab=files")!.href).prs).toEqual([
      { repository: "acme/web", number: 42 },
    ]);
    expect(sessionsLinkForAppPath("/conversation/abc")).toBeNull();
    expect(sessionsLinkForAppPath("/pr/acme/web")).toBeNull();
  });
});
