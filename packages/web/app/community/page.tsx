"use client";

// /community — the product's public chat: the chat page in community scope.
// Readable by anyone, open to every signed in user. See app/chat/page.tsx.
import ChatPage from "../chat/page";

export default function CommunityPage() {
  return <ChatPage scope="community" />;
}
