// The transactional emails every app needs, as functions of brand + params.
// Each returns {subject, html, text}. App specific emails (team invites,
// digests, comment notices) live in the app and use the same block DSL.
//
// Copy rules: subjects say what happened and name the product; one time codes
// lead the subject so inbox previews and OTP autofill can pick them up; every
// email states in the footer why it was received; anything the user did NOT
// initiate says clearly what to do if it wasn't them.

import { type Brand, resolveBrand } from "./brand";
import { createRenderer, type EmailBlock, type RenderOptions, type RenderedEmail } from "./render";

export const OTP_EXPIRY_MINUTES = 15;

/** A fixed, unambiguous UTC stamp: security notices read the same everywhere. */
export function formatWhen(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface CodeEmailParams {
  code: string;
  email: string;
  /** Minutes until the code expires. Default 15. */
  expiryMinutes?: number;
}

export interface PasswordChangedParams {
  email: string;
  changedAt: number;
  /** Where "Secure my account" points. Default `${brand.url}/forgot-password`. */
  resetUrl?: string;
}

export interface WelcomeParams {
  email: string;
  name?: string;
  /** Subject line. Default `Welcome to ${brand.name}`. */
  subject?: string;
  /** Inbox preview line. Default the brand tagline. */
  preheader?: string;
  /** Card heading. Default "Welcome". */
  heading?: string;
  /**
   * First paragraph, placed after the greeting ("Welcome, Ada."). Default
   * `${brand.name} is ${brand.tagline}.` with the tagline lowercased.
   */
  intro?: string;
  /** Blocks between the intro and the button: product tour, install steps. */
  blocks?: EmailBlock[];
  /** Call to action. Default "Open ${brand.name}" to the brand URL. */
  cta?: { label: string; url: string };
  /** Closing note. Default invites a reply to the support address. */
  note?: string;
}

export interface Templates {
  verifyEmail(params: CodeEmailParams, opts?: RenderOptions): RenderedEmail;
  passwordReset(params: CodeEmailParams, opts?: RenderOptions): RenderedEmail;
  passwordChanged(params: PasswordChangedParams, opts?: RenderOptions): RenderedEmail;
  welcome(params: WelcomeParams, opts?: RenderOptions): RenderedEmail;
}

/** Bind the generic templates to one brand. */
export function createTemplates(brandInput: Brand): Templates {
  const brand = resolveBrand(brandInput);
  const render = createRenderer(brand);

  return {
    verifyEmail(args, opts) {
      const minutes = args.expiryMinutes ?? OTP_EXPIRY_MINUTES;
      return render(
        {
          subject: `${args.code} is your ${brand.name} verification code`,
          preheader: `Enter this code to confirm ${args.email}. It expires in ${minutes} minutes.`,
          eyebrow: "verify your email",
          heading: "Confirm your email address",
          blocks: [
            {
              kind: "text",
              value: `Enter this code to finish creating your ${brand.name} account for **${args.email}**.`,
            },
            { kind: "code", code: args.code, hint: `expires in ${minutes} minutes` },
            {
              kind: "note",
              value: `Didn't create a ${brand.name} account? You can safely ignore this email — nothing happens without the code.`,
            },
          ],
          reason: `You received this email because ${args.email} was used to sign up at ${brand.host}.`,
        },
        opts,
      );
    },

    passwordReset(args, opts) {
      const minutes = args.expiryMinutes ?? OTP_EXPIRY_MINUTES;
      return render(
        {
          subject: `Reset your ${brand.name} password`,
          preheader: `Your reset code is ${args.code}. It expires in ${minutes} minutes.`,
          eyebrow: "password reset",
          heading: "Reset your password",
          blocks: [
            {
              kind: "text",
              value: `We received a request to reset the password for **${args.email}**. Enter this code to choose a new one.`,
            },
            { kind: "code", code: args.code, hint: `expires in ${minutes} minutes` },
            {
              kind: "note",
              value:
                "Didn't request this? Ignore this email — your password stays unchanged unless the code is used.",
            },
          ],
          reason: `You received this email because a password reset was requested for ${args.email} at ${brand.host}.`,
        },
        opts,
      );
    },

    passwordChanged(args, opts) {
      return render(
        {
          subject: `Your ${brand.name} password was changed`,
          preheader: "If this was you, no action is needed.",
          eyebrow: "security",
          heading: "Your password was changed",
          blocks: [
            { kind: "text", value: `The password for your ${brand.name} account was just changed.` },
            {
              kind: "meta",
              rows: [
                { label: "account", value: args.email },
                { label: "when", value: formatWhen(args.changedAt) },
              ],
            },
            { kind: "text", value: "If this was you, no action is needed." },
            {
              kind: "text",
              value: `If this **wasn't** you, someone else may have access to your account. Reset your password now and email us at **${brand.supportEmail}**.`,
            },
            {
              kind: "button",
              label: "Secure my account",
              url: args.resetUrl ?? `${brand.url}/forgot-password`,
            },
          ],
          reason: `You received this security notice because the password for ${args.email} was changed at ${brand.host}.`,
        },
        opts,
      );
    },

    welcome(args, opts) {
      const greeting = args.name?.trim() ? `Welcome, ${args.name.trim()}.` : "Welcome.";
      const intro = args.intro ?? `${brand.name} is ${brand.tagline.toLowerCase()}.`;
      const cta = args.cta ?? { label: `Open ${brand.name}`, url: brand.url };
      return render(
        {
          subject: args.subject ?? `Welcome to ${brand.name}`,
          preheader: args.preheader ?? brand.tagline,
          eyebrow: "welcome",
          heading: args.heading ?? "Welcome",
          blocks: [
            { kind: "text", value: `${greeting} ${intro}` },
            ...(args.blocks ?? []),
            { kind: "button", label: cta.label, url: cta.url },
            {
              kind: "note",
              value:
                args.note ??
                `Questions? Just reply — or write **${brand.supportEmail}**. A human reads every message.`,
            },
          ],
          reason: `You received this one-time email because ${args.email} created a ${brand.name} account.`,
        },
        opts,
      );
    },
  };
}
