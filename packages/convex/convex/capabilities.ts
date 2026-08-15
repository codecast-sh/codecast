// Re-export barrel. The functions live in capabilityState.ts,
// capabilityBindings.ts and capabilityCatalog.ts; this file keeps every
// existing address (api.capabilities.*) working, because Convex registers
// re-exported functions under the exporting module's path too.
//
// RULE (ct-42828): a new capability function goes in the module matching its
// concern — state (reporting, reads, fleet fold), bindings (writes, events,
// revision), catalog (external registry cache) — never back into this file.
// Thirteen tasks write this surface; three files merge cleanly, one does not.

export * from "./capabilityState";
export * from "./capabilityBindings";
export * from "./capabilityCatalog";
