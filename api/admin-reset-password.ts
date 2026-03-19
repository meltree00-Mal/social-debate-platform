import { createClient } from '@supabase/supabase-js';

const json = (res: any, statusCode: number, payload: Record<string, unknown>) => {
  res.status(statusCode).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const normalizeEmail = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const findAuthUserByEmail = async (adminClient: any, email: string) => {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) {
      return { user: null, error };
    }

    const users = data.users ?? [];
    const matched = users.find((user: any) => normalizeEmail(user.email) === email);
    if (matched) {
      return { user: matched, error: null };
    }

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  return { user: null, error: null };
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    json(res, 500, { error: 'Missing SUPABASE config on server' });
    return;
  }

  let body: any = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
  }

  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
  const targetEmail = normalizeEmail(body?.targetEmail);
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword.trim() : '';

  if (!accessToken || !targetEmail || !newPassword) {
    json(res, 400, { error: 'accessToken, targetEmail and newPassword are required' });
    return;
  }

  if (newPassword.length < 4) {
    json(res, 400, { error: 'Password must be at least 4 characters' });
    return;
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: requesterData, error: requesterError } = await adminClient.auth.getUser(accessToken);
  if (requesterError || !requesterData.user?.email) {
    json(res, 401, { error: 'Invalid admin session' });
    return;
  }

  const requesterEmail = normalizeEmail(requesterData.user.email);

  const { data: usersDoc, error: usersError } = await adminClient
    .from('shared_users')
    .select('payload')
    .eq('id', 1)
    .maybeSingle();

  if (usersError) {
    json(res, 500, { error: 'Failed to load shared users' });
    return;
  }

  const payload = usersDoc?.payload;
  if (!Array.isArray(payload)) {
    json(res, 500, { error: 'Invalid shared users payload' });
    return;
  }

  const requester = payload.find((user: any) => normalizeEmail(user?.email) === requesterEmail);
  if (!requester || requester.isAdmin !== true || requester.isActive === false) {
    json(res, 403, { error: 'Only active admin can reset passwords' });
    return;
  }

  const targetExists = payload.some((user: any) => normalizeEmail(user?.email) === targetEmail);
  if (!targetExists) {
    json(res, 404, { error: 'Target user not found in shared users' });
    return;
  }

  const { user: targetAuthUser, error: listUsersError } = await findAuthUserByEmail(adminClient, targetEmail);
  if (listUsersError) {
    json(res, 500, { error: listUsersError.message || 'Failed to list auth users' });
    return;
  }

  if (!targetAuthUser?.id) {
    json(res, 404, { error: 'Target auth account not found' });
    return;
  }

  const { error: updateError } = await adminClient.auth.admin.updateUserById(targetAuthUser.id, {
    password: newPassword,
  });

  if (updateError) {
    json(res, 500, { error: updateError.message || 'Failed to reset password' });
    return;
  }

  json(res, 200, { ok: true });
}
