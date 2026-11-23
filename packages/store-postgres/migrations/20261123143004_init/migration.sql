CREATE SCHEMA "agent_runtime";
--> statement-breakpoint
CREATE TABLE "agent_runtime"."conversations" (
	"scope_id" bigint,
	"id" bigint,
	"owner_conversation_id" bigint,
	"owner_task_id" bigint,
	"parent_conversation_id" bigint,
	"parent_at" bigint,
	"record" text NOT NULL,
	CONSTRAINT "conversations_pkey" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."document_revisions" (
	"scope_id" bigint,
	"document_id" bigint,
	"seq" bigint,
	"kind" text NOT NULL,
	"version" bigint NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "document_revisions_pkey" PRIMARY KEY("scope_id","document_id","seq"),
	CONSTRAINT "document_revisions_kind" CHECK ("kind" IN ('base', 'delta'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."documents" (
	"scope_id" bigint,
	"id" bigint,
	"kind" text COLLATE "C" NOT NULL,
	"family" smallint NOT NULL,
	"key_value" text COLLATE "C" NOT NULL,
	"scope_kind" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"retired_at" bigint,
	"record" text NOT NULL,
	CONSTRAINT "documents_pkey" PRIMARY KEY("scope_id","id"),
	CONSTRAINT "documents_family" CHECK ("family" IN (0, 1)),
	CONSTRAINT "documents_scope_kind" CHECK ("scope_kind" IN ('session', 'conversation', 'task'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."entries" (
	"scope_id" bigint,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"head" bigint,
	"commit_seq" bigint NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "entries_pkey" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."record_ids" (
	"scope_id" bigint,
	"id" bigint,
	"record_type" text NOT NULL,
	CONSTRAINT "record_ids_pkey" PRIMARY KEY("scope_id","id"),
	CONSTRAINT "record_ids_record_type" CHECK ("record_type" IN ('conversation', 'entry', 'task', 'submission', 'document'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."scopes" (
	"scope_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_runtime"."scopes_scope_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text COLLATE "C" NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"next_id" bigint DEFAULT 2 NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"lease_token" bigint DEFAULT 0 NOT NULL,
	"lease_holder" text,
	"lease_expires_at" timestamp with time zone,
	"wake_active" boolean DEFAULT false NOT NULL,
	"wake_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scopes_kind_name" UNIQUE("kind","name")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."submissions" (
	"scope_id" bigint,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"request_id" text COLLATE "C",
	"status" text NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "submissions_pkey" PRIMARY KEY("scope_id","id"),
	CONSTRAINT "submissions_status" CHECK ("status" IN ('queued', 'placed', 'done', 'unanswered'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."tasks" (
	"scope_id" bigint,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"status" text NOT NULL,
	"abort_requested" boolean NOT NULL,
	"background" boolean NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("scope_id","id"),
	CONSTRAINT "tasks_status" CHECK ("status" IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'))
);
--> statement-breakpoint
CREATE INDEX "conversations_by_owner_conversation" ON "agent_runtime"."conversations" ("scope_id","owner_conversation_id","id");--> statement-breakpoint
CREATE INDEX "conversations_by_owner_task" ON "agent_runtime"."conversations" ("scope_id","owner_task_id","id");--> statement-breakpoint
CREATE INDEX "document_revisions_by_kind" ON "agent_runtime"."document_revisions" ("scope_id","document_id","kind","seq" DESC);--> statement-breakpoint
CREATE INDEX "documents_by_address" ON "agent_runtime"."documents" ("scope_id","kind","scope_kind","owner_id","family","key_value","created_at" DESC);--> statement-breakpoint
CREATE INDEX "documents_by_scope" ON "agent_runtime"."documents" ("scope_id","scope_kind","owner_id","id");--> statement-breakpoint
CREATE INDEX "documents_by_scope_kind" ON "agent_runtime"."documents" ("scope_id","scope_kind","owner_id","kind","id");--> statement-breakpoint
CREATE INDEX "entries_by_conversation" ON "agent_runtime"."entries" ("scope_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "entry_heads_by_conversation" ON "agent_runtime"."entries" ("scope_id","conversation_id","id") WHERE "head" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "scopes_unfinished" ON "agent_runtime"."scopes" ("scope_id") WHERE "wake_active" OR "wake_at" IS NOT NULL OR "lease_holder" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_by_request" ON "agent_runtime"."submissions" ("scope_id","conversation_id","request_id");--> statement-breakpoint
CREATE INDEX "submissions_by_conversation" ON "agent_runtime"."submissions" ("scope_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "submissions_by_status" ON "agent_runtime"."submissions" ("scope_id","status","id");--> statement-breakpoint
CREATE INDEX "tasks_by_status" ON "agent_runtime"."tasks" ("scope_id","status","id");--> statement-breakpoint
CREATE INDEX "tasks_by_conversation" ON "agent_runtime"."tasks" ("scope_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "tasks_by_kind" ON "agent_runtime"."tasks" ("scope_id","kind","id");--> statement-breakpoint
CREATE INDEX "tasks_by_abort_requested" ON "agent_runtime"."tasks" ("scope_id","abort_requested","id");--> statement-breakpoint
CREATE INDEX "tasks_by_background" ON "agent_runtime"."tasks" ("scope_id","background","id");--> statement-breakpoint
ALTER TABLE "agent_runtime"."conversations" ADD CONSTRAINT "conversations_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."document_revisions" ADD CONSTRAINT "document_revisions_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."documents" ADD CONSTRAINT "documents_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."entries" ADD CONSTRAINT "entries_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."record_ids" ADD CONSTRAINT "record_ids_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."submissions" ADD CONSTRAINT "submissions_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runtime"."tasks" ADD CONSTRAINT "tasks_scope_id_scopes_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "agent_runtime"."scopes"("scope_id") ON DELETE CASCADE;