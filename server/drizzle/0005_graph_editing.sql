CREATE TABLE `deletions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`root_type` text NOT NULL,
	`root_value` text NOT NULL,
	`root_label` text NOT NULL,
	`node_count` integer NOT NULL,
	`edge_count` integer NOT NULL,
	`removed` text NOT NULL,
	CONSTRAINT "deletions_kind_ck" CHECK("deletions"."kind" IN ('node', 'group')),
	CONSTRAINT "deletions_mode_ck" CHECK("deletions"."mode" IN ('node', 'subtree')),
	CONSTRAINT "deletions_root_type_ck" CHECK("deletions"."root_type" IN ('domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak'))
);
--> statement-breakpoint
CREATE INDEX `deletions_at_idx` ON `deletions` (`at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool` text NOT NULL,
	`tool_group` text NOT NULL,
	`node_id` text,
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
	CONSTRAINT "jobs_status_ck" CHECK("__new_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused')),
	CONSTRAINT "jobs_mode_ck" CHECK("__new_jobs"."mode" IN ('passive', 'active', 'intrusive')),
	CONSTRAINT "jobs_target_type_ck" CHECK("__new_jobs"."target_type" IN ('domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "tool", "tool_group", "node_id", "target_type", "target_value", "mode", "status", "queued_scope_log_id", "scope_log_id", "argv", "image", "container_id", "timeout_sec", "exit_code", "error", "issues", "created_at", "started_at", "finished_at", "scan_id", "nodes_created", "nodes_updated") SELECT "id", "tool", "tool_group", "node_id", "target_type", "target_value", "mode", "status", "queued_scope_log_id", "scope_log_id", "argv", "image", "container_id", "timeout_sec", "exit_code", "error", "issues", "created_at", "started_at", "finished_at", "scan_id", "nodes_created", "nodes_updated" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_created_at_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_scan_id_idx` ON `jobs` (`scan_id`);--> statement-breakpoint
CREATE INDEX `jobs_node_id_idx` ON `jobs` (`node_id`);