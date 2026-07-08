/**
 * Entity link knowledge now lives in `@codecast/shared/entities` so the CLI's
 * `cast link` command and the web entity pills share one source of truth for
 * "what URL addresses this object". This module re-exports it unchanged so the
 * existing `@/lib/entityLinks` import sites keep working.
 */
export * from "@codecast/shared/entities";
