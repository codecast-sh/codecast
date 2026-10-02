// A call named in an agent's message: `cl-N` reads as a pill, and
// `cl-N:a-b` alone on its line embeds those transcript lines with their
// speakers. Rendered through the transcript's own markdown pipeline, with the
// resolver answered by fixtures instead of the server.
// Run: bun test components/calls/__tests__/callRefs.mount.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
// Loads first, as in the app: it and messageMarkdown import each other.
import "../../chat/ChatMessage";
import { ASSISTANT_MD_REMARK, MESSAGE_MD_COMPONENTS } from "../../messageMarkdown";
import { EntityFixtureContext } from "../../../lib/entityDisplay";
import { ConvexProvider } from "convex/react";
import { heroConvexStub } from "../../../app/(marketing)/heroFly/convexStub";

const call = {
  _id: "k57abcdefghijkmnpqrstvwxyz234567",
  short_id: "cl-100",
  title: "Broker desk interface design",
  status: "ended",
  started_at: 1_000,
  ended_at: 1_000 + 76 * 60_000,
  participants: [{ id: "u-sam", name: "Samvit Ramadurgam" }, { id: "u-jason", name: "Jason Benn" }],
  summary: "We picked the desk layout.",
};
const turns = {
  from_seq: 1,
  to_seq: 3,
  more: false,
  segments: [
    { seq: 1, speaker_id: "u-sam", speaker_name: "Samvit Ramadurgam", text: "Put the queue on the left", t0: 0 },
    { seq: 2, speaker_id: "u-sam", speaker_name: "Samvit Ramadurgam", text: "and the chat on the right", t0: 2_000 },
    { seq: 3, speaker_id: "u-jason", speaker_name: "Jason Benn", text: "Agreed, ship it", t0: 5_000 },
  ],
};
const fixtures = {
  "cl-100": { type: "call" as const, entity: { ...call, turns: null } },
  "cl-100:1-3": { type: "call" as const, entity: { ...call, turns } },
};
const render = (md: string) =>
  renderToStaticMarkup(
    <ConvexProvider client={heroConvexStub}>
      <EntityFixtureContext.Provider value={fixtures}>
        <ReactMarkdown remarkPlugins={ASSISTANT_MD_REMARK as any} components={MESSAGE_MD_COMPONENTS as any}>
          {md}
        </ReactMarkdown>
      </EntityFixtureContext.Provider>
    </ConvexProvider>,
  );

describe("call references in an agent's message", () => {
  test("a line range alone on its line embeds the words with their speakers", () => {
    const html = render("Here is what they agreed:\n\ncl-100:1-3\n");
    expect(html).toContain("Broker desk interface design");
    expect(html).toContain("Put the queue on the left");
    expect(html).toContain("Agreed, ship it");
    expect(html).toContain("Samvit");
    expect(html).toContain("Jason");
    expect(html).toContain(`/calls/${call._id}?turns=1-3`);
  });

  test("a call mentioned mid sentence is a pill named by its title", () => {
    const html = render("We settled it on cl-100 yesterday.");
    expect(html).toContain("Broker desk interface design");
    expect(html).not.toContain("Put the queue on the left");
    expect(html).toContain(`/calls/${call._id}`);
  });
});
