# Social posting via Publora

Codecast posts to its social accounts through [Publora](https://publora.com) — one REST
call publishes to every connected platform. Docs: https://docs.publora.com. The API
posts to accounts that are already connected; it cannot create accounts or connect them.

## Pieces

- `scripts/publora.mjs` — CLI over the API. Run it with no args for command help.
- Trigger `tr-55` (every 2d, spawned run) — mines recent shipped work, drafts
  platform-fit copy, schedules it, and logs each post on task ct-41857.
- API key: `PUBLORA_API_KEY` env var, or `~/.config/codecast/publora_key`. Never in the repo.

## One-time setup (human steps)

1. Create the social accounts for codecast. Start with X, Bluesky, and LinkedIn —
   the free Publora plan covers 3 accounts. Add Threads/Mastodon/Telegram later.
2. Sign up at https://publora.com and connect each account in the dashboard
   (app.publora.com) via OAuth.
3. Dashboard → API → Generate, then save the key:
   `mkdir -p ~/.config/codecast && pbpaste > ~/.config/codecast/publora_key`
4. Verify: `node scripts/publora.mjs connections` — every account should show
   `tokenStatus: valid`.
5. Fire a first run and watch it: `cast trigger run tr-55`, then unpause the
   schedule: `cast trigger resume tr-55` (it was created paused).

## Quota

Free Starter plan: 15 posts/month, and each targeted platform counts as one post —
a 3-platform blast every 2 days needs ~45/month. The trigger checks the month's count
and skips rather than overrun. For daily posting, Pro is $2.99/account/month for
100 posts per account.

## Platform fit

One `content` field goes to all targeted platforms. X auto-threads past 280 chars;
Bluesky (300), Mastodon (500), and Threads (500) hard-fail past their limits.
So either keep one version under 280, or post twice: short copy for the
microblogs, long copy for LinkedIn (3,000).
