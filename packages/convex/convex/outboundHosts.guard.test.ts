import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { VENDORS, type Vendor } from "@codecast/shared/contracts/vendorCoverage";

// Regulated health data (HIPAA, plan pl-990): every vendor that receives
// transcript content must be covered by a BAA, so a server fetch to a new host
// is a compliance decision, not a code detail. This reads the source for
// fetches to a literal https host and fails on one not listed here. A host
// joins the list with what it receives; a vendor that sees content needs a BAA
// first (task ct-87100), and names its vendor in the same union as
// BAA_COVERED_VENDORS (contracts/vendorCoverage), so the two lists stay in
// step. Fetches to a computed URL (connectors reading a
// team's own sources, presigned storage URLs) are out of this test's reach.
const ALLOWED: Record<string, { vendor: Vendor; receives: string }> = {
  "api.anthropic.com": { vendor: "anthropic", receives: "transcript content: model calls (lib/anthropic, gated by lib/vendorGuard)" },
  "api.openai.com": { vendor: "openai", receives: "transcript content: suggestions, embeddings, transcription, realtime voice (lib/openai, gated by lib/vendorGuard)" },
  "slack.com": { vendor: "slack", receives: "the team's own Slack workspace (its Slack plan must carry a BAA; ct-87104)" },
  "api.github.com": { vendor: "github", receives: "the team's own GitHub repos: org membership, deploy targets" },
  "api.linear.app": { vendor: "linear", receives: "the team's own Linear workspace, issues the team links" },
  "exp.host": { vendor: "expo", receives: "push notifications to the team's phones (bodies must carry no transcript text for regulated teams)" },
};

const ROOT = import.meta.dir;
const FETCH_HOST = /\bfetch\(\s*["'`]https:\/\/([a-z0-9.-]+)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(test|testkit)\.ts$/.test(name) ? [path] : [];
  });
}

describe("outbound hosts", () => {
  test("the server fetches only hosts whose data handling is recorded", () => {
    const unlisted: string[] = [];
    for (const file of sources(ROOT)) {
      for (const m of readFileSync(file, "utf8").matchAll(FETCH_HOST)) {
        if (!(m[1] in ALLOWED)) unlisted.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(unlisted).toEqual([]);
  });

  test("every allowed host names a known vendor, and every vendor that receives content has a chokepoint", () => {
    for (const [host, entry] of Object.entries(ALLOWED)) expect([host, entry.vendor in VENDORS]).toEqual([host, true]);
    // A content vendor reached over a literal host must be one the guard knows; LiveKit and Tavus are reached
    // at computed URLs (LIVEKIT_URL, the face worker) and gate in callRooms.callsOffReason and callFace.faceMode.
    const contentHosts = Object.values(ALLOWED).filter((e) => VENDORS[e.vendor].receives === "content").map((e) => e.vendor);
    expect(contentHosts.sort()).toEqual(["anthropic", "openai"]);
  });

  test("a content vendor's host is fetched only from its chokepoint", () => {
    const CHOKEPOINT: Partial<Record<Vendor, string>> = { anthropic: "lib/anthropic.ts", openai: "lib/openai.ts" };
    const stray: string[] = [];
    for (const file of sources(ROOT)) {
      for (const m of readFileSync(file, "utf8").matchAll(FETCH_HOST)) {
        const home = CHOKEPOINT[ALLOWED[m[1]]?.vendor];
        if (home && relative(ROOT, file) !== home) stray.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(stray).toEqual([]);
  });
});
