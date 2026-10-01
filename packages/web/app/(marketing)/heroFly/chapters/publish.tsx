"use client";

/**
 * Chapter 11, Publish: the lead session answers with a canvas report and runs
 * `cast publish`; the report becomes its page, framed the way a conversation
 * frames a published page. The page in the frame is the real codecast.sh/a/
 * chrome with its comments, generated ahead of time (scripts/hero-page.ts)
 * and isolated in a sandboxed iframe with an opaque origin.
 */

import { AssistantBlock } from "@/components/conversation/blocks/turnBlocks";
import { PageCard, PageFavicon, PublishedPageActions } from "@/components/PublishedPageEmbed";
import type { PartProps } from "./contract";
import { fly, useFilmTime } from "../filmClock";
import { PAGE, PUBLISH, REPLY } from "../fixtures/publish";
import { SESSIONS } from "../fixtures/story";

const noop = () => {};
const TOOL_ID = "hero-tool-publish";
const TOOL_CALLS = [{ id: TOOL_ID, name: "Bash", input: JSON.stringify({ command: REPLY.command, description: "Publish the report as a page" }) }];
const TOOL_RESULTS = [{ tool_use_id: TOOL_ID, content: REPLY.output }];

function Reply({ now }: { now: number }) {
  const ran = useFilmTime((t) => t >= PUBLISH.command);
  return (
    <div className="mx-auto w-[680px] pt-8" {...fly("page/publish.reply")}>
      <AssistantBlock
        content={REPLY.content}
        timestamp={now - REPLY.ago}
        messageId="hero-msg-publish"
        agentType={SESSIONS.lead.agent}
        toolCalls={ran ? TOOL_CALLS : undefined}
        toolResults={ran ? TOOL_RESULTS : undefined}
      />
    </div>
  );
}

function Page() {
  const framed = useFilmTime((t) => t >= PUBLISH.frame);
  return (
    <div className="absolute inset-x-6 top-5" {...fly("page/publish.card")}>
      <PageCard
        icon={<PageFavicon className="h-4 w-4" />}
        title={PAGE.title}
        href={`https://${PAGE.url}`}
        actions={<PublishedPageActions slug={PAGE.slug} expanded={false} onToggleExpand={noop} />}
      >
        <div className="h-[470px] w-full bg-sol-card" data-hero-live="">
          {framed && (
            <iframe src="/hero/page.html" className="h-full w-full" sandbox="allow-scripts" title={PAGE.title} loading="eager" />
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
