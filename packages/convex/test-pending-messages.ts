import { ConvexHttpClient } from "convex/browser";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

async function test() {
  console.log("Testing pending_messages functionality...\n");

  const apiToken = process.env.CONVEX_API_TOKEN;
  if (!apiToken) {
    console.error("CONVEX_API_TOKEN not set");
    process.exit(1);
  }

  const conversationId = process.argv[2];
  if (!conversationId) {
    console.error("Usage: bun test-pending-messages.ts <conversation_id>");
    console.error("You can find a conversation ID from your Convex dashboard");
    process.exit(1);
  }

  try {
    console.log("1. Testing sendMessageToSession...");
    const messageId = await client.mutation("pendingMessages:sendMessageToSession" as any, {
      conversation_id: conversationId,
      content: "Test message from pending_messages verification",
      api_token: apiToken,
    });
    console.log(`✓ Created message: ${messageId}\n`);

    console.log("2. Testing getMessageStatus...");
    const status = await client.query("pendingMessages:getMessageStatus" as any, {
      message_id: messageId,
      api_token: apiToken,
    });
    console.log(`✓ Status: ${JSON.stringify(status, null, 2)}\n`);

    if (status.status !== "pending") {
      throw new Error(`Expected status 'pending', got '${status.status}'`);
    }

    console.log("3. Testing getPendingMessages...");
    const pending = await client.query("pendingMessages:getPendingMessages" as any, {
      api_token: apiToken,
    });
    console.log(`✓ Found ${pending.length} pending messages\n`);

    const found = pending.find((m: any) => m._id === messageId);
    if (!found) {
      throw new Error("Created message not found in pending messages");
    }

    console.log("4. Testing updateMessageStatus to 'delivered'...");
    await client.mutation("pendingMessages:updateMessageStatus" as any, {
      message_id: messageId,
      status: "delivered",
      delivered_at: Date.now(),
      api_token: apiToken,
    });
    console.log("✓ Updated to delivered\n");

    console.log("5. Verifying status updated...");
    const updatedStatus = await client.query("pendingMessages:getMessageStatus" as any, {
      message_id: messageId,
      api_token: apiToken,
    });
    console.log(`✓ Status: ${JSON.stringify(updatedStatus, null, 2)}\n`);

    if (updatedStatus.status !== "delivered") {
      throw new Error(`Expected status 'delivered', got '${updatedStatus.status}'`);
    }

    console.log("6. Testing retryMessage...");
    await client.mutation("pendingMessages:retryMessage" as any, {
      message_id: messageId,
      api_token: apiToken,
    });
    console.log("✓ Retry successful\n");

    console.log("7. Verifying retry incremented count...");
    const retriedStatus = await client.query("pendingMessages:getMessageStatus" as any, {
      message_id: messageId,
      api_token: apiToken,
    });
    console.log(`✓ Status: ${JSON.stringify(retriedStatus, null, 2)}\n`);

    if (retriedStatus.status !== "pending") {
      throw new Error(`Expected status reset to 'pending', got '${retriedStatus.status}'`);
    }
    if (retriedStatus.retry_count !== 1) {
      throw new Error(`Expected retry_count 1, got ${retriedStatus.retry_count}`);
    }

    console.log("✅ All tests passed!");
  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
    process.exit(1);
  }
}

test();
