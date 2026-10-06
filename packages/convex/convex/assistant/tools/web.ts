// The hosted assistant's web tools (plan pl-840): fetch_page and search_web
// are @platform/assistant's, and this module gives them codecast's
// transport. fetch_page reads through lib/publicFetch (a public host on every
// redirect hop, none of codecast's own pages, a byte cap, text only);
// search_web posts through lib/anthropic on the deployment's key, on the
// cheap model, and is offered only when that key is set. The turn rules read
// codecast's own formats for the user rows a machine writes: a decision
// answer resumes the turn it paused, and a routine fire is not the person's
// words, so neither starts a new search count nor lets a URL run unasked.
import type { Tool } from "@platform/agent";
import {
  fetchPageTool as platformFetchPageTool,
  searchEstimateUsd,
  searchWebTool as platformSearchWebTool,
  turnRowRules,
  webTools as platformWebTools,
  type WebDeps as PlatformWebDeps,
} from "@platform/assistant/web";
import { isMachineDeliveredMessage, parseDecisionAnswer } from "@codecast/shared/contracts";
import { CHEAP_MODEL, postMessages } from "../../lib/anthropic";
import { fetchPublicPage } from "../../lib/publicFetch";

export {
  PAGE_MAX_BYTES,
  PAGE_MAX_CHARS,
  SEARCH_ESTIMATE_INPUT_TOKENS,
  SEARCH_MAX_PER_TURN,
  searchSources,
  typedUrls,
  WEB_SCOPES,
  WEB_SEARCH_PRICE_USD,
  WEB_SEARCH_TOOL,
} from "@platform/assistant/web";

export interface WebDeps {
  /** The fetch fetch_page uses; tests pass a fake. */
  fetch?: typeof fetch;
}

const USER_AGENT = "Mozilla/5.0 (compatible; CodecastAssistant/1.0; +https://codecast.sh)";

/** The package's web deps on codecast's transport. search_web gets the
 *  Messages API only while the deployment's key is set. */
function webDeps(deps: WebDeps): PlatformWebDeps {
  return {
    readPage: (url, request) => fetchPublicPage(url, { ...request, fetch: deps.fetch }),
    ...(process.env.ANTHROPIC_API_KEY ? { messages: postMessages } : {}),
    searchModel: CHEAP_MODEL,
    userAgent: USER_AGENT,
  };
}

export const { isPersonTyped, pageAllowedWithoutAsking, turnRows, searchesBefore } = turnRowRules({
  isDecisionAnswer: (text) => !!parseDecisionAnswer(text),
  isMachineDelivered: isMachineDeliveredMessage,
});

/** The charge for a search whose usage was never read. */
export const SEARCH_ESTIMATE_USD = () => searchEstimateUsd(CHEAP_MODEL);

export function fetchPageTool(deps: WebDeps = {}): Tool {
  return platformFetchPageTool(webDeps(deps));
}

export function searchWebTool(deps: WebDeps = {}, searches = { made: 0 }): Tool {
  return platformSearchWebTool(webDeps(deps), searches);
}

/** The web tools. search_web needs the deployment's Anthropic key. */
export function webTools(deps: WebDeps = {}): Tool[] {
  return platformWebTools(webDeps(deps));
}
