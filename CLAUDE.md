# Elevate Opportunity Digest

Weekly Claude Code routine that pulls active opportunities from Lightfield, drafts a next-step and email for each one in Russ's voice, and posts the digest as a threaded Slack message to `#elevatemsp-primary-gtm`.

## Auto-run behavior (cloud sessions)

**If you are running in a cloud session (`CLAUDE_CODE_REMOTE=true`) and no other task has been given, your job is to run the digest immediately — do not wait for user input.**

```bash
bun run digest
```

Run it, report what was posted to Slack, commit any lockfile changes, and push. That's the whole job.

## Running the digest

```bash
bun run digest
```

The script will:
1. Fetch all active opportunities from Lightfield (New → Closing stages)
2. For each opportunity: pull champion contacts, notes, meeting summaries, and the last 90 days of Gmail threads
3. Analyze each opportunity using a Claude subagent (via `@anthropic-ai/claude-agent-sdk`) — no separate `ANTHROPIC_API_KEY` needed
4. Post a threaded digest to Slack

## Environment variables

Set in the "Elevate Opportunity Digest" cloud environment config (not in `.env`):

| Variable | Purpose |
|---|---|
| `LIGHTFIELD_API_KEY` | Lightfield CRM API access |
| `SLACK_BOT_TOKEN` | Post to `#elevatemsp-primary-gtm` |
| `GMAIL_USER` | Gmail account for IMAP email fetch |
| `GMAIL_APP_PASSWORD` | Gmail App Password (not account password) |
| `GITHUB_TOKEN` | Lets the session-start hook wire up `git push` auth |

`ANTHROPIC_API_KEY` is **not** needed — Claude analysis runs via the agent SDK using Claude Code's own auth.

## Git workflow in web sessions

Commit signing is broken in this environment. Always commit with:

```bash
git -c commit.gpgsign=false commit -m "..."
git push -u origin main
```

The session-start hook automatically sets the remote URL with `GITHUB_TOKEN` so `git push` works without extra config.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude subagent analysis (replaces direct SDK)
- `imapflow` — Gmail IMAP access
- `mailparser` — Parse raw email messages
