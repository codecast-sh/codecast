// The web's origin for links written into messages and pages. One reader of
// SITE_URL so a deployment with another host changes every link at once.
export function siteUrl(): string {
  return process.env.SITE_URL || "https://codecast.sh";
}

// Every origin the web app runs on against this backend: production plus the
// two local dev origins, so a dev web can exercise the shared backend.
export function webOrigins(): Set<string> {
  return new Set([siteUrl(), "https://local.codecast.sh", "http://localhost:3200"]);
}

// The origins a passkey ceremony may run on: the web's alone. The local dev
// origins serve code from a checkout an agent can edit, so a page there could
// ask for the person's real passkey under any words it likes; only a dev
// deployment (PASSKEY_DEV_ORIGINS=1) takes them.
export function passkeyOrigins(): Set<string> {
  return process.env.PASSKEY_DEV_ORIGINS === "1" ? webOrigins() : new Set([siteUrl()]);
}
