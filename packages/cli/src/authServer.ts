import * as http from "http";
import { randomBytes } from "crypto";

export interface AuthResult {
  userId: string;
  nonce: string;
}

export interface AuthServerOptions {
  port?: number;
  timeout?: number;
}

export class AuthServer {
  private server: http.Server | null = null;
  private nonce: string;
  private port: number;
  private timeout: number;
  private resolve: ((result: AuthResult | null) => void) | null = null;
  private timeoutId: NodeJS.Timeout | null = null;

  constructor(options: AuthServerOptions = {}) {
    this.nonce = randomBytes(32).toString("hex");
    this.port = options.port || 42424;
    this.timeout = options.timeout || 300000;
  }

  getNonce(): string {
    return this.nonce;
  }

  getPort(): number {
    return this.port;
  }

  async start(): Promise<AuthResult | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;

      this.timeoutId = setTimeout(() => {
        this.stop();
        resolve(null);
      }, this.timeout);

      this.server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/callback") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            try {
              const data = JSON.parse(body);

              if (data.nonce !== this.nonce) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid nonce" }));
                return;
              }

              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(JSON.stringify({ success: true }));

              if (this.timeoutId) {
                clearTimeout(this.timeoutId);
              }

              this.stop();

              if (this.resolve) {
                this.resolve({
                  userId: data.userId,
                  nonce: data.nonce,
                });
              }
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid request" }));
            }
          });
        } else if (req.method === "OPTIONS") {
          res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`Auth server listening on http://127.0.0.1:${this.port}`);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.port += 1;
          if (this.server) {
            this.server.listen(this.port, "127.0.0.1");
          }
        } else {
          console.error("Auth server error:", err);
          this.stop();
          if (this.resolve) {
            this.resolve(null);
          }
        }
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
