"use client";
// /map: every live session on one zoomable canvas, in piles, with the org on top (components/sessionMap).
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { SessionMap } from "../../components/sessionMap/SessionMap";

export default function SessionMapPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <SessionMap />
      </DashboardLayout>
    </AuthGuard>
  );
}
