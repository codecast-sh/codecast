"use client";
// /vault — the team Vault. Files lived here before it moved to /files, and its
// links (/vault?f=…) are written into notes and transcripts, so a /vault URL
// carrying a Files query is sent on to /files unchanged (lib/vault/vaultHref.ts).

import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { VaultPage } from "../../components/secrets/VaultPage";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { legacyFilesHref } from "../../lib/vault/vaultHref";

export default function VaultRoute() {
  const router = useRouter();
  const filesHref = legacyFilesHref(`/vault?${useSearchParams().toString()}`);

  useWatchEffect(() => {
    if (filesHref) router.replace(filesHref);
  }, [filesHref, router]);

  if (filesHref) return null;
  return (
    <AuthGuard>
      <VaultPage />
    </AuthGuard>
  );
}
