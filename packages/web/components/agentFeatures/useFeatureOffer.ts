"use client";

// Whether to offer one agent feature to this person, and the two ways they
// answer: turn it on, or say no. Every place the app suggests a feature (the
// new-features banner, the upsells on the surfaces a feature feeds, the hint
// under a Claude artifact) asks this one hook, so a feature is offered by one
// rule and declined once for all of them.

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { snippetAvailableForTeams, snippetBySlug, type SnippetDescriptor } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useDevices, type Device } from "../DeviceBadge";
import { snippetEnabledOn, snippetIntroKey } from "../../lib/newSnippets";

type SetSnippet = ReturnType<typeof useMutation<typeof api.devices.setDeviceSnippet>>;

/**
 * Turn a feature on for each machine. Sends the pre-rename slug when one
 * exists: old daemons only match their exact slug, new ones resolve aliases.
 */
export function turnOnFeature(setSnippet: SetSnippet, devices: Device[], s: SnippetDescriptor) {
  return Promise.all(devices.map((d) => setSnippet({ device_id: d.device_id, snippet: s.wireSlug ?? s.slug, enabled: true })));
}

export interface FeatureOffer {
  feature: SnippetDescriptor | undefined;
  /** Show the offer: the feature exists for this person's teams, a machine has
   *  reported its setup, every machine has it off, and it was never declined. */
  offer: boolean;
  /** Machines a "Turn on" reaches right now. */
  onlineCount: number;
  busy: boolean;
  /** Set once this offer turned the feature on, so the place that offered it
   *  can say so before the roster catches up and the offer goes away. */
  turnedOn: boolean;
  turnOn: () => Promise<void>;
  dismiss: () => void;
}

export function useFeatureOffer(slug: string): FeatureOffer {
  const feature = snippetBySlug(slug);
  const teams = useInboxStore((s) => s.teams);
  const declined = useInboxStore((s) => s.clientState.dismissed?.[snippetIntroKey(slug)]);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const { devices, onlineLocals, onlineRemotes } = useDevices();
  const setSnippet = useMutation(api.devices.setDeviceSnippet);
  const [busy, setBusy] = useState(false);
  const [turnedOn, setTurnedOn] = useState(false);

  const online = [...onlineLocals, ...onlineRemotes];
  const reporting = devices.filter((d) => !!d.settings);
  const offer =
    !!feature &&
    snippetAvailableForTeams(feature.slug, teams) &&
    reporting.length > 0 &&
    !reporting.some((d) => snippetEnabledOn(d.settings, feature)) &&
    !declined;

  const stamp = () => updateDismissed(snippetIntroKey(slug), Date.now());

  return {
    feature,
    offer,
    onlineCount: online.length,
    busy,
    turnedOn,
    dismiss: stamp,
    turnOn: async () => {
      if (!feature || online.length === 0) return;
      setBusy(true);
      try {
        await turnOnFeature(setSnippet, online, feature);
        setTurnedOn(true);
        stamp();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't turn that on");
      } finally {
        setBusy(false);
      }
    },
  };
}
