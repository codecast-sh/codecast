import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { inboxEpoch } from "../inboxProjection";
import { genWorld } from "./inboxProjectionGen";
import { TEAM_WORLD_MAX_USERS, genTeamWorld, teamIdFor, userIdFor, type TeamWorldSpec } from "./teamWorldGen";

const EPOCH = inboxEpoch(1_800_000_000_000);
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// genWorld output for every seed a legacy suite builds a world from, captured
// before teamWorldGen existed. The web sims call seededWorld(seed) =
// genWorld(seed, 45, EPOCH, "u" x 32); the convex convergence suite calls
// genWorld(seed, n <= 90, EPOCH, "users_me"). Rows draw from one stream in
// order, so a smaller count is a prefix of the larger world pinned here
// (seededWorld(31, 30) is the head of seed 31's 45 rows, the convex 50 to 80
// row worlds the head of their 90). A changed hash means a pinned world moved:
// never re-pin without triage.
const WEB_ME = "u".repeat(32);
const CONVEX_ME = "users_me";
const PINNED: Array<[seed: number, count: number, me: string, hash: string]> = [
  [11, 45, WEB_ME, "5d6cad9b18997463fcc46e669360d84054ce20d1afe1125817204663b9ad8b20"],
  [21, 45, WEB_ME, "54ac7360050e32365fcb769b41ad4862f03d9fb3394b9267a6e8874c3b03e19d"],
  [22, 45, WEB_ME, "b17c176a740de79a61d72039920cd2fd84e3e9b9adb5eac65986189fb4305292"],
  [23, 45, WEB_ME, "9d3d67bd9b4cfdb48abc74d03f85b2fbbfc5052f8b1d98af71bb74bc58c1d5bf"],
  [24, 45, WEB_ME, "a4c45d883b14e31ad285a4644400919af7508f17d523f336921b7e2087b5613e"],
  [25, 45, WEB_ME, "80e1985847d018775033fd6c1506d7d1b447e5e0b747667c079e278f7c1be628"],
  [26, 45, WEB_ME, "e0f663456256d641bdc7fcb3e9041fcc6896daab11c37a29247f2af6a7789073"],
  [27, 45, WEB_ME, "3b19084d3f0c4fe7e60749407dabfb6a7e57ff275665320cc40fbdcad40a6e96"],
  [28, 45, WEB_ME, "7330daed267a49bef63fdc1347b4a0d52abe02b72decd9b3a957f5bc69ec5006"],
  [29, 45, WEB_ME, "590b1f10e6035c9a1bcff5086f4d693dbc92b389ad73044c4238f6f73241860b"],
  [30, 45, WEB_ME, "9715e0cfeb407c3ea1f1323fff988d8302b30453d0b3cefff3f08c2622bf9054"],
  [31, 45, WEB_ME, "bb8de0991ec3e4d795bf8a5beb22d9c452b326b0efc7808ffff4b977f047b9bb"],
  [32, 45, WEB_ME, "9af4e3937398e729d5d6218b6b5d0b7aaf762ac0952f77bbc36acdf404238d6e"],
  [41, 45, WEB_ME, "84440123be5d235870d1ed34b4346394bc4db4a5865c2c9f04e2761eb7c3c127"],
  [42, 45, WEB_ME, "14b0ad288fa469d0e01940c07fc2eaaf996ad552a7482cb4820b951404d3a736"],
  [43, 45, WEB_ME, "112a28a686b5acbe3722d6cc0bac9738542630e801cb803b9ba907a932ceee57"],
  [51, 45, WEB_ME, "2967cd7b342c1ca1d87e3292a91822e161968738a23e1585106427f407e5558c"],
  [52, 45, WEB_ME, "5b2e8f242a274c91cc5ab62adc3cb0bd20d0c70268e51102117d2afdbf36f8e1"],
  [61, 45, WEB_ME, "10ddde7ee691d183e7d5c6f4685e122127e77b1c26cc3a259a2265e327997b88"],
  [71, 45, WEB_ME, "8acd3ada0e0fe0d098d4fb120b2f9c5bf191ead398bb54a135d82e72f3cd1f89"],
  [72, 45, WEB_ME, "0fbde65f97a0b9e0de54ebed730871115225077d8dc200f6a711229af8bff2d5"],
  [81, 45, WEB_ME, "883379e81534762fa670ba1df907d01bf8f40ea485d7e2eb8a0f98a0087693e3"],
  [82, 45, WEB_ME, "c6df98a22ee1762117c1f82aeeace6c8be448afe450d9f7358da04a420301ed6"],
  [83, 45, WEB_ME, "f7e59b9721861b5888dd531cd8fd7aa3221aa9a75463cefc151622e73343c9f0"],
  [84, 45, WEB_ME, "dd5f7d64e80280823eefac4aef0c4b7b5a75f04deccd572eb5cba1ebbe65017c"],
  [85, 45, WEB_ME, "da81e4930dcf0f56e6484631212f60694d179e50b98b815bbb8a206ca6036c97"],
  [86, 45, WEB_ME, "4d36349a21c052c22de176faf37c69fb6ad2496b3565040d45e18eb250070e37"],
  [87, 45, WEB_ME, "64cca24f83dc0ee7ff661271ce2220a8e3556d671b7bd985d14cb9a94569cef1"],
  [88, 45, WEB_ME, "f19046fef7eb295622175cafdde227f7fda602b0f9525abeb85bc3b29bb18bf4"],
  [89, 45, WEB_ME, "718c6479ac8ba030ba801edd1c19eb8affcbb558df9ca9ddd4afad321b16bc9b"],
  [90, 45, WEB_ME, "cea050049753ea1630ffdab33b3e599c54dfdf5575c92fcf4cd36d159eb1bd50"],
  [91, 45, WEB_ME, "a2d8defe1e31237135bd45219b7ce7cf39247cdc59106f8eed837a17f53c1626"],
  [92, 45, WEB_ME, "5367726e434bcdbd44bd7fe77345b2812b52492c5f63bf72a160d8ae393309f2"],
  [101, 45, WEB_ME, "8018ede65d83be72763fa0cac9c0c8c6aff86d26a3a5de5526b2d7b35f128556"],
  [102, 45, WEB_ME, "c754390d16c61b6d95a247a47f8995b3332d9d4d1c54da59335fdaed1e62d144"],
  [111, 45, WEB_ME, "0286f44e7e5c44519ef10ebbd31c5e62259cf8c5fcaa9e55ba5b1e5a91aebd78"],
  [500, 90, CONVEX_ME, "546a27168114ec15f2115aa7b034c2f440f71c627095a0ebce383bcf92c68bac"],
  [501, 90, CONVEX_ME, "8859da59257d7562bf07db97ee2283f4946b0b592bf8031523b1e5048bda1805"],
  [502, 90, CONVEX_ME, "49ccabb95991e89d0aff636242980f1715278adbf9905a83b258c1f55c969afa"],
  [503, 90, CONVEX_ME, "3a677c6fb575d765ccd750e627fcbe66d679aca7e5b7c35c2a11915165d675bb"],
  [504, 90, CONVEX_ME, "2c9c3a23b6956d3d7d3635abae0c287c4de464f0c4aeaa5935cf6870091cd63b"],
  [505, 90, CONVEX_ME, "65b5d72351c951159e4ca7d2bbd58eb141a76d7c0ff760e8bfb259cc9ad9efad"],
  [506, 90, CONVEX_ME, "26c47be487cab61230c77ef98275fe62ec8df81feadcf855c34de0cb52c3e7b5"],
  [507, 90, CONVEX_ME, "952aab331bd0f9756fa4f872edf3c738f55ba5a04627aaa0d64bd5a8e2576332"],
  [508, 90, CONVEX_ME, "613a3ec0ff2fe98859329d766a4f9205bab6e18733b47574a9dfe1f1e1fbeed5"],
  [509, 90, CONVEX_ME, "47d9ed5f9cc77c39c10bac8d280fe0440a15d0991a6c9aa9cd9e09647f02015e"],
  [510, 90, CONVEX_ME, "18df7f9286b44361232b8b78ef6988eb51ac4c7788521a377554c2de440e7817"],
  [511, 90, CONVEX_ME, "07af566502da2ef4c6a6f36d74de7e80db0800cb572177a3cbe9b8a6ff38d03d"],
  [512, 90, CONVEX_ME, "da6d38ca28d9e329e1c91970a042c87839815948f6a825f701adbd952605040c"],
  [513, 90, CONVEX_ME, "bffeb3c1c2c0e1ddf8284568bfcdf7e58304cdf5af59cbf2c0da62988ae29b15"],
  [77, 10, CONVEX_ME, "df14825e25a7bb483ff639ae62caa74bf92606ac3d7c90c4f97b1de0cb3ef27b"],
  [9, 40, CONVEX_ME, "e5fcd9574ae85acf8b32cf459a3260f57e94026f72c8014926a19650e9cc8bac"],
];

const NAMES = Array.from({ length: TEAM_WORLD_MAX_USERS }, (_, i) => `user${i}`);
const fullSpec = (seed: number): TeamWorldSpec => ({
  users: NAMES,
  teams: [
    { name: "acme", members: NAMES.slice(0, 6), features: { chat: true, org: true } },
    { name: "beta", members: NAMES.slice(4, 12) },
  ],
  rowsPerUser: 45,
  seed,
  epoch: EPOCH,
});

describe("genWorld stays pinned for the legacy suites", () => {
  test.each(PINNED)("seed %d, %d rows, me %s", (seed, count, me, hash) => {
    expect(sha(genWorld(seed, count, EPOCH, me))).toBe(hash);
  });
});

describe("genTeamWorld", () => {
  test("each user's world is genWorld at seed * 16 + index, owned by that user", () => {
    const w = genTeamWorld(fullSpec(7));
    NAMES.forEach((name, i) => {
      expect(w.perUser[name]).toEqual(genWorld(7 * 16 + i, 45, EPOCH, userIdFor(name)));
      for (const c of w.perUser[name].conversations) expect(c.user_id).toBe(userIdFor(name));
    });
  });

  test("teams, memberships and users match what teams.create and teams.join write", () => {
    const w = genTeamWorld({
      users: ["ada", "bo", "cy"],
      teams: [{ name: "acme", members: ["ada", "bo"], features: { org: true } }, { name: "beta", members: ["bo"] }],
      rowsPerUser: 5,
      seed: 1,
      epoch: EPOCH,
    });
    const acme = teamIdFor("acme");
    expect(w.teams.map((t) => [t._id, t.name, t.features])).toEqual([[acme, "acme", { org: true }], [teamIdFor("beta"), "beta", undefined]]);
    expect(w.team_memberships.map((m) => [m.user_id, m.team_id, m.role])).toEqual([
      [userIdFor("ada"), acme, "admin"],
      [userIdFor("bo"), acme, "member"],
      [userIdFor("bo"), teamIdFor("beta"), "admin"],
    ]);
    const byName = Object.fromEntries(w.users.map((u) => [u.name, u]));
    expect(byName.bo.team_id).toBe(acme);
    expect(byName.bo.active_team_id).toBe(acme);
    expect(byName.cy.team_id).toBeUndefined();
    for (const id of [...w.users, ...w.teams, ...w.team_memberships].map((r) => r._id)) expect(id).toMatch(/^[a-z0-9]{32}$/);
    // Every session predates nothing a membership gates: members joined first.
    const earliestStart = Math.min(...Object.values(w.perUser).flatMap((p) => p.conversations.map((c) => c.started_at)));
    for (const m of w.team_memberships) expect(m.joined_at).toBeLessThan(earliestStart);
  });

  test("no two users' conversation ids or tags collide across seeds 1-50", () => {
    const ids = new Map<string, string>();
    const titles = new Map<string, string>();
    const claim = (map: Map<string, string>, key: string, owner: string) => {
      const prior = map.get(key);
      if (prior !== undefined) throw new Error(`${key} held by ${prior} and ${owner}`);
      map.set(key, owner);
    };
    for (let seed = 1; seed <= 50; seed++) {
      const w = genTeamWorld(fullSpec(seed));
      for (const r of [...w.users, ...w.teams, ...w.team_memberships]) {
        if (seed === 1) claim(ids, r._id, "genesis");
        else expect(ids.get(r._id)).toBe("genesis");
      }
      for (const [name, world] of Object.entries(w.perUser)) {
        const owner = `seed ${seed} ${name}`;
        const own = new Set(world.conversations.map((c) => c._id));
        for (const c of world.conversations) {
          claim(ids, c._id, owner);
          if (c.title.startsWith("Session ")) claim(titles, c.title, owner);
          // A lead pointer never reaches into another user's sessions.
          if (c.spawned_by_conversation_id) expect(own.has(c.spawned_by_conversation_id)).toBe(true);
        }
        for (const r of [...world.managed_sessions, ...world.session_decisions]) claim(ids, r._id, owner);
      }
    }
    // 50 seeds x 16 users x 45 rows, each with a distinct id.
    expect([...ids.values()].filter((o) => o !== "genesis").length).toBeGreaterThan(50 * 16 * 45);
  });

  test("every armed_trigger_kind genWorld stamps is backed by one armed trigger", () => {
    const w = genTeamWorld(fullSpec(3));
    const armed = Object.values(w.perUser).flatMap((p) => p.conversations.filter((c) => c.armed_trigger_kind));
    expect(armed.length).toBeGreaterThan(0);
    expect(w.agent_tasks.length).toBe(armed.length);
    const byHome = new Map(w.agent_tasks.map((t) => [t.originating_conversation_id, t]));
    for (const c of armed) {
      const t = byHome.get(c._id)!;
      expect([t.user_id, t.status, t.schedule_type]).toEqual([c.user_id, "scheduled", c.armed_trigger_kind === "standing" ? "recurring" : "once"]);
      expect(t._id).toMatch(/^[a-z0-9]{32}$/);
    }
    expect(new Set(w.agent_tasks.map((t) => t._id)).size).toBe(w.agent_tasks.length);
  });

  test("refuses specs that would merge or misattribute rows", () => {
    const base = { rowsPerUser: 1, seed: 1, epoch: EPOCH };
    expect(() => genTeamWorld({ ...base, users: [...NAMES, "extra"], teams: [] })).toThrow(/at most 16/);
    expect(() => genTeamWorld({ ...base, users: ["ada"], teams: [{ name: "acme", members: ["bo"] }] })).toThrow(/not in users/);
    expect(() => genTeamWorld({ ...base, users: ["ada"], teams: [{ name: "acme", members: ["ada", "ada"] }] })).toThrow(/twice/);
    expect(() => genTeamWorld({ ...base, users: ["Ada", "ada"], teams: [] })).toThrow(/collides/);
  });

  test("is deterministic", () => {
    expect(sha(genTeamWorld(fullSpec(3)))).toBe(sha(genTeamWorld(fullSpec(3))));
  });
});
