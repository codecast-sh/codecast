// The connect form for a token-paste app (Sentry, PostHog, an app connector):
// the settings its descriptor lists, then the token itself in a password
// field. Shared by the /settings/integrations card and the /capabilities Apps
// tab, so both surfaces ask for the same fields with the same rules.
//
// The fields come from `descriptor.tokenConfig`, the same list the server
// validates against (tokenConnectors.parseTokenConfig) and the CLI turns into
// flags, so a provider's settings are declared once.

import { useState, type FormEvent } from "react";
import type { AppDescriptor } from "@codecast/shared/contracts";
import { QuietButton } from "./parts";

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
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">{f.label}</span>
            <input
              type="text"
              value={values[f.key] ?? ""}
              placeholder={f.placeholder ?? f.default}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              spellCheck={false}
              autoComplete="off"
              className={INPUT}
            />
          </label>
        ))}
      </div>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">
          {descriptor.tokenLabel ?? "Token"}
          {descriptor.tokenOptional ? " (optional)" : ""}
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
        />
      </label>
      <p className="text-[11px] leading-relaxed text-sol-text-dim">
        {descriptor.tokenOptional && !token.trim()
          ? `With no secret, codecast signs every request it makes to ${descriptor.name}, and the app checks the signature against codecast's published keys. Nothing to paste here or set in the app's deployment.`
          : `Checked with one call to ${descriptor.name} before it is saved, then stored encrypted. Agents act through the backend and never see it.`}
      </p>
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
