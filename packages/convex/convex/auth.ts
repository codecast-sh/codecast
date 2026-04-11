import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Email } from "@convex-dev/auth/providers/Email";
import GitHub from "@auth/core/providers/github";
import Apple from "@auth/core/providers/apple";
import { Resend as ResendAPI } from "resend";
import { alphabet, generateRandomString } from "oslo/crypto";

const ResendOTPPasswordReset = Email({
  id: "resend-otp-password-reset",
  apiKey: process.env.RESEND_API_KEY,
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return generateRandomString(6, alphabet("0-9", "A-Z"));
  },
  async sendVerificationRequest({ identifier: email, provider, token }) {
    const resend = new ResendAPI(provider.apiKey);
    const { error } = await resend.emails.send({
      from: "Codecast <support@codecast.sh>",
      to: [email],
      subject: "Reset your Codecast password",
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Reset your password</h1>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
            Use this code to reset your password. It expires in 15 minutes.
          </p>
          <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #1a1a1a;">${token}</span>
          </div>
          <p style="color: #888; font-size: 14px;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (error) {
      throw new Error(JSON.stringify(error));
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  session: {
    totalDurationMs: 1000 * 60 * 60 * 24 * 365 * 10, // 10 years
    inactiveDurationMs: 1000 * 60 * 60 * 24 * 365 * 2, // 2 years
  },
  jwt: {
    durationMs: 1000 * 60 * 60 * 24 * 365, // 1 year
  },
  callbacks: {
    async redirect({ redirectTo }) {
      if (redirectTo.startsWith("codecast://") || redirectTo.startsWith("exp+codecast://")) {
        return redirectTo;
      }
      const siteUrl = process.env.SITE_URL?.replace(/\/$/, "") ?? "";
      if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
        return `${siteUrl}${redirectTo}`;
      }
      if (redirectTo.startsWith(siteUrl)) {
        return redirectTo;
      }
      throw new Error(`Invalid redirectTo: ${redirectTo}`);
    },
  },
  providers: [
    GitHub({
      authorization: {
        params: {
          scope: "read:user user:email repo read:org",
        },
      },
      profile(profile, tokens) {
        return {
          id: String(profile.id),
          email: profile.email,
          name: profile.name ?? profile.login,
          image: profile.avatar_url,
          github_id: String(profile.id),
          github_username: profile.login,
          github_avatar_url: profile.avatar_url,
          github_access_token: tokens.access_token,
        };
      },
    }),
    Apple({
      profile(profile) {
        return {
          id: profile.sub,
          email: profile.email,
          name: profile.name
            ? `${profile.name.firstName ?? ""} ${profile.name.lastName ?? ""}`.trim()
            : profile.email?.split("@")[0],
          image: undefined,
        };
      },
    }),
    Password({ reset: ResendOTPPasswordReset }),
  ],
});
