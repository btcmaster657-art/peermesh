begin;

alter table profiles add column if not exists has_accepted_provider_terms boolean default false;
alter table profiles add column if not exists daily_share_limit_mb integer default null;
alter table profiles add column if not exists share_bytes_today bigint default 0;
alter table profiles add column if not exists share_bytes_today_date date default current_date;

alter table sessions add column if not exists provider_kind text;
alter table sessions add column if not exists target_host text;

create table if not exists private_share_devices (
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

create index if not exists private_share_devices_user_id_idx on private_share_devices (user_id);
create index if not exists private_share_devices_share_code_idx on private_share_devices (share_code);

create or replace view peer_availability as
  select
    pd.country_code as country,
    count(*)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
  group by pd.country_code;

create or replace function increment_bytes_shared(
  p_user_id uuid,
  p_bytes bigint
) returns void as $$
begin
  update profiles
  set
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

create or replace function get_provider_share_status(
  p_user_id uuid
) returns table (
  user_id uuid,
  total_bytes_today bigint,
  daily_share_limit_mb integer,
  can_accept boolean
) as $$
  select
    p.id as user_id,
    case
      when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0)
      else 0
    end as total_bytes_today,
    p.daily_share_limit_mb,
    case
      when p.daily_share_limit_mb is null then true
      else (
        case
          when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0)
          else 0
        end
      ) < (p.daily_share_limit_mb::bigint * 1024 * 1024)
    end as can_accept
  from profiles p
  where p.id = p_user_id;
$$ language sql security definer;

create or replace function finalize_session_accountability(
  p_session_id uuid,
  p_provider_id uuid,
  p_provider_country text,
  p_bytes_used bigint,
  p_target_host text default null
) returns void as $$
begin
  update session_accountability
  set
    provider_id      = coalesce(p_provider_id, provider_id),
    provider_country = coalesce(p_provider_country, provider_country),
    target_host      = coalesce(p_target_host, target_host),
    bytes_used       = greatest(coalesce(bytes_used, 0), coalesce(p_bytes_used, 0)),
    ended_at         = now()
  where session_id = p_session_id;
end;
$$ language plpgsql security definer;

commit;
