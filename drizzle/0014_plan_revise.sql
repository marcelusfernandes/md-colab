DROP TRIGGER `publishing_tokens_scope_validate_insert`;--> statement-breakpoint
DROP TRIGGER `publishing_tokens_scope_validate_update`;--> statement-breakpoint
CREATE TRIGGER `publishing_tokens_scope_validate_insert`
BEFORE INSERT ON `publishing_tokens`
FOR EACH ROW
WHEN NOT (
	(NEW.`scope`='publish' AND NEW.`document_id` IS NULL) OR
	(NEW.`scope` IN ('plan_read','plan_revise') AND NEW.`document_id` IS NOT NULL)
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
		(NEW.`scope` IN ('plan_read','plan_revise') AND NEW.`document_id` IS NOT NULL)
	)
BEGIN
	SELECT RAISE(ABORT,'publishing token scope target is immutable');
END;
