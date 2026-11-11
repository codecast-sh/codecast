"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { agentSetupPagePath, deviceDisplayName, isAgentSetupTool, type AgentSetupTool } from "@codecast/shared/contracts";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { useDevices, type Device } from "@/components/DeviceBadge";
import { useLocalDeviceId } from "@/hooks/useLocalDeviceId";
import { useMountEffect } from "@/hooks/useMountEffect";
import { useAgentToolSetup } from "@/lib/useAgentToolSetup";
import { agentSetupSteps, type AgentSetupStep } from "@/lib/agentToolSetupSteps";
import { useRouteMeta } from "../pageMeta";
import { SOL } from "../blog/blogChrome";
import { HeroStage as BrowserStage } from "../features/browser/HeroStage";
import { BX_CSS } from "../features/browser/kit";
import { HeroStage as ComputerStage } from "../features/computer/HeroStage";
import "../features/computer/computer.css";

/**
 * /setup/browser and /setup/computer: where every route into a tool's setup
 * lands (the CLI, the extension's first run, agent guidance, feature pages).
 * It says what the tool does, then finishes the setup on one machine from
 * here: each step is a link the person follows or a start the machine's
 * daemon runs (useAgentToolSetup), so nobody types a command. `?device=`
 * names the machine; without it, the one this browser runs on.
 */

const INK = SOL.base03;
const BODY = SOL.base01;
const LINE = "#eadfc2";

interface ToolCopy {
  accent: string;
  title: string;
  dek: string;
  facts: Array<[string, string]>;
  tries: string[];
  feature: string;
}

const COPY: Record<AgentSetupTool, ToolCopy> = {
  browser: {
    accent: SOL.red,
    title: "Let your agents use your Chrome",
    dek: "Each agent session gets its own background tab in the Chrome you already use, signed in where you are. It opens pages, clicks, types, and posts what it saw into the conversation.",
    facts: [
      ["Its own tab", "in a red Cast group, behind your tabs"],
      ["Your sign-ins", "no second browser, no passwords handed over"],
      ["Proof in the thread", "screenshots, console errors, failed requests"],
    ],
    tries: [
      "Open localhost:3000, sign up as a new user and screenshot each step",
      "Check the pricing page on mobile width and list anything that overflows",
      "Find last week's failed payments in my Stripe dashboard",
    ],
    feature: "/features/browser",
  },
  computer: {
    accent: SOL.magenta,
    title: "Let your agents use your Mac's apps",
    dek: "Agents read an app's window as a list of its buttons, fields and text, then click, type and scroll in it. They work in windows behind yours and never take your keyboard.",
    facts: [
      ["Any Mac app", "Notes, Slack, Mail, Finder, System Settings"],
      ["Behind your windows", "nothing comes forward on its own"],
      ["Two permissions", "granted to one small signed helper, not your terminal"],
    ],
    tries: [
      "Read my unread Slack DMs and summarize what needs a reply",
      "Make a Notes checklist from the open tasks in this repo",
      "Turn on Do Not Disturb until 5pm",
    ],
    feature: "/features/computer",
  },
};

export default function SetupPage() {
  const raw = useParams<{ tool: string }>().tool ?? "";
  const tool: AgentSetupTool | null = isAgentSetupTool(raw) ? raw : null;
  useRouteMeta(tool ? agentSetupPagePath(tool) : "/features");
  return (
    <div className="min-h-screen w-full overflow-x-clip" style={{ backgroundColor: SOL.base3 }}>
      <MarketingNav active="/features" />
      {tool ? <ToolSetup tool={tool} /> : (
        <main className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="font-mono text-2xl font-bold mb-4" style={{ color: INK }}>Nothing to set up here</h1>
          <Link href="/features" className="text-sm underline" style={{ color: SOL.blue }}>All features</Link>
        </main>
      )}
    </div>
  );
}

function ToolSetup({ tool }: { tool: AgentSetupTool }) {
  const c = COPY[tool];
  return (
    <main>
      <style>{BX_CSS}</style>
      <section className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(900px 420px at 90% 0%, color-mix(in srgb, ${c.accent} 8%, transparent), transparent 70%)` }} />
        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-12 sm:pt-16 pb-12 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px] gap-10 lg:gap-14 items-start [&>*]:min-w-0">
          <div>
            <h1 className="font-mono font-bold text-[32px] sm:text-[44px] leading-[1.06] tracking-[-0.04em] [text-wrap:balance]" style={{ color: INK }}>
              {c.title}
            </h1>
            <p className="mt-5 text-[16px] sm:text-[17px] leading-8 max-w-xl" style={{ color: BODY }}>{c.dek}</p>
            <dl className="mt-8 grid sm:grid-cols-3 gap-3">
              {c.facts.map(([k, v]) => (
                <div key={k} className="rounded-xl px-4 py-3" style={{ backgroundColor: "#fffaf0", border: `1px solid ${LINE}`, boxShadow: `inset 3px 0 0 ${c.accent}` }}>
                  <dt className="font-mono font-bold text-[14px]" style={{ color: INK }}>{k}</dt>
                  <dd className="mt-1 text-[13px] leading-5" style={{ color: BODY }}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <SetupBox tool={tool} />
        </div>
      </section>
      <section className="max-w-7xl mx-auto px-5 sm:px-8 pb-14">
        {tool === "browser" ? <BrowserStage /> : <ComputerStage />}
      </section>
      <Tries tool={tool} />
    </main>
  );
}

/** Which machine the steps run on: `?device=`, else this browser's machine, else the newest online one. */
function useSetupMachine(signedIn: boolean) {
  const named = useSearchParams().get("device");
  const { devices, locals, mostRecentOnlineLocal, loaded } = useDevices();
  const localId = useLocalDeviceId(signedIn);
  const [picked, setPicked] = useState<string | null>(null);
  const choices = useMemo(
    () => devices.filter((d) => !d.is_remote || d.device_id === named).sort((a, b) => Number(b.online) - Number(a.online) || b.last_seen - a.last_seen),
    [devices, named],
  );
  const byId = (id: string | null) => (id ? devices.find((d) => d.device_id === id) : undefined);
  const machine = byId(picked) ?? byId(named) ?? byId(localId) ?? mostRecentOnlineLocal ?? locals[0] ?? null;
  return { machine, choices, pick: setPicked, loaded };
}

function SetupBox({ tool }: { tool: AgentSetupTool }) {
  const c = COPY[tool];
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { machine, choices, pick, loaded } = useSetupMachine(isAuthenticated);
  const live = isAuthenticated && !!machine?.online && !(tool === "computer" && !supportsComputer(machine));
  const setup = useAgentToolSetup(machine ? { deviceId: machine.device_id } : null, tool, live);
  const steps = agentSetupSteps(tool, live ? setup.status : undefined);
  const ready = live && !!setup.status?.ready;

  // Coming back from the Web Store tab or System Settings is when the answer changes.
  const lastCheck = useRef(0);
  const checkRef = useRef(setup.check);
  checkRef.current = setup.check;
  const liveRef = useRef(live);
  liveRef.current = live;
  useMountEffect(() => {
    const again = () => {
      if (!liveRef.current || document.visibilityState !== "visible" || Date.now() - lastCheck.current < 3_000) return;
      lastCheck.current = Date.now();
      void checkRef.current();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  });

  const returnTo = typeof window === "undefined" ? agentSetupPagePath(tool) : `${window.location.pathname}${window.location.search}`;
  const blocker: React.ReactNode =
    isLoading ? null
    : !isAuthenticated ? (
      <Blocker
        title="Sign in to finish here"
        action={<Primary accent={c.accent} href={`/login?return_to=${encodeURIComponent(returnTo)}`}>Sign in</Primary>}
      />
    )
    : !loaded ? null
    : !machine ? (
      <Blocker
        title="Codecast is not on this computer yet"
        action={<Primary accent={c.accent} href="/download?manual=1">Download Codecast</Primary>}
      />
    )
    : !machine.online ? (
      <Blocker
        title={`${deviceDisplayName(machine)} is offline`}
        detail="Open the Codecast app on it. This box picks up as soon as it is back."
        action={<Primary accent={c.accent} href="/download?manual=1">Get the app</Primary>}
      />
    )
    : tool === "computer" && !supportsComputer(machine) ? (
      <Blocker title={`${deviceDisplayName(machine)} runs ${machine.platform}`} detail="Agent computer use needs a Mac (or Linux with X11)." />
    )
    : null;

  const next = steps.findIndex((s) => !s.done);
  const busy = isLoading || (isAuthenticated && !loaded) || (live && (setup.checking || setup.waiting));

  return (
    <div className="rounded-2xl overflow-hidden lg:sticky lg:top-20" style={{ border: `1px solid ${LINE}`, backgroundColor: "rgba(255,250,240,.9)", boxShadow: "0 18px 40px -28px rgba(0,43,54,.35)" }}>
      <div className="flex items-center gap-2 px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
        <span className="font-mono font-bold text-[15px]" style={{ color: INK }}>Set up</span>
        {machine && isAuthenticated && (
          choices.length > 1 ? (
            <select
              aria-label="Machine"
              value={machine.device_id}
              onChange={(e) => pick(e.target.value)}
              className="font-mono text-[13px] rounded-md px-1.5 py-0.5 bg-transparent"
              style={{ color: BODY, border: `1px solid ${LINE}` }}
            >
              {choices.map((d) => <option key={d.device_id} value={d.device_id}>{deviceDisplayName(d)}{d.online ? "" : " (offline)"}</option>)}
            </select>
          ) : (
            <span className="font-mono text-[13px]" style={{ color: BODY }}>on {deviceDisplayName(machine)}</span>
          )
        )}
        <span className="ml-auto">{busy && <Loader2 className="h-4 w-4 animate-spin" style={{ color: SOL.base1 }} />}</span>
      </div>

      {ready ? (
        <div className="px-5 py-6">
          <div className="flex items-center gap-2.5 font-mono font-bold text-[17px]" style={{ color: SOL.green }}>
            <span className="h-7 w-7 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: SOL.green }}><Check className="h-4 w-4" strokeWidth={3} /></span>
            Ready
          </div>
          <p className="mt-2 text-[14px] leading-6" style={{ color: BODY }}>
            Every agent on {machine ? deviceDisplayName(machine) : "this machine"} can now {tool === "browser" ? "work in your Chrome" : "use your Mac's apps"}. Ask one in plain words.
          </p>
          <div className="mt-4"><Primary accent={c.accent} href="/inbox">Open Codecast</Primary></div>
        </div>
      ) : (
        <ol>
          {steps.map((s, i) => (
            <StepRow
              key={s.label}
              n={i + 1}
              step={s}
              accent={c.accent}
              current={i === next && (live || (!isAuthenticated && "href" in (s.action ?? {})))}
              // Links work for anyone; a start needs the machine.
              actionable={!!s.action && ("href" in s.action || (live && !setup.checking))}
              waiting={setup.waiting}
              onStart={() => void setup.start()}
              first={i === 0}
            />
          ))}
        </ol>
      )}

      {!ready && live && setup.waiting && (
        <p className="px-5 pb-4 -mt-1 font-mono text-[12.5px]" style={{ color: c.accent }}>
          {tool === "computer" ? "Turn on “codecast computer” in System Settings" : "Click Pair in the Chrome tab that opened"}
        </p>
      )}
      {!ready && live && setup.error && <p className="px-5 pb-4 text-[13px]" style={{ color: SOL.red }}>{setup.error}</p>}
      {blocker}
    </div>
  );
}

function supportsComputer(d: Device): boolean {
  return /darwin|mac|linux/i.test(d.platform);
}

function StepRow({ n, step, accent, current, actionable, waiting, onStart, first }: {
  n: number;
  step: AgentSetupStep;
  accent: string;
  current: boolean;
  actionable: boolean;
  waiting: boolean;
  onStart: () => void;
  first: boolean;
}) {
  const a = step.action;
  return (
    <li className="flex items-start gap-3 px-5 py-4" style={{ borderTop: first ? undefined : `1px solid ${LINE}`, opacity: step.done || current ? 1 : 0.6 }}>
      <span
        className="mt-0.5 h-7 w-7 shrink-0 rounded-full flex items-center justify-center font-mono text-[13px] font-bold"
        style={step.done ? { backgroundColor: SOL.green, color: "#fff" } : current ? { backgroundColor: accent, color: "#fff" } : { border: `1.5px solid ${SOL.base1}`, color: SOL.base1 }}
      >
        {step.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono font-bold text-[15px]" style={{ color: step.done ? SOL.base1 : INK, textDecoration: step.done ? "line-through" : undefined }}>{step.label}</div>
        {!step.done && step.hint && <div className="mt-0.5 text-[13px] leading-5" style={{ color: BODY }}>{step.hint}</div>}
        {!step.done && a && actionable && (
          <div className="mt-3">
            {"href" in a ? (
              <Primary accent={accent} href={a.href} external quiet={!current}>{a.label}</Primary>
            ) : (
              <button
                type="button"
                disabled={waiting}
                onClick={onStart}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13.5px] font-semibold transition-all hover:-translate-y-px disabled:opacity-60 disabled:hover:translate-y-0"
                style={current ? { backgroundColor: accent, color: "#fff" } : { border: `1px solid ${accent}`, color: accent }}
              >
                {waiting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {waiting ? "Waiting…" : a.label}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Blocker({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="px-5 py-4" style={{ borderTop: `1px solid ${LINE}`, backgroundColor: "rgba(238,232,213,.45)" }}>
      <div className="font-mono font-bold text-[14px]" style={{ color: INK }}>{title}</div>
      {detail && <p className="mt-1 text-[13px] leading-5" style={{ color: BODY }}>{detail}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function Primary({ accent, href, external, quiet, children }: { accent: string; href: string; external?: boolean; quiet?: boolean; children: React.ReactNode }) {
  const style = quiet ? { border: `1px solid ${accent}`, color: accent } : { backgroundColor: accent, color: "#fff", boxShadow: `0 8px 22px -12px ${accent}` };
  const cls = "inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13.5px] font-semibold transition-all hover:-translate-y-px";
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls} style={style}>{children}<ExternalLink className="h-3.5 w-3.5" /></a>
  ) : (
    <Link href={href} className={cls} style={style}>{children}</Link>
  );
}

function Tries({ tool }: { tool: AgentSetupTool }) {
  const c = COPY[tool];
  return (
    <section style={{ backgroundColor: SOL.base2 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-14 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-8 items-start">
        <div>
          <h2 className="font-mono font-bold text-[22px] tracking-tight" style={{ color: INK }}>Then ask for things like</h2>
          <Link href={c.feature} className="mt-3 inline-block font-mono text-[13px] underline underline-offset-4" style={{ color: BODY }}>How it works</Link>
        </div>
        <ul className="grid gap-2.5">
          {c.tries.map((t) => <TryRow key={t} text={t} accent={c.accent} />)}
        </ul>
      </div>
    </section>
  );
}

function TryRow({ text, accent }: { text: string; accent: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex items-center gap-3 rounded-xl px-4 py-3" style={{ backgroundColor: "#fffaf0", border: `1px solid ${LINE}` }}>
      <span className="font-mono text-[14px] flex-1" style={{ color: INK }}>{text}</span>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 h-8 w-8 rounded-md flex items-center justify-center"
        style={{ color: copied ? SOL.green : accent }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </li>
  );
}
