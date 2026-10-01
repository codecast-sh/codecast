import { expect, test } from "bun:test";
import { syncKnockToasts, type KnockAnswers } from "./knockToasts";

function fakeToaster() {
  const shown: Array<{ message: string; data: any }> = [];
  const dismissed: Array<string | number | undefined> = [];
  const t = ((message: string, data?: any) => {
    shown.push({ message, data });
    return data?.id;
  }) as any;
  t.dismiss = (id?: string | number) => dismissed.push(id);
  return { t, shown, dismissed };
}

const ROOM = "people:u1,u2";
const answers = () => {
  const log: string[] = [];
  const a: KnockAnswers = {
    admitPerson: (room, user) => log.push(`person:${room}:${user}`),
    admitGuest: (id, name) => log.push(`guest:${id}:${name}`),
    denyGuest: (id) => log.push(`deny:${id}`),
  };
  return { a, log };
};
const person = { from_user: "u3", from_name: "Bo Lee", created_at: 1, kind: "person" as const, can_answer: true };
const guest = { from_user: "guest:g1", from_name: "Ada Lovelace", created_at: 2, kind: "guest" as const, guest_id: "g1", can_answer: true };

test("a fresh guest knock with the stage closed is a toast with Admit and Deny, under the name the door shows", () => {
  const { t, shown } = fakeToaster();
  const { a, log } = answers();
  const ids = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set(), stageOpen: false, answers: a, toast: t });
  expect([...ids]).toEqual([`knock:${ROOM}:guest:g1`]);
  expect(shown[0].message).toBe("Ada Lovelace wants to join the call");
  expect(shown[0].data.description).toContain("guest");
  shown[0].data.action.onClick();
  shown[0].data.cancel.onClick();
  expect(log).toEqual(["guest:g1:Ada Lovelace", "deny:g1"]);
});

test("a teammate's knock admits with a ring and offers no Deny", () => {
  const { t, shown } = fakeToaster();
  const { a, log } = answers();
  syncKnockToasts({ roomKey: ROOM, current: [person], fresh: [person], shown: new Set(), stageOpen: false, answers: a, toast: t });
  expect(shown[0].message).toBe("Bo wants to join the call");
  expect(shown[0].data.cancel).toBeUndefined();
  shown[0].data.action.onClick();
  expect(log).toEqual([`person:${ROOM}:u3`]);
});

test("somebody who may not answer the door is told, with nothing to press", () => {
  const { t, shown } = fakeToaster();
  syncKnockToasts({ roomKey: ROOM, current: [{ ...guest, can_answer: false }], fresh: [{ ...guest, can_answer: false }], shown: new Set(), stageOpen: false, answers: answers().a, toast: t });
  expect(shown[0].message).toBe("Ada Lovelace is waiting at the door");
  expect(shown[0].data.action).toBeUndefined();
});

test("a knock that left takes its toast with it, and an open stage takes them all", () => {
  const { t, dismissed } = fakeToaster();
  const id = `knock:${ROOM}:guest:g1`;
  let ids = syncKnockToasts({ roomKey: ROOM, current: [], fresh: [], shown: new Set([id]), stageOpen: false, answers: answers().a, toast: t });
  expect(ids.size).toBe(0);
  expect(dismissed).toEqual([id]);
  const shown = fakeToaster();
  ids = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set([id]), stageOpen: true, answers: answers().a, toast: shown.t });
  expect(ids.size).toBe(0);
  expect(shown.shown).toHaveLength(0);
  expect(shown.dismissed).toEqual([id]);
});

test("a toast stays until the knock leaves, however long the guest waits", () => {
  const { t, shown } = fakeToaster();
  syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set(), stageOpen: false, answers: answers().a, toast: t });
  expect(shown[0].data.duration).toBe(Infinity);
});

test("closing the stage on a knock nobody answered brings its toast back", () => {
  const { t, shown } = fakeToaster();
  let ids = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set(), stageOpen: true, answers: answers().a, toast: t });
  expect(shown).toHaveLength(0);
  ids = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: ids, stageOpen: false, answers: answers().a, toast: t });
  expect(shown).toHaveLength(1);
  expect([...ids]).toEqual([`knock:${ROOM}:guest:g1`]);
});

test("only the window that tells the person toasts, and a new knock is also a system notification once", () => {
  const { t, shown, dismissed } = fakeToaster();
  const told: string[] = [];
  const notify = (title: string, _body: string, key: string) => told.push(`${title}|${key}`);
  const quiet = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set(["x"]), stageOpen: false, answers: answers().a, leader: false, notify, toast: t });
  expect(quiet.size).toBe(0);
  expect(shown).toHaveLength(0);
  expect(dismissed).toEqual(["x"]);
  expect(told).toEqual([]);
  const ids = syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: new Set(), stageOpen: false, answers: answers().a, leader: true, notify, toast: t });
  expect(told).toEqual([`Ada Lovelace wants to join the call|knock:${ROOM}:guest:g1:2`]);
  // The same knock shown again (the stage closed on it) is not a second banner.
  syncKnockToasts({ roomKey: ROOM, current: [guest], fresh: [guest], shown: ids, stageOpen: false, answers: answers().a, leader: true, notify, toast: t });
  expect(told).toHaveLength(1);
});
