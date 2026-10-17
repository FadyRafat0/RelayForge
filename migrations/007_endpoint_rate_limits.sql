ALTER TABLE webhook_endpoints ADD COLUMN rate_limit_per_second integer NOT NULL DEFAULT 10
  CHECK (rate_limit_per_second BETWEEN 1 AND 1000);
