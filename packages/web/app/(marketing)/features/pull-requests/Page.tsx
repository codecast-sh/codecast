"use client";

import { useEffect, useState } from "react";
import { SOL } from "../../blog/blogChrome";
import "./pr.css";
import { Hero } from "./Hero";
import { Batch } from "./Batch";
import { Doors, Linked, Switchboard, Tour } from "./Sections";
import { Closing, Limits, Names, PublicRepo, Reference, Related, Ship } from "./More";
import { C, Section } from "./kit";

/** `?static` renders every animation at its end state (screenshots, slow machines). */
function useStatic(): boolean {
  const [s, setS] = useState(false);
  useEffect(() => {
    setS(new URLSearchParams(window.location.search).has("static"));
  }, []);
  return s;
}

export default function PullRequestsPage() {
  const isStatic = useStatic();
  return (
    <main className="prx-root" data-static={isStatic ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      <Hero />

      <Section
        id="how"
        n={1}
        tone="paper"
        title="One row per pull request, three ways in"
        lede={
          <>
            <p>
              A pull request lives on GitHub. Codecast keeps a copy of it current from GitHub&apos;s webhooks and sends every act
              taken here back to GitHub. The page, the CLI and an agent all go through one server layer, so nothing one of
              them can do is missing from another.
            </p>
          </>
        }
      >
        <Doors />
      </Section>

      <Section
        id="sessions"
        n={2}
        title="Every pull request knows its sessions"
        lede={
          <p>
            When an agent wrote the change, the reasoning is in a transcript, not in the description. So the pull request
            carries links to the conversations that made it: the shepherd in the header, the other sessions and tasks beside it,
            and a session on every commit. A reviewer is one click from what the agent was trying to do.
          </p>
        }
      >
        <Linked />
      </Section>

      <Section
        id="batch"
        n={3}
        tone="paper"
        title="A review is one batch with one verdict"
        lede={
          <p>
            Hold a note on each line that needs one, from the Files view or with <C>--hold</C>. Held notes are yours alone and
            are drawn dashed. When you finish, they leave together as one GitHub review under your account, and if a session
            owns the pull request the whole review reaches it as one message the moment GitHub accepts it. Pick a verdict below.
          </p>
        }
      >
        <Batch />
      </Section>

      <Section
        id="shepherd"
        n={4}
        title="The shepherd: what wakes it, and what it reads"
        lede={
          <p>
            <C>cast pr shepherd on</C> binds a session to the pull request and creates one standing trigger for it. Only a
            wake sets that trigger to run, and a wake comes from something the agent can act on. Each wake hands the
            session a briefing rebuilt from where the pull request stands now.
          </p>
        }
      >
        <Switchboard />
      </Section>

      <Section
        id="terminal"
        n={5}
        tone="paper"
        title="All of it from a terminal"
        lede={<p>The read verbs, as they print. An agent uses the same ones you do.</p>}
      >
        <Tour />
      </Section>

      <Section
        id="ship"
        n={6}
        title="/cast-ship: from finished work to a merge"
        lede={
          <p>
            The skill that opens the pull request also shepherds it. Commits, a description that links the session, the
            binding, and a session that sleeps between events instead of polling.
          </p>
        }
      >
        <Ship />
      </Section>

      <Section id="public" n={7} tone="paper" title="Public repositories get a public page">
        <PublicRepo />
      </Section>

      <Section
        id="names"
        n={8}
        title="Whose name is on it"
        lede={<p>Most acts go out under the codecast GitHub app. The ones that carry judgement go out as you.</p>}
      >
        <Names />
      </Section>

      <Section id="reference" n={9} tone="paper" title="Command reference">
        <Reference />
      </Section>

      <Section id="limits" n={10} title="Limits and plain answers">
        <Limits />
      </Section>

      <Section id="related" n={11} tone="paper" title="Works with">
        <Related />
      </Section>

      <Closing />
    </main>
  );
}
