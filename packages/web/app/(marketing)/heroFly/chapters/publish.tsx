"use client";

/**
 * Chapter 11, Publish: the lead session answers with a canvas report and runs
 * `cast publish`; the report becomes its page, framed the way a conversation
 * frames a published page. The page in the frame is the real codecast.sh/a/
 * chrome with its comments, generated ahead of time (scripts/hero-page.ts),
 * shown as a still that becomes the live page (a sandboxed iframe with an
 * opaque origin) when a visitor points at it.
 */

import { useState } from "react";
import { AssistantBlock } from "@/components/conversation/blocks/turnBlocks";
import { PageCard, PageFavicon, PublishedPageActions } from "@/components/PublishedPageEmbed";
import type { PartProps } from "./contract";
import { fly } from "../filmClock";
import { FilmSwap } from "../film";
import { PAGE, PUBLISH, REPLY } from "../fixtures/publish";
import { SESSIONS } from "../fixtures/story";

const noop = () => {};
const TOOL_ID = "hero-tool-publish";
const TOOL_CALLS = [{ id: TOOL_ID, name: "Bash", input: JSON.stringify({ command: REPLY.command, description: "Publish the report as a page" }) }];
const TOOL_RESULTS = [{ tool_use_id: TOOL_ID, content: REPLY.output }];

const RAN = [PUBLISH.command];

/** The lead's reply; its `cast publish` call dissolves in under the text as it runs, rather than appearing in one frame. */
function Reply({ now }: { now: number }) {
  return (
    <div className="mx-auto w-[680px] pt-8" {...fly("page/publish.reply")}>
      <FilmSwap
        cues={RAN}
        render={(ran) => (
          <AssistantBlock
            content={REPLY.content}
            timestamp={now - REPLY.ago}
            messageId="hero-msg-publish"
            agentType={SESSIONS.lead.agent}
            toolCalls={ran ? TOOL_CALLS : undefined}
            toolResults={ran ? TOOL_RESULTS : undefined}
          />
        )}
      />
    </div>
  );
}

/**
 * The page: a still of it, captured from public/hero/page.html, so the film
 * never waits on a cross-process frame painting under the camera's
 * transform. The live page mounts over it only when a visitor reaches for
 * it, and fades in once it has loaded.
 */
function Page() {
  const [live, setLive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="absolute inset-x-6 top-3" {...fly("page/publish.card")}>
      <PageCard
        icon={<PageFavicon className="h-4 w-4" />}
        title={PAGE.title}
        href={`https://${PAGE.url}`}
        actions={<PublishedPageActions slug={PAGE.slug} expanded={false} onToggleExpand={noop} />}
      >
        <div className="relative h-[500px] w-full overflow-hidden bg-sol-card" data-hero-live="" onPointerEnter={() => setLive(true)}>
          <img src="/hero/page.jpg" alt="" className="absolute inset-0 h-full w-full object-cover object-top" decoding="async" draggable={false} />
          {live && (
            <iframe
              src="/hero/page.html"
              className="absolute inset-0 h-full w-full transition-opacity duration-300"
              style={{ opacity: loaded ? 1 : 0 }}
              sandbox="allow-scripts"
              title={PAGE.title}
              onLoad={() => setLoaded(true)}
            />
          )}
        </div>
      </PageCard>
    </div>
  );
}

export function PublishScene({ now }: PartProps) {
  return (
    <div className="relative h-full">
      <Reply now={now} />
      <Page />
    </div>
  );
}
