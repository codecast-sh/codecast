// The consent screen an outside agent opens to connect (docs/architecture/agent-mcp.md).
// The job: see who is asking, as which account, and allow or deny. Allow grants
// a capability, so it goes through the shared review (SwitchReview); Deny is one
// press. The page never sends the browser anywhere the agent did not register:
// an unknown client or return address shows the error and stays here.
import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useLocalAuth } from "../../../lib/localAuth";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { SwitchReview } from "../../../components/consequential/ConsequentialSwitch";
import { agentConnectLedger } from "../../../components/consequential/ledgers";

function withParams(base: string, params: Record<string, string | null>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

function AuthorizeContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const localAuthed = useLocalAuth();
  const router = useRouter();
  const q = useSearchParams();
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state");
  const challenge = q.get("code_challenge") ?? "";
  const method = q.get("code_challenge_method") ?? "";
  const resource = q.get("resource");
  const malformed = !clientId || !redirectUri || q.get("response_type") !== "code";

  const info = useQueryNoThrow(api.mcpConsent.consentInfo, isAuthenticated && !malformed ? { client_id: clientId, redirect_uri: redirectUri } : "skip").data;
  const approve = useMutation(api.mcpConsent.approve);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useWatchEffect(() => {
    if (!isLoading && !isAuthenticated && !localAuthed) {
      router.replace(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [isLoading, isAuthenticated, localAuthed]);

  if (malformed) return <Shell title="Can't connect" error="This link is missing what an agent sends. Start the connection again from the agent." />;
  if (!isAuthenticated || info === undefined) return <AppLoader />;
  if ("error" in info) return <Shell title="Can't connect" error={info.error} />;

  const deny = () => window.location.assign(withParams(redirectUri, { error: "access_denied", state }));
  const allow = async () => {
    setReviewing(false);
    setSending(true);
    const out = await approve({ client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, ...(resource ? { resource } : {}) });
    if ("error" in out) {
      setSending(false);
      setError(out.error);
      return;
    }
    window.location.assign(withParams(redirectUri, { code: out.code, state }));
  };

  const workspaces = info.workspaces;
  const account = info.account.email ?? info.account.name ?? "you";
  const ledger = agentConnectLedger({ client: info.client_name, host: info.redirect_host, account, workspaces });

  return (
    <Shell title={info.client_name} subtitle={info.redirect_host} error={error}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]" data-consent-facts>
        <dt className="text-sol-text-dim">As</dt>
        <dd className="truncate text-sol-text">{account}</dd>
        <dt className="text-sol-text-dim">Reads</dt>
        <dd className="text-sol-text">{workspaces.join(", ")}</dd>
        <dt className="text-sol-text-dim">Writes</dt>
        <dd className="text-sol-green">Nothing</dd>
      </dl>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={deny} disabled={sending} data-consent-deny>Deny</Button>
        <Button variant="amber" onClick={() => setReviewing(true)} disabled={sending} data-consent-review>
          {sending ? "Connecting" : "Connect"}
        </Button>
      </div>
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={allow} />}
    </Shell>
  );
}

function Shell({ title, subtitle, error, children }: { title: string; subtitle?: string; error?: string | null; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-sol-bg p-4">
      <div className="w-full max-w-sm rounded-lg border border-sol-border bg-sol-bg-alt/50 p-6" data-consent>
        <div className="mb-1 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Connect an agent</div>
        <h1 className="truncate text-lg font-semibold text-sol-text">{title}</h1>
        {subtitle && <div className="mb-5 truncate text-[13px] text-sol-text-muted">returns to {subtitle}</div>}
        {error && <p className="mt-3 text-[13px] text-sol-red" role="alert">{error}</p>}
        {children}
      </div>
    </div>
  );
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={<AppLoader />}>
      <AuthorizeContent />
    </Suspense>
  );
}
