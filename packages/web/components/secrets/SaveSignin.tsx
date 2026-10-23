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
import { Check, ChevronDown, ChevronRight, Laptop, Loader2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { SECRET_NAME_RE, signinName, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDevices, type Device } from "../DeviceBadge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyCap";
import { ScopePicker, type VaultScope } from "./AddSecretDialog";
import { CopyButton, KindGlyph, Row } from "./parts";

type Team = { id: string; name: string } | null;
type Saved = { short_id: string; name: string; host: string; cookies: number; action: "created" | "rotated" | "filled"; account_hint?: string };

const fieldCls =
  "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 font-mono text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";

/** The host a typed site names, or "" (any URL works: `https://vercel.com/dashboard` -> `vercel.com`). */
export function siteHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
}

/** Google and YouTube keep their own login in the agent browser; saving one would sign the person out (browser/profile.ts). */
export const keepsOwnLogin = (host: string) => /(^|\.)(google|youtube)\.com$/.test(host);

/** The command a person runs to save it through the agent browser instead. */
export function agentBrowserLines(host: string, name: string, team: Team): string {
  const site = host || "<site>";
  const where = team ? ` --team ${/^[\w.-]+$/.test(team.name) ? team.name : `"${team.name.replace(/"/g, '\\"')}"`}` : " --personal";
  return `cast browser login ${site}\ncast vault save-signin ${site}${name && name !== signinName(host) ? ` --name ${name}` : ""}${where}`;
}

/** The command's outcome in words a person can act on. */
export function captureFailure(error: string, laptop: string): string {
  if (error === "expired_ttl") return `${laptop} never picked it up: is it asleep, or its codecast daemon stopped?`;
  if (/Unknown command/i.test(error)) return `codecast on ${laptop} is too old for this: run cast update there`;
  return error;
}

/** Sharing a sign-in with a team gives every agent there the person's own session, so it is reviewed first, with what the check found. */
export function shareSigninLedger(r: { host: string; team: string; people: number; laptop: string; cookies: number; account_hint?: string }): SwitchLedger {
  return {
    name: `Share your ${r.host} sign-in`,
    subject: `Team · ${r.team}`,
    shift: null,
    figures: [
      { value: String(r.people), label: r.people === 1 ? "person's agents sign in as you" : "people's agents sign in as you", tone: "warn" },
      { value: String(r.cookies), label: r.cookies === 1 ? "cookie" : "cookies" },
    ],
    rows: [
      { k: "Site", v: r.host },
      { k: "Account", v: r.account_hint ? `${r.account_hint}, from Chrome on ${r.laptop}` : `Yours, from Chrome on ${r.laptop}`, tone: "warn" },
      { k: "Stays alive", v: "Agents write newer cookies back" },
      { k: "To undo", v: "Delete it, then sign out on the site", tone: "warn" },
    ],
    confirm: "Share with the team",
    keep: "Cancel",
  };
}

type Checked = { host: string; cookies: number; account_hint?: string };

/** One `requestSigninCapture` command on a laptop and its answer: a check (counts the cookies) or a save. */
function useLaptopCommand<T>(check: boolean) {
  const request = useMutation(api.secrets.requestSigninCapture);
  const [sent, setSent] = useState<{ id: Id<"daemon_commands">; laptop: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const { data } = useQueryNoThrow(api.users.getCommandResult, sent ? { command_id: sent.id } : "skip");
  const reset = () => {
    setRefused(null);
    setSent(null);
  };
  const start = async (args: { site: string; name: string; device: Device; team: Team }) => {
    reset();
    const res: any = await request({
      site: args.site,
      name: args.name || undefined,
      device_id: args.device.device_id,
      ...(check ? { check: true } : {}),
      ...(args.team ? { team_id: args.team.id as Id<"teams"> } : { personal: true }),
    }).catch((err: Error) => ({ error: err.message }));
    if (res?.error) return setRefused(res.error);
    setSent({ id: res.command_id, laptop: res.label ?? args.device.label });
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
  return { start, reset, waiting, result, failed };
}

/**
 * Saving one site's sign-in into one place from a laptop's Chrome. A press
 * first checks that Chrome holds the site's cookies; only a count goes on, to
 * the share review for a team or straight to the save for Only me, so nobody
 * confirms a share that was never possible. `review` is the share review,
 * for the caller to show in place of its own dialog.
 */
export function useSigninWays({ host, name, team, onSaved }: { host: string; name: string; team: Team; onSaved?: (s: Saved) => void }) {
  const { onlineLocals } = useDevices();
  const people = useInboxStore((s) => peopleOf(s.teamMembers).length);
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
  return { host, name, team, onlineLocals, device, setPicked, blocked, press, state, failed: save.failed ?? check.failed, saved: save.result, review };
}

export type SigninWaysState = ReturnType<typeof useSigninWays>;

/** The laptop button; its face is the state: checking, not signed in there, saving. */
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
  return (
    <div className={`inline-flex h-8 min-w-0 items-stretch overflow-hidden rounded-md ${signedOut ? "border border-sol-red/60 text-sol-text" : "bg-sol-yellow text-sol-bg"}`} data-vault-signin-button={w.state}>
      <button
        type="button"
        disabled={!!w.blocked || busy}
        onClick={w.press}
        title={signedOut ? `Sign in to ${w.host} in Chrome on ${w.device.label}, then check again` : undefined}
        className="inline-flex min-w-0 items-center gap-1.5 px-3 text-[12.5px] font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
        data-vault-signin-chrome
      >
        {busy ? <Loader2 size={13} className="shrink-0 animate-spin" /> : signedOut ? <span className="size-1.5 shrink-0 rounded-full bg-sol-red" /> : <Laptop size={13} className="shrink-0" />}
        <span className="truncate">
          {w.state === "checking"
            ? `Checking Chrome on ${w.device.label}`
            : w.state === "saving"
              ? `Saving from ${w.device.label}`
              : signedOut
                ? "Not signed in · Check again"
                : `From my Chrome on ${w.device.label}`}
        </span>
      </button>
      {w.onlineLocals.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Pick a laptop" disabled={busy} className={`border-l px-1.5 hover:brightness-110 ${signedOut ? "border-sol-red/40" : "border-sol-bg/25"}`}>
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
  if (w.state === "failed") return <div className="text-[12px] text-sol-red" data-vault-signin-state="failed">{w.failed}</div>;
  if (w.blocked && w.host) return <div className="text-[11.5px] text-sol-text-dim">{w.blocked}</div>;
  return null;
}

/** The agent-browser commands, folded behind "For agents": data for whoever scripts it, whole when opened. */
function ForAgents({ ways: w }: { ways: SigninWaysState }) {
  const [open, setOpen] = useState(false);
  const lines = agentBrowserLines(w.host, w.name, w.team);
  return (
    <div className="min-w-0" data-vault-signin-agents>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] text-sol-text-dim hover:text-sol-text">
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          For agents
        </button>
        <CopyButton get={() => lines} label="Copy commands" />
      </div>
      {open && <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-sol-border/70 bg-sol-bg-alt/50 px-2 py-1.5 font-mono text-[12px] leading-snug text-sol-text">{lines}</pre>}
    </div>
  );
}

/** Add > Sign-in on the Vault page: the site, its name and who can use it, then the laptop button; the share review replaces the dialog while it is open. */
export function SaveSigninDialog({ scope, rows, onClose, onSaved }: { scope: VaultScope; rows: SecretMeta[]; onClose: () => void; onSaved?: (shortId: string) => void }) {
  const [siteText, setSiteText] = useState("");
  const [typedName, setTypedName] = useState<string | null>(null);
  const [where, setWhere] = useState<"team" | "personal">(scope.team ? "team" : "personal");
  const host = siteHost(siteText);
  const name = typedName ?? signinName(host);
  const team: Team = where === "team" && scope.team ? { id: scope.team.id, name: scope.team.name } : null;
  const workspace = team ? scope.team!.key : scope.personal;
  // A name already holding a sign-in here is replaced; one holding anything else is not free.
  const clash = useMemo(() => rows.find((r) => r.workspace === workspace && r.name === name), [rows, workspace, name]);
  const nameState = !name ? null : !SECRET_NAME_RE.test(name) ? "Lowercase letters, digits and dashes" : clash && clash.kind !== "signin" ? "Taken by a " + clash.kind : clash ? "Replaces the saved one" : "Free";
  const nameBad = !!name && (!SECRET_NAME_RE.test(name) || (!!clash && clash.kind !== "signin"));
  const ways = useSigninWays({ host, name: nameBad ? "" : name, team, onSaved: (s) => onSaved?.(s.short_id) });
  if (ways.review) return ways.review;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose className="w-[34rem] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl [&>*]:min-w-0" data-vault-save-signin>
        <header className="flex items-center gap-2.5 border-b border-sol-border/60 px-5 py-3.5">
          <KindGlyph kind="signin" />
          <DialogTitle className="text-[15px] font-semibold tracking-normal text-sol-text">Save a sign-in</DialogTitle>
          <DialogDescription className="sr-only">Store a site's sign-in so every agent's browser starts signed in.</DialogDescription>
        </header>
        <div className="flex flex-col px-5 py-3">
          <Row label="Site">
            <input value={siteText} onChange={(e) => setSiteText(e.target.value)} placeholder="vercel.com" spellCheck={false} autoFocus className={fieldCls} data-vault-signin-site />
          </Row>
          <Row label="Name">
            <div className="flex items-center gap-2">
              <input value={name} onChange={(e) => setTypedName(e.target.value.toLowerCase())} placeholder="vercel-signin" spellCheck={false} className={`${fieldCls} ${nameBad ? "border-sol-red/70" : ""}`} />
              {nameState && <span className={`shrink-0 text-[11.5px] ${nameBad ? "text-sol-red" : clash ? "text-sol-orange" : "text-sol-green"}`}>{nameState}</span>}
            </div>
          </Row>
          <Row label="Who can use it">
            <ScopePicker scope={scope} value={where} onChange={setWhere} />
          </Row>
          <div className="flex min-w-0 flex-col gap-1.5 pt-2" data-vault-signin-ways>
            <Outcome ways={ways} />
            <ForAgents ways={ways} />
          </div>
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text">
            Cancel <KeyCap size="xs">esc</KeyCap>
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
  const ways = useSigninWays({ host: siteHost(siteText), name: row.name, team: row.team_id ? { id: row.team_id, name: teamName } : null });
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-vault-signin-request={row.name}>
      {!row.sites?.length && (
        <input value={siteText} onChange={(e) => setSiteText(e.target.value)} placeholder="Site, like vercel.com" spellCheck={false} className={fieldCls} />
      )}
      <div className="flex min-w-0">
        <ChromeButton ways={ways} />
      </div>
      <Outcome ways={ways} />
      <ForAgents ways={ways} />
      {ways.review}
    </div>
  );
}
