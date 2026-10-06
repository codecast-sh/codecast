import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api";

const url = process.env.CONVEX_URL!;
const c = new ConvexHttpClient(url);
const log = (label: string, v: unknown) => console.log(`\n# ${label}\n${JSON.stringify(v, null, 1).slice(0, 900)}`);
const expectError = async (label: string, p: Promise<unknown>) => {
  try { await p; console.log(`!! ${label}: expected an error`); process.exitCode = 1; }
  catch (e: any) { console.log(`ok ${label}: ${JSON.stringify(e.data ?? e.message).slice(0, 160)}`); }
};

const A = await c.mutation(api.visitors.register, {});
const B = await c.mutation(api.visitors.register, {});
const a = { visitor_id: A.visitor_id, secret: A.secret };
const b = { visitor_id: B.visitor_id, secret: B.secret };
log("register A", A.visitor);
log("me A", await c.query(api.visitors.me, a));
log("me with wrong secret", await c.query(api.visitors.me, { ...a, secret: B.secret }));
await expectError("apps.get with wrong secret", c.query(api.apps.get, { ...a, secret: B.secret, slug: "x" }));
await expectError("apps.get with B's id and A's secret", c.query(api.apps.get, { visitor_id: B.visitor_id, secret: A.secret, slug: "x" }));
log("setCharacter A", await c.mutation(api.visitors.setCharacter, { ...a, avatar: "raccoon", name: "  Pocket  " }));
log("setCharacter A clear name", await c.mutation(api.visitors.setCharacter, { ...a, name: null }));
await c.mutation(api.visitors.setCharacter, { ...a, name: "Pocket" });

const made = await c.mutation(api.apps.create, { ...a, prompt: "a frog choir, one note per person" });
log("apps.create", made);
const app = await c.query(api.apps.get, { ...a, slug: made.slug });
log("apps.get", app);
log("apps.get unknown slug", await c.query(api.apps.get, { ...a, slug: "nope-zzzz" }));
log("versions.list", await c.query(api.versions.list, { ...a, app_id: made.app_id }));
const files = await c.query(api.versions.files, { ...a, app_id: made.app_id, number: 1 });
log("versions.files paths", files?.files.map((f) => `${f.path} ${f.size}b ${f.hash.slice(0, 8)}`));

await c.mutation(api.presence.heartbeat, { ...a, app_id: made.app_id });
await c.mutation(api.presence.heartbeat, { ...b, app_id: made.app_id, viewing_version: 1 });
await c.mutation(api.presence.setTyping, { ...b, app_id: made.app_id, typing: true });
log("presence.here (2, B typing, B viewing v1)", await c.query(api.presence.here, { ...a, app_id: made.app_id }));
log("send chat", await c.mutation(api.messages.send, { ...b, app_id: made.app_id, body: "hi frogs", mode: "chat" }));
log("send auto", await c.mutation(api.messages.send, { ...b, app_id: made.app_id, body: "make the frogs bigger", mode: "auto" }));
log("send change with element", await c.mutation(api.messages.send, {
  ...a, app_id: made.app_id, body: "  this button should be pink  ", mode: "change",
  element: { selector: "main > section > button", tag: "BUTTON", text: "Wave\n hello", snippet: "<button>Wave hello</button>" },
}));
await expectError("send empty", c.mutation(api.messages.send, { ...a, app_id: made.app_id, body: "   ", mode: "chat" }));
const here2 = await c.query(api.presence.here, { ...a, app_id: made.app_id });
log("typing cleared by send? B typing_until", here2.map((h) => [h.visitor.name, h.typing_until]));
const p1 = await c.query(api.messages.list, { ...a, app_id: made.app_id, paginationOpts: { numItems: 2, cursor: null } });
log("messages page 1", p1);
const p2 = await c.query(api.messages.list, { ...a, app_id: made.app_id, paginationOpts: { numItems: 2, cursor: p1.continueCursor } });
log("messages page 2", p2.page.map((m) => [m.kind, m.body, m.author?.name]));
await c.mutation(api.presence.leave, { ...b, app_id: made.app_id });
log("gallery", await c.query(api.apps.gallery, { ...a, limit: 3 }));
const sends = [];
for (let i = 0; i < 20; i++) sends.push(c.mutation(api.messages.send, { ...a, app_id: made.app_id, body: `spam ${i}`, mode: "chat" }).then(() => "ok", (e) => e.data?.code));
log("A sends 20 more (1 already sent, limit 20/min)", (await Promise.all(sends)).join(","));
console.log(`\nAPP ${made.app_id} ${made.slug} ${A.visitor_id}`);
