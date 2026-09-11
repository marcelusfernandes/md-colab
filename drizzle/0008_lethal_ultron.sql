CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`retry_of_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_attempt_at` integer,
	`uncertain` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`payload` text,
	`provider_id` text,
	`last_error_code` text,
	`last_error_at` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_recipient_generation` ON `notification_deliveries` (`event_id`,`recipient_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_retry_of` ON `notification_deliveries` (`retry_of_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_ready` ON `notification_deliveries` (`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`document_id` text NOT NULL,
	`root_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_comment_id_unique` ON `notification_events` (`comment_id`);--> statement-breakpoint
CREATE INDEX `notification_events_document` ON `notification_events` (`document_id`);--> statement-breakpoint
CREATE TABLE `notification_reconciliations` (
	`action_id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`evidence` text NOT NULL,
	`provider_id` text,
	`note` text,
	`result_delivery_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notification_reconciliations_delivery` ON `notification_reconciliations` (`delivery_id`);
--> statement-breakpoint
CREATE TRIGGER `notification_after_comment`
AFTER INSERT ON `comments`
FOR EACH ROW
WHEN EXISTS(
	SELECT 1 FROM `documents` d
	WHERE d.`id`=NEW.`document_id` AND d.`is_test`=0
)
BEGIN
	INSERT INTO `notification_events` (`id`,`comment_id`,`document_id`,`root_id`,`actor_id`,`created_at`)
	VALUES (NEW.`id`,NEW.`id`,NEW.`document_id`,COALESCE(NEW.`root_id`,NEW.`id`),NEW.`author_id`,NEW.`created_at`);

	INSERT INTO `notification_deliveries` (
		`id`,`event_id`,`recipient_id`,`recipient_email`,`generation`,`status`,
		`available_at`,`attempts`,`uncertain`,`created_at`
	)
	SELECT lower(hex(randomblob(16))),NEW.`id`,recipients.`recipient_id`,u.`email`,1,'pending',
		CAST(strftime('%s','now') AS INTEGER),0,0,NEW.`created_at`
	FROM (
		SELECT d.`owner_id` AS `recipient_id`
		FROM `documents` d
		WHERE d.`id`=NEW.`document_id` AND d.`owner_id`<>NEW.`author_id`
		UNION
		SELECT c.`author_id` AS `recipient_id`
		FROM `comments` c
		WHERE COALESCE(NEW.`root_id`,NEW.`id`)<>NEW.`id`
			AND c.`document_id`=NEW.`document_id`
			AND COALESCE(c.`root_id`,c.`id`)=COALESCE(NEW.`root_id`,NEW.`id`)
			AND c.`sequence`<NEW.`sequence`
			AND c.`author_id`<>NEW.`author_id`
	) recipients
	JOIN `users` u ON u.`id`=recipients.`recipient_id`
	JOIN `documents` d ON d.`id`=NEW.`document_id`
	WHERE u.`test_email` IS NULL AND (
		recipients.`recipient_id`=d.`owner_id` OR
		EXISTS(
			SELECT 1 FROM `shares` s
			WHERE s.`document_id`=d.`id` AND s.`email`=u.`email`
		)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `notification_reconciliation_validate`
BEFORE INSERT ON `notification_reconciliations`
FOR EACH ROW
BEGIN
	SELECT CASE
		WHEN NEW.`evidence` NOT IN ('accepted','confirmed_not_delivered')
			THEN RAISE(ABORT,'invalid notification evidence')
		WHEN NEW.`operator_id`='' OR length(NEW.`operator_id`)>128
			THEN RAISE(ABORT,'invalid notification operator')
		WHEN NEW.`note` IS NULL OR trim(NEW.`note`)='' OR length(NEW.`note`)>500
			THEN RAISE(ABORT,'notification evidence note required')
		WHEN NEW.`evidence`='accepted' AND (
			NEW.`provider_id` IS NULL OR trim(NEW.`provider_id`)='' OR
			NEW.`result_delivery_id` IS NOT NULL
		) THEN RAISE(ABORT,'accepted notification evidence is invalid')
		WHEN NEW.`evidence`='confirmed_not_delivered' AND (
			NEW.`provider_id` IS NOT NULL OR NEW.`result_delivery_id` IS NULL OR
			trim(NEW.`result_delivery_id`)=''
		) THEN RAISE(ABORT,'non-delivery evidence is invalid')
		WHEN NOT EXISTS(
			SELECT 1 FROM `notification_deliveries` d
			WHERE d.`id`=NEW.`delivery_id` AND d.`status`='blocked'
				AND d.`lease_token` IS NULL
		) THEN RAISE(ABORT,'notification delivery is not reconcilable')
		WHEN NEW.`evidence`='accepted' AND NOT EXISTS(
			SELECT 1 FROM `notification_deliveries` d
			WHERE d.`id`=NEW.`delivery_id` AND d.`uncertain`=1
		) THEN RAISE(ABORT,'accepted evidence requires an uncertain delivery')
		WHEN NEW.`evidence`='confirmed_not_delivered' AND EXISTS(
			SELECT 1 FROM `notification_deliveries` child
			WHERE child.`retry_of_id`=NEW.`delivery_id`
		) THEN RAISE(ABORT,'notification delivery already has a retry generation')
		WHEN NEW.`evidence`='confirmed_not_delivered' AND NOT EXISTS(
			SELECT 1
			FROM `notification_deliveries` d
			JOIN `notification_events` e ON e.`id`=d.`event_id`
			JOIN `documents` doc ON doc.`id`=e.`document_id`
			JOIN `users` u ON u.`id`=d.`recipient_id`
			WHERE d.`id`=NEW.`delivery_id` AND doc.`is_test`=0
				AND u.`test_email` IS NULL AND u.`email`=d.`recipient_email`
				AND (doc.`owner_id`=u.`id` OR EXISTS(
					SELECT 1 FROM `shares` s
					WHERE s.`document_id`=doc.`id` AND s.`email`=u.`email`
				))
		) THEN RAISE(ABORT,'notification recipient no longer has access')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `notification_reconciliation_accepted`
AFTER INSERT ON `notification_reconciliations`
FOR EACH ROW WHEN NEW.`evidence`='accepted'
BEGIN
	UPDATE `notification_deliveries`
	SET `status`='sent',`provider_id`=NEW.`provider_id`,
		`last_error_code`=NULL,`last_error_at`=NULL
	WHERE `id`=NEW.`delivery_id` AND `status`='blocked' AND `uncertain`=1;
END;
--> statement-breakpoint
CREATE TRIGGER `notification_reconciliation_not_delivered`
AFTER INSERT ON `notification_reconciliations`
FOR EACH ROW WHEN NEW.`evidence`='confirmed_not_delivered'
BEGIN
	INSERT INTO `notification_deliveries` (
		`id`,`event_id`,`recipient_id`,`recipient_email`,`generation`,`retry_of_id`,
		`status`,`available_at`,`attempts`,`uncertain`,`created_at`
	)
	SELECT NEW.`result_delivery_id`,d.`event_id`,d.`recipient_id`,d.`recipient_email`,
		d.`generation`+1,d.`id`,'pending',CAST(strftime('%s','now') AS INTEGER),0,0,
		strftime('%Y-%m-%dT%H:%M:%fZ','now')
	FROM `notification_deliveries` d
	WHERE d.`id`=NEW.`delivery_id` AND d.`status`='blocked';

	UPDATE `notification_deliveries`
	SET `status`='reconciled_not_delivered',`last_error_code`=NULL,`last_error_at`=NULL
	WHERE `id`=NEW.`delivery_id` AND `status`='blocked';
END;
