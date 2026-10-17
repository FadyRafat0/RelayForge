CREATE TABLE delivery_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
  previous_attempt_count integer NOT NULL CHECK (previous_attempt_count >= 0),
  previous_max_attempts integer NOT NULL CHECK (previous_max_attempts > 0),
  additional_attempts integer NOT NULL CHECK (additional_attempts BETWEEN 1 AND 10),
  replayed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_attempt_count <= previous_max_attempts),
  -- Only one replay may reopen the same failed generation.
  UNIQUE (delivery_id, previous_attempt_count)
);

CREATE INDEX deliveries_dead_completed_idx ON deliveries (completed_at DESC, id DESC)
  WHERE status = 'dead';
