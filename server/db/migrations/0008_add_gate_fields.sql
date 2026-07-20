ALTER TABLE changes ADD COLUMN gate_state TEXT;
--> statement-breakpoint
ALTER TABLE changes ADD COLUMN docs_complete INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE changes ADD COLUMN retro_done INTEGER NOT NULL DEFAULT 0;
