"use client";

import { useStillMode } from "../kit";
import { PUBLISH_CSS } from "./motion";
import { Hero } from "./Hero";
import { Inputs } from "./Inputs";
import { Live } from "./Live";
import { History } from "./History";
import { Comments } from "./Comments";
import { Gates } from "./Gates";
import { Places } from "./Places";
import { Video } from "./Video";
import { Reference } from "./Reference";
import { Closing, Limits } from "./Limits";

/** /features/publish: the cast publish deep dive. Still mode (`?static` or reduced motion) renders every animation at its end state. */
export default function PublishPage() {
  const isStatic = useStillMode();
  return (
    <main className="pb-root" data-static={isStatic ? "" : undefined}>
      <style>{PUBLISH_CSS}</style>
      <Hero />
      <Inputs />
      <Live />
      <History />
      <Comments />
      <Gates />
      <Places />
      <Video />
      <Reference />
      <Limits />
      <Closing />
    </main>
  );
}
