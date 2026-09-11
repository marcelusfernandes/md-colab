ALTER TABLE `comments` ADD `root_id` text;--> statement-breakpoint
UPDATE `comments` SET `root_id`=`id` WHERE `root_id` IS NULL;--> statement-breakpoint
CREATE INDEX `comments_document_root_sequence` ON `comments` (`document_id`,`root_id`,`sequence`);--> statement-breakpoint
-- M1 clients do not send root_id. Their comments remain roots, without
-- renumbering the persisted sequence used by comment cursors.
CREATE TRIGGER `comments_root_after_insert`
AFTER INSERT ON `comments`
FOR EACH ROW WHEN NEW.`root_id` IS NULL
BEGIN
  UPDATE `comments` SET `root_id`=NEW.`id` WHERE `sequence`=NEW.`sequence`;
END;
