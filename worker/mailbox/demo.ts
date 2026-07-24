import type { MailAddress } from "./model";
import type { NewEmail, NewFolder } from "./schema";

type DemoInput = {
  id: string;
  conversationId: string;
  messageId: string;
  direction?: "incoming" | "outgoing";
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  preview: string;
  body: string;
  ageMs: number;
  references?: string[];
};

function email(input: DemoInput, now: number): NewEmail {
  const timelineAt = new Date(now - input.ageMs);
  const outgoing = input.direction === "outgoing";
  return {
    id: input.id,
    conversationId: input.conversationId,
    direction: outgoing ? "outgoing" : "incoming",
    messageIdHeader: input.messageId,
    inReplyToJson: input.references?.slice(-1) ?? [],
    referencesJson: input.references ?? [],
    fromJson: [input.from],
    toJson: input.to,
    ccJson: input.cc ?? [],
    subject: input.subject,
    preview: input.preview,
    bodyText: input.body,
    timelineAt,
    transportState: outgoing ? "submitted" : "received",
    deliveryStatusJson: outgoing
      ? input.to.map((recipient, index) => ({
          recipient: recipient.address,
          status: "delivered" as const,
          eventId: `demo_${input.id}_${index}`,
          eventAt: timelineAt.getTime() + 1_500,
          smtpCode: "250",
          detail: null,
        }))
      : [],
  };
}

const ilya = { address: "ilya@demo.example", name: "Ilya Morozov" };
const support = { address: "support@demo.example", name: "Customer care" };

export function demoMailboxEmails(mailboxId: string, now = Date.now()): NewEmail[] {
  if (mailboxId === "mbx_demo_personal") {
    return [
      email({
        id: "msg_demo_01",
        conversationId: "conv_demo_launch",
        messageId: "<launch@linear.demo>",
        from: { address: "karri@linear.app", name: "Karri Saarinen" },
        to: [ilya],
        subject: "The craft behind fast software",
        preview: "I kept thinking about our conversation on speed and quality. The teams that move fastest rarely skip the details.",
        body: "Hey Ilya,\n\nI kept thinking about our conversation on speed and quality. The teams that move fastest rarely skip the details — they make the right details easier to see.\n\nHere are the notes from our design review and the three decisions we should make this week.\n\nKarri",
        ageMs: 540_000,
      }, now),
      email({
        id: "msg_demo_07",
        conversationId: "conv_demo_launch",
        messageId: "<reply@openworkspace.demo>",
        direction: "outgoing",
        from: ilya,
        to: [{ address: "karri@linear.app", name: "Karri Saarinen" }],
        subject: "Re: The craft behind fast software",
        preview: "That framing is exactly right. I turned the decisions into a smaller review doc.",
        body: "That framing is exactly right. I turned the decisions into a smaller review doc and will send the final version tomorrow.\n\nThanks,\nIlya",
        ageMs: 180_000,
        references: ["<launch@linear.demo>"],
      }, now),
      email({
        id: "msg_demo_02",
        conversationId: "conv_demo_cloudflare",
        messageId: "<workers@cloudflare.demo>",
        from: { address: "jessica@cloudflare.com", name: "Jessica Lee" },
        to: [ilya],
        cc: [{ address: "maya@demo.example", name: "Maya Chen" }],
        subject: "Your Workers architecture review",
        preview: "The per-mailbox SQLite design looks solid. Keeping raw MIME in R2 leaves the mailbox database focused.",
        body: "Hi Ilya,\n\nThe per-mailbox SQLite design looks solid. Keeping raw MIME in R2 leaves the mailbox database focused on RFC metadata and conversation state.\n\nI left a few notes on retries and idempotency below.\n\nBest,\nJessica",
        ageMs: 4_200_000,
      }, now),
      email({
        id: "msg_demo_03",
        conversationId: "conv_demo_maya",
        messageId: "<maya-update@demo>",
        from: { address: "maya@demo.example", name: "Maya Chen" },
        to: [ilya],
        subject: "Friday launch checklist",
        preview: "I grouped the remaining work into launch blockers and follow-ups. We are down to four real blockers.",
        body: "I grouped the remaining work into launch blockers and follow-ups. We are down to four real blockers:\n\n1. Verify catch-all routing\n2. Run mobile QA\n3. Confirm outbound domain\n4. Write the setup guide\n\nEverything else can follow next week.",
        ageMs: 86_400_000,
      }, now),
      email({
        id: "msg_demo_04",
        conversationId: "conv_demo_vercel",
        messageId: "<design@vercel.demo>",
        from: { address: "rauno@vercel.com", name: "Rauno Freiberg" },
        to: [ilya],
        subject: "Re: interaction details",
        preview: "The reduced motion version feels right now. I would keep the mailbox transition almost instant.",
        body: "The reduced-motion build is ready for review. I shortened the mailbox transition and kept the composer animation subtle.\n\nThe updated interaction notes are attached to the ticket.",
        ageMs: 172_800_000,
      }, now),
      email({
        id: "msg_demo_05",
        conversationId: "conv_demo_weekly",
        messageId: "<weekly@paper.demo>",
        from: { address: "digest@dense-discovery.com", name: "Dense Discovery" },
        to: [ilya],
        subject: "Issue 341 — tools for thought",
        preview: "A small collection of thoughtful products, strange links, and ideas worth carrying into the weekend.",
        body: "A small collection of thoughtful products, strange links, and ideas worth carrying into the weekend.\n\nThis week: humane inboxes, local-first databases, and why fast tools feel calm.",
        ageMs: 259_200_000,
      }, now),
      email({
        id: "msg_demo_06",
        conversationId: "conv_demo_invoice",
        messageId: "<invoice@figma.demo>",
        from: { address: "billing@figma.com", name: "Figma" },
        to: [ilya],
        subject: "Your July invoice",
        preview: "Your invoice is ready. No action is required.",
        body: "Your July invoice is ready. No action is required. You can find billing details in your workspace settings.",
        ageMs: 432_000_000,
      }, now),
    ];
  }

  if (mailboxId === "mbx_demo_support") {
    return [
      email({ id: "msg_demo_08", conversationId: "conv_demo_customer1", messageId: "<help1@customer.demo>", from: { address: "noah@northstar.studio", name: "Noah Williams" }, to: [support], subject: "Can we use our own sending domain?", preview: "We are evaluating the product for our studio and need mail to come from our existing domain.", body: "Hi team,\n\nWe are evaluating the product for our studio and need mail to come from our existing domain. Is that supported, and which DNS records do we need to add?\n\nThanks,\nNoah", ageMs: 900_000 }, now),
      email({ id: "msg_demo_09", conversationId: "conv_demo_customer2", messageId: "<help2@customer.demo>", from: { address: "amina@harbor.so", name: "Amina Okafor" }, to: [support], subject: "Importing an existing mailbox", preview: "Is there a recommended path for importing a few years of historical email?", body: "Hello,\n\nIs there a recommended path for importing a few years of historical email? We have roughly 18 GB and would like to preserve threads if possible.\n\nAmina", ageMs: 7_200_000 }, now),
      email({ id: "msg_demo_10", conversationId: "conv_demo_customer3", messageId: "<help3@customer.demo>", from: { address: "lea@atelier.fr", name: "Léa Martin" }, to: [support], subject: "Shared inbox notifications", preview: "Could each person choose which shared mailboxes should send browser notifications?", body: "Bonjour,\n\nCould each person choose which shared mailboxes should send browser notifications? We have support and press addresses, but not everyone needs both.\n\nMerci,\nLéa", ageMs: 97_200_000 }, now),
      email({ id: "msg_demo_11", conversationId: "conv_demo_customer3", messageId: "<support-reply@demo>", direction: "outgoing", from: support, to: [{ address: "lea@atelier.fr", name: "Léa Martin" }], subject: "Re: Shared inbox notifications", preview: "Yes — notification preferences are per person and per mailbox.", body: "Hi Léa,\n\nYes — notification preferences are per person and per mailbox. You can stay in the shared inbox without receiving every browser notification.\n\nBest,\nMaya", ageMs: 90_000_000, references: ["<help3@customer.demo>"] }, now),
      email({ id: "msg_demo_12", conversationId: "conv_demo_spam", messageId: "<promo@spam.demo>", from: { address: "offers@growth-hack.invalid", name: "Growth Network" }, to: [support], subject: "10x your pipeline overnight", preview: "One weird trick your competitors do not want you to know.", body: "One weird trick your competitors do not want you to know.", ageMs: 345_600_000 }, now),
    ];
  }

  return [];
}

export function demoMailboxFolders(mailboxId: string): NewFolder[] {
  if (mailboxId !== "mbx_demo_personal") return [];
  return [
    {
      id: "Product",
      name: "Product",
      sortOrder: 100,
    },
    {
      id: "Pitch Decks",
      name: "Pitch Decks",
      sortOrder: 110,
    },
  ];
}

export function demoMailboxConversationState(mailboxId: string) {
  if (mailboxId === "mbx_demo_personal") {
    return [
      { id: "conv_demo_maya", folderId: "Product" },
      { id: "conv_demo_vercel", folderId: "Pitch Decks" },
      { id: "conv_demo_invoice", mailboxState: "archive" as const },
    ];
  }
  if (mailboxId === "mbx_demo_support") {
    return [{ id: "conv_demo_spam", mailboxState: "spam" as const }];
  }
  return [];
}
