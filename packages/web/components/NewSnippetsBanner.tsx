"use client";

// "New agent features" upsell. When the catalog ships a snippet after this
// account was created, a slim banner appears above the tab bar; opening it
// explains each new feature with the same prose the CLI wizard prints and
// offers a one-click "Turn on" (applied to every online machine). Dismissing
// or enabling stamps the slug in the cross-device dismissed bag, so the
// banner never returns for that feature — the Settings page stays the place
// to adjust later, and both paths link there.

import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { ArrowRight, Check, Sparkles, X } from "lucide-react";
import type { SnippetDescriptor } from "@codecast/shared/contracts";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useDevices } from "./DeviceBadge";
import { newSnippetsFor, snippetEnabledOn, snippetIntroKey } from "../lib/newSnippets";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function NewSnippetsBanner() {
  const { user } = useCurrentUser();
  const { devices, onlineLocals, onlineRemotes } = useDevices();
  const dismissed = useInboxStore((s) => s.clientState.dismissed);
  const teams = useInboxStore((s) => s.teams);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const openSettingsModal = useInboxStore((s) => s.openSettingsModal);
  const setSnippet = useMutation(api.devices.setDeviceSnippet);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [enabledNow, setEnabledNow] = useState<Set<string>>(new Set());

  const fresh = useMemo(
    () =>
      newSnippetsFor({
        userCreatedAt: typeof user?._creationTime === "number" ? user._creationTime : undefined,
        devices,
        dismissed,
        teams,
      }),
    [user?._creationTime, devices, dismissed, teams],
  );

  // Freeze the roster when the dialog opens: enabling or dismissing a feature
  // stamps it (dropping it from `fresh`), and its card must not vanish mid-read.
  const shownRef = useRef<SnippetDescriptor[]>([]);
  if (open && shownRef.current.length === 0) shownRef.current = fresh;
  if (!open && shownRef.current.length > 0) shownRef.current = [];
  const shown = open ? shownRef.current : fresh;

  if (!open && fresh.length === 0) return null;

  const onlineDevices = [...onlineLocals, ...onlineRemotes];

  const stampAll = () => {
    const now = Date.now();
    for (const s of fresh) updateDismissed(snippetIntroKey(s.slug), now);
  };

  const turnOn = async (s: SnippetDescriptor) => {
    setBusy((p) => new Set(p).add(s.slug));
    try {
      await Promise.all(
        onlineDevices.map((d) =>
          // Send the pre-rename slug when one exists — same rule as Settings:
          // old daemons only match their exact slug, new ones resolve aliases.
          setSnippet({ device_id: d.device_id, snippet: s.wireSlug ?? s.slug, enabled: true }),
        ),
      );
      setEnabledNow((p) => new Set(p).add(s.slug));
      updateDismissed(snippetIntroKey(s.slug), Date.now());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't turn that on");
    } finally {
      setBusy((p) => {
        const n = new Set(p);
        n.delete(s.slug);
        return n;
      });
    }
  };

  const names = fresh.map((s) => s.name).join(", ");

  return (
    <>
      {fresh.length > 0 && (
        <div className="bg-gradient-to-r from-sol-cyan/10 via-sol-blue/10 to-sol-cyan/10 border-b border-sol-cyan/30">
          <div className="px-4 py-2 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Sparkles className="w-4 h-4 text-sol-cyan flex-shrink-0" />
              <span className="text-sm text-sol-text truncate">
                {fresh.length === 1 ? "New agent feature: " : "New agent features: "}
                <span className="font-medium">{names}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors"
              >
                See what&apos;s new
                <ArrowRight className="w-3 h-3" />
              </button>
              <button
                onClick={stampAll}
                className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto bg-sol-card border-sol-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sol-text">
              <Sparkles className="w-4 h-4 text-sol-cyan" />
              New agent features
            </DialogTitle>
            <DialogDescription className="text-sol-base1">
              These shipped since you set up codecast. Each one installs a small section into a
              machine&apos;s CLAUDE.md that teaches agents the capability — nothing runs until an
              agent uses it. You can turn any of them on or off later in Settings → Agent
              Features.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {shown.map((s) => {
              const on =
                enabledNow.has(s.slug) ||
                devices.some((d) => snippetEnabledOn(d.settings ?? undefined, s));
              return (
                <div key={s.slug} className="rounded-lg border border-sol-border bg-sol-bg-alt p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-sol-text">{s.name}</span>
                        <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30">
                          New
                        </span>
                      </div>
                      <div className="text-[13px] text-sol-base1 mt-0.5">{s.desc}</div>
                    </div>
                    {on ? (
                      <span className="inline-flex items-center gap-1 text-xs text-sol-green flex-shrink-0 mt-0.5">
                        <Check className="w-3.5 h-3.5" /> On
                      </span>
                    ) : (
                      <button
                        disabled={busy.has(s.slug) || onlineDevices.length === 0}
                        onClick={() => turnOn(s)}
                        className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded border border-sol-cyan/40 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy.has(s.slug) ? "Turning on…" : "Turn on"}
                      </button>
                    )}
                  </div>
                  <p className="text-[12px] text-sol-base1 leading-relaxed mt-2">{s.detail}</p>
                  <p className="text-[11px] text-sol-text-dim mt-2 font-mono">{s.writesTo}</p>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[11px] text-sol-text-dim">
              {onlineDevices.length === 0
                ? "No machines online — turn on from Settings later"
                : onlineDevices.length === 1
                  ? "Turn on applies to your online machine"
                  : `Turn on applies to ${onlineDevices.length} online machines`}
            </span>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  setOpen(false);
                  openSettingsModal("agent-features");
                }}
                className="px-3 py-1 text-xs rounded border border-sol-border text-sol-base1 hover:text-sol-text hover:border-sol-base1 transition-colors inline-flex items-center gap-1 whitespace-nowrap"
              >
                Open Settings
                <ArrowRight className="w-3 h-3" />
              </button>
              <button
                onClick={() => {
                  stampAll();
                  setOpen(false);
                }}
                className="px-3 py-1 text-xs rounded border border-sol-border text-sol-base1 hover:text-sol-text hover:border-sol-base1 transition-colors"
              >
                Later
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
