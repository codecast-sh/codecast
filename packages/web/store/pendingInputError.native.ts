import { captureError } from "@platform/analytics/native";

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  captureError(error instanceof Error ? error : new Error(String(error)), context);
}
