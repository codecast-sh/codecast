// The web's origin for links written into messages and pages. One reader of
// SITE_URL so a deployment with another host changes every link at once.
export function siteUrl(): string {
  return process.env.SITE_URL || "https://codecast.sh";
}
