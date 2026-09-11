ALTER TABLE `publishing_tokens` ADD `scope` text DEFAULT 'publish' NOT NULL;--> statement-breakpoint
ALTER TABLE `publishing_tokens` ADD `document_id` text REFERENCES documents(id);--> statement-breakpoint
CREATE INDEX `publishing_tokens_document` ON `publishing_tokens` (`document_id`);--> statement-breakpoint
CREATE TRIGGER `publishing_tokens_scope_validate_insert`
BEFORE INSERT ON `publishing_tokens`
FOR EACH ROW
WHEN NOT (
	(NEW.`scope`='publish' AND NEW.`document_id` IS NULL) OR
	(NEW.`scope`='plan_read' AND NEW.`document_id` IS NOT NULL)
)
BEGIN
	SELECT RAISE(ABORT,'invalid publishing token scope target');
END;--> statement-breakpoint
CREATE TRIGGER `publishing_tokens_scope_validate_update`
BEFORE UPDATE ON `publishing_tokens`
FOR EACH ROW
WHEN NEW.`scope`<>OLD.`scope`
	OR NEW.`document_id` IS NOT OLD.`document_id`
	OR NOT (
		(NEW.`scope`='publish' AND NEW.`document_id` IS NULL) OR
		(NEW.`scope`='plan_read' AND NEW.`document_id` IS NOT NULL)
	)
BEGIN
	SELECT RAISE(ABORT,'publishing token scope target is immutable');
END;
