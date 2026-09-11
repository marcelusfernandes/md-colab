CREATE TABLE `document_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`markdown` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_revisions_document_ordinal` ON `document_revisions` (`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `document_revisions_document` ON `document_revisions` (`document_id`);--> statement-breakpoint
ALTER TABLE `comments` ADD `source_revision_id` text REFERENCES document_revisions(id);--> statement-breakpoint
ALTER TABLE `documents` ADD `current_revision_id` text;--> statement-breakpoint
INSERT INTO `document_revisions` (`id`,`document_id`,`ordinal`,`author_id`,`title`,`filename`,`markdown`,`created_at`)
SELECT `id`,`id`,1,`owner_id`,`title`,`filename`,`markdown`,`created_at`
FROM `documents`;--> statement-breakpoint
UPDATE `documents` SET `current_revision_id`=`id`;--> statement-breakpoint
UPDATE `comments` SET `source_revision_id`=`document_id`;--> statement-breakpoint
CREATE TRIGGER `document_revisions_immutable_update`
BEFORE UPDATE ON `document_revisions`
BEGIN
	SELECT RAISE(ABORT, 'document revisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `document_revisions_immutable_delete`
BEFORE DELETE ON `document_revisions`
BEGIN
	SELECT RAISE(ABORT, 'document revisions are immutable');
END;
