-- Two independently generated UUIDs provide 244 random bits without an extension.
-- The volatile default also gives each existing endpoint its own secret.
ALTER TABLE webhook_endpoints ADD COLUMN signing_secret text NOT NULL
  DEFAULT ('whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  CHECK (signing_secret ~ '^whsec_[0-9a-f]{64}$');
