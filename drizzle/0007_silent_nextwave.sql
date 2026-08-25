CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cloudflare_zone_id` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name_unique` ON `domains` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `domains_primary_unique` ON `domains` (`is_primary`) WHERE "domains"."is_primary" = 1;--> statement-breakpoint
INSERT INTO `domains` (`id`, `name`, `cloudflare_zone_id`, `is_primary`, `created_by_user_id`, `created_at`, `updated_at`)
SELECT 'dom_primary', `domain`, NULL, 1, `owner_user_id`, `created_at`, unixepoch() * 1000
FROM `installations`;--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `updated_at`)
SELECT 'ai_processing_enabled', CASE WHEN `ai_processing_enabled` = 1 THEN 'true' ELSE 'false' END, unixepoch() * 1000
FROM `installations`;--> statement-breakpoint
DROP TABLE `installations`;--> statement-breakpoint
-- D1 keeps foreign keys enabled inside migrations, so dropping the parent
-- mailbox table cascades into these children. Preserve them explicitly.
CREATE TABLE `__mailbox_members_backup` AS
SELECT * FROM `mailbox_members`;--> statement-breakpoint
CREATE TABLE `__mailbox_notification_preferences_backup` AS
SELECT * FROM `mailbox_notification_preferences`;--> statement-breakpoint
CREATE TABLE `__new_mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`local_part` text NOT NULL,
	`domain_id` text NOT NULL,
	`display_name` text NOT NULL,
	`owner_user_id` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "mailboxes_primary_owner_check" CHECK("is_primary" = 0 OR "owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_mailboxes`("id", "local_part", "domain_id", "display_name", "owner_user_id", "is_primary", "created_by_user_id", "created_at", "updated_at")
SELECT
	"id",
	substr("address", 1, instr("address", '@') - 1),
	'dom_primary',
	"display_name",
	"personal_owner_id",
	CASE WHEN "personal_owner_id" IS NULL THEN 0 ELSE 1 END,
	"created_by_user_id",
	"created_at",
	"updated_at"
FROM `mailboxes`;--> statement-breakpoint
DROP TABLE `mailboxes`;--> statement-breakpoint
ALTER TABLE `__new_mailboxes` RENAME TO `mailboxes`;--> statement-breakpoint
INSERT INTO `mailbox_members` (`mailbox_id`, `user_id`, `can_send`, `created_at`)
SELECT `mailbox_id`, `user_id`, `can_send`, `created_at`
FROM `__mailbox_members_backup`;--> statement-breakpoint
INSERT INTO `mailbox_notification_preferences` (`mailbox_id`, `user_id`, `enabled`, `updated_at`)
SELECT `mailbox_id`, `user_id`, `enabled`, `updated_at`
FROM `__mailbox_notification_preferences_backup`;--> statement-breakpoint
DROP TABLE `__mailbox_members_backup`;--> statement-breakpoint
DROP TABLE `__mailbox_notification_preferences_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_unique` ON `mailboxes` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_owner_primary_unique` ON `mailboxes` (`owner_user_id`) WHERE "mailboxes"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `mailboxes_owner_idx` ON `mailboxes` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_domain_idx` ON `mailboxes` (`domain_id`);
