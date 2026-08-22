PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "token_hash", "user_id", "expires_at", "created_at", "user_agent")
SELECT 'ses_' || lower(hex(randomblob(16))), "token_hash", "user_id", "expires_at", "created_at", "user_agent"
FROM `sessions`;--> statement-breakpoint
CREATE TABLE `__push_subscription_backup` AS
SELECT subscription."id", session."id" AS "session_id", subscription."endpoint", subscription."p256dh", subscription."auth", subscription."created_at", subscription."updated_at"
FROM `push_subscriptions` subscription
INNER JOIN `__new_sessions` session ON session."token_hash" = subscription."session_token_hash";--> statement-breakpoint
DROP TABLE `push_subscriptions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE TABLE `__new_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_push_subscriptions`("id", "session_id", "endpoint", "p256dh", "auth", "created_at", "updated_at")
SELECT "id", "session_id", "endpoint", "p256dh", "auth", "created_at", "updated_at"
FROM `__push_subscription_backup`;--> statement-breakpoint
DROP TABLE `__push_subscription_backup`;--> statement-breakpoint
ALTER TABLE `__new_push_subscriptions` RENAME TO `push_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_id`);
