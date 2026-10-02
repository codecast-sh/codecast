import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RelativeTimeNow, useRelativeTime } from "@/lib/conversationFormat";
import { SessionMessageBlock } from "@/components/conversation/blocks/systemBlocks";
import { HeroSandbox } from "./sandbox";

// The hero's fixtures are stamped against the instant it mounted (`now`). A
// view's "2m ago" must read that offset, not how long the page has been open:
// with the wall clock five minutes on, a message stamped a second before `now`
// still says "just now" under the sandbox, and only outside it says "5m ago".

const now = 1_800_000_000_000;
let clock: ReturnType<typeof spyOn> | null = null;
afterEach(() => clock?.mockRestore());

function Probe({ ts }: { ts: number }) {
  const relativeTime = useRelativeTime();
  return <span>{relativeTime(ts)}</span>;
}

describe("relative time under the hero", () => {
  test("measures from the fixtures' instant, not the wall clock", () => {
    clock = spyOn(Date, "now").mockReturnValue(now + 5 * 60_000);
    expect(renderToStaticMarkup(<RelativeTimeNow.Provider value={now}><Probe ts={now - 1_000} /></RelativeTimeNow.Provider>)).toContain("just now");
    expect(renderToStaticMarkup(<RelativeTimeNow.Provider value={now}><Probe ts={now - 3 * 60_000} /></RelativeTimeNow.Provider>)).toContain("3m ago");
    // Outside a film, the wall clock as before.
    expect(renderToStaticMarkup(<Probe ts={now - 1_000} />)).toContain("5m ago");
  });

  test("a real view under the sandbox reads it too", () => {
    clock = spyOn(Date, "now").mockReturnValue(now + 5 * 60_000);
    const html = renderToStaticMarkup(
      <HeroSandbox now={now}>
        <SessionMessageBlock from="jx7d2wk" body="Retry route is in." timestamp={now - 40_000} />
      </HeroSandbox>,
    );
    expect(html).toContain("just now");
    expect(html).not.toContain("5m ago");
  });
});
