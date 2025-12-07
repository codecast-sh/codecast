import type { Metadata } from "next";
import { JetBrains_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "codecast",
  description: "Sync coding agent conversations to a shared database",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${jetbrainsMono.variable} ${fraunces.variable} ${jetbrainsMono.className}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
