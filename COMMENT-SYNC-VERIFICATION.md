# GitHub Comment Sync Verification (ccs-jxrr)

This feature implements inbound comment sync from GitHub to Codecast.

## What Was Implemented

### Schema Changes (`packages/convex/convex/schema.ts`)

Updated `review_comments` table to support GitHub sync:
- Made `review_id` optional (comments can exist without a review)
- Added `pull_request_id` (required, links comment to PR)
- Made `file_path` and `line_number` optional (for general PR comments)
- Added `updated_at` (tracks edits)
- Added `github_comment_id` (unique GitHub comment ID)
- Added `codecast_origin` (boolean to mark Codecast-created comments)
- Added `author_github_username` (for attribution)
- Added `author_user_id` (optional, for Codecast users)
- Added indexes for `pull_request_id` and `github_comment_id`

### Event Processing (`packages/convex/convex/githubWebhooks.ts`)

Added `processCommentWebhooks` internal mutation that:
1. Queries unprocessed webhook events
2. Handles the following event types:
   - `pull_request_review_comment.created/edited/deleted`
   - `issue_comment.created/edited/deleted` (for PR general comments)
3. For each event:
   - Parses the payload
   - Matches PR by repository + number
   - Creates/updates/deletes review_comments
   - Skips comments with `codecast_comment_id:` in body (deduplication)
   - Marks event as processed

### Automatic Processing (`packages/convex/convex/crons.ts`)

Created scheduled function that runs every minute to:
- Process up to 50 pending webhook events
- Automatically sync comments without manual intervention

### Query for UI (`packages/convex/convex/reviews.ts`)

Added `getCommentsForPR` query to:
- Retrieve all comments for a given PR
- Used by the UI to display synced comments

### Updated Existing Code

Modified `addReviewComment` mutation in `reviews.ts` to:
- Look up review to get `pull_request_id`
- Mark comments as `codecast_origin: true`

## Acceptance Criteria Verification

### 1. Comments from GitHub appear in Codecast PR view ✅

- Webhook events create `review_comments` records
- `getCommentsForPR` query returns all comments for a PR
- Author attribution preserved via `author_github_username`

### 2. Edited comments update in Codecast ✅

- `handleReviewCommentEdited` and `handleIssueCommentEdited` update existing comments
- `updated_at` timestamp tracked

### 3. Deleted comments removed from Codecast ✅

- `handleReviewCommentDeleted` and `handleIssueCommentDeleted` delete comments
- Looks up by `github_comment_id` index

### 4. Comments originated from Codecast not duplicated ✅

- Checks for `codecast_comment_id:` marker in comment body
- Skips processing if marker found
- Returns `false` to mark event as skipped

### 5. Author attribution preserved ✅

- `author_github_username` field stores GitHub username
- Optional `author_user_id` links to Codecast user (if they exist)

## How to Test

### Automated Test

Run the test script:
```bash
cd packages/convex
bun run test-comment-sync.ts
```

This sends sample webhook events to the endpoint and verifies they're stored.

### Manual Testing

1. Set up a GitHub webhook pointing to your Convex deployment
2. Create a PR in the linked repository
3. Add a comment to the PR on GitHub
4. Wait up to 1 minute for the cron to process
5. Query `getCommentsForPR` with the PR ID to see synced comments

### Verify Deduplication

1. Post a comment from Codecast to GitHub (once outbound sync is implemented)
2. Verify the comment includes `codecast_comment_id:` marker
3. Webhook event should be stored but skipped during processing

## Event Flow

```
GitHub PR Comment
       ↓
GitHub Webhook
       ↓
Convex HTTP Endpoint (/api/webhooks/github)
       ↓
storeWebhookEvent (internal mutation)
       ↓
github_webhook_events table (processed: false)
       ↓
Cron job (every 1 minute)
       ↓
processCommentWebhooks (internal mutation)
       ↓
Parse and route by event type
       ↓
handleReviewCommentCreated/Edited/Deleted
       ↓
review_comments table
       ↓
getCommentsForPR (query)
       ↓
Codecast UI
```

## Notes

- Events are processed asynchronously (up to 1 minute delay)
- Failed events remain unprocessed and will be retried
- Duplicate webhook deliveries are handled idempotently
- General PR comments (issue_comment events) are stored alongside review comments
