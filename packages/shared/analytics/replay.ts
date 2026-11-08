// The fraction of sessions PostHog records as a replay, on web, desktop and
// mobile alike. A recorded session serializes every DOM change (on the phone,
// walks the view tree) on the main thread: for everyone, that was one of the
// Aug 2026 idle slowdowns on web and froze taps on mobile, so it stays a
// sample. The package never records in development.
export const POSTHOG_REPLAY_SAMPLE_RATE = 0.1;
