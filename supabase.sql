-- ================================
-- Cleanup (safe to re-run on fresh or existing DB)
-- ================================
do $$ begin
  drop trigger if exists on_auth_user_created on auth.users;
exception when others then null; end $$;

do $$ begin
  drop trigger if exists profiles_updated_at on profiles;
exception when others then null; end $$;

do $$ begin
  drop trigger if exists sessions_updated_at on sessions;
exception when others then null; end $$;

drop function if exists handle_new_user() cascade;
drop function if exists handle_updated_at() cascade;
drop function if exists update_trust_score(uuid, integer) cascade;
drop function if exists increment_bandwidth(uuid, bigint) cascade;
drop function if exists increment_bytes_shared(uuid, bigint) cascade;
drop function if exists reset_monthly_bandwidth() cascade;
drop function if exists upsert_provider_heartbeat(uuid, text, text) cascade;
drop function if exists remove_provider_device(uuid, text) cascade;
drop function if exists cleanup_stale_providers() cascade;
drop function if exists cleanup_stale_sessions() cascade;

drop view if exists peer_availability cascade;

drop table if exists extension_auth_tokens cascade;
drop table if exists abuse_reports cascade;
drop table if exists session_accountability cascade;
drop table if exists sessions cascade;
drop table if exists provider_devices cascade;
drop table if exists device_codes cascade;
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
  total_bytes_used bigint default 0,
  bandwidth_used_month bigint default 0,
  bandwidth_limit bigint default 5368709120, -- 5GB free tier

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Sessions table
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  provider_id uuid references profiles(id) on delete set null,
  target_country text not null,
  relay_endpoint text,
  status text default 'pending' check (status in ('pending','active','ended','flagged')),
  bytes_used bigint default 0,
  signed_receipt text, -- JWT accountability receipt
  started_at timestamptz default now(),
  ended_at timestamptz
);

-- Session accountability (immutable audit log)
create table session_accountability (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  requester_id uuid references profiles(id) on delete set null,
  provider_id uuid references profiles(id) on delete set null,
  target_host text,
  provider_country text,
  signed_receipt text not null,
  created_at timestamptz default now()
);

-- Abuse reports
create table abuse_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references profiles(id) on delete set null,
  reported_session_id uuid references sessions(id) on delete set null,
  reason text not null,
  reviewed boolean default false,
  created_at timestamptz default now()
);

-- Extension auth tokens (one-time bypass tokens for extension sign-in)
create table extension_auth_tokens (
  id uuid primary key default gen_random_uuid(),
  ext_id text not null unique,
  user_id uuid references profiles(id) on delete cascade not null,
  token text not null,
  supabase_token text,                -- Supabase access_token for API calls
  used boolean default false,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz default now()
);

-- Active provider devices (one row per sharing device, heartbeat-based)
create table provider_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,             -- stable per-install UUID
  country_code text not null,
  last_heartbeat timestamptz not null default now(),
  created_at timestamptz default now(),
  unique (user_id, device_id)
);

create index on provider_devices (last_heartbeat);
create index on provider_devices (user_id);

-- Device authorization codes (OAuth 2.0 Device Flow for desktop app)
create table device_codes (
  id uuid primary key default gen_random_uuid(),
  device_code text not null unique,   -- long random code for polling
  user_code text not null unique,     -- short human-readable code (e.g. PMSH-4829)
  user_id uuid references profiles(id) on delete cascade,
  token text,                         -- desktop token issued after approval
  status text default 'pending' check (status in ('pending','approved','expired','denied')),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz default now()
);

-- Auto-delete used/expired tokens
create index on extension_auth_tokens (ext_id) where used = false;
create index on device_codes (device_code) where status = 'pending';
create index on device_codes (user_code) where status = 'pending';

-- Peer availability view — based on live heartbeats, not stale boolean
create view peer_availability as
  select
    pd.country_code as country,
    count(distinct pd.user_id)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
  group by pd.country_code;

-- Trust score function
create or replace function update_trust_score(
  p_user_id uuid,
  delta integer
) returns void as $$
  update profiles
  set trust_score = greatest(0, least(100, trust_score + delta)),
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

-- Increment bandwidth usage
create or replace function increment_bandwidth(
  p_user_id uuid,
  p_bytes bigint
) returns void as $$
  update profiles
  set total_bytes_used = total_bytes_used + p_bytes,
      bandwidth_used_month = bandwidth_used_month + p_bytes,
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

-- Increment bytes shared (called when provider ends a session)
create or replace function increment_bytes_shared(
  p_user_id uuid,
  p_bytes bigint
) returns void as $$
  update profiles
  set total_bytes_shared = total_bytes_shared + p_bytes,
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

-- Upsert provider heartbeat and sync is_sharing
create or replace function upsert_provider_heartbeat(
  p_user_id uuid,
  p_device_id text,
  p_country text
) returns void as $$
begin
  insert into provider_devices (user_id, device_id, country_code, last_heartbeat)
  values (p_user_id, p_device_id, p_country, now())
  on conflict (user_id, device_id)
  do update set last_heartbeat = now(), country_code = p_country;

  update profiles set is_sharing = true, updated_at = now() where id = p_user_id;
end;
$$ language plpgsql security definer;

-- Remove a specific device and update is_sharing if no devices remain
create or replace function remove_provider_device(
  p_user_id uuid,
  p_device_id text
) returns void as $$
begin
  delete from provider_devices where user_id = p_user_id and device_id = p_device_id;

  update profiles
  set is_sharing = exists(
    select 1 from provider_devices
    where user_id = p_user_id
      and last_heartbeat > now() - interval '45 seconds'
  ),
  updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

-- Purge stale devices (heartbeat older than 45s) and fix is_sharing
create or replace function cleanup_stale_providers()
returns void as $$
begin
  -- Find affected users before deleting
  update profiles
  set is_sharing = exists(
    select 1 from provider_devices pd
    where pd.user_id = profiles.id
      and pd.last_heartbeat > now() - interval '45 seconds'
  ),
  updated_at = now()
  where id in (
    select distinct user_id from provider_devices
    where last_heartbeat <= now() - interval '45 seconds'
  );

  delete from provider_devices where last_heartbeat <= now() - interval '45 seconds';
end;
$$ language plpgsql security definer;

-- Auto-end sessions stuck in active for more than 2 hours
create or replace function cleanup_stale_sessions()
returns void as $$
  update sessions
  set status = 'ended', ended_at = now()
  where status = 'active'
    and started_at < now() - interval '2 hours';
$$ language sql security definer;

-- Reset monthly bandwidth (call via cron or scheduled function)
create or replace function reset_monthly_bandwidth()
returns void as $$
  update profiles
  set bandwidth_used_month = 0
  where subscription_status = 'free';
$$ language sql security definer;

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, country_code, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'country_code', 'RW'),
    nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Updated_at trigger
create or replace function handle_updated_at()
returns trigger as $$
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

-- Profiles: users manage their own
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- Peer availability view is public (needed for country picker)
create policy "Anyone can view peer counts"
  on profiles for select
  using (true);

-- Sessions: users manage their own
create policy "Users can view own sessions"
  on sessions for select using (auth.uid() = user_id);

create policy "Users can create sessions"
  on sessions for insert with check (auth.uid() = user_id);

create policy "Users can update own sessions"
  on sessions for update using (auth.uid() = user_id);

-- Abuse reports: authenticated users can file
create policy "Authenticated users can report"
  on abuse_reports for insert
  with check (auth.uid() = reporter_id);

-- Session accountability: service role only (no user RLS needed)
alter table session_accountability enable row level security;
create policy "Service role only"
  on session_accountability for all
  using (false);

-- Extension auth tokens: service role only
alter table extension_auth_tokens enable row level security;
create policy "Service role only ext tokens"
  on extension_auth_tokens for all
  using (false);

-- Provider devices: service role only
alter table provider_devices enable row level security;
create policy "Service role only provider devices"
  on provider_devices for all
  using (false);

-- Device codes: service role only
alter table device_codes enable row level security;
create policy "Service role only device codes"
  on device_codes for all
  using (false);