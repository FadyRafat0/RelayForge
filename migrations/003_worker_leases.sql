ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_outcome_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_outcome_check
    CHECK (outcome IN ('in_progress', 'succeeded', 'failed', 'abandoned'));

-- Stop old workers before this migration. Preserve any legacy interrupted work.
UPDATE delivery_attempts SET outcome = 'abandoned', finished_at = clock_timestamp(),
    error_message = 'Legacy worker interrupted during lease migration; HTTP outcome unknown'
    WHERE outcome = 'in_progress';
UPDATE deliveries SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'pending' END,
    completed_at = CASE WHEN attempt_count >= max_attempts THEN clock_timestamp() ELSE NULL END,
    next_attempt_at = clock_timestamp(), last_enqueued_at = NULL, last_stream_id = NULL
    WHERE status = 'processing';

ALTER TABLE deliveries
    ADD COLUMN active_attempt_id uuid,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN lease_owner text CHECK (char_length(btrim(lease_owner)) BETWEEN 1 AND 100),
    ADD CONSTRAINT deliveries_processing_lease CHECK ((status = 'processing') = (active_attempt_id IS NOT NULL)),
    ADD CONSTRAINT deliveries_lease_expiry_pair CHECK ((active_attempt_id IS NULL) = (lease_expires_at IS NULL)),
    ADD CONSTRAINT deliveries_lease_owner_pair CHECK ((active_attempt_id IS NULL) = (lease_owner IS NULL));

-- The active attempt must belong to this delivery, not merely exist elsewhere.
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_delivery_id_id_key UNIQUE (delivery_id, id);
ALTER TABLE deliveries ADD CONSTRAINT deliveries_active_attempt_fkey
    FOREIGN KEY (id, active_attempt_id) REFERENCES delivery_attempts (delivery_id, id) ON DELETE RESTRICT;

CREATE INDEX deliveries_expired_lease_idx ON deliveries (lease_expires_at, id)
    WHERE status = 'processing';
