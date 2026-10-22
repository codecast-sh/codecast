"use client";
// Saving a site's sign-in (docs/architecture/vault.md "Saved sign-ins"), the
// two ways a person can: from their own Chrome on one of their online laptops
// (secrets.requestSigninCapture queues `vault_capture_signin` there; the
// laptop reads the cookies and stores them itself), or through the agent
// browser, which is a command to run. The web never holds a cookie: it sends a
// site and a name, and reads back the command's outcome, a count and an
// account name or the reason it failed.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { Check, ChevronDown, Laptop, Loader2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { SECRET_NAME_RE, type SecretMeta } from "@codecast/shared/contracts/secrets";
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
import { siteName } from "./vaultModel";

type Team = { id: string; name: string } | null;
type Saved = { short_id: string; name: string; host: string; cookies: number; action: "created" | "rotated" | "filled"; account_hint?: string };

const fieldCls =
  "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 font-mono text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";

/** The host a typed site names, or "" (any URL works: `https://vercel.com/dashboard` -> `vercel.com`). */
export function siteHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
}

/** A sign-in's default name, the one `cast vault save-signin` picks too. */
export const signinName = (host: string) => (host ? `${siteName(host) || "site"}-signin` : "");

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

/** Sharing a sign-in with a team gives every agent there the person's own session, so it is reviewed first. */
export function shareSigninLedger(r: { host: string; team: string; people: number; laptop: string }): SwitchLedger {
  return {
    name: `Share your ${r.host} sign-in`,
    subject: `Team · ${r.team}`,
    shift: null,
    figures: [{ value: String(r.people), label: r.people === 1 ? "person's agents sign in as you" : "people's agents sign in as you", tone: "warn" }],
    rows: [
      { k: "Site", v: r.host },
      { k: "Account", v: `Yours, from Chrome on ${r.laptop}`, tone: "warn" },
      { k: "Stays alive", v: "Agents write newer cookies back" },
      { k: "To undo", v: "Delete it, then sign out on the site", tone: "warn" },
    ],
    confirm: "Share with the team",
    keep: "Cancel",
  };
}

function useCapture() {
  const request = useMutation(api.secrets.requestSigninCapture);
  const [sent, setSent] = useState<{ id: Id<"daemon_commands">; laptop: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const { data } = useQueryNoThrow(api.users.getCommandResult, sent ? { command_id: sent.id } : "skip");
  const start = async (args: { site: string; name: string; device: Device; team: Team }) => {
    setRefused(null);
    setSent(null);
    const res: any = await request({
      site: args.site,
      name: args.name,
      device_id: args.device.device_id,
      ...(args.team ? { team_id: args.team.id as Id<"teams"> } : { personal: true }),
    }).catch((err: Error) => ({ error: err.message }));
    if (res?.error) return setRefused(res.error);
    setSent({ id: res.command_id, laptop: res.label ?? args.device.label });
  };
  let saved: Saved | null = null;
  let failed = refused;
  if (sent && data?.error) failed = captureFailure(data.error, sent.laptop);
  else if (sent && data?.result) {
    try {
      saved = JSON.parse(data.result);
    } catch {
      failed = "The laptop answered in a form this page does not read: update codecast there";
    }
  }
  const waiting = !!sent && !saved && !failed ? sent.laptop : null;
  return { start, waiting, saved, failed };
}

/**
 * Both ways to save one site's sign-in into one place: the laptop button (a
 * team save is reviewed first) with its live outcome, and the agent-browser
 * command beneath it.
 */
export function SigninWays({ host, name, team, onSaved }: { host: string; name: string; team: Team; onSaved?: (s: Saved) => void }) {
  const { onlineLocals } = useDevices();
  const people = useInboxStore((s) => peopleOf(s.teamMembers).length);
  const [picked, setPicked] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const capture = useCapture();
  const device = onlineLocals.find((d) => d.device_id === picked) ?? onlineLocals[0] ?? null;
  const blocked = !host ? "Name the site" : keepsOwnLogin(host) ? "Google keeps its own login" : !SECRET_NAME_RE.test(name) ? "Fix the name" : null;
  const go = () => {
    if (!device) return;
    setReviewing(false);
    void capture.start({ site: host, name, device, team });
  };
  const press = () => (team ? setReviewing(true) : go());
  useWatchEffect(() => {
    if (capture.saved) onSaved?.(capture.saved);
  }, [capture.saved?.short_id]);
  const lines = agentBrowserLines(host, name, team);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-vault-signin-ways>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {device ? (
          <div className="inline-flex h-8 items-stretch overflow-hidden rounded-md bg-sol-yellow text-sol-bg">
            <button
              type="button"
              disabled={!!blocked || !!capture.waiting}
              onClick={press}
              className="inline-flex items-center gap-1.5 px-3 text-[12.5px] font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
              data-vault-signin-chrome
            >
              {capture.waiting ? <Loader2 size={13} className="animate-spin" /> : <Laptop size={13} />}
              From my Chrome on {device.label}
            </button>
            {onlineLocals.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Pick a laptop" className="border-l border-sol-bg/25 px-1.5 hover:brightness-110">
                    <ChevronDown size={13} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
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
        ) : (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-sol-border px-3 text-[12px] text-sol-text-dim" data-vault-signin-no-laptop>
            <Laptop size={13} /> No laptop online
          </span>
        )}
        {blocked && host ? <span className="text-[11.5px] text-sol-text-dim">{blocked}</span> : null}
      </div>

      {capture.waiting && <div className="text-[12px] text-sol-text-muted" data-vault-signin-state="waiting">Reading Chrome on {capture.waiting}</div>}
      {capture.failed && <div className="text-[12px] text-sol-red" data-vault-signin-state="failed">{capture.failed}</div>}
      {capture.saved && (
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]" data-vault-signin-state="saved">
          <Check size={13} className="shrink-0 text-sol-green" />
          <Link href={`/vault?s=${capture.saved.short_id}`} className="truncate font-mono text-sol-text hover:underline">{capture.saved.name}</Link>
          <span className="shrink-0 tabular-nums text-sol-text-muted">{capture.saved.cookies} cookies</span>
          {capture.saved.account_hint && <span className="truncate text-sol-text-muted">· {capture.saved.account_hint}</span>}
        </div>
      )}

      <div className="flex min-w-0 items-start gap-2 rounded-md border border-sol-border/70 bg-sol-bg-alt/50 px-2 py-1.5">
        <span className="shrink-0 pt-px text-[11px] text-sol-text-dim">Agent browser</span>
        <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-snug text-sol-text">{lines}</pre>
        <CopyButton get={() => lines} label="Copy commands" />
      </div>

      {reviewing && team && device && (
        <SwitchReview ledger={shareSigninLedger({ host, team: team.name, people, laptop: device.label })} onClose={() => setReviewing(false)} onConfirm={go} />
      )}
    </div>
  );
}

/** Add > Sign-in on the Vault page: the site, its name and who can use it, then the two ways. */
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
          <Row label="Save it" className="pt-2.5">
            <SigninWays host={host} name={nameBad ? "" : name} team={team} onSaved={(s) => onSaved?.(s.short_id)} />
          </Row>
        </div>
        <footer className="flex items-center justify-end border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-2 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text">
            Close <KeyCap size="xs">esc</KeyCap>
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** A sign-in request's fill: the two ways, aimed at the request's own name, site and workspace. */
export function SigninRequestFill({ row }: { row: SecretMeta }) {
  const teamName = useInboxStore((s) => (s.teams ?? []).find((t: any) => String(t._id) === row.team_id)?.name ?? "the team");
  const [siteText, setSiteText] = useState(row.sites?.[0] ?? "");
  const host = siteHost(siteText);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-vault-signin-request={row.name}>
      {!row.sites?.length && (
        <input value={siteText} onChange={(e) => setSiteText(e.target.value)} placeholder="Site, like vercel.com" spellCheck={false} className={fieldCls} />
      )}
      <SigninWays host={host} name={row.name} team={row.team_id ? { id: row.team_id, name: teamName } : null} />
    </div>
  );
}
