"use client";

// Hosted mode's page keys in the main window: Cmd+1 Inbox, 2 Approvals,
// 3 To-dos, 4 Notes, 5 Routines (lib/surfaceRules HOSTED_SECTION_KEYS). The
// Chat and Work windows answer the same chords with their own sections
// (AppWindowBar), so DashboardLayout mounts this only outside them.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useShortcutAction } from "../shortcuts";
import { HOSTED_SECTION_KEYS } from "../lib/surfaceRules";

function SectionKey({ action, path }: (typeof HOSTED_SECTION_KEYS)[number]) {
  const router = useRouter();
  useShortcutAction(action, useCallback(() => router.push(path), [router, path]));
  return null;
}

export function HostedSectionKeys() {
  return (
    <>
      {HOSTED_SECTION_KEYS.map((k) => <SectionKey key={k.action} {...k} />)}
    </>
  );
}
