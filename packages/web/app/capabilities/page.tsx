"use client";

// The route entry for /capabilities. The surface itself lives in
// components/capabilities/CapabilitiesPage.tsx, matching how every other page
// here is split: the route file exists so the manifest has something to lazy
// import, and holds no logic of its own.
//
// Every prop is optional. Without a public catalog wired up, the Library tab
// still browses what this account's own machines report — a real catalog with a
// real cross-reference, bounded by the fleet rather than empty.

import CapabilitiesPage from "@/components/capabilities/CapabilitiesPage";

export default function Page() {
  return <CapabilitiesPage />;
}
