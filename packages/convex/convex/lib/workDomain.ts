// Which email addresses name an employer, and whether a user has proven they
// hold theirs. A leaf on purpose: teams.ts (create) and teamDiscovery.ts
// (find, request) both read it, and teamDiscovery imports from teams.ts.
import type { Doc } from "../_generated/dataModel";

// Consumer mailbox providers: an address here says nothing about an employer.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "passmail.com", "gmx.com", "gmx.de", "web.de",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com",
  "naver.com", "hanmail.net", "privaterelay.appleid.com", "fastmail.com", "hey.com",
  "outlook.in", "rediffmail.com", "tutanota.com", "duck.com",
]);
// Providers that only hand us an email they have verified.
const VERIFYING_PROVIDERS = new Set(["github", "google", "apple", "apple-native"]);
/** The company domain of an address, or null for free mail and malformed input. */
export function workDomain(email: string | undefined | null): string | null {
  const m = String(email ?? "").trim().toLowerCase().match(/^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  return FREE_MAIL.has(m[1]) ? null : m[1];
}

/** True when the user has proven they hold their account email. */
export async function emailProven(ctx: any, user: Doc<"users">): Promise<boolean> {
  if (user.emailVerificationTime) return true;
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q: any) => q.eq("userId", user._id))
    .collect();
  return accounts.some((a: any) => VERIFYING_PROVIDERS.has(a.provider));
}
