CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`class` text NOT NULL,
	`hash` text NOT NULL,
	`display` text NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`revoked_at` text,
	`last_used_at` text,
	`create_time` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash_unique` ON `api_key` (`hash`);--> statement-breakpoint
CREATE INDEX `api_key_user` ON `api_key` (`user_id`);--> statement-breakpoint
CREATE TABLE `billing_customer` (
	`principal` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cart` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`customer` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cart_customer` ON `cart` (`scope`,`customer`);--> statement-breakpoint
CREATE TABLE `delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`order_id` text NOT NULL,
	`driver` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`items` text NOT NULL,
	`artifacts` text DEFAULT '[]' NOT NULL,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_order` ON `delivery` (`scope`,`order_id`);--> statement-breakpoint
CREATE TABLE `entitlement_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`entitlement` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `entitlement_grant_principal` ON `entitlement_grant` (`principal`);--> statement-breakpoint
CREATE TABLE `json_rows` (
	`scope` text DEFAULT '' NOT NULL,
	`collection` text NOT NULL,
	`parent` text DEFAULT '' NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`scope`, `collection`, `parent`, `id`)
);
--> statement-breakpoint
CREATE TABLE `notification_message` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`target_id` text,
	`address` text NOT NULL,
	`recipient` text,
	`scope` text,
	`topic` text,
	`template` text,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`body_html` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`problem` text,
	`operation` text,
	`read_time` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_recipient` ON `notification_message` (`recipient`);--> statement-breakpoint
CREATE INDEX `message_status` ON `notification_message` (`status`);--> statement-breakpoint
CREATE TABLE `operation` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`queue` text DEFAULT 'default' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`ok` integer,
	`error` text,
	`response` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`trigger` text,
	`owner` text,
	`request_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL,
	`locked_by` text,
	`logs` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operation_due` ON `operation` (`status`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `operation_request_id` ON `operation` (`request_id`);--> statement-breakpoint
CREATE TABLE `commerce_order` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`customer` text NOT NULL,
	`items` text NOT NULL,
	`total_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payment` text,
	`discount` text,
	`cart_id` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `commerce_order_customer` ON `commerce_order` (`scope`,`customer`);--> statement-breakpoint
CREATE TABLE `pool_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `pool_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pool_account_userId_idx` ON `pool_account` (`user_id`);--> statement-breakpoint
CREATE TABLE `pool_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `pool_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pool_session_token_unique` ON `pool_session` (`token`);--> statement-breakpoint
CREATE INDEX `pool_session_userId_idx` ON `pool_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `pool_two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer
);
--> statement-breakpoint
CREATE INDEX `pool_two_factor_user` ON `pool_two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `pool_user` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`two_factor_enabled` integer DEFAULT false,
	`is_anonymous` integer DEFAULT false,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pool_user_project_email` ON `pool_user` (`project_id`,`email`);--> statement-breakpoint
CREATE TABLE `pool_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_verification_identifier_idx` ON `pool_verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `search_document` (
	`scope` text DEFAULT '' NOT NULL,
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`text` text NOT NULL,
	`vector` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `search_document_scope` ON `search_document` (`scope`,`collection`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `notification_subscriber` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`target_id` text NOT NULL,
	`preferences` text,
	`create_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscriber_topic` ON `notification_subscriber` (`topic`);--> statement-breakpoint
CREATE TABLE `notification_target` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`address` text NOT NULL,
	`principal` text,
	`status` text DEFAULT 'active' NOT NULL,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `target_principal` ON `notification_target` (`principal`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`data` text NOT NULL,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`definition` text NOT NULL,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text,
	`challenge` text,
	`verified_time` text,
	`last_error` text,
	`created_by` text,
	`state` text NOT NULL,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`display_name` text NOT NULL,
	`notify_email` text NOT NULL,
	`redirect_url` text,
	`submit_key` text,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `kinds` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`definition` text NOT NULL,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`seo` text,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`auth_pool` text,
	`site` text,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer NOT NULL,
	`form_id` text NOT NULL,
	`data` text NOT NULL,
	`replyto` text,
	`verdict` text,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`form_id`, `id`),
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`css` text NOT NULL,
	`created_by` text,
	`create_time` text NOT NULL,
	`update_time` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
