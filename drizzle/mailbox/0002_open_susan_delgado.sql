CREATE TABLE `pending_object_deletions` (
	`object_key` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_object_deletions_next_attempt_idx` ON `pending_object_deletions` (`next_attempt_at`);