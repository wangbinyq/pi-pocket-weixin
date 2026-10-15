# Security

This bridge grants one paired Weixin user the capabilities of a Pi Pocket owner. A Pocket coding agent can execute commands and access files on its host. Use only your own accounts and a trusted machine.

## Boundaries

- Only the exact Weixin identity returned by QR login is accepted. Groups, bot messages, and unrelated senders are dropped. No automatic first-sender pairing, arbitrary allowlists, or guest impersonation.
- Pocket owner authentication is checked at startup and again before processing input, collecting replies, and sending output. Conversation access is checked again before sending a persisted conversation reply.
- The bridge calls authenticated Pocket APIs; it does not read or edit Pocket's data files. Existing authorization, model selection, queueing, spend limits, and approval checks still apply.
- No approval endpoint, shell endpoint, model switch, or destructive session command is exposed through the bridge's slash commands. Ordinary language sent to Pi can still ask it to act with the owner's authority.
- Connecting a session explicitly subscribes its future final replies to Weixin, including work started in the browser or by schedules. Switching does not unsubscribe previous sessions. Use /unwatch to cancel a subscription and its pending replies. A send already in flight cannot be recalled.
- HTTPS is mandatory outside loopback for Pocket. iLink endpoints must be HTTPS hosts beneath weixin.qq.com. Redirects are refused on credentialed HTTP requests. Login redirects are separately validated.
- Credentials and pending messages are **not encrypted at rest**. Private directory/file modes protect them on POSIX; backups, root, other processes under the same OS user, and compromised devices remain trusted. Windows ACL behavior is not verified.
- Do not run another consumer for the same iLink bot. Locks only coordinate this bridge under the same OS user on one machine; they do not lock other implementations or remote hosts.
- Receipts cannot guarantee exactly-once external message delivery. Ambiguous sends may repeat; repeated text is not proof of a new command. Submitted Pocket input is deduplicated by its deterministic request ID.

## Reporting

Use GitHub's private vulnerability reporting if it is enabled for this repository. Otherwise contact the repository owner privately. Never post owner tokens, QR codes, credentials.json, .env, database files, or real conversation transcripts in a public issue.

This project is an early prototype. Tests exercise protocol fixtures and an isolated Pocket instance, not real Weixin account eligibility, login, messaging limits, or server-side idempotency.
