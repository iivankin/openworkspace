PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_push_subscriptions` (
  `id`, `user_id`, `endpoint`, `p256dh`, `auth`, `created_at`, `updated_at`
)
SELECT
  subscription.`id`, session.`user_id`, subscription.`endpoint`,
  subscription.`p256dh`, subscription.`auth`, subscription.`created_at`,
  subscription.`updated_at`
FROM `push_subscriptions` subscription
INNER JOIN `sessions` session ON session.`id` = subscription.`session_id`;--> statement-breakpoint
DROP TABLE `push_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_push_subscriptions` RENAME TO `push_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
DROP INDEX `sessions_user_idx`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `location` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip_address` text;--> statement-breakpoint
CREATE INDEX `sessions_user_created_idx` ON `sessions` (`user_id`,`created_at`);
