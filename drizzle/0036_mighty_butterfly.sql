ALTER TABLE `inbound_messages` ADD `item_id` text REFERENCES items(id);--> statement-breakpoint
ALTER TABLE `inbound_messages` ADD `index_diagnostics` text;--> statement-breakpoint
CREATE INDEX `inbound_message_index_due` ON `inbound_messages` (`status`,`item_id`,`id`);