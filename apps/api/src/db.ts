import { Pool, type QueryResultRow } from 'pg';

import { env } from './env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10
});

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}
