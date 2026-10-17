"use client";

import { useState, type ReactNode } from "react";
import { Bot, Flame, Plus } from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, MUTED, TEXT, V, tint, ROLLOUT_SOURCE } from "./theme";
import { AppFrame, C, Code, Section } from "./kit";
import { FactValue, HoverCard, Pill, StatusBadge } from "./objects";
import { CUS_A, CUS_B, INC6, INC7, INC_STATUSES, incident, statusTone } from "./data";
import { FindingBlock, RolloutBlock } from "./blocks";

/* ── 5. Your kinds ───────────────────────────────────────────────────────── */

const MANIFEST = `"objects": [{
  "prefix": "inc",
  "title": "Incident",
  "plural": "Incidents",
  "icon": "flame",
  "statuses": ["triage", "mitigating", "monitoring", "resolved"],
  "fields": {
    "severity":  { "type": "enum", "options": ["sev-1", "sev-2", "sev-3"] },
    "service":   { "type": "text" },
    "commander": { "type": "person" },
    "started":   { "type": "date" },
    "session":   { "type": "ref" }
  }
}]`;

const INC8 = incident(8, "Refund webhooks retry with no cap", "triage", [["severity", "sev-3"], ["service", "refunds-worker"]]);

/** Which manifest lines each output comes from, so pointing at one lights the other. */
const OUTPUTS: { key: string; lines: number[]; title: string; note: ReactNode; body: ReactNode }[] = [
  {
    key: "pill", lines: [2, 5], title: "A pill everywhere markdown renders",
    note: <>Messages, docs, comments, chat, published pages. <C>inc-6</C> is resolved, so it dims.</>,
    body: <div className="text-[14px] leading-8" style={{ color: TEXT }}><Pill o={INC8} /> <Pill o={INC7} /> <Pill o={INC6} /></div>,
  },
  {
    key: "board", lines: [6], title: "A board and a table",
    note: <>One column per status, drag to move. A <b style={{ color: TEXT, fontWeight: 600 }}>New incident</b> field on top.</>,
    body: (
      <div className="grid grid-cols-4 gap-1.5">
        {INC_STATUSES.map((s) => {
          const rows = s === "triage" ? [INC8] : s === "mitigating" ? [INC7] : s === "resolved" ? [INC6] : [];
          return (
            <div key={s} className="rounded-md p-1.5 min-h-[86px]" style={{ backgroundColor: "rgba(238,232,213,.55)" }}>
              <div className="mb-1.5 flex items-center gap-1"><StatusBadge label={s} color={statusTone(INC_STATUSES, s)} /></div>
              {rows.map((r) => (
                <div key={r.id} className="rounded border px-1.5 py-1 mb-1" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
                  <div className="font-mono text-[9.5px]" style={{ color: DIM }}>{r.id}</div>
                  <div className={`text-[10.5px] leading-tight ${r.done ? "line-through opacity-60" : ""}`} style={{ color: TEXT }}>{r.title}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    ),
  },
  {
    key: "page", lines: [7, 8, 9, 10, 11, 12], title: "A page per object, with typed fields",
    note: <>A severity picker, a person picker, a date, a link to the session it came from. All editable.</>,
    body: (
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {[["severity", <StatusBadge key="s" label="sev-2" color={SOL.orange} />], ["service", "payments-api"], ["commander", "Dana"], ["started", "Oct 16, 2:14pm"], ["session", <Pill key="p" o={{ id: "jx7c6zk", kind: "Session", icon: Bot, color: SOL.blue, title: "Checkout failing" }} />]].map(([k, v]) => (
          <div key={k as string} className="contents"><span style={{ color: DIM }}>{k}</span><span style={{ color: TEXT }}>{v}</span></div>
        ))}
      </div>
    ),
  },
];

export function YourKinds() {
  const [hot, setHot] = useState<string | null>(null);
  const mark = OUTPUTS.find((o) => o.key === hot)?.lines ?? [];
  return (
    <Section
      id="your-kinds"
      tone="sand"
      title="Add your own object kinds"
      lede={<>A kind is a few lines in a mod's manifest: a prefix, its statuses in order, and typed fields. From that, codecast gives your kind what its own objects have: numbered ids, a pill in every conversation, a card on hover, a board and a table, a page for each object, and commands your agents use to file and update them.</>}
      aside={<>Ids only become pills when a mod declares the prefix, so <C>covid-19</C> in a sentence stays prose. A kind stays recognised while its mod is switched off.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] gap-6 items-start">
        <Code file="incident-desk / codecast-mod.json" code={MANIFEST} mark={mark} size={12} className="lg:sticky lg:top-24" />
        <div className="space-y-3">
          {OUTPUTS.map((o) => (
            <div
              key={o.key}
              onMouseEnter={() => setHot(o.key)}
              onMouseLeave={() => setHot(null)}
              className="md-lift rounded-xl border p-4"
              style={{ borderColor: hot === o.key ? V : LINE, backgroundColor: SOL.base3 }}
            >
              <div className="text-[14px] font-semibold" style={{ color: TEXT }}>{o.title}</div>
              <p className="text-[13px] leading-6 mt-0.5 mb-3" style={{ color: MUTED }}>{o.note}</p>
              {o.body}
            </div>
          ))}
          <div className="rounded-xl border p-4" style={{ borderColor: LINE, backgroundColor: SOL.base03 }}>
            <div className="text-[14px] font-semibold" style={{ color: SOL.base2 }}>Verbs for every agent</div>
            <pre className="mt-2 font-mono text-[12px] leading-[1.75] whitespace-pre-wrap" style={{ color: SOL.base1 }}>
              <span style={{ color: SOL.green }}>$ </span>cast obj create inc "Refund webhooks retry with no cap" --set severity=sev-3{"\n"}
              <span style={{ color: V }}>  created inc-8</span>{"\n"}
              <span style={{ color: SOL.green }}>$ </span>cast obj set inc-7 status=monitoring
            </pre>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 6. External kinds ───────────────────────────────────────────────────── */

const RESOLVE = `// "external": true in the manifest: nothing is stored in codecast.
on("object.resolve", { object: "cus" }, async ($, e) => {
  const r = await $.http.fetch(\`https://api.acme.dev/customers/\${e.id}\`,
    { secret: "acme_admin" });
  if (!r.ok) return null;
  const c = r.json;
  return {
    title: c.name,
    status: c.health,
    fields: { plan: c.plan, mrr: c.mrr, owner: c.owner },
  };
});`;

export function External() {
  return (
    <Section
      id="external"
      title="Show objects that live in another system"
      lede={<>Most of what your team talks about already lives somewhere: customers in your database, orders in your store, tickets in a support tool. An external kind stores nothing. Its ids carry the other system's id, and a small hook answers what each one is called and where it stands, live, every time it draws.</>}
      aside={<>One of our own mods maps nineteen kinds from a product we run (contacts, requests, matches, calls) through a connector. Agents working on that product write those ids in every reply.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] gap-6 items-start">
        <div>
          <Code file="billing / ui.tsx" code={RESOLVE} mark={[3, 4]} size={12} />
          <p className="mt-4 text-[14px] leading-6" style={{ color: MUTED }}>
            The API key stays on codecast's server. A request that names a secret is sent from there, only to the origins that secret allows, and no browser ever holds the key. A connected product can be read through <C>$.connector.read</C> instead, as the person who is looking.
          </p>
        </div>
        <div className="space-y-4">
          <AppFrame title="Billing retries · payments">
            <div className="p-4 text-[14px] leading-8" style={{ color: TEXT }}>
              Twelve charges failed for <Pill o={CUS_A} /> since the deploy and five for <Pill o={CUS_B} />. Both retried cleanly once the canary took over.
            </div>
            <div className="px-4 pb-4"><HoverCard o={CUS_B} className="w-full" /></div>
          </AppFrame>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["cus-3f9a21bc", "what the agent wrote"], ["1 call", "your API, per draw"], ["0 rows", "copied into codecast"]].map(([a, b]) => (
              <div key={b} className="rounded-lg border px-2 py-3" style={{ borderColor: LINE }}>
                <div className="font-mono text-[12.5px] font-semibold truncate" style={{ color: V }}>{a}</div>
                <div className="text-[11px] mt-1" style={{ color: MUTED }}>{b}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 7. Blocks ───────────────────────────────────────────────────────────── */

const FENCE = `on("ui.render", { fence: "rollout" }, async ($, e) => {
  const { service, build } = JSON.parse(e.props.code);
  const url = \`https://deploy.acme.dev/\${service}/\${build}\`;
  const r = await $.http.fetch(url, { secret: "deploy" });
  const d = r.json;
  return (
    <Card title={service}>
      <Grid columns={3}>
        <Stat label="traffic" value={\`\${d.canary}%\`} />
        <Stat label="errors" value={d.errors.canary} tone="green" />
        <Stat label="errors" value={d.errors.current} tone="red" />
      </Grid>
      <Sparkline values={d.errors.series} tone="red" />
      <Row gap={2}>
        <Button variant="primary" onPress={() => promote($, d, 50)}>
          Promote to 50%
        </Button>
        <Button onPress={() => rollback($, d)}>Roll back</Button>
      </Row>
    </Card>
  );
});`;

export function Blocks() {
  const [src, setSrc] = useState(false);
  return (
    <Section
      id="blocks"
      tone="grid"
      title="Blocks that draw live data and buttons"
      lede={<>A mod can claim a fenced block type. The agent writes a few fields; the mod draws them with live data, as stats, charts, tables and buttons, in every place markdown renders. With the mod off, the block shows as plain code.</>}
      aside={<>Mods draw with codecast's own elements: cards, tables, stats, sparklines, charts, tabs, pills. A block looks native in light and dark, in every theme, because a mod may only use the theme's colors.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-6 items-start">
        <div>
          <div className="flex items-center gap-1 mb-3 p-1 rounded-lg w-fit" style={{ backgroundColor: "rgba(238,232,213,.8)" }} role="tablist">
            {[["As you see it", false], ["As the agent wrote it", true]].map(([l, v]) => (
              <button key={l as string} role="tab" aria-selected={src === v} onClick={() => setSrc(v as boolean)} className="rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors" style={{ backgroundColor: src === v ? "#fffdf6" : "transparent", color: src === v ? TEXT : MUTED, boxShadow: src === v ? "0 1px 2px rgba(0,43,54,.12)" : undefined }}>
                {l as string}
              </button>
            ))}
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
            <p className="text-[14px] leading-7 mb-3" style={{ color: TEXT }}>Canary is out on the previous build:</p>
            {src ? (
              <pre className="rounded-md px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap" style={{ backgroundColor: "rgba(147,161,161,.14)", color: MUTED }}>{ROLLOUT_SOURCE}</pre>
            ) : (
              <RolloutBlock />
            )}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl border p-4" style={{ borderColor: LINE }}>
              <div className="font-mono text-[12px] font-semibold" style={{ color: SOL.cyan }}>cast-canvas</div>
              <p className="mt-1 text-[13px] leading-6" style={{ color: MUTED }}>Built in. A one-off drawing the agent writes as HTML for one reply. Static once sent.</p>
            </div>
            <div className="rounded-xl border p-4" style={{ borderColor: V, backgroundColor: tint(V, 5) }}>
              <div className="font-mono text-[12px] font-semibold" style={{ color: V }}>a mod's block</div>
              <p className="mt-1 text-[13px] leading-6" style={{ color: MUTED }}>Code that draws from live data, for everyone with the mod, every time the block appears.</p>
            </div>
          </div>
        </div>
        <Code file="releases / ui.tsx" code={FENCE} size={11.5} mark={[1, 2]} />
      </div>
    </Section>
  );
}

/* ── 8. Agents learn the noun ────────────────────────────────────────────── */

const GUIDE = `Incidents (inc-N): mention one by its short id and it
reads as a live reference. When you find a problem you
are not fixing in this session, file it with
cast obj create inc "<title>", or write a finding block
and let the person file it with one click.`;

export function Learn() {
  const [filed, setFiled] = useState(false);
  return (
    <Section
      id="agents-learn"
      dark
      title="Agents learn your kinds when the mod is installed"
      lede={<>A mod carries a short note for agents: what its objects are, which blocks it draws, when to reach for them. Every session the mod applies to starts with that note. So the incident an agent notices at the end of a long task gets filed as <C dark>inc-8</C> instead of being mentioned once and forgotten.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-6 items-start">
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: "#0b4a5a", backgroundColor: SOL.base02 }}>
          <div className="h-9 px-4 flex items-center border-b font-mono text-[11.5px]" style={{ borderColor: "#0b4a5a", color: SOL.base01 }}>incident-desk / AGENTS.md</div>
          <pre className="p-4 font-mono text-[12.5px] leading-[1.8] whitespace-pre-wrap" style={{ color: SOL.base1 }}>{GUIDE}</pre>
          <div className="px-4 pb-4 text-[12px] leading-5" style={{ color: SOL.base01 }}>Every session the mod applies to starts with this note.</div>
        </div>
        <div>
          <AppFrame title="Retry webhook deliveries · api" style={{ backgroundColor: SOL.base3 }}>
            <div className="p-4 space-y-3 text-[14px] leading-7" style={{ color: TEXT }}>
              <p>The payments worker now backs off with jitter and caps at five tries. While tracing it I found the same pattern somewhere I am not touching:</p>
              <FindingBlock
                filed={filed ? (
                  <span className="md-pop inline-flex items-center gap-1.5 text-[12px]"><span style={{ color: MUTED }}>Filed as</span><Pill o={INC8} /></span>
                ) : (
                  <button onClick={() => setFiled(true)} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium" style={{ backgroundColor: V, color: SOL.base3 }}>
                    <Plus className="w-3 h-3" />File incident
                  </button>
                )}
              />
            </div>
          </AppFrame>
          {filed && (
            <div className="md-pop mt-3 flex items-center gap-2 text-[12.5px]" style={{ color: SOL.base1 }}>
              <Flame className="w-3.5 h-3.5" style={{ color: V }} /><span>Now on the board in <b style={{ color: SOL.base2, fontWeight: 600 }}>triage</b>.</span>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

