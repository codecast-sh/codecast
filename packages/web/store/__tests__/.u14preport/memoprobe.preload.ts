import { afterAll } from "bun:test";
import { Replica } from "../inboxSimHarness";
const P: any = Replica.prototype;
const last = new WeakMap<object, any>();
const st = { placed: 0, sameState: 0, sameSessions: 0 };
const orig = P.placed;
P.placed = function () {
  st.placed++;
  const s = this.window.store.getState();
  const prev = last.get(this);
  if (prev === s) st.sameState++;
  if (prev && prev.sessions === s.sessions) st.sameSessions++;
  last.set(this, s);
  return orig.call(this);
};
afterAll(() => console.log("[memo]", JSON.stringify(st)));
