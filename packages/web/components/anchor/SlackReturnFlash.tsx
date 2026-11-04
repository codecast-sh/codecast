"use client";

// The Slack install completes on /slack/connect and comes back to the
// workspace's root page with ?slack=connected|error; this says which, once.

import { useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";

export function SlackReturnFlash() {
  const [flash, setFlash] = useState<null | "connected" | "error">(null);
  useMountEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("slack");
    if (s !== "connected" && s !== "error") return;
    setFlash(s);
    const u = new URL(window.location.href);
    ["code", "state", "scope", "team", "slack", "reason", "error"].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState({}, "", u.pathname + u.search);
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  });
  if (!flash) return null;
  return (
    <div className={`px-6 py-2 text-sm shrink-0 ${flash === "connected" ? "bg-sol-green/15 text-sol-green" : "bg-sol-red/15 text-sol-red"}`}>
      {flash === "connected"
        ? "Slack connected. Invite the bot to a channel, then link it under Settings."
        : "Slack connection failed. Please try again."}
    </div>
  );
}
