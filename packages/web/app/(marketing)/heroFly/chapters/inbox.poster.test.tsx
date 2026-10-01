import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { renderToString } from "react-dom/server";
import { buildBootGraph } from "../../../../../cli/src/bench/bootGraph";
import { useInboxStore } from "../../../../store/inboxStore";
import { HeroSandbox } from "../sandbox";
import { createFilmClock, FilmClockContext } from "../filmClock";
import { POSTER_T } from "../world";
import { inboxRows } from "../fixtures/desk";
import { CUES, PROMPT, SESSIONS } from "../fixtures/story";
import { chapter as inbox } from "./inbox.chapter";
import { chapter as conversation } from "./conversation.chapter";

// The inbox chapter is the poster: the marketing prerender (src/prerender-entry
// .tsx) renders it with renderToString, where the app's store holds nothing for
// it and has no visitor. So it must draw from its fixtures alone.
//
// What this pins, and what it cannot: the store MODULE is already on the
// prerender's graph (src/layouts/MarketingLayout -> components/ThemeProvider),
// and so is every view that renders a Link (src/compat/next-link ->
// tabRouting), so a store-free module graph is not a property the poster can
// have. The two properties that matter are: the chapter's own modules never
// import the store at runtime, and rendering the poster on the server reads
// nothing from it.

const NOW = Date.UTC(2026, 8, 30, 12);
const web = path.resolve(import.meta.dir, "../../../..");
const repo = path.resolve(web, "../..");
const STORE = path.join(web, "store/inboxStore.ts");

const OWN = ["inbox.chapter.ts", "inbox.tsx", "inbox.motion.ts"].map((f) => path.join(import.meta.dir, f))
  .concat([path.join(import.meta.dir, "../fixtures/desk.ts")]);

function renderPoster(parts: typeof inbox.parts) {
  return renderToString(
    <HeroSandbox>
      <FilmClockContext.Provider value={createFilmClock(POSTER_T)}>
        {parts.map((p) => <p.Component key={p.key} now={NOW} />)}
      </FilmClockContext.Provider>
    </HeroSandbox>,
  );
}

describe("the poster chapter", () => {
  test("its own modules have no runtime import of the store", () => {
    const alias = (spec: string) => (spec.startsWith("@/") ? path.join(web, spec.slice(2)) : null);
    for (const file of OWN) {
      const graph = buildBootGraph(file, repo, { alias });
      const own = graph.nodes.get(file)!;
      expect(own.imports.includes(STORE), `${path.basename(file)} imports the store`).toBe(false);
    }
  });

  test("renders on the server from fixtures alone, reading nothing from the store", () => {
    const getState = spyOn(useInboxStore, "getState");
    const getInitialState = spyOn(useInboxStore, "getInitialState");
    let html = "";
    try {
      html = renderPoster(inbox.parts);
      expect(getState, "store reads").not.toHaveBeenCalled();
      expect(getInitialState, "server snapshot reads").not.toHaveBeenCalled();
    } finally {
      getState.mockRestore();
      getInitialState.mockRestore();
    }
    // The poster shows the lead landed and selected, over the six sessions it opens on.
    expect(POSTER_T).toBeGreaterThan(CUES.leadSelected);
    expect(html).toContain(SESSIONS.lead.title);
    for (const r of inboxRows(NOW)) expect(html).toContain(r.session.title as string);
    expect(html).toContain('data-active="true"');
  });

  test("the prerendered film is visible: nothing on the way to the desk is at opacity 0", async () => {
    const { HeroFlythrough } = await import("../../HeroFlythrough");
    const html = renderToString(<HeroFlythrough />);
    const at = html.indexOf('data-fly="mount:desk"');
    expect(at, "the desk is in the prerender").toBeGreaterThan(0);
    // Everything before the desk is its ancestors and the world's backdrop: none may hide the poster until the scripts land.
    expect(html.slice(0, at)).not.toMatch(/style="[^"]*opacity:\s*0(;|")/);
    expect(html).toContain(SESSIONS.lead.title);
  });

  test("the conversation half of the poster renders on the server with the prompt in it", () => {
    const html = renderPoster(conversation.parts);
    expect(html).toContain(SESSIONS.lead.title);
    expect(html).toContain(PROMPT);
  });
});
