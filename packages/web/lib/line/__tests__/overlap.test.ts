import { describe, expect, test } from "bun:test";
import { commonWords, defectHeads, jaccard, overlapShare, problemOverlaps, ruleOf, SAME_DEFECT, SAME_TITLE, sameExpectation, titleSimilarity, titleWords, withDuplicatesUnderPrimary } from "../overlap";
import { takenWords } from "../lineModel";
import { closeChip } from "../scriptReport";

describe("overlap", () => {
  test("identical titles are one problem filed under the oldest; unlike titles stand alone", () => {
    const m = problemOverlaps([
      { id: "b", ref: "ct-2", title: "A message to a contact leads with the result", at: 2 },
      { id: "a", ref: "ct-1", title: "A message to a contact leads with the result", at: 1 },
      { id: "c", ref: "ct-3", title: "Fee answer invents transaction structure", at: 3 },
    ]);
    expect(m.get("b")).toMatchObject({ primary: "a", primaryRef: "ct-1", set: ["a", "b"] });
    expect(m.get("c")!.set).toEqual(["c"]);
    expect(withDuplicatesUnderPrimary([{ id: "c" }, { id: "b" }, { id: "a" }], m).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(titleSimilarity("Sender identity re-derived per send", "Fee model not disclosed")).toBe(0);
  });

  test("problems whose findings cite one rule are one defect, folded under the oldest", () => {
    const m = problemOverlaps([
      { id: "a", ref: "ct-1", title: "Contacts who replied get mail from several addresses", at: 1, fingerprints: ["moment:mo-1:ex-t-16", "moment:mo-2:ex-t-16"] },
      { id: "b", ref: "ct-2", title: "Anubhav got mail from three addresses", at: 2, fingerprints: ["moment:mo-3:ex-t-16"] },
      { id: "d", ref: "ct-4", title: "Fee answer is vague", at: 4, fingerprints: ["moment:mo-5:ex-t-16"] },
      { id: "c", ref: "ct-3", title: "Fee answer invents transaction structure", at: 3, fingerprints: ["moment:mo-4:ex-t-3"] },
    ]);
    expect(m.get("b")).toMatchObject({ primary: "b", set: ["b"], defect: ["a", "b"] });
    expect(m.get("c")!.defect).toEqual(["c"]);
    expect(m.get("d")!.defect).toEqual(["d"]);
    const rows = [{ id: "b" }, { id: "c" }, { id: "a" }];
    expect(withDuplicatesUnderPrimary(rows, m, new Set()).map((r) => r.id)).toEqual(["c", "a"]);
    expect(withDuplicatesUnderPrimary(rows, m, new Set(["a"])).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect([...defectHeads(rows, m)].map(([k, v]) => [k, v.map((x) => x.id)])).toEqual([["a", ["b"]]]);
  });

  test("words in most of a process's titles say nothing about one of them", () => {
    const titles = Array.from({ length: 10 }, (_, i) => `Union sends message ${i} topic${i}`);
    expect(commonWords(titles).has("union")).toBe(true);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });

  test("a rule is the expectation most findings cite", () => {
    expect(ruleOf(["moment:mo-1:ex-a-16", "moment:mo-2:ex-a-16", "evidence:x:ex-a-3"])).toBe("ex-a-16");
    expect(ruleOf(["moment:mo-1:ex-a-16", "evidence:x:ex-a-3"])).toBeNull();
  });
});

describe("taken edge words", () => {
  test("an or edge reads by the way the run took it, never the other", () => {
    const e = { condition: "outcome = success or prove.json.outcome = infeasible" };
    expect(takenWords(e, (lhs) => (lhs === "outcome" ? "success" : "red"))).toBeNull();
    expect(takenWords({ condition: "red.json.red = true or prove.json.outcome = infeasible" }, (lhs) => (lhs === "red.json.red" ? true : "red"))).toBe("red");
    expect(takenWords({ condition: "red.json.red = true or prove.json.outcome = infeasible" }, (lhs) => (lhs === "red.json.red" ? false : "infeasible"))).toBe("infeasible");
    expect(takenWords({ condition: "outcome = success" }, () => "success")).toBeUndefined();
  });
});

describe("close chip", () => {
  test("a dissolve says how it closed", () => {
    const v = (result: Record<string, unknown>) => [{ decided: { result } }];
    expect(closeChip(v({ outcome: "dissolved", kind: "already_fixed", into: "4a97f88114" }))).toBe("fixed on main 4a97f88");
    expect(closeChip(v({ kind: "known_cause", into: "ct-59229" }))).toBe("dup ct-59229");
    expect(closeChip(v({ kind: "judge_defect", into: "judge:comms" }))).toBe("judge defect");
    expect(closeChip(v({ outcome: "open" }))).toBeNull();
  });
});

describe("a judge's Not met title", () => {
  // Union's ct-57459 is titled with its whole expectation; the judge filed ct-58675 as "Not met:" its first clause.
  const whole = "A message to a contact leads with the result, the recommendation or one actionable question; it does not narrate Union's effort, apologize for ordinary delay, or send activity that means nothing to t…";
  const judged = "Not met: A message to a contact leads with the result, the recommendation or one actionable question";
  test("is the same problem as the one titled with the expectation it quotes", () => {
    expect(sameExpectation(judged, whole)).toBe(true);
    const m = problemOverlaps([{ id: "a", ref: "ct-57459", title: whole, at: 1 }, { id: "b", ref: "ct-58675", title: judged, at: 2 }]);
    expect(m.get("b")?.primary).toBe("a");
    expect(m.get("a")?.set).toEqual(["a", "b"]);
  });
  test("never matches a short or unrelated title, or two titles neither of which a judge wrote", () => {
    expect(sameExpectation("Not met: A message", "A message to a contact leads with the result")).toBe(false);
    expect(sameExpectation(judged, "Cold email describes the search the contact's need implies")).toBe(false);
    expect(sameExpectation("A message to a contact leads with the result", whole)).toBe(false);
  });
});

describe("problemOverlaps over many problems", () => {
  // The every-pair reading the indexed pass must equal: a duplicate is a Jaccard at SAME_TITLE or one expectation
  // quoted twice; a defect adds problems under one rule whose stems overlap by SAME_DEFECT.
  function everyPair(items: ReadonlyArray<{ id: string; title: string; at: number; fingerprints?: string[] }>) {
    const sorted = [...items].sort((a, b) => a.at - b.at);
    const common = commonWords(sorted.map((i) => i.title));
    const words = sorted.map((i) => titleWords(i.title, common));
    const stems = words.map((w) => new Set([...w].map((x) => x.replace(/'s$/, "").replace(/(?<=\w{3})(es|s)$/, ""))));
    const rules = sorted.map((i) => ruleOf(i.fingerprints));
    const dup = new Set<string>();
    const defect = new Set<string>();
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i].id}|${sorted[j].id}`;
      if (jaccard(words[i], words[j]) >= SAME_TITLE || sameExpectation(sorted[i].title, sorted[j].title)) { dup.add(key); defect.add(key); }
      if (rules[i] && rules[i] === rules[j] && overlapShare(stems[i], stems[j]) >= SAME_DEFECT) defect.add(key);
    }
    return { dup, defect };
  }
  const together = (sets: ReadonlyArray<string>, a: string, b: string) => sets.includes(a) && sets.includes(b);

  test("joins exactly the pairs the every-pair reading joins", () => {
    const vocab = ["contact", "reply", "address", "mail", "caller", "booked", "call", "fee", "answer", "grade", "email", "held", "overnight", "sender", "zoom", "broker", "vendor", "record"];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const expectation = "a caller who books a call hears the time back";
    const items = Array.from({ length: 400 }, (_, n) => {
      const kind = rand(10);
      const title = kind === 0 ? `Not met: ${expectation.slice(0, 24 + rand(20))}…`
        : kind === 1 ? expectation
        : Array.from({ length: 2 + rand(4) }, () => vocab[rand(vocab.length)]).join(" ");
      return { id: `p${n}`, ref: null, title, at: rand(1000), fingerprints: rand(3) ? [`moment:mo-${n}:ex-r-${rand(4)}`] : [] };
    });
    const m = problemOverlaps(items);
    const want = everyPair(items);
    const sorted = [...items].sort((a, b) => a.at - b.at);
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i].id, sorted[j].id];
      if (want.dup.has(`${a}|${b}`)) expect(together(m.get(a)!.set, a, b)).toBe(true);
      if (want.defect.has(`${a}|${b}`)) expect(together(m.get(a)!.defect, a, b)).toBe(true);
    }
    // Nothing beyond those pairs: every set is the closure of the pairs the reading names.
    const closure = (pairs: Set<string>) => {
      const parent = new Map(sorted.map((i) => [i.id, i.id]));
      const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
      for (const p of pairs) { const [a, b] = p.split("|"); parent.set(find(b), find(a)); }
      return (id: string) => sorted.filter((i) => find(i.id) === find(id)).map((i) => i.id);
    };
    const dupOf = closure(want.dup);
    const defectOf = closure(want.defect);
    for (const i of sorted) {
      expect(m.get(i.id)!.set).toEqual(dupOf(i.id));
      expect(m.get(i.id)!.defect).toEqual(defectOf(i.id));
    }
  });
});
