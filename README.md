# OpenWorkspace

Self-hosted team mail on Cloudflare — personal and shared inboxes, passkey-only access, no passwords to manage.

One Worker, your domain, your data. Invite people with a link, grant mailbox access, and send and receive mail without running an MTA.

## Highlights

- **Passkeys only** — no passwords, invitations and recovery via one-time links
- **Personal and shared mailboxes** — read-only or read-and-send access per member
- **Catch-all routing** — accept every address at your domain; only provisioned mailboxes receive mail
- **Delivery status** — bounces, deferrals, and complaints surface in the app
- **Runs on Cloudflare** — Workers, D1, Durable Objects, R2, Email Service, and Queues

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iivankin/openworkspace)

Or clone and deploy from your machine (requires [Bun](https://bun.sh) and a Cloudflare account):

```bash
git clone git@github.com:iivankin/openworkspace.git
cd openworkspace
bun install
bun run deploy
```

Cloudflare provisions D1 and R2 from `wrangler.jsonc`. Domain mail setup is manual — complete it once after the first deploy.

### Connect your domain

1. **Email Routing** — In **Compute → Email Service → Email Routing**, enable Email Routing for your domain.
2. **Catch-all** — Under **Routing Rules**, enable **Catch-all**, choose **Send to a Worker**, and select this Worker.
3. **Outbound sending** — Under **Email Sending**, onboard the same domain. Cloudflare adds SPF, DKIM, return-path, and DMARC records.
4. **Delivery events** — Open **Queues → openworkspace-delivery-events → Subscriptions**, subscribe to **Email Sending** for that domain, and select all six `message.*` events.
5. **First admin** — Open the app. With an empty database, the first-run screen creates your personal mailbox and registers you as administrator with a passkey.

Unknown catch-all recipients are rejected permanently. Only addresses you create in the app accept mail.

Docs: [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) · [Catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#catch-all-rule) · [Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## Local development

Requires [Bun](https://bun.sh).

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:setup:local
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). Local seed includes an admin, a member, mailboxes, and sample messages. With `ALLOW_MOCK_AUTH=true` (dev only), **Open seeded local demo** skips WebAuthn.

| Fixture | Path |
| --- | --- |
| Invitation | `/invite/demo-invitation-token` (while signed out) |
| Passkey recovery | `/recover/demo-recovery-token` |

Outbound mail is logged locally instead of sent. Useful checks: `bun run typecheck`, `bun run test`, `bun run build`.

## Using the app

- **Empty install** — first visitor sets a name and personal email, registers a passkey, and becomes admin.
- **Invite users** — admin creates a person with a personal mailbox and shares the one-time invitation link. They register a passkey to join.
- **Recover access** — admin issues a one-hour recovery link; redeeming it replaces all passkeys and ends existing sessions.
- **Shared mailboxes** — admin adds members with read-only or read-and-send access. Everyone who is a member can read; there is no send-only mode.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
