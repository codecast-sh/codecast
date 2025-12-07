"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

function CliAuthContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip"
  );
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"waiting" | "sending" | "success" | "error">("waiting");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const nonce = searchParams.get("nonce");
  const port = searchParams.get("port");

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      const returnUrl = encodeURIComponent(
        `/auth/cli?nonce=${nonce}&port=${port}`
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

    const sendAuth = async () => {
      setStatus("sending");

      try {
        const response = await fetch(`http://localhost:${port}/callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: currentUser._id,
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
  }, [isAuthenticated, isLoading, currentUser, nonce, port, router]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-sol-base03 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-base02/50 rounded-lg p-8 border border-sol-base01">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto mb-4"></div>
            <p className="text-sol-base0">Redirecting to login...</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "waiting" || status === "sending") {
    return (
      <div className="min-h-screen bg-sol-base03 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-base02/50 rounded-lg p-8 border border-sol-base01">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto mb-4"></div>
            <h1 className="text-2xl font-semibold text-white mb-2">
              Authenticating CLI
            </h1>
            <p className="text-sol-base0">
              Sending authentication to your terminal...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-sol-base03 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-sol-base02/50 rounded-lg p-8 border border-sol-base01">
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
            <p className="text-sol-base0 mb-4">{errorMessage}</p>
            <p className="text-sol-base0 text-sm">
              Please return to your terminal and try the manual setup option.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sol-base03 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-sol-base02/50 rounded-lg p-8 border border-sol-base01">
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
            Authenticated Successfully!
          </h1>
          <p className="text-sol-base0 mb-4">
            You can now return to your terminal to continue setup.
          </p>
          <p className="text-sol-base0 text-sm">
            This window can be closed.
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
        <div className="min-h-screen bg-sol-base03 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-sol-base02/50 rounded-lg p-8 border border-sol-base01">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto mb-4"></div>
              <p className="text-sol-base0">Loading...</p>
            </div>
          </div>
        </div>
      }
    >
      <CliAuthContent />
    </Suspense>
  );
}
