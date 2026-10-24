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
