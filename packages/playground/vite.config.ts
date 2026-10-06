import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // CONVEX_URL comes from .env.local, written by the Convex CLI.
  envPrefix: ["VITE_", "CONVEX_URL"],
  server: {
    port: 5317,
    strictPort: true,
    // The avatar art and KeyCap are imported from packages/web, never copied.
    fs: { allow: ["../.."] },
  },
});
