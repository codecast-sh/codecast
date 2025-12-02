import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "code-chat-sync",
  description: "Sync coding agent conversations to a shared database",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
