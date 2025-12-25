# Agent Notes

## Test Credentials
For testing the web app locally, use:
- Email: ashot@almostcandid.com
- Password: Sheep2Mylk
These are also stored in packages/web/.env.local as TEST_USER_EMAIL and TEST_USER_PASSWORD.

## Debugging Lessons

### Convex Auth Issues
- When debugging Convex Auth (OAuth, login issues), check `npx convex logs` FIRST before investigating client-side redirect flows
- The `profile` function in Convex Auth providers MUST return an `id` field as a string
- Error "The profile method of the github config must return a string ID" means you're missing the `id` field in your profile return object
