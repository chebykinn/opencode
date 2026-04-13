CREATE TABLE `sse_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`directory` text NOT NULL,
	`type` text NOT NULL,
	`properties` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sse_event_directory_id_idx` ON `sse_event` (`directory`,`id`);--> statement-breakpoint
CREATE INDEX `sse_event_created_at_idx` ON `sse_event` (`created_at`);