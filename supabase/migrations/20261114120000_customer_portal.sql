-- Customer self-service portal.
-- Operators: joeamilam@gmail.com, heath@isomelectric.com.
-- Customers read only their own rows. Coverage changes go through
-- private.apply_customer_coverage, called by the Netlify service role.
-- Brenden's login is created with the default password Dockafi1234.
-- Portal mail is stored in email_drafts. Nothing is sent automatically.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Profile link + coverage schedule columns
-- ---------------------------------------------------------------------------

alter table public.end_users
  add column if not exists auth_user_id uuid unique references auth.users (id) on delete set null,
  add column if not exists portal_invited_at timestamptz,
  add column if not exists portal_activated_at timestamptz,
  add column if not exists must_change_password boolean not null default false;

alter table public.subscriptions
  add column if not exists suspended_at timestamptz,
  add column if not exists auto_cancel_on date,
  add column if not exists cancelled_at timestamptz,
  add column if not exists warning_30_sent_on date,
  add column if not exists warning_7_sent_on date,
  add column if not exists warning_1_sent_on date;

alter table public.service_requests drop constraint if exists service_requests_request_type_check;
alter table public.service_requests add constraint service_requests_request_type_check
  check (request_type = any (array['suspend'::text, 'cancel'::text, 'reactivate'::text, 'auto_cancel'::text]));

create index if not exists idx_end_users_auth_user on public.end_users (auth_user_id);
create index if not exists idx_subscriptions_auto_cancel
  on public.subscriptions (status, auto_cancel_on)
  where status = 'suspended';

-- ---------------------------------------------------------------------------
-- Roles. Authorization lives here, not in user-editable user_metadata.
-- ---------------------------------------------------------------------------

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role = any (array['admin'::text, 'customer'::text])),
  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

revoke all on table public.user_roles from public, anon, authenticated;
grant select on table public.user_roles to authenticated;
grant select, insert, update, delete on table public.user_roles to service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to authenticated, service_role;

drop policy if exists user_roles_select on public.user_roles;
create policy user_roles_select on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or private.is_admin());

-- Seed operators before the blanket authenticated policies are replaced.
insert into public.user_roles (user_id, role)
select id, 'admin'
from auth.users
where lower(email) in ('joeamilam@gmail.com', 'heath@isomelectric.com')
on conflict (user_id) do update set role = 'admin';

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'admin')
where lower(email) in ('joeamilam@gmail.com', 'heath@isomelectric.com');

-- ---------------------------------------------------------------------------
-- Close public Auth signup. Invites set app_metadata.role before insert.
-- Allowlisted operator emails can still be recreated from the dashboard.
-- ---------------------------------------------------------------------------

create or replace function private.reject_public_signup()
returns trigger
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  meta_role text := coalesce(new.raw_app_meta_data->>'role', '');
begin
  if meta_role in ('admin', 'customer') then
    return new;
  end if;
  if lower(coalesce(new.email, '')) in ('joeamilam@gmail.com', 'heath@isomelectric.com') then
    return new;
  end if;
  raise exception 'Public signup is disabled'
    using errcode = '42501';
end;
$$;

revoke all on function private.reject_public_signup() from public;

drop trigger if exists reject_public_signup on auth.users;
create trigger reject_public_signup
  before insert on auth.users
  for each row execute function private.reject_public_signup();

-- ---------------------------------------------------------------------------
-- Replace authenticated ALL with operator-only, then customer read policies.
-- Partner checkout keeps anon INSERT on orders_queue.
-- ---------------------------------------------------------------------------

do $policies$
declare
  t text;
begin
  foreach t in array array[
    'device_assignments', 'device_enduser', 'devices', 'end_users', 'invoices',
    'orders_queue', 'organizations', 'service_requests', 'sim_cards',
    'subscriptions', 'support_tickets'
  ]
  loop
    execute format('drop policy if exists "Authenticated full access" on public.%I', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I for all to authenticated using (private.is_admin()) with check (private.is_admin())',
      t
    );
  end loop;
end
$policies$;

drop policy if exists "Anon can match device_enduser" on public.device_enduser;
drop policy if exists "Anon can match devices" on public.devices;
drop policy if exists "Anon can match endusers" on public.end_users;
drop policy if exists "Anon read and write access" on public.sim_cards;
drop policy if exists "Anon full access" on public.subscriptions;
drop policy if exists "Allow all inserts" on public.service_requests;

drop policy if exists customer_read_own_end_user on public.end_users;
create policy customer_read_own_end_user on public.end_users
  for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists customer_read_own_link on public.device_enduser;
create policy customer_read_own_link on public.device_enduser
  for select to authenticated
  using (
    exists (
      select 1 from public.end_users eu
      where eu.id = device_enduser.end_user_id
        and eu.auth_user_id = auth.uid()
    )
  );

drop policy if exists customer_read_own_device on public.devices;
create policy customer_read_own_device on public.devices
  for select to authenticated
  using (
    exists (
      select 1
      from public.device_enduser de
      join public.end_users eu on eu.id = de.end_user_id
      where de.device_id = devices.id
        and eu.auth_user_id = auth.uid()
    )
  );

drop policy if exists customer_read_own_subscription on public.subscriptions;
create policy customer_read_own_subscription on public.subscriptions
  for select to authenticated
  using (
    exists (
      select 1
      from public.device_enduser de
      join public.end_users eu on eu.id = de.end_user_id
      where de.id = subscriptions.device_enduser_id
        and eu.auth_user_id = auth.uid()
    )
  );

-- The anon key is in the SPA. Take away table privileges that RLS used to
-- leave open. orders_queue INSERT stays so partner checkout can still post.
revoke all on table public.devices from anon;
revoke all on table public.end_users from anon;
revoke all on table public.device_enduser from anon;
revoke all on table public.sim_cards from anon;
revoke all on table public.subscriptions from anon;
revoke all on table public.service_requests from anon;
revoke all on table public.organizations from anon;
revoke all on table public.invoices from anon;
revoke all on table public.support_tickets from anon;
revoke all on table public.device_assignments from anon;
revoke all on table public.orders_queue from anon;
grant insert on table public.orders_queue to anon;

-- ---------------------------------------------------------------------------
-- Email drafts. Nothing is sent until an operator marks it sent.
-- ---------------------------------------------------------------------------

create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  from_address text not null default 'aquaease.creations@gmail.com',
  to_email text not null,
  subject text not null,
  body_text text not null,
  kind text not null check (kind = any (array[
    'welcome'::text, 'password_reset'::text, 'tello_change'::text,
    'warning'::text, 'auto_cancel'::text, 'customer_notice'::text
  ])),
  end_user_id uuid references public.end_users (id) on delete set null,
  device_id uuid references public.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'draft' check (status = any (array['draft'::text, 'sent'::text, 'discarded'::text])),
  sent_at timestamptz,
  sent_by text
);

alter table public.email_drafts enable row level security;

revoke all on table public.email_drafts from public, anon, authenticated;
grant select, update on table public.email_drafts to authenticated;
grant select, insert, update, delete on table public.email_drafts to service_role;

drop policy if exists admin_read_drafts on public.email_drafts;
create policy admin_read_drafts on public.email_drafts
  for select to authenticated
  using (private.is_admin());

drop policy if exists admin_update_drafts on public.email_drafts;
create policy admin_update_drafts on public.email_drafts
  for update to authenticated
  using (private.is_admin())
  with check (private.is_admin());

create index if not exists email_drafts_status on public.email_drafts (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Coverage changes. security definer, executable by service_role only.
-- ---------------------------------------------------------------------------

create or replace function private.lookup_auth_email(p_email text)
returns table(id uuid, role text, email text)
language sql
stable
security definer
set search_path = auth, public
as $$
  select u.id,
         coalesce(u.raw_app_meta_data->>'role', ''),
         u.email
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;
$$;

create or replace function private.apply_customer_coverage(
  p_auth_user uuid,
  p_device uuid,
  p_action text,
  p_admin_email text,
  p_portal_url text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eu public.end_users%rowtype;
  v_link public.device_enduser%rowtype;
  v_sub public.subscriptions%rowtype;
  v_device public.devices%rowtype;
  v_sim public.sim_cards%rowtype;
  v_today date := (timezone('America/New_York', now()))::date;
  v_deadline date;
  v_now timestamptz := now();
  v_ref text;
  v_coverage text;
  v_tello text;
  v_draft uuid;
  v_body text;
  v_subject text;
  v_admin text := coalesce(nullif(trim(p_admin_email), ''), 'joeamilam@gmail.com');
begin
  if p_auth_user is null or p_device is null then
    raise exception 'Missing account or device';
  end if;
  if p_action not in ('suspend', 'reactivate', 'cancel') then
    raise exception 'Unknown action';
  end if;

  select * into v_eu from public.end_users where auth_user_id = p_auth_user;
  if not found then
    raise exception 'No customer profile is linked to this login';
  end if;

  select * into v_link
  from public.device_enduser
  where device_id = p_device
    and end_user_id = v_eu.id
    and status in ('active', 'suspended')
  order by case status when 'active' then 0 else 1 end, activated_at desc nulls last
  limit 1;
  if not found then
    if exists (
      select 1 from public.device_enduser
      where device_id = p_device and end_user_id = v_eu.id and status = 'cancelled'
    ) then
      raise exception 'This service is canceled. Restarting requires a new SIM card.';
    end if;
    raise exception 'That device is not on your account';
  end if;

  select * into v_device from public.devices where id = p_device;
  select * into v_sim from public.sim_cards where device_id = p_device limit 1;

  select * into v_sub
  from public.subscriptions
  where device_enduser_id = v_link.id
  order by case status when 'active' then 0 when 'suspended' then 1 else 2 end, created_at desc
  limit 1;

  if v_sub.id is null then
    insert into public.subscriptions (device_enduser_id, plan_name, status, next_billing_date)
    values (
      v_link.id,
      coalesce(v_sim.data_plan, '50 GB Monthly'),
      'active',
      (v_today + interval '1 month')::date
    )
    returning * into v_sub;
  end if;

  if p_action = 'suspend' and v_link.status = 'suspended' and v_sub.status = 'suspended' then
    return jsonb_build_object(
      'ok', true,
      'unchanged', true,
      'coverage', 'suspended',
      'auto_cancel_on', v_sub.auto_cancel_on,
      'device_id', p_device
    );
  end if;

  if p_action = 'reactivate' and v_link.status = 'active' and v_sub.status = 'active' then
    return jsonb_build_object(
      'ok', true,
      'unchanged', true,
      'coverage', 'active',
      'device_id', p_device
    );
  end if;

  if p_action = 'reactivate' and (v_link.status = 'cancelled' or v_sub.status = 'cancelled') then
    raise exception 'This service is canceled. Restarting requires a new SIM card.';
  end if;

  v_deadline := (v_today + interval '6 months')::date;

  if p_action = 'suspend' then
    update public.subscriptions
      set status = 'suspended',
          suspended_at = v_now,
          auto_cancel_on = v_deadline,
          cancelled_at = null,
          next_billing_date = null,
          warning_30_sent_on = null,
          warning_7_sent_on = null,
          warning_1_sent_on = null
      where id = v_sub.id;
    update public.device_enduser set status = 'suspended' where id = v_link.id;
    update public.devices set status = 'suspended' where id = p_device;
    if v_sim.id is not null and v_sim.status is distinct from 'deactivated' then
      update public.sim_cards set status = 'suspended' where id = v_sim.id;
    end if;
    v_coverage := 'suspended';
    v_tello := 'pause';
  elsif p_action = 'reactivate' then
    if exists (
      select 1 from public.device_enduser
      where device_id = p_device and status = 'active' and id <> v_link.id
    ) then
      raise exception 'Another active customer is already linked to this device';
    end if;
    update public.subscriptions
      set status = 'active',
          suspended_at = null,
          auto_cancel_on = null,
          cancelled_at = null,
          next_billing_date = (v_today + interval '1 month')::date,
          warning_30_sent_on = null,
          warning_7_sent_on = null,
          warning_1_sent_on = null
      where id = v_sub.id;
    update public.device_enduser set status = 'active', deactivated_at = null where id = v_link.id;
    update public.devices set status = 'active' where id = p_device;
    if v_sim.id is not null then
      update public.sim_cards set status = 'active' where id = v_sim.id;
    end if;
    v_coverage := 'active';
    v_tello := 'restore';
    v_deadline := null;
  else
    update public.subscriptions
      set status = 'cancelled',
          cancelled_at = v_now,
          auto_cancel_on = null,
          next_billing_date = null
      where id = v_sub.id;
    update public.device_enduser
      set status = 'cancelled', deactivated_at = v_now
      where id = v_link.id;
    update public.devices set status = 'inactive' where id = p_device;
    if v_sim.id is not null then
      update public.sim_cards set status = 'deactivated' where id = v_sim.id;
    end if;
    v_coverage := 'cancelled';
    v_tello := 'deactivate';
    v_deadline := null;
  end if;

  v_ref := 'PTL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.service_requests (
    reference, request_type, status, submitted_name, submitted_email, submitted_imei_last5,
    detail, notes, device_id, end_user_id, reseller_org_id
  ) values (
    v_ref,
    case p_action when 'suspend' then 'suspend' when 'reactivate' then 'reactivate' else 'cancel' end,
    'new',
    trim(v_eu.first_name || ' ' || v_eu.last_name),
    v_eu.email,
    right(v_device.imei, 5),
    'Platform status is already ' || v_coverage || '. Tello: ' || v_tello ||
      ' SIM. ICCID ' || coalesce(v_sim.iccid, 'none') || '. IMEI ' || v_device.imei ||
      case when v_deadline is null then '.' else '. Auto-cancel ' || v_deadline::text || '.' end,
    'Platform status already updated. Make the matching change in Tello (tello.com/account), then mark this request actioned.',
    p_device,
    v_eu.id,
    v_eu.reseller_org_id
  );

  v_subject := 'DockaFi Tello change: ' || p_action || ' ' || trim(v_eu.first_name || ' ' || v_eu.last_name);
  v_body :=
    'A customer changed coverage in the DockaFi portal. The platform status is already updated.' || E'\n\n' ||
    'Action: ' || upper(p_action) || E'\n' ||
    'Tello: ' || v_tello || ' this SIM at tello.com/account' || E'\n' ||
    'Customer: ' || trim(v_eu.first_name || ' ' || v_eu.last_name) || ' <' || v_eu.email || '>' || E'\n' ||
    'IMEI: ' || v_device.imei || E'\n' ||
    'ICCID: ' || coalesce(v_sim.iccid, 'none') || E'\n' ||
    'Data plan: ' || coalesce(v_sim.data_plan, v_sub.plan_name, '50 GB Monthly') || E'\n' ||
    'Coverage now: ' || v_coverage || E'\n' ||
    case when v_deadline is null then '' else 'Auto-cancel date: ' || v_deadline::text || E'\n' end ||
    'Request: ' || v_ref || E'\n\n' ||
    'Suspend pauses billing until they reactivate. They must reactivate within 6 months or the line is canceled.' || E'\n' ||
    'Cancel means a new SIM card has to be shipped before service can start again.';

  insert into public.email_drafts (from_address, to_email, subject, body_text, kind, end_user_id, device_id)
  values ('aquaease.creations@gmail.com', v_admin, v_subject, v_body, 'tello_change', v_eu.id, p_device)
  returning id into v_draft;

  return jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'coverage', v_coverage,
    'auto_cancel_on', v_deadline,
    'reference', v_ref,
    'device_id', p_device,
    'draft_id', v_draft
  );
end;
$$;

create or replace function private.customer_portal_snapshot(p_auth_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eu public.end_users%rowtype;
  v_today date := (timezone('America/New_York', now()))::date;
  v_devices jsonb;
begin
  if p_auth_user is null then
    return null;
  end if;
  select * into v_eu from public.end_users where auth_user_id = p_auth_user;
  if not found then
    return null;
  end if;

  if v_eu.portal_activated_at is null then
    update public.end_users set portal_activated_at = now() where id = v_eu.id;
  end if;

  select coalesce(jsonb_agg(item order by sort_key, imei), '[]'::jsonb)
    into v_devices
  from (
    select
      case de.status when 'active' then 0 when 'suspended' then 1 else 2 end as sort_key,
      d.imei,
      jsonb_build_object(
        'device_id', d.id,
        'imei', d.imei,
        'data_plan', coalesce(sim.data_plan, sub.plan_name, '50 GB Monthly'),
        'coverage', coalesce(sub.status, de.status),
        'auto_cancel_on', sub.auto_cancel_on
      ) as item
    from public.device_enduser de
    join public.devices d on d.id = de.device_id
    left join lateral (
      select s.status, s.plan_name, s.auto_cancel_on
      from public.subscriptions s
      where s.device_enduser_id = de.id
      order by case s.status when 'active' then 0 when 'suspended' then 1 else 2 end, s.created_at desc
      limit 1
    ) sub on true
    left join public.sim_cards sim on sim.device_id = d.id
    where de.end_user_id = v_eu.id
      and (
        de.status in ('active', 'suspended')
        or (
          de.id = (
            select de2.id
            from public.device_enduser de2
            where de2.end_user_id = v_eu.id
              and de2.status = 'cancelled'
            order by de2.deactivated_at desc nulls last, de2.activated_at desc nulls last
            limit 1
          )
          and not exists (
            select 1 from public.device_enduser x
            where x.end_user_id = v_eu.id
              and x.status in ('active', 'suspended')
          )
        )
      )
  ) rows;

  return jsonb_build_object(
    'first_name', v_eu.first_name,
    'last_name', v_eu.last_name,
    'email', v_eu.email,
    'phone', v_eu.phone,
    'must_change_password', v_eu.must_change_password,
    'preview_auto_cancel_on', (v_today + interval '6 months')::date,
    'devices', v_devices
  );
end;
$$;

create or replace function private.run_coverage_schedule(
  p_admin_email text,
  p_portal_url text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('America/New_York', now()))::date;
  v_admin text := coalesce(nullif(trim(p_admin_email), ''), 'joeamilam@gmail.com');
  v_portal text := coalesce(nullif(trim(p_portal_url), ''), 'https://dockafiplatform.netlify.app/?portal=1');
  v_row record;
  v_days integer;
  v_slot integer;
  v_flag date;
  v_warnings integer := 0;
  v_cancels integer := 0;
  v_ref text;
  v_name text;
begin
  for v_row in
    select
      s.id as subscription_id,
      s.auto_cancel_on,
      s.warning_30_sent_on,
      s.warning_7_sent_on,
      s.warning_1_sent_on,
      s.device_enduser_id,
      de.device_id,
      de.end_user_id,
      eu.first_name,
      eu.last_name,
      eu.email,
      eu.reseller_org_id,
      d.imei,
      sim.iccid,
      sim.id as sim_id,
      coalesce(sim.data_plan, s.plan_name, '50 GB Monthly') as data_plan
    from public.subscriptions s
    join public.device_enduser de on de.id = s.device_enduser_id
    join public.end_users eu on eu.id = de.end_user_id
    join public.devices d on d.id = de.device_id
    left join public.sim_cards sim on sim.device_id = d.id
    where s.status = 'suspended'
      and s.auto_cancel_on is not null
  loop
    v_days := v_row.auto_cancel_on - v_today;
    v_name := trim(v_row.first_name || ' ' || v_row.last_name);

    if v_days <= 0 then
      update public.subscriptions
        set status = 'cancelled',
            cancelled_at = now(),
            next_billing_date = null,
            auto_cancel_on = null
        where id = v_row.subscription_id
          and status = 'suspended';
      if not found then
        continue;
      end if;
      update public.device_enduser
        set status = 'cancelled', deactivated_at = now()
        where id = v_row.device_enduser_id;
      update public.devices set status = 'inactive' where id = v_row.device_id;
      if v_row.sim_id is not null then
        update public.sim_cards set status = 'deactivated' where id = v_row.sim_id;
      end if;

      v_ref := 'PTL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      insert into public.service_requests (
        reference, request_type, status, submitted_name, submitted_email, submitted_imei_last5,
        detail, notes, device_id, end_user_id, reseller_org_id
      ) values (
        v_ref,
        'auto_cancel',
        'new',
        v_name,
        v_row.email,
        right(v_row.imei, 5),
        'Platform auto-canceled this suspended line. Tello: deactivate SIM. ICCID ' ||
          coalesce(v_row.iccid, 'none') || '. IMEI ' || v_row.imei || '.',
        'Platform status already updated. Deactivate the SIM in Tello (tello.com/account), then mark this request actioned.',
        v_row.device_id,
        v_row.end_user_id,
        v_row.reseller_org_id
      );

      insert into public.email_drafts (from_address, to_email, subject, body_text, kind, end_user_id, device_id)
      values (
        'aquaease.creations@gmail.com',
        v_admin,
        'DockaFi auto-cancel: deactivate Tello SIM for ' || v_name,
        'Suspended coverage reached the 6-month limit and was canceled in the platform.' || E'\n\n' ||
          'Tello: deactivate this SIM at tello.com/account' || E'\n' ||
          'Customer: ' || v_name || ' <' || v_row.email || '>' || E'\n' ||
          'IMEI: ' || v_row.imei || E'\n' ||
          'ICCID: ' || coalesce(v_row.iccid, 'none') || E'\n' ||
          'Data plan: ' || v_row.data_plan || E'\n' ||
          'Request: ' || v_ref || E'\n\n' ||
          'Restarting later requires a new SIM card shipped to the customer.',
        'auto_cancel',
        v_row.end_user_id,
        v_row.device_id
      );
      insert into public.email_drafts (from_address, to_email, subject, body_text, kind, end_user_id, device_id)
      values (
        'aquaease.creations@gmail.com',
        v_row.email,
        'Your DockaFi coverage was canceled',
        'Your DockaFi coverage was canceled because it stayed suspended through ' ||
          to_char(v_row.auto_cancel_on, 'FMMonth FMDD, YYYY') || '.' || E'\n\n' ||
          'You were not billed while it was suspended. Restarting service requires a new SIM card shipped to you. The current SIM cannot be reused.' || E'\n\n' ||
          'Sign in: ' || v_portal,
        'customer_notice',
        v_row.end_user_id,
        v_row.device_id
      );
      v_cancels := v_cancels + 1;
      continue;
    end if;

    v_slot := null;
    v_flag := null;
    if v_days <= 1 then
      if v_row.warning_1_sent_on is null then v_slot := 1; end if;
    elsif v_days <= 7 then
      if v_row.warning_7_sent_on is null then v_slot := 7; end if;
    elsif v_days <= 30 then
      if v_row.warning_30_sent_on is null then v_slot := 30; end if;
    end if;

    if v_slot is null then
      continue;
    end if;

    insert into public.email_drafts (from_address, to_email, subject, body_text, kind, end_user_id, device_id)
    values (
      'aquaease.creations@gmail.com',
      v_row.email,
      'DockaFi coverage cancels on ' || to_char(v_row.auto_cancel_on, 'FMMonth FMDD, YYYY'),
      'Your DockaFi coverage is suspended and is set to cancel on ' ||
        to_char(v_row.auto_cancel_on, 'FMMonth FMDD, YYYY') || '.' || E'\n\n' ||
        'You will not be billed while it is suspended. Reactivate within 6 months or the device will be canceled. ' ||
        'After that cancellation, a new SIM card must be shipped to restart service.' || E'\n\n' ||
        'Sign in: ' || v_portal || E'\n\n' ||
        'This reminder is ' || v_slot || ' day' || case when v_slot = 1 then '' else 's' end || ' ahead of that date.',
      'warning',
      v_row.end_user_id,
      v_row.device_id
    );

    if v_slot = 30 then
      update public.subscriptions set warning_30_sent_on = v_today where id = v_row.subscription_id;
    elsif v_slot = 7 then
      update public.subscriptions set warning_7_sent_on = v_today where id = v_row.subscription_id;
    else
      update public.subscriptions set warning_1_sent_on = v_today where id = v_row.subscription_id;
    end if;
    v_warnings := v_warnings + 1;
  end loop;

  return jsonb_build_object('ok', true, 'warnings', v_warnings, 'cancellations', v_cancels);
end;
$$;

revoke all on function private.lookup_auth_email(text) from public;
revoke all on function private.apply_customer_coverage(uuid, uuid, text, text, text) from public;
revoke all on function private.customer_portal_snapshot(uuid) from public;
revoke all on function private.run_coverage_schedule(text, text) from public;
grant execute on function private.lookup_auth_email(text) to service_role;
grant execute on function private.apply_customer_coverage(uuid, uuid, text, text, text) to service_role;
grant execute on function private.customer_portal_snapshot(uuid) to service_role;
grant execute on function private.run_coverage_schedule(text, text) to service_role;

-- PostgREST exposes public only. Wrappers are invoker functions granted to service_role.
create or replace function public.lookup_auth_email(p_email text)
returns table(id uuid, role text, email text)
language sql
security invoker
set search_path = public
as $$
  select * from private.lookup_auth_email(p_email);
$$;

create or replace function public.apply_customer_coverage(
  p_auth_user uuid,
  p_device uuid,
  p_action text,
  p_admin_email text default 'joeamilam@gmail.com',
  p_portal_url text default 'https://dockafiplatform.netlify.app/?portal=1'
) returns jsonb
language sql
security invoker
set search_path = public
as $$
  select private.apply_customer_coverage(p_auth_user, p_device, p_action, p_admin_email, p_portal_url);
$$;

create or replace function public.customer_portal_snapshot(p_auth_user uuid)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select private.customer_portal_snapshot(p_auth_user);
$$;

create or replace function public.run_coverage_schedule(
  p_admin_email text default 'joeamilam@gmail.com',
  p_portal_url text default 'https://dockafiplatform.netlify.app/?portal=1'
) returns jsonb
language sql
security invoker
set search_path = public
as $$
  select private.run_coverage_schedule(p_admin_email, p_portal_url);
$$;

revoke all on function public.lookup_auth_email(text) from public, anon, authenticated;
revoke all on function public.apply_customer_coverage(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.customer_portal_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.run_coverage_schedule(text, text) from public, anon, authenticated;
grant execute on function public.lookup_auth_email(text) to service_role;
grant execute on function public.apply_customer_coverage(uuid, uuid, text, text, text) to service_role;
grant execute on function public.customer_portal_snapshot(uuid) to service_role;
grant execute on function public.run_coverage_schedule(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Brenden Milstead. Auth login uses the default password Dockafi1234.
-- Craig Isom's cancelled device_enduser rows stay as history.
-- A welcome draft is saved. Nothing is emailed.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

insert into public.end_users (first_name, last_name, email, status)
select 'Brenden', 'Milstead', 'brendenmilstead@yahoo.com', 'active'
where exists (
  select 1 from public.devices where id = '9b5f038d-009f-4d49-a976-d5422621fef9'
)
and not exists (
  select 1 from public.end_users where lower(email) = 'brendenmilstead@yahoo.com'
);

insert into public.device_enduser (device_id, end_user_id, status, activated_at, notes)
select
  '9b5f038d-009f-4d49-a976-d5422621fef9',
  eu.id,
  'active',
  now(),
  'Customer portal seed. Previous cancelled links kept as history.'
from public.end_users eu
where lower(eu.email) = 'brendenmilstead@yahoo.com'
  and exists (
    select 1 from public.devices where id = '9b5f038d-009f-4d49-a976-d5422621fef9'
  )
  and not exists (
    select 1 from public.device_enduser de
    where de.device_id = '9b5f038d-009f-4d49-a976-d5422621fef9'
      and de.status = 'active'
  );

insert into public.subscriptions (device_enduser_id, plan_name, status, next_billing_date)
select
  de.id,
  coalesce((
    select sim.data_plan from public.sim_cards sim
    where sim.device_id = de.device_id
    limit 1
  ), '50 GB Monthly'),
  'active',
  ((timezone('America/New_York', now()))::date + interval '1 month')::date
from public.device_enduser de
join public.end_users eu on eu.id = de.end_user_id
where de.device_id = '9b5f038d-009f-4d49-a976-d5422621fef9'
  and de.status = 'active'
  and lower(eu.email) = 'brendenmilstead@yahoo.com'
  and not exists (
    select 1 from public.subscriptions s where s.device_enduser_id = de.id
  );

do $brenden$
declare
  v_user uuid;
  v_eu uuid;
  v_device uuid := '9b5f038d-009f-4d49-a976-d5422621fef9';
begin
  if not exists (select 1 from public.devices where id = v_device) then
    return;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password'
  ) then
    return;
  end if;

  perform set_config('search_path', 'public, extensions', true);

  select id into v_eu from public.end_users where lower(email) = 'brendenmilstead@yahoo.com';
  select id into v_user from auth.users where lower(email) = 'brendenmilstead@yahoo.com';

  if v_user is null then
    v_user := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user,
      'authenticated',
      'authenticated',
      'brendenmilstead@yahoo.com',
      crypt('Dockafi1234', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"],"role":"customer"}'::jsonb,
      '{"first_name":"Brenden","last_name":"Milstead"}'::jsonb,
      now(),
      now(),
      '',
      '',
      '',
      '',
      false,
      false
    );
    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider, created_at, updated_at
    ) values (
      gen_random_uuid(),
      v_user::text,
      v_user,
      jsonb_build_object('sub', v_user::text, 'email', 'brendenmilstead@yahoo.com'),
      'email',
      now(),
      now()
    );
  end if;

  update public.end_users
    set auth_user_id = v_user,
        must_change_password = true,
        portal_invited_at = coalesce(portal_invited_at, now())
    where id = v_eu;

  insert into public.user_roles (user_id, role)
  values (v_user, 'customer')
  on conflict (user_id) do update set role = 'customer';

  if not exists (
    select 1 from public.email_drafts
    where kind = 'welcome' and lower(to_email) = 'brendenmilstead@yahoo.com'
  ) then
    insert into public.email_drafts (from_address, to_email, subject, body_text, kind, end_user_id, device_id)
    values (
      'aquaease.creations@gmail.com',
      'brendenmilstead@yahoo.com',
      'Your DockaFi customer portal login',
      'Hi Brenden,' || E'\n\n' ||
        'Your DockaFi customer portal login is ready.' || E'\n\n' ||
        'Sign in: https://dockafiplatform.netlify.app/?portal=1' || E'\n' ||
        'Email: brendenmilstead@yahoo.com' || E'\n' ||
        'Temporary password: Dockafi1234' || E'\n\n' ||
        'Please change this password after you sign in. You can keep using the portal if you wait, and the page will keep reminding you until you do.',
      'welcome',
      v_eu,
      v_device
    );
  end if;
end
$brenden$;

notify pgrst, 'reload schema';
