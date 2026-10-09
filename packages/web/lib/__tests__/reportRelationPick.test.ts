import { beforeEach, describe, expect, it, mock } from "bun:test";

// What the palette tells the person about a relation pick, toast by toast:
// a check shows as loading and turns into what landed, a wait the server met
// at once says so, a refusal clears the toast (the dispatch failure toast
// gives the reason), and a write parked for the outbox says it will land.
const toasts: string[] = [];
const sonner = await import("sonner");
mock.module("sonner", () => ({
  ...sonner,
  toast: Object.assign((m: string, o?: { id?: string }) => toasts.push(`note${o?.id ? `#${o.id}` : ""}:${m}`), {
    success: (m: string, o?: { id?: string }) => (toasts.push(`ok${o?.id ? `#${o.id}` : ""}:${m}`), "s1"),
    error: (m: string) => toasts.push(`err:${m}`),
    loading: (m: string) => (toasts.push(`loading:${m}`), "t1"),
    dismiss: (id?: string) => toasts.push(`dismiss#${id}`),
  }),
}));
const { reportRelationPick } = await import("../taskRelations");

const settle = () => new Promise((r) => setTimeout(r, 0));
const pick = (landed: Promise<string>, pr = false) =>
  pr
    ? { ok: true as const, pending: true as const, message: "Checking PR o/r#42 for ct-1…", parked: "ct-1 will wait on PR #42 once it reaches the server", landed }
    : { ok: true as const, message: "ct-1 waits on decision sd-4", landed };

describe("reportRelationPick", () => {
  beforeEach(() => { toasts.length = 0; });

  it("turns a PR check into what landed", async () => {
    reportRelationPick(pick(Promise.resolve("ct-1 waits on PR #42: already merged"), true));
    await settle();
    expect(toasts).toEqual(["loading:Checking PR o/r#42 for ct-1…", "ok#t1:ct-1 waits on PR #42: already merged"]);
  });

  it("says when a wait was met at once", async () => {
    reportRelationPick(pick(Promise.resolve("ct-1 waits on decision sd-4: already answered: yes")));
    await settle();
    expect(toasts).toEqual(["ok:ct-1 waits on decision sd-4", "ok#s1:ct-1 waits on decision sd-4: already answered: yes"]);
  });

  it("leaves a pick that landed as said alone", async () => {
    reportRelationPick(pick(Promise.resolve("ct-1 waits on decision sd-4")));
    await settle();
    expect(toasts).toEqual(["ok:ct-1 waits on decision sd-4"]);
  });

  it("clears the toast on a refusal", async () => {
    reportRelationPick(pick(Promise.reject(new Error("Uncaught Error: codecast cannot see PR o/r#42")), true));
    await settle();
    expect(toasts).toEqual(["loading:Checking PR o/r#42 for ct-1…", "dismiss#t1"]);
  });

  it("says a parked PR wait will land", async () => {
    reportRelationPick(pick(Promise.reject(new Error("network down")), true));
    await settle();
    expect(toasts).toEqual(["loading:Checking PR o/r#42 for ct-1…", "note#t1:ct-1 will wait on PR #42 once it reaches the server"]);
  });

  it("says a refused pick at once", () => {
    reportRelationPick({ ok: false, message: "A task can't wait on itself" });
    expect(toasts).toEqual(["err:A task can't wait on itself"]);
  });
});
