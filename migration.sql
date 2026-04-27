-- PeerMesh production migration
-- Aligns billing, provider occupancy, provider session reporting, and multi-slot sharing state.

alter table profiles add column if not exists role text not null default 'client';
alter table profiles add column if not exists contribution_credits_bytes bigint not null default 0;
alter table profiles add column if not exists wallet_balance_usd numeric(14,2) not null default 0;
alter table profiles add column if not exists wallet_pending_payout_usd numeric(14,2) not null default 0;
alter table profiles add column if not exists payout_currency text;
alter table profiles add column if not exists payment_provider text not null default 'flutterwave';
alter table profiles add column if not exists state_actor text;
alter table profiles add column if not exists state_changed_at timestamptz default now();

alter table sessions add column if not exists provider_kind text;
alter table sessions add column if not exists provider_device_id text;
alter table sessions add column if not exists provider_base_device_id text;
alter table sessions add column if not exists target_host text;
alter table sessions add column if not exists target_hosts text[] default '{}';
alter table sessions add column if not exists signed_receipt text;
alter table sessions add column if not exists disconnect_reason text;
alter table sessions add column if not exists request_access_mode text not null default 'public';
alter table sessions add column if not exists request_auth_kind text not null default 'user';
alter table sessions add column if not exists api_key_id uuid;
alter table sessions add column if not exists request_id text;
alter table sessions add column if not exists pricing_tier text;
alter table sessions add column if not exists requested_bandwidth_gb numeric(10,4);
alter table sessions add column if not exists requested_rpm integer;
alter table sessions add column if not exists requested_period_hours integer;
alter table sessions add column if not exists requested_session_mode text;
alter table sessions add column if not exists estimated_cost_usd numeric(14,4) not null default 0;

alter table provider_devices add column if not exists relay_url text default null;
alter table provider_devices add column if not exists connection_slots integer not null default 1;
alter table provider_devices add column if not exists state_actor text;
alter table provider_devices add column if not exists state_changed_at timestamptz default now();
alter table provider_devices add column if not exists updated_at timestamptz default now();

alter table provider_slot_limits add column if not exists state_actor text;
alter table provider_slot_limits add column if not exists state_changed_at timestamptz default now();

alter table private_share_devices add column if not exists state_actor text;
alter table private_share_devices add column if not exists state_changed_at timestamptz default now();
alter table private_share_devices add column if not exists updated_at timestamptz default now();

alter table abuse_reports add column if not exists reported_user_id uuid references profiles(id) on delete set null;
alter table abuse_reports add column if not exists report_subject text not null default 'provider';

alter table extension_auth_tokens add column if not exists refresh_token text;
alter table extension_auth_tokens add column if not exists device_session_id uuid;

alter table device_codes add column if not exists refresh_token text;
alter table device_codes add column if not exists device_session_id uuid;

create table if not exists device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_code_id uuid references device_codes(id) on delete set null,
  actor text not null default 'device_flow',
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'extension_auth_tokens_device_session_id_fkey'
  ) then
    alter table extension_auth_tokens
      add constraint extension_auth_tokens_device_session_id_fkey
      foreign key (device_session_id) references device_sessions(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'device_codes_device_session_id_fkey'
  ) then
    alter table device_codes
      add constraint device_codes_device_session_id_fkey
      foreign key (device_session_id) references device_sessions(id) on delete set null;
  end if;
end $$;

create table if not exists wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  kind text not null check (kind in ('credit','debit','payment','payout','refund','bonus','contribution_credit')),
  amount_usd numeric(14,2) not null,
  currency text not null default 'USD',
  reference text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  provider text not null default 'flutterwave',
  tx_ref text not null unique,
  flutterwave_transaction_id text,
  checkout_url text,
  status text not null default 'pending' check (status in ('pending','successful','failed','cancelled')),
  amount_usd numeric(14,2) not null,
  local_amount numeric(14,2),
  local_currency text,
  raw_response jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  verified_at timestamptz
);

create table if not exists provider_payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  amount_usd numeric(14,2) not null,
  destination_currency text not null,
  destination_amount numeric(14,2),
  fx_rate numeric(18,8),
  flutterwave_transfer_id text,
  status text not null default 'pending' check (status in ('pending','processing','successful','failed','cancelled')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  processed_at timestamptz
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  tier text not null check (tier in ('standard','advanced','enterprise','contributor')),
  rpm_limit integer not null,
  session_mode text not null check (session_mode in ('rotating','sticky')),
  requires_verification boolean not null default false,
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid references api_keys(id) on delete cascade not null,
  user_id uuid references profiles(id) on delete cascade not null,
  session_id uuid references sessions(id) on delete set null,
  request_id text,
  bandwidth_bytes bigint not null default 0,
  rpm_requested integer not null default 0,
  session_mode text not null default 'rotating' check (session_mode in ('rotating','sticky')),
  duration_minutes integer not null default 0,
  estimated_cost_usd numeric(14,4) not null default 0,
  collected_cost_usd numeric(14,4) not null default 0,
  shortfall_cost_usd numeric(14,4) not null default 0,
  created_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_api_key_id_fkey'
  ) then
    alter table sessions
      add constraint sessions_api_key_id_fkey
      foreign key (api_key_id) references api_keys(id) on delete set null;
  end if;
end $$;

update sessions
set target_hosts = array[target_host]
where target_host is not null
  and (target_hosts is null or target_hosts = '{}');

create index if not exists wallet_ledger_user_created_idx on wallet_ledger (user_id, created_at desc);
create unique index if not exists wallet_ledger_reference_uidx on wallet_ledger (reference);
create index if not exists payment_transactions_user_created_idx on payment_transactions (user_id, created_at desc);
create index if not exists payment_transactions_status_idx on payment_transactions (status);
create index if not exists provider_payouts_user_created_idx on provider_payouts (user_id, created_at desc);
create index if not exists device_sessions_user_created_idx on device_sessions (user_id, created_at desc);
create index if not exists api_keys_user_created_idx on api_keys (user_id, created_at desc);
create index if not exists api_keys_key_prefix_idx on api_keys (key_prefix);
create index if not exists api_usage_user_created_idx on api_usage (user_id, created_at desc);
create index if not exists api_usage_key_created_idx on api_usage (api_key_id, created_at desc);
create index if not exists sessions_status_idx on sessions (status) where status = 'active';
create index if not exists sessions_provider_status_idx on sessions (provider_id, status, started_at desc);
create index if not exists sessions_provider_device_status_idx on sessions (provider_device_id, status) where status = 'active';
create index if not exists provider_devices_country_hb_idx on provider_devices (country_code, last_heartbeat);

alter table wallet_ledger enable row level security;
alter table payment_transactions enable row level security;
alter table provider_payouts enable row level security;
alter table device_sessions enable row level security;
alter table api_keys enable row level security;
alter table api_usage enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'wallet_ledger'
      and policyname = 'Users can view own wallet ledger'
  ) then
    create policy "Users can view own wallet ledger" on wallet_ledger for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_transactions'
      and policyname = 'Users can view own payment transactions'
  ) then
    create policy "Users can view own payment transactions" on payment_transactions for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'device_sessions'
      and policyname = 'Service role only device sessions'
  ) then
    create policy "Service role only device sessions" on device_sessions for all using (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_payouts'
      and policyname = 'Users can view own provider payouts'
  ) then
    create policy "Users can view own provider payouts" on provider_payouts for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can view own api keys'
  ) then
    create policy "Users can view own api keys" on api_keys for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can insert own api keys'
  ) then
    create policy "Users can insert own api keys" on api_keys for insert with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can update own api keys'
  ) then
    create policy "Users can update own api keys" on api_keys for update using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_usage'
      and policyname = 'Users can view own api usage'
  ) then
    create policy "Users can view own api usage" on api_usage for select using (auth.uid() = user_id);
  end if;
end $$;

create or replace view peer_availability as
  select
    pd.country_code as country,
    count(*)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  left join sessions s on s.provider_device_id = pd.device_id and s.status = 'active'
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
    and s.id is null
  group by pd.country_code;
