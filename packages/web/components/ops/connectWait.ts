// What the connect sheet says once a source is made, until data flows: one
// reading from the new source's row and its health (sourceHealth.ts), so a
// poll that fails, a manifest that cannot be read or a token that lost its
// grip shows its reason and fix in the sheet rather than an endless spinner.
// Pure, apart from sendTestEvent, the sheet's one network call.
import { ingestEndpoint } from "./opsModel";
import type { SourceHealth } from "./sourceHealth";
import type { OpsSource } from "./opsTypes";

export type ConnectWaitState = "adding" | "waiting" | "connected" | "arrived" | "failing";
export type ConnectWait = { state: ConnectWaitState; label: string; reason: string | null };

const VENDOR_LABEL: Record<string, string> = { sentry: "Sentry", posthog: "PostHog" };

export function connectWait(
  fresh: Pick<OpsSource, "provider" | "status" | "keyed" | "last_error" | "last_event_at" | "last_poll_at" | "manifest_fetched_at"> | null,
  health: Pick<SourceHealth, "state" | "label" | "reason" | "lastAt"> | undefined,
): ConnectWait {
  if (!fresh) return { state: "adding", label: "Adding", reason: null };
  // Anything the new source holds came after the sheet made it: a vendor's first poll may bring issues that are days old.
  if (health?.lastAt ?? fresh.last_event_at) return { state: "arrived", label: fresh.keyed ? "First event arrived" : "Data arriving", reason: null };
  const broken = fresh.status === "error" || health?.state === "auth" || health?.state === "failing" || (health?.state === "degraded" && !!health.reason);
  if (broken || fresh.last_error) return { state: "failing", label: health && health.state !== "waiting" && health.state !== "stopped" ? health.label : "Failing", reason: health?.reason ?? fresh.last_error ?? null };
  if (fresh.provider === "app") return fresh.manifest_fetched_at ? { state: "connected", label: "Connected · codecast.json read", reason: null } : { state: "waiting", label: "Reading codecast.json", reason: null };
  if (fresh.last_poll_at) return { state: "connected", label: "Connected · nothing in the last poll", reason: null };
  if (VENDOR_LABEL[fresh.provider]) return { state: "waiting", label: `Waiting for the first ${VENDOR_LABEL[fresh.provider]} poll`, reason: null };
  return { state: "waiting", label: "Waiting for the first event", reason: null };
}

/** The test event a keyed source's key sends from the browser, the same item the overview's check command sends. */
export function testEventBody(at: number): string {
  return JSON.stringify({ sdk: { name: "codecast-web", version: "1" }, items: [{ type: "event", name: "codecast.test", at }] });
}

export type TestSend = { ok: true } | { ok: false; error: string };

/** Sends one test event with the key the sheet holds; the answer's error when the door refuses it. */
export async function sendTestEvent(convexUrl: string, key: string): Promise<TestSend> {
  try {
    const res = await fetch(`${ingestEndpoint(convexUrl)}/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: testEventBody(Date.now()) });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, error: `${res.status} ${body?.error ?? res.statusText}`.trim() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Could not reach the ingest endpoint" };
  }
}
