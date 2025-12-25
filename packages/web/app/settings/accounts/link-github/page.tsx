"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

interface GitHubLinkData {
  github_id: string;
  github_username: string;
  github_avatar_url: string;
  github_access_token: string;
}

function getCookie(name: string): string | null {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || null;
  return null;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

export default function LinkGitHubPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const linkGitHub = useMutation(api.users.linkGitHub);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"checking" | "redirecting" | "linking" | "error">("checking");
  const processedRef = useRef(false);

  useEffect(() => {
    if (isLoading || processedRef.current) return;

    if (!isAuthenticated) {
      router.replace("/login?return_to=/settings/accounts");
      return;
    }

    const cookieData = getCookie("github_link_data");

    if (cookieData) {
      processedRef.current = true;
      deleteCookie("github_link_data");
      setStatus("linking");

      let data: GitHubLinkData;
      try {
        data = JSON.parse(decodeURIComponent(cookieData));
      } catch {
        setError("Invalid GitHub data received");
        setStatus("error");
        return;
      }

      linkGitHub({
        github_id: data.github_id,
        github_username: data.github_username,
        github_avatar_url: data.github_avatar_url,
        github_access_token: data.github_access_token,
      })
        .then(() => {
          router.replace("/settings/accounts");
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to link GitHub account");
          setStatus("error");
        });
    } else {
      processedRef.current = true;
      setStatus("redirecting");
      window.onbeforeunload = null;
      window.location.href = "/api/github/link";
    }
  }, [isAuthenticated, isLoading, router, linkGitHub]);

  if (isLoading || status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-bg">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-sol-cyan border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-sol-text">Loading...</div>
        </div>
      </div>
    );
  }

  if (status === "redirecting") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-bg">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-sol-cyan border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-sol-text">Redirecting to GitHub...</div>
        </div>
      </div>
    );
  }

  if (status === "linking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-bg">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-sol-cyan border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-sol-text">Linking GitHub account...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-bg">
        <div className="text-center max-w-md">
          <div className="text-red-400 mb-4">{error}</div>
          <button
            onClick={() => router.push("/settings/accounts")}
            className="px-4 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sol-text hover:bg-sol-bg-alt/80"
          >
            Back to Settings
          </button>
        </div>
      </div>
    );
  }

  return null;
}
