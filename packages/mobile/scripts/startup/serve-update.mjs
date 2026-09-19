// Serves one `expo export` directory as an expo-updates manifest, so an
// installed binary runs the exact release artifact. bun serve-update.mjs <dist> <port> <expo-config.json>
import * as fs from "node:fs"; import * as path from "node:path"; import * as crypto from "node:crypto";
const [dist, portArg, configPath] = process.argv.slice(2);
const port = Number(portArg);
const meta = JSON.parse(fs.readFileSync(path.join(dist, "metadata.json"), "utf8")).fileMetadata;
const expoClient = JSON.parse(fs.readFileSync(configPath, "utf8"));
const TYPES = { ttf: "font/ttf", otf: "font/otf", png: "image/png", jpg: "image/jpeg", webp: "image/webp", m4a: "audio/mp4", caf: "audio/x-caf", json: "application/json" };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function asset(rel, ext, launch) {
  const buf = fs.readFileSync(path.join(dist, rel));
  return {
    hash: b64url(crypto.createHash("sha256").update(buf).digest()),
    key: crypto.createHash("md5").update(buf).digest("hex"),
    contentType: launch ? "application/javascript" : TYPES[ext ?? ""] ?? "application/octet-stream",
    ...(launch ? {} : { fileExtension: "." + ext }),
    url: `http://127.0.0.1:${port}/file/${rel}`,
  };
}
const id = crypto.randomUUID();
Bun.serve({ port, fetch(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/file/")) {
    const file = path.join(dist, decodeURIComponent(url.pathname.slice(6)));
    if (!file.startsWith(path.resolve(dist))) return new Response("no", { status: 403 });
    return new Response(Bun.file(file));
  }
  const platform = req.headers.get("expo-platform") ?? url.searchParams.get("platform") ?? "ios";
  const m = meta[platform];
  const manifest = {
    id, createdAt: new Date().toISOString(), runtimeVersion: process.env.RUNTIME_VERSION ?? (expoClient.runtimeVersion?.policy ? expoClient.version : expoClient.runtimeVersion),
    launchAsset: process.env.LAUNCH_URL
      ? { hash: "dev", key: "dev-bundle", contentType: "application/javascript", url: process.env.LAUNCH_URL }
      : asset(m.bundle, null, true),
    assets: process.env.LAUNCH_URL ? [] : m.assets.map((a) => asset(a.path, a.ext, false)),
    metadata: {}, extra: { expoClient },
  };
  console.log(new Date().toISOString(), "manifest", platform);
  const boundary = "codecast-startup";
  const body = `--${boundary}\r\ncontent-disposition: form-data; name="manifest"\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n--${boundary}--\r\n`;
  return new Response(body, { headers: { "content-type": `multipart/mixed; boundary=${boundary}`, "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" } });
} });
console.log("serving", dist, "on", port);
