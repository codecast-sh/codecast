import { expect, test } from "bun:test";
import { guestsSig, rosterWithGuests } from "./roomGuests";

const seat = (id: string, name: string) => ({ user_id: id, user_name: name });
const guest = (id: string, name: string, joined_at: number) => ({ guest_id: id, identity: `guest:${id}`, name, joined_at });

test("a room with no guests hands back its seats untouched", () => {
  const seats = [seat("u1", "Sam")];
  expect(rosterWithGuests(seats, undefined)).toBe(seats);
  expect(rosterWithGuests(seats, [])).toBe(seats);
});

test("guests follow the seats, in the order they were let in, keyed by identity and flagged", () => {
  const rows = rosterWithGuests([seat("u1", "Sam")], [guest("g2", "Bo", 200), guest("g1", "Ada", 100)]);
  expect(rows.map((r) => r.user_id)).toEqual(["u1", "guest:g1", "guest:g2"]);
  expect(rows[1]).toEqual({ user_id: "guest:g1", user_name: "Ada", joined_at: 100, guest: true });
});

test("a guest is listed once, and never in place of a seat", () => {
  const rows = rosterWithGuests([seat("guest:g1", "Ada")], [guest("g1", "Ada", 100), guest("g1", "Ada", 100)]);
  expect(rows).toHaveLength(1);
});

test("the signature moves with who is in and their names, and not otherwise", () => {
  const a = guestsSig([guest("g1", "Ada", 100)]);
  expect(guestsSig([guest("g1", "Ada", 100)])).toBe(a);
  expect(guestsSig([guest("g1", "Ada L", 100)])).not.toBe(a);
  expect(guestsSig(undefined)).toBe("");
});

test("a link's closing time reads in the unit a person checks it in", async () => {
  const { guestLinkExpiry } = await import("./roomGuests");
  const now = new Date(2026, 9, 2, 9, 0).getTime();
  expect(guestLinkExpiry(now - 1, now)).toBe("expired");
  expect(guestLinkExpiry(now + 42 * 60_000, now)).toBe("closes in 42 min");
  expect(guestLinkExpiry(now + 10 * 3_600_000, now)).toBe("open until 7:00 PM");
  expect(guestLinkExpiry(now + 2 * 86_400_000, now)).toBe("open until Sun 9:00 AM");
  expect(guestLinkExpiry(now + 7 * 86_400_000, now)).toBe("open until Oct 9");
});
