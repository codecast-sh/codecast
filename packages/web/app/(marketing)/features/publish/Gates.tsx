"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, CYAN, Flag, Section } from "./kit";

type Gate = { id: string; flag: string; off?: string; name: string; short: string; what: ReactNode; screen: ReactNode };

function Field({ placeholder, value }: { placeholder: string; value?: string }) {
  return (
    <div className="rounded-md border px-3 h-9 flex items-center font-mono text-[12px]" style={{ borderColor: "rgba(88,110,117,.3)", color: value ? SOL.base02 : SOL.base1, backgroundColor: "#fff" }}>
      {value ?? placeholder}
    </div>
  );
}

function GateCard({ title, body, children }: { title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="w-full max-w-[300px] rounded-xl border p-5 text-left" style={{ borderColor: "rgba(88,110,117,.25)", backgroundColor: SOL.base3, boxShadow: "0 20px 40px -24px rgba(0,43,54,.45)" }}>
      <div className="font-mono text-[10.5px] mb-3 pb-2 border-b truncate" style={{ color: SOL.base1, borderColor: SOL.base2 }}>Q3 churn audit</div>
      <div className="font-mono text-[13px] font-bold" style={{ color: SOL.base03 }}>{title}</div>
      <div className="mt-1 text-[12.5px] leading-5" style={{ color: SOL.base01 }}>{body}</div>
      {children && <div className="mt-4 space-y-2">{children}</div>}
    </div>
  );
}

function Btn({ children }: { children: ReactNode }) {
  return <div className="rounded-md h-9 flex items-center justify-center font-mono text-[12px] font-semibold text-white" style={{ backgroundColor: SOL.base03 }}>{children}</div>;
}

const GATES: Gate[] = [
  {
    id: "password", short: "A password before the page loads.", flag: "--password-stdin", off: "--no-password", name: "Password",
    what: <>Readers type a password before the page loads. The server keeps only a salted hash, and each page accepts 12 guesses a minute.</>,
    screen: <GateCard title="This page is password protected" body={<>Enter the password to view <b>Q3 churn audit</b>.</>}><Field placeholder="Password" value="••••••••" /><Btn>Unlock</Btn></GateCard>,
  },
  {
    id: "email", short: "An email address before viewing, logged per reader.", flag: "--email-gate", off: "--no-email-gate", name: "Email gate",
    what: <>Readers give an email address before viewing. <strong>Seen by</strong> in Manage sharing then lists each address with how many times and when it opened the page. The address is not verified, so treat it as who said they were reading.</>,
    screen: <GateCard title="Enter your email to view" body={<>The author of <b>Q3 churn audit</b> asks viewers to identify themselves.</>}><Field placeholder="you@company.com" value="maya@northwind.dev" /><Btn>Continue</Btn></GateCard>,
  },
  {
    id: "expires", short: "The link closes after a duration you set.", flag: "--expires 7d", off: "--expires never", name: "Expires",
    what: <>The link stops working after a duration, from one minute to weeks, or never. The page and its history stay in your list; only the link closes.</>,
    screen: <GateCard title="This link has expired" body={<>The author set an expiry on <b>Q3 churn audit</b> and it has passed.</>} />,
  },
  {
    id: "edit", short: "Who can edit and publish from the browser.", flag: "--edit-mode link", name: "Editing",
    what: <>By default only you publish versions. Open it to anyone holding an edit link, or to signed-in teammates, and they can edit and publish from the browser with <strong>Edit this page</strong>. A version made in the browser records who made it.</>,
    screen: (
      <div className="w-full max-w-[300px] rounded-xl border overflow-hidden text-left" style={{ borderColor: "rgba(88,110,117,.25)", boxShadow: "0 20px 40px -24px rgba(0,43,54,.45)" }}>
        <div className="flex items-center justify-between px-3 h-9 border-b font-mono text-[11px]" style={{ borderColor: SOL.base2, backgroundColor: SOL.base2, color: SOL.base01 }}>
          <span>churn-audit.md</span>
          <span className="rounded px-2 py-0.5 text-white font-semibold" style={{ backgroundColor: CYAN }}>Publish</span>
        </div>
        <div className="px-3 py-3 font-mono text-[11px] leading-[1.7] bg-white" style={{ color: SOL.base02 }}>
          <div># Q3 churn audit</div>
          <div style={{ color: SOL.base1 }}>&nbsp;</div>
          <div>Churn rose from 3.1% to <span style={{ backgroundColor: "rgba(42,161,152,.2)" }}>4.4%</span><span className="pb-caret" /></div>
        </div>
      </div>
    ),
  },
  {
    id: "session", short: "Hide the link back to the publishing session.", flag: "--no-session", off: "--session", name: "Session link",
    what: <>By default the page&apos;s bar links to the session that published it, so a teammate can read how the page came to be. Hide that link for pages you send outside the team.</>,
    screen: (
      <div className="w-full max-w-[300px] rounded-lg border px-3 h-9 flex items-center gap-2 font-mono text-[11px]" style={{ borderColor: "rgba(88,110,117,.25)", backgroundColor: "#fff", color: SOL.base01 }}>
        <span className="truncate font-semibold" style={{ color: SOL.base03 }}>Q3 churn audit</span>
        <span className="line-through" style={{ color: SOL.blue, textDecorationColor: SOL.red }}>Churn analysis</span>
        <span className="ml-auto rounded-full border px-2" style={{ borderColor: "rgba(88,110,117,.28)" }}>v4</span>
      </div>
    ),
  },
];

/** What a reader meets at each gate: the password, email and expiry screens side by side. */
export function GateScreens() {
  return (
    <div className="grid sm:grid-cols-3 gap-4 justify-items-center">
      {GATES.filter((g) => ["password", "email", "expires"].includes(g.id)).map((g) => <div key={g.id} className="w-full flex justify-center">{g.screen}</div>)}
    </div>
  );
}

function GateBoard() {
  const [active, setActive] = useState(GATES[0].id);
  const g = GATES.find((x) => x.id === active) ?? GATES[0];
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(88,110,117,.22)" }}>
      <div role="tablist" aria-label="Gates" className="divide-y bg-white/70" style={{ borderColor: "rgba(88,110,117,.15)" }}>
        {GATES.map((x) => {
          const on = x.id === active;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(x.id)}
              onMouseEnter={() => setActive(x.id)}
              className="w-full text-left px-5 sm:px-6 py-4 transition-colors block"
              style={{ backgroundColor: on ? "rgba(42,161,152,.07)" : undefined, borderColor: "rgba(88,110,117,.15)", boxShadow: on ? `inset 3px 0 0 ${CYAN}` : undefined }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[14px] font-semibold" style={{ color: SOL.base03 }}>{x.name}</span>
                <Flag>{x.flag}</Flag>
                {x.off && <Flag color={SOL.base1}>{x.off}</Flag>}
              </div>
              <div className={`text-[14.5px] leading-6 mt-2 ${on ? "" : "hidden lg:block"}`} style={{ color: SOL.base01 }}>{on ? x.what : x.short}</div>
            </button>
          );
        })}
      </div>
      <div className="pb-paper relative flex items-center justify-center p-8 min-h-[260px] border-t lg:border-t-0 lg:border-l" style={{ borderColor: "rgba(88,110,117,.15)" }}>
        <div key={g.id} className="pb-anim pb-rise w-full flex justify-center">{g.screen}</div>
        <span className="absolute bottom-3 right-4 font-mono text-[10.5px]" style={{ color: SOL.base1 }}>what the reader sees</span>
      </div>
    </div>
  );
}

const SAFETY: { k: string; v: ReactNode }[] = [
  { k: "Unlisted", v: <>Pages have unguessable links, are never listed anywhere, and tell search engines not to index them.</> },
  { k: "Sandboxed", v: <>Every page and bundle file is served under a sandbox policy. A script on a published page runs, but can&apos;t act with your codecast sign-in.</> },
  { k: "No leaking tokens", v: <>Gate tokens ride in the page&apos;s query string, so pages send no referrer. A link on your page can&apos;t carry them away.</> },
  { k: "Revocation bound", v: <>Add a password, set an expiry or delete a page, and caches stop serving the old answer within six minutes. Copies a reader already saved can&apos;t be recalled by anyone.</> },
];

export function Gates() {
  return (
    <Section
      id="gates"
      n="04"
      title="Decide who can read it, for how long, and who can change it."
      lede={<>Open <strong>Manage sharing</strong> from the page&apos;s ⋯ menu (or <strong>Manage</strong> on its card in Pages) to set a password, an email gate, an expiry, comments, the session link and who can edit. A change leaves the content and version alone and only changes who gets in. An agent can set the same gates when it publishes; each one&apos;s flag is beside its name.</>}
    >
      <GateBoard />
      <div className="mt-10">
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-6">
          {SAFETY.map((s) => (
            <div key={s.k}>
              <dt className="font-mono text-[13px] font-semibold flex items-center gap-2" style={{ color: SOL.base03 }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CYAN }} />{s.k}
              </dt>
              <dd className="mt-1.5 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
