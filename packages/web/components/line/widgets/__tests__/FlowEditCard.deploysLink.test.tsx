// A shipped pipeline edit's state word links into /deploys: Live with its deploy opens that deploy, a word about the
// commit the run landed opens the run's team's Deploys page at it, and a word with neither stays plain text. The run's
// read, its flow and its journey are faked; the ship words and their link run for real.
import { expect, mock, test } from "bun:test";

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
let runs: any[] = [];
let journey: any = null;
mock.module("../../../../hooks/useSyncWorkflows", () => ({ useSessionFlowRuns: () => runs }));
mock.module("../../../../hooks/useFlowObject", () => ({ useRunFlow: () => ({ flow: {}, library: {} }), useNamedFlow: () => ({ flow: null, library: {} }) }));
const realJourney = await import("../../../../lib/ship/journey");
mock.module("../../../../lib/ship/journey", () => ({ ...realJourney, journeyOf: () => journey }));
mock.module("../../../ship/Journey", () => ({ JourneyView: () => null }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { FlowEditCard } = await import("../FlowEditCard");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const edit: any = { flow: "change", base: "change", file: "line/change.cast", graph_hash: "h1", changes: [], repository: null };
const run = (over: any) => ({ _id: "r1", graph_hash: "h1", created_at: 1, workspace: "team:T1", ...over });

function state(r: any, j: any) {
  runs = [r];
  journey = j;
  const html = renderToStaticMarkup(<FlowEditCard edit={edit} conversationId="c1" />).replace(/&amp;/g, "&");
  const m = html.match(/<(a|span) [^>]*class="lw-flow-state[^"]*"[^>]*>([^<]*)</)!;
  return { tag: m[1], words: m[2], href: m[0].match(/href="([^"]*)"/)?.[1] ?? null };
}

test("live with its deploy opens that deploy", () => {
  expect(state(run({ status: "completed" }), { stages: [], now: { kind: "live", line: "Live on web in dp-12" } })).toEqual({ tag: "a", words: "Live · dp-12", href: "/deploys?deploy=dp-12" });
});

test("a landed commit not live yet opens the team's Deploys page at it", () => {
  const s = state(run({ status: "completed", merge: { sha: SHA } }), { stages: [], now: { kind: "done" } });
  expect(s).toEqual({ tag: "a", words: "Merged", href: `/deploys?team=T1&sha=${SHA}` });
});

test("with neither a deploy nor a landed commit the word is a plain span", () => {
  const s = state(run({ status: "running", current_node_id: "review", current_node_label: "Review" }), { stages: [], now: { kind: "running" } });
  expect(s).toEqual({ tag: "span", words: "Review", href: null });
});
