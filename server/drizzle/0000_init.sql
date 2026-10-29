CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "edges_relation_ck" CHECK("edges"."relation" IN ('has_subdomain', 'resolves_to', 'has_port', 'serves', 'has_url', 'uses_technology', 'has_vulnerability', 'has_certificate', 'has_email', 'has_secret', 'found_in_leak'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edges_source_relation_target_uq` ON `edges` (`source_id`,`relation`,`target_id`);--> statement-breakpoint
CREATE INDEX `edges_source_idx` ON `edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `edges_target_idx` ON `edges` (`target_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`label` text NOT NULL,
	`severity` text,
	`confidence` text DEFAULT 'discovered' NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`tag` text,
	`notes` text DEFAULT '' NOT NULL,
	`pos_x` real,
	`pos_y` real,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	CONSTRAINT "nodes_type_ck" CHECK("nodes"."type" IN ('domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak')),
	CONSTRAINT "nodes_severity_ck" CHECK("nodes"."severity" IN ('info', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "nodes_confidence_ck" CHECK("nodes"."confidence" IN ('discovered', 'corroborated', 'verified')),
	CONSTRAINT "nodes_tag_ck" CHECK("nodes"."tag" IN ('interesting', 'checked', 'ignored'))
);
--> statement-breakpoint
CREATE INDEX `nodes_type_idx` ON `nodes` (`type`);--> statement-breakpoint
CREATE INDEX `nodes_severity_idx` ON `nodes` (`severity`);--> statement-breakpoint
CREATE INDEX `nodes_confidence_idx` ON `nodes` (`confidence`);--> statement-breakpoint
CREATE INDEX `nodes_tag_idx` ON `nodes` (`tag`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`tool` text NOT NULL,
	`severity` text,
	`data` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "observations_severity_ck" CHECK("observations"."severity" IN ('info', 'low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observations_node_scan_uq` ON `observations` (`node_id`,`scan_id`);--> statement-breakpoint
CREATE INDEX `observations_scan_idx` ON `observations` (`scan_id`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`tool_version` text,
	`target` text NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`errors` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`file_hash` text NOT NULL,
	`raw` text NOT NULL,
	CONSTRAINT "scans_status_ck" CHECK("scans"."status" IN ('success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scans_file_hash_unique` ON `scans` (`file_hash`);