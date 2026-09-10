CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`author_id` text NOT NULL,
	`publishing_token_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`payload_digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publishing_token_id`) REFERENCES `publishing_tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_author_idempotency` ON `publications` (`author_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_document` ON `publications` (`document_id`);--> statement-breakpoint
CREATE TABLE `publishing_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publishing_tokens_token_hash_unique` ON `publishing_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `publishing_tokens_user_created` ON `publishing_tokens` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `publishing_tokens_expiry` ON `publishing_tokens` (`expires_at`);