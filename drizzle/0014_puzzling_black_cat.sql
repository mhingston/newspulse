CREATE TABLE `analysis_reservations` (
	`key` text PRIMARY KEY NOT NULL,
	`tokens` integer NOT NULL,
	`micros` integer NOT NULL,
	`status` text NOT NULL
);
