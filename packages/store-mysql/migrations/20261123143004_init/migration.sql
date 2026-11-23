CREATE TABLE `agent_runtime_conversations` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`owner_conversation_id` bigint,
	`owner_task_id` bigint,
	`parent_conversation_id` bigint,
	`parent_at` bigint,
	`record` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_document_revisions` (
	`scope_id` bigint NOT NULL,
	`document_id` bigint NOT NULL,
	`seq` bigint NOT NULL,
	`kind` varchar(5) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` bigint NOT NULL,
	`content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`document_id`,`seq`),
	CONSTRAINT `document_revisions_kind` CHECK(`agent_runtime_document_revisions`.`kind` IN ('base', 'delta'))
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_documents` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`kind` varchar(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
	`family` smallint NOT NULL,
	`key_value` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
	`scope_kind` varchar(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`owner_id` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`retired_at` bigint,
	`record` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`),
	CONSTRAINT `documents_family` CHECK(`agent_runtime_documents`.`family` IN (0, 1)),
	CONSTRAINT `documents_scope_kind` CHECK(`agent_runtime_documents`.`scope_kind` IN ('session', 'conversation', 'task'))
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_entries` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`conversation_id` bigint NOT NULL,
	`head` bigint,
	`marker_id` bigint GENERATED ALWAYS AS ((if(`head` is null, null, `id`))) VIRTUAL,
	`commit_seq` bigint NOT NULL,
	`record` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_record_ids` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`record_type` varchar(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`),
	CONSTRAINT `record_ids_record_type` CHECK(`agent_runtime_record_ids`.`record_type` IN ('conversation', 'entry', 'task', 'submission', 'document'))
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_scopes` (
	`scope_id` bigint AUTO_INCREMENT PRIMARY KEY,
	`kind` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
	`name` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
	`scope_key` binary(32) GENERATED ALWAYS AS (unhex(sha2(concat(`kind`, x'00', `name`), 256))) STORED NOT NULL,
	`next_id` bigint NOT NULL DEFAULT 2,
	`next_seq` bigint NOT NULL DEFAULT 1,
	`lease_token` bigint NOT NULL DEFAULT 0,
	`lease_holder` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
	`lease_expires_at` datetime(3),
	`wake_active` boolean NOT NULL DEFAULT false,
	`wake_at` bigint,
	`unfinished` boolean GENERATED ALWAYS AS ((`wake_active` or `wake_at` is not null or `lease_holder` is not null)) VIRTUAL NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (utc_timestamp(3)),
	`commit_nonce` binary(16),
	CONSTRAINT `scopes_scope_key` UNIQUE INDEX(`scope_key`)
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_submissions` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`conversation_id` bigint NOT NULL,
	`request_id` varchar(760) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,
	`status` varchar(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`record` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`),
	CONSTRAINT `submissions_status` CHECK(`agent_runtime_submissions`.`status` IN ('queued', 'placed', 'done', 'unanswered'))
);
--> statement-breakpoint
CREATE TABLE `agent_runtime_tasks` (
	`scope_id` bigint NOT NULL,
	`id` bigint NOT NULL,
	`conversation_id` bigint NOT NULL,
	`kind` varchar(760) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
	`status` varchar(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`abort_requested` boolean NOT NULL,
	`background` boolean NOT NULL,
	`record` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	CONSTRAINT PRIMARY KEY(`scope_id`,`id`),
	CONSTRAINT `tasks_status` CHECK(`agent_runtime_tasks`.`status` IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'))
);
--> statement-breakpoint
CREATE INDEX `conversations_by_owner_conversation` ON `agent_runtime_conversations` (`scope_id`,`owner_conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `conversations_by_owner_task` ON `agent_runtime_conversations` (`scope_id`,`owner_task_id`,`id`);--> statement-breakpoint
CREATE INDEX `document_revisions_by_kind` ON `agent_runtime_document_revisions` (`scope_id`,`document_id`,`kind`,`seq`);--> statement-breakpoint
CREATE INDEX `documents_by_address` ON `agent_runtime_documents` (`scope_id`,`kind`,`scope_kind`,`owner_id`,`family`,`key_value`,`created_at`);--> statement-breakpoint
CREATE INDEX `documents_by_scope` ON `agent_runtime_documents` (`scope_id`,`scope_kind`,`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `documents_by_scope_kind` ON `agent_runtime_documents` (`scope_id`,`scope_kind`,`owner_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `entries_by_conversation` ON `agent_runtime_entries` (`scope_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `entry_heads_by_conversation` ON `agent_runtime_entries` (`scope_id`,`conversation_id`,`marker_id`);--> statement-breakpoint
CREATE INDEX `scopes_unfinished` ON `agent_runtime_scopes` (`unfinished`,`scope_id`);--> statement-breakpoint
CREATE INDEX `submissions_by_request` ON `agent_runtime_submissions` (`scope_id`,`conversation_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `submissions_by_conversation` ON `agent_runtime_submissions` (`scope_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `submissions_by_status` ON `agent_runtime_submissions` (`scope_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_by_status` ON `agent_runtime_tasks` (`scope_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_by_conversation` ON `agent_runtime_tasks` (`scope_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_by_kind` ON `agent_runtime_tasks` (`scope_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_by_abort_requested` ON `agent_runtime_tasks` (`scope_id`,`abort_requested`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_by_background` ON `agent_runtime_tasks` (`scope_id`,`background`,`id`);--> statement-breakpoint
ALTER TABLE `agent_runtime_conversations` ADD CONSTRAINT `conversations_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_document_revisions` ADD CONSTRAINT `document_revisions_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_documents` ADD CONSTRAINT `documents_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_entries` ADD CONSTRAINT `entries_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_record_ids` ADD CONSTRAINT `record_ids_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_submissions` ADD CONSTRAINT `submissions_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `agent_runtime_tasks` ADD CONSTRAINT `tasks_scope` FOREIGN KEY (`scope_id`) REFERENCES `agent_runtime_scopes`(`scope_id`) ON DELETE CASCADE;