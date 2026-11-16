CREATE TABLE `jmap_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE INDEX `jmap_changes_type_seq_idx` ON `jmap_changes` (`type`,`seq`);
--> statement-breakpoint
CREATE TRIGGER `jmap_email_created` AFTER INSERT ON `emails` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Email', NEW.id, 'created'), ('Thread', NEW.conversation_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_email_updated` AFTER UPDATE ON `emails` WHEN OLD.backup_sha256 IS NEW.backup_sha256 BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Email', NEW.id, 'updated'), ('Thread', NEW.conversation_id, 'updated');
  INSERT INTO jmap_changes (type, id, kind) SELECT 'Thread', OLD.conversation_id, 'updated' WHERE OLD.conversation_id IS NOT NEW.conversation_id;
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_email_destroyed` AFTER DELETE ON `emails` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Email', OLD.id, 'destroyed'), ('Thread', OLD.conversation_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_thread_created` AFTER INSERT ON `conversations` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Thread', NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_thread_moved` AFTER UPDATE ON `conversations` WHEN OLD.mailbox_state IS NOT NEW.mailbox_state OR OLD.folder_id IS NOT NEW.folder_id BEGIN
  INSERT INTO jmap_changes (type, id, kind) SELECT 'Email', id, 'updated' FROM emails WHERE conversation_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_thread_destroyed` AFTER DELETE ON `conversations` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Thread', OLD.id, 'destroyed');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_email_read` AFTER INSERT ON `email_read_states` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', NEW.email_id, 'updated', NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_email_unread` AFTER DELETE ON `email_read_states` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', OLD.email_id, 'updated', OLD.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_draft_created` AFTER INSERT ON `drafts` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', NEW.id, 'created', NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_draft_updated` AFTER UPDATE ON `drafts` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', NEW.id, 'updated', NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_draft_destroyed` AFTER DELETE ON `drafts` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', OLD.id, 'destroyed', OLD.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_folder_created` AFTER INSERT ON `folders` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_folder_updated` AFTER UPDATE ON `folders` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', NEW.id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_folder_destroyed` AFTER DELETE ON `folders` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', OLD.id, 'destroyed');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_system_folder_placed` AFTER INSERT ON `system_folder_order` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', NEW.folder_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_system_folder_moved` AFTER UPDATE ON `system_folder_order` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', NEW.folder_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_system_folder_reset` AFTER DELETE ON `system_folder_order` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Mailbox', OLD.folder_id, 'updated');
END;
--> statement-breakpoint
CREATE TRIGGER `jmap_changes_pruned` AFTER INSERT ON `jmap_changes` WHEN NEW.seq % 1000 = 0 BEGIN
  DELETE FROM jmap_changes WHERE seq <= NEW.seq - 100000;
END;