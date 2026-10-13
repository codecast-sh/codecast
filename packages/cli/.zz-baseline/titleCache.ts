// Session titles the daemon has generated, keyed by agent session id
// (~/.codecast/titles.json). The daemon owns writes; anything else reads.

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "./config/configDir.js";

export interface TitleCache {
  [sessionId: string]: string;
}

const titleCacheFile = () => path.join(defaultConfigDir(), "titles.json");

export function readTitleCache(): TitleCache {
  try {
    return JSON.parse(fs.readFileSync(titleCacheFile(), "utf-8")) as TitleCache;
  } catch {
    return {};
  }
}

export function saveTitleCache(cache: TitleCache): void {
  fs.writeFileSync(titleCacheFile(), JSON.stringify(cache, null, 2));
}
