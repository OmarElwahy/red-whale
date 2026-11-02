-- Tool runs (docs/architecture.md §12). New tables only: nothing to carry forward, so not a breaking migration.
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool` text NOT NULL,
	`tool_group` text NOT NULL,
	`node_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_value` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`queued_scope_log_id` integer NOT NULL,
	`scope_log_id` integer,
	`argv` text,
	`image` text,
	`container_id` text,
	`timeout_sec` integer NOT NULL,
	`exit_code` integer,
	`error` text,
	`issues` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`scan_id` text,
	`nodes_created` integer,
	`nodes_updated` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`queued_scope_log_id`) REFERENCES `scope_log`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_log_id`) REFERENCES `scope_log`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_status_ck" CHECK("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused')),
	CONSTRAINT "jobs_mode_ck" CHECK("jobs"."mode" IN ('passive', 'active', 'intrusive')),
	CONSTRAINT "jobs_target_type_ck" CHECK("jobs"."target_type" IN ('domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_created_at_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_scan_id_idx` ON `jobs` (`scan_id`);--> statement-breakpoint
CREATE INDEX `jobs_node_id_idx` ON `jobs` (`node_id`);--> statement-breakpoint
CREATE TABLE `runner_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "runner_state_single_row_ck" CHECK("runner_state"."id" = 1)
);
--> statement-breakpoint
-- This workspace's ID: labels its containers and volumes, so cleaning up orphans never touches another workspace's.
INSERT INTO `runner_state` (`id`, `workspace_id`, `created_at`) VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
