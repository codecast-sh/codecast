import { describe, expect, test } from "bun:test";
import { docOrigin, isHumanDocOrigin, isOnHumanShelf, docSourceForPlanSource } from "./index";

describe("docOrigin", () => {
  test("only an explicit human stamp is human", () => {
    expect(docOrigin({ source: "human" })).toBe("human");
    for (const source of ["agent", "plan_mode", "file_sync", "inline_extract", "import"]) {
      expect(docOrigin({ source })).toBe("agent");
    }
  });

  test("unknown and missing sources default to agent, never leaking onto the shelf", () => {
    expect(docOrigin({ source: "some_future_writer" })).toBe("agent");
    expect(docOrigin({ source: undefined })).toBe("agent");
    expect(docOrigin({ source: null })).toBe("agent");
    expect(isHumanDocOrigin({})).toBe(false);
  });
});

describe("isOnHumanShelf", () => {
  test("human origin is on the shelf", () => {
    expect(isOnHumanShelf({ source: "human" })).toBe(true);
  });

  test("machine docs stay off the shelf until pinned", () => {
    expect(isOnHumanShelf({ source: "file_sync" })).toBe(false);
    expect(isOnHumanShelf({ source: "agent", pinned: false })).toBe(false);
    expect(isOnHumanShelf({ source: "agent", pinned: true })).toBe(true);
  });
});

describe("docSourceForPlanSource", () => {
  test("only a human plan yields a human plan-body doc", () => {
    expect(docSourceForPlanSource("human")).toBe("human");
    for (const s of ["agent", "promoted", "template", "fork", "imported", undefined, null]) {
      expect(docSourceForPlanSource(s as any)).toBe("agent");
    }
  });
});
