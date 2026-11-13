// Cast machines: one cloud machine per person, launched and woken by this
// backend in codecast's own AWS account, so a person with no CLI can start a
// session (castMachines.ts). Spliced into schema.ts as `...castMachineTables`.
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const castMachineStatus = v.union(
  v.literal("launching"), // waiting to call RunInstances (or retrying it)
  v.literal("waiting_capacity"), // the running cap is full; retried on a timer
  v.literal("booting"), // instance exists, its daemon has not signed in yet
  v.literal("ready"), // signed in: device_id names its daemon
  v.literal("failed"),
);

export const castMachineTables = {
  cast_machines: defineTable({
    user_id: v.id("users"),
    region: v.string(),
    status: castMachineStatus,
    instance_id: v.optional(v.string()),
    device_id: v.optional(v.string()),
    // sha256 of the one-hour setup token the machine's first boot redeems;
    // the exchange names the device it bound, which is how we learn device_id.
    voucher_hash: v.optional(v.string()),
    // sha256 of the key pi on this machine presents to the model proxy.
    proxy_key_hash: v.optional(v.string()),
    // Sessions started before the machine signed in; started on it at sign-in.
    held_conversation_ids: v.array(v.id("conversations")),
    launch_attempts: v.number(),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_voucher_hash", ["voucher_hash"])
    .index("by_proxy_key_hash", ["proxy_key_hash"])
    .index("by_device", ["user_id", "device_id"]),
};
