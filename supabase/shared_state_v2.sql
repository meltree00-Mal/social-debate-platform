-- Split shared state into per-domain documents with optimistic-lock versioning.

create table if not exists public.shared_users (
  id bigint primary key,
  payload jsonb not null default '[]'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_markets (
  id bigint primary key,
  payload jsonb not null default '[]'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_secrets (
  id bigint primary key,
  payload jsonb not null default '[]'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_feedbacks (
  id bigint primary key,
  payload jsonb not null default '[]'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_settings (
  id bigint primary key,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Seed singleton rows used by the app (id=1).
insert into public.shared_users (id) values (1)
on conflict (id) do nothing;

insert into public.shared_markets (id) values (1)
on conflict (id) do nothing;

insert into public.shared_secrets (id) values (1)
on conflict (id) do nothing;

insert into public.shared_feedbacks (id) values (1)
on conflict (id) do nothing;

insert into public.shared_settings (id, payload)
values (1, '{"publicAnnouncement":"欢迎来到社交对线平台内测，欢迎提出改进建议。","testInviteCode":""}'::jsonb)
on conflict (id) do nothing;

-- Lightweight conflict event log for debugging concurrent write races.
create table if not exists public.sync_conflict_log (
  id bigserial primary key,
  table_name text not null,
  attempted_version bigint not null,
  user_name text,
  occurred_at timestamptz not null default now()
);

-- Optional: migrate legacy monolithic shared_state row if it exists.
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'shared_state'
  ) then
    update public.shared_users
    set payload = coalesce((select payload->'users' from public.shared_state where id = 1), payload),
        version = case when (select payload->'users' from public.shared_state where id = 1) is not null then greatest(version, 1) else version end,
        updated_at = now()
    where id = 1;

    update public.shared_markets
    set payload = coalesce((select payload->'markets' from public.shared_state where id = 1), payload),
        version = case when (select payload->'markets' from public.shared_state where id = 1) is not null then greatest(version, 1) else version end,
        updated_at = now()
    where id = 1;

    update public.shared_secrets
    set payload = coalesce((select payload->'secrets' from public.shared_state where id = 1), payload),
        version = case when (select payload->'secrets' from public.shared_state where id = 1) is not null then greatest(version, 1) else version end,
        updated_at = now()
    where id = 1;

    update public.shared_feedbacks
    set payload = coalesce((select payload->'feedbacks' from public.shared_state where id = 1), payload),
        version = case when (select payload->'feedbacks' from public.shared_state where id = 1) is not null then greatest(version, 1) else version end,
        updated_at = now()
    where id = 1;

    update public.shared_settings
    set payload = jsonb_build_object(
      'publicAnnouncement', coalesce((select payload->>'publicAnnouncement' from public.shared_state where id = 1), payload->>'publicAnnouncement', '欢迎来到社交对线平台内测，欢迎提出改进建议。'),
      'testInviteCode', coalesce((select payload->>'testInviteCode' from public.shared_state where id = 1), payload->>'testInviteCode', '')
    ),
        version = case when (select payload from public.shared_state where id = 1) is not null then greatest(version, 1) else version end,
        updated_at = now()
    where id = 1;
  end if;
end
$$;