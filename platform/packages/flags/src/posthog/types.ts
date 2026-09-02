// The PostHog half: flags and experiments that only the UI reads. One
// interface, three adapters (browser SDK, React Native SDK, server HTTP).
// Anything a server must enforce belongs in the catalog half, not here.

export type FlagValue = boolean | string | undefined;

export interface FlagsClient {
  /** Is the flag on? Multivariate flags count as on when they have a variant. */
  getFlag: (key: string) => boolean;
  /** The JSON payload attached to the flag, or undefined. */
  getPayload: <T = unknown>(key: string) => T | undefined;
  /** The variant string of a multivariate flag; undefined when off or boolean. */
  getVariant: (key: string) => string | undefined;
  /** Fetch fresh flags. */
  reload: () => Promise<void>;
}

/** Normalize a raw SDK value into on/off and variant. */
export function splitFlagValue(value: FlagValue): { enabled: boolean; variant: string | undefined } {
  if (typeof value === "string") return { enabled: value.length > 0, variant: value };
  return { enabled: value === true, variant: undefined };
}
