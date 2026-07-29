import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NavigationProgress } from "@/components/NavigationProgress";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/sonner";
import { DesktopProvider } from "@/components/DesktopProvider";
import { OpenInDesktopHandoff } from "@/components/OpenInDesktopHandoff";
import { ShortcutProvider } from "@/shortcuts";
import { TipProvider } from "@/tips/TipProvider";
import { useLocalStorageMigration } from "@/hooks/useLocalStorageMigration";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { identifyUser, resetUser } from "@/lib/analytics";
import { durableAuthStorage } from "@/lib/durableAuthStorage";
import { CONVEX_URL } from "@/lib/localAuth";
import { PrincipalLocalStateProvider } from "@/components/PrincipalLocalStateProvider";

function PrefsMigration() {
  useLocalStorageMigration();
  return null;
}

// "Set session model didn't go through — not authorized". The command name
// rides convCommand's args; the reason is the last server refusal in the
// (possibly nested) error message, minus stack-frame and client-suffix noise.
function describeDispatchFailure(f: { action: string; args: unknown; message: string }): string {
  const command = f.action === "convCommand" && Array.isArray(f.args) ? String(f.args[1]) : f.action;
  const label = command
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
  const reason =
    f.message
      .split(/Uncaught (?:Convex)?Error:/)
      .pop()
      ?.split("\n")[0]
      ?.replace(/\s+at handler.*$/, "")
      .replace(/\s+Called by client.*$/, "")
      .trim() || "rejected by the server";
  const friendly = /not authorized/i.test(reason) ? "you don't have access to that session" : reason;
  return `${label} didn't go through — ${friendly}`;
}

// Turns a permanent dispatch rejection (recorded by useEnsureDispatch) into a
// visible toast. Lives here rather than in the shared hook because sonner is
// DOM-only and the hook is also bundled by the mobile app.
function DispatchFailureToast() {
  const failure = useInboxStore((s) => s.lastDispatchFailure);
  const lastShownAt = useRef(0);
  useEffect(() => {
    if (!failure || failure.at === lastShownAt.current) return;
    lastShownAt.current = failure.at;
    toast.error(describeDispatchFailure(failure));
  }, [failure]);
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
  new ConvexReactClient(CONVEX_URL, {
    unsavedChangesWarning: false,
  });

if (import.meta.hot) {
  import.meta.hot.data.convexClient = convex;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider client={convex} storage={durableAuthStorage}>
      <PrincipalLocalStateProvider>
      <ThemeProvider>
        <ShortcutProvider>
        <TipProvider>
        <NavigationProgress />
        {children}
        <ErrorBoundary name="DesktopProvider" level="inline">
          <DesktopProvider />
        </ErrorBoundary>
        <ErrorBoundary name="OpenInDesktopHandoff" level="inline">
          <OpenInDesktopHandoff />
        </ErrorBoundary>
        <PrefsMigration />
        <AnalyticsIdentify />
        <DispatchFailureToast />
        <Toaster position="bottom-right" />
        </TipProvider>
        </ShortcutProvider>
      </ThemeProvider>
      </PrincipalLocalStateProvider>
    </ConvexAuthProvider>
  );
}
