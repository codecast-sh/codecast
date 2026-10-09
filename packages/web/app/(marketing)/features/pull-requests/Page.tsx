"use client";

import { SOL } from "../../blog/blogChrome";
import "./pr.css";
import { Hero } from "./Hero";
import { Batch } from "./Batch";
import { Doors, Linked, Switchboard, Tour } from "./Sections";
import { Closing, Limits, Names, PublicRepo, Reference, Related, Ship } from "./More";
import { C, Section } from "./kit";
import { Shot } from "../decisions/kit";
import { useStillMode } from "../kit";

export default function PullRequestsPage() {
  const isStatic = useStillMode();
  return (
    <main className="prx-root" data-static={isStatic ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      <Hero />

      <Section
        id="how"
        n={1}
        tone="paper"
        title="One page per pull request, kept in step with GitHub"
        lede={
          <>
            <p>
              Open a pull request from a conversation, a task, a plan or a repository&apos;s page. The header shows its state,
              author and branches, the <b>Shepherd</b> line, and <b>Checks</b>, <b>Review</b>, <b>Merge</b>, <b>Open comments</b> and{" "}
              <b>Diff</b> at a glance, over the <b>Conversation</b>, <b>Files</b>, <b>Commits</b> and <b>Checks</b> tabs.
            </p>
            <p>
              Codecast keeps the page current from GitHub&apos;s webhooks and sends every act taken here back to GitHub. The page,
              an agent and a script all go through one server layer, so nothing one of them can do is missing from another.
            </p>
          </>
        }
      >
        <Shot
          src="/features/pull-requests/pr-page.webp"
          alt="A pull request page in codecast: title, Open state, branches, the Shepherd line naming the session that opened it and reading Wakes on changes, then checks, review, merge, open comments and diff, over the Conversation, Files, Commits and Checks tabs"
          w={1800}
          h={820}
          className="mb-12"
          caption={<>A pull request on codecast&apos;s own repository. The agent session that opened it stays on as its shepherd and wakes on changes.</>}
        />
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
            Hold a note on each line that needs one, from the Files view. Held notes are yours alone and are drawn dashed. When you finish, they leave together as one GitHub review under your account, and if a session
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
            The <b>Shepherd</b> line in the header names the session that owns the pull request. Agents that open one through
            codecast take the role themselves; on a pull request without one, click <b>Assign a shepherd session</b> and pick a
            session, and switch it between <b>Wakes on changes</b> and <b>Paused</b> on the same line. Only something the agent
            can act on wakes it, and each wake hands the session a briefing rebuilt from where the pull request stands now.
          </p>
        }
      >
        <Switchboard />
      </Section>

      <Section
        id="ship"
        n={5}
        title="Ask for a pull request; the agent sees it to the merge"
        lede={
          <p>
            The agent that opens the pull request also shepherds it: commits, a description that links the session, the
            Shepherd line, and a session that sleeps between events instead of polling.
          </p>
        }
      >
        <Ship />
      </Section>

      <Section id="public" n={6} tone="paper" title="Public repositories get a public page">
        <PublicRepo />
      </Section>

      <Section
        id="names"
        n={7}
        title="Whose name is on it"
        lede={<p>Most acts go out under the codecast GitHub app. The ones that carry judgement go out as you.</p>}
      >
        <Names />
      </Section>

      <Section
        id="terminal"
        n={8}
        tone="paper"
        title="For scripts and agents"
        lede={<p>Every act on the page has a <C>cast pr</C> verb, which is how the shepherd works. You can use the same verbs from a terminal or a script. The read verbs, as they print:</p>}
      >
        <Tour />
        <div className="mt-12"><Reference /></div>
      </Section>

      <Section id="limits" n={9} title="Limits and plain answers">
        <Limits />
      </Section>

      <Section id="related" n={10} tone="paper" title="Works with">
        <Related />
      </Section>

      <Closing />
    </main>
  );
}
