// The `convex/auth.config.ts` body: one JWT issuer, the deployment's own site URL.
export function createAuthHttpConfig(domain: string | undefined = process.env.CONVEX_SITE_URL) {
  return {
    providers: [
      {
        domain,
        applicationID: "convex",
      },
    ],
  };
}
