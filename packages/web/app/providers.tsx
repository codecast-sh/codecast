"use client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ReactNode } from "react";
import { ThemeProvider } from "../components/ThemeProvider";
import { NavigationProgress } from "../components/NavigationProgress";
import { Toaster } from "sonner";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud");

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider client={convex}>
      <ThemeProvider>
        <NavigationProgress />
        {children}
        <Toaster position="top-right" richColors />
      </ThemeProvider>
    </ConvexAuthProvider>
  );
}
