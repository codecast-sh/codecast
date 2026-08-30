import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, Suspense, useRef } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useSearchParams, useRouter } from "next/navigation";
import { AppLoader } from "../../../components/AppLoader";
import { buildDesktopDeepLink } from "../../../lib/desktop";

function CliAuthContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip"
  );
  const createToken = useMutation(api.apiTokens.createToken);
  const depositCliAuth = useMutation(api.cliAuth.deposit);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { signIn } = useAuthActions();
  const [status, setStatus] = useState<"waiting" | "sending" | "success" | "error">("waiting");
  const [viaRelay, setViaRelay] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const oauthStarted = useRef(false);

  const nonce = searchParams.get("nonce");
  const port = searchParams.get("port");
  // The desktop app runs this same flow with mode=desktop: no localhost
  // listener to call back — delivery is always the server relay, which the
  // app watches via cliAuth.pendingDeposit.
  const isDesktopMode = searchParams.get("mode") === "desktop";
  // Which provider button was clicked in the desktop app. When this browser
  // has no session yet, we jump straight into that provider's OAuth instead
  // of parking the user on the login page.
  const provider = searchParams.get("provider");
  const device = searchParams.get("device") || (isDesktopMode ? "Codecast Desktop" : "CLI Device");
  const deviceName = decodeURIComponent(device);

  const deliverAuth = async () => {
    setStatus("sending");

    let tokenResult: { token: string };
    try {
      tokenResult = await createToken({ name: deviceName });
    } catch (err) {
      console.error("Auth token mint error:", err);
      setStatus("error");
      setErrorMessage(
        "Couldn't create an API token for this device. Please reload this page and try again."
      );
      return;
    }

    if (!isDesktopMode) {
      // Target 127.0.0.1 explicitly (not "localhost"): on macOS "localhost"
      // resolves to ::1 first, but the CLI auth server binds IPv4 only. Safari
      // does not fall back from a refused IPv6 connection, so a "localhost"
      // fetch fails with "Load failed". 127.0.0.1 matches the bind exactly.
      let response: Response | null = null;
      try {
        response = await fetch(`http://127.0.0.1:${port}/callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: currentUser!._id,
            apiToken: tokenResult.token,
            nonce: nonce,
          }),
        });
      } catch (err) {
        // fetch() only throws on a transport failure: nothing is listening on
        // that port — most often because the CLI runs on a DIFFERENT machine
        // (cast auth over SSH; 127.0.0.1 here is the browser's machine). Fall
        // through to the server relay below: the CLI polls for it by nonce
        // while it waits, so a remote auth still completes hands-free.
        console.error("Auth callback connection error, relaying via server:", err);
      }

      if (response) {
        if (!response.ok) {
          // The server answered but refused — most often a stale nonce from an
          // earlier `cast auth` run still holding the port.
          console.error("Auth callback rejected:", response.status);
          setStatus("error");
          setErrorMessage(
            "The CLI rejected this sign-in. It may be left over from an earlier 'cast auth' run."
          );
          return;
        }
        setStatus("success");
        return;
      }
    }

    try {
      await depositCliAuth({
        nonce: nonce!,
        token: tokenResult.token,
        device_name: deviceName,
      });
      setViaRelay(true);
      setStatus("success");
    } catch (relayErr) {
      console.error("Auth relay deposit error:", relayErr);
      setStatus("error");
      setErrorMessage(
        isDesktopMode
          ? "Couldn't hand the sign-in to the desktop app. Go back to Codecast and try again."
          : `Couldn't reach the cast CLI on 127.0.0.1:${port}. It may have stopped waiting.`
      );
    }
  };

  useWatchEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      const returnPath = `/auth/cli?${new URLSearchParams(searchParams.toString()).toString()}`;
      // Desktop provider hint: run that provider's OAuth right here and come
      // back to this page authed — the user already said which account kind
      // they want, so the login page would be a pointless stop.
      if ((provider === "apple" || provider === "github") && !oauthStarted.current) {
        oauthStarted.current = true;
        signIn(provider, { redirectTo: returnPath }).catch(() => {
          router.push(`/login?return_to=${encodeURIComponent(returnPath)}`);
        });
        return;
      }
      if (oauthStarted.current) {
        return; // OAuth redirect in flight
      }
      // Most people running `cast auth` already have an account — send them to
      // sign-in (which links to sign-up), not the other way around. /login
      // preserves return_to and bounces back here once the session exists.
      router.push(`/login?return_to=${encodeURIComponent(returnPath)}`);
      return;
    }

    if (!currentUser) {
      return;
    }

    if (!nonce || (!port && !isDesktopMode)) {
      setStatus("error");
      setErrorMessage("Missing nonce or port parameters");
      return;
    }

    // Both modes wait for the explicit Authorize click below — an emailed
    // link must not be able to connect a stranger's device just by being
    // opened in a signed-in browser.
  }, [isAuthenticated, isLoading, currentUser, nonce, port, device, provider, router, signIn]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <AppLoader
            className="min-h-0 bg-transparent"
            size={32}
            label={
              provider === "apple" || provider === "github"
                ? `Continuing to ${provider === "apple" ? "Apple" : "GitHub"} sign-in...`
                : "Redirecting to login..."
            }
          />
        </div>
      </div>
    );
  }

  // The browser holds the session; connecting a device is an explicit grant,
  // so both modes get a real consent step showing which account is about to
  // be handed over — never an auto-fire on page load.
  if (status === "waiting") {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-sol-text mb-2">
              {isDesktopMode ? "Sign in to the desktop app" : "Connect your terminal"}
            </h1>
            <p className="text-sol-text-muted mb-6">
              {deviceName} will be {isDesktopMode ? "signed in" : "connected"} as{" "}
              <span className="text-sol-text">{currentUser?.email ?? "your account"}</span>.
            </p>
            <button
              onClick={deliverAuth}
              className="w-full py-3 px-4 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg"
            >
              Authorize
            </button>
            <p className="text-sol-text-dim text-sm mt-4">
              Didn&apos;t request this from {isDesktopMode ? "the Codecast app" : "cast auth"}? Close this page.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "sending") {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <div className="text-center">
            <AppLoader className="min-h-0 bg-transparent mb-4" size={32} />
            <h1 className="text-2xl font-semibold text-sol-text mb-2">
              {isDesktopMode ? "Signing in the desktop app" : "Authenticating CLI"}
            </h1>
            <p className="text-sol-text-muted">
              Generating API token for {deviceName}...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <div className="text-center">
            <div className="mb-4">
              <svg
                className="mx-auto h-12 w-12 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold text-sol-text mb-2">
              Authentication Failed
            </h1>
            <p className="text-sol-text-muted mb-5">{errorMessage}</p>
            {isDesktopMode ? (
              <p className="text-sol-text-muted text-sm">
                Switch back to the Codecast app and start the sign-in again — it
                will open a fresh page here.
              </p>
            ) : (
            <div className="text-left bg-sol-bg-alt/60 rounded-lg p-4 text-sm">
              <p className="text-sol-text-muted mb-2">To finish connecting:</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sol-text-muted">
                <li>
                  Re-run <code className="text-amber-400">cast auth</code> in your
                  terminal and complete it within 5 minutes.
                </li>
                <li>
                  Or skip the browser entirely: open{" "}
                  <a
                    href="/settings/cli"
                    className="text-amber-400 hover:text-amber-300 underline"
                  >
                    Settings → CLI
                  </a>
                  , generate a token, and run{" "}
                  <code className="text-amber-400">cast login &lt;token&gt;</code>.
                </li>
              </ol>
            </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
        <div className="text-center">
          <div className="mb-4">
            <svg
              className="mx-auto h-12 w-12 text-green-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-sol-text mb-2">
            {isDesktopMode ? "Desktop app signed in" : "CLI Authenticated"}
          </h1>
          {isDesktopMode ? (
            <>
              <p className="text-sol-text-muted mb-6">
                Codecast will finish signing in on its own in a moment — you can
                close this tab and switch back to it.
              </p>
              <a
                href={buildDesktopDeepLink("/inbox")}
                className="inline-block py-3 px-6 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
              >
                Open Codecast
              </a>
            </>
          ) : (
            <>
              <p className="text-sol-text-muted mb-2">
                {viaRelay
                  ? "Signed in — your terminal will finish connecting in a few seconds."
                  : "Your terminal is now connected to codecast."}
              </p>
              <p className="text-sol-text-dim text-sm mb-6">
                Device: {deviceName}
              </p>
              <p className="text-sol-text-muted text-sm">
                {viaRelay
                  ? "You can close this window. If cast auth already stopped waiting, re-run it and sign in again."
                  : "You can close this window and return to your terminal."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <Suspense
      fallback={
        <AppLoader />
      }
    >
      <CliAuthContent />
    </Suspense>
  );
}
