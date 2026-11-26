// Types for updatePolicy.js, which the CLI's out-of-band desktop updater
// (packages/cli/src/desktopUpdate.ts) imports so both updaters judge a feed
// and a bundle by the same rules.
export function cmpVersions(a: string, b: string): number;
export function parseFeed(text: string): { version?: string; zip?: string; sha512?: string };
export function plistVersion(xml: string): string | null;
export function bundleRefusal(opts: { feedVersion: string; bundleVersion: string | null; runningVersion: string; force?: boolean }): string | null;
