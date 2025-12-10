import type { NextConfig } from "next";
import { join } from "path";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/download/[binary]": ["./public/binaries/**/*"],
  },
};

export default nextConfig;
