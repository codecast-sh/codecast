"use client";

// Guided setup for the Cursor API key Cursor Cloud sessions run on. Cursor has
// no OAuth for its API: a key is made by hand on cursor.com. So the dialog
// walks the person through that page, takes the pasted key, seals it to the
// machine that drives the cloud agents (the browser cannot reach
// api.cursor.com), and shows that machine's verdict: the Cursor account the
// key belongs to, or Cursor's reason for refusing it. A refused key is never
// stored.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { captureException } from "@sentry/react";
import { ExternalLink, KeyRound } from "lucide-react";
import { getProviderKeySpec } from "@codecast/shared/contracts";
import { useDevices, type Device } from "./DeviceBadge";
import { deviceManagedKeys, useProviderKeyCommand } from "../lib/useProviderKeyCommand";
import { Step } from "./MintTokenDialog";
import { useLiveSessionMeta } from "../hooks/useLiveSessionMeta";
import { useInboxStore } from "../store/inboxStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

const CURSOR = getProviderKeySpec("cursor")!;

/**
 * The machine that drives a Cursor Cloud session, and whether it holds a
 * Cursor key: the one named (the session's machine, the page's machine), else
 * your most recently seen online computer.
 */
export function useCursorKeyStatus(deviceId?: string | null): { device: Device | null; connected: boolean } {
  const { byId, mostRecentOnlineLocal } = useDevices();
  const device = (deviceId ? byId.get(deviceId) : undefined) ?? mostRecentOnlineLocal;
  return { device, connected: !!device && deviceManagedKeys(device).managedIds.includes("cursor") };
}

/** A small "Connect Cursor" control that opens the guided dialog. */
export function ConnectCursorButton({ label = "Connect Cursor", className, deviceId, conversationId }: { label?: string; className?: string; deviceId?: string | null; conversationId?: string }) {
  const [open, setOpen] = useState(false);
  // From a session: the key belongs on the machine that runs it.
  const ownerDeviceId = useLiveSessionMeta(conversationId)?.ownerDeviceId;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 rounded border border-sol-violet/40 bg-sol-violet/10 px-1.5 py-0.5 text-[10px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/20 ${className ?? ""}`}
      >
        <KeyRound className="h-3 w-3" aria-hidden />
        {label}
      </button>
      {open && <ConnectCursorDialog deviceId={deviceId ?? ownerDeviceId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ConnectCursorDialog({ onClose, deviceId }: { onClose: () => void; deviceId?: string | null }) {
  // The machine is fixed when the dialog opens: the roster reorders as
  // machines check in, and the key must go where the label said.
  const initial = useCursorKeyStatus(deviceId);
  const [pinnedId] = useState(() => initial.device?.device_id ?? null);
  const { device, connected } = useCursorKeyStatus(pinnedId);
  const { setKey } = useProviderKeyCommand();
  const [opened, setOpened] = useState(false);
  const [key, setKeyText] = useState("");
  const [commandId, setCommandId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const outcome = useQuery(
    (api.devices as any).providerKeyCommandOutcome,
    commandId ? { command_id: commandId as Id<"daemon_commands"> } : "skip",
  ) as { state: "pending" } | { state: "done"; account?: string } | { state: "failed"; error: string } | null | undefined;

  const pubkey = device ? deviceManagedKeys(device).pubkey : undefined;
  const machine = device?.label ?? "your computer";
  const checking = sending || (!!commandId && (outcome === undefined || outcome?.state === "pending"));
  const done = outcome?.state === "done";
  const failed = outcome?.state === "failed" ? outcome.error : sendError;
  const trimmed = key.trim();
  const looksRight = trimmed.startsWith(CURSOR.keyPrefix ?? "") && trimmed.length > 20;

  const openCursor = () => {
    window.open(CURSOR.consoleUrl, "_blank", "noopener,noreferrer");
    setOpened(true);
  };

  const submit = async () => {
    if (!device || !pubkey || !looksRight) return;
    setSending(true);
    setSendError(null);
    setCommandId(null);
    try {
      const id = await setKey(device.device_id, pubkey, "cursor", trimmed);
      setCommandId(id ?? null);
      setKeyText("");
    } catch (err) {
      captureException(err);
      setSendError(err instanceof Error ? err.message : "Couldn't send the key");
    } finally {
      setSending(false);
    }
  };

  const step1 = opened || trimmed || commandId ? "done" : "active";
  const step2 = commandId && !failed ? "done" : opened || trimmed ? "active" : "todo";
  const step3 = done ? "done" : checking || failed ? "active" : "todo";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Cursor</DialogTitle>
          <DialogDescription>
            Cursor Cloud sessions run on Cursor's machines against your GitHub repos. Codecast drives them from{" "}
            {machine} with a Cursor API key.
          </DialogDescription>
        </DialogHeader>

        {!device ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            None of your computers is online. Start codecast on one (<code className="font-mono">cast start</code>), then come back.
          </p>
        ) : !pubkey ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            Update codecast on {machine} to add keys from here.
          </p>
        ) : (
          <div className="space-y-3 text-xs leading-relaxed text-sol-text-muted">
            {connected && !commandId && (
              <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
                {machine} already has a Cursor key. Adding another replaces it.
              </p>
            )}
            <ol className="space-y-3 rounded-md border border-sol-border bg-sol-bg-alt/60 p-3">
              <Step n={1} state={step1}>
                Open Cursor's API keys page, signed in to the Cursor account the agents should run on.
                <span className="mt-1.5 block">
                  <Button type="button" size="sm" variant="outline" onClick={openCursor} className="h-7 gap-1.5 px-2.5 text-[11px]">
                    Open cursor.com/dashboard/api <ExternalLink className="h-3 w-3" aria-hidden />
                  </Button>
                </span>
              </Step>
              <Step n={2} state={step2}>
                Under <span className="text-sol-text">User API Keys</span> press <span className="text-sol-text">Add</span>, name it{" "}
                <span className="text-sol-text">codecast</span>, press <span className="text-sol-text">Save</span>, and copy the key. Cursor shows it once.
                <form className="mt-1.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                  <Input
                    aria-label="Cursor API key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(e) => setKeyText(e.target.value)}
                    placeholder={`${CURSOR.keyPrefix}…`}
                    className="h-8 font-mono"
                  />
                  <Button type="submit" size="sm" disabled={!looksRight || checking} className="h-8">
                    {checking ? "Checking…" : "Connect"}
                  </Button>
                </form>
                {trimmed && !looksRight && (
                  <span className="mt-1 block text-[11px] text-amber-500">A Cursor key starts with {CURSOR.keyPrefix}.</span>
                )}
              </Step>
              <Step n={3} state={step3}>
                Codecast checks the key with Cursor on {machine} and keeps it there. It crosses codecast's servers only sealed to that machine.
                {checking && (
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-500">
                    <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" aria-hidden />
                    checking with Cursor
                  </span>
                )}
              </Step>
            </ol>

            {failed && (
              <p className="rounded-md border border-sol-red/30 bg-sol-red/10 p-2.5 text-sol-red">{failed}</p>
            )}
            {done && (
              <p className="rounded-md border border-sol-green/30 bg-sol-green/10 p-2.5 text-sol-green">
                Connected{outcome.state === "done" && outcome.account ? ` as ${outcome.account}` : ""}. Cursor Cloud sessions now run from {machine}, and your
                cloud agents from the last 30 days appear in your inbox.
              </p>
            )}
            <p className="text-[11px] text-sol-text-dim">
              Agents only reach repos Cursor's GitHub app can see. Connect it under{" "}
              <a href="https://cursor.com/dashboard/integrations" target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-sol-text">
                Cursor → Integrations
              </a>
              .
            </p>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant={done ? "default" : "ghost"} onClick={onClose} className="h-7 px-3 text-[11px]">
            {done ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Cursor Cloud Agent behind a session (its `bc-` id is the session id), opened on cursor.com. */
export function CursorCloudLink({ conversationId }: { conversationId: string }) {
  const id = useInboxStore((st) => {
    const key = st.resolveLiveSessionId(conversationId);
    const row = (st.conversations[key] ?? st.sessions[key]) as { agent_type?: string; session_id?: string } | undefined;
    return row?.agent_type === "cursor" && row.session_id?.startsWith("bc-") ? row.session_id : null;
  });
  if (!id) return null;
  return (
    <a
      href={`https://cursor.com/agents/${id}`}
      target="_blank"
      rel="noreferrer"
      title="This session runs as a Cursor Cloud Agent: open it on cursor.com"
      className="inline-flex shrink-0 items-center gap-1 rounded border border-sol-violet/30 px-1.5 py-px text-[10px] text-sol-violet hover:bg-sol-violet/10"
    >
      Cursor Cloud <ExternalLink className="h-2.5 w-2.5" aria-hidden />
    </a>
  );
}
