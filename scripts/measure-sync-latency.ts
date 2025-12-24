#!/usr/bin/env bun

import * as fs from "fs";
import * as path from "path";
import { ConvexClient } from "convex/browser";

const CONVEX_URL = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!CONVEX_URL) {
  console.error("Error: CONVEX_URL not set");
  process.exit(1);
}

console.log("=== Sync Latency Measurement Tool ===\n");

const testSessionId = `latency-test-${Date.now()}`;
const projectsPath = path.join(process.env.HOME || "", ".claude", "projects");
const testProjectPath = path.join(projectsPath, "test-project");
const testFilePath = path.join(testProjectPath, `${testSessionId}.jsonl`);

console.log(`Test session: ${testSessionId}`);
console.log(`History file: ${testFilePath}\n`);

if (!fs.existsSync(testProjectPath)) {
  fs.mkdirSync(testProjectPath, { recursive: true });
}

const client = new ConvexClient(CONVEX_URL);

const testMessage = `Sync latency test message - ${Date.now()}`;

const sessionMeta = {
  type: "session_meta",
  session_id: testSessionId,
  project_path: testProjectPath,
  timestamp: Date.now(),
};

const userMessage = {
  type: "response_item",
  role: "user",
  content: testMessage,
  timestamp: Date.now(),
  uuid: `msg-${Date.now()}`,
};

console.log("Writing test message to history file...");
const writeStartTime = Date.now();

fs.writeFileSync(
  testFilePath,
  JSON.stringify(sessionMeta) + "\n" + JSON.stringify(userMessage) + "\n"
);

console.log(`File written at: ${new Date(writeStartTime).toISOString()}`);
console.log(`Message: "${testMessage}"\n`);

console.log("Waiting for message to appear in Convex...");

let found = false;
let attempts = 0;
const maxAttempts = 40;

const checkInterval = setInterval(async () => {
  attempts++;

  try {
    const conversations: any = await client.query("conversations:listConversations" as any, {
      filter: "my",
    });

    const matchingConv = conversations?.conversations?.find((c: any) =>
      c.title?.includes(testMessage) || c.first_user_message?.includes(testMessage)
    );

    if (matchingConv) {
      const appearTime = Date.now();
      const latency = appearTime - writeStartTime;

      clearInterval(checkInterval);
      found = true;

      console.log(`\n✓ Message found!`);
      console.log(`  Appeared at: ${new Date(appearTime).toISOString()}`);
      console.log(`  Latency: ${latency}ms`);
      console.log(`  Conversation ID: ${matchingConv._id}`);

      if (latency < 2000) {
        console.log(`\n✓ PASS: Sync latency is under 2 seconds`);
      } else {
        console.log(`\n✗ FAIL: Sync latency exceeds 2 seconds`);
      }

      fs.unlinkSync(testFilePath);

      client.close();
      process.exit(latency < 2000 ? 0 : 1);
    }
  } catch (error) {
    console.error(`Error querying Convex: ${error}`);
  }

  if (attempts >= maxAttempts) {
    clearInterval(checkInterval);
    console.log(`\n✗ FAIL: Message did not appear after ${maxAttempts * 100}ms`);

    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    client.close();
    process.exit(1);
  }
}, 100);
