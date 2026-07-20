ALTER TABLE projects ADD COLUMN git_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN git_default_branch TEXT;
ALTER TABLE changes ADD COLUMN git_branch TEXT;
