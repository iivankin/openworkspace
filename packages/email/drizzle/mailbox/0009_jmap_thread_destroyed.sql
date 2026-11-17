-- A message deleted with its conversation (deleting for good removes the
-- conversation first) logs no thread update after the thread's destruction:
-- Thread/changes would otherwise report the thread as updated.
DROP TRIGGER `jmap_email_destroyed`;
--> statement-breakpoint
CREATE TRIGGER `jmap_email_destroyed` AFTER DELETE ON `emails` BEGIN
  INSERT INTO jmap_changes (type, id, kind) VALUES ('Email', OLD.id, 'destroyed');
  INSERT INTO jmap_changes (type, id, kind)
    SELECT 'Thread', OLD.conversation_id, 'updated'
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id);
END;
