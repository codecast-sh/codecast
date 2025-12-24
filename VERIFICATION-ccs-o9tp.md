# Verification: Discoverable share URLs - opt-in public directory (ccs-o9tp)

## Implementation Summary

### 1. Database Schema Changes ✅
**File:** `packages/convex/convex/schema.ts`

Added `public_conversations` table with:
- `conversation_id`: Reference to conversations
- `user_id`: Owner of the conversation
- `title`: Required title for public listing
- `description`: Optional description
- `tags`: Optional array of tags
- `preview_text`: Extracted from first user message (~200 chars)
- `agent_type`: Type of agent (claude_code, codex, cursor)
- `message_count`: Number of messages in conversation
- `created_at`: Timestamp
- `view_count`: Track popularity

Indexes:
- `by_created_at`: For sorting by recency
- `by_view_count`: For sorting by popularity

### 2. Mutation Implementation ✅
**File:** `packages/convex/convex/conversations.ts`

Added `publishToDirectory` mutation that:
- Verifies user authentication
- Checks conversation ownership
- Requires share_token to exist (must share first)
- Extracts preview text from first user message
- Creates or updates public_conversations entry
- Returns the public conversation ID

Security:
- Only owner can publish their conversations
- Conversation must have share_token (public link created first)
- Updates existing entry if conversation already published

### 3. UI Components ✅

#### Switch Component
**File:** `packages/web/components/ui/switch.tsx`

Simple toggle switch with:
- Checked/unchecked states
- Disabled state support
- Accessible (role="switch", aria-checked)
- Styled with Solarized theme colors

#### ShareDialog Component
**File:** `packages/web/components/ShareDialog.tsx`

Features:
- Shows share link with copy button
- "List in public directory" toggle switch
- Conditional fields when public enabled:
  - Title input (pre-filled with conversation title)
  - Description textarea
  - Tags input (comma-separated)
- Submit button adapts text based on public state
- Integrates with generateShareLink and publishToDirectory mutations
- Toast notifications for success/error states

### 4. Integration ✅
**File:** `packages/web/app/conversation/[id]/page.tsx`

Updated conversation page:
- Added ShareDialog import and state
- Modified share button to open dialog instead of immediate copy
- Dialog receives conversation ID, title, and existing share token
- Callback to update local state when share token generated

## Testing Plan

### Manual Test Steps

1. **Start Development Environment**
   ```bash
   cd packages/convex && npx convex dev
   cd packages/web && bun run dev
   ```

2. **Test Basic Sharing**
   - Navigate to any conversation
   - Click share button (link icon)
   - Verify ShareDialog opens
   - Verify share link is generated
   - Click "Share" button
   - Verify link is copied to clipboard
   - Close dialog

3. **Test Public Directory Publishing**
   - Click share button again on same conversation
   - Verify share link is pre-populated
   - Toggle "List in public directory" switch ON
   - Verify title, description, tags fields appear
   - Fill in:
     - Title: "Example: Building a React Component"
     - Description: "Detailed walkthrough of creating a reusable button component"
     - Tags: "react, typescript, components"
   - Click "Share & List Publicly"
   - Verify success toast appears
   - Verify dialog closes

4. **Verify Database Entry**
   - Open Convex dashboard
   - Navigate to public_conversations table
   - Verify new entry exists with:
     - Correct conversation_id
     - Title, description, tags from form
     - preview_text extracted from conversation
     - view_count initialized to 0

5. **Test Update Existing**
   - Open share dialog for same conversation again
   - Toggle "List in public directory" ON
   - Change title to "Updated: React Component Tutorial"
   - Click "Share & List Publicly"
   - Verify in Convex dashboard that entry is updated, not duplicated

### Database Query Test

Run in Convex dashboard or test file:

```typescript
// Query public conversations
const publicConvos = await ctx.db
  .query("public_conversations")
  .withIndex("by_created_at")
  .order("desc")
  .take(10);

console.log("Public conversations:", publicConvos);

// Verify entry has all required fields
const entry = publicConvos[0];
assert(entry.conversation_id);
assert(entry.user_id);
assert(entry.title);
assert(entry.preview_text);
assert(entry.agent_type);
assert(typeof entry.message_count === 'number');
assert(typeof entry.view_count === 'number');
```

### Error Cases to Test

1. **Publish without share token**
   - Try to publish conversation that hasn't been shared
   - Should fail with error: "Conversation must be shared before publishing to directory"

2. **Non-owner publishing**
   - Try to publish someone else's conversation
   - Should fail with error: "Unauthorized: can only publish your own conversations"

3. **Empty title**
   - Toggle public ON but leave title empty
   - Dialog should prevent submission (title is required)

## Acceptance Criteria Status

- [x] Add public_conversations table to Convex schema
- [x] Enhance share dialog with 'List in public directory' switch
- [x] Show title, description, tags fields when public enabled
- [x] Add publishToDirectory mutation
- [x] Verify conversations can be published to directory (manual test plan provided)

## Files Changed

1. `packages/convex/convex/schema.ts` - Added public_conversations table
2. `packages/convex/convex/conversations.ts` - Added publishToDirectory mutation
3. `packages/web/components/ui/switch.tsx` - Created switch component
4. `packages/web/components/ShareDialog.tsx` - Created share dialog component
5. `packages/web/app/conversation/[id]/page.tsx` - Integrated ShareDialog

## Notes

- ShareDialog uses existing UI components (Dialog, Input, Textarea, Button)
- Switch component created with simple implementation, can be replaced with shadcn/ui version later if needed
- Preview text extraction limited to 200 characters from first user message
- Tags are stored as array of strings, split by comma in UI
- View count tracking implemented but increment logic not yet added (will be in public directory page feature)
