import { describe, expect, test } from "bun:test";
import { scribeRefOf, scribeShownStatus } from "../useScribe";

describe("scribeShownStatus", () => {
  test("with no press in flight, the server's status shows", () => {
    for (const s of ["absent", "joining", "listening"] as const) expect(scribeShownStatus(s, null)).toBe(s);
  });

  test("an invite on its way shows Scribe joining until the server says more", () => {
    expect(scribeShownStatus("absent", "invite")).toBe("joining");
    expect(scribeShownStatus("joining", "invite")).toBe("joining");
    expect(scribeShownStatus("listening", "invite")).toBe("listening");
  });

  test("a removal on its way shows Scribe gone", () => {
    expect(scribeShownStatus("listening", "remove")).toBe("absent");
    expect(scribeShownStatus("joining", "remove")).toBe("absent");
  });
});

describe("scribeRefOf", () => {
  const live = (over: Record<string, unknown>) => ({ transcript_id: "t1", team_id: "team1", routes: [], scribe_claim: null, ...over }) as any;

  test("a seated Scribe is named by its route, a joining one by its claim", () => {
    expect(scribeRefOf(live({ routes: [{ kind: "session", target: "s-other", added_by: "u" }, { kind: "session", target: "s-scribe", added_by: "u", role: "scribe" }] }))).toEqual({ target: "s-scribe" });
    expect(scribeRefOf(live({ scribe_claim: { by: "u", at: 42 } }))).toEqual({ claim: 42 });
  });

  test("no Scribe, or one already removed, names nothing", () => {
    expect(scribeRefOf(live({}))).toBeNull();
    expect(scribeRefOf(live({ scribe_claim: { by: "u", at: 42, removed: true } }))).toBeNull();
    expect(scribeRefOf(null)).toBeNull();
  });
});

describe("the press in flight", () => {
  test("is the store's ephemeral state, by room, cleared to nothing", async () => {
    const { useInboxStore } = await import("../../../store/inboxStore");
    const st = () => useInboxStore.getState();
    st().noteScribePress("channel:a", "invite");
    st().noteScribePress("channel:b", "remove");
    expect(st().scribePresses).toEqual({ "channel:a": "invite", "channel:b": "remove" });
    st().noteScribePress("channel:a", null);
    expect(st().scribePresses).toEqual({ "channel:b": "remove" });
    st().noteScribePress("channel:b", null);
  });
});
