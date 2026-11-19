// `cast call board|pin|unpin|pins`: the stage of the huddle this session is
// fed. Everyone in the call sees what is pinned beside the faces, live, and
// edits it together (convex/callStage.ts).

type StageDeps = {
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  session: string;
  json: boolean;
  webUrl: string;
};

const docUrl = (web: string, id: string) => `${web.replace(/\/$/, "")}/docs/${id}`;

export async function runCallStage(verb: "board" | "pin" | "unpin" | "pins", arg: string | undefined, deps: StageDeps): Promise<void> {
  const { post, session, json, webUrl } = deps;
  if (verb === "board") {
    const r = await post("/cli/calls/board", { session });
    if (json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`doc:${r.doc_id}  ${r.title ?? "the call's board"}  ${r.pinned ? "on the stage" : "not on the stage (cast call pin doc:" + r.doc_id + ")"}`);
    console.log(docUrl(webUrl, r.doc_id));
    console.log(`Read it with \`cast board read ${r.doc_id}\`, write with the \`cast board\` verbs.`);
    return;
  }
  if (verb === "pins") {
    const r = await post("/cli/calls/pins", { session });
    if (json) return void console.log(JSON.stringify(r, null, 2));
    if (!r.pins.length) return void console.log("The stage holds no pins. `cast call board` gives the call its board.");
    for (const p of r.pins) {
      const what = p.board ? "the call's board" : p.doc_type ?? p.kind;
      console.log(`${p.ref}  ${what}${p.title ? `  ${p.title}` : ""}`);
    }
    return;
  }
  if (!arg) throw new Error(`Name what to ${verb}: doc:<id>, a /docs link, a page link (https://codecast.sh/a/<slug>) or a short id`);
  if (verb === "pin") {
    const r = await post("/cli/calls/pin", { session, ref: arg });
    if (json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`ok ${r.ref}${r.title ? ` (${r.title})` : ""} is on the stage for everyone in the call${r.replaced ? `; ${r.replaced} left to make room` : ""}`);
    return;
  }
  const r = await post("/cli/calls/unpin", { session, ref: arg });
  if (json) return void console.log(JSON.stringify(r, null, 2));
  console.log(r.removed ? `ok ${arg} is off the stage` : `${arg} was not on the stage (\`cast call pins\` lists what is)`);
}
