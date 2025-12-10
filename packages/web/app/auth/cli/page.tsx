"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect, useState, Suspense, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";

function CliAuthContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip"
  );
  const createToken = useMutation(api.apiTokens.createToken);
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"waiting" | "sending" | "success" | "error">("waiting");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const hasStartedAuth = useRef(false);

  const nonce = searchParams.get("nonce");
  const port = searchParams.get("port");
  const device = searchParams.get("device") || "CLI Device";

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      const returnUrl = encodeURIComponent(
        `/auth/cli?nonce=${nonce}&port=${port}&device=${encodeURIComponent(device)}`
      );
      router.push(`/signup?return_to=${returnUrl}`);
      return;
    }

    if (!currentUser) {
      return;
    }

    if (!nonce || !port) {
      setStatus("error");
      setErrorMessage("Missing nonce or port parameters");
      return;
    }

    if (hasStartedAuth.current) {
      return;
    }
    hasStartedAuth.current = true;

    const sendAuth = async () => {
      setStatus("sending");

      try {
        const tokenResult = await createToken({ name: decodeURIComponent(device) });

        const response = await fetch(`http://localhost:${port}/callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: currentUser._id,
            apiToken: tokenResult.token,
            nonce: nonce,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to send authentication to CLI");
        }

        setStatus("success");
      } catch (err) {
        console.error("Auth callback error:", err);
        setStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to connect to CLI"
        );
      }
    };

    sendAuth();
  }, [isAuthenticated, isLoading, currentUser, nonce, port, device, router, createToken]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mx-auto mb-4"></div>
            <p className="text-sol-text-muted">Redirecting to login...</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "waiting" || status === "sending") {
    return (
      <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mx-auto mb-4"></div>
            <h1 className="text-2xl font-semibold text-white mb-2">
              Authenticating CLI
            </h1>
            <p className="text-sol-text-muted">
              Generating API token for {decodeURIComponent(device)}...
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
            <h1 className="text-2xl font-semibold text-white mb-2">
              Authentication Failed
            </h1>
            <p className="text-sol-text-muted mb-4">{errorMessage}</p>
            <p className="text-sol-text-muted text-sm">
              Please return to your terminal and try again with &apos;codecast auth&apos;
            </p>
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
          <h1 className="text-2xl font-semibold text-white mb-2">
            CLI Authenticated
          </h1>
          <p className="text-sol-text-muted mb-2">
            Your terminal is now connected to codecast.
          </p>
          <p className="text-sol-text-dim text-sm mb-6">
            Device: {decodeURIComponent(device)}
          </p>
          <p className="text-sol-text-muted text-sm">
            You can close this window and return to your terminal.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mx-auto mb-4"></div>
              <p className="text-sol-text-muted">Loading...</p>
            </div>
          </div>
        </div>
      }
    >
      <CliAuthContent />
    </Suspense>
  );
}
