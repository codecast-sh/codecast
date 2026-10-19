import { execFileAsync, whichBin } from "./proc.js";

// iPhone photos are HEIC, and older app builds uploaded them as they were,
// under whatever Content-Type the picker guessed. No agent reads HEIC (Claude
// and Codex take PNG, JPEG, GIF and WebP), so the daemon turns one into a JPEG
// before handing its path over.

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);

/** True for HEIF/HEIC bytes: an ISO media box whose major brand is HEIF's. */
export function isHeicImage(data: Buffer): boolean {
  return data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp" && HEIC_BRANDS.has(data.subarray(8, 12).toString("ascii"));
}

type Exec = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>;

/** The converters this machine has, best first: macOS's sips, then libheif's
 *  heif-convert and ImageMagick on Linux hosts. */
function converters(platform: NodeJS.Platform, which: (name: string) => string | null): Array<[string, (src: string, dest: string) => string[]]> {
  const out: Array<[string, (src: string, dest: string) => string[]]> = [];
  if (platform === "darwin") out.push(["/usr/bin/sips", (src, dest) => ["-s", "format", "jpeg", src, "--out", dest]]);
  const heifConvert = which("heif-convert");
  if (heifConvert) out.push([heifConvert, (src, dest) => ["-q", "90", src, dest]]);
  const magick = which("magick");
  if (magick) out.push([magick, (src, dest) => [src, dest]]);
  return out;
}

/** Write a JPEG of the HEIC at `src` to `dest`. False when no converter is
 *  installed or every one failed; the caller keeps the original then. */
export async function heicToJpeg(
  src: string,
  dest: string,
  deps: { exec?: Exec; platform?: NodeJS.Platform; which?: (name: string) => string | null } = {},
): Promise<boolean> {
  const exec = deps.exec ?? (execFileAsync as unknown as Exec);
  for (const [bin, args] of converters(deps.platform ?? process.platform, deps.which ?? ((n) => whichBin(n)))) {
    try {
      await exec(bin, args(src, dest), { timeout: 30_000 });
      return true;
    } catch {
      // try the next converter
    }
  }
  return false;
}
