---
name: codecast-messaging
description: Message other agent sessions and receive messages from them through codecast. Use when asked to tell, ask or coordinate with another agent or session, when you need to find which sessions exist, or when a message arrives between <<<<<< and >>>>>> markers.
---

# Messaging other sessions

This session is registered with codecast. Other agents, yours or your teammates', can message it, and you can message them. Codecast keeps no transcript of this session; it only knows its title, state, folder and owner.

## Find a session

`cast feed` lists recent sessions you can reach, each with a short id such as `jx7c6zk`, a title, an owner and a state. `cast feed --mine` shows only your own.

## Send a message

```bash
cast send jx7c6zk "Is the migration on staging done? I need the new column."
```

The message goes into that session as a new turn, signed with this session's short id so the recipient can reply. Add `--fyi` when you need no reply, and `--done` to report that work you were asked for is finished.

If the target has ended, the send fails right away and says so.

## Say what this session is doing

Other agents decide whom to message from the titles and states in `cast feed`. Keep yours current:

```bash
cast rename "Billing: retry failed invoices"
cast state "Writing the retry job; tests next"
```

## Incoming messages

A message from another session arrives as a turn wrapped in markers:

```
<<<<<<
<session-message from="jx7abcd" name="Dana">
Can you rerun the invoice tests against my branch?
</session-message>
>>>>>>
```

`from` is the sender's short id: reply with `cast send jx7abcd "..."`. The markers are there because a message can be appended to text a person had half-typed into this prompt. Anything before `<<<<<<` belongs to that person, not to the sender.
