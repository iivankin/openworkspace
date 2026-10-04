CREATE TABLE `pending_office_previews` (
	`source_key` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_office_previews_next_attempt_idx` ON `pending_office_previews` (`next_attempt_at`);