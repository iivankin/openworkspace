CREATE TABLE `retention_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`trash_days` integer,
	`spam_days` integer,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `state_changed_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_state_changed_idx` ON `conversations` (`mailbox_state`,`state_changed_at`);--> statement-breakpoint
-- Every existing conversation starts its clock now, so turning on retention
-- never deletes old Trash or Spam at once.
UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000);--> statement-breakpoint
CREATE TRIGGER `conversations_state_inserted_at`
AFTER INSERT ON `conversations`
FOR EACH ROW
WHEN NEW.`state_changed_at` IS NULL
BEGIN
	UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000)
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
-- Covers every path that moves a conversation, including the upsert in
-- indexInsertedEmail that brings a thread back from Trash.
CREATE TRIGGER `conversations_state_changed_at`
AFTER UPDATE OF `mailbox_state` ON `conversations`
FOR EACH ROW
WHEN NEW.`mailbox_state` IS NOT OLD.`mailbox_state`
BEGIN
	UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000)
	WHERE `id` = NEW.`id`;
END;
