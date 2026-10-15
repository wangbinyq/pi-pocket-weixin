# Security

This bridge grants one paired Weixin user the capabilities of a Pi Pocket owner. A Pocket coding agent can execute commands and access files on its host. Use only your own accounts and a trusted machine.

## Boundaries

- Only the exact Weixin identity returned by QR login is accepted. Groups, bot messages, and unrelated senders are dropped. No automatic first-sender pairing, arbitrary allowlists, or guest impersonation.
- Pocket owner authentication is checked at startup and again before processing input, collecting replies, and sending output. Conversation access is checked again before sending a persisted conversation reply.
- The bridge calls authenticated Pocket APIs; it does not read or edit Pocket's data files. Existing authorization, model selection, queueing, spend limits, and approval checks still apply.
- No approval endpoint, shell endpoint, model switch, or destructive session command is exposed through the bridge's slash commands. Ordinary language sent to Pi can still ask it to act with the owner's authority.
- A Weixin DM has one current Pocket session. Only that session is synchronized, including new final replies started in the browser or by schedules. Switching atomically retires old synchronization and cancels its unsent replies, without stopping Pocket tasks. Returning starts at the current history head rather than replaying time away. In-flight sends cannot be recalled. Route generations prevent stale history reads and retries from resurrecting cancelled output.
- Text quotes are untrusted model context, never route authority or bridge commands. Quoted media is rejected until media support exists. Rapid text may be durably combined, but commands and unsupported messages are boundaries. /retry-send retries delivery only; Hermes-style transcript rewind and model rerun are not exposed.
- HTTPS is mandatory outside loopback for Pocket. iLink endpoints must be HTTPS hosts beneath weixin.qq.com. Redirects are refused on credentialed HTTP requests. Login redirects are separately validated.
- Credentials and pending messages are **not encrypted at rest**. Private directory/file modes protect them on POSIX; backups, root, other processes under the same OS user, and compromised devices remain trusted. Windows ACL behavior is not verified.
- Do not run another consumer for the same iLink bot. Locks only coordinate this bridge under the same OS user on one machine; they do not lock other implementations or remote hosts.
- Receipts cannot guarantee exactly-once external message delivery. Ambiguous sends may repeat; repeated text is not proof of a new command. Submitted Pocket input is deduplicated by its deterministic request ID.

## Reporting

Use GitHub's private vulnerability reporting if it is enabled for this repository. Otherwise contact the repository owner privately. Never post owner tokens, QR codes, credentials.json, .env, database files, or real conversation transcripts in a public issue.

This project is an early prototype. Automated tests use protocol fixtures and an isolated Pocket instance. One real Weixin account has completed QR login and /help and /status round trips; ordinary model-task end-to-end behavior, general account eligibility, long-idle messaging limits, and server-side idempotency are not established by those checks.
