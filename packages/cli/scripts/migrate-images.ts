#!/usr/bin/env bun
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

const POSITIONS_FILE = path.join(
  process.env.HOME || "",
  ".codecast",
  "positions.json"
);

async function findSessionsWithImages(): Promise<string[]> {
  const claudeProjectsDir = path.join(
    process.env.HOME || "",
    ".claude",
    "projects"
  );

  const sessionFiles = await glob(`${claudeProjectsDir}/**/*.jsonl`);
  const sessionsWithImages: string[] = [];

  for (const file of sessionFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      if (content.includes('"type":"image"')) {
        sessionsWithImages.push(file);
      }
    } catch {
      // Skip files we can't read
    }
  }

  return sessionsWithImages;
}

async function resetPositions(sessionPaths: string[]): Promise<number> {
  if (!fs.existsSync(POSITIONS_FILE)) {
    console.log("No positions file found");
    return 0;
  }

  const positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
  let resetCount = 0;

  for (const sessionPath of sessionPaths) {
    if (sessionPath in positions) {
      delete positions[sessionPath];
      resetCount++;
    }
  }

  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions));
  return resetCount;
}

async function main() {
  console.log("🔍 Finding sessions with images...");
  const sessionsWithImages = await findSessionsWithImages();
  console.log(`   Found ${sessionsWithImages.length} sessions with images`);

  if (sessionsWithImages.length === 0) {
    console.log("✅ No sessions with images found");
    return;
  }

  // Show sample of sessions
  console.log("\n📁 Sample sessions:");
  for (const session of sessionsWithImages.slice(0, 5)) {
    const basename = path.basename(session);
    console.log(`   ${basename}`);
  }
  if (sessionsWithImages.length > 5) {
    console.log(`   ... and ${sessionsWithImages.length - 5} more`);
  }

  console.log("\n🔄 Resetting positions to force resync...");
  const resetCount = await resetPositions(sessionsWithImages);
  console.log(`   Reset ${resetCount} positions`);

  console.log("\n✅ Migration complete!");
  console.log("   The daemon will resync these sessions on next run.");
  console.log("   Images will be uploaded to Convex storage.");
  console.log("\n⚠️  Note: This may take a while depending on the number of sessions.");
  console.log("   Monitor progress with: tail -f ~/.codecast/daemon.log");
}

main().catch(console.error);
