import { createClient } from '@supabase/supabase-js';

type DocKey = 'users' | 'markets' | 'secrets' | 'feedbacks' | 'settings';

interface MutateRequestBody {
  doc?: DocKey;
  expectedVersion?: number;
  requestId?: string;
  mutationType?: string;
  payload?: unknown;
  userName?: string | null;
}

const DOC_TABLES: Record<DocKey, string> = {
  users: 'shared_users',
  markets: 'shared_markets',
  secrets: 'shared_secrets',
  feedbacks: 'shared_feedbacks',
  settings: 'shared_settings',
};

const json = (res: any, status: number, payload: Record<string, unknown>) => {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const parseBody = (body: unknown): MutateRequestBody | null => {
  if (!body) return {};
  if (typeof body === 'object') return body as MutateRequestBody;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as MutateRequestBody;
    } catch {
      return null;
    }
  }
  return null;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    json(res, 405, {
      ok: false,
      code: 'INVALID_METHOD',
      version: 0,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const body = parseBody(req.body);
  if (!body) {
    json(res, 400, {
      ok: false,
      code: 'INVALID_REQUEST',
      version: 0,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const doc = body.doc;
  const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : Number.NaN;
  const payload = body.payload;
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const mutationType = typeof body.mutationType === 'string' ? body.mutationType : 'unknown';
  const userName = typeof body.userName === 'string' ? body.userName : null;

  if (!doc || !(doc in DOC_TABLES) || Number.isNaN(expectedVersion) || typeof payload === 'undefined' || !requestId) {
    json(res, 400, {
      ok: false,
      code: 'INVALID_REQUEST',
      version: 0,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    json(res, 503, {
      ok: false,
      code: 'UNAVAILABLE',
      version: 0,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const table = DOC_TABLES[doc];
  const nowIso = new Date().toISOString();

    // Guard against stale-snapshot overwrites for the users table.
    // A write that would set user count to 0 (or cut it by >50% when there are >=4 users)
    // is almost certainly a stale-cache write from a client with empty/old localStorage.
    if (doc === 'users') {
      const { data: snapshotRow } = await supabase
        .from(table)
        .select('payload')
        .eq('id', 1)
        .maybeSingle();

      const currentCount = Array.isArray(snapshotRow?.payload)
        ? (snapshotRow.payload as unknown[]).length
        : 0;
      const nextCount = Array.isArray(payload) ? (payload as unknown[]).length : 0;

      if (currentCount > 0 && nextCount === 0) {
        json(res, 400, {
          ok: false,
          code: 'EMPTY_PAYLOAD',
          version: expectedVersion,
          updatedAt: nowIso,
        });
        return;
      }

      if (currentCount >= 4 && nextCount < currentCount / 2) {
        json(res, 400, {
          ok: false,
          code: 'STALE_SNAPSHOT',
          version: expectedVersion,
          updatedAt: nowIso,
        });
        return;
      }
    }

    // Optional dedupe/audit tables may not exist yet; best-effort only.
  const { error: dedupeError } = await supabase
    .from('request_dedupe')
    .insert({ request_id: requestId, doc_key: doc, user_name: userName, status: 'ok' });

  if (!dedupeError) {
    // Dedupe insert succeeded, continue.
  } else if ((dedupeError as { code?: string }).code === '23505') {
    const { data: currentRow } = await supabase
      .from(table)
      .select('version,updated_at')
      .eq('id', 1)
      .maybeSingle();

    json(res, 202, {
      ok: true,
      code: 'DUPLICATE',
      version: typeof currentRow?.version === 'number' ? currentRow.version : expectedVersion,
      updatedAt: currentRow?.updated_at ?? nowIso,
    });
    return;
  }

  const nextVersion = expectedVersion + 1;
  const { data: updatedRow, error: updateError } = await supabase
    .from(table)
    .update({ payload, version: nextVersion, updated_at: nowIso })
    .eq('id', 1)
    .eq('version', expectedVersion)
    .select('version,updated_at')
    .maybeSingle();

  if (updateError) {
    json(res, 500, {
      ok: false,
      code: 'SERVER_ERROR',
      version: expectedVersion,
      updatedAt: nowIso,
    });
    return;
  }

  if (!updatedRow || typeof updatedRow.version !== 'number') {
    const { data: currentRow } = await supabase
      .from(table)
      .select('version,updated_at')
      .eq('id', 1)
      .maybeSingle();

    const currentVersion = typeof currentRow?.version === 'number' ? currentRow.version : expectedVersion;
    const currentUpdatedAt = currentRow?.updated_at ?? nowIso;

    void supabase
      .from('sync_conflict_log')
      .insert({ table_name: table, attempted_version: expectedVersion, user_name: userName, occurred_at: nowIso });

    void supabase
      .from('mutation_audit_log')
      .insert({
        doc_key: doc,
        mutation_type: mutationType,
        request_id: requestId,
        user_name: userName,
        expected_version: expectedVersion,
        resulting_version: currentVersion,
        result: 'conflict',
      });

    json(res, 409, {
      ok: false,
      code: 'VERSION_CONFLICT',
      version: currentVersion,
      updatedAt: currentUpdatedAt,
    });
    return;
  }

  void supabase
    .from('mutation_audit_log')
    .insert({
      doc_key: doc,
      mutation_type: mutationType,
      request_id: requestId,
      user_name: userName,
      expected_version: expectedVersion,
      resulting_version: updatedRow.version,
      result: 'ok',
    });

  json(res, 200, {
    ok: true,
    code: 'OK',
    version: updatedRow.version,
    updatedAt: updatedRow.updated_at,
  });
}
