CREATE TABLE `email_read_states` (
	`user_id` text NOT NULL,
	`email_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `email_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_read_states_email_idx` ON `email_read_states` (`email_id`);