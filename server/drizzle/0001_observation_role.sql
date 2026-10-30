-- Breaking: rows from before this migration have no role, and schema changes don't get backfills
-- (CLAUDE.md). openDb() refuses to run it on a database that holds data, so this table is empty here.
DROP TABLE `observations`;--> statement-breakpoint
CREATE TABLE `observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`tool` text NOT NULL,
	`role` text NOT NULL,
	`severity` text,
	`data` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "observations_severity_ck" CHECK("observations"."severity" IN ('info', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "observations_role_ck" CHECK("observations"."role" IN ('finding', 'parent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observations_node_scan_uq` ON `observations` (`node_id`,`scan_id`);--> statement-breakpoint
CREATE INDEX `observations_scan_idx` ON `observations` (`scan_id`);
