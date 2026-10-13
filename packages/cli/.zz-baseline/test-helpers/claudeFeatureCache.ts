// The remote feature flags Claude Code cached in this machine's ~/.claude.json,
// with the machine's answers to the prompts those flags raise. Some flags
// change what a pane does with input, notably the <pasted_content> paste
// wrapper (tengu_virtual_pancake, 2.1.277+), and a fresh config dir starts
// without them, so a scratch session that should paste the way a real one does
// seeds them from here. Others raise a startup prompt (the fullscreen renderer
// upsell, tengu_flickering_rain) that this machine already answered; its seen
// count comes along so the scratch pane opens on the composer as the human's
// sessions do. Shared by scripts/lib/claudeScratch.ts and the matrix harness
// (messagingHarness.ts).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ANSWERED_PROMPTS = ["fullscreenUpsellSeenCount"] as const;

export function machineClaudeFeatureCache(): Record<string, unknown> {
  let machine: Record<string, unknown> = {};
  try {
    machine = JSON.parse(fs.readFileSync(path.join(process.env.HOME || os.homedir(), ".claude.json"), "utf8"));
  } catch { /* no machine cache */ }
  const answered = Object.fromEntries(ANSWERED_PROMPTS.filter((k) => machine[k] !== undefined).map((k) => [k, machine[k]]));
  return { cachedGrowthBookFeatures: machine.cachedGrowthBookFeatures ?? {}, cachedGrowthBookFeaturesAt: Date.now(), ...answered };
}

// Whether this machine's cached flags turn on the <pasted_content> paste
// wrapper, so a scratch pane seeded from them wraps a paste the same way.
export function machinePasteWrapperOn(): boolean {
  const features = machineClaudeFeatureCache().cachedGrowthBookFeatures as Record<string, unknown>;
  return features.tengu_virtual_pancake === true;
}
