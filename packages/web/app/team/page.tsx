import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import Link from "next/link";

export default function TeamPage() {
  const user = useQuery(api.users.getCurrentUser);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  const [searchTerm, setSearchTerm] = useState("");

  if (!user) {
    return null;
  }

  if (!user.team_id) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1">You are not part of a team.</p>
        </Card>
      </div>
    );
  }

  const getRelativeTime = (timestamp: number | undefined) => {
    if (!timestamp) return "Never";
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    if (hours === 1) return "1 hour ago";
    if (hours < 24) return `${hours} hours ago`;
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  const getMemberStatus = (timestamp: number | undefined) => {
    if (!timestamp) return "offline";
    const diff = Date.now() - timestamp;
    if (diff < 60000) return "online";
    if (diff < 300000) return "recent";
    return "offline";
  };

  const filteredMembers = teamMembers
    ?.filter((m): m is NonNullable<typeof m> => m !== null)
    .filter((member) => {
      const searchLower = searchTerm.toLowerCase();
      return (
        member.name?.toLowerCase().includes(searchLower) ||
        member.email?.toLowerCase().includes(searchLower)
      );
    });

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-sol-text mb-2">Team Directory</h1>
        <p className="text-sol-base1">
          {teamMembers?.length || 0} member{(teamMembers?.length || 0) !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="mb-6">
        <Input
          type="text"
          placeholder="Search team members..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="max-w-md bg-sol-bg-alt border-sol-border text-sol-text"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredMembers?.map((member) => {
          const status = getMemberStatus(member.daemon_last_seen);
          const lastSeen = getRelativeTime(member.daemon_last_seen);

          return (
            <Link
              key={member._id}
              href={member.github_username ? `/team/${member.github_username}` : "#"}
              className={member.github_username ? "" : "pointer-events-none"}
            >
              <Card className="p-4 bg-sol-bg border-sol-border hover:border-sol-cyan transition-colors cursor-pointer">
                <div className="flex items-start gap-3">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-full bg-sol-base02 flex items-center justify-center text-sol-text font-semibold">
                      {member.name?.[0]?.toUpperCase() || member.email?.[0]?.toUpperCase() || "?"}
                    </div>
                    <div
                      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-sol-bg ${
                        status === "online"
                          ? "bg-sol-green"
                          : status === "recent"
                          ? "bg-sol-yellow"
                          : "bg-sol-base01"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sol-text truncate">
                      {member.name || "Unnamed"}
                    </div>
                    {member.title && (
                      <div className="text-sm text-sol-base1 truncate">{member.title}</div>
                    )}
                    {!member.title && (
                      <div className="text-sm text-sol-base1 truncate">{member.email}</div>
                    )}
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {member.status && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            member.status === "available"
                              ? "bg-sol-green/20 text-sol-green"
                              : member.status === "busy"
                              ? "bg-sol-red/20 text-sol-red"
                              : "bg-sol-yellow/20 text-sol-yellow"
                          }`}
                        >
                          {member.status}
                        </span>
                      )}
                      {member.role && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            member.role === "admin"
                              ? "bg-sol-cyan/20 text-sol-cyan"
                              : "bg-sol-base02/20 text-sol-base1"
                          }`}
                        >
                          {member.role}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-sol-base01 mt-1">{lastSeen}</div>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      {filteredMembers?.length === 0 && (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1 text-center">No team members found.</p>
        </Card>
      )}
    </div>
  );
}
