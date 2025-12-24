import { ConvexHttpClient } from "convex/browser";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

async function test() {
  console.log("Testing updateDaemonLastSeen mutation...\n");

  const apiToken = process.env.CONVEX_API_TOKEN;
  if (!apiToken) {
    console.error("CONVEX_API_TOKEN not set");
    process.exit(1);
  }

  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: bun test-update-daemon-last-seen.ts <user_id>");
    console.error("You can find a user ID from your Convex dashboard");
    process.exit(1);
  }

  try {
    console.log(`1. Getting user before update...`);
    const userBefore = await client.query("users:listUsers" as any, {});
    const targetUser = userBefore.find((u: any) => u._id === userId);
    if (!targetUser) {
      throw new Error(`User ${userId} not found`);
    }
    console.log(`✓ User found: ${targetUser.email || "no email"}`);
    console.log(`  daemon_last_seen before: ${targetUser.daemon_last_seen || "null"}\n`);

    console.log("2. Calling updateDaemonLastSeen...");
    const beforeTimestamp = Date.now();
    await client.mutation("users:updateDaemonLastSeen" as any, {
      user_id: userId,
    });
    const afterTimestamp = Date.now();
    console.log("✓ Mutation completed\n");

    console.log("3. Verifying daemon_last_seen was updated...");
    await new Promise(resolve => setTimeout(resolve, 500));
    const usersAfter = await client.query("users:listUsers" as any, {});
    const userAfter = usersAfter.find((u: any) => u._id === userId);

    if (!userAfter.daemon_last_seen) {
      throw new Error("daemon_last_seen was not set");
    }

    console.log(`✓ daemon_last_seen after: ${userAfter.daemon_last_seen}`);

    if (userAfter.daemon_last_seen < beforeTimestamp || userAfter.daemon_last_seen > afterTimestamp) {
      throw new Error(
        `daemon_last_seen ${userAfter.daemon_last_seen} is not within expected range [${beforeTimestamp}, ${afterTimestamp}]`
      );
    }

    console.log("✓ Timestamp is within expected range\n");
    console.log("✅ All tests passed!");
  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
    process.exit(1);
  }
}

test();
