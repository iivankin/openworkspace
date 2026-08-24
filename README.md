# OpenWorkspace

Self-hosted team mail on Cloudflare — personal and shared inboxes, passkey-only access, no passwords to manage.

One Worker, your domain, your data. Invite people with a link, grant mailbox access, and send and receive mail without running an MTA.

## Highlights

- **Passkeys only** — no passwords, invitations and recovery via one-time links
- **Personal and shared mailboxes** — read-only or read-and-send access per member
- **Catch-all routing** — accept every address at your domain; only provisioned mailboxes receive mail
- **Delivery status** — bounces, deferrals, and complaints surface in the app
- **Realtime and push** — mailbox-scoped WebSockets plus optional PWA notifications
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
7. **Attachment upload cleanup** — Run `bun run r2:lifecycle:setup` once to expire abandoned composer uploads after seven days. If the provisioned bucket is not named `openworkspace`, run `R2_BUCKET_NAME=<bucket> bun run r2:lifecycle:setup`.
8. **Direct attachment uploads** — Optional. Create an R2 API token (Object Read & Write) for the mail bucket and set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID`. In the R2 bucket **Settings → CORS**, allow your app origin with methods `PUT` and `HEAD` and headers `Content-Type`. Without these secrets, uploads still work through the Worker.
9. **Show original authentication** — Optional.
   1. Open [Cloudflare User API Tokens](https://dash.cloudflare.com/profile/api-tokens) (**My Profile → API Tokens**, not **Account API Tokens**) and choose **Create Token → Custom token**.
   2. Grant **Zone → Analytics → Read** and scope the token to **Include → Specific zone → your mail domain**. Copy the token when Cloudflare shows it; the value is displayed only once.
   3. Open that domain's **Overview** page and copy **Zone ID** from the **API** section.
   4. Store both values on the deployed Worker from the project directory. Wrangler prompts for each value without putting it in shell history:

      ```bash
      bunx wrangler secret put CLOUDFLARE_ZONE_ID
      bunx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
      ```

   Show original will display Cloudflare's SPF, DKIM, DMARC, and spam results for incoming messages. Analytics can only be fetched during Cloudflare's 31-day retention window; fetched results are retained with the message.
10. **AI mail processing** — Optional. An admin enables Workers AI globally under **Administration → Mailboxes**. Mailbox members then configure folders, the shared confidence threshold, and classification rules from the folder-management button beside that mailbox's folders. Incoming mail is checked for spam and assigned to one existing custom folder before realtime updates and push delivery. After two failed inference attempts, mail falls back to Inbox. Workers AI usage is billed to the Cloudflare account, including calls made from local development.
11. **Push notifications** — Generate one persistent VAPID key pair with `bun run push:keygen`. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a contact such as `mailto:admin@example.com` in `VAPID_SUBJECT` with `wrangler secret put`. Users can then enable the current device and choose mailboxes under **Settings → Notifications**. Device registrations belong to the current login session, so signing out or recovering an account disables them until the user explicitly enables that device again.

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

Outbound mail is logged locally instead of sent. To test push locally, add a key pair from `bun run push:keygen` and `VAPID_SUBJECT` to `.dev.vars`. Useful checks: `bun run typecheck`, `bun run test`, `bun run build`.

## Using the app

- **Empty install** — first visitor sets a name and personal email, registers a passkey, and becomes admin.
- **Invite users** — admin creates a person with a personal mailbox and shares the one-time invitation link. They register a passkey to join.
- **Recover access** — admin issues a one-hour recovery link; redeeming it replaces all passkeys and ends existing sessions.
- **Settings** — each person manages their avatar, appearance, current-device push subscription, and per-mailbox notification preferences.
- **Shared mailboxes** — admin adds members with read-only or read-and-send access. Everyone who is a member can read; there is no send-only mode.
- **PWA notifications** — desktop and Android browsers can subscribe from Settings. On iPhone and iPad, first add OpenWorkspace to the Home Screen, then enable notifications from the installed app.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
