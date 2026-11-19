"use client";
/**
 * Team settings > Read-only keys (admins only): a key a server uses to read
 * what every member sees of the team's sessions, as metadata, from
 * GET /cli/v1/team/sessions (convex/teamReadKeys.ts).
 *
 * Revoking is a store action that paints at once. Minting calls its mutation
 * directly instead: the answer is a secret shown once, which must not ride the
 * dispatch outbox into IndexedDB.
 */
import { useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
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
import { useInboxStore } from "../../store/inboxStore";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useCopy } from "../../hooks/useCopy";
import { relativeTime } from "../../lib/entityDisplay";
import { CONVEX_URL } from "../../lib/convexUrl";
import { ConfirmButton } from "../integrations/parts";
import { ConsequentialSwitch, type SwitchLedger } from "../consequential/ConsequentialSwitch";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIFETIME: Record<TeamReadKeyExpiryDays, string> = { 30: "30 days", 90: "90 days", 365: "1 year" };
const DEFAULT_LIFETIME: TeamReadKeyExpiryDays = 90;
/** The count shows once this many keys are live, so the limit never comes as a surprise. */
const SHOW_COUNT_FROM = MAX_LIVE_TEAM_READ_KEYS - 2;

type KeyRow = NonNullable<FunctionReturnType<typeof api.teamReadKeys.list>>[number];

/** The server's own words for a refusal it means a person to read, else the fallback. */
const refusal = (e: unknown, fallback: string) => (e instanceof ConvexError && typeof e.data === "string" ? e.data : fallback);
type Minted = { key_id: string; key: string; name: string };

function keyLedger(name: string, team: string, days: TeamReadKeyExpiryDays): SwitchLedger {
  return {
    name: "New read-only key",
    subject: `${team} · ${name || "Read-only key"}`,
    shift: null,
    figures: [{ value: "Anyone", label: "with the key reads the team's shared sessions", tone: "warn" }],
    rows: [
      { k: "Reads", v: "Titles, summaries, repos, branches, owners", tone: "warn" },
      { k: "Sessions", v: "Shared with the team" },
      { k: "Use logged", v: "Once an hour, in cast audit" },
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
  const nameField = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const isLive = (k: KeyRow) => !k.revoked_at && k.expires_at > now;
  const live = (keys ?? []).filter(isLive).length;
  const listed = (keys ?? []).filter((k) => String(k._id) !== minted?.key_id);
  const ended = listed.filter((k) => !isLive(k));
  return (
    <SettingsSection
      title="Read-only keys"
      icon={KeyRound}
      description="A read-only key lets a server list the team's shared sessions, without their messages."
      actions={live >= SHOW_COUNT_FROM ? <span className="tabular-nums text-xs text-sol-text-dim">{live} of {MAX_LIVE_TEAM_READ_KEYS} active</span> : undefined}
    >
      {minted ? (
        <MintedKey
          minted={minted}
          onDone={() => {
            flushSync(() => setMinted(null));
            nameField.current?.focus();
          }}
        />
      ) : (
        <NewKey teamId={teamId} teamName={teamName} nameField={nameField} loading={!keys} full={live >= MAX_LIVE_TEAM_READ_KEYS} onMinted={setMinted} />
      )}
      {!keys && <div aria-hidden className="h-[57px] animate-pulse bg-sol-bg-highlight/30" data-read-key-loading />}
      {listed.filter(isLive).map((k) => (
        <KeyLine key={k._id} teamId={teamId} row={k} now={now} />
      ))}
      {ended.length > 0 && (
        <details className="divide-y divide-sol-border/40 modern:divide-sol-border/70" data-read-key-ended>
          <summary className="cursor-pointer select-none px-4 py-2.5 text-xs text-sol-text-dim hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/60 sm:px-5">
            {ended.length} ended {ended.length === 1 ? "key" : "keys"}
          </summary>
          {ended.map((k) => (
            <KeyLine key={k._id} teamId={teamId} row={k} now={now} />
          ))}
        </details>
      )}
    </SettingsSection>
  );
}

/** Name a key and create it through the review, which also picks its lifetime. */
function NewKey({ teamId, teamName, nameField, loading, full, onMinted }: {
  teamId: Id<"teams">;
  teamName: string;
  nameField: Ref<HTMLInputElement>;
  /** The team's keys have not arrived, so the limit is not known yet. */
  loading: boolean;
  full: boolean;
  onMinted: (m: Minted) => void;
}) {
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
          ref={nameField}
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
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={press} disabled={loading || full || creating} aria-haspopup="dialog" aria-expanded={reviewing} data-read-key-create>
              <span className="grid justify-items-center">
                <span aria-hidden className="invisible col-start-1 row-start-1">Creating…</span>
                <span className="col-start-1 row-start-1">{creating ? "Creating…" : "Create"}</span>
              </span>
            </Button>
          )}
        />
      </div>
      {full && (
        <p className="mt-1.5 text-xs text-sol-text-muted" data-read-key-full>
          A team can have {MAX_LIVE_TEAM_READ_KEYS} active keys. Revoke one to create another.
        </p>
      )}
    </div>
  );
}

/** The new key, shown this one time. Out of both session recorders: codecast's (data-private) and PostHog's (ph-no-capture). */
function MintedKey({ minted, onDone }: { minted: Minted; onDone: () => void }) {
  const key = useCopy();
  const curl = useCopy();
  return (
    <div className="ph-no-capture flex flex-col gap-2 px-4 py-3 sm:px-5" data-private data-read-key-minted>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 break-words text-sm text-sol-text">{minted.name}</span>
        <span className="text-xs text-sol-orange">Copy it now. It won't be shown again.</span>
      </div>
      <code className="block select-all break-all rounded-md border border-sol-border/70 bg-sol-bg-highlight/40 px-2 py-1.5 font-mono text-xs leading-4 text-sol-text">{minted.key}</code>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="cyan" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => key.copy(() => minted.key)}>
          <span className="grid justify-items-center">
            <span aria-hidden className="invisible col-start-1 row-start-1">Copy failed</span>
            <span className="col-start-1 row-start-1">{key.state === "copied" ? "Copied" : key.state === "failed" ? "Copy failed" : "Copy key"}</span>
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="[@media(pointer:coarse)]:min-h-11"
          onClick={() => curl.copy(() => `curl -H "Authorization: Bearer ${minted.key}" ${CONVEX_URL}/cli/v1/team/sessions`)}
        >
          <span className="grid justify-items-center">
            <span aria-hidden className="invisible col-start-1 row-start-1">Copy curl command</span>
            <span className="col-start-1 row-start-1">{curl.state === "copied" ? "Copied" : curl.state === "failed" ? "Copy failed" : "Copy curl command"}</span>
          </span>
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="-mr-2.5 text-sol-text-dim" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function KeyLine({ teamId, row, now }: { teamId: Id<"teams">; row: KeyRow; now: number }) {
  const ended = row.revoked_at ? "Revoked" : row.expires_at <= now ? "Expired" : null;
  const daysLeft = Math.ceil((row.expires_at - now) / DAY_MS);
  const details = [
    `${row.prefix}…`,
    row.created_by_name && `by ${row.created_by_name}`,
    row.last_used_at ? `Used ${relativeTime(row.last_used_at)}` : ended ? "Never used" : "Not used yet",
    ended ? null : daysLeft === 1 ? "1 day left" : `${daysLeft} days left`,
  ].filter((d): d is string => !!d);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5" data-read-key={ended ?? "live"}>
      <div className="row-start-1 min-w-0">
        <div className={`break-words text-sm ${ended ? "text-sol-text-dim" : "text-sol-text"}`}>{row.name}</div>
        {/* Every item has a leading dot; the one that starts a line is clipped. */}
        <div className="overflow-hidden text-xs text-sol-text-dim">
          <div className="-ml-3 flex flex-wrap">
            {details.map((d, i) => (
              <span key={i} className={`relative whitespace-nowrap pl-3 before:absolute before:left-1 before:content-['·'] ${i === 0 ? "font-mono" : ""}`}>{d}</span>
            ))}
          </div>
        </div>
      </div>
      {ended ? (
        <span className="text-xs text-sol-text-dim">{ended}</span>
      ) : (
        <>
          {/* Holds the Revoke column, so on a phone the name keeps its width while the confirm opens on the line below. */}
          <span aria-hidden className="invisible col-start-2 row-start-1 text-meta">Revoke</span>
          <div className="col-start-2 row-start-1 flex items-center justify-end max-sm:has-[[data-armed]]:row-start-2 max-sm:has-[[data-armed]]:[grid-column:1/-1]">
            <ConfirmButton
              label="Revoke"
              question="Anything using this key loses access now."
              className="text-sol-text-dim hover:text-sol-red hover:no-underline"
              onConfirm={() => useInboxStore.getState().revokeTeamReadKey(String(teamId), String(row._id))}
            />
          </div>
        </>
      )}
    </div>
  );
}
