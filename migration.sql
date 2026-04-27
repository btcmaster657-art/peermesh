alter table profiles add column if not exists payout_country_code text;
alter table profiles add column if not exists payout_bank_code text;
alter table profiles add column if not exists payout_bank_name text;
alter table profiles add column if not exists payout_account_number text;
alter table profiles add column if not exists payout_account_name text;
alter table profiles add column if not exists payout_beneficiary_name text;
alter table profiles add column if not exists payout_branch_code text;
