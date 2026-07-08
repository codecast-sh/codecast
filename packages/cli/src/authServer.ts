import * as http from "http";
import { randomBytes } from "crypto";

export interface AuthResult {
  userId: string;
  apiToken: string;
  nonce: string;
}

export interface AuthServerOptions {
  port?: number;
  timeout?: number;
}

// If the preferred port is taken we try the next one, but cap the search so a
// machine with a wedged range can't spin forever.
const MAX_PORT_ATTEMPTS = 20;

export class AuthServer {
  private server: http.Server | null = null;
  private nonce: string;
  private port: number;
  private timeout: number;
  private timeoutId: NodeJS.Timeout | null = null;
  private resultPromise: Promise<AuthResult | null>;
  private resolveResult!: (result: AuthResult | null) => void;
  private settled = false;

  constructor(options: AuthServerOptions = {}) {
    this.nonce = randomBytes(32).toString("hex");
    this.port = options.port || 42424;
    this.timeout = options.timeout || 300000;
    // Create the result promise up front so the request handler can resolve it
    // regardless of whether waitForCallback() has been called yet — closing the
    // race between "browser POSTs" and "we start waiting".
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = (result) => {
        if (this.settled) return;
        this.settled = true;
        resolve(result);
      };
    });
  }

  getNonce(): string {
    return this.nonce;
  }

  getPort(): number {
    return this.port;
  }

  // Standard CORS headers for the callback origin. Access-Control-Allow-Private-
  // Network is required by Chrome's Private Network Access: a fetch from
  // https://codecast.sh (public) to http://127.0.0.1 (loopback) is blocked
  // unless the preflight opts in — without it the browser fails the callback
  // with a bare "Failed to fetch".
  private corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
    };
  }

  // Bind the callback server and resolve with the port we ACTUALLY bound to.
  // The browser URL must be built from this value (not the requested port):
  // EADDRINUSE bumps us to the next port, and telling the browser the wrong one
  // sends the callback POST nowhere.
  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempts = 0;

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
                res.writeHead(400, {
                  "Content-Type": "application/json",
                  ...this.corsHeaders(),
                });
                res.end(JSON.stringify({ error: "Invalid nonce" }));
                return;
              }

              res.writeHead(200, {
                "Content-Type": "application/json",
                ...this.corsHeaders(),
              });
              res.end(JSON.stringify({ success: true }));

              this.stop();
              this.resolveResult({
                userId: data.userId,
                apiToken: data.apiToken,
                nonce: data.nonce,
              });
            } catch {
              res.writeHead(400, {
                "Content-Type": "application/json",
                ...this.corsHeaders(),
              });
              res.end(JSON.stringify({ error: "Invalid request" }));
            }
          });
        } else if (req.method === "OPTIONS") {
          res.writeHead(204, this.corsHeaders());
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < MAX_PORT_ATTEMPTS) {
          attempts += 1;
          this.port += 1;
          this.server?.listen(this.port, "127.0.0.1");
        } else {
          this.stop();
          reject(err);
        }
      });

      // Resolve on the "listening" event (not the listen() callback) so the
      // resolution survives the EADDRINUSE retry, which re-listens without a
      // per-call callback.
      this.server.on("listening", () => {
        resolve(this.port);
      });

      this.server.listen(this.port, "127.0.0.1");
    });
  }

  // Wait for the browser to POST credentials back, or resolve null on timeout.
  // Call AFTER listen() and after opening the browser URL.
  async waitForCallback(): Promise<AuthResult | null> {
    this.timeoutId = setTimeout(() => {
      this.stop();
      this.resolveResult(null);
    }, this.timeout);
    return this.resultPromise;
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
