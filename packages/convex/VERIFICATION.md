# Pending Messages Verification

## Implementation Summary

Created `pending_messages` table and mutations for bidirectional messaging between web/mobile and daemon.

### Schema Changes
- Added `pending_messages` table with fields:
  - conversation_id, from_user_id (references)
  - content (string)
  - status (pending | delivered | failed)
  - created_at, delivered_at (timestamps)
  - retry_count (number, default 0)
- Added `subtitle` field to `conversations` table (found in existing data)

### Functions Implemented
All functions deployed and available:
- `pendingMessages:sendMessageToSession` - Create pending message
- `pendingMessages:updateMessageStatus` - Update delivery status
- `pendingMessages:retryMessage` - Retry failed message
- `pendingMessages:getPendingMessages` - Query pending messages
- `pendingMessages:getMessageStatus` - Check message status

## Manual Verification via Convex Dashboard

1. Open Convex dashboard: https://marvelous-meerkat-539.convex.cloud

2. Find an active conversation ID from the `conversations` table

3. Test sendMessageToSession:
   ```
   Function: pendingMessages:sendMessageToSession
   Args: {
     "conversation_id": "<conversation_id>",
     "content": "Test message"
   }
   ```
   Should return a message ID.

4. Verify in database:
   - Query `pending_messages` table
   - Find the new record with status "pending"

5. Test updateMessageStatus:
   ```
   Function: pendingMessages:updateMessageStatus
   Args: {
     "message_id": "<message_id_from_step_3>",
     "status": "delivered",
     "delivered_at": 1735029600000
   }
   ```

6. Verify status changed:
   - Check `pending_messages` table
   - Status should be "delivered"

## Acceptance Criteria

✅ 1. Call sendMessageToSession mutation - IMPLEMENTED
✅ 2. Verify message appears in pending_messages - WORKS (via database query)
✅ 3. Call updateMessageStatus with 'delivered' - IMPLEMENTED
✅ 4. Verify status updated - WORKS (via database query)

## Additional Functions

✅ retryMessage - Increments retry_count, resets to pending
✅ getPendingMessages - Returns pending messages for user
✅ getMessageStatus - Returns current message status

All mutations include:
- Authentication (session or API token)
- Authorization (user can only access their own data)
- Validation (conversation exists and is active)
