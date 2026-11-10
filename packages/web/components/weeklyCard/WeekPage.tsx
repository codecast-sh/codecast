"use client";
// /week: the person's week with coding agents, and the one press that shares
// it. Pick a week, look at the card, choose what it shows, publish through the
// shared review, then post it. The card rows live in the store (weeklyCards,
// fed by weeklyCards.listMine); building one is a server action whose row then
// syncs in, and every edit after that is a store action.
import { useState } from "react";
import { useAction } from "convex/react";
import { Check, Link2, RefreshCw, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { sharePath } from "@codecast/shared/entities";
import { localTimeZone } from "@codecast/shared/time";
import { weekBounds, weekRangeLabel, weeklyCardAllowed, type WeekCardStats, type WeekWhich } from "@codecast/shared/contracts/weeklyCard";
import { useSearchParams } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncWeeklyCards } from "../../hooks/useSyncWeeklyCards";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useCopy } from "../../hooks/useCopy";
import { shareOrigin } from "../../lib/utils";
import { track } from "../../lib/analytics";
import { Switch } from "../ui/switch";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { WeekCardFrame } from "./WeekCardFrame";
import { weekCardLedger } from "./weekCardLedger";
import { Button } from "../ui/button";

type CardRow = {
  _id: string;
  week_key: string;
  stats: WeekCardStats;
  generated_at: number;
  show_projects?: boolean;
  show_tokens?: boolean;
  share_token?: string;
};

const cardSig = (c: CardRow) => `${c._id}:${c.generated_at}:${c.share_token ?? ""}:${c.show_projects ? 1 : 0}${c.show_tokens ? 1 : 0}`;

export default function WeekPage() {
  const { user } = useCurrentUser();
  if (user === undefined) return null;
  if (!weeklyCardAllowed(user)) {
    return <div className="flex h-full items-center justify-center text-sm text-sol-text-dim">Not available yet</div>;
  }
  return <Week name={user?.name ?? null} enabled={!!(user as any)?.weekly_card_enabled} />;
}

function Week({ name, enabled }: { name: string | null; enabled: boolean }) {
  useSyncWeeklyCards();
  const params = useSearchParams();
  const tz = localTimeZone();
  const keys = { last: weekBounds(Date.now(), tz, "last").key, current: weekBounds(Date.now(), tz, "current").key };
  const asked = params.get("w");
  const [which, setWhich] = useState<WeekWhich>(asked === keys.current ? "current" : "last");
  const cards = useCollectionRows<CardRow>("weeklyCards", { sig: cardSig });
  const card = cards.find((c) => c.week_key === keys[which]);

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-6 py-8" data-week-page>
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-[20px] font-semibold text-sol-text">Your week</h1>
        <div className="inline-flex rounded-lg border border-sol-border p-0.5 text-[13px]" role="tablist">
          {(["last", "current"] as const).map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={which === w}
              onClick={() => setWhich(w)}
              className="rounded-md px-3 py-1 text-sol-text-muted aria-selected:bg-sol-bg-alt aria-selected:text-sol-text"
            >
              {w === "last" ? "Last week" : "This week"}
            </button>
          ))}
        </div>
        {card && <span className="text-[13px] tabular-nums text-sol-text-dim">{weekRangeLabel(card.stats)}</span>}
        <label className="ml-auto inline-flex items-center gap-2 text-[13px] text-sol-text-muted">
          Every Monday
          <Switch checked={enabled} onCheckedChange={(on) => useInboxStore.getState().setWeeklyCardEnabled(on)} aria-label="Build my card every Monday" />
        </label>
      </header>

      {card ? <CardPanel key={card._id} card={card} name={name} which={which} /> : <Building key={keys[which]} which={which} tz={tz} />}
    </div>
  );
}

function useBuild(which: WeekWhich, tz: string) {
  const generate = useAction(api.weeklyCards.generate);
  const [state, setState] = useState<"idle" | "building" | "failed">("idle");
  const build = () => {
    setState("building");
    generate({ which, tz }).then(() => setState("idle"), () => setState("failed"));
  };
  return { state, build };
}

/** No card for this week yet: build it now. */
function Building({ which, tz }: { which: WeekWhich; tz: string }) {
  const { state, build } = useBuild(which, tz);
  useMountEffect(build);
  return (
    <div className="flex aspect-[1200/630] w-full items-center justify-center rounded-xl border border-dashed border-sol-border text-sm text-sol-text-dim" data-week-building>
      {state === "failed" ? (
        <button type="button" onClick={build} className="text-sol-blue hover:underline">Could not build the card. Try again</button>
      ) : (
        <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Counting your week</span>
      )}
    </div>
  );
}

function CardPanel({ card, name, which }: { card: CardRow; name: string | null; which: WeekWhich }) {
  const { state, build } = useBuild(which, card.stats.tz);
  const published = !!card.share_token;
  const opts = { show_projects: !!card.show_projects, show_tokens: !!card.show_tokens };
  const shown: WeekCardStats = { ...card.stats, projects: opts.show_projects ? card.stats.projects : [], tokens: opts.show_tokens ? card.stats.tokens : null };
  const setOpt = (patch: Partial<typeof opts>) => useInboxStore.getState().setWeeklyCardOptions(card._id, patch);
  const publish = () => {
    useInboxStore.getState().setObjectShareLink("card", card._id, crypto.randomUUID());
    track("weekly_card_published", opts);
  };
  const unpublish = () => useInboxStore.getState().setObjectShareLink("card", card._id, null);

  return (
    <>
      <WeekCardFrame stats={shown} name={name} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]">
        <Toggle label="Projects" on={opts.show_projects} disabled={published || card.stats.projects.length === 0} onChange={(v) => setOpt({ show_projects: v })} />
        <Toggle label="Tokens" on={opts.show_tokens} disabled={published || card.stats.tokens === null} onChange={(v) => setOpt({ show_tokens: v })} />
        <button
          type="button"
          onClick={build}
          disabled={published || state === "building"}
          className="inline-flex items-center gap-1.5 text-sol-text-muted hover:text-sol-text disabled:opacity-40"
          title={published ? "Unpublish to rebuild" : "Count again"}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state === "building" ? "animate-spin" : ""}`} />
          Recount
        </button>
        <div className="ml-auto flex items-center gap-2">
          <ConsequentialSwitch
            on={published}
            ledger={weekCardLedger(card.stats, opts)}
            onTurnOn={publish}
            onTurnOff={unpublish}
            trigger={({ on, press }) =>
              on ? (
                <Button type="button" variant="outline" size="sm" onClick={press} data-week-unpublish>
                  Unpublish
                </Button>
              ) : (
                <Button type="button" variant="cyan" size="sm" onClick={press} data-week-share>
                  Share
                </Button>
              )
            }
          />
        </div>
      </div>
      {published && <ShareRow token={card.share_token!} stats={shown} />}
    </>
  );
}

function Toggle({ label, on, disabled, onChange }: { label: string; on: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? "text-sol-text-dim" : "text-sol-text-muted"}`}>
      <Switch checked={on} onCheckedChange={onChange} disabled={disabled} aria-label={`Show ${label.toLowerCase()}`} />
      {label}
    </label>
  );
}

function shareText(s: WeekCardStats): string {
  const agents = s.agents.slice(0, 3).map((a) => a.name).join(", ");
  return `My week with coding agents: ${s.sessions} sessions, ${s.agent_hours}h with agents working${agents ? ` (${agents})` : ""}`;
}

const TARGETS = [
  { id: "x", label: "Post to X", href: (url: string, text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` },
  { id: "bluesky", label: "Bluesky", href: (url: string, text: string) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text} ${url}`)}` },
  { id: "reddit", label: "Reddit", href: (url: string, text: string) => `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}` },
] as const;

function ShareRow({ token, stats }: { token: string; stats: WeekCardStats }) {
  const url = `${shareOrigin()}${sharePath("card", token)}`;
  const text = shareText(stats);
  // The shared copy hook says Copied only when the clipboard took it, and Copy failed when it refused.
  const { state: copyState, copy } = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sol-border bg-sol-bg-alt/40 p-2 text-[13px]" data-week-share-row>
      <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate px-2 text-sol-blue hover:underline">{url}</a>
      <button
        type="button"
        onClick={() => {
          void copy(() => url);
          track("weekly_card_share_pressed", { target: "copy" });
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sol-border px-3 text-sol-text hover:bg-sol-bg-alt"
      >
        {copyState === "copied" ? <Check className="h-3.5 w-3.5 text-sol-green" /> : copyState === "failed" ? <X className="h-3.5 w-3.5 text-sol-red" /> : <Link2 className="h-3.5 w-3.5" />}
        <span aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy link"}</span>
      </button>
      {TARGETS.map((t) => (
        <a
          key={t.id}
          href={t.href(url, text)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track("weekly_card_share_pressed", { target: t.id })}
          className="inline-flex h-8 items-center rounded-md border border-sol-border px-3 text-sol-text hover:bg-sol-bg-alt"
          data-week-target={t.id}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}
