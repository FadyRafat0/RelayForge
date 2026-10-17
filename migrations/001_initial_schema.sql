-- One local project for now. Authentication and project ownership come later.
CREATE TABLE webhook_endpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    -- Basic format only; outbound URL/SSRF validation belongs in the API/worker.
    url text NOT NULL CHECK (url ~ '^https?://[^[:space:]]+$' AND char_length(url) <= 2048),
    event_types text[] NOT NULL DEFAULT ARRAY['*']::text[],
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (cardinality(event_types) > 0 AND array_ndims(event_types) = 1
           AND array_position(event_types, NULL) IS NULL
           AND array_position(event_types, '') IS NULL)
);

CREATE TABLE events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL CHECK (char_length(btrim(type)) BETWEEN 1 AND 100),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    -- NULL means no key supplied; multiple NULLs are allowed by UNIQUE.
    idempotency_key text UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'dead')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, endpoint_id),
    CHECK (attempt_count <= max_attempts),
    CHECK ((status IN ('succeeded', 'dead')) = (completed_at IS NOT NULL))
);

CREATE TABLE delivery_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    outcome text NOT NULL DEFAULT 'in_progress'
        CHECK (outcome IN ('in_progress', 'succeeded', 'failed')),
    http_status integer CHECK (http_status BETWEEN 100 AND 599),
    error_message text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (delivery_id, attempt_number),
    CHECK ((outcome = 'in_progress') = (finished_at IS NULL)),
    CHECK (finished_at IS NULL OR finished_at >= started_at),
    CHECK (outcome <> 'succeeded' OR
           (http_status IS NOT NULL AND http_status BETWEEN 200 AND 299 AND error_message IS NULL))
);

-- Initial indexes for expected lookups; tune against real queries later.
CREATE INDEX webhook_endpoints_created_idx ON webhook_endpoints (created_at, id);
CREATE INDEX events_created_idx ON events (created_at, id);
CREATE INDEX deliveries_endpoint_created_idx ON deliveries (endpoint_id, created_at, id);
CREATE INDEX deliveries_pending_due_idx ON deliveries (next_attempt_at, id)
    WHERE status = 'pending';
-- UNIQUE(event_id, endpoint_id) and UNIQUE(delivery_id, attempt_number)
-- already create indexes that support event and attempt-history lookups.

-- DEFAULT now() runs only on INSERT. A trigger also keeps updated_at fresh.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_updated_at BEFORE UPDATE ON webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER deliveries_updated_at BEFORE UPDATE ON deliveries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
