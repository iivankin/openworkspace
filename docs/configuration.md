# Configuration

You configure the workspace in `alchemy.run.ts`, in your project folder. Change
it, then run `bun run deploy`. If a setting is invalid, the deploy stops and
lists what to fix.

```ts
// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import { Email } from "@open-workspace/email/alchemy";
import * as Alchemy from "alchemy";

export default Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "mail.example.com",
    mailDomains: ["example.com", "example.org"],
    ai: {
      providers: {
        cloudflare: { type: "cloudflare" },
        anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      },
      features: {
        classification: {
          enabled: true,
          provider: "cloudflare",
          model: "openai/gpt-6-luna",
          reasoning: "medium",
        },
        translation: {
          enabled: true,
          provider: "anthropic",
          model: "claude-haiku-5-5",
          reasoning: "none",
        },
      },
    },
    modules: [Email()],
  })
);
```

## Props

| Prop          | What it sets                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`    | Required. Where the app is served, such as `mail.example.com`. It must be in a zone of your Cloudflare account. Passkeys and single sign-on apps are tied to it. |
| `mailDomains` | Required. Your mail domains, primary first. Every address in the workspace must be on one of them. See [Mail domains](deploy.md#mail-domains).                   |
| `ai`          | AI providers and the features that use them. See [AI](#ai).                                                                                                      |
| `backups`     | Daily snapshots of the workspace to a bucket of their own. See [Backups](#backups).                                                                              |
| `modules`     | The apps in the workspace, such as `Email()`.                                                                                                                    |
| `apps`        | Single sign-on apps declared in code. See [Single sign-on](sso.md#declare-apps-in-code).                                                                         |
| `webhooks`    | Webhook endpoints declared in code. See [Webhooks](webhooks.md#declare-endpoints-in-code).                                                                       |
| `env`         | Extra Worker bindings or variables.                                                                                                                              |
| `mockAuth`    | Local development and tests only: a demo sign-in that works only on `localhost`.                                                                                 |
| `seed`, `dev` | Local development only: SQL files to load into the database, and the host and port for `alchemy dev`.                                                            |

`Email()` takes three options:

- `pushContact`: the `mailto:` or `https:` contact push services see, instead
  of the app's URL.
- `retention`: how many days a conversation stays in Trash or Spam before it is
  deleted permanently, as `{ trash, spam }`. Spam defaults to 30 days. Trash,
  or a folder set to `null`, keeps mail until someone empties it. For example,
  `Email({ retention: { trash: 30, spam: 14 } })`. Conversations already in
  Trash or Spam when this ships count from the upgrade.
- `archive`: a write-once copy of every message the workspace receives and
  sends, locked for `{ years }` in a bucket of its own. Off by default. See
  [Mail archive](#mail-archive).

### Removing a mail domain

If you take a domain out of `mailDomains` while addresses still use it, the
deploy still goes through. Those addresses keep working, but nobody can create
new ones on that domain, the domain stops receiving mail, and the admin screen
shows a notice.

To retire a domain cleanly:

1. Give each person and team on it an address on another domain. Make it the
   person's primary address.
2. Delete the old addresses.
3. Remove the domain from `mailDomains` and deploy.

## Backups

```ts
OpenWorkspace({
  // …
  backups: { keepDays: 14, keepWeeks: 8 }, // or {} for these defaults
});
```

With `backups`, the deploy creates an R2 bucket for them alone, so a mistake
in the mail bucket can't take the backups with it. Once a day the Worker
starts a snapshot and writes it a batch at a time on the hourly cron, picking
up where an interrupted run stopped. Each snapshot holds:

- `backups/<id>/core.json`: people, teams, addresses, single sign-on apps,
  webhooks and branding. Sessions, passkeys, tokens, client secrets and
  signing secrets are never in it, nor apps and webhooks declared in code.
- `backups/<id>/email/<address>/*.jsonl`: one line per message with its place
  (Inbox, Archive, Spam, Trash or Sent), custom folder, read state and
  conversation; then a line for the address's settings (folders and their
  order, rules, the auto-reply and whom it answered, AI sorting
  instructions, blocked and trusted senders, the address's signature, and
  each person's notification choice), one per draft, and one per image or
  file a draft, the auto-reply or the signature holds.
- `backups/<id>/email/workspace/*.jsonl`: the workspace's blocked senders and
  each person's own signature, with its images. Other modules add folders of
  their own.
- `backups/objects/<sha256>.<extension>`: each message (`.eml`), settings
  (`.json`) and file (`.bin`), stored once however many snapshots list it.
  Sent mail is the MIME kept when it was sent (see
  [How sent mail is kept](#how-sent-mail-is-kept)), except that one which
  sent large files as download links is rebuilt with those files attached,
  so a restore still has them.
- `backups/<id>/complete.json`: written last. A snapshot without it was still
  being written, or failed, and may lack part of the data.

Sessions, push subscriptions, delivery logs, unsubscribe attempts, spam
reports and other state the workspace rebuilds or a device registers again
aren't kept.

A mailbox remembers which messages are stored, so a snapshot reads and uploads
only new mail: about 2,500 new messages an hour, and over 100,000 already
stored ones. The first snapshot of a large workspace takes a while; later ones
take minutes. The newest snapshot of each of the last `keepDays` days and of
the last `keepWeeks` weeks is kept, and once a week objects no kept snapshot
lists are deleted. A snapshot that hasn't finished a day and a half after it
started is marked failed and deleted, so the next day's can start.

**Administration → Backups** shows the latest snapshot, any problems, and
**Run now**. Only administrators see it.

### Keep a copy outside Cloudflare

The bucket guards against mistakes, bugs and leaving OpenWorkspace, but it is
in the same Cloudflare account as the workspace: losing or compromising the
account takes both. Copy it somewhere else on a schedule, such as another
provider's storage or a disk. With [rclone](https://rclone.org), an R2 API
token scoped to the backup bucket (read only), and a remote for the other
side:

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = …
secret_access_key = …
endpoint = https://<account-id>.r2.cloudflarestorage.com

[offsite]
type = b2
account = …
key = …
```

```sh
# crontab: every night at 03:30, after the day's snapshot
30 3 * * * rclone sync r2:<backup-bucket>/backups offsite:acme-workspace-backups/backups \
  --backup-dir offsite:acme-workspace-backups/deleted/$(date +\%F) \
  --max-delete 5000 --fast-list
```

`sync` keeps the copy matching what retention keeps, and copies only what is
new: objects never change once written. Whatever it would delete goes to
`deleted/<date>` instead, so if the account is taken over and the bucket
emptied, the copy still has it; `--max-delete` stops a run that would delete
far more than retention ever does. Let the other side delete `deleted/` after
a while (a lifecycle rule of, say, 30 days), so mail deleted from the
workspace leaves the backups too, as data protection rules expect. Don't set
such a rule on the rest: an object written years ago is still in today's
snapshot.

A copy made while a snapshot is being written holds part of it; the next
night completes it. Restore only snapshots with `complete.json`.

### Restore

Copy the bucket to your computer (`rclone copy r2:<backup-bucket>/backups
./backups`), then restore a snapshot as an administrator:

```sh
bunx @open-workspace/create import backup backups/2026-03-10T041700.000Z \
  --workspace https://mail.acme.com
```

It puts back what the workspace is missing and leaves what exists alone:

1. The workspace: people, as invitations (passkeys can't be restored; send
   each an invitation link from **Administration → People**), teams,
   addresses, single sign-on apps, webhooks, and the name and logo. Something
   that exists, by id or by its address, handle or entity id, is skipped.
   Restored webhooks are off with a new secret, and restored OIDC apps have
   no client secret: rotate them before turning them on.
   Aliases come back with the inbox or list they point to, a catch-all
   unless its domain has one, and forwards with their destinations, which
   Cloudflare asks to confirm again if the account is new. A destination
   Cloudflare couldn't add shows **Not added to Cloudflare** in the address
   editor; **Save address** adds it again.
2. Each module's data. Mail adds each message an address is missing, in its
   place, folder, read state and conversation; it never removes or rolls back
   mail. It adds the folders, rules (moving to the restored folders of the
   same name), drafts, blocked senders (never the workspace's own mail
   domains) and signatures that aren't there, and
   an auto-reply, AI instructions or notification choice only where none is
   set. People are matched by their primary address. A reply or forward draft
   whose message isn't restored comes back as a new message.

Run it again to retry what failed; what is there already is skipped.
Cloudflare also keeps 30 days of the database's history
([D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/))
on the Workers Paid plan.

## Mail archive

Some businesses must keep their mail unaltered for years (in Germany, for
example, § 257 HGB, § 147 AO and the GoBD). Backups don't cover that: they
can be deleted, and they miss mail deleted on the day it arrived. The mail
archive does:

```ts
modules: [Email({ archive: { years: 10 } })],
```

The deploy creates an R2 bucket, `MailArchive`, with a
[bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
rule: R2 refuses to delete or overwrite an object until it is `years` old,
whoever asks, the Worker and API tokens included.

- **Received mail** is copied byte for byte once it's accepted, as
  `<year>/<month>/incoming/<id>.eml`, including mail that lands in Spam.
  Mail to a mailing list is archived once, as the list's. Its raw copy in the
  mail bucket isn't deleted, even by **Delete forever** or by deleting the
  address, until it's archived. Mail to a forward address is archived as the
  forward's once it has been forwarded; the workspace keeps no other copy of
  it, so a copy that fails waits under `archive-staging/` in the mail bucket.
- **Refused mail isn't archived**: mail to an unknown address, a list post
  from someone not allowed to post, and a forward that isn't sent (over the
  hop limit, a workspace-blocked sender, a DMARC failure where the sender's
  policy is quarantine or reject, the sender being the only destination, or
  every destination refusing it). A DMARC failure under `p=none` is
  forwarded, so it is archived.
- **Drafts aren't archived**: they are neither sent nor received. A draft is
  archived as sent mail once it is sent.
- **Sent mail** is copied right after Email Sending accepts it, as
  `<year>/<month>/outgoing/<id>.eml`. Every message the workspace sends goes
  through the same step, auto-replies included: they aren't stored in the
  mailbox, so their copy is named `ar_<uuid>.eml` and keeps their
  `Auto-Submitted` header.
- An object is never overwritten, and carries its SHA-256 and the address's
  id in its metadata. Each message has a row in the `mail_archive_entries`
  table.
- Archiving never holds up or bounces mail. A copy that fails is retried
  every hour, after 5 minutes and then doubling up to 6 hours. If the
  database can't record a message, it is accepted anyway, and the copy waits
  under `archive-staging/` in the mail bucket for the hourly pass. Under
  **Administration → Mail archive**, for administrators, you see the counts,
  the messages not archived yet with their errors, and **Archive now**. A
  message whose source is gone (a delivery that bounced before it was
  stored, say) or that still fails after a week is marked **not archived**
  and no longer retried, so it can't hold up the rest.
- The archive starts with the deploy that turns it on; older mail isn't
  copied.

Archived copies can't be erased before `archive.years` runs out, not even
for an erasure request. Set `years` to the retention period you're legally
obliged to keep, and list the archive in your records of processing. The
retention exemption for erasure requests covers only mail you're obliged to
keep.

### How sent mail is kept

Email Sending takes a structured message, not MIME, so there are no bytes of
a sent message to keep as they were sent. The archive's copy is MIME rebuilt
from exactly what the workspace handed Email Sending: the text, HTML,
attachments, sender, recipients and headers, with the Message-ID Email
Sending returned and the time it was sent. Cloudflare adds its own headers
and DKIM signature on the way out; those aren't in the copy. Describe it that
way in your GoBD procedure documentation (Verfahrensdokumentation). Received
mail is kept as the bytes that arrived, signatures included.

The same copy is kept in the mailbox as the sent message's source: mail apps
download it as the message's blob, backups and the archive read it, and
deleting the message for good deletes it.

### What the lock does and doesn't guarantee

- It stops deletion and overwriting of an object while the rule holds,
  through the Worker, the dashboard and the S3 API alike.
- The rule itself is a bucket setting. Anyone who can edit the bucket's
  settings in the Cloudflare account can change or remove it, including by
  changing `archive.years` and deploying. Removing or shortening the rule
  unlocks objects already written, so they can be deleted. Dropping
  `archive` stops archiving new mail but leaves the bucket, its objects and
  its rule in place: the deploy doesn't delete them.
- Cloudflare's [audit log](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/)
  records changes to the bucket's settings. Keep the people who can make them
  few, and check the log.
- Pick the period the law requires, not "forever". The GDPR asks for
  personal data to be deleted once it's no longer needed, and the legal duty
  to keep mail (Art. 17(3)(b)) covers only that period. German retention
  periods run from the end of the calendar year the message is from, while
  the lock counts from the day each copy is written: lock for a year more
  than the period (`years: 11` for 10 years).
- Once its lock ends an object stays until someone deletes it; nothing
  deletes it for you.

## AI

AI is optional. Under `ai.providers` you name where models run, using any names
you like. Under `ai.features` you turn features on and point each at a
provider.

| `type`                          | Settings                                                                                                     | Model ids                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare`                    | `gateway` (optional; the account's default AI Gateway otherwise). No key: billed to your Cloudflare account. | Workers AI (`@cf/zai-org/glm-4.7-flash`), AI Gateway models (`openai/…`, `anthropic/…`, `google/…`), or `dynamic/…` routes |
| `openai`, `anthropic`, `google` | `apiKeyEnv` (required), `baseURL` and `headers` (optional)                                                   | The vendor's own ids (`gpt-5.5`, `claude-haiku-5-5`)                                                                       |
| `openai-compatible`             | `baseURL` (required), `apiKeyEnv` and `headers` (optional). For OpenRouter, vLLM, Ollama and similar.        | Whatever the endpoint accepts                                                                                              |

A feature you leave out, or set to `enabled: false`, is off.

| Feature          | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `classification` | Catches spam and sorts incoming mail into folders     |
| `translation`    | Translates messages and attachments when someone asks |

Each enabled feature sets `provider` (a name from `ai.providers`), `model`, and
optionally `reasoning`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, or `provider-default`.

API keys never go in `alchemy.run.ts`. `apiKeyEnv` names a variable, and you
put the key in `.env` under that name, for example `ANTHROPIC_API_KEY=…`. The
deploy fails if the key is missing.

Before you turn a feature on, check the provider's data-retention terms: the
model sees the full text of incoming mail. See [AI sorting](mail.md#ai-sorting)
for how it's used.

## Secrets

Secrets go in `.env` (or the environment) and are uploaded when you deploy.

| Name                                 | When you need it                                  |
| ------------------------------------ | ------------------------------------------------- |
| Each provider's `apiKeyEnv`          | Whenever that provider is declared                |
| `SPAMHAUS_DQS_KEY`                   | Optional. Turns on Spamhaus blocklist checks      |
| SCIM tokens of apps declared in code | Whatever names you read with `Config.Redacted(…)` |

You don't add signing keys, push keys, or storage credentials. The first deploy
creates them.
