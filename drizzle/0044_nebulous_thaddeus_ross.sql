CREATE INDEX `discovery_runs_schedule_started` ON `discovery_runs` (`schedule_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `discovery_runs_started` ON `discovery_runs` (`started_at`);