import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
export default defineConfig({ root: path.resolve(__dirname), plugins: [react()], resolve: { alias: { "@": path.resolve(__dirname, "..") } }, optimizeDeps: { entries: ["_composer-scratch-entry.tsx"] } });
