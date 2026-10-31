-- Scope guard (docs/architecture.md §10). New tables only: nothing to carry forward, so not a breaking migration.
CREATE TABLE `scope_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`target_type` text NOT NULL,
	`target_value` text NOT NULL,
	`mode` text NOT NULL,
	`decision` text NOT NULL,
	`rule_id` integer,
	`reason` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `scope_rules`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scope_log_source_ck" CHECK("scope_log"."source" IN ('check', 'run')),
	CONSTRAINT "scope_log_target_type_ck" CHECK("scope_log"."target_type" IN ('domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak')),
	CONSTRAINT "scope_log_mode_ck" CHECK("scope_log"."mode" IN ('passive', 'active')),
	CONSTRAINT "scope_log_decision_ck" CHECK("scope_log"."decision" IN ('in', 'out', 'n/a'))
);
--> statement-breakpoint
CREATE INDEX `scope_log_source_at_idx` ON `scope_log` (`source`,`at`);--> statement-breakpoint
CREATE TABLE `scope_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	CONSTRAINT "scope_rules_kind_ck" CHECK("scope_rules"."kind" IN ('domain', 'wildcard', 'ip', 'cidr')),
	CONSTRAINT "scope_rules_action_ck" CHECK("scope_rules"."action" IN ('include', 'exclude'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scope_rules_active_uq` ON `scope_rules` (`kind`,`value`,`action`) WHERE "scope_rules"."removed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `scope_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`passive_only` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "scope_settings_single_row_ck" CHECK("scope_settings"."id" = 1)
);
--> statement-breakpoint
-- The single settings row. passive_only starts on: no active check is in scope until the analyst turns it off.
INSERT INTO `scope_settings` (`id`, `passive_only`, `updated_at`) VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
