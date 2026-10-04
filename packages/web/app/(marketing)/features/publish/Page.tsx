"use client";

import { useEffect, useState } from "react";
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

/** /features/publish: the cast publish deep dive. `?static` renders every animation at its end state. */
export default function PublishPage() {
  const [isStatic, setStatic] = useState(false);
  useEffect(() => {
    setStatic(new URLSearchParams(window.location.search).has("static"));
  }, []);
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
