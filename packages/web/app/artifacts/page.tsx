"use client";
// /pages (alias /artifacts) — published-page gallery for the signed-in user.

import { AuthGuard } from "../../components/AuthGuard";
import { ArtifactGallery } from "../../components/artifacts/ArtifactGallery";

export default function ArtifactsPage() {
  return (
    <AuthGuard>
      <ArtifactGallery />
    </AuthGuard>
  );
}
