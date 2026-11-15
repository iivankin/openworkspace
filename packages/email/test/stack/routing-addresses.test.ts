import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { fakeEmailRouting } from "./fake-email-routing.ts";
import { readJson } from "./json.ts";
import { drainInbound } from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";
let primaryId = "";
let teamId = "";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

const createdMailbox = z.looseObject({ mailboxId: z.string() });

/** A new address, as the admin API takes it (listPosting is filled in). */
type AddressInput = {
  address: string;
  displayName: string;
  ownerUserId: string | null;
  teamId: string | null;
  delivery: "inbox" | "list" | "alias" | "forward";
  aliasOf?: string;
  forwardTo?: string[];
  catchAll?: boolean;
};

async function createAddress(json: AddressInput) {
  const response = await call(adminCookie, "/api/admin/mailboxes", {
    method: "POST",
    json: { listPosting: "workspace", ...json },
  });

  expect(response.status).toBe(201);

  return (await readJson(response, createdMailbox)).mailboxId;
}

/**
 * A message as Email Routing hands it over, DMARC-verified unless
 * `failsDmarc`; the sender's domain publishes `dmarcPolicy` (reject).
 */
function rawMessage(input: {
  from: string;
  to: string;
  messageId: string;
  failsDmarc?: boolean;
  dmarcPolicy?: "none" | "reject";
}) {
  const domain = input.from.split("@")[1];
  const dmarc = input.failsDmarc ? "fail" : "pass";
  const policy = input.dmarcPolicy ?? "reject";

  return [
    `Received: from mail.${domain} (192.0.2.10)`,
    `        by cloudflare-email.net (cloudflare) id ${crypto.randomUUID().slice(0, 12)}`,
    `        for <${input.to}>; Sat, 31 Oct 2026 10:00:00 +0000`,
    `Authentication-Results: mx.cloudflare.net; dmarc=${dmarc} header.from=${domain} policy.dmarc=${policy}; spf=${dmarc} smtp.mailfrom=${input.from}`,
    `From: Sender <${input.from}>`,
    `To: ${input.to}`,
    `Subject: Routed ${input.messageId}`,
    `Message-ID: <${input.messageId}>`,
    "",
    "Hello.",
  ].join("\r\n");
}

function deliver(input: {
  from?: string;
  to: string;
  messageId: string;
  failsDmarc?: boolean;
  dmarcPolicy?: "none" | "reject";
  /** Destinations Email Routing refuses, as it does unconfirmed ones. */
  unverified?: string[];
}) {
  const from = input.from ?? "client@outside.test";

  return hooks.email({
    from,
    to: input.to,
    raw: rawMessage({ ...input, from }),
    unverified: input.unverified,
  });
}

async function received(mailboxId: string, messageId: string) {
  await drainInbound(mailboxId);

  return mailbox(mailboxId).getEmailByMessageId(`<${messageId}>`);
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);

  const admin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin'"
  ).first<{ id: string }>();

  adminId = required(admin, "the bootstrap creates an admin").id;

  const primary = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
  )
    .bind(adminId)
    .first<{ id: string }>();

  primaryId = required(primary, "the admin has a primary mailbox").id;

  const team = await call(adminCookie, "/api/admin/teams", {
    method: "POST",
    json: {
      name: "Support",
      slug: "support",
      description: null,
      everyone: false,
      members: [],
    },
  });

  expect(team.status).toBe(201);
  teamId = (await readJson(team, z.looseObject({ teamId: z.string() }))).teamId;
});

describe("an alias", () => {
  let aliasId = "";

  beforeAll(async () => {
    aliasId = await createAddress({
      address: "billing@example.test",
      displayName: "Billing",
      ownerUserId: adminId,
      teamId: null,
      delivery: "alias",
      aliasOf: primaryId,
    });
  });

  it("delivers into its mailbox, keeping the address it was sent to", async () => {
    const { rejection } = await deliver({
      to: "Billing@example.test",
      messageId: "alias-1@outside.test",
    });

    expect(rejection).toBeUndefined();
    expect(await received(primaryId, "alias-1@outside.test")).toMatchObject({
      envelopeTo: "Billing@example.test",
    });
    // Nothing lands in a mailbox of the alias's own.
    expect(await hooks.mailboxSql(aliasId, "SELECT id FROM emails")).toEqual(
      []
    );
  });

  it("is where a reply comes from", async () => {
    const source = required(
      await received(primaryId, "alias-1@outside.test"),
      "the alias's mail arrived"
    );

    const conversation = await call(
      adminCookie,
      `/api/mail/conversations/${source.conversationId}?mailboxId=${primaryId}`
    );

    expect(conversation.status).toBe(200);
    expect(await conversation.json()).toMatchObject({
      messages: [
        {
          replyPlan: {
            actions: [{ mode: "reply", to: ["client@outside.test"] }],
          },
        },
      ],
    });

    const reply = await call(
      adminCookie,
      `/api/mail/messages/${source.id}/replies`,
      {
        method: "POST",
        json: {
          requestId: crypto.randomUUID(),
          mailboxId: primaryId,
          mode: "reply",
          cc: [],
          bcc: [],
          bodyText: "Paid, thanks.",
        },
      }
    );

    expect(reply.status).toBe(201);

    const { messageId } = await readJson(
      reply,
      z.looseObject({ messageId: z.string() })
    );

    expect(await mailbox(primaryId).getEmail(messageId)).toMatchObject({
      fromJson: [{ address: "billing@example.test", name: "Billing" }],
    });
  });
});

describe("plus addressing", () => {
  it("delivers sam+tag@ to sam@ when there's no such address", async () => {
    const { rejection } = await deliver({
      to: "admin+shop@example.test",
      messageId: "plus-1@outside.test",
    });

    expect(rejection).toBeUndefined();
    expect(await received(primaryId, "plus-1@outside.test")).toMatchObject({
      envelopeTo: "admin+shop@example.test",
    });
  });
});

describe("the catch-all", () => {
  it("takes mail for unknown addresses on its domain only", async () => {
    expect(
      (await deliver({ to: "nobody@example.test", messageId: "lost@x.test" }))
        .rejection
    ).toBe("Mailbox nobody@example.test does not exist");

    const inboxId = await createAddress({
      address: "support@example.test",
      displayName: "Support",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      catchAll: true,
    });

    expect(
      (await deliver({ to: "nobody@example.test", messageId: "caught@x.test" }))
        .rejection
    ).toBeUndefined();
    expect(await received(inboxId, "caught@x.test")).toMatchObject({
      envelopeTo: "nobody@example.test",
    });

    // A real address, and a plus address of one, still win.
    await deliver({ to: "admin+x@example.test", messageId: "own@x.test" });
    expect(await received(primaryId, "own@x.test")).not.toBeNull();

    expect(
      (
        await deliver({
          to: "nobody@secondary.test",
          messageId: "other-domain@x.test",
        })
      ).rejection
    ).toBe("Mailbox nobody@secondary.test does not exist");
  });
});

describe("a forward", () => {
  it("adds its destinations and forwards to the ones Email Routing accepts", async () => {
    const routing = fakeEmailRouting();

    const forwardId = await createAddress({
      address: "press@example.test",
      displayName: "Press",
      ownerUserId: null,
      teamId,
      delivery: "forward",
      forwardTo: ["pr@agency.test", "client@outside.test"],
    });

    // Saving it asked Cloudflare to email both a confirmation link.
    expect([...routing.verified.keys()].sort()).toEqual([
      "client@outside.test",
      "pr@agency.test",
    ]);

    const statuses = await call(
      adminCookie,
      `/api/mail/forward-destinations/${forwardId}`
    );

    expect(await statuses.json()).toMatchObject({
      connected: true,
      destinations: [
        { email: "pr@agency.test", status: "waiting" },
        { email: "client@outside.test", status: "waiting" },
      ],
    });

    // Email Routing refuses unconfirmed destinations itself; with none left,
    // the Worker throws and the sender gets a bounce.
    const unconfirmed = await deliver({
      to: "press@example.test",
      messageId: "press-1@x.test",
      unverified: ["pr@agency.test", "client@outside.test"],
    });

    expect(unconfirmed.error).toBe(
      "Forwarding mail for press@example.test failed"
    );
    expect(unconfirmed.forwarded).toEqual([]);

    const confirmed = await deliver({
      to: "press@example.test",
      messageId: "press-2@x.test",
    });

    // Never back to its sender; the hop count goes along.
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.rejection).toBeUndefined();
    expect(confirmed.forwarded).toEqual([
      {
        to: "pr@agency.test",
        headers: [["x-openworkspace-forwarded", "1"]],
      },
    ]);

    // Failing DMARC under p=reject is refused, so the sender hears of it.
    const failing = await deliver({
      to: "press@example.test",
      messageId: "press-3@x.test",
      failsDmarc: true,
    });

    expect(failing.forwarded).toEqual([]);
    expect(failing.rejection).toBe(
      "Not forwarded: the message failed DMARC, and outside.test asks to reject such mail"
    );

    // Under p=none the domain asks for nothing: it goes on.
    const unenforced = await deliver({
      to: "press@example.test",
      messageId: "press-4@x.test",
      failsDmarc: true,
      dmarcPolicy: "none",
    });

    expect(unenforced.rejection).toBeUndefined();
    expect(unenforced.forwarded.map((forward) => forward.to)).toEqual([
      "pr@agency.test",
    ]);
  });

  it("shows a destination Email Routing lacks, and adds it again", async () => {
    const routing = fakeEmailRouting();

    const forwardId = await createAddress({
      address: "media@example.test",
      displayName: "Media",
      ownerUserId: null,
      teamId,
      delivery: "forward",
      forwardTo: ["desk@agency.test"],
    });

    // As if adding it had failed when the address was saved.
    routing.verified.delete("desk@agency.test");

    const missing = await call(
      adminCookie,
      `/api/mail/forward-destinations/${forwardId}`
    );

    expect(await missing.json()).toMatchObject({
      destinations: [{ email: "desk@agency.test", status: "missing" }],
    });

    const retried = await call(
      adminCookie,
      `/api/mail/forward-destinations/${forwardId}`,
      { method: "POST" }
    );

    expect(retried.status).toBe(200);
    await retried.body?.cancel();
    expect(routing.verified.get("desk@agency.test")).toBe(false);
  });

  it("shows its destinations only to people who manage the address", async () => {
    const invitation = await call(adminCookie, "/api/admin/invitations", {
      method: "POST",
      json: { name: "Member", email: "member@example.test" },
    });

    const { accessLink } = await readJson(
      invitation,
      z.object({ accessLink: z.looseObject({ userId: z.string() }) })
    );

    await env.DB.prepare(
      "UPDATE users SET status = 'active', permissions = ? WHERE id = ?"
    )
      .bind(JSON.stringify(["manage_people"]), accessLink.userId)
      .run();

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: accessLink.userId }),
      })
    );

    const memberCookie = sessionCookie(login);
    await login.json();

    const forward = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE local_part = 'press'"
    ).first<{ id: string }>();

    // A team's forward needs manage_teams; manage_people isn't enough.
    const refused = await call(
      memberCookie,
      `/api/mail/forward-destinations/${required(forward, "saved").id}`
    );

    expect(refused.status).toBe(403);
    await refused.body?.cancel();
  });
});
