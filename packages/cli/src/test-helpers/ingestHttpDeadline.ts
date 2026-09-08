import { expect, test } from "bun:test";
import net from "node:net";
import { makeFunctionReference } from "convex/server";
import { SyncService } from "../syncService.js";
import { serializeTranscript } from "../workers/ingestClient.js";

for (const operation of ["mutation", "upload"] as const) {
  for (const mode of ["headers", "body"] as const) {
    test(`expired ingestion cancels stalled ${operation} ${mode} while another request succeeds`, async () => {
      let closed = false;
      const sockets = new Set<net.Socket>();
      const server = net.createServer(socket => {
        sockets.add(socket);
        let body = "";
        let handled = false;
        let stalled = false;
        socket.on("close", () => { sockets.delete(socket); if (stalled) closed = true; });
        socket.on("data", chunk => {
          if (handled) return;
          body += chunk.toString();
          const split = body.indexOf("\r\n\r\n");
          if (split < 0) return;
          const length = Number(/content-length:\s*(\d+)/i.exec(body.slice(0, split))?.[1]);
          const payload = body.slice(split + 4);
          if (payload.length < length) return;
          handled = true;
          const upload = body.startsWith("POST /upload ");
          const request = upload ? undefined : JSON.parse(payload);
          stalled = upload || Boolean(request.args[0].stall);
          if (stalled) {
            if (mode === "body") socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"status":"success","value":');
          } else {
            const value = request.path === "images:generateUploadUrl"
              ? `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/upload`
              : "healthy";
            const result = JSON.stringify({ status: "success", value });
            socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${result.length}\r\nConnection: close\r\n\r\n${result}`);
          }
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const sync = new SyncService({ convexUrl: `http://127.0.0.1:${address.port}` });
      const client = sync.getClient();
      const mutation = makeFunctionReference<"mutation">("test:deadline");
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(await client.mutation(mutation, {}, { skipQueue: true })).toBe("healthy");
        const failed = serializeTranscript(`http-deadline-${operation}-${mode}`, () =>
          operation === "mutation"
            ? client.mutation(mutation, { stall: true }, { skipQueue: true })
            : sync.uploadImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), "image/png"),
        { timeoutMs: 100 }).then(() => "unexpected success", error => String(error));
        expect(await client.mutation(mutation, {}, { skipQueue: true })).toBe("healthy");
        const result = await Promise.race([
          failed,
          new Promise<string>(resolve => { guard = setTimeout(() => resolve("still pending"), 1000); }),
        ]);
        expect(result).toContain("ingest transaction deadline");
        const end = Date.now() + 1000;
        while (!closed && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
        expect(closed).toBe(true);
      } finally {
        clearTimeout(guard);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }
}
