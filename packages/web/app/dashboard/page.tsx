"use client";

import { AuthGuard } from "../../components/AuthGuard";

export default function DashboardPage() {
  return (
    <AuthGuard>
      <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-semibold text-white tracking-tight mb-6">
            Dashboard
          </h1>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-xl p-6">
            <p className="text-slate-400">Welcome to your dashboard.</p>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
