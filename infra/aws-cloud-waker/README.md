# Cloud trigger waker

This is an opt-in backend capability for existing sessions on the approved host. It creates no compute, exposes no public AWS control API and sends no project files or credentials through the message database.

## Approved identity

`codecast-cloud-waker` is a dedicated IAM user without console access. Its sole inline policy is `start-instance-policy.json`: StartInstances on one EC2 ARN, in one region. It has no stop, terminate, provision, describe, IAM or other permissions. Do not copy the workstation's ambient credentials; those are unrelated administrative credentials.

The operator configures these server-only environment variables:

- `CAST_CLOUD_WAKE_AWS_ACCESS_KEY_ID`
- `CAST_CLOUD_WAKE_AWS_SECRET_ACCESS_KEY`
- `CAST_CLOUD_WAKE_AWS_SESSION_TOKEN` only for temporary credentials
- `CAST_CLOUD_WAKE_HOSTS`, an explicit JSON array, maximum 32 entries:

```json
[{"ownerUserId":"<registered Codecast user id>","deviceId":"<registered remote device id>","instanceId":"i-084309c56a91e15ff","region":"us-west-2"}]
```

The owner/device tuple must match both the conversation owner and a registered remote device. Neither a task nor an API caller supplies an AWS target. Invalid configuration logs a sanitized warning and disables server ownership: no server AWS call is allowed, while existing local scheduling remains available. AWS credentials and signing details are never stored on device rows; audit metadata contains only the request timestamp, attempts, lease, sanitized error code and AWS request ID.

## Release sequence

1. The release owner typechecks and deploys a reviewed, up-to-date candidate through `packages/convex/deploy.sh`, before shipping clients. Do not deploy the shared in-flight checkout.
2. Set dedicated credentials on that exact deployment, using private files and the CLI's `env set NAME --from-file <file>` support. Do not put secrets in argv, terminal output, source patches or task comments. Leave the allowlist empty until credentials and the backend are ready.
3. Set `CAST_CLOUD_WAKE_HOSTS` last. This switches the configured targets to server scheduling and suppresses their laptop wake/claim paths. Other triggers remain daemon-owned. The two minute device heartbeat threshold avoids starting an instance that has just answered.
4. Inspect internal `cloudWake:status`. A cron dispatches due bound triggers every minute; another reconciles expired leases and lost wake schedules. A bounded, owner-scoped recovery scan reconstructs wake intent if a final heartbeat cleared it before pending work was delivered and the host then went offline. Delivered, failed and cancelled messages do not wake the host. Each wake has at most five attempts. Success is followed by a heartbeat check; a failed or missing heartbeat remains visible as failure, not silently done.
5. After repairing a permanent failure (for example revoked credentials), send fresh work or run the bound trigger again to create a new wake request. This deliberately does not retry authorization failures forever.

Removing the allowlist reverses server ownership and restores the existing laptop paths. Removing the dedicated credentials alone does not restore ownership: it causes fail-closed wake failures. To disable the feature, remove the allowlist first, then deactivate the dedicated key if needed. Existing sessions and worktrees are not deleted. Already-in-flight StartInstances calls can finish; they target only the approved host.

A daemon that already claimed a trigger before opt-in may finish that run. Use a newly created future trigger for rollout proof rather than changing ownership mid-run.

## Required live acceptance

- Keep the original private cloud worktree and its assigned port.
- Schedule a new trigger bound to that session; stop the existing host and verify EC2 reports stopped before the trigger is due.
- Verify laptop `getDueTasks` excludes this trigger, `claimTask` refuses it, and heartbeat `wake_devices` excludes the host. This makes laptop mediators absent for the target without interrupting unrelated fleet jobs.
- Observe the server's `cloud_trigger_dispatched` record, the matching pending-message client ID, leased wake audit and AWS request ID. Verify CloudTrail attributes StartInstances to the dedicated IAM user, not a laptop identity.
- Verify the original agent responds after the host boots, from the preserved worktree and allocated port. Inspect the actual response; EC2 running or an injected message alone is not task execution.
- Exercise wrong owner/device internal claims and require `NotAllowlisted` with no AWS call. An attempted arbitrary instance argument is not accepted by the internal action schema. With the dedicated key, AWS DryRun must deny an unapproved existing instance while allowing the approved one.
- Return the test host to its prior idle/sleep policy and retain the user's worktree. Do not stop unrelated instances or processes.

The trigger dispatcher's transaction inserts the normal pending message and advances the trigger together. It does not spawn an agent or copy a transcript itself. Existing remote delivery resumes the original session. The usual task-run completion semantics still count successful injection separately from the agent's eventual response.
