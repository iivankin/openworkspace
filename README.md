# OpenWorkspace

Self-hosted team mail on Cloudflare — personal and shared inboxes, passkey-only access, no passwords to manage.

One Worker, your domain, your data. Invite people with a link, grant mailbox access, and send and receive mail without running an MTA.

## Highlights

- **Passkeys only** — no passwords, invitations and recovery via one-time links
- **Personal and shared mailboxes** — read-only or read-and-send access per member
- **Catch-all routing** — accept every address at your domain; only provisioned mailboxes receive mail
- **Delivery status** — bounces, deferrals, and complaints surface in the app
- **Runs on Cloudflare** — Workers, D1, Durable Objects, R2, Images, Email Service, and Queues

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iivankin/openworkspace)

Or clone and deploy from your machine (requires [Bun](https://bun.sh) and a Cloudflare account):

```bash
git clone git@github.com:iivankin/openworkspace.git
cd openworkspace
bun install
bun run deploy
```

Cloudflare provisions D1, R2, and the Images binding from `wrangler.jsonc`. Domain mail setup is manual — complete it once after the first deploy.

### Pull updates from upstream

The Deploy button creates a copy of this repo on your GitHub account. To take template updates later:

```bash
bun run sync:upstream
```

The script asks whether to run `bun install` and push to `origin`.
The script merges upstream (`main` or `master`) and keeps your Cloudflare-provisioned D1/R2 identifiers in `wrangler.jsonc`. Deploy-button copies often have no shared git history with this repo; the first sync allows unrelated histories and prefers upstream on conflicts, then restores your local D1/R2 ids. If a merge conflict remains, resolve it manually and keep your local `database_id` / `bucket_name`.

### Connect your domain

1. **Email Routing** — In **Compute → Email Service → Email Routing**, enable Email Routing for your domain.
2. **Catch-all** — Under **Routing Rules**, enable **Catch-all**, choose **Send to a Worker**, and select this Worker.
3. **Outbound sending** — Under **Email Sending**, onboard the same domain. Cloudflare adds SPF, DKIM, return-path, and DMARC records.
4. **Delivery events** — Open **Queues → openworkspace-delivery-events → Subscriptions**, subscribe to **Email Sending** for that domain, and select all six `message.*` events.
5. **First admin** — Open the app. With an empty database, the first-run screen creates your personal mailbox and registers you as administrator with a passkey.
6. **Profile photos** — Enable **Images** for the account if prompted. Create a public delivery variant named `public` (or `avatar`). Uploaded avatars use custom ids `avatars/<userId>` and are served from `https://imagedelivery.net/<account_hash>/avatars/<userId>/public` (not your Worker domain). Optional later: a custom Images delivery hostname in the dashboard.
7. **Direct attachment uploads** — Optional. Create an R2 API token (Object Read & Write) for the mail bucket and set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID`. In the R2 bucket **Settings → CORS**, allow your app origin with methods `PUT` and `HEAD` and headers `Content-Type`. Without these secrets, uploads still work through the Worker.

Unknown catch-all recipients are rejected permanently. Only addresses you create in the app accept mail.

### Enable the OIDC identity provider

Each deployment can act as one OpenID Connect issuer for its existing users.
Configure the canonical public origin and an RSA signing key:

```bash
bun run oidc:keygen
wrangler secret put OIDC_ISSUER
wrangler secret put OIDC_SIGNING_PRIVATE_JWK
```

Use the exact HTTPS origin (for example `https://mail.example.com`) as
`OIDC_ISSUER`, and paste the generated JSON as `OIDC_SIGNING_PRIVATE_JWK`.
Then open **Administration → SSO applications** to register each relying
party's exact redirect URI, scopes, client type, and assigned users. A
confidential client secret is displayed once.

Clients discover the provider at:

```text
https://mail.example.com/.well-known/openid-configuration
```

The provider supports Authorization Code with mandatory PKCE S256, public and
confidential clients, `openid profile email groups offline_access`, rotating
refresh tokens, revocation, UserInfo, and RP-initiated logout. Group membership
never grants application access; the client only receives group slugs selected
in its claim allowlist.

For signing-key rotation, retain the previous public JWK in a
`{"keys":[...]}` value under `OIDC_PREVIOUS_PUBLIC_JWKS`, deploy the new private
key, and keep the previous public key published until old ID tokens and JWKS
caches have expired.

Docs: [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) · [Catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#catch-all-rule) · [Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## Local development

Requires [Bun](https://bun.sh).

```bash
bun install
cp .dev.vars.example .dev.vars
```

Uncomment `ALLOW_MOCK_AUTH=true` in `.dev.vars` (dev only), then:

```bash
bun run db:setup:local
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). Local seed includes an admin, a member, mailboxes, and sample messages. With mock auth enabled, **Open seeded local demo** skips WebAuthn.

| Fixture | Path |
| --- | --- |
| Invitation | `/invite/demo-invitation-token` (while signed out) |
| Passkey recovery | `/recover/demo-recovery-token` |

Outbound mail is logged locally instead of sent. Useful checks: `bun run typecheck`, `bun run test`, `bun run build`.

## Using the app

- **Empty install** — first visitor sets a name and personal email, registers a passkey, and becomes admin.
- **Invite users** — admin creates a person with a personal mailbox and shares the one-time invitation link. They register a passkey to join.
- **Recover access** — admin issues a one-hour recovery link; redeeming it replaces all passkeys and ends existing sessions.
- **Settings** — each person uploads or removes their avatar under **Settings → Profile**, and chooses light/dark/system under **Appearance**.
- **Shared mailboxes** — admin adds members with read-only or read-and-send access. Everyone who is a member can read; there is no send-only mode.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
