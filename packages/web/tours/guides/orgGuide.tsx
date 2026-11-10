"use client";
// The Org guide: Tidepool, a small team building a booking app, grows from
// every session reporting to you into roles that own areas and bring you only
// what needs you. Each chapter is one idea of the feature
// (docs/architecture/org-roles.md, org-staffing.md), drawn on the stage with
// the guide kit; the copy names what a person sees in the app.
import { Check, MoreHorizontal, Pause, Play, X } from "lucide-react";
import { Switch } from "../../components/ui/switch";
import { Chip, Count, Dot, Face, Msg, Person, ROLES, RoleCard, SessionRow, Show, StageButton, StatePill, Win, Wires, useArrived, useStageDrag, wirePath, type RoleKey, type WorkState } from "./kit";
import type { GuideDef, SceneProps } from "./types";

const ACCENT = "var(--sol-violet)";
const YOU_COLOR = "var(--sol-blue)";

// ------------------------------------------------------------ 1. too many threads

const INBOX: Array<{ title: string; lane: "product" | "qa" | "growth" }> = [
  { title: "Plan next week's release", lane: "product" },
  { title: "Fix double booking on slot release", lane: "qa" },
  { title: "Draft the spring promo email", lane: "growth" },
  { title: "Flaky test in booking-sync", lane: "qa" },
  { title: "Spec: group bookings", lane: "product" },
  { title: "A/B test the pricing page", lane: "growth" },
  { title: "Refund webhook retries", lane: "qa" },
  { title: "Onboarding checklist copy", lane: "product" },
  { title: "Checkout times out on slow 3G", lane: "qa" },
  { title: "Referral credits", lane: "growth" },
  { title: "Calendar sync for instructors", lane: "product" },
  { title: "Weekly metrics digest", lane: "growth" },
];
const LANE_Y = { product: 170, qa: 300, growth: 430 } as const;
const rowY = (i: number) => 36 + 34 + 12 + i * 39 + 17;

function TooMany({ beat }: SceneProps) {
  const shown = beat === 0 ? 7 : INBOX.length;
  const grouped = beat >= 2;
  const youX = 935, youY = 300;
  const stateOf = (i: number): WorkState => (beat === 1 ? (i % 5 === 3 ? "working" : "needs_input") : grouped ? (i % 4 === 0 ? "needs_input" : i % 3 === 0 ? "done" : "working") : i % 3 === 1 ? "needs_input" : "working");
  return (
    <div className="gs">
      <Win title={<><b>Inbox</b><span className="gs-dim">· Tidepool</span></>} at={{ x: 36, y: 36, w: 440, h: 528 }} right={<span className="gs-pill" style={{ color: "var(--sol-orange)", background: "color-mix(in srgb, var(--sol-orange) 14%, transparent)" }}><Count value={beat === 0 ? 9 : beat === 1 ? 41 : 2} /> FOR YOU</span>}>
        <div className="absolute left-[12px] right-[12px] top-[12px] flex flex-col gap-[5px]">
          {INBOX.map((r, i) => (
            <Show key={r.title} on={i < shown} style={{ transitionDelay: `${(i % 7) * 60}ms` }}>
              <SessionRow title={r.title} state={stateOf(i)} who={grouped ? <Face avatar={ROLES[r.lane].avatar} size={16} /> : undefined} />
            </Show>
          ))}
        </div>
      </Win>
      <Wires>
        {INBOX.map((r, i) => (
          <path key={`d${i}`} d={wirePath(476, rowY(i), youX - 34, youY)} className="gs-wire" data-hot={beat === 1 ? "" : undefined} style={{ opacity: !grouped && i < shown ? 0.85 : 0, stroke: beat === 1 ? "var(--sol-orange)" : undefined, strokeWidth: 1.1, transform: "rotate(0)" }} />
        ))}
        {INBOX.map((r, i) => (
          <path key={`g${i}`} d={wirePath(476, rowY(i), 692, LANE_Y[r.lane])} className="gs-wire" style={{ opacity: grouped ? 0.7 : 0, transitionDelay: `${300 + i * 25}ms` }} />
        ))}
        {(["product", "qa", "growth"] as const).map((k) => (
          <path key={k} d={wirePath(738, LANE_Y[k], youX - 34, youY)} className="gs-wire" data-hot="" style={{ opacity: grouped ? 1 : 0, transitionDelay: "700ms" }} />
        ))}
      </Wires>
      {(["product", "qa", "growth"] as const).map((k, i) => (
        <Show key={k} on={grouped} pop at={{ x: 668, y: LANE_Y[k] - 26 }} style={{ transitionDelay: `${150 + i * 120}ms` }}>
          <div className="flex flex-col items-center gap-1 w-[92px]">
            <Face avatar={ROLES[k].avatar} size={40} />
            <span className="text-[11px] font-semibold text-center leading-tight">{ROLES[k].name}</span>
          </div>
        </Show>
      ))}
      <div className="absolute flex flex-col items-center gap-2" style={{ left: youX - 75, top: youY - 34, width: 150 }}>
        <span className="rounded-full transition-[box-shadow] duration-500" style={{ boxShadow: beat === 1 ? "0 0 0 5px color-mix(in srgb, var(--sol-orange) 45%, transparent), 0 0 0 14px color-mix(in srgb, var(--sol-orange) 14%, transparent)" : "0 0 0 4px color-mix(in srgb, var(--guide-accent) 25%, transparent)" }}>
          <Person name="You" you size={64} color={YOU_COLOR} />
        </span>
        <span className="text-[13px] font-semibold">You</span>
        <span className="text-[11.5px] text-center leading-tight" style={{ color: beat === 1 ? "var(--sol-orange)" : "var(--sol-text-muted)" }}>
          <Count value={beat === 0 ? 9 : beat === 1 ? 41 : 2} /> waiting on you
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 2. a role

function ARole({ beat }: SceneProps) {
  const sessions: Array<[string, WorkState]> = [
    ["Plan next week's release", "working"],
    ["Spec: group bookings", "needs_input"],
    ["Onboarding checklist copy", "done"],
    ["Calendar sync for instructors", "working"],
  ];
  return (
    <div className="gs">
      <div className="gs-card absolute" style={{ left: 56, top: 50, width: 500, height: 478, padding: 22 }}>
        <div className="flex items-center gap-4">
          <Face avatar="fox" size={72} />
          <div className="min-w-0">
            <div className="gs-serif text-[26px] font-semibold leading-tight">Head of Product</div>
            <div className="text-[12px] gs-dim mt-1">@product · a role at Tidepool</div>
            <div className="mt-2 flex items-center gap-2 text-[12px] gs-muted">Reports to <Person name="You" you size={18} color={YOU_COLOR} /> <span className="text-[var(--sol-text)] font-semibold">You</span></div>
          </div>
        </div>
        <Show on={beat >= 1} at={{ x: 22, y: 116, w: 456 }}>
          <div className="gs-label">OWNS</div>
          <p className="text-[13px] mt-1 leading-snug">The booking app: what ships each week, and why.</p>
          <div className="flex gap-1.5 mt-2"><Chip color="var(--sol-blue)">Booking app</Chip><Chip color="var(--sol-blue)">Instructor calendar</Chip></div>
        </Show>
        <Show on={beat >= 2} at={{ x: 22, y: 212, w: 456 }}>
          <div className="gs-label">ITS OWN SESSION</div>
          <div className="mt-2 rounded-xl p-3 flex flex-col gap-2" style={{ background: "var(--sol-bg)", border: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)" }}>
            <div className="flex items-center gap-2 text-[12px]"><Dot state="working" /> <span className="font-semibold">Working</span><span className="gs-dim">· planning Thursday's release</span></div>
            <div className="text-[12px] gs-muted leading-snug">"Yesterday you held group bookings for the pricing review. It's done, so I've put the spec back in this week's plan."</div>
          </div>
        </Show>
        <Show on={beat >= 3} at={{ x: 22, y: 358, w: 456 }}>
          <div className="gs-label">TRIGGERS THAT WAKE IT</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {[["Every 4 hours", "Review its open work", "in 1h 12m"], ["A session needs input", "Answer, or bring it to you", "armed"]].map(([when, what, next], i) => (
              <div key={when} className="flex items-center gap-3 h-[38px] px-3 rounded-lg" style={{ background: "var(--sol-bg)", border: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)", animation: beat === 3 ? `guide-breathe 1.6s ${i * 0.4}s ease-in-out 2` : undefined }}>
                <span className="text-[12px] font-semibold w-[178px] shrink-0">{when}</span>
                <span className="text-[12px] gs-muted flex-1 truncate">{what}</span>
                <span className="text-[11px] gs-dim">{next}</span>
              </div>
            ))}
          </div>
        </Show>
      </div>
      <Wires>
        {sessions.map((_, i) => (
          <path key={i} d={`M556,${150} C600,150 600,${150 + i * 52} 640,${150 + i * 52}`} className="gs-wire" style={{ opacity: beat >= 1 ? 0.8 : 0, transitionDelay: `${i * 90}ms` }} />
        ))}
      </Wires>
      <Show on={beat >= 1} at={{ x: 640, y: 96, w: 350 }}>
        <div className="gs-label mb-2">SESSIONS THAT REPORT TO IT</div>
      </Show>
      {sessions.map(([t, st], i) => (
        <Show key={t} on={beat >= 1} at={{ x: 640, y: 133 + i * 52, w: 360 }} style={{ transitionDelay: `${150 + i * 90}ms` }}>
          <SessionRow title={t} state={st} />
        </Show>
      ))}
      <Show on={beat >= 1} at={{ x: 640, y: 350, w: 360 }} style={{ transitionDelay: "600ms" }}>
        <div className="text-[12px] gs-muted leading-relaxed">Their questions go to Head of Product first. You hear about the one it cannot settle.</div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 3. the chart

const CHART: Array<{ key: RoleKey; cx: number; boss: "you" | "leo" | "product"; dots: WorkState[]; goal?: string }> = [
  { key: "people", cx: 120, boss: "you", dots: ["dormant"] },
  { key: "product", cx: 316, boss: "you", dots: ["working", "needs_input", "done", "working"], goal: "Group bookings live" },
  { key: "qa", cx: 512, boss: "you", dots: ["working", "working", "needs_input", "working", "done", "working"], goal: "Zero double bookings" },
  { key: "growth", cx: 708, boss: "you", dots: ["working", "done", "idle"], goal: "Bookings +20% by June" },
  { key: "infra", cx: 920, boss: "leo", dots: ["working", "dormant"], goal: "Checkout under 1s" },
];
const ROLE_W = 184;
const ROLE_Y = 290;

/** Where Growth goes when it is dropped on Head of Product, from where it stands. */
const GROWTH_MOVE = { x: 316 - 708, y: 452 - ROLE_Y };

function Chart({ beat, act, waiting }: SceneProps) {
  const moved = beat >= 3 || (beat === 2 && !waiting);
  const drag = useStageDrag(waiting, GROWTH_MOVE, act);
  const lens = beat >= 4 ? "Everything" : "People";
  const posOf = (c: (typeof CHART)[number]) => (c.key === "growth" && moved ? { cx: 316, y: 452 } : { cx: c.cx, y: ROLE_Y });
  const bossAt = (c: (typeof CHART)[number]) => (c.key === "growth" && moved ? { x: 316, y: ROLE_Y + 98 } : c.boss === "leo" ? { x: 920, y: 166 } : { x: 414, y: 166 });
  return (
    <div className="gs">
      <div className="absolute flex items-center gap-1 p-1 rounded-lg" style={{ left: 390, top: 22, background: "var(--sol-bg)", border: "1px solid color-mix(in srgb, var(--sol-border) 70%, transparent)" }}>
        {["People", "Everything", "Goals"].map((l) => (
          <span key={l} className="px-3 h-[26px] inline-flex items-center rounded-md text-[12px] transition-colors duration-500" style={{ background: l === lens ? "var(--sol-bg-alt)" : "transparent", color: l === lens ? "var(--sol-text)" : "var(--sol-text-dim)", fontWeight: l === lens ? 600 : 400 }}>{l}</span>
        ))}
      </div>
      <Wires>
        {CHART.map((c, i) => {
          const p = posOf(c), b = bossAt(c);
          return <path key={c.key} d={wirePath(b.x, b.y, p.cx, p.y)} className="gs-wire" data-hot={c.key === "growth" && moved ? "" : undefined} style={{ strokeDasharray: 600, strokeDashoffset: 0, animation: `gs-draw 900ms ${200 + i * 90}ms both` }} />;
        })}
      </Wires>
      {[{ x: 414, name: "You", you: true, sub: "Founder", color: YOU_COLOR }, { x: 920, name: "Leo", you: false, sub: "Engineer", color: "var(--sol-magenta)" }].map((p) => (
        <div key={p.name} className="gs-card absolute flex items-center gap-2.5" style={{ left: p.x - 80, top: 112, width: 160, padding: "9px 11px", animation: "guide-say-in 500ms both" }}>
          <Person name={p.name} you={p.you} size={32} color={p.color} />
          <div><div className="text-[13px] font-semibold leading-tight">{p.you ? "You" : p.name}</div><div className="text-[11px] gs-dim">{p.sub}</div></div>
        </div>
      ))}
      {CHART.map((c, i) => {
        const p = posOf(c);
        const waits = c.key === "growth" && waiting;
        return (
          <div key={c.key} className="absolute" style={{ left: p.cx - ROLE_W / 2, top: p.y, width: ROLE_W, zIndex: c.key === "growth" ? 2 : undefined, transition: c.key === "growth" && drag.live ? "none" : "left 900ms cubic-bezier(.3,.7,.2,1), top 900ms cubic-bezier(.3,.7,.2,1), transform 600ms cubic-bezier(.3,.7,.2,1)", transform: c.key === "growth" ? drag.transform : undefined, animation: `guide-say-in 500ms ${300 + i * 90}ms both` }}>
            <RoleCard role={c.key} spot={waits} line={c.key === "people" ? "weekly review" : `${c.dots.length} sessions`} state={c.dots.includes("needs_input") ? "needs_input" : "working"}>
              <div className="overflow-hidden transition-all duration-500" style={{ maxHeight: lens === "Everything" && c.goal ? 30 : 0, opacity: lens === "Everything" && c.goal ? 1 : 0 }}>
                <div className="mt-2 pt-2 text-[11px] truncate" style={{ color: "var(--sol-yellow)", borderTop: "1px solid color-mix(in srgb, var(--sol-border) 55%, transparent)" }}>◎ {c.goal}</div>
              </div>
            </RoleCard>
            {waits && (
              <button type="button" {...drag.handlers} className="absolute inset-0 rounded-xl cursor-grab active:cursor-grabbing touch-none" aria-label="Drag Growth under Head of Product" data-guide-stage-act />
            )}
            <div className="flex items-center gap-1.5 mt-2.5 px-1">
              {c.dots.map((d, j) => <span key={j} style={{ animation: beat >= 1 && d !== "idle" ? `guide-say-in 400ms ${j * 70}ms both` : undefined }}><Dot state={beat >= 1 ? d : "idle"} size={11} /></span>)}
            </div>
          </div>
        );
      })}
      <Show on={beat === 1} at={{ x: 60, y: 540 }}>
        <div className="flex items-center gap-4 text-[11.5px] gs-muted">
          {(["working", "needs_input", "done", "dormant"] as WorkState[]).map((s) => <span key={s} className="flex items-center gap-1.5"><Dot state={s} /> {s === "needs_input" ? "Waiting on someone" : s === "working" ? "Working" : s === "done" ? "Done, yours to read" : "Asleep until its trigger"}</span>)}
        </div>
      </Show>
      <Show on={waiting} at={{ x: 530, y: 470, w: 300 }}>
        <div className="gs-note" style={{ position: "relative" }}>Drag Growth onto Head of Product</div>
      </Show>
      <Show on={moved && beat < 4} pop at={{ x: 470, y: 470 }}>
        <div className="flex items-center gap-2 px-3 h-[32px] rounded-lg text-[12px]" style={{ background: "var(--sol-card)", border: "1px solid color-mix(in srgb, var(--guide-accent) 45%, transparent)" }}>
          <Check className="w-3.5 h-3.5" style={{ color: ACCENT }} /> Growth now reports to Head of Product <span className="gs-dim ml-2">Undo</span>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 4. hiring

const TEMPLATES: Array<{ name: string; faces: string[]; roles: string; hire?: boolean }> = [
  { name: "Software team", faces: ["fox", "hedgehog", "toucan", "owl"], roles: "Product, QA, Growth, Head of People", hire: true },
  { name: "Support desk", faces: ["seal", "penguin", "koala"], roles: "Triage, Billing help, Escalations" },
  { name: "Content studio", faces: ["swan", "robin"], roles: "Editor, Social" },
  { name: "Head of People", faces: ["owl"], roles: "Reviews the company and proposes roles" },
];
const HIRED: RoleKey[] = ["product", "qa", "growth", "people"];

function Hiring({ beat, act, waiting }: SceneProps) {
  const hired = beat >= 2;
  return (
    <div className="gs">
      <Win title={<><b>Hire</b><span className="gs-dim">· start from a template</span></>} at={{ x: 36, y: 36, w: 560, h: 528 }}>
        <div className="absolute left-4 right-4 top-4 grid grid-cols-2 gap-3">
          {TEMPLATES.map((t, i) => (
            <div key={t.name} className={`gs-card p-3.5 ${t.hire && waiting ? "gs-spot" : ""}`} style={{ height: 198, animation: `guide-say-in 450ms ${i * 80}ms both`, opacity: hired && !t.hire ? 0.45 : 1, transition: "opacity 500ms" }}>
              <div className="flex -space-x-2">{t.faces.map((f) => <span key={f} className="rounded-full" style={{ boxShadow: "0 0 0 2px var(--sol-card)" }}><Face avatar={f} size={34} /></span>)}</div>
              <div className="mt-3 text-[14px] font-semibold">{t.name}</div>
              <div className="text-[11.5px] gs-muted mt-1 leading-snug h-[34px]">{t.roles}</div>
              <div className="mt-2.5 flex items-center gap-2">
                <span className="text-[11px] gs-dim">{t.faces.length} {t.faces.length === 1 ? "role" : "roles"}</span>
                <span className="ml-auto">
                  {t.hire && hired ? <span className="gs-pill" style={{ color: ACCENT, background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)" }}><Check className="w-3 h-3" /> HIRED</span>
                    : <StageButton primary={t.hire} wait={t.hire && waiting} onPress={act}>Hire</StageButton>}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="absolute left-4 right-4 bottom-4 gs-card px-3 h-[46px] flex items-center gap-2" style={{ animation: "guide-say-in 450ms 400ms both" }}>
          <span className="text-[12.5px] gs-dim flex-1">Or describe one: "Keeps our help docs current"</span>
          <StageButton>Make role</StageButton>
        </div>
      </Win>
      <div className="absolute flex flex-col items-center" style={{ left: 640, top: 60, width: 364 }}>
        <div className="gs-card flex items-center gap-2 px-3 py-2"><Person name="You" you size={26} color={YOU_COLOR} /><span className="text-[13px] font-semibold">You</span></div>
        <svg width="364" height="40" aria-hidden><path d="M182,0 L182,20 M46,20 L318,20 M46,20 L46,40 M136,20 L136,40 M228,20 L228,40 M318,20 L318,40" className="gs-wire" style={{ opacity: hired ? 1 : 0.35 }} /></svg>
        <div className="grid grid-cols-4 gap-2 w-full">
          {HIRED.map((k, i) => (
            <div key={k} className={`gs-card flex flex-col items-center text-center gap-1.5 py-3 px-1 transition-all duration-500 ${hired ? "" : "gs-ghost"}`} style={{ opacity: hired ? 1 : 0.5, transitionDelay: `${i * 160}ms` }}>
              <span style={{ filter: hired ? "none" : "grayscale(1)", transition: `filter 500ms ${i * 160}ms` }}><Face avatar={ROLES[k].avatar} size={38} /></span>
              <span className="text-[11px] font-semibold leading-tight">{ROLES[k].name}</span>
            </div>
          ))}
        </div>
        <Show on={hired} at={{ x: 0, y: 200, w: 364 }} style={{ transitionDelay: "700ms" }}>
          <div className="flex flex-col gap-2">
            {[["Charter", "what each one owns, in a paragraph"], ["Projects", "Booking app → Head of Product, Checkout → QA Lead"], ["Triggers", "a review every few hours, and on needs input"]].map(([k, v]) => (
              <div key={k} className="flex gap-3 text-[12px] leading-snug"><span className="w-[70px] shrink-0 font-semibold">{k}</span><span className="gs-muted">{v}</span></div>
            ))}
          </div>
        </Show>
        <Show on={beat >= 3} at={{ x: 0, y: 320, w: 364 }}>
          <div className="gs-card p-3 flex items-center gap-3">
            <Pause className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
            <div className="flex-1 text-[12px] leading-snug"><b>Routines start paused.</b> <span className="gs-muted">Switch each on when you are ready.</span></div>
            <Switch checked={false} onCheckedChange={() => {}} aria-label="A role's routine" />
          </div>
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 5. head of people

function HeadOfPeople({ beat, act, waiting }: SceneProps) {
  const applied = beat >= 3;
  const load = { product: 0.62, qa: applied ? 0.78 : 1, growth: 0.41 } as const;
  return (
    <div className="gs">
      <Win title={<><Face avatar="owl" size={18} /><b>Head of People</b><span className="gs-dim">· weekly review</span></>} at={{ x: 36, y: 36, w: 420, h: 528 }}>
        <div className="absolute left-4 right-4 top-4 flex flex-col gap-3">
          <Msg from={<Face avatar="owl" size={26} />}>Weekly review: 5 roles, 41 sessions, 23 decisions answered. One seat is over its capacity.</Msg>
          <Show on={beat >= 1}>
            <Msg from={<Face avatar="owl" size={26} />}>QA Lead answered 14 decisions a day across Checkout and Payments, about three times what one role can hold. I propose a <b>Payments QA</b> role under it, taking the Payments project and its 6 sessions.</Msg>
          </Show>
          <Show on={applied}>
            <Msg from={<Person name="You" you size={26} color={YOU_COLOR} />} you>Approved.</Msg>
          </Show>
          <Show on={applied} style={{ transitionDelay: "500ms" }}>
            <Msg from={<Face avatar="owl" size={26} />}>Done. Payments QA is hired and its sessions moved. I'll check its load next week.</Msg>
          </Show>
        </div>
      </Win>
      {(["product", "qa", "growth"] as const).map((k, i) => (
        <RoleCard key={k} role={k} at={{ x: 488 + i * 176, y: 48, w: 172 }} line={<span style={{ color: load[k] >= 1 ? "var(--sol-red)" : undefined }}>{k === "qa" && load.qa >= 1 ? "3.1× its load" : `${Math.round(load[k] * 100)}% of its load`}</span>}>
          <div className="gs-bar mt-2.5"><i style={{ width: `${Math.min(1, load[k]) * 100}%`, background: load[k] >= 1 ? "var(--sol-red)" : load[k] > 0.7 ? "var(--sol-yellow)" : "var(--sol-green)" }} /></div>
        </RoleCard>
      ))}
      <Wires>
        <path d={wirePath(750, 128, 750, 196)} className="gs-wire" style={{ opacity: beat >= 1 ? 1 : 0, strokeDasharray: applied ? "none" : "4 4" }} data-hot={beat >= 1 ? "" : undefined} />
      </Wires>
      <Show on={beat >= 1} pop at={{ x: 664, y: 196, w: 172 }}>
        <RoleCard role="payments" ghost={!applied} line={applied ? "6 sessions" : "proposed"} state={applied ? "working" : undefined} />
      </Show>
      <Show on={beat >= 1 && !applied} at={{ x: 848, y: 200, w: 170 }} style={{ transitionDelay: "300ms" }}>
        <div className="flex flex-col gap-1.5 items-start"><Chip color={ACCENT}>+ owns Payments</Chip><Chip color={ACCENT}>6 sessions move</Chip></div>
      </Show>
      <Show on={beat >= 2} at={{ x: 488, y: 300, w: 524 }}>
        <div className="gs-card p-4" style={{ borderColor: applied ? "color-mix(in srgb, var(--sol-green) 45%, transparent)" : undefined }}>
          <div className="flex items-center gap-2">
            <span className="gs-pill" style={{ color: ACCENT, background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)" }}>PROPOSAL</span>
            <span className="text-[13.5px] font-semibold">Add Payments QA under QA Lead</span>
          </div>
          <div className="mt-3 flex flex-col gap-1.5 text-[12px]">
            {[["New role", "Payments QA, reports to QA Lead"], ["Moves", "Payments project and 6 sessions"], ["Why", "QA Lead is at 3.1× its load for two weeks running"]].map(([k, v]) => (
              <div key={k} className="flex gap-3"><span className="w-[70px] shrink-0 gs-dim">{k}</span><span>{v}</span></div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            {applied ? (
              <span className="text-[12.5px] font-semibold flex items-center gap-1.5" style={{ color: "var(--sol-green)" }}><Check className="w-4 h-4" /> Approved and applied</span>
            ) : (
              <>
                <StageButton primary wait={waiting} onPress={act}>Approve</StageButton>
                <StageButton>Adjust</StageButton>
                <StageButton>Reject</StageButton>
              </>
            )}
          </div>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 6. decisions climb

const LADDER = [
  { id: "you", y: 70 },
  { id: "qa", y: 196 },
  { id: "payments", y: 322 },
  { id: "hand", y: 448 },
] as const;
const LADDER_X = 230;

function Ladder({ beat, act, waiting }: SceneProps) {
  const second = beat >= 2;
  const answered = beat >= 4 || (beat === 3 && !waiting);
  // Where the question is: up one rung in the first beat, all the way up in the third.
  const arrived = useArrived(500);
  const tokenY = beat === 0 ? (arrived ? 322 : 448) : beat === 1 ? 322 : answered ? 448 : 70;
  const node = (id: (typeof LADDER)[number]["id"]) => {
    if (id === "you") return <div className="gs-card flex items-center gap-2.5" style={{ padding: "9px 11px" }}><Person name="You" you size={30} color={YOU_COLOR} /><div className="text-[13px] font-semibold">You</div></div>;
    if (id === "hand") return <div className="gs-card flex items-center gap-2 px-3 h-[48px]"><Dot state={answered || !second ? "working" : "needs_input"} /><span className="text-[12px] font-semibold whitespace-nowrap">Fix refund retries</span></div>;
    return <RoleCard role={id} />;
  };
  return (
    <div className="gs">
      <Wires>
        <path d={`M${LADDER_X},110 L${LADDER_X},448`} className="gs-wire" data-hot={second && !answered ? "" : undefined} />
      </Wires>
      {LADDER.map((r) => (
        <div key={r.id} className="absolute" style={{ left: LADDER_X - 100, top: r.y, width: 200 }}>{node(r.id)}</div>
      ))}
      <div className="gs-token" style={{ left: LADDER_X + 112, top: tokenY + 24, transitionDuration: second && !answered ? "1800ms" : "900ms" }} />
      {/* The first question: settled one rung up. */}
      <Show on={!second} at={{ x: LADDER_X + 132, y: 452, w: 250 }}><div className="gs-note" style={{ position: "relative" }}>Retry a failed refund 3 or 5 times?</div></Show>
      <Show on={!second} at={{ x: LADDER_X + 132, y: 318, w: 270 }} style={{ transitionDelay: "700ms" }}>
        <div className="gs-card px-3 py-2 text-[12px] leading-snug flex gap-2"><Check className="w-4 h-4 shrink-0" style={{ color: "var(--sol-green)" }} /><span><b>5, as Stripe recommends.</b> <span className="gs-muted">Settled by Payments QA.</span></span></div>
      </Show>
      <Show on={beat === 1} at={{ x: 640, y: 120, w: 340 }}>
        <div className="gs-card p-4 flex flex-col gap-3">
          {[["Settled by roles today", 37, "var(--sol-green)"], ["Reached you", 2, "var(--sol-orange)"]].map(([k, v, c]) => (
            <div key={k as string} className="flex items-baseline gap-3"><span className="gs-serif text-[34px] font-semibold tabular-nums" style={{ color: c as string }}>{v as number}</span><span className="text-[12.5px] gs-muted">{k}</span></div>
          ))}
        </div>
      </Show>
      {/* The second question: climbs, each rung adding what it knows. */}
      <Show on={second && !answered} at={{ x: LADDER_X + 132, y: 452, w: 226 }}><div className="gs-note" style={{ position: "relative" }}>Ship the refund fix to every customer today?</div></Show>
      <Show on={second} at={{ x: LADDER_X + 132, y: 326, w: 226 }} style={{ transitionDelay: "500ms" }}>
        <div className="text-[11.5px] gs-muted leading-snug">"Touches every customer, so it's not mine to call."</div>
      </Show>
      <Show on={second} at={{ x: LADDER_X + 132, y: 200, w: 226 }} style={{ transitionDelay: "1100ms" }}>
        <div className="text-[11.5px] leading-snug"><b>Recommends:</b> <span className="gs-muted">ship to 10% first and watch refunds for a day.</span></div>
      </Show>
      <Show on={beat >= 3} at={{ x: 620, y: 70, w: 390 }}>
        <div className="gs-card p-4" style={{ borderColor: "color-mix(in srgb, var(--guide-accent) 45%, transparent)" }}>
          <div className="flex items-center gap-2"><StatePill state="needs_input" /><span className="text-[11px] gs-dim">from Fix refund retries</span></div>
          <div className="mt-2 text-[14.5px] font-semibold leading-snug">Ship the refund fix to every customer today?</div>
          <div className="mt-3 flex items-start gap-2 text-[12px] leading-snug rounded-lg p-2.5" style={{ background: "var(--sol-bg)" }}>
            <Face avatar="hedgehog" size={20} /><span><b>QA Lead recommends</b> shipping to 10% first and watching refunds for a day.</span>
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {[["1", "Ship to 10% first", true], ["2", "Ship to everyone now", false], ["3", "Hold until Monday", false]].map(([k, label, rec]) => {
              const chosen = answered && rec;
              return (
                <button key={k as string} type="button" onClick={rec && waiting ? act : undefined} data-wait={rec && waiting ? "" : undefined} data-guide-stage-act={rec && waiting ? "" : undefined}
                  className={`flex items-center gap-2.5 h-[36px] px-3 rounded-lg text-left text-[12.5px] ${rec && waiting ? "gs-live cursor-pointer" : "pointer-events-none"}`}
                  style={{ border: `1px solid ${chosen ? "var(--guide-accent)" : "color-mix(in srgb, var(--sol-border) 70%, transparent)"}`, background: chosen ? "color-mix(in srgb, var(--guide-accent) 12%, transparent)" : "var(--sol-bg)", opacity: answered && !rec ? 0.45 : 1 }}>
                  <span className="text-[10.5px] gs-dim w-3">{k as string}</span><span className="flex-1">{label as string}</span>{rec && <span className="text-[10.5px]" style={{ color: ACCENT }}>recommended</span>}{chosen && <Check className="w-4 h-4" style={{ color: ACCENT }} />}
                </button>
              );
            })}
          </div>
        </div>
      </Show>
      <Show on={answered} at={{ x: 620, y: 420, w: 390 }} style={{ transitionDelay: "400ms" }}>
        <div className="text-[12.5px] gs-muted leading-snug">Your answer goes back down the line. QA Lead takes the rollout from here.</div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 7. a role's page

const TABS = ["Overview", "Work", "Sessions", "Decisions", "Triggers", "Settings"] as const;

function RolePage({ beat }: SceneProps) {
  const tab = beat <= 0 ? "Overview" : beat === 1 ? "Work" : beat === 2 ? "Triggers" : "Settings";
  const menu = beat >= 4;
  return (
    <div className="gs">
      <Win title={<><b>QA Lead</b><span className="gs-dim">· a role's page</span></>} at={{ x: 28, y: 28, w: 984, h: 544 }}>
        <div className="absolute left-0 right-0 top-0 h-[74px] flex items-center gap-3.5 px-5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)" }}>
          <Face avatar="hedgehog" size={44} />
          <div>
            <div className="gs-serif text-[20px] font-semibold leading-tight">QA Lead</div>
            <div className="text-[12px] gs-muted flex items-center gap-1.5 mt-0.5"><Dot state="working" /> Working · checking three open bugs before Thursday</div>
          </div>
          <div className="ml-auto flex items-center gap-2 text-[12px] gs-muted">Reports to <Person name="You" you size={20} color={YOU_COLOR} /> You</div>
          <span className={`w-8 h-8 rounded-lg inline-flex items-center justify-center ${menu ? "gs-spot" : ""}`} style={{ border: "1px solid color-mix(in srgb, var(--sol-border) 70%, transparent)" }}><MoreHorizontal className="w-4 h-4" /></span>
        </div>
        <Show on={menu} pop at={{ x: 712, y: 66, w: 240 }} style={{ zIndex: 3, transformOrigin: "top right" }}>
          <div className="gs-card p-1.5 flex flex-col text-[12.5px]" style={{ background: "var(--sol-card)", boxShadow: "0 24px 60px -20px rgba(0,0,0,.65)" }}>
            {[[Pause, "Pause", "stops it, keeps everything"], [X, "Retire", "its sessions report to you"]].map(([Icon, label, sub]: any) => (
              <div key={label} className="flex items-start gap-2 px-2 py-1.5 rounded-md"><Icon className="w-3.5 h-3.5 mt-0.5" /><span><span className="font-semibold">{label}</span><br /><span className="text-[11px] gs-dim">{sub}</span></span></div>
            ))}
          </div>
        </Show>
        <div className="absolute left-0 top-[74px] bottom-0 w-[470px] p-5 flex flex-col gap-3" style={{ borderRight: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)" }}>
          <Msg from={<Person name="You" you size={24} color={YOU_COLOR} />} you>What's blocking the checkout release?</Msg>
          <Msg from={<Face avatar="hedgehog" size={24} />}>One flaky test in booking-sync. A session is fixing it now; the fix comes to you as a card by 3pm. Everything else for Thursday is green.</Msg>
          <div className="mt-auto gs-card h-[44px] px-3 flex items-center text-[12.5px] gs-dim">Ask QA Lead…</div>
        </div>
        <div className="absolute right-0 top-[74px] bottom-0 left-[470px] p-4">
          <div className="flex gap-0.5">
            {TABS.map((t) => <span key={t} className="px-2 h-[26px] inline-flex items-center rounded-md text-[11.5px] transition-colors duration-300" style={{ background: t === tab ? "var(--sol-bg-alt)" : "transparent", color: t === tab ? "var(--sol-text)" : "var(--sol-text-dim)", fontWeight: t === tab ? 600 : 400 }}>{t}</span>)}
          </div>
          <div key={tab} className="mt-4 flex flex-col gap-2" style={{ animation: "guide-say-in 380ms ease-out" }}>
            {tab === "Overview" && (
              <>
                <div className="gs-label">CHARTER</div>
                <p className="text-[12.5px] leading-relaxed">Keeps checkout and bookings correct. Owns the Checkout project, triages every bug report, and decides what is safe to ship.</p>
                <div className="gs-label mt-2">STANDS</div>
                <div className="flex gap-1.5 flex-wrap"><Chip color="var(--sol-green)">Checkout: green</Chip><Chip color="var(--sol-orange)">1 flaky test</Chip><Chip>3 open bugs</Chip></div>
              </>
            )}
            {tab === "Work" && [["Fix double booking on slot release", "needs_input"], ["Flaky test in booking-sync", "working"], ["Checkout times out on slow 3G", "working"], ["Refund email missing receipt", "done"]].map(([t, st]) => (
              <SessionRow key={t} title={t} state={st as WorkState} who={<Face avatar="hedgehog" size={16} />} />
            ))}
            {tab === "Triggers" && [["Every 4 hours", "Review open work", "in 1h 12m", true], ["When a session needs input", "Answer it or bring it to you", "armed", true], ["Mondays 9am", "Write the week's QA plan", "paused", false]].map(([w, d, n, on]) => (
              <div key={w as string} className="gs-card flex items-center gap-3 px-3 h-[48px]">
                <div className="flex-1 min-w-0"><div className="text-[12.5px] font-semibold">{w as string}</div><div className="text-[11px] gs-dim truncate">{d as string}</div></div>
                <span className="text-[11px] gs-dim">{n as string}</span>
                <Play className="w-3.5 h-3.5 gs-dim" />
                <Switch checked={on as boolean} onCheckedChange={() => {}} aria-label={w as string} />
              </div>
            ))}
            {tab === "Settings" && (
              <>
                {[["Works on its own", "Starts sessions for its projects without asking", true], ["Hires its own help", "May propose new roles under it", false]].map(([k, d, on]) => (
                  <div key={k as string} className="gs-card flex items-center gap-3 px-3 h-[52px]">
                    <div className="flex-1"><div className="text-[12.5px] font-semibold">{k as string}</div><div className="text-[11px] gs-dim">{d as string}</div></div>
                    <Switch checked={on as boolean} onCheckedChange={() => {}} aria-label={k as string} />
                  </div>
                ))}
                <div className="gs-card flex items-center gap-3 px-3 h-[48px]"><span className="text-[12.5px] font-semibold flex-1">Daily limit</span><span className="text-[12px]">30 sessions a day</span></div>
                <div className="gs-card flex items-center gap-3 px-3 h-[48px]"><span className="text-[12.5px] font-semibold flex-1">Runs on</span><span className="text-[12px]">Leo's Mac mini</span></div>
              </>
            )}
          </div>
        </div>
      </Win>
    </div>
  );
}

// ------------------------------------------------------------ the guide

export const ORG_GUIDE: GuideDef = {
  id: "org-guide",
  feature: "org",
  name: "Org",
  accent: ACCENT,
  home: "/org",
  pageTour: "org-page",
  chapters: [
    {
      id: "threads",
      title: "Too many threads",
      Scene: TooMany,
      beats: [
        { say: "Tidepool's team runs about forty agent sessions a day. Right now every one of them reports to you." },
        { say: "Every question waits for your answer, so the whole team moves at the speed of your inbox.", hold: 3800 },
        { say: "Org puts roles between you and the work. Each role owns an area and answers for the sessions in it, so two questions reach you instead of forty.", hold: 5200 },
      ],
    },
    {
      id: "role",
      title: "A role",
      Scene: ARole,
      beats: [
        { say: "A role is a standing agent with a name, a face and one area it owns. It reports to a person." },
        { say: "It owns projects. Every session working on them reports to the role instead of to you.", hold: 4200 },
        { say: "It keeps one session open across days, so it remembers what was decided yesterday.", hold: 4200 },
        { say: "Triggers wake it: on a schedule, and whenever one of its sessions needs an answer.", hold: 4200 },
      ],
    },
    {
      id: "chart",
      title: "The chart",
      Scene: Chart,
      beats: [
        { say: "The Org page is the company as it runs: people, the roles under them, and the live sessions under each role." },
        { say: "Each dot is a session, colored by who acts next. Orange is waiting on someone; green is working.", hold: 4200 },
        { say: "Change the structure by dragging. Here Growth should report to Head of Product.", act: "Drag Growth under Head of Product" },
        { say: "One drop moved the role and every session under it. Undo is right there." },
        { say: "Everything adds each role's goal, so you can see what the work is for.", hold: 4200 },
      ],
    },
    {
      id: "hire",
      title: "Hiring",
      Scene: Hiring,
      beats: [
        { say: "Start from a template for your kind of team, or describe a role in one sentence." },
        { say: "Tidepool builds software. Hire the software team.", act: "Hire the software team" },
        { say: "Each role arrives with its charter, its triggers, and the projects it takes over from you.", hold: 4400 },
        { say: "Their routines start paused. Nothing runs until you switch it on.", hold: 3800 },
      ],
    },
    {
      id: "people",
      title: "Head of People",
      Scene: HeadOfPeople,
      beats: [
        { say: "The Head of People is a role that reviews the company every week: each role's load, its stalls, how long its decisions wait." },
        { say: "When the structure stops fitting, it proposes a change and draws it on the chart as a ghost.", hold: 4600 },
        { say: "A proposal says what changes and why. Nothing applies until a person approves.", act: "Approve the proposal" },
        { say: "Approved: Payments QA is hired, its sessions move, and QA Lead is back within its load.", hold: 4400 },
      ],
    },
    {
      id: "decisions",
      title: "Decisions climb",
      Scene: Ladder,
      beats: [
        { say: "A session's question goes first to the role it reports to. Payments QA settles this one." },
        { say: "Roles settle what their charter covers, and you never see those.", hold: 3400 },
        { say: "What a role cannot settle climbs the reporting line, and each role on the way adds what it knows.", hold: 4800 },
        { say: "It reaches you as one card with a recommendation already written.", act: "Pick: ship to 10% first" },
        { say: "One card instead of forty threads. Your answer goes back down to the session that asked." },
      ],
    },
    {
      id: "page",
      title: "A role's page",
      Scene: RolePage,
      beats: [
        { say: "Every role has a page. Talk to it like a colleague: it answers from what it has seen." },
        { say: "Work lists the tasks it owns and the sessions working them.", hold: 3400 },
        { say: "Triggers says what wakes it. Pause one, run it now, or change when it runs.", hold: 3800 },
        { say: "Settings: whether it works on its own, a daily limit, and the machine it runs on.", hold: 3800 },
        { say: "Pause stops a role and keeps everything. Retire removes it, and its sessions report to you again.", hold: 4200 },
      ],
    },
  ],
  gives: [
    "Roles that own areas and answer for the sessions in them",
    "One queue of decisions, each with a recommendation",
    "A Head of People that proposes the structure as you grow",
    "Triggers, a daily limit and a pause switch on every role",
  ],
};
