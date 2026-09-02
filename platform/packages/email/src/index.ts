// @platform/email — brand injected transactional email: block DSL renderer,
// generic templates, delivery transports, and the digest policy.

// Brand
export {
  palette,
  monoStack,
  resolveBrand,
  senderAddress,
  type Brand,
  type BrandPalette,
  type ResolvedBrand,
} from "./brand";

// Render
export {
  createRenderer,
  renderEmail,
  escapeHtml,
  type EmailBlock,
  type EmailDef,
  type RenderedEmail,
  type RenderEmail,
  type RenderOptions,
} from "./render";

// Templates
export {
  createTemplates,
  formatWhen,
  OTP_EXPIRY_MINUTES,
  type CodeEmailParams,
  type PasswordChangedParams,
  type Templates,
  type WelcomeParams,
} from "./templates";

// Transports
export {
  createRelayTransport,
  createResendTransport,
  resendTransportForBrand,
  transportFromEnv,
  type EmailMessage,
  type FetchLike,
  type RelayTransportConfig,
  type ResendTransportConfig,
  type SendOptions,
  type Transport,
} from "./transports/index";

// Digest policy
export {
  ACTIVE_MS,
  COOLDOWN_MS,
  DEFAULT_DIGEST_POLICY,
  GRACE_MS,
  MAX_LOOKBACK_MS,
  WINDOW_MS,
  createEntryCapper,
  digestEligible,
  digestRange,
  generateUnsubscribeToken,
  isValidUnsubscribeToken,
  listUnsubscribeHeaders,
  runDigestSweep,
  sweepWindow,
  unsubscribeByToken,
  type DigestPolicy,
  type DigestRecipient,
  type DigestSweepHooks,
} from "./digest/policy";
export { unsubscribeResponse } from "./digest/unsubscribePage";
