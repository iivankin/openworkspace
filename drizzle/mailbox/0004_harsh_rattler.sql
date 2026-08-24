CREATE TABLE `mailbox_ai_configuration` (
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`confidence_threshold` integer DEFAULT 75 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `emails` ADD `ai_classification_json` text;--> statement-breakpoint
ALTER TABLE `pending_inbound` ADD `ai_attempts` integer DEFAULT 0 NOT NULL;
