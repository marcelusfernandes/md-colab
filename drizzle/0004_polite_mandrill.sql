CREATE TABLE `__new_comments` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`document_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`quote` text NOT NULL,
	`source_start` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "document_id", "author_id", "body", "quote", "source_start", "created_at")
SELECT "id", "document_id", "author_id", "body", "quote", "source_start", "created_at"
FROM `comments`
ORDER BY "created_at", "id";--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
CREATE UNIQUE INDEX `comments_id_unique` ON `comments` (`id`);--> statement-breakpoint
CREATE INDEX `comments_document_created` ON `comments` (`document_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_document_sequence` ON `comments` (`document_id`,`sequence`);
