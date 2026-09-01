CREATE TABLE `saml_application_assignments` (
	`application_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`application_id`, `user_id`),
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saml_application_assignments_user_idx` ON `saml_application_assignments` (`user_id`);--> statement-breakpoint
CREATE TABLE `saml_application_group_claims` (
	`application_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`application_id`, `group_id`),
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `identity_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saml_application_group_claims_group_idx` ON `saml_application_group_claims` (`group_id`);--> statement-breakpoint
CREATE TABLE `saml_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`entity_id` text NOT NULL,
	`acs_url` text NOT NULL,
	`name_id_format` text DEFAULT 'email' NOT NULL,
	`access_policy` text DEFAULT 'selected_users' NOT NULL,
	`email_attribute_name` text NOT NULL,
	`name_attribute_name` text NOT NULL,
	`groups_attribute_name` text,
	`sign_response` integer DEFAULT true NOT NULL,
	`require_signed_authn_requests` integer DEFAULT false NOT NULL,
	`sp_signing_certificate` text,
	`allow_idp_initiated` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_applications_entity_id_unique` ON `saml_applications` (`entity_id`);--> statement-breakpoint
CREATE INDEX `saml_applications_enabled_idx` ON `saml_applications` (`enabled`);--> statement-breakpoint
CREATE INDEX `saml_applications_created_by_idx` ON `saml_applications` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `saml_pairwise_subjects` (
	`application_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`application_id`, `user_id`),
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_pairwise_subjects_name_id_unique` ON `saml_pairwise_subjects` (`name_id`);--> statement-breakpoint
CREATE INDEX `saml_pairwise_subjects_user_idx` ON `saml_pairwise_subjects` (`user_id`);--> statement-breakpoint
CREATE TABLE `saml_authn_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`user_id` text,
	`sp_request_id` text,
	`acs_url` text NOT NULL,
	`relay_state` text,
	`requested_sp_name_qualifier` text,
	`allow_name_id_creation` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'awaiting_login' NOT NULL,
	`browser_secret_hash` text,
	`auth_time` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_authn_requests_sp_request_unique` ON `saml_authn_requests` (`application_id`,`sp_request_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_expiry_idx` ON `saml_authn_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_user_idx` ON `saml_authn_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_status_idx` ON `saml_authn_requests` (`status`);--> statement-breakpoint
-- Keep the Entity ID and every issued persistent NameID in one immutable namespace.
-- The trigger closes the race between the first NameID insert and an admin update.
CREATE TRIGGER `saml_applications_entity_id_immutable`
BEFORE UPDATE OF `entity_id` ON `saml_applications`
FOR EACH ROW
WHEN NEW.entity_id <> OLD.entity_id
  AND EXISTS (
    SELECT 1
    FROM `saml_pairwise_subjects`
    WHERE `application_id` = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'SAML_ENTITY_ID_IMMUTABLE');
END;
