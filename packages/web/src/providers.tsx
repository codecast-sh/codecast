import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ReactNode, useRef } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NavigationProgress } from "@/components/NavigationProgress";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/sonner";
import { DesktopProvider } from "@/components/DesktopProvider";
import { ShortcutProvider } from "@/shortcuts";
import { TipProvider } from "@/tips/TipProvider";
import { useLocalStorageMigration } from "@/hooks/useLocalStorageMigration";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { identifyUser, resetUser } from "@/lib/analytics";

function PrefsMigration() {
  useLocalStorageMigration();
  return null;
}

function AnalyticsIdentify() {
  const { user } = useCurrentUser();
  const lastId = useRef<string | null>(null);
  const id = user?._id ?? null;
  if (id && id !== lastId.current) {
    lastId.current = id;
    identifyUser(id, {
      email: user!.email,
      name: user!.name,
      github_username: user!.github_username,
    });
  } else if (!id && lastId.current) {
    lastId.current = null;
    resetUser();
  }
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
        <ShortcutProvider>
        <TipProvider>
        <NavigationProgress />
        {children}
        <ErrorBoundary name="DesktopProvider" level="inline">
          <DesktopProvider />
        </ErrorBoundary>
        <PrefsMigration />
        <AnalyticsIdentify />
        <Toaster position="bottom-right" />
        </TipProvider>
        </ShortcutProvider>
      </ThemeProvider>
    </ConvexAuthProvider>
  );
}
