"use client";
/**
 * Team settings > Read-only keys (admins only): a key a server uses to read
 * what every member sees of the team's sessions, as metadata, from
 * GET /cli/v1/team/sessions (convex/teamReadKeys.ts).
 *
 * Both writes call their mutations directly. Minting answers with a secret
 * shown once, which must not ride the dispatch outbox into IndexedDB. A key
 * keeps working until the server has revoked it, so its row says Revoking
 * until the server's list says Revoked, and a refusal says why.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  MAX_LIVE_TEAM_READ_KEYS,
  TEAM_READ_KEY_EXPIRY_DAYS,
  type TeamReadKeyExpiryDays,
} from "@codecast/convex/convex/lib/teamReadKey";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./ui";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useCopy } from "../../hooks/useCopy";
import { relativeTime } from "../../lib/entityDisplay";
import { CONVEX_URL } from "../../lib/convexUrl";
import { ConsequentialSwitch, type SwitchLedger } from "../consequential/ConsequentialSwitch";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIFETIME: Record<TeamReadKeyExpiryDays, string> = { 30: "30 days", 90: "90 days", 365: "1 year" };
const DEFAULT_LIFETIME: TeamReadKeyExpiryDays = 90;
/** The count shows once this many keys are live, so the limit never comes as a surprise. */
const SHOW_COUNT_FROM = MAX_LIVE_TEAM_READ_KEYS - 2;
/** Revoked and expired keys shown before the rest fold away, most recently ended first. */
const ENDED_SHOWN = 3;
/** The focus ring components/ui/button.tsx draws, for the plain text buttons here. */
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/60 modern:focus-visible:outline-[color:var(--focus-ring)]";

type KeyRow = NonNullable<FunctionReturnType<typeof api.teamReadKeys.list>>[number];

/** The server's own words for a refusal it means a person to read, else the fallback. */
const refusal = (e: unknown, fallback: string) => (e instanceof ConvexError && typeof e.data === "string" ? e.data : fallback);
type Minted = { key_id: string; key: string; name: string };

function keyLedger(name: string, team: string, days: TeamReadKeyExpiryDays): SwitchLedger {
  return {
    name: "New read-only key",
    subject: `${name || "Read key"} · ${team}`,
    shift: null,
    figures: [{ value: "Read only", label: "no messages or prompts" }],
    rows: [
      { k: "Reads", v: "Titles, summaries, branches", tone: "warn" },
      { k: "Of", v: "Sessions shared with the team" },
      { k: "Each use", v: "Recorded in the team audit log (cast audit)" },
      { k: "Key shown", v: "Once" },
    ],
    pick: { k: "Expires in", options: TEAM_READ_KEY_EXPIRY_DAYS.map((d) => LIFETIME[d]), value: LIFETIME[days] },
    stop: "Revoke the key",
    confirm: "Create key",
    keep: "Not now",
  };
}

export function TeamReadKeys({ teamId, teamName }: { teamId: Id<"teams">; teamName: string }) {
  const keys = useSettingsData("teamReadKeys", String(teamId)).data;
  const [minted, setMinted] = useState<Minted | null>(null);
  const [allEnded, setAllEnded] = useState(false);
  const now = Date.now();
  const isLive = (k: KeyRow) => !k.revoked_at && k.expires_at > now;
  const live = (keys ?? []).filter(isLive).length;
  const ended = (keys ?? []).filter((k) => !isLive(k)).sort((a, b) => (b.revoked_at ?? b.expires_at) - (a.revoked_at ?? a.expires_at));
  const folded = new Set(allEnded ? [] : ended.slice(ENDED_SHOWN).map((k) => String(k._id)));
  return (
    <SettingsSection
      title="Read-only keys"
      icon={KeyRound}
      description="Lets a server list the team's shared sessions, without their messages."
      actions={live >= SHOW_COUNT_FROM ? <span className="tabular-nums text-xs text-sol-text-dim">{live} of {MAX_LIVE_TEAM_READ_KEYS} active</span> : undefined}
    >
      {minted ? (
        <MintedKey minted={minted} onHide={() => setMinted(null)} />
      ) : (
        <NewKey teamId={teamId} teamName={teamName} full={live >= MAX_LIVE_TEAM_READ_KEYS} onMinted={setMinted} />
      )}
      {(keys ?? []).filter((k) => String(k._id) !== minted?.key_id && !folded.has(String(k._id))).map((k) => (
        <KeyLine key={k._id} teamId={teamId} row={k} now={now} />
      ))}
      {folded.size > 0 && (
        <button type="button" className={`w-full px-4 py-2.5 text-left text-xs text-sol-text-dim hover:text-sol-text focus-visible:-outline-offset-2 sm:px-5 ${FOCUS_RING}`} onClick={() => setAllEnded(true)} data-read-key-more>
          Show {folded.size} more revoked or expired {folded.size === 1 ? "key" : "keys"}
        </button>
      )}
    </SettingsSection>
  );
}

/** Name a key and create it through the review, which also picks its lifetime. */
function NewKey({ teamId, teamName, full, onMinted }: { teamId: Id<"teams">; teamName: string; full: boolean; onMinted: (m: Minted) => void }) {
  const create = useMutation(api.teamReadKeys.create);
  const [name, setName] = useState("");
  const [days, setDays] = useState<TeamReadKeyExpiryDays>(DEFAULT_LIFETIME);
  const [creating, setCreating] = useState(false);
  const mint = async () => {
    setCreating(true);
    try {
      const res = await create({ team_id: teamId, name: name.trim(), expires_in_days: days });
      onMinted({ key_id: String(res.key_id), key: res.key, name: res.name });
      setName("");
      setDays(DEFAULT_LIFETIME);
    } catch (e) {
      toast.error(refusal(e, "Couldn't create the key"));
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className="px-4 py-3 sm:px-5" data-read-key-new>
      <div className="flex items-center gap-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. Status board"
          className="h-7 min-w-0 flex-1 text-xs"
          aria-label="Key name"
          maxLength={80}
          disabled={creating}
        />
        <ConsequentialSwitch
          on={false}
          ledger={keyLedger(name.trim(), teamName, days)}
          onPick={(option) => setDays(TEAM_READ_KEY_EXPIRY_DAYS.find((d) => LIFETIME[d] === option) ?? DEFAULT_LIFETIME)}
          onTurnOn={() => void mint()}
          onTurnOff={() => {}}
          trigger={({ press, reviewing }) => (
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={press} disabled={full || creating} aria-haspopup="dialog" aria-expanded={reviewing} data-read-key-create>
              {creating ? "Creating…" : "Create"}
            </Button>
          )}
        />
      </div>
      {full && (
        <p className="mt-1.5 text-xs text-sol-text-muted" data-read-key-full>
          {MAX_LIVE_TEAM_READ_KEYS} keys are active. Revoke one to make another.
        </p>
      )}
    </div>
  );
}

/** The new key, shown this one time. Out of both session recorders: codecast's (data-private) and PostHog's (ph-no-capture). */
export function MintedKey({ minted, onHide }: { minted: Minted; onHide: () => void }) {
  const key = useCopy();
  const curl = useCopy();
  return (
    <div className="ph-no-capture flex flex-col gap-2 px-4 py-3 sm:px-5" data-private data-read-key-minted>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 break-words text-sm text-sol-text">{minted.name}</span>
        <span className="text-xs text-sol-orange">Copy it now. It won't be shown again.</span>
      </div>
      <code className="block select-all break-all rounded-md bg-sol-bg-highlight/40 px-2 py-1.5 font-mono text-xs leading-4 text-sol-text">{minted.key}</code>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="cyan" size="sm" onClick={() => key.copy(() => minted.key)}><CopyLabel state={key.state} label="Copy key" /></Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => curl.copy(() => `curl -H "Authorization: Bearer ${minted.key}" ${CONVEX_URL}/cli/v1/team/sessions`)}
        >
          <CopyLabel state={curl.state} label="Copy curl command" />
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="-mr-2.5 text-sol-text-dim" onClick={onHide}>Hide key</Button>
      </div>
    </div>
  );
}

/** A copy button's label, as wide as its widest wording, so the button keeps its size when it says Copied or Copy failed. */
function CopyLabel({ state, label }: { state: "idle" | "copied" | "failed"; label: string }) {
  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <span className="grid justify-items-center">
      {[label, "Copied", "Copy failed"].map((text) => (
        <span key={text} className={`col-start-1 row-start-1 ${text === shown ? "" : "invisible"}`} aria-hidden={text !== shown || undefined}>
          {text}
        </span>
      ))}
    </span>
  );
}

function KeyLine({ teamId, row, now }: { teamId: Id<"teams">; row: KeyRow; now: number }) {
  const revoke = useMutation(api.teamReadKeys.revoke);
  const [step, setStep] = useState<"idle" | "confirm" | "revoking">("idle");
  const ended = row.revoked_at ? "Revoked" : row.expires_at <= now ? "Expired" : null;
  const daysLeft = Math.ceil((row.expires_at - now) / DAY_MS);
  const details = [
    `${row.prefix}…`,
    row.created_by_name,
    row.last_used_at ? `Used ${relativeTime(row.last_used_at)}` : "Not used yet",
    ended ? null : daysLeft === 1 ? "1 day left" : `${daysLeft} days left`,
  ].filter((d): d is string => !!d);
  const confirm = async () => {
    setStep("revoking");
    try {
      await revoke({ team_id: teamId, key_id: row._id });
    } catch (e) {
      setStep("idle");
      toast.error(refusal(e, "Couldn't revoke the key"));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5" data-read-key={ended ?? (step === "revoking" ? "revoking" : "live")}>
      <div className="min-w-0 flex-1">
        <div className={`break-words text-sm ${ended ? "text-sol-text-dim" : "text-sol-text"}`}>{row.name}</div>
        <div className={`flex flex-wrap text-xs ${ended ? "text-sol-text-muted" : "text-sol-text-dim"}`}>
          {details.map((d, i) => (
            <span key={i} className={`whitespace-nowrap ${i === 0 ? "font-mono" : ""}`}>{i > 0 && <span aria-hidden className="mx-1">·</span>}{d}</span>
          ))}
        </div>
      </div>
      {ended || step === "revoking" ? (
        <span className="shrink-0 text-xs text-sol-text-muted">{ended ?? "Revoking…"}</span>
      ) : step === "confirm" ? (
        // On a phone the confirm takes its own line under the key, with full-size targets.
        <div className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 sm:w-auto" data-read-key-confirm>
          <span className="w-full text-right text-xs text-sol-text-muted sm:w-auto">Anything using this key loses access now.</span>
          <div className="flex gap-2">
            <Button variant="red" size="sm" className="min-h-11 px-4 sm:min-h-0 sm:px-2.5" onClick={() => void confirm()}>Revoke</Button>
            <Button variant="ghost" size="sm" className="min-h-11 px-4 sm:min-h-0 sm:px-2.5" onClick={() => setStep("idle")}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button type="button" className={`-my-2 shrink-0 rounded-sm py-2 text-meta text-sol-text-dim hover:text-sol-red focus-visible:outline-offset-2 ${FOCUS_RING}`} onClick={() => setStep("confirm")}>
          Revoke
        </button>
      )}
    </div>
  );
}
