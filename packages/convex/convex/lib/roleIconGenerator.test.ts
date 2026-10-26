import { describe, expect, test } from "bun:test";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { roleIconSvg, type RoleIcon } from "@codecast/shared/contracts/roleIcon";
import { DIRECTIONS, contactSheet, drawRequest, generateRoleIcon, judgeRequest, parseCandidate, parseVerdict, vetCandidate, type AskRequest, type IconBrief } from "./roleIconGenerator";
import { iconMask, maskIoU } from "./roleIconRaster";

// The generator's pipeline with the model stubbed: what the drawers and the
// judge are told, how replies are read, and the checks between them.

const ex = (concept: string) => ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === concept)!;
const siblings = ["coin", "database", "heart"].map((c) => ({ title: ex(c).title, icon: ex(c).icon }));
const brief: IconBrief = {
  role_id: "org_roles_up", title: "Upkeep lead", handle: "upkeep", charter: "Keeps the house and the machines in working order.",
  siblings, examples: ROLE_ICON_EXAMPLES.filter((e) => e.title !== "Upkeep lead"), accent: "green",
};
const svgOf = (icon: RoleIcon) => roleIconSvg(icon);
const WRENCH = `<svg viewBox="0 0 24 24"><path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z"/></svg>`;
const HAMMER = `<svg viewBox="0 0 24 24"><rect x="5" y="4" width="10" height="5" rx="1.5"/><line x1="10" y1="9" x2="10" y2="20"/></svg>`;
const reply = (concept: string, svg: string) => JSON.stringify({ concept, reasoning: `a ${concept}`, svg });

describe("drawRequest", () => {
  test("carries the brief, the house set, the taken icons and the direction", () => {
    const r = drawRequest(brief, 1, "too thin");
    expect(r.system).toContain("Role icon design language");
    expect(r.prompt).toContain("Upkeep lead (@upkeep)");
    expect(r.prompt).toContain("Keeps the house");
    expect(r.prompt).toContain(`"coin", "database", "heart"`);
    expect(r.prompt).toContain(svgOf(ex("database").icon).replace(/ xmlns="[^"]*"/, ""));
    expect(r.prompt).toContain(DIRECTIONS[1]);
    expect(r.prompt).toContain("too thin");
    expect(r.prompt).not.toContain("person's steer");
    expect(drawRequest({ ...brief, hint: "something botanical" }, 0).prompt).toContain("something botanical");
  });

  test("never shows the drawer an answer: the role's own example is left out by the caller", () => {
    expect(drawRequest(brief, 0).prompt).not.toContain("Upkeep lead: ");
  });
});

describe("parseCandidate", () => {
  test("reads the JSON object, fenced or with prose around it", () => {
    expect(parseCandidate(reply("wrench", WRENCH))?.concept).toBe("wrench");
    expect(parseCandidate("Here:\n```json\n" + reply("hammer", HAMMER) + "\n```")?.svg).toBe(HAMMER);
  });
  test("null for a reply without concept and svg", () => {
    expect(parseCandidate("I can't draw that")).toBeNull();
    expect(parseCandidate(JSON.stringify({ concept: "x" }))).toBeNull();
    expect(parseCandidate(null)).toBeNull();
  });
});

describe("vetCandidate", () => {
  test("a clean drawing becomes an icon in the brief's accent, with its closest sibling", () => {
    const v = vetCandidate({ concept: "wrench", reasoning: "", svg: WRENCH }, siblings, "green");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.icon.accent).toBe("green");
      expect(v.closest!.iou).toBeLessThan(0.7);
    }
  });
  test("refuses a taken concept, invalid SVG, and a silhouette a sibling already has", () => {
    expect(vetCandidate({ concept: "Coin", reasoning: "", svg: WRENCH }, siblings, "green")).toMatchObject({ ok: false, problems: [expect.stringContaining("Finances lead")] });
    expect(vetCandidate({ concept: "x", reasoning: "", svg: `<svg><text>W</text></svg>` }, siblings, "green").ok).toBe(false);
    // The database redrawn under another name is the same shape.
    const copy = svgOf(ex("database").icon);
    const same = vetCandidate({ concept: "storage", reasoning: "", svg: copy }, siblings, "green");
    expect(same).toMatchObject({ ok: false, problems: [expect.stringContaining("silhouette overlaps Infrastructure lead")] });
  });
});

describe("silhouette IoU", () => {
  test("a glyph matches itself, and the house icons stay apart", () => {
    const db = iconMask(ex("database").icon);
    expect(maskIoU(db, db)).toBe(1);
    expect(maskIoU(db, iconMask(ex("heart").icon))).toBeLessThan(0.5);
  });
});

describe("contactSheet", () => {
  test("is a PNG", () => {
    const png = contactSheet([ex("wrench").icon, ex("sprout").icon], siblings);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

describe("judge", () => {
  test("the request names each candidate by its sheet letter", () => {
    const c = [{ icon: { ...ex("wrench").icon, accent: "green" as const }, reasoning: "fixes things" }, { icon: ex("sprout").icon, reasoning: "" }];
    const r = judgeRequest(brief, c);
    expect(r.prompt).toContain(`A: "wrench". The drawer's reasoning: fixes things`);
    expect(r.prompt).toContain(`B: "sprout"`);
    expect(r.prompt).toContain(`Finances lead ("coin")`);
  });
  test("parseVerdict reads a letter in range, else no winner", () => {
    expect(parseVerdict(`{"winner":"b","rationale":"clear","critique":""}`, 2)).toEqual({ winner: 1, rationale: "clear", critique: "" });
    expect(parseVerdict(`{"winner":"C","rationale":"","critique":""}`, 2)?.winner).toBeNull();
    expect(parseVerdict(`{"winner":null,"rationale":"","critique":"try a broom"}`, 2)).toEqual({ winner: null, rationale: "", critique: "try a broom" });
    expect(parseVerdict("no", 2)).toBeNull();
  });
});

describe("generateRoleIcon", () => {
  const usage = { input_tokens: 100, output_tokens: 10 };
  test("draws three, judges the distinct survivors, returns the winner with a preview", async () => {
    const asked: AskRequest[] = [];
    const answers = [reply("wrench", WRENCH), reply("wrench", WRENCH), reply("hammer", HAMMER)];
    const result = await generateRoleIcon(brief, async (req) => {
      asked.push(req);
      if (req.image) return { text: `{"winner":"B","rationale":"a hammer says upkeep","critique":""}`, usage };
      return { text: answers[asked.length - 1], usage };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.icon.concept).toBe("hammer");
    expect(result.rationale).toBe("a hammer says upkeep");
    // The duplicate wrench is judged once: two candidates on the sheet.
    expect(asked[3].prompt).toContain(`A: "wrench"`);
    expect(asked[3].prompt).toContain(`B: "hammer"`);
    expect(asked[3].prompt).not.toContain(`C: `);
    expect(result.calls).toBe(4);
    expect(result.usage).toEqual({ input_tokens: 400, output_tokens: 40 });
    expect([...result.preview.subarray(1, 4)]).toEqual([80, 78, 71]);
  });

  test("a rejection feeds its critique into one more round", async () => {
    let judged = 0;
    const draws: AskRequest[] = [];
    const result = await generateRoleIcon(brief, async (req) => {
      if (req.image) return { text: judged++ ? `{"winner":"A","rationale":"ok","critique":""}` : `{"winner":null,"rationale":"","critique":"draw a hammer"}`, usage };
      draws.push(req);
      return { text: reply(draws.length > 3 ? "hammer" : "wrench", draws.length > 3 ? HAMMER : WRENCH), usage };
    });
    expect(result.ok && result.icon.concept).toBe("hammer");
    expect(draws.slice(3).every((d) => d.prompt.includes("draw a hammer"))).toBe(true);
    expect(result.rounds.length).toBe(2);
  });

  test("gives up after two rounds with nothing usable, saying why", async () => {
    const result = await generateRoleIcon(brief, async () => ({ text: reply("coin", WRENCH), usage }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("already Finances lead's icon");
    expect(result.calls).toBe(6);
  });
});
