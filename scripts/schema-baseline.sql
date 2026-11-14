-- Minimal copy of the ops tables the customer-portal migration alters.
-- Used only by scripts/portal-rls-test.js. Not applied to production.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'reseller',
  notes text
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  serial_number text not null unique,
  imei text not null unique,
  imei_last5 text generated always as (right(imei, 5)) stored,
  status text not null default 'unassigned'
    check (status = any (array['unassigned','assigned','active','suspended','inactive'])),
  notes text,
  reseller_org_id uuid,
  created_at timestamptz default now()
);

create table public.sim_cards (
  id uuid primary key default gen_random_uuid(),
  iccid text not null unique,
  status text not null default 'unactivated'
    check (status = any (array['unactivated','active','suspended','deactivated'])),
  device_id uuid unique references public.devices (id),
  data_plan text,
  activation_code text,
  carrier text
);

create table public.end_users (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text not null,
  email_normalized text generated always as (lower(trim(both from email))) stored,
  phone text,
  status text not null default 'active'
    check (status = any (array['active','suspended','cancelled'])),
  reseller_org_id uuid,
  created_at timestamptz default now()
);

create table public.device_enduser (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id),
  end_user_id uuid not null references public.end_users (id),
  assigned_by_org_id uuid,
  status text not null default 'active'
    check (status = any (array['active','suspended','cancelled'])),
  activated_at timestamptz default now(),
  deactivated_at timestamptz,
  notes text
);

create unique index idx_device_enduser_active
  on public.device_enduser (device_id) where status = 'active';

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  device_enduser_id uuid not null references public.device_enduser (id),
  plan_name text default 'Standard Broadband',
  monthly_amount numeric default 60,
  billing_cycle text default 'monthly',
  status text not null default 'active'
    check (status = any (array['active','suspended','cancelled'])),
  next_billing_date date,
  created_at timestamptz default now()
);

create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  request_type text not null check (request_type = any (array['suspend','cancel'])),
  status text not null default 'new'
    check (status = any (array['new','pending','actioned','rejected'])),
  submitted_name text not null,
  submitted_email text not null,
  submitted_imei_last5 text not null,
  detail text,
  notes text,
  device_id uuid,
  end_user_id uuid,
  reseller_org_id uuid,
  actioned_by text,
  actioned_at timestamptz,
  created_at timestamptz default now()
);

create table public.orders_queue (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_email text not null,
  status text not null default 'pending_shipment'
);

create table public.invoices (
  id uuid primary key default gen_random_uuid()
);

create table public.support_tickets (
  id uuid primary key default gen_random_uuid()
);

create table public.device_assignments (
  id uuid primary key default gen_random_uuid()
);

grant all on all tables in schema public to anon, authenticated, service_role;

alter table public.devices enable row level security;
alter table public.end_users enable row level security;
alter table public.device_enduser enable row level security;
alter table public.sim_cards enable row level security;
alter table public.subscriptions enable row level security;
alter table public.service_requests enable row level security;
alter table public.orders_queue enable row level security;
alter table public.organizations enable row level security;
alter table public.invoices enable row level security;
alter table public.support_tickets enable row level security;
alter table public.device_assignments enable row level security;

create policy "Authenticated full access" on public.devices for all to authenticated using (true) with check (true);
create policy "Anon can match devices" on public.devices for select to anon, authenticated using (true);
create policy "Authenticated full access" on public.end_users for all to authenticated using (true) with check (true);
create policy "Anon can match endusers" on public.end_users for select to anon, authenticated using (true);
create policy "Authenticated full access" on public.device_enduser for all to authenticated using (true) with check (true);
create policy "Anon can match device_enduser" on public.device_enduser for select to anon, authenticated using (true);
create policy "Authenticated full access" on public.sim_cards for all to authenticated using (true) with check (true);
create policy "Anon read and write access" on public.sim_cards for all to anon using (true) with check (true);
create policy "Authenticated full access" on public.subscriptions for all to authenticated using (true) with check (true);
create policy "Anon full access" on public.subscriptions for all to anon using (true) with check (true);
create policy "Authenticated full access" on public.service_requests for all to authenticated using (true) with check (true);
create policy "Allow all inserts" on public.service_requests for insert to anon, authenticated with check (true);
create policy "Authenticated full access" on public.orders_queue for all to authenticated using (true) with check (true);
create policy "Allow all inserts" on public.orders_queue for insert to anon, authenticated with check (true);
create policy "Authenticated full access" on public.organizations for all to authenticated using (true) with check (true);
create policy "Authenticated full access" on public.invoices for all to authenticated using (true) with check (true);
create policy "Authenticated full access" on public.support_tickets for all to authenticated using (true) with check (true);
create policy "Authenticated full access" on public.device_assignments for all to authenticated using (true) with check (true);
