import { afterAll } from "bun:test";
import { Net } from "../sim/net";
const P: any = Net.prototype;
const st = { next: 0, scanned: 0, nonNull: 0, nextDue: 0, drain: 0, step: 0, maxQ: 0, filters: 0 };
const on = P.next; P.next = function (only: any) { st.next++; st.scanned += this.queues.size; st.maxQ = Math.max(st.maxQ, this.queues.size); const r = on.call(this, only); if (r !== null) st.nonNull++; return r; };
const nd = P.nextDue; P.nextDue = function (o: any) { st.nextDue++; st.scanned += this.queues.size; return nd.call(this, o); };
const dr = P.drain; P.drain = function (o: any) { st.drain++; return dr.call(this, o); };
afterAll(() => console.log("[net]", JSON.stringify(st)));
