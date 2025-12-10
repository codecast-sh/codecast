import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/download/[binary]": ["./binaries/**/*"],
  },
};

export default nextConfig;
