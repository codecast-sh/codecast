import { webcrypto } from "node:crypto";

const CONVEX_URL = process.env.CONVEX_URL || "https://convex.codecast.sh";
const WEBHOOK_SECRET = "test-secret-123";

async function generateSignature(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(body);

  const key = await webcrypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await webcrypto.subtle.sign("HMAC", key, messageData);
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return "sha256=" + hashHex;
}

async function testWebhook() {
  const testPayload = {
    action: "opened",
    pull_request: {
      id: 1,
      number: 123,
      title: "Test PR",
    },
  };

  const body = JSON.stringify(testPayload);

  console.log("Testing webhook endpoint...\n");

  console.log("Test 1: Missing headers (should return 400)");
  const response1 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    body,
  });
  console.log(`Status: ${response1.status}`);
  console.log(`Response: ${await response1.text()}\n`);

  console.log("Test 2: Invalid signature (should return 401)");
  const response2 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": "sha256=invalid",
      "X-GitHub-Delivery": "test-delivery-1",
      "X-GitHub-Event": "pull_request",
      "Content-Type": "application/json",
    },
    body,
  });
  console.log(`Status: ${response2.status}`);
  console.log(`Response: ${await response2.text()}\n`);

  console.log("Test 3: Valid signature (should return 200)");
  const signature = await generateSignature(body, WEBHOOK_SECRET);
  const response3 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Delivery": "test-delivery-2",
      "X-GitHub-Event": "pull_request",
      "Content-Type": "application/json",
    },
    body,
  });
  console.log(`Status: ${response3.status}`);
  console.log(`Response: ${await response3.text()}\n`);

  console.log("Test 4: Duplicate delivery (should handle idempotently)");
  const response4 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Delivery": "test-delivery-2",
      "X-GitHub-Event": "pull_request",
      "Content-Type": "application/json",
    },
    body,
  });
  console.log(`Status: ${response4.status}`);
  console.log(`Response: ${await response4.text()}\n`);
}

testWebhook().catch(console.error);
