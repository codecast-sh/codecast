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

async function testCommentSync() {
  console.log("Testing GitHub comment sync...\n");

  const prPayload = {
    number: 123,
    id: 123456789,
    title: "Test PR for comment sync",
    body: "Test PR body",
    state: "open",
    user: { login: "testuser" },
    base: {
      repo: {
        full_name: "test/repo",
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const commentPayload = {
    comment: {
      id: 987654321,
      body: "This is a test comment from GitHub",
      user: { login: "testuser" },
      path: "src/test.ts",
      line: 42,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    pull_request: prPayload,
  };

  console.log("1. Sending PR review comment created webhook...");
  const body1 = JSON.stringify(commentPayload);
  const signature1 = await generateSignature(body1, WEBHOOK_SECRET);

  const response1 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature1,
      "X-GitHub-Delivery": `test-comment-created-${Date.now()}`,
      "X-GitHub-Event": "pull_request_review_comment",
      "Content-Type": "application/json",
    },
    body: body1,
  });
  console.log(`   Status: ${response1.status}`);
  console.log(`   Response: ${await response1.text()}`);

  console.log("\n2. Sending edited comment webhook...");
  const editedCommentPayload = {
    action: "edited",
    comment: {
      ...commentPayload.comment,
      body: "This comment was edited",
      updated_at: new Date().toISOString(),
    },
    pull_request: prPayload,
  };

  const body2 = JSON.stringify(editedCommentPayload);
  const signature2 = await generateSignature(body2, WEBHOOK_SECRET);

  const response2 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature2,
      "X-GitHub-Delivery": `test-comment-edited-${Date.now()}`,
      "X-GitHub-Event": "pull_request_review_comment",
      "Content-Type": "application/json",
    },
    body: body2,
  });
  console.log(`   Status: ${response2.status}`);
  console.log(`   Response: ${await response2.text()}`);

  console.log("\n3. Sending deleted comment webhook...");
  const deletedCommentPayload = {
    action: "deleted",
    comment: commentPayload.comment,
    pull_request: prPayload,
  };

  const body3 = JSON.stringify(deletedCommentPayload);
  const signature3 = await generateSignature(body3, WEBHOOK_SECRET);

  const response3 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature3,
      "X-GitHub-Delivery": `test-comment-deleted-${Date.now()}`,
      "X-GitHub-Event": "pull_request_review_comment",
      "Content-Type": "application/json",
    },
    body: body3,
  });
  console.log(`   Status: ${response3.status}`);
  console.log(`   Response: ${await response3.text()}`);

  console.log("\n4. Testing deduplication (Codecast-originated comment)...");
  const codecastCommentPayload = {
    action: "created",
    comment: {
      id: 111222333,
      body: "codecast_comment_id: abc123\nThis originated from Codecast",
      user: { login: "testuser" },
      path: "src/test.ts",
      line: 50,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    pull_request: prPayload,
  };

  const body4 = JSON.stringify(codecastCommentPayload);
  const signature4 = await generateSignature(body4, WEBHOOK_SECRET);

  const response4 = await fetch(`${CONVEX_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature4,
      "X-GitHub-Delivery": `test-comment-dedup-${Date.now()}`,
      "X-GitHub-Event": "pull_request_review_comment",
      "Content-Type": "application/json",
    },
    body: body4,
  });
  console.log(`   Status: ${response4.status}`);
  console.log(`   Response: ${await response4.text()}`);
  console.log("   (Should be stored but skipped during processing)");

  console.log("\n✅ All webhook tests completed!");
  console.log("\nNote: Events are stored but not automatically processed.");
  console.log("Run processCommentWebhooks mutation to process pending events.");
}

testCommentSync().catch(console.error);
