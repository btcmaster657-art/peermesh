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

drop view if exists peer_availability cascade;

drop table if exists abuse_reports cascade;
drop table if exists session_accountability cascade;
drop table if exists sessions cascade;
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

-- Peer availability view
create view peer_availability as
  select
    country_code as country,
    count(*)::int as count
  from profiles
  where is_sharing = true
    and is_verified = true
  group by country_code;

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