import { defineTable } from "convex/server";
import { v } from "convex/values";
import { TEAM_HOST_MEMBER_STATUSES } from "@codecast/shared/contracts/teamHosts";

/**
 * Team machines (docs/architecture/team-machines.md): a Linux box a team owns,
 * where each member runs as their own Linux user, daemon and Claude login.
 */
export const teamHostTables = {
  team_hosts: defineTable({
    // Who may see and join it. Membership is the access rule, as for device_shares.
    team_id: v.id("teams"),
    name: v.string(),
    // Written into the box's marker (/etc/codecast/shared-host): every daemon
    // there names the machine by it on its heartbeat.
    host_key: v.string(),
    // The person who registered it and the daemon running as the box's sudoer,
    // which carries out joins and removals.
    admin_user_id: v.id("users"),
    admin_device_id: v.string(),
    admin_linux_user: v.string(),
    // How to reach it over ssh (public address), for members who want a shell.
    address: v.optional(v.string()),
    platform: v.string(),
    created_at: v.number(),
  })
    .index("by_team", ["team_id"])
    .index("by_host_key", ["host_key"]),

  team_host_members: defineTable({
    host_id: v.id("team_hosts"),
    user_id: v.id("users"),
    linux_user: v.string(),
    // Their daemon's device, set by its first heartbeat from the box.
    device_id: v.optional(v.string()),
    status: v.union(...TEAM_HOST_MEMBER_STATUSES.map((s) => v.literal(s))),
    // While joining or removing: the step the admin daemon is on, and why it stopped.
    step: v.optional(v.string()),
    error: v.optional(v.string()),
    // The one-hour setup token the admin daemon exchanges for this member's
    // codecast login. Cleared when claimed; no query returns it.
    voucher: v.optional(v.string()),
    // Public keys installed for ssh: the member's laptop key when joining from the CLI.
    ssh_pubkey: v.optional(v.string()),
    requested_at: v.number(),
    ready_at: v.optional(v.number()),
  })
    .index("by_host", ["host_id"])
    .index("by_user", ["user_id"]),
};
