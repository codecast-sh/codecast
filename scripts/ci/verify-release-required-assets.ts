// The gate finalize-cli-release.yml runs between "the draft holds the assets"
// and "the release is public": every binary a client can be pointed at must
// exist on the release, be fully uploaded, and be non-empty. Without it a
// release whose upload half-failed still becomes the public target (ct-49566).
//
// Reads the draft-aware releases list, not /releases/tags/<tag>, because that
// endpoint 404s while the release is still a draft.
import { assetName } from "../../platform/packages/cli-kit/src/update/version.ts";

const API_VERSION = "2022-11-28";

/** The five platforms one build-binaries.sh run produces. */
const RELEASE_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;

/** Asset names derived from the same function the updater resolves downloads
 *  with, so a rename cannot leave this gate checking stale names. */
export function getRequiredReleaseAssetNames(): string[] {
  return RELEASE_PLATFORM_KEYS.map((key) => assetName("codecast", key));
}

export interface ReleaseAsset {
  name: string;
  /** GitHub reports "starter" until the upload completes. */
  state?: string;
  size?: number;
}

export interface ReleaseSummary {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

export interface AssetShortfall {
  missing: string[];
  notUploaded: string[];
  empty: string[];
}

/** Pure: what the release lacks, given the names it must carry. */
export function findAssetShortfall(
  release: ReleaseSummary,
  requiredNames: string[] = getRequiredReleaseAssetNames(),
): AssetShortfall {
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const present = requiredNames
    .map((name) => byName.get(name))
    .filter((asset): asset is ReleaseAsset => asset !== undefined);
  return {
    missing: requiredNames.filter((name) => !byName.has(name)).sort(),
    notUploaded: present
      .filter((asset) => asset.state !== undefined && asset.state !== "uploaded")
      .map((asset) => `${asset.name}:${asset.state}`)
      .sort(),
    empty: present.filter((asset) => asset.size === 0).map((asset) => asset.name).sort(),
  };
}

export function assertRequiredAssets(
  tag: string,
  release: ReleaseSummary,
  requiredNames: string[] = getRequiredReleaseAssetNames(),
): void {
  const { missing, notUploaded, empty } = findAssetShortfall(release, requiredNames);
  if (missing.length === 0 && notUploaded.length === 0 && empty.length === 0) return;
  throw new Error(
    [
      `Release ${tag} is not ready to publish.`,
      missing.length > 0 ? `Missing: ${missing.join(", ")}` : null,
      notUploaded.length > 0 ? `Not uploaded: ${notUploaded.join(", ")}` : null,
      empty.length > 0 ? `Empty: ${empty.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function fetchDraftAwareRelease(input: {
  repo: string;
  tag: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseSummary> {
  const { repo, tag, token, fetchImpl = fetch } = input;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub releases request failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const releases = (await res.json()) as unknown;
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`);
  }
  const matches = (releases as ReleaseSummary[]).filter((r) => r.tag_name === tag);
  if (matches.length !== 1) {
    throw new Error(
      `Release ${repo}@${tag} appears ${matches.length} times in the draft-aware releases list`,
    );
  }
  return matches[0];
}

export async function verifyRequiredReleaseAssets(input: {
  repo: string;
  tag: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ tag: string; checked: string[]; draft: boolean }> {
  const release = await fetchDraftAwareRelease(input);
  const checked = getRequiredReleaseAssetNames();
  assertRequiredAssets(input.tag, release, checked);
  return { tag: input.tag, checked, draft: release.draft === true };
}

async function main(): Promise<void> {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: bun scripts/ci/verify-release-required-assets.ts <tag>");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN must be set");
  const repo = process.env.GITHUB_REPOSITORY || "codecast-sh/codecast";
  const result = await verifyRequiredReleaseAssets({ repo, tag, token });
  console.log(
    `Verified ${result.checked.length} required assets on ${repo}@${tag} (draft=${result.draft})`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
