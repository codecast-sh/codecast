import type { Metadata } from "next";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import ConversationPageClient from "./ConversationPageClient";

const CONVEX_ID_REGEX = /^[a-z0-9]{32}$/;
const BASE_URL = "https://codecast.sh";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  if (!CONVEX_ID_REGEX.test(id)) {
    return {
      title: "codecast",
      description: "Coding agent conversation",
    };
  }

  try {
    const meta = await convex.query(api.conversations.getConversationMeta, {
      conversation_id: id as Id<"conversations">,
    });

    if (!meta) {
      return {
        title: "codecast",
        description: "Coding agent conversation",
      };
    }

    const title = meta.title;
    const description = meta.description
      || (meta.author ? `${meta.message_count} messages by ${meta.author}` : `${meta.message_count} messages`)
      + (meta.project_path ? ` in ${meta.project_path.split("/").pop()}` : "");

    return {
      title: `${title} - codecast`,
      description,
      openGraph: {
        title,
        description,
        url: `${BASE_URL}/conversation/${id}`,
        siteName: "codecast",
        type: "article",
        ...(meta.author && { authors: [meta.author] }),
      },
      twitter: {
        card: "summary",
        title,
        description,
      },
    };
  } catch {
    return {
      title: "codecast",
      description: "Coding agent conversation",
    };
  }
}

export default function Page() {
  return <ConversationPageClient />;
}
