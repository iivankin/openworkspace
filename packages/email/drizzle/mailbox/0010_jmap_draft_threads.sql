-- A draft is a thread of its own, the person's only: Thread/changes lists
-- it as created and destroyed with the draft.
DROP TRIGGER `jmap_draft_created`;
--> statement-breakpoint
CREATE TRIGGER `jmap_draft_created` AFTER INSERT ON `drafts` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', NEW.id, 'created', NEW.user_id);
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Thread', NEW.id, 'created', NEW.user_id);
END;
--> statement-breakpoint
DROP TRIGGER `jmap_draft_destroyed`;
--> statement-breakpoint
CREATE TRIGGER `jmap_draft_destroyed` AFTER DELETE ON `drafts` BEGIN
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Email', OLD.id, 'destroyed', OLD.user_id);
  INSERT INTO jmap_changes (type, id, kind, user_id) VALUES ('Thread', OLD.id, 'destroyed', OLD.user_id);
END;
