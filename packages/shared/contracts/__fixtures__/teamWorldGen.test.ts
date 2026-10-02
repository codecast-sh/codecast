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
// never re-pin without triage. (Re-pinned 2026-10-02 when decide rows gained
// blocking/default_option/stack_id from their own stream: every world hashed
// equal to its old pin with those three fields stripped.)
const WEB_ME = "u".repeat(32);
const CONVEX_ME = "users_me";
const PINNED: Array<[seed: number, count: number, me: string, hash: string]> = [
  [11, 45, WEB_ME, "eec9be50246e560ab0cd1a584049d7989f7680c1d522e299ff451d7f0617c081"],
  [21, 45, WEB_ME, "54a0435a5a51852559f4f14b701045d6d5489b33d8d1b76f36348c253e381236"],
  [22, 45, WEB_ME, "a80ef53aab4411a50d9e4c6e191f63df11abb05d352087c53fad545305f49fa3"],
  [23, 45, WEB_ME, "8285d1196d98c94be1b3ce655f05484d914edbc6e051ffbab41fc619bf717e12"],
  [24, 45, WEB_ME, "5668567816d2cb53cc1fc171ff6dd40497da1e806f9a9a7f96640bb7f7566fdf"],
  [25, 45, WEB_ME, "d2ef3c7d5675863c3a9cae377aa25366bb888acce8ec1e27e6fe1c61bd3c5dde"],
  [26, 45, WEB_ME, "e0f663456256d641bdc7fcb3e9041fcc6896daab11c37a29247f2af6a7789073"],
  [27, 45, WEB_ME, "3b19084d3f0c4fe7e60749407dabfb6a7e57ff275665320cc40fbdcad40a6e96"],
  [28, 45, WEB_ME, "8c96759233d6fa4c200bc69cbf816996aa765ef34df60bcb9b784f4697af109c"],
  [29, 45, WEB_ME, "888b851882142518ecb7c0a4f4c8dca1f28f8318fb82ab9fd497a1d23ba1d6de"],
  [30, 45, WEB_ME, "7752f323aa5ddad1e2a4ff91e0e1bdd66aadd28699f7a486f7b1246442ec1791"],
  [31, 45, WEB_ME, "19c5041dd5eb0f8b1d60e26e4b2f144c997db99d557bf56b749a5099a75b54de"],
  [32, 45, WEB_ME, "f918204caaa0502946cd9a3b5b21fe3a8694619495a7b26046cd238dc7e71041"],
  [41, 45, WEB_ME, "01e6e017892acc1c309bff2bdbe8f36ff0ac9be1534e7166412fd6e5a77763d4"],
  [42, 45, WEB_ME, "6d9ef93b482701b70e718ff7da383e30ae989d2855495bd9b413abe131fb436b"],
  [43, 45, WEB_ME, "832ebcba5beb41705b059963d7466bf7a16f1d9e842fc9485b2317feb8100b01"],
  [51, 45, WEB_ME, "471b89126c253a1edc934025912805a682a52f0abc9ba94a75fbd1f244688fc3"],
  [52, 45, WEB_ME, "ec4c45542f90903d68241346b06aa7e3958be14ff92daee16c2a2d570e1af364"],
  [61, 45, WEB_ME, "77de0a53f01d8c1aac75d23e9092f66709e2eaf6f94dc770f3076c91bd4be929"],
  [71, 45, WEB_ME, "36c8003df6d1749bc819412a6aa9fe11901ea2a0646738c7277f6a64374826f5"],
  [72, 45, WEB_ME, "38819e4998bb6f7f5b57f896ad7ca5e59470f8a9e878c4e0191b958e9ece6b63"],
  [81, 45, WEB_ME, "088fa92a60c459438b500072738b7c4d77a9d608a76837ba9f5cd3feb19a0691"],
  [82, 45, WEB_ME, "6ae41da69dc6d942c657837eb2a8434bd6a15918da9cc4d1ad022bc5b691680b"],
  [83, 45, WEB_ME, "49202fc2c3d689995d1c19f22960c522a227425a208880ce4cd9996c1682bb5a"],
  [84, 45, WEB_ME, "61e3bcb287e662409512a09b04623c8ea1a4f9e3be3b5649d05398d7893a31d6"],
  [85, 45, WEB_ME, "ec795c80b3ce83db971df9e49ea1cafcc07f797d46224739a89e61a71f7aa83f"],
  [86, 45, WEB_ME, "dddb8ab2ffb6fa62734b6cb96ff71385db827c6a841f1570760333aea576796c"],
  [87, 45, WEB_ME, "1c7876d8a767df10c6c995ba2f7ece2b9eadff27e473e96a960c8f00168b27f4"],
  [88, 45, WEB_ME, "f19046fef7eb295622175cafdde227f7fda602b0f9525abeb85bc3b29bb18bf4"],
  [89, 45, WEB_ME, "718c6479ac8ba030ba801edd1c19eb8affcbb558df9ca9ddd4afad321b16bc9b"],
  [90, 45, WEB_ME, "cd3ce266b6bd3e9f097e794d1f26344950a7895f5fa0821ca92022f16cad56b5"],
  [91, 45, WEB_ME, "3f9cde9e535ea326b828c624cb076eef4ef6be8cfc68adee0e6f972ac0d03af4"],
  [92, 45, WEB_ME, "aec29aee9509b1762c97ea2dd1afaf2f0f7556091af9785fa241c39c5801025f"],
  [101, 45, WEB_ME, "7754757352ce2d1bdabcb8e756f9583cb45cd301f45460f77ced25fc92ff50a1"],
  [102, 45, WEB_ME, "6940bf9c07cf884527725674e9c772f6056bb9065304aacd530118975c6de46d"],
  [111, 45, WEB_ME, "1fb97ecb05ebd9fb1f770183173cc8ad1e75c9e59583d6523ba09c1db121cd8d"],
  [500, 90, CONVEX_ME, "d6eb43b13a9a74a68f7cc5a572920f9e45eb38ddbfba8b501a017d2f26e50407"],
  [501, 90, CONVEX_ME, "ed8d2057b96eb69a23bfc5e3b113aadc916340be1c7e36f77bbe7bbd3744e922"],
  [502, 90, CONVEX_ME, "6f3566b48a110a5904956f4ad88948fd69005b7ffb46ad44a2af13d580e5e157"],
  [503, 90, CONVEX_ME, "cb3e404b369037fb4e288851b5d95749605178567ec2d96f90cfaaf4073a4385"],
  [504, 90, CONVEX_ME, "d83c9ed417b86b1ea00922f4888c6607f90845a516ca3e97d7343e9719a83304"],
  [505, 90, CONVEX_ME, "5068ed236bbd6594dacfaf3aa09386890817231435dd3c03666a65402a4245f3"],
  [506, 90, CONVEX_ME, "ea89903e9e8f1c00cd302f1b397f4e3a370467e2d4474a0ad1c594e21022b5e1"],
  [507, 90, CONVEX_ME, "1d4e724bcba3575646cab803659f0868f2ad80899e82af379dbccb807bf95159"],
  [508, 90, CONVEX_ME, "0452a3876a61ff7455ee9ec5000010117f0c423a911f1c3078ba96b9ec56ffba"],
  [509, 90, CONVEX_ME, "b5583cf5671279f1ce55a1ddec55c60dc79ccb0c6f8fcdb8a7a984d5a42d3f1b"],
  [510, 90, CONVEX_ME, "7d53d19d417fc754037df27f1183283f37b0ff3d8e7bb2825e64726efc496036"],
  [511, 90, CONVEX_ME, "ad145ff1c5615fd84ce86dc7046eb99b7ff5f57fabf0d1515f1350f295197a43"],
  [512, 90, CONVEX_ME, "23ae91dc3be83d6949b59933e235e93b46bb87f2b17968c24b62b2df40983f76"],
  [513, 90, CONVEX_ME, "4a63b365dc7687d23c147802ac19046000b456986e2a38828f8771719302d9c7"],
  [77, 10, CONVEX_ME, "df14825e25a7bb483ff639ae62caa74bf92606ac3d7c90c4f97b1de0cb3ef27b"],
  [9, 40, CONVEX_ME, "acf3a8acea7534823824be21fd9f59eda7fcbf3d6c0a370c27eac9eec768b280"],
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
