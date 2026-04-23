-- PeerMesh targeted migration: slot-level share limits + slot config support

begin;

alter table if exists provider_devices
  add column if not exists connection_slots integer not null default 1;

create table if not exists provider_slot_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  device_id text not null,
  base_device_id text not null,
  slot_index integer,
  daily_limit_mb integer,
  bytes_today bigint not null default 0,
  bytes_today_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id),
  check (daily_limit_mb is null or daily_limit_mb >= 1024),
  check (slot_index is null or slot_index >= 0)
);

create index if not exists provider_slot_limits_user_base_idx
  on provider_slot_limits (user_id, base_device_id);

create index if not exists provider_slot_limits_user_date_idx
  on provider_slot_limits (user_id, bytes_today_date);

alter table provider_slot_limits enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_slot_limits'
      and policyname = 'Service role only provider slot limits'
  ) then
    create policy "Service role only provider slot limits"
      on provider_slot_limits for all using (false);
  end if;
end
$$;

commit;
