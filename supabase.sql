-- ================================
-- Cleanup (safe to re-run on fresh or existing DB)
-- ================================
do $$ begin
  drop trigger if exists on_auth_user_created on auth.users;
exception when others then null; end $$;

do $$ begin
  drop trigger if exists profiles_updated_at on profiles;
exception when others then null; end $$;

drop function if exists handle_new_user() cascade;
drop function if exists handle_updated_at() cascade;
drop function if exists update_trust_score(uuid, integer) cascade;
drop function if exists increment_bandwidth(uuid, bigint) cascade;
drop function if exists increment_bytes_shared(uuid, bigint) cascade;
drop function if exists get_provider_share_status(uuid) cascade;
drop function if exists reset_monthly_bandwidth() cascade;
drop function if exists upsert_provider_heartbeat(uuid, text, text) cascade;
drop function if exists upsert_provider_heartbeat(uuid, text, text, text) cascade;
drop function if exists remove_provider_device(uuid, text) cascade;
drop function if exists cleanup_stale_providers() cascade;
drop function if exists cleanup_stale_sessions() cascade;
drop function if exists finalize_session_accountability(uuid, uuid, text, bigint, text) cascade;
drop function if exists set_preferred_provider(uuid, text, uuid) cascade;

drop view if exists peer_availability cascade;

drop table if exists extension_auth_tokens cascade;
drop table if exists abuse_reports cascade;
drop table if exists session_accountability cascade;
drop table if exists sessions cascade;
drop table if exists provider_devices cascade;
drop table if exists provider_slot_limits cascade;
drop table if exists private_share_devices cascade;
drop table if exists device_codes cascade;
drop table if exists auth_tokens cascade;
drop table if exists countries cascade;
drop table if exists profiles cascade;

-- ================================
-- Extensions
-- ================================
create extension if not exists "uuid-ossp";

-- Profiles table (extends Supabase auth.users)
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique,
  country_code text not null default 'RW',
  trust_score integer default 50 check (trust_score between 0 and 100),

  -- Verification
  is_verified boolean default false,
  verified_at timestamptz,
  phone_number text,
  gov_id_verified boolean default false,

  -- Subscription
  is_premium boolean default false,
  subscription_id text,
  subscription_status text default 'free',
  stripe_customer_id text,

  -- Network
  is_sharing boolean default false,
  total_bytes_shared bigint default 0,
  share_bytes_today bigint default 0,
  share_bytes_today_date date default current_date,
  total_bytes_used bigint default 0,
  bandwidth_used_month bigint default 0,
  bandwidth_limit bigint default 5368709120, -- 5GB free tier
  preferred_providers jsonb default '{}'::jsonb,
  has_accepted_provider_terms boolean default false,
  daily_share_limit_mb integer default null,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Sessions table — single source of truth for all session data.
-- session_accountability has been removed; everything lives here.
create table sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null, -- requester
  provider_id    uuid references profiles(id) on delete set null,          -- set on agent_ready
  provider_kind  text,                                                      -- 'desktop'|'cli'|'extension'
  target_country text not null,
  target_host    text,                                                      -- best representative hostname
  target_hosts   text[] default '{}',                                      -- all hostnames seen in session
  relay_endpoint text,
  status         text default 'pending' check (status in ('pending','active','ended','flagged')),
  bytes_used     bigint default 0,
  signed_receipt text,                                                      -- HMAC accountability receipt
  started_at     timestamptz default now(),
  ended_at       timestamptz
);

create index sessions_status_idx on sessions (status) where status = 'active';

-- Abuse reports
create table abuse_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references profiles(id) on delete set null,
  reported_session_id uuid references sessions(id) on delete set null,
  reason text not null,
  reviewed boolean default false,
  created_at timestamptz default now()
);

-- Extension auth tokens
create table extension_auth_tokens (
  id uuid primary key default gen_random_uuid(),
  ext_id text not null unique,
  user_id uuid references profiles(id) on delete cascade not null,
  token text not null,
  supabase_token text,
  used boolean default false,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz default now()
);

-- Active provider devices (one row per sharing device, heartbeat-based)
create table provider_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  connection_slots integer not null default 1,
  country_code text not null,
  relay_url text default null,         -- relay the device is currently connected to
  last_heartbeat timestamptz not null default now(),
  created_at timestamptz default now(),
  unique (user_id, device_id)
);

create index on provider_devices (last_heartbeat);
create index on provider_devices (user_id);
create index on provider_devices (country_code, last_heartbeat);

-- Slot-level sharing controls and daily limits
create table provider_slot_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  base_device_id text not null,
  slot_index integer,
  daily_limit_mb integer,
  bytes_today bigint not null default 0,
  bytes_today_date date not null default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, device_id),
  check (daily_limit_mb is null or daily_limit_mb >= 1024),
  check (slot_index is null or slot_index >= 0)
);

create index on provider_slot_limits (user_id, base_device_id);
create index on provider_slot_limits (user_id, bytes_today_date);

-- Private sharing codes
create table private_share_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  share_code text not null unique,
  enabled boolean default false,
  expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, base_device_id)
);

create index on private_share_devices (user_id);
create index on private_share_devices (share_code);

-- Device authorization codes (OAuth 2.0 Device Flow)
create table device_codes (
  id uuid primary key default gen_random_uuid(),
  device_code text not null unique,
  user_code text not null unique,
  user_id uuid references profiles(id) on delete cascade,
  token text,
  status text default 'pending' check (status in ('pending','approved','expired','denied','revoked')),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz default now()
);

create index on extension_auth_tokens (ext_id) where used = false;
create index on device_codes (device_code) where status = 'pending';
create index on device_codes (user_code) where status = 'pending';

-- Countries
create table countries (
  code       text primary key,
  name       text not null,
  flag       text not null,
  region     text not null default '',
  active     boolean not null default true,
  sort_order integer not null default 999,
  created_at timestamptz default now()
);

create index on countries (active) where active = true;
create index on countries (region);
create index on countries (sort_order, name);

-- Auth tokens
create table auth_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade not null,
  email      text not null,
  token      text not null,
  type       text not null check (type in ('forgot_password','confirm_email')),
  used       boolean not null default false,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz default now()
);

create index on auth_tokens (email, type) where used = false;
create index on auth_tokens (expires_at);

-- Peer availability view
create view peer_availability as
  select
    pd.country_code as country,
    count(*)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
  group by pd.country_code;

-- ================================
-- Functions
-- ================================

create or replace function update_trust_score(p_user_id uuid, delta integer)
returns void as $$
  update profiles
  set trust_score = greatest(0, least(100, trust_score + delta)), updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

create or replace function increment_bandwidth(p_user_id uuid, p_bytes bigint)
returns void as $$
  update profiles
  set total_bytes_used = total_bytes_used + p_bytes,
      bandwidth_used_month = bandwidth_used_month + p_bytes,
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

create or replace function increment_bytes_shared(p_user_id uuid, p_bytes bigint)
returns void as $$
begin
  update profiles set
    total_bytes_shared = total_bytes_shared + p_bytes,
    share_bytes_today = case
      when share_bytes_today_date = current_date then coalesce(share_bytes_today, 0) + p_bytes
      else p_bytes
    end,
    share_bytes_today_date = current_date,
    updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function get_provider_share_status(p_user_id uuid)
returns table (
  user_id uuid,
  total_bytes_today bigint,
  daily_share_limit_mb integer,
  can_accept boolean
) as $$
  select
    p.id,
    case when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0) else 0 end,
    p.daily_share_limit_mb,
    case
      when p.daily_share_limit_mb is null then true
      else (case when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0) else 0 end)
           < (p.daily_share_limit_mb::bigint * 1024 * 1024)
    end
  from profiles p where p.id = p_user_id;
$$ language sql security definer;

create or replace function upsert_provider_heartbeat(
  p_user_id   uuid,
  p_device_id text,
  p_country   text,
  p_relay_url text default null
) returns void as $$
begin
  insert into provider_devices (user_id, device_id, country_code, last_heartbeat, relay_url)
  values (p_user_id, p_device_id, p_country, now(), p_relay_url)
  on conflict (user_id, device_id)
  do update set
    last_heartbeat = now(),
    country_code   = p_country,
    relay_url      = coalesce(p_relay_url, provider_devices.relay_url);

  update profiles set is_sharing = true, updated_at = now() where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function remove_provider_device(p_user_id uuid, p_device_id text)
returns void as $$
begin
  delete from provider_devices where user_id = p_user_id and device_id = p_device_id;
  update profiles
  set is_sharing = exists(
    select 1 from provider_devices
    where user_id = p_user_id and last_heartbeat > now() - interval '45 seconds'
  ), updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function cleanup_stale_providers() returns void as $$
begin
  update profiles
  set is_sharing = exists(
    select 1 from provider_devices pd
    where pd.user_id = profiles.id and pd.last_heartbeat > now() - interval '45 seconds'
  ), updated_at = now()
  where id in (
    select distinct user_id from provider_devices
    where last_heartbeat <= now() - interval '45 seconds'
  );
  delete from provider_devices where last_heartbeat <= now() - interval '45 seconds';
end;
$$ language plpgsql security definer;

create or replace function cleanup_stale_sessions() returns void as $$
  update sessions set status = 'ended', ended_at = now()
  where status in ('pending', 'active') and started_at < now() - interval '2 hours';
$$ language sql security definer;

create or replace function reset_monthly_bandwidth() returns void as $$
  update profiles set bandwidth_used_month = 0 where subscription_status = 'free';
$$ language sql security definer;

-- Update peer affinity — set preferred provider for a country
create or replace function set_preferred_provider(
  p_user_id          uuid,
  p_country          text,
  p_provider_user_id uuid
) returns void as $$
  update profiles
  set preferred_providers = preferred_providers || jsonb_build_object(p_country, p_provider_user_id::text),
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

-- Auto-create profile on signup
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, country_code, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'country_code', 'RW'),
    nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

create or replace function handle_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute procedure handle_updated_at();

-- ================================
-- Row Level Security
-- ================================

alter table profiles enable row level security;
alter table sessions enable row level security;
alter table abuse_reports enable row level security;

create policy "Users can view own profile"   on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Anyone can view peer counts"  on profiles for select using (true);

create policy "Users can view own sessions"   on sessions for select using (auth.uid() = user_id);
create policy "Users can create sessions"     on sessions for insert with check (auth.uid() = user_id);
create policy "Users can update own sessions" on sessions for update using (auth.uid() = user_id);

create policy "Authenticated users can report"
  on abuse_reports for insert with check (auth.uid() = reporter_id);

alter table extension_auth_tokens enable row level security;
create policy "Service role only ext tokens" on extension_auth_tokens for all using (false);

alter table provider_devices enable row level security;
create policy "Service role only provider devices" on provider_devices for all using (false);

alter table device_codes enable row level security;
create policy "Service role only device codes" on device_codes for all using (false);

alter table countries enable row level security;
create policy "Anyone can read active countries" on countries for select using (active = true);

alter table auth_tokens enable row level security;
create policy "Service role only auth tokens" on auth_tokens for all using (false);

alter table private_share_devices enable row level security;
create policy "Service role only private share devices" on private_share_devices for all using (false);

alter table provider_slot_limits enable row level security;
create policy "Service role only provider slot limits" on provider_slot_limits for all using (false);

-- ================================
-- Migrations (safe to run on existing DBs)
-- ================================
alter table provider_devices add column if not exists relay_url text default null;
alter table provider_devices add column if not exists connection_slots integer not null default 1;
create table if not exists provider_slot_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  base_device_id text not null,
  slot_index integer,
  daily_limit_mb integer,
  bytes_today bigint not null default 0,
  bytes_today_date date not null default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, device_id),
  check (daily_limit_mb is null or daily_limit_mb >= 1024),
  check (slot_index is null or slot_index >= 0)
);
create index if not exists provider_slot_limits_user_base_idx on provider_slot_limits (user_id, base_device_id);
create index if not exists provider_slot_limits_user_date_idx on provider_slot_limits (user_id, bytes_today_date);
alter table provider_slot_limits enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_slot_limits'
      and policyname = 'Service role only provider slot limits'
  ) then
    create policy "Service role only provider slot limits" on provider_slot_limits for all using (false);
  end if;
end $$;
alter table profiles add column if not exists has_accepted_provider_terms boolean default false;
alter table profiles add column if not exists daily_share_limit_mb integer default null;
alter table profiles add column if not exists share_bytes_today bigint default 0;
alter table profiles add column if not exists share_bytes_today_date date default current_date;
alter table sessions add column if not exists provider_kind text;
alter table sessions add column if not exists target_host text;
alter table sessions add column if not exists signed_receipt text;
alter table sessions add column if not exists target_hosts text[] default '{}';

update sessions
set target_hosts = array[target_host]
where target_host is not null
  and (target_hosts is null or target_hosts = '{}');

create index if not exists sessions_status_idx on sessions (status) where status = 'active';
create index if not exists provider_devices_country_hb_idx on provider_devices (country_code, last_heartbeat);
