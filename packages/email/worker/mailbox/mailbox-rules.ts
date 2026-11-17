/** A mailbox's rules for new mail, and its AI sorting settings. */
import {
  aiFeatureEnabled,
  createDb,
  createId,
  mailboxAccess,
} from "@open-workspace/core/module";
import { asc, desc, eq } from "drizzle-orm";

import { evaluateRules, ruleMatches } from "../mail/rules";
import type { RuleInput, RuleOutcome } from "../mail/rules";
import * as mailboxFolders from "./mailbox-folders";
import type { MailboxAiConfiguration } from "./model";
import { emails, folders, mailboxAiConfiguration, mailRules } from "./schema";
import type { MailRule, NewEmail } from "./schema";
import type { MailboxContext } from "./support";
import {
  AI_CONFIGURATION_ID,
  MAX_RULES,
  RULE_TEST_SCAN,
  ruleView,
} from "./support";

export function aiConfiguration(m: MailboxContext): MailboxAiConfiguration {
  const stored = m.db
    .select()
    .from(mailboxAiConfiguration)
    .where(eq(mailboxAiConfiguration.id, AI_CONFIGURATION_ID))
    .all()[0];

  return stored
    ? {
        instructions: stored.instructions,
        confidenceThreshold: stored.confidenceThreshold,
      }
    : {
        instructions: "",
        confidenceThreshold: 75,
      };
}

/** `folderDeleted`: a "Move to folder" action whose folder is gone, so it files nothing. */
export function listRules(m: MailboxContext) {
  const custom = new Set(
    m.db
      .select({ id: folders.id })
      .from(folders)
      .all()
      .map((folder) => folder.id)
  );

  return m.db
    .select()
    .from(mailRules)
    .orderBy(asc(mailRules.position))
    .all()
    .map((rule) => ({
      ...ruleView(rule),
      folderDeleted: rule.actionsJson.some(
        (action) =>
          action.type === "moveToFolder" && !custom.has(action.folderId)
      ),
    }));
}

/**
 * A "Move to folder" action needs a custom folder that exists, unless the
 * rule already had it: a rule whose folder was deleted can still be
 * renamed or switched off.
 */
export function ruleFolderError(
  m: MailboxContext,
  input: RuleInput,
  kept: readonly string[] = []
) {
  return input.actions.some(
    (action) =>
      action.type === "moveToFolder" &&
      !kept.includes(action.folderId) &&
      mailboxFolders.getFolder(m, action.folderId)?.kind !== "custom"
  )
    ? "Move to folder needs an existing custom folder"
    : null;
}

export function createRule(m: MailboxContext, input: RuleInput) {
  const error = ruleFolderError(m, input);

  if (error) return { status: "invalid" as const, error };

  const existing = m.db
    .select({ position: mailRules.position })
    .from(mailRules)
    .all();

  if (existing.length >= MAX_RULES) return { status: "limit" as const };

  const rule: MailRule = {
    id: createId("rule"),
    position: Math.max(0, ...existing.map((row) => row.position)) + 1,
    name: input.name,
    enabled: input.enabled,
    match: input.match,
    conditionsJson: input.conditions,
    actionsJson: input.actions,
    stopProcessing: input.stopProcessing,
    updatedAt: new Date(),
  };

  m.db.insert(mailRules).values(rule).run();

  return { status: "ok" as const, rule: ruleView(rule) };
}

export function updateRule(m: MailboxContext, id: string, input: RuleInput) {
  const stored = m.db
    .select({ actions: mailRules.actionsJson })
    .from(mailRules)
    .where(eq(mailRules.id, id))
    .all()[0];

  if (!stored) return { status: "not_found" as const };

  const error = ruleFolderError(
    m,
    input,
    stored.actions.flatMap((action) =>
      action.type === "moveToFolder" ? [action.folderId] : []
    )
  );

  if (error) return { status: "invalid" as const, error };

  const [updated] = m.db
    .update(mailRules)
    .set({
      name: input.name,
      enabled: input.enabled,
      match: input.match,
      conditionsJson: input.conditions,
      actionsJson: input.actions,
      stopProcessing: input.stopProcessing,
      updatedAt: new Date(),
    })
    .where(eq(mailRules.id, id))
    .returning()
    .all();

  if (!updated) return { status: "not_found" as const };

  return { status: "ok" as const, rule: ruleView(updated) };
}

export function deleteRule(m: MailboxContext, id: string) {
  return (
    m.db
      .delete(mailRules)
      .where(eq(mailRules.id, id))
      .returning({ id: mailRules.id })
      .all().length > 0
  );
}

export function reorderRules(m: MailboxContext, ruleIds: string[]) {
  const current = m.db.select({ id: mailRules.id }).from(mailRules).all();

  if (
    current.length !== ruleIds.length ||
    new Set(ruleIds).size !== ruleIds.length ||
    !current.every((row) => ruleIds.includes(row.id))
  ) {
    return false;
  }

  m.db.transaction((tx) => {
    for (const [index, id] of ruleIds.entries()) {
      tx.update(mailRules)
        .set({ position: index + 1 })
        .where(eq(mailRules.id, id))
        .run();
    }
  });

  return true;
}

/** How many of the latest incoming messages the conditions match; changes nothing. */
export function testRule(
  m: MailboxContext,
  rule: Pick<RuleInput, "match" | "conditions">
) {
  const recent = m.db
    .select()
    .from(emails)
    .where(eq(emails.direction, "incoming"))
    .orderBy(desc(emails.timelineAt))
    .limit(RULE_TEST_SCAN)
    .all();

  const matches = recent.filter((email) => ruleMatches(rule, email));

  return {
    scanned: recent.length,
    matches: matches.length,
    sample: matches.slice(0, 5).map((email) => ({
      id: email.id,
      conversationId: email.conversationId,
      subject: email.subject,
      from: email.fromJson[0]?.address ?? null,
      timelineAt: email.timelineAt.getTime(),
    })),
  };
}

/** The rules' verdict on a live delivery, or null when none matches. */
export function inboundRules(
  m: MailboxContext,
  email: NewEmail,
  jobId: string
): RuleOutcome | null {
  let outcome: RuleOutcome;

  try {
    outcome = evaluateRules(
      m.db
        .select()
        .from(mailRules)
        .where(eq(mailRules.enabled, true))
        .orderBy(asc(mailRules.position))
        .all()
        .map(ruleView),
      {
        fromJson: email.fromJson ?? [],
        toJson: email.toJson ?? [],
        ccJson: email.ccJson ?? [],
        envelopeTo: email.envelopeTo ?? null,
        subject: email.subject ?? "",
        listId: email.listId ?? null,
        attachmentsJson: email.attachmentsJson ?? [],
      }
    );
  } catch (error) {
    // A broken rule never holds up the delivery.
    console.error(`Rules failed for inbound delivery ${jobId}`, error);

    return null;
  }

  return outcome.matchedRuleIds.length ? outcome : null;
}

/** Everyone with access to the mailbox: whom "Mark read" marks mail read for. */
export async function mailboxReaders(m: MailboxContext) {
  const members = await createDb(m.env.DB)
    .select({ userId: mailboxAccess.userId })
    .from(mailboxAccess)
    .where(eq(mailboxAccess.mailboxId, m.state.id.name ?? ""));

  return members.map((member) => member.userId);
}

export function getMailboxAiSettings(m: MailboxContext) {
  return {
    configuration: aiConfiguration(m),
    globalEnabled: aiFeatureEnabled("classification"),
  };
}

export function setMailboxAiConfiguration(
  m: MailboxContext,
  configuration: MailboxAiConfiguration
) {
  if (
    configuration.confidenceThreshold < 50 ||
    configuration.confidenceThreshold > 100 ||
    configuration.instructions.length > 4000
  ) {
    throw new Error("Invalid mailbox AI configuration");
  }

  m.db
    .insert(mailboxAiConfiguration)
    .values({
      id: AI_CONFIGURATION_ID,
      instructions: configuration.instructions.trim(),
      confidenceThreshold: configuration.confidenceThreshold,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mailboxAiConfiguration.id,
      set: {
        instructions: configuration.instructions.trim(),
        confidenceThreshold: configuration.confidenceThreshold,
        updatedAt: new Date(),
      },
    })
    .run();

  return getMailboxAiSettings(m);
}
