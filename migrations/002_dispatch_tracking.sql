ALTER TABLE deliveries
    ADD COLUMN last_enqueued_at timestamptz,
    ADD COLUMN last_stream_id text CHECK (last_stream_id ~ '^[0-9]+-[0-9]+$'),
    ADD CONSTRAINT deliveries_enqueue_tracking_pair
        CHECK ((last_enqueued_at IS NULL) = (last_stream_id IS NULL));

-- Reuse the existing partial index for pending deliveries by next_attempt_at.
-- Queue markers are hints, not completion: stale pending work is republished.
