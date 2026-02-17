"use client";

import { AuthGuard } from "../../components/AuthGuard";
import { QueuePageClient } from "./QueuePageClient";

export default function QueuePage() {
  return (
    <AuthGuard>
      <QueuePageClient />
    </AuthGuard>
  );
}
