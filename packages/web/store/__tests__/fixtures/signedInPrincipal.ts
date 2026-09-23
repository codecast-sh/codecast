// A signed-in window for cache tests. The disk cache belongs to one account
// (idbCache: hydration serves it only to the principal named by the stored
// JWT, and writes land only for that principal), so a test that exercises
// persistence needs a token in localStorage BEFORE the cache module boots and,
// when it seeds rows, the owner's user row on disk. Import this first.
import Dexie from "dexie";
import { AUTH_JWT_STORAGE_KEY, issueFakeToken, mapStorage } from "./fakeAuthToken";

export const TEST_PRINCIPAL = "userA";

export function installSignedInPrincipal(principalId = TEST_PRINCIPAL): void {
  if (typeof (globalThis as any).localStorage === "undefined") (globalThis as any).localStorage = mapStorage();
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(principalId));
}

/** Mark the seeded cache as the principal's: the server-confirmed user row hydration checks. */
export async function stampCacheOwner(principalId = TEST_PRINCIPAL): Promise<void> {
  const db = new Dexie("codecast-store");
  await db.open();
  await db.table("meta").put({ key: "currentUser", value: { _id: principalId } });
  db.close();
}

installSignedInPrincipal();
