import base from "./vite.preview-migrate.config";
export default { ...base, cacheDir: "/tmp/codecast-remote-setup-vite", optimizeDeps: { entries: ["remote-machine-local.html"] }, server: { port: 5207, strictPort: true, host: "127.0.0.1", hmr: false, watch: null } };
