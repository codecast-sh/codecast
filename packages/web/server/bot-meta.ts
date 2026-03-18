import type { Context, Next } from "hono";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/convex/_generated/api.js";
import type { Id } from "../../convex/convex/_generated/dataModel";

const BOT_UA_PATTERNS = [
  "Googlebot", "bingbot", "Slackbot", "Twitterbot", "facebookexternalhit",
  "LinkedInBot", "Discordbot", "WhatsApp", "TelegramBot", "Applebot",
  "Pinterestbot", "redditbot", "Embedly", "Quora Link Preview",
  "Showyoubot", "outbrain", "rogerbot", "vkShare", "W3C_Validator",
];

function isBot(ua: string | undefined): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERNS.some((p) => ua.includes(p));
}

const convexUrl = process.env.VITE_CONVEX_URL || "https://convex.codecast.sh";
const convex = new ConvexHttpClient(convexUrl);

const BASE_URL = "https://codecast.sh";

function ogHtml(meta: { title: string; description: string; url: string; image?: string }) {
  const img = meta.image || `${BASE_URL}/logo-final.png`;
  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8" />
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}" />
  <meta property="og:title" content="${esc(meta.title)}" />
  <meta property="og:description" content="${esc(meta.description)}" />
  <meta property="og:url" content="${esc(meta.url)}" />
  <meta property="og:site_name" content="codecast" />
  <meta property="og:type" content="article" />
  <meta property="og:image" content="${esc(img)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${esc(meta.title)}" />
  <meta name="twitter:description" content="${esc(meta.description)}" />
  <meta name="twitter:image" content="${esc(img)}" />
</head><body></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONVEX_ID_REGEX = /^[a-z0-9]{32}$/;

async function getConversationMeta(id: string) {
  if (!CONVEX_ID_REGEX.test(id)) return null;
  try {
    const meta = await convex.query(api.conversations.getConversationMeta, {
      conversation_id: id as Id<"conversations">,
    });
    if (!meta) return null;
    const title = meta.title || "Coding Session";
    const description = meta.description
      || (meta.author ? `${meta.message_count} messages by ${meta.author}` : `${meta.message_count} messages`);
    return { title: `${title} - codecast`, description, url: `${BASE_URL}/conversation/${id}` };
  } catch {
    return null;
  }
}

async function getShareMeta(token: string) {
  try {
    const meta = await convex.query(api.conversations.getSharedConversationMeta, {
      share_token: token,
    });
    if (!meta) return null;
    const title = meta.title || "Shared Conversation";
    const description = meta.description
      || (meta.author ? `${meta.message_count} messages by ${meta.author}` : `${meta.message_count} messages`);
    return { title: `${title} - codecast`, description, url: `${BASE_URL}/share/${token}` };
  } catch {
    return null;
  }
}

async function getShareMessageMeta(token: string) {
  try {
    const meta = await convex.query(api.messages.getSharedMessageMeta, {
      share_token: token,
    });
    if (!meta) return null;
    const title = meta.title || "Shared Message";
    const description = meta.description || "A shared coding conversation";
    return { title: `${title} - codecast`, description, url: `${BASE_URL}/share/message/${token}` };
  } catch {
    return null;
  }
}

const ROUTES: Array<{ pattern: RegExp; handler: (match: RegExpMatchArray) => Promise<{ title: string; description: string; url: string } | null> }> = [
  { pattern: /^\/conversation\/([a-z0-9]{32})$/, handler: (m) => getConversationMeta(m[1]) },
  { pattern: /^\/share\/message\/(.+)$/, handler: (m) => getShareMessageMeta(m[1]) },
  { pattern: /^\/share\/(.+)$/, handler: (m) => getShareMeta(m[1]) },
];

const STATIC_META: Record<string, { title: string; description: string }> = {
  "/": { title: "codecast", description: "Sync coding agent conversations to a shared database" },
  "/about": { title: "About - codecast", description: "About codecast" },
  "/features": { title: "CLI Features - codecast", description: "codecast CLI features and commands" },
  "/documentation": { title: "Documentation - codecast", description: "codecast documentation" },
  "/security": { title: "Security - codecast", description: "How codecast protects your data" },
  "/privacy": { title: "Privacy Policy - codecast", description: "codecast privacy policy" },
  "/terms": { title: "Terms of Service - codecast", description: "codecast terms of service" },
};

export async function botMetaMiddleware(c: Context, next: Next) {
  const ua = c.req.header("user-agent");
  if (!isBot(ua)) return next();

  const path = new URL(c.req.url).pathname;

  const staticMeta = STATIC_META[path];
  if (staticMeta) {
    return c.html(ogHtml({ ...staticMeta, url: `${BASE_URL}${path}` }));
  }

  for (const route of ROUTES) {
    const match = path.match(route.pattern);
    if (match) {
      const meta = await route.handler(match);
      if (meta) return c.html(ogHtml(meta));
      break;
    }
  }

  return next();
}
