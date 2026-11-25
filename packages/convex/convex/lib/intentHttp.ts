// The intent check's two cast routes, mounted by http.ts through cliRoute.
import { internal } from "../_generated/api";
import { citeRef, readOriginator, verifyCardCitation, verifyCitation, type WordCite } from "./originatorChain";

const typedStepOf = (ctx: any, api_token: string) => (id: string, state: unknown) =>
  ctx.runQuery(internal.originator.typedStep, { api_token, conversation_id: id, ...(state === undefined ? {} : { state }) });

// POST /cli/sessions/originator (`cast flow asker`): who started a session's line of work and what people typed
// along it, its chain up to the originator and each typed line with its provenance, numbered as `cast read` numbers it.
// A task named without a session reads the sessions tied to the task instead.
export async function originatorRoute(ctx: any, body: any) {
  const { api_token, conversation_id, task, run_id } = body;
  if (typeof api_token !== "string") return { error: "Missing api_token" };
  if (typeof conversation_id !== "string" && typeof task !== "string") return { error: "Missing conversation_id or task" };
  return await readOriginator({
    head: () => ctx.runQuery(internal.originator.chain, {
      api_token,
      ...(typeof conversation_id === "string" ? { conversation_id } : {}),
      ...(typeof task === "string" ? { task } : {}),
      ...(typeof run_id === "string" ? { run_id } : {}),
    }),
    typedStep: typedStepOf(ctx, api_token),
  });
}

// POST /cli/intent/verify (`cast flow intent-verify`, the intent segment): whether the line or card answer a read
// cited is the run starter's own word to ship, checked in code (verifyCitation, verifyCardCitation); the model that
// chose it decides nothing here. It writes nothing to the run: a flow composing the segment routes on the answer and
// its intent.json.
export async function intentVerifyRoute(ctx: any, body: any) {
  const { api_token, run_id, cite, card, quote, head } = body;
  if (typeof api_token !== "string" || typeof run_id !== "string") return { error: "Missing api_token or run_id" };
  if (typeof quote !== "string") return { error: "A citation comes with a quote" };
  if ((cite === undefined) === (card === undefined)) return { error: "Cite a line ({conversation_short_id, line}) or a card (sd-N), one of them" };
  if (head !== undefined && (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head))) return { error: "head is the full commit sha the read was given" };
  const facts = await ctx.runQuery(internal.originator.citeRun, { api_token, run_id });
  const run = async () => facts;
  let said: { cite: WordCite; quote: string; user_id: string; said_at: number };
  if (card !== undefined) {
    if (typeof card !== "string") return { error: "A card cite is sd-N" };
    const answer = await verifyCardCitation({ run, card: (ref) => ctx.runQuery(internal.originator.citedCard, { api_token, run_id, card: ref }) }, card, quote);
    if ("refused" in answer) return { error: `Not verified: ${answer.refused}` };
    said = { cite: { card: answer.card }, quote: answer.quote, user_id: answer.user_id, said_at: answer.said_at };
  } else {
    if (typeof cite?.conversation_short_id !== "string" || !Number.isInteger(cite?.line)) return { error: "A cite is {conversation_short_id, line} with a quote" };
    const line = await verifyCitation({ run, typedStep: typedStepOf(ctx, api_token) }, { conversation_short_id: cite.conversation_short_id, line: cite.line }, quote);
    if ("refused" in line) return { error: `Not verified: ${line.refused}` };
    said = { cite: { conversation_short_id: line.short_id, line: line.line }, quote: line.quote, user_id: line.user_id, said_at: line.said_at };
  }
  const name = "error" in facts ? null : facts.starter_name;
  await ctx.runMutation(internal.originator.noteIntent, { api_token, run_id, text: `${name ?? "The person who started the run"} said to ship: "${said.quote}" (${citeRef(said.cite)}), checked against the record.` });
  return { starter_id: said.user_id, starter_name: name, cite: citeRef(said.cite), quote: said.quote, said_at: said.said_at, ...(head ? { head } : {}) };
}
