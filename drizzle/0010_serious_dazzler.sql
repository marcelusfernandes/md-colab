ALTER TABLE `document_revisions` ADD `base_revision_id` text REFERENCES document_revisions(id);--> statement-breakpoint
ALTER TABLE `document_revisions` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `document_revisions` ADD `considered_comment_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TRIGGER `document_revisions_advance_document`
AFTER INSERT ON `document_revisions`
WHEN NEW.ordinal > 1
BEGIN
	UPDATE `documents`
	SET `current_revision_id`=NEW.id,
		`title`=NEW.title,
		`filename`=NEW.filename,
		`markdown`=NEW.markdown
	WHERE `id`=NEW.document_id
		AND `owner_id`=NEW.author_id
		AND `current_revision_id`=NEW.base_revision_id
		AND EXISTS(
			SELECT 1 FROM `document_revisions` base
			WHERE base.id=NEW.base_revision_id
				AND base.document_id=NEW.document_id
				AND base.ordinal=NEW.ordinal-1
		);
	SELECT CASE WHEN changes()<>1
		THEN RAISE(ABORT, 'document revision advance conflict') END;
END;
