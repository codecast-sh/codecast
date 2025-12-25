# Testing Remote Permission Approval (ccs-ony7)

## Feature Overview
This feature allows users to approve/deny Claude Code tool permissions from the web dashboard.

## Implementation Summary
1. **Convex Schema**: Added `pending_permissions` table
2. **Convex Mutations**: Created `permissions.ts` with mutations and queries
3. **Daemon Integration**: Added WebSocket subscription to listen for permission responses and inject them into Claude Code stdin
4. **Web UI**: Created `PermissionCard` component integrated into `ConversationView`

## Manual Testing Steps

### Prerequisites
1. Daemon running and authenticated
2. Web dashboard accessible
3. Active Claude Code conversation

### Test 1: Create Permission Request and Approve
```javascript
// In Convex dashboard or via API, create a test permission:
await ctx.runMutation(api.permissions.createPermissionRequest, {
  conversation_id: "<active-conversation-id>",
  tool_name: "Bash",
  arguments_preview: "rm -rf /tmp/test",
});
```

**Expected behavior:**
1. Permission appears in web UI on conversation view
2. Shows "Permission Required" card with tool name and preview
3. "Approve" and "Deny" buttons visible

### Test 2: Approve Permission
1. Click "Approve" button in web UI
2. Check daemon logs (`tail -f ~/.codecast/daemon.log`)

**Expected behavior:**
1. Web UI shows "Permission approved" toast
2. Permission card disappears
3. Daemon log shows:
   ```
   Permission subscription update received
   New permission response: <id> status=approved tool=Bash
   Found N Claude Code process(es) for permission injection
   Successfully injected permission response 'y' to <tty-path>
   ```
4. Claude Code receives 'y' input and proceeds

### Test 3: Deny Permission
Same as Test 2, but click "Deny" instead

**Expected behavior:**
1. Daemon injects 'n' instead of 'y'
2. Claude Code receives denial

## Known Limitations (Phase 2)
- Permission prompt detection from Claude Code stdout is NOT yet implemented
- Permissions must be created manually or via future integration
- No automatic permission type detection
- No "allow for session" or "allow all" modes yet

## Future Enhancements
- Auto-detect permission prompts from Claude Code process output
- Support permission modes (once, session, all of type)
- Add permission history and analytics
- Support bulk approval/denial
