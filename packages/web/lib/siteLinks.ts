import { BROWSER_EXTENSION_STORE_URL } from "@codecast/shared/contracts";

/**
 * Every outward link the marketing site repeats: community, source, socials,
 * and the support mailboxes. One place to change an invite or a handle.
 */
export const SITE_LINKS = {
  // The public community chat: codecast's own channels, readable by anyone
  // and open to every signed-in user (app/chat in community scope).
  community: "/community",
  githubOrg: "https://github.com/codecast-sh",
  githubRepo: "https://github.com/codecast-sh/codecast",
  githubIssues: "https://github.com/codecast-sh/codecast/issues",
  x: "https://x.com/codecastsh",
  appStore: "https://apps.apple.com/app/id6757820850",
  chromeExtension: BROWSER_EXTENSION_STORE_URL,
  supportEmail: "support@codecast.sh",
  securityEmail: "security@codecast.sh",
  enterpriseEmail: "enterprise@codecast.sh",
} as const;
