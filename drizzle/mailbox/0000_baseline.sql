CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`latest_email_id` text NOT NULL,
	`timeline_at` integer NOT NULL,
	`mailbox_state` text DEFAULT 'active' NOT NULL,
	`folder_id` text,
	`has_incoming` integer DEFAULT false NOT NULL,
	`has_outgoing` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`latest_email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `conversations_timeline_idx` ON `conversations` (`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_inbox_timeline_idx` ON `conversations` (`mailbox_state`,`has_incoming`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_sent_timeline_idx` ON `conversations` (`mailbox_state`,`has_outgoing`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_folder_timeline_idx` ON `conversations` (`folder_id`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`request_fingerprint` text,
	`conversation_id` text NOT NULL,
	`direction` text NOT NULL,
	`message_id_header` text,
	`in_reply_to_json` text DEFAULT '[]' NOT NULL,
	`references_json` text DEFAULT '[]' NOT NULL,
	`from_json` text NOT NULL,
	`reply_to_json` text DEFAULT '[]' NOT NULL,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '(no subject)' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`body_text` text,
	`quoted_text` text,
	`body_html_r2_key` text,
	`raw_mime_r2_key` text,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`list_id` text,
	`list_post_address` text,
	`timeline_at` integer NOT NULL,
	`transport_state` text NOT NULL,
	`transport_error` text,
	`delivery_status_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emails_conversation_timeline_idx` ON `emails` (`conversation_id`,`timeline_at`,`id`);--> statement-breakpoint
CREATE INDEX `emails_message_id_header_idx` ON `emails` (`message_id_header`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_name_unique` ON `folders` (`name`);--> statement-breakpoint
CREATE INDEX `folders_order_idx` ON `folders` (`sort_order`,`name`);--> statement-breakpoint
CREATE TABLE `pending_inbound` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_object_key` text NOT NULL,
	`envelope_from` text NOT NULL,
	`envelope_to` text NOT NULL,
	`received_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_inbound_next_attempt_idx` ON `pending_inbound` (`next_attempt_at`,`received_at`);--> statement-breakpoint
-- Runtime-only search/projection objects: Drizzle snapshots do not model them.
CREATE VIRTUAL TABLE `email_search` USING fts5(
	`email_id` UNINDEXED,
	`conversation_id` UNINDEXED,
	`subject`,
	`addresses`,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `emails_after_insert`
AFTER INSERT ON `emails`
BEGIN
	INSERT INTO `conversations` (
		`id`,
		`latest_email_id`,
		`timeline_at`,
		`mailbox_state`,
		`folder_id`,
		`has_incoming`,
		`has_outgoing`
	)
	VALUES (
		NEW.`conversation_id`,
		NEW.`id`,
		NEW.`timeline_at`,
		'active',
		NULL,
		NEW.`direction` = 'incoming',
		NEW.`direction` = 'outgoing'
	)
	ON CONFLICT(`id`) DO UPDATE SET
		`latest_email_id` = CASE
			WHEN NEW.`timeline_at` > `conversations`.`timeline_at`
				OR (
					NEW.`timeline_at` = `conversations`.`timeline_at`
					AND NEW.`id` > `conversations`.`latest_email_id`
				)
			THEN NEW.`id`
			ELSE `conversations`.`latest_email_id`
		END,
		`timeline_at` = MAX(`conversations`.`timeline_at`, NEW.`timeline_at`),
		`mailbox_state` = CASE
			WHEN `conversations`.`mailbox_state` IN ('archive', 'trash')
				OR (
					`conversations`.`mailbox_state` = 'spam'
					AND NEW.`direction` = 'outgoing'
				)
			THEN 'active'
			ELSE `conversations`.`mailbox_state`
		END,
		`has_incoming` = `conversations`.`has_incoming`
			OR NEW.`direction` = 'incoming',
		`has_outgoing` = `conversations`.`has_outgoing`
			OR NEW.`direction` = 'outgoing';

	INSERT INTO `email_search` (
		`email_id`,
		`conversation_id`,
		`subject`,
		`addresses`,
		`body`
	)
	VALUES (
		NEW.`id`,
		NEW.`conversation_id`,
		NEW.`subject`,
		COALESCE(NEW.`from_json`, '') || ' '
			|| COALESCE(NEW.`reply_to_json`, '') || ' '
			|| COALESCE(NEW.`to_json`, '') || ' '
			|| COALESCE(NEW.`cc_json`, '') || ' '
			|| COALESCE(NEW.`bcc_json`, ''),
		COALESCE(NEW.`body_text`, '') || ' ' || COALESCE(NEW.`preview`, '')
	);
END;
