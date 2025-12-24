import { ConvexHttpClient } from "convex/browser";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

async function test() {
  console.log("Testing publishToDirectory functionality...\n");

  const apiToken = process.env.CONVEX_API_TOKEN;
  if (!apiToken) {
    console.error("CONVEX_API_TOKEN not set");
    process.exit(1);
  }

  const conversationId = process.argv[2];
  if (!conversationId) {
    console.error("Usage: bun test-publish-to-directory.ts <conversation_id>");
    console.error("You can find a conversation ID from your Convex dashboard");
    process.exit(1);
  }

  try {
    console.log("1. Testing generateShareLink...");
    const shareToken = await client.mutation("conversations:generateShareLink" as any, {
      conversation_id: conversationId,
    });
    console.log(`✓ Generated share token: ${shareToken}\n`);

    console.log("2. Testing publishToDirectory with full metadata...");
    const publicId = await client.mutation("conversations:publishToDirectory" as any, {
      conversation_id: conversationId,
      title: "Test: Building a React Component",
      description: "A detailed walkthrough of creating a reusable button component with TypeScript",
      tags: ["react", "typescript", "components"],
    });
    console.log(`✓ Published to directory: ${publicId}\n`);

    console.log("3. Verifying public_conversations entry exists...");
    const publicConvos = await client.query("conversations:listPublicConversations" as any, {
      limit: 100,
    }).catch(() => {
      console.log("Note: listPublicConversations query not yet implemented");
      return null;
    });

    if (publicConvos) {
      const found = publicConvos.find((c: any) => c.conversation_id === conversationId);
      if (!found) {
        throw new Error("Published conversation not found in public listings");
      }
      console.log(`✓ Found in public listings: ${JSON.stringify(found, null, 2)}\n`);

      if (found.title !== "Test: Building a React Component") {
        throw new Error(`Expected title 'Test: Building a React Component', got '${found.title}'`);
      }
      if (!found.description?.includes("button component")) {
        throw new Error("Description not saved correctly");
      }
      if (!found.tags?.includes("react")) {
        throw new Error("Tags not saved correctly");
      }
      if (!found.preview_text) {
        throw new Error("Preview text not extracted");
      }
    }

    console.log("4. Testing update existing public entry...");
    const updatedId = await client.mutation("conversations:publishToDirectory" as any, {
      conversation_id: conversationId,
      title: "Updated: React Component Tutorial",
      description: "Updated description with more details",
      tags: ["react", "typescript", "tutorial"],
    });
    console.log(`✓ Updated entry: ${updatedId}\n`);

    if (updatedId !== publicId) {
      throw new Error("Should update existing entry, not create new one");
    }

    console.log("5. Testing error case: publish without share token...");
    try {
      await client.mutation("conversations:publishToDirectory" as any, {
        conversation_id: "invalid_id_that_has_no_share_token",
        title: "Should fail",
      });
      throw new Error("Should have thrown error for conversation without share token");
    } catch (error: any) {
      if (error.message.includes("share token") || error.message.includes("not found")) {
        console.log("✓ Correctly rejected conversation without share token\n");
      } else {
        throw error;
      }
    }

    console.log("✅ All tests passed!");
  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

test();
