"use client";
// Saving a site's sign-in (docs/architecture/vault.md "Saved sign-ins"), the
// two ways a person can: from their own Chrome on one of their online laptops
// (secrets.requestSigninCapture queues `vault_capture_signin` there; the
// laptop reads the cookies and stores them itself, after a check that Chrome
// holds them), or through the agent browser, which is a command to run. The web never holds a cookie: it sends a
// site and a name, and reads back the command's outcome, a count and an
// account name or the reason it failed.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { Check, ChevronDown, ExternalLink, Laptop, Loader2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { SECRET_NAME_RE, keepsOwnLogin, signinName, signinSite, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDevices, type Device } from "../DeviceBadge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyCap";
import { ScopePicker, type VaultScope } from "./AddSecretDialog";
import { CommandDisclosure, KindGlyph, Row } from "./parts";
import { FIELD_MONO, VAULT_DIALOG } from "../../lib/secretLook";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui/button";
import { shareSigninLedger, shareSigninsLedger } from "../../lib/secretLedgers";
import { vaultFailure } from "./vaultModel";
import { useSampleVault, type SampleVault } from "./sampleVault";
import { modernButton } from "../ui/modernLook";
import { teamMembersOf } from "../../lib/activeTeam";

type Team = { id: string; name: string } | null;
type Saved = { short_id: string; name: string; host: string; cookies: number; action: "created" | "rotated" | "filled"; account_hint?: string };

/** The command a person runs in their own terminal to save it from their Chrome there (agents are refused this read). */
function terminalLine(host: string, name: string, team: Team): string {
  const site = host || "<site>";
  const where = team ? ` --team ${/^[\w.-]+$/.test(team.name) ? team.name : `"${team.name.replace(/"/g, '\\"')}"`}` : " --personal";
  return `cast vault save-signin ${site} --from-chrome${name && name !== signinName(host) ? ` --name ${name}` : ""}${where}`;
}

/** The command's outcome in words a person can act on. */
function captureFailure(error: string, laptop: string): string {
  if (error === "expired_ttl") return `${laptop} never picked it up: is it asleep, or its codecast daemon stopped?`;
  if (/Unknown command/i.test(error)) return `codecast on ${laptop} is too old for this: run cast update there`;
  return error;
}

/** `profile` is the Chrome profile a 0 count was read from (a laptop on an older codecast leaves it out). */
type Checked = { host: string; cookies: number; account_hint?: string; profile?: string };

/** A sample Vault's one laptop, whose Chrome always holds the site. */
const SAMPLE_LAPTOPS: Device[] = [{ device_id: "sample-laptop", label: "Sample laptop", platform: "darwin", last_seen: 0, is_remote: false, local_project_roots: [], online: true }];

/** What a laptop would answer a sample Vault's command, at once. */
function sampleAnswer(sample: SampleVault, check: boolean, args: { site: string; name: string; team: Team }) {
  return JSON.stringify(check ? { host: args.site, cookies: 2, account_hint: "sample@example.test" } : sample.saveSignin(args));
}

/** One `requestSigninCapture` command on a laptop and its answer: a check (counts the cookies) or a save. A sample Vault answers it itself. */
function useLaptopCommand<T>(check: boolean) {
  const request = useMutation(api.secrets.requestSigninCapture);
  const sample = useSampleVault();
  const [sent, setSent] = useState<{ id: Id<"daemon_commands">; laptop: string; at: number; answer?: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const { data: live } = useQueryNoThrow(api.users.getCommandResult, sent && !sent.answer ? { command_id: sent.id } : "skip");
  const data = sent?.answer ? { result: sent.answer, error: undefined, claimed_at: Date.now() } : live;
  const reset = () => {
    setRefused(null);
    setSent(null);
  };
  const start = async (args: { site: string; name: string; device: Device; team: Team }) => {
    reset();
    if (sample) return setSent({ id: "sample" as Id<"daemon_commands">, laptop: args.device.label, at: Date.now(), answer: sampleAnswer(sample, check, args) });
    const res: any = await request({
      site: args.site,
      name: args.name || undefined,
      device_id: args.device.device_id,
      ...(check ? { check: true } : {}),
      ...(args.team ? { team_id: args.team.id as Id<"teams"> } : { personal: true }),
    }).catch(vaultFailure);
    if (res?.error) return setRefused(res.error);
    setSent({ id: res.command_id, laptop: res.label ?? args.device.label, at: Date.now() });
  };
  let result: T | null = null;
  let failed = refused;
  if (sent && data?.error) failed = captureFailure(data.error, sent.laptop);
  else if (sent && data?.result) {
    try {
      result = JSON.parse(data.result);
    } catch {
      failed = "The laptop answered in a form this page does not read: update codecast there";
    }
  }
  const waiting = !!sent && !result && !failed ? sent.laptop : null;
  // Waiting has two stages a person can tell apart: the laptop has not picked it up yet (claimed_at null), or it is working on it.
  const progress = waiting && sent ? { since: sent.at, unpicked: data?.claimed_at === null } : null;
  return { start, reset, waiting, progress, result, failed };
}

/**
 * Saving one site's sign-in into one place from a laptop's Chrome. A press
 * first checks that Chrome holds the site's cookies; only a count goes on, to
 * the share review for a team or straight to the save for Only me, so nobody
 * confirms a share that was never possible. `review` is the share review,
 * for the caller to show in place of its own dialog.
 */
function useSigninWays({ host, name, team, onSaved }: { host: string; name: string; team: Team; onSaved?: (s: Saved) => void }) {
  const devices = useDevices();
  const onlineLocals = useSampleVault() ? SAMPLE_LAPTOPS : devices.onlineLocals;
  const people = useInboxStore((s) => peopleOf(teamMembersOf(s)).length);
  const [picked, setPicked] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const check = useLaptopCommand<Checked>(true);
  const save = useLaptopCommand<Saved>(false);
  const device = onlineLocals.find((d) => d.device_id === picked) ?? onlineLocals[0] ?? null;
  const blocked = !host ? "Name the site" : keepsOwnLogin(host) ? "Google keeps its own login" : !SECRET_NAME_RE.test(name) ? "Fix the name" : null;
  const found = check.result && check.result.cookies > 0 ? check.result : null;
  const go = () => {
    setReviewing(false);
    if (device) void save.start({ site: host, name, device, team });
  };
  const press = () => {
    if (!device || blocked) return;
    save.reset();
    void check.start({ site: host, name, device, team });
  };
  // What was checked is for this site, laptop and place only.
  useWatchEffect(() => {
    check.reset();
    setReviewing(false);
  }, [host, device?.device_id, team?.id]);
  // The parsed answer is a new object each render; its count names it.
  const foundSig = found ? `${found.host}:${found.cookies}` : null;
  useWatchEffect(() => {
    if (found) team ? setReviewing(true) : go();
  }, [foundSig]);
  useWatchEffect(() => {
    if (save.result) onSaved?.(save.result);
  }, [save.result?.short_id]);
  const state: "idle" | "checking" | "signed-out" | "saving" | "saved" | "failed" = save.result
    ? "saved"
    : save.waiting
      ? "saving"
      : save.failed || check.failed
        ? "failed"
        : check.waiting
          ? "checking"
          : check.result && !found
            ? "signed-out"
            : "idle";
  const review =
    reviewing && team && device && found ? (
      <SwitchReview
        ledger={shareSigninLedger({ host, team: team.name, people, laptop: device.label, cookies: found.cookies, account_hint: found.account_hint })}
        onClose={() => (setReviewing(false), check.reset())}
        onConfirm={go}
      />
    ) : null;
  return { host, name, team, onlineLocals, device, setPicked, blocked, press, state, progress: save.progress ?? check.progress, checkedProfile: check.result?.profile, failed: save.failed ?? check.failed, saved: save.result, review };
}

export type SigninWaysState = ReturnType<typeof useSigninWays>;

/** Seconds since a press, so a wait reads as progress rather than a spinner. */
function Elapsed({ since }: { since: number }) {
  const now = useCoarseNow(1000);
  return <span className="shrink-0 tabular-nums opacity-70">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

/** The laptop button; its face is the state: waiting for the laptop, reading Chrome, saving, or not signed in (Check again, and Open the site). */
export function ChromeButton({ ways: w }: { ways: SigninWaysState }) {
  if (!w.device) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-sol-border px-3 text-[12px] text-sol-text-dim" data-vault-signin-no-laptop>
        <Laptop size={13} /> No laptop online
      </span>
    );
  }
  const busy = w.state === "checking" || w.state === "saving";
  const signedOut = w.state === "signed-out";
  const label = busy
    ? w.progress?.unpicked
      ? `Waiting for ${w.device.label}`
      : w.state === "checking"
        ? `Reading Chrome on ${w.device.label}`
        : `Saving from ${w.device.label}`
    : signedOut
      ? "Check again"
      : `From my Chrome on ${w.device.label}`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {signedOut && (
        <a
          href={`https://${w.host}`}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text hover:border-sol-text-dim ${modernButton({ variant: "outline", size: "md" })}`}
          data-vault-signin-open
        >
          Open <span className="modern:font-mono">{w.host}</span> <ExternalLink size={12} className="text-sol-text-dim" />
        </a>
      )}
      <div className={cn(buttonVariants({ variant: signedOut ? "outline" : "yellow", size: "sm" }), "min-w-0 items-stretch gap-0 overflow-hidden p-0")} data-vault-signin-button={w.state}>
        <button
          type="button"
          disabled={!!w.blocked || busy}
          onClick={w.press}
          className="inline-flex min-w-0 items-center gap-1.5 px-3 text-[12.5px] font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
          data-vault-signin-chrome
        >
          {busy ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Laptop size={13} className="shrink-0" />}
          <span className="truncate">{label}</span>
          {busy && w.progress ? <Elapsed since={w.progress.since} /> : null}
        </button>
        {w.onlineLocals.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Pick a laptop" disabled={busy} className={`border-l px-1.5 hover:brightness-110 ${signedOut ? "border-sol-border" : "border-sol-bg/25"}`}>
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {w.onlineLocals.map((d) => (
                <DropdownMenuItem key={d.device_id} onSelect={() => w.setPicked(d.device_id)}>
                  <Laptop size={13} />
                  {d.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

/** What the press ended in, when the button cannot say it: saved (a link to it) or why not. */
function Outcome({ ways: w }: { ways: SigninWaysState }) {
  if (w.saved) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]" data-vault-signin-state="saved">
        <Check size={13} className="shrink-0 text-sol-green" />
        <Link href={`/vault?s=${w.saved.short_id}`} className="truncate font-mono text-sol-text hover:underline">{w.saved.name}</Link>
        <span className="shrink-0 tabular-nums text-sol-text-muted">{w.saved.cookies} cookies</span>
        {w.saved.account_hint && <span className="truncate text-sol-text-muted">· {w.saved.account_hint}</span>}
      </div>
    );
  }
  if (w.state === "signed-out" && w.device) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]" data-vault-signin-state="signed-out">
        <span className="size-1.5 shrink-0 rounded-full bg-sol-red" />
        <span className="shrink-0 text-sol-red">Not signed in to <span className="modern:font-mono">{w.host}</span></span>
        <span className="truncate text-sol-text-muted">
          · Chrome{w.checkedProfile ? `, profile ${w.checkedProfile}` : ""}, on {w.device.label}
        </span>
      </div>
    );
  }
  if (w.state === "failed") return <div className="text-[12px] text-sol-red" data-vault-signin-state="failed">{w.failed}</div>;
  if (w.blocked && w.host) return <div className="text-meta text-sol-text-dim">{w.blocked}</div>;
  return null;
}

/** The same save from a terminal on the laptop, folded behind "In a terminal". */
function InTerminal({ ways: w }: { ways: SigninWaysState }) {
  return <CommandDisclosure label="In a terminal" text={terminalLine(w.host, w.name, w.team)} data-vault-signin-terminal />;
}

/** Add > Sign-in on the Vault page: the site, its name and who can use it, then the laptop button; the share review replaces the dialog while it is open. */
export function SaveSigninDialog({ scope, rows, onClose, onSaved }: { scope: VaultScope; rows: SecretMeta[]; onClose: () => void; onSaved?: (shortId: string) => void }) {
  const [siteText, setSiteText] = useState("");
  const [typedName, setTypedName] = useState<string | null>(null);
  const [where, setWhere] = useState<"team" | "personal">(scope.team ? "team" : "personal");
  const host = (signinSite(siteText) ?? "");
  const name = typedName ?? signinName(host);
  const team: Team = where === "team" && scope.team ? { id: scope.team.id, name: scope.team.name } : null;
  const workspace = team ? scope.team!.key : scope.personal;
  // A name already holding a sign-in here is replaced; one holding anything else is not free.
  const clash = useMemo(() => rows.find((r) => r.workspace === workspace && r.name === name), [rows, workspace, name]);
  const nameState = !name ? null : !SECRET_NAME_RE.test(name) ? "Lowercase letters, digits and dashes" : clash && clash.kind !== "signin" ? "Taken by a " + clash.kind : clash ? "Replaces the saved one" : null;
  const nameBad = !!name && (!SECRET_NAME_RE.test(name) || (!!clash && clash.kind !== "signin"));
  const ways = useSigninWays({ host, name: nameBad ? "" : name, team, onSaved: (s) => onSaved?.(s.short_id) });
  if (ways.review) return ways.review;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose className={VAULT_DIALOG} data-vault-save-signin>
        <header className="flex items-center gap-2.5 border-b border-sol-border/60 px-5 py-3.5">
          <KindGlyph kind="signin" />
          <DialogTitle className="text-[15px] font-semibold tracking-normal text-sol-text">Save a sign-in</DialogTitle>
          <DialogDescription className="sr-only">Store a site's sign-in so every agent's browser starts signed in.</DialogDescription>
        </header>
        <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-3">
          <Row label="Site" align="input">
            <input value={siteText} onChange={(e) => setSiteText(e.target.value)} placeholder="vercel.com" spellCheck={false} autoFocus className={FIELD_MONO} data-vault-signin-site />
          </Row>
          <Row label="Name" align="input">
            <div className="flex items-center gap-2">
              <input value={name} onChange={(e) => setTypedName(e.target.value.toLowerCase())} placeholder="vercel-signin" spellCheck={false} className={`${FIELD_MONO} ${nameBad ? "border-sol-red/70" : ""}`} />
              {nameState && <span className={`shrink-0 text-meta ${nameBad ? "text-sol-red" : clash ? "text-sol-orange" : "text-sol-green"}`}>{nameState}</span>}
            </div>
          </Row>
          <Row label="Who can use it" align="input">
            <ScopePicker scope={scope} value={where} onChange={setWhere} />
          </Row>
          <div className="flex min-w-0 flex-col gap-1.5 pt-2" data-vault-signin-ways>
            <Outcome ways={ways} />
            <InTerminal ways={ways} />
          </div>
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3">
          <button type="button" onClick={onClose} className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text ${modernButton({ variant: "outline", size: "md" })}`}>
            Cancel <span className="hidden sm:inline-flex"><KeyCap size="xs">esc</KeyCap></span>
          </button>
          <ChromeButton ways={ways} />
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** A sign-in request's fill: the laptop button, aimed at the request's own name, site and workspace. */
export function SigninRequestFill({ row }: { row: SecretMeta }) {
  const teamName = useInboxStore((s) => (s.teams ?? []).find((t: any) => String(t._id) === row.team_id)?.name ?? "the team");
  const [siteText, setSiteText] = useState(row.sites?.[0] ?? "");
  const ways = useSigninWays({ host: (signinSite(siteText) ?? ""), name: row.name, team: row.team_id ? { id: row.team_id, name: teamName } : null });
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-vault-signin-request={row.name}>
      {!row.sites?.length && (
        <input value={siteText} onChange={(e) => setSiteText(e.target.value)} placeholder="Site, like vercel.com" spellCheck={false} className={FIELD_MONO} />
      )}
      <div className="flex min-w-0">
        <ChromeButton ways={ways} />
      </div>
      <Outcome ways={ways} />
      <InTerminal ways={ways} />
      {ways.review}
    </div>
  );
}

// ── Every open sign-in request at once ─────────────────────────────────────

/** Where one site of a batch stands: its check's count (0 = not signed in there), then its save, or why either failed. */
type BatchState = { checked?: Checked; saved?: Saved; failed?: string };
type BatchPhase = "idle" | "checking" | "review" | "saving" | "done";

/**
 * One requested site in a batch: its check and then its save, each the same
 * laptop command the site's own button sends. It draws nothing and starts a
 * command once when the batch hands it its turn.
 */
function BatchSite({ row, device, team, turn, onState }: { row: SecretMeta; device: Device; team: Team; turn: "check" | "save" | null; onState: (id: string, s: BatchState) => void }) {
  const check = useLaptopCommand<Checked>(true);
  const save = useLaptopCommand<Saved>(false);
  const args = { site: signinSite(row.sites![0]!) ?? row.sites![0]!, name: row.name, device, team };
  useWatchEffect(() => {
    if (turn === "check") void check.start(args);
    else if (turn === "save") void save.start(args);
  }, [turn]);
  const sig = `${check.result?.cookies ?? ""}|${check.failed ?? ""}|${save.result?.short_id ?? ""}|${save.failed ?? ""}`;
  useWatchEffect(() => {
    if (sig !== "|||") onState(row._id, { checked: check.result ?? undefined, saved: save.result ?? undefined, failed: save.failed ?? check.failed ?? undefined });
  }, [sig]);
  return null;
}

/** The first site waits alone (the Mac may ask for Keychain access once); after it, this many run at a time. */
const BATCH_PARALLEL = 4;

/**
 * Save every open sign-in request in one workspace from one laptop's Chrome:
 * a press checks each site there, one review shows what was found, and its
 * confirm saves them all. Sites Chrome is not signed in to stay open, each
 * with its own button.
 */
export function SaveAllSignins({ rows, team }: { rows: SecretMeta[]; team: Team }) {
  const devices = useDevices();
  const onlineLocals = useSampleVault() ? SAMPLE_LAPTOPS : devices.onlineLocals;
  const people = useInboxStore((s) => peopleOf(teamMembersOf(s)).length);
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<BatchPhase>("idle");
  const [states, setStates] = useState<Record<string, BatchState>>({});
  // The sites a press took, fixed until it ends: a request filled meanwhile leaves the list but not the batch.
  const [batch, setBatch] = useState<SecretMeta[]>([]);
  const device = onlineLocals.find((d) => d.device_id === picked) ?? onlineLocals[0] ?? null;
  const asked = rows.filter((r) => r.kind === "signin" && r.status === "requested" && r.sites?.length && !keepsOwnLogin(signinSite(r.sites[0]!) ?? ""));

  const onState = (id: string, s: BatchState) => setStates((all) => ({ ...all, [id]: s }));
  const found = batch.filter((r) => (states[r._id]?.checked?.cookies ?? 0) > 0);
  const stage = phase === "saving" ? found : batch;
  const finished = (r: SecretMeta) => (phase === "saving" ? !!(states[r._id]?.saved || states[r._id]?.failed) : !!(states[r._id]?.checked || states[r._id]?.failed));
  const doneCount = stage.filter(finished).length;
  // Turns go in list order: one until the first site finishes, then BATCH_PARALLEL at a time.
  const open = new Set(stage.filter((r) => !finished(r)).slice(0, doneCount === 0 ? 1 : BATCH_PARALLEL).map((r) => r._id));
  const turnOf = (r: SecretMeta): "check" | "save" | null =>
    phase === "checking" && (open.has(r._id) || finished(r)) ? "check" : phase === "saving" && (open.has(r._id) || finished(r)) ? "save" : null;

  useWatchEffect(() => {
    if (phase === "checking" && batch.length && doneCount === batch.length) setPhase(found.length ? (team ? "review" : "saving") : "done");
    else if (phase === "saving" && doneCount === found.length) setPhase("done");
  }, [phase, doneCount]);

  if (!device || (asked.length < 2 && phase === "idle")) return null;
  const start = () => {
    setStates({});
    setBatch(asked);
    setPhase("checking");
  };
  const saved = batch.filter((r) => states[r._id]?.saved).length;
  const signedOut = batch.filter((r) => states[r._id]?.checked?.cookies === 0).length;
  const failed = batch.filter((r) => states[r._id]?.failed).length;
  const busy = phase === "checking" || phase === "saving";
  const label =
    phase === "checking" ? `Reading Chrome ${doneCount}/${batch.length}` : phase === "saving" ? `Saving ${doneCount}/${found.length}` : `Save ${asked.length} from my Chrome on ${device.label}`;

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-[12px] font-normal" data-vault-signin-all={phase}>
      {batch.map((r) => (
        <BatchSite key={r._id} row={r} device={device} team={team} turn={turnOf(r)} onState={onState} />
      ))}
      {phase === "done" && (
        <span className="flex min-w-0 items-center gap-1.5 tabular-nums" data-vault-signin-all-outcome>
          <Check size={13} className="shrink-0 text-sol-green" />
          <span className="text-sol-text">{saved} saved</span>
          {signedOut > 0 && <span className="text-sol-text-muted">· {signedOut} not signed in</span>}
          {failed > 0 && <span className="text-sol-red">· {failed} failed</span>}
        </span>
      )}
      {(phase !== "done" || asked.length >= 2) && (
        <div className={cn(buttonVariants({ variant: "yellow", size: "sm" }), "min-w-0 items-stretch gap-0 overflow-hidden p-0")}>
          <button type="button" disabled={busy} onClick={start} className="inline-flex min-w-0 items-center gap-1.5 px-3 text-[12.5px] font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim" data-vault-signin-all-button>
            {busy ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Laptop size={13} className="shrink-0" />}
            <span className="truncate tabular-nums">{label}</span>
          </button>
          {onlineLocals.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="Pick a laptop" disabled={busy} className="border-l border-sol-bg/25 px-1.5 hover:brightness-110">
                  <ChevronDown size={13} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onlineLocals.map((d) => (
                  <DropdownMenuItem key={d.device_id} onSelect={() => setPicked(d.device_id)}>
                    <Laptop size={13} />
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {phase === "review" && team && (
        <SwitchReview
          ledger={shareSigninsLedger({
            team: team.name,
            people,
            laptop: device.label,
            found: found.map((r) => ({ host: states[r._id]!.checked!.host, cookies: states[r._id]!.checked!.cookies, account_hint: states[r._id]!.checked!.account_hint })),
            signedOut: batch.filter((r) => states[r._id]?.checked?.cookies === 0).map((r) => r.sites![0]!),
          })}
          onClose={() => setPhase("done")}
          onConfirm={() => setPhase("saving")}
        />
      )}
    </div>
  );
}
