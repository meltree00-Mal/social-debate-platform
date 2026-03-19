-- shared_state_v3_hardening.sql
-- Purpose: harden split-document writes with idempotency + optimistic lock in DB.

create extension if not exists pgcrypto;

create table if not exists public.request_dedupe (
  id bigserial primary key,
  request_id uuid not null,
  doc_key text not null check (doc_key in ('users','markets','secrets','feedbacks','settings')),
  user_name text,
  status text not null default 'ok',
  created_at timestamptz not null default now(),
  unique (request_id, doc_key)
);

create table if not exists public.mutation_audit_log (
  id bigserial primary key,
  doc_key text not null,
  mutation_type text not null,
  request_id uuid not null,
  user_name text,
  expected_version bigint,
  resulting_version bigint,
  result text not null,
  latency_ms int,
  created_at timestamptz not null default now()
);

alter table public.request_dedupe enable row level security;
alter table public.mutation_audit_log enable row level security;

-- Server-role only: no public RLS policies added intentionally.

create or replace function public.update_shared_doc_with_cas(
  p_doc_key text,
  p_expected_version bigint,
  p_next_payload jsonb,
  p_request_id uuid,
  p_user_name text,
  p_mutation_type text default 'unknown'
)
returns table(ok boolean, code text, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_name text;
  v_inserted int;
  v_current_version bigint;
  v_now timestamptz := now();
  v_start timestamptz := clock_timestamp();
begin
  if p_doc_key not in ('users','markets','secrets','feedbacks','settings') then
    return query select false, 'INVALID_DOC', 0::bigint, v_now;
    return;
  end if;

  insert into public.request_dedupe(request_id, doc_key, user_name)
  values (p_request_id, p_doc_key, p_user_name)
  on conflict (request_id, doc_key) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    -- duplicated request_id for same doc
    v_table_name := 'shared_' || p_doc_key;
    execute format('select version from public.%I where id = 1', v_table_name) into v_current_version;

    insert into public.mutation_audit_log(
      doc_key, mutation_type, request_id, user_name, expected_version, resulting_version, result, latency_ms
    ) values (
      p_doc_key, p_mutation_type, p_request_id, p_user_name, p_expected_version, v_current_version, 'duplicate',
      (extract(epoch from (clock_timestamp() - v_start)) * 1000)::int
    );

    return query select true, 'DUPLICATE', v_current_version, v_now;
    return;
  end if;

  v_table_name := 'shared_' || p_doc_key;

  execute format(
    'update public.%I set payload = $1, version = version + 1, updated_at = now() where id = 1 and version = $2 returning version, updated_at',
    v_table_name
  ) using p_next_payload, p_expected_version
  into v_current_version, v_now;

  if v_current_version is null then
    execute format('select version, updated_at from public.%I where id = 1', v_table_name)
    into v_current_version, v_now;

    insert into public.mutation_audit_log(
      doc_key, mutation_type, request_id, user_name, expected_version, resulting_version, result, latency_ms
    ) values (
      p_doc_key, p_mutation_type, p_request_id, p_user_name, p_expected_version, v_current_version, 'conflict',
      (extract(epoch from (clock_timestamp() - v_start)) * 1000)::int
    );

    return query select false, 'VERSION_CONFLICT', v_current_version, v_now;
    return;
  end if;

  insert into public.mutation_audit_log(
    doc_key, mutation_type, request_id, user_name, expected_version, resulting_version, result, latency_ms
  ) values (
    p_doc_key, p_mutation_type, p_request_id, p_user_name, p_expected_version, v_current_version, 'ok',
    (extract(epoch from (clock_timestamp() - v_start)) * 1000)::int
  );

  return query select true, 'OK', v_current_version, v_now;
end;
$$;

revoke all on function public.update_shared_doc_with_cas(text, bigint, jsonb, uuid, text, text) from public;
grant execute on function public.update_shared_doc_with_cas(text, bigint, jsonb, uuid, text, text) to service_role;

create index if not exists idx_request_dedupe_created_at on public.request_dedupe(created_at);
create index if not exists idx_mutation_audit_log_created_at on public.mutation_audit_log(created_at);
create index if not exists idx_mutation_audit_log_result on public.mutation_audit_log(result);

-- Optional cleanup job (invoke from cron/edge function):
-- delete from public.request_dedupe where created_at < now() - interval '30 days';
