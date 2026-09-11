CREATE TABLE `conversation_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`root_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_changes_document_sequence` ON `conversation_changes` (`document_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`document_id` text NOT NULL,
	`root_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`version` integer NOT NULL,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`decision` text,
	`decision_reason` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_id_unique` ON `conversation_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_root_version` ON `conversation_events` (`root_id`,`version`);--> statement-breakpoint
CREATE INDEX `conversation_events_document_sequence` ON `conversation_events` (`document_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `conversation_events_root_sequence` ON `conversation_events` (`root_id`,`sequence`);--> statement-breakpoint
CREATE TRIGGER `conversation_change_after_comment`
AFTER INSERT ON `comments`
FOR EACH ROW
BEGIN
	INSERT INTO `conversation_changes` (`document_id`,`root_id`,`created_at`)
	VALUES (NEW.`document_id`,COALESCE(NEW.`root_id`,NEW.`id`),NEW.`created_at`);
END;--> statement-breakpoint
CREATE TRIGGER `conversation_change_after_event`
AFTER INSERT ON `conversation_events`
FOR EACH ROW
BEGIN
	INSERT INTO `conversation_changes` (`document_id`,`root_id`,`created_at`)
	VALUES (NEW.`document_id`,NEW.`root_id`,NEW.`created_at`);
END;
