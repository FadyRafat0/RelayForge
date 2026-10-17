import type { Pool } from 'pg';

export interface NewEndpoint {
  name: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  rate_limit_per_second: number;
}

export interface Endpoint extends NewEndpoint {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface EndpointPage {
  limit: number;
  offset: number;
}

export interface RegisteredEndpoint extends Endpoint { signing_secret: string }

export interface EndpointStore {
  createEndpoint(input: NewEndpoint): Promise<RegisteredEndpoint>;
  listEndpoints(page: EndpointPage): Promise<Endpoint[]>;
  updateEndpoint(id: string, input: Partial<NewEndpoint>): Promise<Endpoint | undefined>;
}

interface EndpointRow extends NewEndpoint {
  id: string;
  created_at: Date;
  updated_at: Date;
}

function toEndpoint(row: EndpointRow): Endpoint {
  return { id: row.id, name: row.name, url: row.url, event_types: row.event_types, enabled: row.enabled,
    rate_limit_per_second: row.rate_limit_per_second,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

export function createEndpointStore(sql: Pick<Pool, 'query'>): EndpointStore {
  return {
    async updateEndpoint(id, input) {
      // COALESCE preserves omitted fields. The API rejects null values.
      const result = await sql.query<EndpointRow>(`UPDATE webhook_endpoints SET
        name = COALESCE($2, name), url = COALESCE($3, url),
        event_types = COALESCE($4, event_types), enabled = COALESCE($5, enabled),
        rate_limit_per_second = COALESCE($6, rate_limit_per_second)
        WHERE id = $1 RETURNING id, name, url, event_types, enabled,
          rate_limit_per_second, created_at, updated_at`,
      [id, input.name, input.url, input.event_types, input.enabled, input.rate_limit_per_second]);
      return result.rows[0] ? toEndpoint(result.rows[0]) : undefined;
    },
    async createEndpoint(input) {
      // Values travel separately from the SQL text; never concatenate user input.
      const result = await sql.query<EndpointRow & { signing_secret: string }>(`INSERT INTO webhook_endpoints
        (name, url, event_types, enabled, rate_limit_per_second) VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, url, event_types, enabled, rate_limit_per_second, created_at, updated_at, signing_secret`,
      [input.name, input.url, input.event_types, input.enabled, input.rate_limit_per_second]);
      const row = result.rows[0];
      if (!row) throw new Error('Endpoint insert returned no row');
      return { ...toEndpoint(row), signing_secret: row.signing_secret };
    },
    async listEndpoints({ limit, offset }) {
      // The UUID breaks ties when several rows share a creation timestamp.
      const result = await sql.query<EndpointRow>(`SELECT
        id, name, url, event_types, enabled, rate_limit_per_second, created_at, updated_at
        FROM webhook_endpoints ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows.map(toEndpoint);
    },
  };
}
