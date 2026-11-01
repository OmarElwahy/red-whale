-- Breaking: edges from before this migration have no provenance, and schema changes don't get backfills
-- (CLAUDE.md). openDb() refuses to run it on a database that holds data, so `edges` is empty here.
DROP TABLE `edges`;--> statement-breakpoint
CREATE TABLE `edges` (
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
	CONSTRAINT "edges_relation_ck" CHECK("edges"."relation" IN ('has_subdomain', 'resolves_to', 'has_port', 'serves', 'has_url', 'uses_technology', 'has_vulnerability', 'has_certificate', 'has_email', 'has_secret', 'found_in_leak')),
	CONSTRAINT "edges_confidence_ck" CHECK("edges"."confidence" IN ('discovered', 'corroborated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edges_source_relation_target_uq` ON `edges` (`source_id`,`relation`,`target_id`);--> statement-breakpoint
CREATE INDEX `edges_source_idx` ON `edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `edges_target_idx` ON `edges` (`target_id`);--> statement-breakpoint
CREATE TABLE `edge_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`edge_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`tool` text NOT NULL,
	`data` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`edge_id`) REFERENCES `edges`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edge_observations_edge_scan_uq` ON `edge_observations` (`edge_id`,`scan_id`);--> statement-breakpoint
CREATE INDEX `edge_observations_edge_idx` ON `edge_observations` (`edge_id`);--> statement-breakpoint
CREATE INDEX `edge_observations_scan_idx` ON `edge_observations` (`scan_id`);--> statement-breakpoint
CREATE INDEX `edge_observations_observed_at_idx` ON `edge_observations` (`observed_at`);
