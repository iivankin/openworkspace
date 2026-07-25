CREATE TABLE `access_link_claims` (
	`access_link_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`claimed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`access_link_id`) REFERENCES `access_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_links` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_links_token_hash_unique` ON `access_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_links_user_kind_idx` ON `access_links` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `access_links_expiry_idx` ON `access_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`access_link_id` text,
	`rp_id` text NOT NULL,
	`origin` text NOT NULL,
	`payload` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`access_link_id`) REFERENCES `access_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_challenges_user_idx` ON `auth_challenges` (`user_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `identity_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_user_idx` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `identity_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_groups_slug_unique` ON `identity_groups` (`slug`);--> statement-breakpoint
CREATE INDEX `identity_groups_name_idx` ON `identity_groups` (`name`);--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `mailbox_members` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`can_send` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_members_user_idx` ON `mailbox_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`personal_owner_id` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`personal_owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_unique` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_personal_owner_unique` ON `mailboxes` (`personal_owner_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_kind_idx` ON `mailboxes` (`kind`);--> statement-breakpoint
CREATE TABLE `oidc_access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_expiry_idx` ON `oidc_access_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_family_idx` ON `oidc_access_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_user_client_idx` ON `oidc_access_tokens` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text,
	`subject_user_id` text,
	`client_id` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `oidc_audit_events_created_idx` ON `oidc_audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `oidc_audit_events_client_idx` ON `oidc_audit_events` (`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_authorization_codes` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`nonce` text,
	`code_challenge` text NOT NULL,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`issued_access_token_hash` text,
	`issued_refresh_family_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_authorization_codes_expiry_idx` ON `oidc_authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_codes_user_client_idx` ON `oidc_authorization_codes` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_authorization_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`status` text DEFAULT 'awaiting_consent' NOT NULL,
	`browser_secret_hash` text,
	`force_consent` integer DEFAULT false NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`state` text,
	`nonce` text,
	`code_challenge` text NOT NULL,
	`auth_time` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_expiry_idx` ON `oidc_authorization_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_user_idx` ON `oidc_authorization_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_status_idx` ON `oidc_authorization_requests` (`status`);--> statement-breakpoint
CREATE TABLE `oidc_client_assignments` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_client_assignments_user_idx` ON `oidc_client_assignments` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_client_group_claims` (
	`client_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`client_id`, `group_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `identity_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_client_group_claims_group_idx` ON `oidc_client_group_claims` (`group_id`);--> statement-breakpoint
CREATE TABLE `oidc_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`client_type` text NOT NULL,
	`secret_hash` text,
	`access_policy` text DEFAULT 'selected_users' NOT NULL,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text DEFAULT '[]' NOT NULL,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`allowed_scopes` text NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `oidc_clients_enabled_idx` ON `oidc_clients` (`enabled`);--> statement-breakpoint
CREATE INDEX `oidc_clients_created_by_idx` ON `oidc_clients` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `oidc_grants` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_grants_user_idx` ON `oidc_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`replaced_by_token_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_family_idx` ON `oidc_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_expiry_idx` ON `oidc_refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_user_client_idx` ON `oidc_refresh_tokens` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `passkey_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_credentials_user_idx` ON `passkey_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`window_ends_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_buckets_expiry_idx` ON `rate_limit_buckets` (`window_ends_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
-- Runtime-only invariant: Drizzle snapshots do not model this trigger.
CREATE TRIGGER `access_link_claim_requires_active_link`
BEFORE INSERT ON `access_link_claims`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `access_links`
	WHERE `id` = NEW.`access_link_id`
		AND `user_id` = NEW.`user_id`
		AND `consumed_at` IS NULL
		AND `expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
)
BEGIN
	SELECT RAISE(ABORT, 'Access link is invalid or expired');
END;