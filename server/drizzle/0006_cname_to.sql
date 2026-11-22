-- TW-1: `edges` is rebuilt to add cname_to to its relation CHECK; every row is copied (not breaking).
-- openDb() runs migrations with foreign keys off (the PRAGMAs below are no-ops inside its transaction).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL,
	`confidence` text DEFAULT 'discovered' NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "edges_relation_ck" CHECK("__new_edges"."relation" IN ('has_subdomain', 'resolves_to', 'has_port', 'serves', 'has_url', 'uses_technology', 'has_vulnerability', 'has_certificate', 'has_email', 'has_secret', 'found_in_leak', 'cname_to')),
	CONSTRAINT "edges_confidence_ck" CHECK("__new_edges"."confidence" IN ('discovered', 'corroborated'))
);
--> statement-breakpoint
INSERT INTO `__new_edges`("id", "source_id", "target_id", "relation", "confidence", "source_count", "first_seen", "last_seen") SELECT "id", "source_id", "target_id", "relation", "confidence", "source_count", "first_seen", "last_seen" FROM `edges`;--> statement-breakpoint
DROP TABLE `edges`;--> statement-breakpoint
ALTER TABLE `__new_edges` RENAME TO `edges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `edges_source_relation_target_uq` ON `edges` (`source_id`,`relation`,`target_id`);--> statement-breakpoint
CREATE INDEX `edges_source_idx` ON `edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `edges_target_idx` ON `edges` (`target_id`);