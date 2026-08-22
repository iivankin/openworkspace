PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token_hash` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_token_hash`) REFERENCES `sessions`(`token_hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `push_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_push_subscriptions` RENAME TO `push_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_token_hash`);
