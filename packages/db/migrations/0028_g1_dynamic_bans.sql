CREATE SEQUENCE "public"."ip_ban_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "ip_ban" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"organization_id" text,
	"site_id" uuid,
	"cluster_id" uuid,
	"cidr" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"node_id" uuid,
	"trigger" jsonb,
	"created_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"seq" bigint NOT NULL,
	"distributed" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "ban_status" jsonb;--> statement-breakpoint
ALTER TABLE "organization_limit" ADD COLUMN "max_bans" integer;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD CONSTRAINT "ip_ban_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD CONSTRAINT "ip_ban_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD CONSTRAINT "ip_ban_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD CONSTRAINT "ip_ban_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_seq_uq" ON "ip_ban" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "ip_ban_cluster_seq_idx" ON "ip_ban" USING btree ("cluster_id","seq");--> statement-breakpoint
CREATE INDEX "ip_ban_org_idx" ON "ip_ban" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ip_ban_site_idx" ON "ip_ban" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "ip_ban_expires_idx" ON "ip_ban" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_site_manual_uq" ON "ip_ban" USING btree ("site_id","cidr") WHERE "ip_ban"."scope" = 'site' and "ip_ban"."source" = 'manual' and "ip_ban"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_platform_uq" ON "ip_ban" USING btree ("cidr") WHERE "ip_ban"."scope" = 'platform' and "ip_ban"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_auto_uq" ON "ip_ban" USING btree ("node_id","site_id","cidr") WHERE "ip_ban"."source" = 'auto' and "ip_ban"."removed_at" is null;