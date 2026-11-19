"use client";
/**
 * Team settings > Read keys (admins only): a key a server uses to read what
 * every member sees of the team's sessions, as metadata, from
 * GET /cli/v1/team/sessions (convex/teamReadKeys.ts).
 *
 * Revoking is a store action that paints at once. Minting calls its mutation
 * directly instead: the answer is a secret shown once, which must not ride the
 * dispatch outbox into IndexedDB.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
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

type KeyRow = NonNullable<FunctionReturnType<typeof api.teamReadKeys.list>>[number];

function keyLedger(team: string, days: TeamReadKeyExpiryDays): SwitchLedger {
  return {
    name: "New read key",
    subject: team,
    shift: null,
    figures: [
      { value: LIFETIME[days], label: "until it expires" },
      { value: "Once", label: "the key is shown" },
    ],
    rows: [
      { k: "Reads", v: "Titles, summaries, branches", tone: "warn" },
      { k: "Of", v: "Sessions shared with the team" },
      { k: "Never", v: "Messages, prompts, file paths" },
      { k: "Each use", v: "Logged in cast audit" },
    ],
    pick: { k: "Expires in", options: TEAM_READ_KEY_EXPIRY_DAYS.map((d) => LIFETIME[d]), value: LIFETIME[days] },
    stop: "Revoke the key",
    confirm: "Create key",
    keep: "Not now",
  };
}

export function TeamReadKeys({ teamId, teamName }: { teamId: Id<"teams">; teamName: string }) {
  const keys = useSettingsData("teamReadKeys", String(teamId)).data;
  const now = Date.now();
  const live = (keys ?? []).filter((k) => !k.revoked_at && k.expires_at > now).length;
  return (
    <SettingsSection
      title="Read keys"
      icon={KeyRound}
      description="For a server that reads the team's shared sessions: titles, summaries and branches, never messages."
      actions={keys ? <span className="tabular-nums text-xs text-sol-text-dim">{live} of {MAX_LIVE_TEAM_READ_KEYS}</span> : undefined}
    >
      <NewKey teamId={teamId} teamName={teamName} full={live >= MAX_LIVE_TEAM_READ_KEYS} />
      {(keys ?? []).map((k) => <KeyLine key={k._id} teamId={teamId} row={k} now={now} />)}
    </SettingsSection>
  );
}

/** Name a key and create it through the review; the key itself is shown here once. */
function NewKey({ teamId, teamName, full }: { teamId: Id<"teams">; teamName: string; full: boolean }) {
  const create = useMutation(api.teamReadKeys.create);
  const [name, setName] = useState("");
  const [days, setDays] = useState<TeamReadKeyExpiryDays>(DEFAULT_LIFETIME);
  const [minted, setMinted] = useState<{ key: string; name: string } | null>(null);
  const mint = async () => {
    try {
      const res = await create({ team_id: teamId, name: name.trim(), expires_in_days: days });
      setMinted({ key: res.key, name: res.name });
      setName("");
      setDays(DEFAULT_LIFETIME);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the key");
    }
  };
  if (minted) return <MintedKey minted={minted} onDone={() => setMinted(null)} />;
  return (
    <div className="flex items-center gap-2 px-4 py-3 sm:px-5" data-read-key-new>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Server name"
        className="h-8 min-w-0 flex-1 text-xs"
        aria-label="Read key name"
        maxLength={80}
      />
      <ConsequentialSwitch
        on={false}
        ledger={keyLedger(teamName, days)}
        onPick={(option) => setDays(TEAM_READ_KEY_EXPIRY_DAYS.find((d) => LIFETIME[d] === option) ?? DEFAULT_LIFETIME)}
        onTurnOn={() => void mint()}
        onTurnOff={() => {}}
        trigger={({ press, reviewing }) => (
          <Button
            variant="cyan"
            size="sm"
            onClick={press}
            disabled={full}
            title={full ? `${MAX_LIVE_TEAM_READ_KEYS} keys are active. Revoke one to make another.` : undefined}
            aria-haspopup="dialog"
            aria-expanded={reviewing}
            data-read-key-create
          >
            Create
          </Button>
        )}
      />
    </div>
  );
}

function MintedKey({ minted, onDone }: { minted: { key: string; name: string }; onDone: () => void }) {
  const key = useCopy();
  const curl = useCopy();
  const said = (state: "idle" | "copied" | "failed", label: string) => (state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:px-5" data-read-key-minted>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm text-sol-text">{minted.name}</span>
        <span className="shrink-0 text-xs text-sol-orange">Shown once</span>
      </div>
      <code className="block truncate rounded-md bg-sol-bg-highlight/40 px-2 py-1.5 font-mono text-xs text-sol-text" title={minted.key}>
        {minted.key}
      </code>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="cyan" size="sm" onClick={() => key.copy(() => minted.key)}>{said(key.state, "Copy key")}</Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => curl.copy(() => `curl -H "Authorization: Bearer ${minted.key}" ${CONVEX_URL}/cli/v1/team/sessions`)}
        >
          {said(curl.state, "Copy curl")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="text-sol-text-dim" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function KeyLine({ teamId, row, now }: { teamId: Id<"teams">; row: KeyRow; now: number }) {
  const ended = row.revoked_at ? "Revoked" : row.expires_at <= now ? "Expired" : null;
  const daysLeft = Math.ceil((row.expires_at - now) / DAY_MS);
  return (
    // Wraps on a narrow screen, so an armed Revoke drops below the name instead of squeezing it.
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5 ${ended ? "opacity-50" : ""}`} data-read-key={ended ?? "live"}>
      <div className="min-w-40 flex-1">
        <div className="truncate text-sm text-sol-text">{row.name}</div>
        <div className="flex flex-wrap gap-x-3 text-xs text-sol-text-dim">
          <span className="font-mono">{row.prefix}…</span>
          {row.created_by_name && <span className="truncate">{row.created_by_name}</span>}
          <span>{row.last_used_at ? `used ${relativeTime(row.last_used_at)}` : "never used"}</span>
          {!ended && <span>{daysLeft === 1 ? "1 day left" : `${daysLeft} days left`}</span>}
        </div>
      </div>
      <div className="ml-auto shrink-0">
        {ended ? (
          <span className="text-xs text-sol-text-dim">{ended}</span>
        ) : (
          <ConfirmButton
            label="Revoke"
            question="Its server loses access at once."
            className="text-sol-text-dim hover:text-sol-red hover:no-underline"
            onConfirm={() => useInboxStore.getState().revokeTeamReadKey(String(teamId), String(row._id))}
          />
        )}
      </div>
    </div>
  );
}
