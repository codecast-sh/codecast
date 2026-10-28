import { describe, expect, test } from "bun:test";
import { removedByTeam } from "./mdm.js";

const TOKEN = "cc_enr_" + "a".repeat(48);
const answer = (body: unknown, status = 403) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("removedByTeam", () => {
  test("names the team when the enroll endpoint says its admins removed the device", async () => {
    const fetchImpl = answer({ ok: false, error: "Acme's admins removed this device.", removed_by: "Acme" });
    expect(await removedByTeam("https://x.site", "dev-1", { enrollment_token: TOKEN }, fetchImpl)).toBe("Acme");
  });
  test("null for any other refusal, an unreachable server, or a machine without a token", async () => {
    expect(await removedByTeam("https://x.site", "dev-1", { enrollment_token: TOKEN }, answer({ ok: false, error: "revoked token" }))).toBeNull();
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await removedByTeam("https://x.site", "dev-1", { enrollment_token: TOKEN }, down)).toBeNull();
    let called = false;
    const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await removedByTeam("https://x.site", "dev-1", {}, spy)).toBeNull();
    expect(called).toBe(false);
  });
});
