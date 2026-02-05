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
  metadataBase: new URL("https://codecast.sh"),
  openGraph: {
    title: "codecast",
    description: "Sync coding agent conversations to a shared database",
    siteName: "codecast",
    type: "website",
    url: "https://codecast.sh",
  },
  twitter: {
    card: "summary",
    title: "codecast",
    description: "Sync coding agent conversations to a shared database",
  },
};

const themeScript = `
  (function() {
    var theme = localStorage.getItem('codecast-theme') || 'light';
    document.documentElement.classList.add(theme);
  })();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${jetbrainsMono.variable} ${fraunces.variable} ${jetbrainsMono.className}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
