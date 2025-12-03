import * as fs from "fs";
import * as path from "path";

const CONFIG_DIR = process.env.HOME + "/.code-chat-sync";
const POSITIONS_FILE = path.join(CONFIG_DIR, "positions.json");

interface Positions {
  [filePath: string]: number;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadPositions(): Positions {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
    }
  } catch {
    /* ignore parse errors, start fresh */
  }
  return {};
}

function savePositions(positions: Positions): void {
  ensureConfigDir();
  const tempFile = POSITIONS_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(positions, null, 2));
  fs.renameSync(tempFile, POSITIONS_FILE);
}

export function getPosition(filePath: string): number {
  return loadPositions()[filePath] || 0;
}

export function setPosition(filePath: string, offset: number): void {
  const positions = loadPositions();
  positions[filePath] = offset;
  savePositions(positions);
}

export function clearPosition(filePath: string): void {
  const positions = loadPositions();
  delete positions[filePath];
  savePositions(positions);
}
