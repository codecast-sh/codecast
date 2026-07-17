import { describe, expect, it } from "bun:test";
import { isForeignSession } from "./liveEntities";

// Regression for "dismiss doesn't stick on a session assigned to me": the
// resolver ignored the owner signals, so hideSessionInDraft treated an
// assigned session (run by a teammate, routed to my inbox via session_owners)
// as foreign — dismiss degraded to delete-my-local-copy with no server write,
// and the live inbox subscription re-delivered the row seconds later.
describe("isForeignSession", () => {
  const ME = "users_me";
  const OTHER = "users_other";

  it("a teammate's session with no ownership signal is foreign", () => {
    expect(isForeignSession({ user_id: OTHER }, undefined, ME)).toBe(true);
  });

  it("owned_by_me makes a teammate-run session mine to triage", () => {
    expect(isForeignSession({ user_id: OTHER, owned_by_me: true }, undefined, ME)).toBe(false);
  });

  it("owner_user_id matching me makes it mine", () => {
    expect(isForeignSession({ user_id: OTHER, owner_user_id: ME }, undefined, ME)).toBe(false);
  });

  it("owned_by_me outranks a stale is_own:false meta from a pre-assignment view", () => {
    expect(
      isForeignSession({ user_id: OTHER, owned_by_me: true }, { is_own: false }, ME),
    ).toBe(false);
  });

  it("is_own:false without any owner signal stays foreign", () => {
    expect(isForeignSession({ user_id: OTHER }, { is_own: false }, ME)).toBe(true);
  });

  it("is_own:true is definitive", () => {
    expect(isForeignSession({ user_id: OTHER }, { is_own: true }, ME)).toBe(false);
  });

  it("someone else's owner_user_id does not make it mine", () => {
    expect(isForeignSession({ user_id: OTHER, owner_user_id: OTHER }, undefined, ME)).toBe(true);
  });

  it("my own session is never foreign", () => {
    expect(isForeignSession({ user_id: ME }, undefined, ME)).toBe(false);
  });

  it("thin row with no signals: author_name is the last-resort foreign marker", () => {
    expect(isForeignSession({ author_name: "Samvit" }, undefined, ME)).toBe(true);
    expect(isForeignSession({}, undefined, ME)).toBe(false);
  });
});
