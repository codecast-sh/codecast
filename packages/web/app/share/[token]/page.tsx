import type { Metadata } from "next";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@codecast/convex/convex/_generated/api";
import SharedConversationClient from "./SharedConversationClient";

const BASE_URL = "https://codecast.sh";
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;

  try {
    const meta = await convex.query(api.conversations.getSharedConversationMeta, {
      share_token: token,
    });

    if (!meta) {
      return {
        title: "Shared Conversation - codecast",
        description: "A shared coding agent conversation",
      };
    }

    const title = `${meta.title} - codecast`;
    const description = meta.description
      || (meta.author ? `${meta.message_count} messages by ${meta.author}` : `${meta.message_count} messages`);

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        url: `${BASE_URL}/share/${token}`,
        siteName: "codecast",
        type: "article",
        images: [{ url: `${BASE_URL}/logo-final.png`, width: 1024, height: 1024, alt: "codecast" }],
        ...(meta.author && { authors: [meta.author] }),
      },
      twitter: {
        card: "summary",
        title,
        description,
        images: [`${BASE_URL}/logo-final.png`],
      },
    };
  } catch {
    return {
      title: "Shared Conversation - codecast",
      description: "A shared coding agent conversation",
    };
  }
}

export default function Page() {
  return <SharedConversationClient />;
}
