// The connect form for a token-paste app (Sentry, PostHog, an app connector):
// the settings its descriptor lists, then the token itself in a masked
// field the browser never reads as a login (see SECRET_PROPS). Shared by the /settings/integrations card and the /capabilities Apps
// tab, so both surfaces ask for the same fields with the same rules.
//
// The fields come from `descriptor.tokenConfig`, the same list the server
// validates against (tokenConnectors.parseTokenConfig) and the CLI turns into
// flags, so a provider's settings are declared once.

import { useState, type CSSProperties, type FormEvent } from "react";
import { ExternalLink, Eye, EyeOff, Lock } from "lucide-react";
import { tokenCreateUrl, type AppDescriptor } from "@codecast/shared/contracts";
import { QuietButton } from "./parts";

/**
 * Keeps password managers and the browser's own autofill out. A text field
 * followed by a password field reads to Chrome as a login form whatever
 * autoComplete says, so it filled the first setting with the person's email
 * and the token with a saved site password. So no field here is
 * type=password (the token is masked by style instead), no name looks like a
 * username, and the managers that read their own opt-out attributes see them.
 */
const NO_FILL = { autoComplete: "off", "data-1p-ignore": "true", "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other" } as const;
const MASKED: CSSProperties = { WebkitTextSecurity: "disc" } as CSSProperties;

const INPUT =
  "mt-1 h-7 w-full rounded border border-sol-border bg-sol-bg px-2 font-mono text-xs text-sol-text focus:border-sol-cyan focus:outline-none";

export function TokenConnectForm({
  descriptor,
  busy,
  onSubmit,
  onCancel,
}: {
  descriptor: AppDescriptor;
  busy: boolean;
  /** Resolves true once the connection is stored; the parent closes the form. */
  onSubmit: (token: string, config: Record<string, string>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const fields = descriptor.tokenConfig ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);

  // Where the token is made, from the host the person typed (or its default), and the scopes it needs.
  const help = descriptor.tokenHelp ? { scopes: descriptor.tokenHelp.scopes, url: tokenCreateUrl(descriptor.tokenHelp.createUrl, fields, values) } : null;

  // Defaulted and optional fields may stay empty; the server fills defaults.
  const missing = fields.some((f) => !f.default && !f.optional && !(values[f.key] ?? "").trim());
  // An app connector needs no secret: codecast signs every request it makes.
  const ready = (!!token.trim() || !!descriptor.tokenOptional) && !missing;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    const config = Object.fromEntries(
      Object.entries(values).map(([k, val]) => [k, val.trim()]).filter(([, val]) => val),
    );
    const stored = await onSubmit(token.trim(), config);
    // A stored token has no reason to stay in page memory; a refused one stays
    // so the person can fix a setting without pasting again.
    if (stored) setToken("");
  };

  return (
    <form onSubmit={submit} autoComplete="off" className="mt-2 space-y-2 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-mark uppercase tracking-wider text-sol-text-dim">{f.label}</span>
            <input
              type="text"
              name={`cc-${descriptor.id}-setting-${f.key}`}
              value={values[f.key] ?? ""}
              placeholder={f.placeholder ?? f.default}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              spellCheck={false}
              {...NO_FILL}
              className={INPUT}
            />
          </label>
        ))}
      </div>
      {help && (
        <div className="flex flex-wrap items-center gap-1.5 text-meta" data-token-help>
          <a href={help.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sol-link hover:underline">
            Create {descriptor.tokenLabel?.toLowerCase() ?? "token"} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          {help.scopes.map((sc) => (
            <span key={sc} className="rounded bg-sol-bg-alt px-1.5 font-mono text-meta text-sol-text-muted" data-token-scope>{sc}</span>
          ))}
        </div>
      )}
      <label className="block">
        <span className="flex items-center gap-1.5 text-mark uppercase tracking-wider text-sol-text-dim">
          {descriptor.tokenLabel ?? "Token"}
          {descriptor.tokenOptional ? " (optional)" : ""}
          <span
            className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal"
            data-token-note
            title={
              descriptor.tokenOptional && !token.trim()
                ? `With no secret, codecast signs every request it makes to ${descriptor.name}, and the app checks the signature against codecast's published keys.`
                : `Checked with one call to ${descriptor.name} before it is saved, then stored encrypted. Agents act through the backend and never see it.`
            }
          >
            <Lock className="h-3 w-3" aria-hidden />
            {descriptor.tokenOptional && !token.trim() ? "codecast signs every request" : "encrypted"}
          </span>
        </span>
        <span className="relative block">
          <input
            type="text"
            name={`cc-${descriptor.id}-secret`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            {...NO_FILL}
            data-token-field
            data-masked={shown ? undefined : "true"}
            style={shown ? undefined : MASKED}
            className={`${INPUT} pr-7`}
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide" : "Show"}
            aria-pressed={shown}
            className="absolute right-1 top-1/2 mt-0.5 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-sol-text-dim hover:text-sol-text"
          >
            {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <QuietButton type="submit" disabled={!ready} busy={busy}>
          {busy ? "Checking" : "Connect"}
        </QuietButton>
        <QuietButton onClick={onCancel} disabled={busy} className="border-transparent text-sol-text-muted">
          Cancel
        </QuietButton>
      </div>
    </form>
  );
}
