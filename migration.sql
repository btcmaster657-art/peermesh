-- Targeted cross-surface sync metadata for sharing state.
-- These columns track the latest user-facing state writer for:
--   - profile daily sharing limit / public sharing status
--   - provider slot count
--   - private share code / enablement / expiry
--   - per-slot daily limits
--
-- Future writers can set `peermesh.state_actor` in the DB session or
-- write `state_actor` directly before the row mutation. If neither is set,
-- the actor falls back to `system`.

create or replace function normalize_peermesh_state_actor(p_actor text)
returns text
language sql
immutable
as $$
  select coalesce(nullif(left(lower(btrim(coalesce(p_actor, ''))), 32), ''), 'system');
$$;

create or replace function resolve_peermesh_state_actor(
  p_new_actor text,
  p_old_actor text default null
)
returns text
language plpgsql
stable
as $$
declare
  v_actor text;
begin
  v_actor := nullif(btrim(current_setting('peermesh.state_actor', true)), '');
  if v_actor is not null then
    return normalize_peermesh_state_actor(v_actor);
  end if;

  if p_old_actor is null or p_new_actor is distinct from p_old_actor then
    return normalize_peermesh_state_actor(p_new_actor);
  end if;

  return 'system';
end;
$$;

alter table profiles add column if not exists state_actor text;
alter table profiles add column if not exists state_changed_at timestamptz;

alter table provider_devices add column if not exists state_actor text;
alter table provider_devices add column if not exists state_changed_at timestamptz;

alter table private_share_devices add column if not exists state_actor text;
alter table private_share_devices add column if not exists state_changed_at timestamptz;

alter table provider_slot_limits add column if not exists state_actor text;
alter table provider_slot_limits add column if not exists state_changed_at timestamptz;

update profiles
set
  state_actor = coalesce(nullif(btrim(state_actor), ''), 'legacy'),
  state_changed_at = coalesce(state_changed_at, updated_at, created_at, now())
where coalesce(btrim(state_actor), '') = ''
   or state_changed_at is null;

update provider_devices
set
  state_actor = coalesce(nullif(btrim(state_actor), ''), 'legacy'),
  state_changed_at = coalesce(state_changed_at, last_heartbeat, created_at, now())
where coalesce(btrim(state_actor), '') = ''
   or state_changed_at is null;

update private_share_devices
set
  state_actor = coalesce(nullif(btrim(state_actor), ''), 'legacy'),
  state_changed_at = coalesce(state_changed_at, updated_at, created_at, now())
where coalesce(btrim(state_actor), '') = ''
   or state_changed_at is null;

update provider_slot_limits
set
  state_actor = coalesce(nullif(btrim(state_actor), ''), 'legacy'),
  state_changed_at = coalesce(state_changed_at, updated_at, created_at, now())
where coalesce(btrim(state_actor), '') = ''
   or state_changed_at is null;

alter table profiles alter column state_actor set default 'system';
alter table profiles alter column state_changed_at set default now();
alter table profiles alter column state_actor set not null;
alter table profiles alter column state_changed_at set not null;

alter table provider_devices alter column state_actor set default 'system';
alter table provider_devices alter column state_changed_at set default now();
alter table provider_devices alter column state_actor set not null;
alter table provider_devices alter column state_changed_at set not null;

alter table private_share_devices alter column state_actor set default 'system';
alter table private_share_devices alter column state_changed_at set default now();
alter table private_share_devices alter column state_actor set not null;
alter table private_share_devices alter column state_changed_at set not null;

alter table provider_slot_limits alter column state_actor set default 'system';
alter table provider_slot_limits alter column state_changed_at set default now();
alter table provider_slot_limits alter column state_actor set not null;
alter table provider_slot_limits alter column state_changed_at set not null;

create or replace function peermesh_apply_state_metadata()
returns trigger
language plpgsql
as $$
declare
  touched boolean := false;
begin
  if tg_op = 'INSERT' then
    new.state_actor := resolve_peermesh_state_actor(new.state_actor, null);
    new.state_changed_at := now();
    return new;
  end if;

  if tg_table_name = 'profiles' then
    touched :=
      new.daily_share_limit_mb is distinct from old.daily_share_limit_mb
      or new.is_sharing is distinct from old.is_sharing;
  elsif tg_table_name = 'provider_devices' then
    touched :=
      new.connection_slots is distinct from old.connection_slots
      or new.device_id is distinct from old.device_id
      or new.user_id is distinct from old.user_id;
  elsif tg_table_name = 'private_share_devices' then
    touched :=
      new.base_device_id is distinct from old.base_device_id
      or new.share_code is distinct from old.share_code
      or new.enabled is distinct from old.enabled
      or new.expires_at is distinct from old.expires_at;
  elsif tg_table_name = 'provider_slot_limits' then
    touched :=
      new.device_id is distinct from old.device_id
      or new.base_device_id is distinct from old.base_device_id
      or new.slot_index is distinct from old.slot_index
      or new.daily_limit_mb is distinct from old.daily_limit_mb;
  else
    touched := true;
  end if;

  if touched then
    new.state_actor := resolve_peermesh_state_actor(new.state_actor, old.state_actor);
    new.state_changed_at := now();
  else
    new.state_actor := old.state_actor;
    new.state_changed_at := old.state_changed_at;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_state_metadata on profiles;
create trigger profiles_state_metadata
  before insert or update on profiles
  for each row execute procedure peermesh_apply_state_metadata();

drop trigger if exists provider_devices_state_metadata on provider_devices;
create trigger provider_devices_state_metadata
  before insert or update on provider_devices
  for each row execute procedure peermesh_apply_state_metadata();

drop trigger if exists private_share_devices_state_metadata on private_share_devices;
create trigger private_share_devices_state_metadata
  before insert or update on private_share_devices
  for each row execute procedure peermesh_apply_state_metadata();

drop trigger if exists provider_slot_limits_state_metadata on provider_slot_limits;
create trigger provider_slot_limits_state_metadata
  before insert or update on provider_slot_limits
  for each row execute procedure peermesh_apply_state_metadata();

create index if not exists provider_devices_user_state_changed_idx
  on provider_devices (user_id, state_changed_at desc);

create index if not exists private_share_devices_user_state_changed_idx
  on private_share_devices (user_id, state_changed_at desc);

create index if not exists provider_slot_limits_user_state_changed_idx
  on provider_slot_limits (user_id, state_changed_at desc);

alter table profiles replica identity full;
alter table provider_devices replica identity full;
alter table private_share_devices replica identity full;
alter table provider_slot_limits replica identity full;
