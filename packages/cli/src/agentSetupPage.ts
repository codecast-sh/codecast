/**
 * The web page that explains `cast browser` / `cast computer` and walks a
 * person through their setup (contracts/agentToolSetup.ts agentSetupPagePath).
 * The link names this machine, so a signed-in page shows where setup stands
 * here and starts each step here.
 */

import { agentSetupPageUrl, type AgentSetupTool } from "@codecast/shared/contracts";
import { webBaseUrl } from "./config/readLocalConfig.js";
import { deviceId } from "./remote/device.js";

export function agentSetupPageLink(tool: AgentSetupTool): string {
  let device: string | undefined;
  try { device = deviceId(); } catch { /* the page falls back to the viewer's machines */ }
  return agentSetupPageUrl(tool, webBaseUrl(), device);
}
