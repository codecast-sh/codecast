import { expect, test } from "bun:test";
import { shouldShowSharingSetup } from "./sharingSetup";

test("only shows for connected recent accounts with sessions", () => {
  const state = { clientState: {}, currentUser: { cli_version: "1", _creationTime: 1 }, sessions: { a: {} } };
  expect(shouldShowSharingSetup(state, 2)).toBe(true);
  expect(shouldShowSharingSetup({ ...state, sessions: {} }, 2)).toBe(false);
  expect(shouldShowSharingSetup({ ...state, currentUser: null }, 2)).toBe(false);
  expect(shouldShowSharingSetup({ ...state, currentUser: { _creationTime: 1 } }, 2)).toBe(false);
  expect(shouldShowSharingSetup(state, 1 + 14 * 86400000)).toBe(false);
});

test("never enumerates sessions for dismissed or expired onboarding", () => {
  let scans = 0;
  const sessions = new Proxy({}, { ownKeys: () => { scans++; return []; } });
  const state = { clientState: { dismissed: { sharing_setup: 1 } }, currentUser: { cli_version: "1", _creationTime: 1 }, sessions };
  expect(shouldShowSharingSetup(state, 2)).toBe(false);
  expect(shouldShowSharingSetup({ ...state, clientState: {} }, 15 * 86400000)).toBe(false);
  expect(scans).toBe(0);
});
