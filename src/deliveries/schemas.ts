// Explicit response fields keep event payloads and endpoint secrets out of inspection APIs.
const text = { type: 'string' };
const integer = { type: 'integer' };
const nullableText = { type: 'string', nullable: true };
function object(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}
export const deliverySchema = object({
  id: text, event_id: text, endpoint_id: text,
  status: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'dead'] },
  attempt_count: integer, max_attempts: integer, next_attempt_at: text, completed_at: nullableText,
  created_at: text, updated_at: text,
});
export const attemptSchema = object({
  id: text, attempt_number: integer,
  outcome: { type: 'string', enum: ['in_progress', 'succeeded', 'failed', 'abandoned'] },
  http_status: { type: 'integer', nullable: true }, error_message: nullableText,
  started_at: text, finished_at: nullableText,
});
export const replaySchema = object({ id: text, reason: text, previous_attempt_count: integer,
  previous_max_attempts: integer, additional_attempts: integer, replayed_at: text });
export const detailSchema = object({ delivery: object({ ...deliverySchema.properties,
  endpoint_enabled: { type: 'boolean' }, event_type: text,
  last_attempt: { ...attemptSchema, nullable: true }, last_replay: { ...replaySchema, nullable: true },
}) });
export const replayResultSchema = object({ delivery: deliverySchema, replay: replaySchema });
export function pageResponse(key: string, items: object) {
  return object({ [key]: { type: 'array', items }, limit: integer, offset: integer });
}
