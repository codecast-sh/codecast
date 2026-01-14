# Agent Notes

## Dev Server

Run dev server:
```bash
./dev.sh      # http://local.codecast.sh (usually already running at this address)
./dev.sh 1    # http://local.1.codecast.sh
./dev.sh 2    # http://local.2.codecast.sh
```

## Test Credentials
For testing the web app locally see email and password in packages/web/.env.local as TEST_USER_EMAIL and TEST_USER_PASSWORD.

## CLI Commands

```bash
# Search & Browse
codecast search "auth"                # search current project
codecast search "bug" -g -s 7d        # global, last 7 days
codecast feed                         # browse recent conversations
codecast read <id> 15:25              # read messages 15-25

# Analysis
codecast diff <id>                    # files changed, commits, tools used
codecast diff --today                 # aggregate today's work
codecast summary <id>                 # goal, approach, outcome, files
codecast context "implement auth"     # find relevant prior sessions
codecast ask "how does X work"        # query across sessions

# Handoff & Tracking
codecast handoff                      # generate context transfer doc
codecast bookmark <id> <msg> --name x # save shareable link
codecast decisions list               # view architectural decisions
codecast decisions add "title" --reason "why"
```

Common options: -g (global), -s/-e (start/end: 7d, 2w, yesterday), -p (page), -n (limit)

## Debugging Lessons

### Convex Auth Issues
- When debugging Convex Auth (OAuth, login issues), check `npx convex logs` FIRST before investigating client-side redirect flows
- The `profile` function in Convex Auth providers MUST return an `id` field as a string
- Error "The profile method of the github config must return a string ID" means you're missing the `id` field in your profile return object
