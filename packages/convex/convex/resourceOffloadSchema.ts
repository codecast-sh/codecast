import { v } from "convex/values";

export const resourceOffloadSelection = v.object({ conversation_id: v.id("conversations"), session_id: v.string(), destination_id: v.string(), attested: v.array(v.string()) });
export const resourceOffloadIntent = v.object({ client_batch_id: v.string(), source_device_id: v.string(), selections: v.array(resourceOffloadSelection), wait_for_idle_ms: v.number() });
