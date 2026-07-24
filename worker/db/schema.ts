import { sql } from "drizzle-orm";
import { accessLinkKinds } from "../../shared/auth";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["invited", "active"] })
      .notNull()
      .default("invited"),
    ...timestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    index("users_role_idx").on(table.role),
  ],
);

/**
 * The singleton installation row is created atomically with the first user.
 * Its primary key prevents two concurrent bootstrap requests from creating
 * multiple initial administrators.
 */
export const installations = sqliteTable("installations", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    displayName: text("display_name").notNull(),
    kind: text("kind", { enum: ["personal", "shared"] }).notNull(),
    personalOwnerId: text("personal_owner_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailboxes_address_unique").on(table.address),
    uniqueIndex("mailboxes_personal_owner_unique").on(table.personalOwnerId),
    index("mailboxes_kind_idx").on(table.kind),
  ],
);

export const mailboxMembers = sqliteTable(
  "mailbox_members",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canSend: integer("can_send", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_members_user_idx").on(table.userId),
  ],
);

export const passkeyCredentials = sqliteTable(
  "passkey_credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    deviceType: text("device_type", {
      enum: ["singleDevice", "multiDevice"],
    }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" })
      .notNull()
      .default(false),
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("passkey_credentials_user_idx").on(table.userId)],
);

export const accessLinks = sqliteTable(
  "access_links",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: accessLinkKinds }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("access_links_token_hash_unique").on(table.tokenHash),
    index("access_links_user_kind_idx").on(table.userId, table.kind),
    index("access_links_expiry_idx").on(table.expiresAt),
  ],
);

/**
 * A claim is inserted in the same D1 batch as the credential. The primary key
 * turns invitation and recovery redemption into an atomic, exactly-once
 * operation even if two WebAuthn ceremonies finish at the same time.
 */
export const accessLinkClaims = sqliteTable("access_link_claims", {
  accessLinkId: text("access_link_id")
    .primaryKey()
    .references(() => accessLinks.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    kind: text("kind", {
      enum: ["bootstrap", ...accessLinkKinds, "authentication"],
    }).notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    accessLinkId: text("access_link_id").references(() => accessLinks.id, {
      onDelete: "cascade",
    }),
    rpId: text("rp_id").notNull(),
    origin: text("origin").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("auth_challenges_expiry_idx").on(table.expiresAt),
    index("auth_challenges_user_idx").on(table.userId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
