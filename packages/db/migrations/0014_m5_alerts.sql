CREATE TABLE "alert_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"available_to_tenants" boolean DEFAULT false NOT NULL,
	"platform" boolean DEFAULT true NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"config_envelope" text NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"active" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"kinds" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_event_id_alert_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."alert_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_channel_id_alert_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscription" ADD CONSTRAINT "alert_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscription" ADD CONSTRAINT "alert_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscription" ADD CONSTRAINT "alert_subscription_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscription" ADD CONSTRAINT "alert_subscription_channel_id_alert_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_delivery_event_channel_uq" ON "alert_delivery" USING btree ("event_id","channel_id");--> statement-breakpoint
CREATE INDEX "alert_event_site_time_idx" ON "alert_event" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_subscription_user_site_channel_uq" ON "alert_subscription" USING btree ("user_id","site_id","channel_id");