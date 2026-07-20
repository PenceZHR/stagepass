ALTER TABLE projects ADD COLUMN prd_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE changes ADD COLUMN suspended_by_prd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE changes ADD COLUMN pre_suspend_status TEXT;

-- Existing projects with context ready should have prd_status='ready'
UPDATE projects SET prd_status = 'ready' WHERE context_status = 'ready';
