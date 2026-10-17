-- Receiver-owned example data, independent of the sender's delivery lifecycle.
-- A real webhook consumer would keep these in its own database.
CREATE TABLE receiver_receipts (
  receiver_id text NOT NULL CHECK (char_length(receiver_id) BETWEEN 1 AND 100),
  delivery_id uuid NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receiver_id, delivery_id)
);

CREATE TABLE receiver_effects (
  receiver_id text NOT NULL,
  delivery_id uuid NOT NULL,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receiver_id, delivery_id),
  FOREIGN KEY (receiver_id, delivery_id)
    REFERENCES receiver_receipts (receiver_id, delivery_id)
);
