import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ReactNode } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NavigationProgress } from "@/components/NavigationProgress";
import { Toaster } from "@/components/ui/sonner";
import { DesktopProvider } from "@/components/DesktopProvider";
import { SlideOutProvider } from "@/components/SlideOutProvider";
import { useLocalStorageMigration } from "@/hooks/useLocalStorageMigration";

function PrefsMigration() {
  useLocalStorageMigration();
  return null;
}

const convex: ConvexReactClient =
  import.meta.hot?.data?.convexClient ??
  new ConvexReactClient(import.meta.env.VITE_CONVEX_URL || "https://convex.codecast.sh", {
    unsavedChangesWarning: false,
  });

if (import.meta.hot) {
  import.meta.hot.data.convexClient = convex;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider client={convex}>
      <ThemeProvider>
        <NavigationProgress />
        {children}
        <DesktopProvider />
        <SlideOutProvider />
        <PrefsMigration />
        <Toaster position="bottom-right" />
      </ThemeProvider>
    </ConvexAuthProvider>
  );
}
