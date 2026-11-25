"use client";

// Sign in to a remote MCP server on one machine, from wherever the person is
// (shared/contracts/mcpLogin.ts). The machine runs the agent CLI's own login
// and reports its authorization URL on the device row; the person approves in
// their own browser, which then lands on the CLI's localhost callback. On the
// machine itself that finishes the sign-in by itself; anywhere else the page
// fails to load, and its address, pasted here, finishes it.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Copy, ExternalLink } from "lucide-react";
import { mcpLoginCallback, MCP_LOGIN_STALE_MS, type McpLoginClient } from "@codecast/shared/contracts";
import { useDevices } from "../DeviceBadge";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchedCommand } from "../../lib/useProviderKeyCommand";
import { serverErrorText } from "../../lib/errorCause";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner, Step } from "../MintTokenDialog";

export type McpSignInTarget = {
  deviceId: string;
  deviceName: string;
  server: string;
  client: McpLoginClient;
  cwd?: string;
};

const CLIENT_LABEL: Record<McpLoginClient, string> = { claude: "Claude Code", codex: "Codex" };

export function McpSignInDialog({ target, onClose }: { target: McpSignInTarget; onClose: () => void }) {
  const start = useMutation(api.mcpLogin.start);
  const submit = useMutation(api.mcpLogin.submitCallback);
  const cancel = useMutation(api.mcpLogin.cancel);
  const { byId } = useDevices();
  const now = useCoarseNow(5000);
  const command = useWatchedCommand(45_000);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  // Set while a pasted address is with the machine: the notice the flow held
  // then, so a newer one means the CLI refused this address.
  const [sent, setSent] = useState<{ noticeAt: number } | null>(null);
  const [sending, setSending] = useState(false);

  const begin = () => {
    setStartedAt(null);
    setStartError(null);
    setSent(null);
    setAddress("");
    start({ device_id: target.deviceId, client: target.client, server: target.server, ...(target.cwd ? { cwd: target.cwd } : {}) })
      .then((r) => {
        setStartedAt(r.started_at);
        command.watch(r.command_id);
      })
      .catch((err) => setStartError(serverErrorText(err)));
  };
  useMountEffect(begin);

  // This sign-in's flow on the device row; a flow for another server or an
  // earlier attempt is not ours.
  const raw = byId.get(target.deviceId)?.mcp_login_flow;
  const flow = raw && startedAt !== null && raw.started_at === startedAt ? raw : undefined;
  const refused = command.outcome?.state === "failed" ? command.outcome.error : undefined;
  const failure =
    startError ??
    (refused ? (/unknown command/i.test(refused) ? `${target.deviceName} runs a cast too old for this. Update it in Settings, Daemon.` : refused) : undefined) ??
    (flow?.status === "rejected" ? flow.reason ?? "The sign-in stopped" : undefined) ??
    (flow?.status === "pending" && now - flow.started_at > MCP_LOGIN_STALE_MS ? "The sign-in timed out" : undefined) ??
    (command.unanswered && !flow?.url ? `${target.deviceName} did not answer` : undefined);
  const done = flow?.status === "confirmed";
  const url = flow?.status === "pending" ? flow.url : undefined;
  const checked = address.trim() ? mcpLoginCallback(address) : null;
  const refusal = flow?.notice && (flow.notice_at ?? 0) > (sent?.noticeAt ?? -1) ? flow.notice : undefined;
  const waiting = sent !== null && !refusal;

  const close = () => {
    if (startedAt !== null && flow?.status === "pending") cancel({ device_id: target.deviceId, started_at: startedAt }).catch(() => {});
    onClose();
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (startedAt === null || !checked || "error" in checked) return;
    setSending(true);
    try {
      const noticeAt = flow?.notice_at ?? 0;
      await submit({ device_id: target.deviceId, started_at: startedAt, callback: checked.url });
      setSent({ noticeAt });
    } catch (err) {
      toast.error(serverErrorText(err));
    } finally {
      setSending(false);
    }
  };

  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => toast.message("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && (done || failure ? onClose() : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to {target.server}</DialogTitle>
          <p className="text-meta text-sol-text-muted">
            {target.deviceName} · {CLIENT_LABEL[target.client]}
          </p>
        </DialogHeader>

        {done ? (
          <p className="text-sm text-sol-green">Signed in</p>
        ) : failure ? (
          <p className="text-sm text-sol-red break-words">{failure}</p>
        ) : !url ? (
          <Spinner label={`Starting on ${target.deviceName}`} />
        ) : (
          <form id="mcp-sign-in" onSubmit={finish}>
            <ol className="space-y-3">
              <Step n={1} state={address ? "done" : "active"}>
                <span className="block">Approve access</span>
                <span className="mt-1.5 flex items-center gap-2">
                  <Button asChild variant="outline" size="xs">
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open sign-in page
                    </a>
                  </Button>
                  <Button type="button" variant="ghost" size="xs" onClick={copy}>
                    <Copy className="h-3.5 w-3.5" />
                    Copy link
                  </Button>
                </span>
              </Step>
              <Step n={2} state={waiting ? "done" : address ? "active" : "todo"}>
                <label htmlFor="mcp-sign-in-address" className="block">
                  Paste the address the browser opened
                </label>
                <input
                  id="mcp-sign-in-address"
                  autoComplete="off"
                  spellCheck={false}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="http://localhost:…/callback?code=…"
                  className="mt-1.5 h-8 w-full rounded border border-sol-border bg-sol-bg px-2 font-mono text-meta text-sol-text"
                />
                {checked && "error" in checked ? (
                  <span className="mt-1 block text-meta text-sol-red">{checked.error}</span>
                ) : refusal && sent ? (
                  <span className="mt-1 block text-meta text-sol-red">{refusal}</span>
                ) : null}
              </Step>
            </ol>
            {waiting && <Spinner className="mt-3" label="Finishing" />}
          </form>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={onClose}>Done</Button>
          ) : failure ? (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button onClick={begin}>Try again</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button type="submit" form="mcp-sign-in" disabled={!url || !checked || "error" in checked || sending || waiting}>
                Finish sign-in
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
