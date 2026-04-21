begin;

-- ── Countries table + seed ────────────────────────────────────────────────────
create table if not exists countries (
  code       text primary key,
  name       text not null,
  flag       text not null,
  region     text not null default '',
  active     boolean not null default true,
  sort_order integer not null default 999,
  created_at timestamptz default now()
);

create index if not exists countries_active_idx on countries (active) where active = true;
create index if not exists countries_region_idx on countries (region);
create index if not exists countries_sort_idx   on countries (sort_order, name);

insert into countries (code, name, flag, region, active, sort_order) values
-- Africa (sort_order=1 = featured)
('DZ','Algeria','🇩🇿','Africa',true,10),
('AO','Angola','🇦🇴','Africa',true,10),
('BJ','Benin','🇧🇯','Africa',true,10),
('BW','Botswana','🇧🇼','Africa',true,10),
('BF','Burkina Faso','🇧🇫','Africa',true,10),
('BI','Burundi','🇧🇮','Africa',true,10),
('CM','Cameroon','🇨🇲','Africa',true,10),
('CV','Cape Verde','🇨🇻','Africa',true,10),
('CF','Central African Republic','🇨🇫','Africa',true,10),
('TD','Chad','🇹🇩','Africa',true,10),
('KM','Comoros','🇰🇲','Africa',true,10),
('CG','Congo','🇨🇬','Africa',true,10),
('CD','DR Congo','🇨🇩','Africa',true,10),
('CI','Côte d''Ivoire','🇨🇮','Africa',true,10),
('DJ','Djibouti','🇩🇯','Africa',true,10),
('EG','Egypt','🇪🇬','Africa',true,10),
('GQ','Equatorial Guinea','🇬🇶','Africa',true,10),
('ER','Eritrea','🇪🇷','Africa',true,10),
('SZ','Eswatini','🇸🇿','Africa',true,10),
('ET','Ethiopia','🇪🇹','Africa',true,10),
('GA','Gabon','🇬🇦','Africa',true,10),
('GM','Gambia','🇬🇲','Africa',true,10),
('GH','Ghana','🇬🇭','Africa',true,1),
('GN','Guinea','🇬🇳','Africa',true,10),
('GW','Guinea-Bissau','🇬🇼','Africa',true,10),
('KE','Kenya','🇰🇪','Africa',true,1),
('LS','Lesotho','🇱🇸','Africa',true,10),
('LR','Liberia','🇱🇷','Africa',true,10),
('LY','Libya','🇱🇾','Africa',true,10),
('MG','Madagascar','🇲🇬','Africa',true,10),
('MW','Malawi','🇲🇼','Africa',true,10),
('ML','Mali','🇲🇱','Africa',true,10),
('MR','Mauritania','🇲🇷','Africa',true,10),
('MU','Mauritius','🇲🇺','Africa',true,10),
('MA','Morocco','🇲🇦','Africa',true,10),
('MZ','Mozambique','🇲🇿','Africa',true,10),
('NA','Namibia','🇳🇦','Africa',true,10),
('NE','Niger','🇳🇪','Africa',true,10),
('NG','Nigeria','🇳🇬','Africa',true,1),
('RW','Rwanda','🇷🇼','Africa',true,1),
('ST','São Tomé and Príncipe','🇸🇹','Africa',true,10),
('SN','Senegal','🇸🇳','Africa',true,10),
('SC','Seychelles','🇸🇨','Africa',true,10),
('SL','Sierra Leone','🇸🇱','Africa',true,10),
('SO','Somalia','🇸🇴','Africa',true,10),
('ZA','South Africa','🇿🇦','Africa',true,1),
('SS','South Sudan','🇸🇸','Africa',true,10),
('SD','Sudan','🇸🇩','Africa',true,10),
('TZ','Tanzania','🇹🇿','Africa',true,10),
('TG','Togo','🇹🇬','Africa',true,10),
('TN','Tunisia','🇹🇳','Africa',true,10),
('UG','Uganda','🇺🇬','Africa',true,10),
('ZM','Zambia','🇿🇲','Africa',true,10),
('ZW','Zimbabwe','🇿🇼','Africa',true,10),
-- Americas
('AG','Antigua and Barbuda','🇦🇬','Americas',true,10),
('AR','Argentina','🇦🇷','Americas',true,10),
('BS','Bahamas','🇧🇸','Americas',true,10),
('BB','Barbados','🇧🇧','Americas',true,10),
('BZ','Belize','🇧🇿','Americas',true,10),
('BO','Bolivia','🇧🇴','Americas',true,10),
('BR','Brazil','🇧🇷','Americas',true,1),
('CA','Canada','🇨🇦','Americas',true,1),
('CL','Chile','🇨🇱','Americas',true,10),
('CO','Colombia','🇨🇴','Americas',true,10),
('CR','Costa Rica','🇨🇷','Americas',true,10),
('CU','Cuba','🇨🇺','Americas',true,10),
('DM','Dominica','🇩🇲','Americas',true,10),
('DO','Dominican Republic','🇩🇴','Americas',true,10),
('EC','Ecuador','🇪🇨','Americas',true,10),
('SV','El Salvador','🇸🇻','Americas',true,10),
('GD','Grenada','🇬🇩','Americas',true,10),
('GT','Guatemala','🇬🇹','Americas',true,10),
('GY','Guyana','🇬🇾','Americas',true,10),
('HT','Haiti','🇭🇹','Americas',true,10),
('HN','Honduras','🇭🇳','Americas',true,10),
('JM','Jamaica','🇯🇲','Americas',true,10),
('MX','Mexico','🇲🇽','Americas',true,10),
('NI','Nicaragua','🇳🇮','Americas',true,10),
('PA','Panama','🇵🇦','Americas',true,10),
('PY','Paraguay','🇵🇾','Americas',true,10),
('PE','Peru','🇵🇪','Americas',true,10),
('KN','Saint Kitts and Nevis','🇰🇳','Americas',true,10),
('LC','Saint Lucia','🇱🇨','Americas',true,10),
('VC','Saint Vincent and the Grenadines','🇻🇨','Americas',true,10),
('SR','Suriname','🇸🇷','Americas',true,10),
('TT','Trinidad and Tobago','🇹🇹','Americas',true,10),
('US','United States','🇺🇸','Americas',true,1),
('UY','Uruguay','🇺🇾','Americas',true,10),
('VE','Venezuela','🇻🇪','Americas',true,10),
-- Asia
('AF','Afghanistan','🇦🇫','Asia',true,10),
('AM','Armenia','🇦🇲','Asia',true,10),
('AZ','Azerbaijan','🇦🇿','Asia',true,10),
('BH','Bahrain','🇧🇭','Asia',true,10),
('BD','Bangladesh','🇧🇩','Asia',true,10),
('BT','Bhutan','🇧🇹','Asia',true,10),
('BN','Brunei','🇧🇳','Asia',true,10),
('KH','Cambodia','🇰🇭','Asia',true,10),
('CN','China','🇨🇳','Asia',true,10),
('CY','Cyprus','🇨🇾','Asia',true,10),
('GE','Georgia','🇬🇪','Asia',true,10),
('IN','India','🇮🇳','Asia',true,10),
('ID','Indonesia','🇮🇩','Asia',true,10),
('IR','Iran','🇮🇷','Asia',true,10),
('IQ','Iraq','🇮🇶','Asia',true,10),
('IL','Israel','🇮🇱','Asia',true,10),
('JP','Japan','🇯🇵','Asia',true,1),
('JO','Jordan','🇯🇴','Asia',true,10),
('KZ','Kazakhstan','🇰🇿','Asia',true,10),
('KW','Kuwait','🇰🇼','Asia',true,10),
('KG','Kyrgyzstan','🇰🇬','Asia',true,10),
('LA','Laos','🇱🇦','Asia',true,10),
('LB','Lebanon','🇱🇧','Asia',true,10),
('MY','Malaysia','🇲🇾','Asia',true,10),
('MV','Maldives','🇲🇻','Asia',true,10),
('MN','Mongolia','🇲🇳','Asia',true,10),
('MM','Myanmar','🇲🇲','Asia',true,10),
('NP','Nepal','🇳🇵','Asia',true,10),
('KP','North Korea','🇰🇵','Asia',true,10),
('OM','Oman','🇴🇲','Asia',true,10),
('PK','Pakistan','🇵🇰','Asia',true,10),
('PS','Palestine','🇵🇸','Asia',true,10),
('PH','Philippines','🇵🇭','Asia',true,10),
('QA','Qatar','🇶🇦','Asia',true,10),
('SA','Saudi Arabia','🇸🇦','Asia',true,10),
('SG','Singapore','🇸🇬','Asia',true,10),
('KR','South Korea','🇰🇷','Asia',true,10),
('LK','Sri Lanka','🇱🇰','Asia',true,10),
('SY','Syria','🇸🇾','Asia',true,10),
('TW','Taiwan','🇹🇼','Asia',true,10),
('TJ','Tajikistan','🇹🇯','Asia',true,10),
('TH','Thailand','🇹🇭','Asia',true,10),
('TL','Timor-Leste','🇹🇱','Asia',true,10),
('TR','Turkey','🇹🇷','Asia',true,10),
('TM','Turkmenistan','🇹🇲','Asia',true,10),
('AE','United Arab Emirates','🇦🇪','Asia',true,10),
('UZ','Uzbekistan','🇺🇿','Asia',true,10),
('VN','Vietnam','🇻🇳','Asia',true,10),
('YE','Yemen','🇾🇪','Asia',true,10),
-- Europe
('AL','Albania','🇦🇱','Europe',true,10),
('AD','Andorra','🇦🇩','Europe',true,10),
('AT','Austria','🇦🇹','Europe',true,10),
('BY','Belarus','🇧🇾','Europe',true,10),
('BE','Belgium','🇧🇪','Europe',true,10),
('BA','Bosnia and Herzegovina','🇧🇦','Europe',true,10),
('BG','Bulgaria','🇧🇬','Europe',true,10),
('HR','Croatia','🇭🇷','Europe',true,10),
('CZ','Czech Republic','🇨🇿','Europe',true,10),
('DK','Denmark','🇩🇰','Europe',true,10),
('EE','Estonia','🇪🇪','Europe',true,10),
('FI','Finland','🇫🇮','Europe',true,10),
('FR','France','🇫🇷','Europe',true,10),
('DE','Germany','🇩🇪','Europe',true,1),
('GR','Greece','🇬🇷','Europe',true,10),
('HU','Hungary','🇭🇺','Europe',true,10),
('IS','Iceland','🇮🇸','Europe',true,10),
('IE','Ireland','🇮🇪','Europe',true,10),
('IT','Italy','🇮🇹','Europe',true,10),
('XK','Kosovo','🇽🇰','Europe',true,10),
('LV','Latvia','🇱🇻','Europe',true,10),
('LI','Liechtenstein','🇱🇮','Europe',true,10),
('LT','Lithuania','🇱🇹','Europe',true,10),
('LU','Luxembourg','🇱🇺','Europe',true,10),
('MT','Malta','🇲🇹','Europe',true,10),
('MD','Moldova','🇲🇩','Europe',true,10),
('MC','Monaco','🇲🇨','Europe',true,10),
('ME','Montenegro','🇲🇪','Europe',true,10),
('NL','Netherlands','🇳🇱','Europe',true,10),
('MK','North Macedonia','🇲🇰','Europe',true,10),
('NO','Norway','🇳🇴','Europe',true,10),
('PL','Poland','🇵🇱','Europe',true,10),
('PT','Portugal','🇵🇹','Europe',true,10),
('RO','Romania','🇷🇴','Europe',true,10),
('RU','Russia','🇷🇺','Europe',true,10),
('SM','San Marino','🇸🇲','Europe',true,10),
('RS','Serbia','🇷🇸','Europe',true,10),
('SK','Slovakia','🇸🇰','Europe',true,10),
('SI','Slovenia','🇸🇮','Europe',true,10),
('ES','Spain','🇪🇸','Europe',true,10),
('SE','Sweden','🇸🇪','Europe',true,10),
('CH','Switzerland','🇨🇭','Europe',true,10),
('UA','Ukraine','🇺🇦','Europe',true,10),
('GB','United Kingdom','🇬🇧','Europe',true,1),
('VA','Vatican City','🇻🇦','Europe',true,10),
-- Oceania
('AU','Australia','🇦🇺','Oceania',true,1),
('FJ','Fiji','🇫🇯','Oceania',true,10),
('KI','Kiribati','🇰🇮','Oceania',true,10),
('MH','Marshall Islands','🇲🇭','Oceania',true,10),
('FM','Micronesia','🇫🇲','Oceania',true,10),
('NR','Nauru','🇳🇷','Oceania',true,10),
('NZ','New Zealand','🇳🇿','Oceania',true,10),
('PW','Palau','🇵🇼','Oceania',true,10),
('PG','Papua New Guinea','🇵🇬','Oceania',true,10),
('WS','Samoa','🇼🇸','Oceania',true,10),
('SB','Solomon Islands','🇸🇧','Oceania',true,10),
('TO','Tonga','🇹🇴','Oceania',true,10),
('TV','Tuvalu','🇹🇻','Oceania',true,10),
('VU','Vanuatu','🇻🇺','Oceania',true,10)
on conflict (code) do update set
  name       = excluded.name,
  flag       = excluded.flag,
  region     = excluded.region,
  active     = excluded.active,
  sort_order = excluded.sort_order;

-- ── session_accountability: add missing columns, indexes, unique constraint ────
alter table session_accountability
  add column if not exists bytes_used bigint default 0,
  add column if not exists started_at timestamptz default now();

create index if not exists session_accountability_session_id_idx
  on session_accountability (session_id);
create index if not exists session_accountability_requester_id_idx
  on session_accountability (requester_id);
create index if not exists session_accountability_provider_id_idx
  on session_accountability (provider_id);

alter table session_accountability
  drop constraint if exists session_accountability_session_id_key;
alter table session_accountability
  add constraint session_accountability_session_id_key unique (session_id);

-- ── finalize_session_accountability: replace UPDATE-only with UPSERT ──────────
-- Pulls provider_id, target_host, requester_id directly from the sessions row
-- so they are never left null even if the initial insert in session/create failed.
create or replace function finalize_session_accountability(
  p_session_id       uuid,
  p_provider_id      uuid,
  p_provider_country text,
  p_bytes_used       bigint,
  p_target_host      text default null
) returns void as $$
begin
  insert into session_accountability (
    session_id, requester_id, provider_id, provider_country,
    bytes_used, target_host, signed_receipt, started_at, ended_at
  )
  select
    s.id,
    s.user_id,
    coalesce(p_provider_id,      s.provider_id),
    coalesce(p_provider_country, s.target_country),
    greatest(coalesce(p_bytes_used, 0), coalesce(s.bytes_used, 0)),
    coalesce(p_target_host,      s.target_host),
    coalesce(s.signed_receipt, ''),
    s.started_at,
    now()
  from sessions s
  where s.id = p_session_id
  on conflict (session_id) do update set
    provider_id      = coalesce(excluded.provider_id,      session_accountability.provider_id),
    provider_country = coalesce(excluded.provider_country, session_accountability.provider_country),
    target_host      = coalesce(excluded.target_host,      session_accountability.target_host),
    bytes_used       = greatest(excluded.bytes_used,       session_accountability.bytes_used),
    ended_at         = now();
end;
$$ language plpgsql security definer;

commit;
