import { describe, expect, it } from "bun:test";
import { compareAccountFingerprints, judgeMintedOwner, attributeFingerprint } from "./ccMintIdentity.js";
import { fetchRateLimitFingerprint } from "./ccAccounts.js";

describe("compareAccountFingerprints", () => {
  it("compares reset times: both match = same, either differs = different, no 7d = unknown", () => {
    const a = { five_hour_reset: 1, seven_day_reset: 2, five_hour_utilization: 0.1, seven_day_utilization: 0.5 };
    expect(compareAccountFingerprints(a, { ...a, five_hour_utilization: 0.9 })).toBe("same");
    expect(compareAccountFingerprints(a, { ...a, five_hour_reset: 3 })).toBe("different");
    expect(compareAccountFingerprints(a, { ...a, seven_day_reset: 9 })).toBe("different");
    expect(compareAccountFingerprints(a, { ...a, seven_day_reset: null })).toBe("unknown");
    const unknown = { five_hour_reset: null, seven_day_reset: null, five_hour_utilization: null, seven_day_utilization: null };
    expect(compareAccountFingerprints(unknown, unknown)).toBe("unknown");
  });

  // Two Team seats answered with a 7d reset and no 5h headers at all
  // (2026-11-25); requiring both windows rejected every mint for them.
  it("an account with no 5-hour window matches on its weekly reset alone", () => {
    const seat = { five_hour_reset: null, seven_day_reset: 2, five_hour_utilization: null, seven_day_utilization: 0.4 };
    expect(compareAccountFingerprints(seat, seat)).toBe("weekly");
    expect(compareAccountFingerprints(seat, { ...seat, seven_day_reset: 3 })).toBe("different");
    // Only one side with a 5-hour window is two plans, so two accounts.
    expect(compareAccountFingerprints(seat, { ...seat, five_hour_reset: 1 })).toBe("different");
    expect(compareAccountFingerprints({ ...seat, five_hour_reset: 1 }, seat)).toBe("different");
  });
});

describe("judgeMintedOwner (whose account a minted token is)", () => {
  const now = 1_788_320_000_000;
  const fp = (five: number | null, seven: number | null) =>
    ({ five_hour_reset: five, seven_day_reset: seven, five_hour_utilization: null, seven_day_utilization: null });
  const profiles = { contact: { uuid: "u-c", email: "contact@x.com" }, jamie: { uuid: "u-j", email: "jamie@x.com" }, other: { uuid: "u-o" } };
  const usage = {
    "u-c": { fetched_at: now, weekly: { percent: 1, resets_at: 1_788_861_600_000 } },
    "u-j": { fetched_at: now, weekly: { percent: 1, resets_at: 1_788_900_000_000 } },
    "u-o": { fetched_at: now, session: { percent: 1, resets_at: 1_788_330_000_000 }, weekly: { percent: 1, resets_at: 1_788_950_000_000 } },
  } as any;
  const judge = (mine: ReturnType<typeof fp> | null, minted: ReturnType<typeof fp>, u = usage) =>
    judgeMintedOwner({ profile: "contact", label: "contact@x.com", mine, minted, profiles, usage: u, now });

  it("both windows matching stores the token for the profile, with no note", () => {
    expect(judge(fp(1_788_324_000, 1_788_861_600), fp(1_788_324_000, 1_788_861_600))).toEqual({ owner: "contact" });
  });

  it("a weekly-only match is stored for the profile and says so", () => {
    const v = judge(fp(null, 1_788_861_600), fp(null, 1_788_861_600));
    expect(v).toMatchObject({ owner: "contact" });
    expect((v as { caveat: string }).caveat).toContain("weekly window only");
  });

  it("a saved account with a 5-hour window, open or closed, is no twin of a token without one", () => {
    for (const resets_at of [now + 3_600_000, now - 3_600_000]) {
      const busy = { ...usage, "u-j": { fetched_at: now, session: { percent: 1, resets_at }, weekly: { percent: 5, resets_at: 1_788_861_600_000 } } };
      const v = judge(fp(null, 1_788_861_600), fp(null, 1_788_861_600), busy);
      expect((v as { caveat: string }).caveat).toContain("weekly window only");
    }
  });

  it("a weekly-only match another saved account shares is stored, but not as verified", () => {
    const twin = { ...usage, "u-j": { fetched_at: now, weekly: { percent: 5, resets_at: 1_788_861_601_000 } } };
    const v = judge(fp(null, 1_788_861_600), fp(null, 1_788_861_600), twin);
    expect(v).toMatchObject({ owner: "contact" });
    expect((v as { caveat: string }).caveat).toContain("not verified");
    expect((v as { caveat: string }).caveat).toContain("jamie@x.com");
  });

  it("long account names keep every message whole under the dialog's 240 characters", () => {
    const long = "someone.long@a-rather-long-company-domain.example"; // 49 characters
    const many = Object.fromEntries(["p1", "p2", "p3", "p4"].map((n) => [n, { uuid: `u-${n}`, email: `${n}.${long}` }]));
    const twins = Object.fromEntries(["p1", "p2", "p3", "p4"].map((n) => [`u-${n}`, { fetched_at: now, weekly: { percent: 1, resets_at: 1_788_861_600_000 } }])) as any;
    const all = { contact: profiles.contact, ...many };
    const shared = judgeMintedOwner({ profile: "contact", label: long, mine: fp(null, 1_788_861_600), minted: fp(null, 1_788_861_600), profiles: all, usage: { ...usage, ...twins }, now });
    const rejected = judgeMintedOwner({ profile: "contact", label: long, mine: fp(1, 1_788_861_600), minted: fp(2, 1_788_861_600), profiles, usage, now });
    expect((shared as { caveat: string }).caveat.length).toBeLessThanOrEqual(240);
    expect((rejected as { rejected: string }).rejected.length).toBeLessThanOrEqual(240);
  });

  it("a proven different account goes to the saved profile it matches, else is rejected as different", () => {
    expect(judge(fp(1_788_324_000, 1_788_861_600), fp(1_788_330_000, 1_788_950_000))).toEqual({ owner: "other" });
    const v = judge(fp(1_788_324_000, 1_788_861_600), fp(1_788_340_000, 1_789_000_000));
    expect("rejected" in v && v.rejected).toContain("different Claude account than contact@x.com");
  });

  // Writing the token to another saved profile replaces that profile's token,
  // so a weekly reset alone (seats created together share one) never moves it.
  it("a snapshot names another saved profile as owner only on both windows", () => {
    expect("rejected" in judge(fp(1_788_324_000, 1_788_861_600), fp(null, 1_788_900_000))).toBe(true);
    // With contact's own snapshot unknown, a weekly-only hit on jamie does not
    // move the token there.
    const blindContact = { ...usage, "u-c": undefined };
    const v = judge(null, fp(null, 1_788_900_000), blindContact);
    expect(v).toMatchObject({ owner: "contact" });
    expect((v as { caveat: string }).caveat).toContain("not verified");
    expect((v as { caveat: string }).caveat).toContain("matches jamie@x.com");
  });

  it("with the saved login dead, the profile's own current weekly reset can still rule it out", () => {
    // contact's snapshot says its week resets at 1_788_861_600; the token's
    // resets elsewhere, so it is not contact's.
    expect("rejected" in judge(null, fp(null, 1_788_900_000))).toBe(true);
    // A snapshot from a week that has already rolled says nothing.
    const stale = { ...usage, "u-c": { fetched_at: now - 8 * 86_400_000, weekly: { percent: 1, resets_at: now - 86_400_000 } } };
    expect(judge(null, fp(null, 1_789_000_000), stale)).toMatchObject({ owner: "contact" });
  });

  it("a snapshot naming the profile cannot overrule a direct comparison that proved otherwise", () => {
    const v = judge(fp(null, 1_788_900_000), fp(null, 1_788_861_600));
    expect("rejected" in v).toBe(true);
  });

  it("when nothing can be compared, a snapshot names the owner, else the profile keeps it with a note", () => {
    expect(judge(null, fp(1_788_330_000, 1_788_950_000))).toEqual({ owner: "other" });
    const weeklySelf = judge(null, fp(null, 1_788_861_600));
    expect(weeklySelf).toMatchObject({ owner: "contact" });
    expect((weeklySelf as { caveat: string }).caveat).toContain("weekly window only");
    // Nor does contact's own snapshot know this week.
    const noOwn = { ...usage, "u-c": undefined };
    const dead = judge(null, fp(null, 1_789_000_000), noOwn);
    expect(dead).toMatchObject({ owner: "contact" });
    expect((dead as { caveat: string }).caveat).toContain("could not vouch");
    const blind = judge(fp(1, null), fp(null, 1_789_000_000), noOwn);
    expect(blind).toMatchObject({ owner: "contact" });
    expect((blind as { caveat: string }).caveat).toContain("could not be compared");
  });
});

describe("fetchRateLimitFingerprint", () => {
  const respond = (status: number, headers: Record<string, string>) =>
    (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;

  it("a limit refusal carrying only the 7d window still fingerprints the account", async () => {
    const fp = await fetchRateLimitFingerprint("t", respond(429, { "anthropic-ratelimit-unified-7d-reset": "1788861600" }));
    expect(fp.seven_day_reset).toBe(1_788_861_600);
    expect(fp.five_hour_reset).toBeNull();
  });

  it("a refusal naming no 7d window is a failed probe", async () => {
    await expect(fetchRateLimitFingerprint("t", respond(401, {}))).rejects.toThrow("Account probe failed");
  });
});

describe("attributeFingerprint (token → saved profile via usage snapshots)", () => {
  const now = 1_788_320_000_000; // ms
  const profiles = { a: { uuid: "u-a" }, b: { uuid: "u-b" }, c: { email: "c@x.com" } };
  const usage = {
    "u-a": { fetched_at: now, session: { percent: 1, resets_at: 1_788_324_000_000 }, weekly: { percent: 1, resets_at: 1_788_861_600_000 } },
    "u-b": { fetched_at: now, session: { percent: 1, resets_at: 1_788_330_000_000 }, weekly: { percent: 1, resets_at: 1_788_900_000_000 } },
    "c@x.com": { fetched_at: now - 86_400_000, session: { percent: 1, resets_at: 1_788_200_000_000 }, weekly: { percent: 1, resets_at: 1_788_950_000_000 } },
  } as any;
  const fp = (five: number | null, seven: number | null) =>
    ({ five_hour_reset: five, seven_day_reset: seven, five_hour_utilization: null, seven_day_utilization: null });

  it("names the one profile whose 7d and (open) 5h windows match, to the second", () => {
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), profiles, usage, now)).toBe("a");
    expect(attributeFingerprint(fp(1_788_324_001, 1_788_861_600), profiles, usage, now)).toBe("a"); // ±2s
  });

  it("an open 5h window that disagrees rules the profile out even when 7d matches", () => {
    expect(attributeFingerprint(fp(1_788_325_000, 1_788_861_600), profiles, usage, now)).toBeNull();
  });

  it("a stale snapshot (5h window already closed) attributes on the 7d reset alone", () => {
    expect(attributeFingerprint(fp(1_788_400_000, 1_788_950_000), profiles, usage, now)).toBe("c");
  });

  it("unknown 7d reset, no snapshot, or an ambiguous match yields null", () => {
    expect(attributeFingerprint(fp(1, null), profiles, usage, now)).toBeNull();
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), { z: { uuid: "u-z" } }, usage, now)).toBeNull();
    const twin = { ...usage, "u-b": usage["u-a"] };
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), profiles, twin, now)).toBeNull();
  });
});
