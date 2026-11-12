"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Screenshot, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Three genuine screenshots of the Codecast web app (a local dev build of this
// repo, signed in to the founder's account) in Chrome on 2026-11-11. The
// conversation pictured is session jx7ck79: a plain Claude Code session started
// in a terminal with the prompt shown, nothing else typed into it. Its findings
// (the stale service worker on codecast.sh, the HTTP 500 on the dev server) are
// quoted from its reply. The dev server failed because this post's route was
// registered in src/App.tsx a few minutes before its page file existed; the
// session found that on its own. A second run of the same prompt fifteen
// minutes later (jx7ca7t) found both pages rendering with no console errors.
// The browser card is the Agent features page on the same account. Product
// claims were checked against the "Let agents use your Chrome" guide,
// packages/cli/src/browser (handoff.ts, policy.ts, bridge/protocol.ts) and
// packages/browser-extension/background.js. Nothing was composited or retouched.

const DIR = "/blog/agents-in-your-own-chrome";

export default function AgentsInYourOwnChromePost() {
  const post = getPost("agents-in-your-own-chrome");
  useRouteMeta("/blog/agents-in-your-own-chrome");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />

      <article className="max-w-2xl mx-auto px-6 pt-16 pb-24">
        <Link href="/blog" className="inline-flex items-center gap-1 text-sm font-medium mb-8" style={{ color: SOL.yellow }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Blog
        </Link>

        <header className="mb-10">
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.12] tracking-tight font-mono" style={{ color: SOL.base03 }}>
            Your coding agent can check the page in your own Chrome
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>A check we ran today</H2>
        <P>
          On November 11 we started Claude Code in a terminal and typed one request: check that
          the pricing page renders on codecast.sh and on a local dev server, screenshot both, and
          report any console errors. Nothing else was typed into the session. Codecast showed the
          conversation as it ran, and this is the top of Claude&apos;s answer.
        </P>

        <Screenshot
          src={`${DIR}/pricing-reply.png`}
          alt="A Codecast conversation titled Pricing page render check. The request to check the pricing page on codecast.sh and on localhost:3201 is pinned at the top. Claude's reply says the prod pricing page renders correctly only after its tab picked up the new build, shows a screenshot of the codecast.sh pricing page inline, and quotes the console error TypeError: Failed to fetch dynamically imported module from the first load."
          caption="The request, and the start of Claude's answer with its screenshot of codecast.sh/pricing inline."
        />

        <P>
          The first load of codecast.sh/pricing showed &ldquo;Pricing crashed&rdquo;. Claude read
          the console, found <Code>Failed to fetch dynamically imported module</Code>, and traced
          it to the site&apos;s service worker: that Chrome had an older build cached, and the old
          build asked for a file the server no longer has. Claude told the service worker to check
          for an update, reloaded, and the page rendered with no console errors. It also pointed
          out that anyone holding the same old build would see the crash until their service
          worker updates. That one is a real bug on our site, found by the check.
        </P>
        <P>
          The dev server was stuck on its loading screen, with nothing in the console but
          Vite&apos;s connection messages. Claude asked the server for the app&apos;s main file
          directly, got an HTTP 500, and read the compile error behind it.
        </P>

        <Screenshot
          src={`${DIR}/dev-server-500.png`}
          alt="Further down the same reply: the compile error Failed to resolve import for a blog page, and Claude's explanation that packages/web/src/App.tsx has an uncommitted edit adding a route for a blog post whose page file is not on disk, and that the dev server should recover once the file exists or the import is removed."
          caption="The dev server's real error, which never reached the console."
        />

        <P>
          The missing file was this post. We had added its route a few minutes before writing the
          page, and the check caught it. We ran the same request again fifteen minutes later:
          both pages rendered, with no console errors.
        </P>

        <H2>Where the agent&apos;s tab lives</H2>
        <P>
          The agent works in the Chrome you already have open, in the profile you paired, so your
          logins come with it: staging, an admin panel, a dashboard behind single sign-on. Nothing
          is copied out of Chrome. Each session gets one tab, opened in the background inside a
          red tab group called <strong>Cast</strong>. It never takes focus, so you can keep typing
          in your own tabs while it works.
        </P>
        <P>
          A tab being driven wears a thin frame and a pointer follows the agent&apos;s clicks. If
          you pin the Codecast icon in Chrome&apos;s toolbar, its badge reads RUN while you look at
          a tab an agent is driving. Chrome also shows its own notice
          that Codecast is debugging the browser. The frame and pointer are hidden while a
          screenshot is taken, so they never end up in the picture.
        </P>
        <P>
          A session can only touch tabs it opened. It cannot read, close or navigate your tabs or
          another session&apos;s, and a tab you open yourself is moved out of the Cast group so
          agents leave it alone. When a session finishes, its tab is closed.
        </P>

        <H2>What comes back to the conversation</H2>
        <P>
          Each browser step shows up in the conversation as a row above the agent&apos;s reply,
          with thumbnails of the screenshots it took. Click a thumbnail to see it full size.{" "}
          <strong>open tab</strong> brings the agent&apos;s tab to the front in your Chrome,{" "}
          <strong>watch live</strong> opens it in a pane beside the conversation, and if the tab
          has been closed the row offers to reopen it. The count of images in the conversation
          header opens all of them in one viewer.
        </P>
        <P>
          When a page misbehaves, the agent reports the errors the page logged and the requests
          that failed, as in the check above. You read the cause in the reply instead of opening
          DevTools yourself.
        </P>

        <H2>What you do once</H2>
        <P>
          Open <strong>Agent features</strong> from your account menu, pick the computer your
          agents run on, and switch on <strong>Browser</strong> under <em>Hands on the
          machine</em>. The card asks for two steps: <strong>Install extension</strong> adds
          Codecast from the Chrome Web Store, and <strong>Pair</strong> connects it to that
          computer. When both are done the card reads <em>Chrome connected</em>.
        </P>

        <Screenshot
          src={`${DIR}/browser-card.png`}
          alt="The Browser card in Codecast's Agent features, switched on, reading Agents check their own UI work in your Chrome, with your sign-ins, with a green Chrome connected line and a How it works link"
          caption="The Browser card once the extension is paired."
        />

        <P>
          Chrome has to run on the same computer as the agent, so you repeat this on each computer
          you use. If an agent reaches for the browser before setup is done, the same steps appear
          as a card under its step in the conversation, with a button to tell the agent to
          continue once Chrome is connected.
        </P>

        <H2>Sign-ins and other steps that stay yours</H2>
        <P>
          When a page asks for a login, a two-factor code or a payment, the agent hands that step
          to you. A card appears inside the page in its tab saying what to do, with a{" "}
          <strong>Continue</strong> button, and the pinned icon&apos;s badge reads WAIT on that tab. You sign
          in, click Continue, and the agent carries on in the same tab. Only your own click counts;
          the agent cannot press Continue for you.
        </P>
        <P>A few other limits are built in:</P>
        <ul className="list-disc pl-6 my-4 space-y-2 text-lg leading-relaxed" style={{ color: SOL.base01 }}>
          <li>
            If the extension is missing or asleep, the agent waits and tells you what to fix. It
            does not start a different browser instead.
          </li>
          <li>
            Chrome does not let any extension drive its own pages, such as{" "}
            <Code>chrome://</Code> settings or the Chrome Web Store. The agent gives you the link
            and the steps and carries on with the rest.
          </li>
          <li>
            Agents read and click through pages freely. Submitting a form, sending a message,
            buying something or changing account settings happens only when you asked for it.
          </li>
          <li>
            A project can list the sites its agents may visit. Local addresses like a dev server
            are reachable only when the list names them exactly.
          </li>
        </ul>

        <H2>What you need</H2>
        <P>
          Desktop Chrome, the Codecast app on the computer where your agents run, and the
          extension paired from Agent features. You don&apos;t need a team for any of it. Ask in plain words
          (&ldquo;open the settings page and show me a screenshot&rdquo;), and agents that change
          a web app also use it to check their own work. The{" "}
          <Link href="/documentation/browser" className="underline" style={{ color: SOL.blue }}>
            browser guide
          </Link>{" "}
          has the full setup and a troubleshooting table.
        </P>
        <P>
          For people who script: agents drive the tab with <Code>cast browser</Code> commands
          (<Code>open</Code>, <Code>shot</Code>, <Code>console</Code>, <Code>handoff</Code>), and
          you can run them yourself from a terminal.
        </P>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast records every coding agent session you run, on any machine, and gives you one
          place to see them, steer them and answer them, on your own or with your team.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <Link href="/documentation/browser">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Read the browser guide
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All three screenshots are the Codecast web app in Chrome on 2026-11-11, signed in to
          the founder&apos;s account, from a local build of the app. The first two are crops of
          one conversation, a Claude Code session started in a terminal with the request shown;
          its findings are quoted as it wrote them. The third is the Browser card on the Agent
          features page. Each image is cropped to the conversation or the card, leaving out the
          sidebars and other sessions. Nothing was composited or retouched.
        </p>
      </article>
    </main>
  );
}
