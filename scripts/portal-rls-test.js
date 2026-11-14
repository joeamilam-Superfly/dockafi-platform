'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Client } = require('pg');

const root = path.join(__dirname, '..');

async function adminClient() {
  const client = new Client({ host: '/var/run/postgresql', user: 'postgres', database: 'postgres' });
  await client.connect();
  return client;
}

async function connectTest() {
  const client = new Client({ host: '/var/run/postgresql', user: 'postgres', database: 'dockafi_portal_test' });
  await client.connect();
  return client;
}

async function q(client, sql, params) {
  return client.query(sql, params);
}

async function asRole(client, role, userId, fn, commit) {
  await q(client, 'begin');
  try {
    if (userId) await q(client, `select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await q(client, 'set local role ' + role);
    const result = await fn();
    await q(client, commit ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    try { await q(client, 'rollback'); } catch (e) { /* already closed */ }
    throw err;
  }
}

async function main() {
  const setup = await adminClient();
  await setup.query('drop database if exists dockafi_portal_test');
  await setup.query('create database dockafi_portal_test');
  await setup.end();

  const db = await connectTest();
  await db.query(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      invited_at timestamptz,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    do $$ begin
      create role anon nologin;
    exception when duplicate_object then null; end $$;
    do $$ begin
      create role authenticated nologin;
    exception when duplicate_object then null; end $$;
    do $$ begin
      create role service_role nologin bypassrls;
    exception when duplicate_object then null; end $$;
  `);
  await db.query(fs.readFileSync(path.join(root, 'scripts/schema-baseline.sql'), 'utf8'));

  const joe = (await db.query(
    `insert into auth.users (email) values ('joeamilam@gmail.com') returning id`
  )).rows[0].id;
  const heath = (await db.query(
    `insert into auth.users (email) values ('heath@isomelectric.com') returning id`
  )).rows[0].id;

  await db.query(fs.readFileSync(path.join(root, 'supabase/migrations/20261114120000_customer_portal.sql'), 'utf8'));

  const customerA = (await db.query(
    `insert into auth.users (email, raw_app_meta_data)
     values ('ada@example.com', '{"role":"customer"}'::jsonb) returning id`
  )).rows[0].id;
  const customerB = (await db.query(
    `insert into auth.users (email, raw_app_meta_data)
     values ('bea@example.com', '{"role":"customer"}'::jsonb) returning id`
  )).rows[0].id;

  let blocked = false;
  try {
    await db.query(`insert into auth.users (email) values ('stranger@example.com')`);
  } catch (err) {
    blocked = /Public signup is disabled/.test(err.message);
  }
  assert.strictEqual(blocked, true, 'public signup should be rejected');

  const deviceA = (await db.query(
    `insert into devices (serial_number, imei, status) values ('DKF-A', '111111111111111', 'active') returning id`
  )).rows[0].id;
  const deviceB = (await db.query(
    `insert into devices (serial_number, imei, status) values ('DKF-B', '222222222222222', 'active') returning id`
  )).rows[0].id;
  await db.query(
    `insert into sim_cards (iccid, status, device_id, data_plan, activation_code)
     values ('8901A', 'active', $1, '50 GB Monthly', 'SECRET-CODE')`,
    [deviceA]
  );
  const userA = (await db.query(
    `insert into end_users (first_name, last_name, email, auth_user_id)
     values ('Ada', 'Example', 'ada@example.com', $1) returning id`,
    [customerA]
  )).rows[0].id;
  const userB = (await db.query(
    `insert into end_users (first_name, last_name, email, auth_user_id)
     values ('Bea', 'Example', 'bea@example.com', $1) returning id`,
    [customerB]
  )).rows[0].id;
  const linkA = (await db.query(
    `insert into device_enduser (device_id, end_user_id, status) values ($1, $2, 'active') returning id`,
    [deviceA, userA]
  )).rows[0].id;
  await db.query(
    `insert into device_enduser (device_id, end_user_id, status) values ($1, $2, 'active')`,
    [deviceB, userB]
  );
  await db.query(
    `insert into subscriptions (device_enduser_id, plan_name, monthly_amount, status, next_billing_date)
     values ($1, '50 GB Monthly', 55, 'active', current_date + 20)`,
    [linkA]
  );
  await db.query(
    `insert into user_roles (user_id, role) values ($1, 'customer'), ($2, 'customer')`,
    [customerA, customerB]
  );

  const roles = await db.query(`select role from user_roles where user_id in ($1, $2) order by role`, [joe, heath]);
  assert.deepStrictEqual(roles.rows.map((r) => r.role), ['admin', 'admin']);

  const adaDevices = await asRole(db, 'authenticated', customerA, async () => {
    const devices = await q(db, 'select imei from devices order by imei');
    const users = await q(db, 'select email from end_users order by email');
    const sims = await q(db, 'select activation_code from sim_cards');
    const updated = await q(db, `update subscriptions set status = 'suspended'`);
    return { devices: devices.rows, users: users.rows, sims: sims.rows, updated: updated.rowCount };
  });
  assert.deepStrictEqual(adaDevices.devices, [{ imei: '111111111111111' }]);
  assert.deepStrictEqual(adaDevices.users, [{ email: 'ada@example.com' }]);
  assert.strictEqual(adaDevices.sims.length, 0, 'customers must not read SIM activation codes');
  assert.strictEqual(adaDevices.updated, 0, 'customers cannot change subscription status directly');

  const joeDevices = await asRole(db, 'authenticated', joe, async () => {
    return (await q(db, 'select imei from devices order by imei')).rows;
  });
  assert.strictEqual(joeDevices.length, 2);

  async function countOrDenied(sql) {
    await q(db, 'savepoint anon_probe');
    try {
      const rows = await q(db, sql);
      await q(db, 'release savepoint anon_probe');
      return rows.rows.length;
    } catch (err) {
      await q(db, 'rollback to savepoint anon_probe');
      if (/permission denied/i.test(err.message)) return 0;
      throw err;
    }
  }
  const anon = await asRole(db, 'anon', null, async () => {
    const devices = await countOrDenied('select id from devices');
    const sims = await countOrDenied('select id from sim_cards');
    let requestDenied = false;
    await q(db, 'savepoint anon_probe');
    try {
      await q(db, `insert into service_requests (reference, request_type, submitted_name, submitted_email, submitted_imei_last5)
        values ('REQ-X', 'suspend', 'A', 'a@a.co', '11111')`);
      await q(db, 'release savepoint anon_probe');
    } catch (err) {
      await q(db, 'rollback to savepoint anon_probe');
      requestDenied = /permission denied|row-level security/i.test(err.message);
    }
    await q(db, `insert into orders_queue (customer_name, customer_email) values ('Buyer', 'buyer@example.com')`);
    const orders = await countOrDenied('select id from orders_queue');
    return { devices, sims, requestDenied, orders };
  });
  assert.strictEqual(anon.devices, 0);
  assert.strictEqual(anon.sims, 0);
  assert.strictEqual(anon.requestDenied, true);
  assert.strictEqual(anon.orders, 0, 'anon can insert an order but cannot read it back');

  let rpcDenied = false;
  try {
    await asRole(db, 'authenticated', customerA, async () => {
      await q(db, `select public.apply_customer_coverage($1, $2, 'suspend', 'ops@example.com', 'http://local/?portal=1')`, [customerA, deviceA]);
    });
  } catch (err) {
    rpcDenied = /permission denied/i.test(err.message);
  }
  assert.strictEqual(rpcDenied, true);

  const suspended = await asRole(db, 'service_role', null, async () => {
    const result = await q(db,
      `select public.apply_customer_coverage($1, $2, 'suspend', 'ops@example.com', 'http://local/?portal=1') as result`,
      [customerA, deviceA]
    );
    return result.rows[0].result;
  }, true);
  assert.strictEqual(suspended.coverage, 'suspended');
  assert.ok(suspended.auto_cancel_on);
  assert.strictEqual(suspended.unchanged, false);

  const state = await db.query(`
    select s.status as sub_status, s.next_billing_date, s.auto_cancel_on,
           de.status as link_status, d.status as device_status, sim.status as sim_status
    from subscriptions s
    join device_enduser de on de.id = s.device_enduser_id
    join devices d on d.id = de.device_id
    join sim_cards sim on sim.device_id = d.id
    where d.id = $1
  `, [deviceA]);
  assert.strictEqual(state.rows[0].sub_status, 'suspended');
  assert.strictEqual(state.rows[0].next_billing_date, null);
  assert.strictEqual(state.rows[0].link_status, 'suspended');
  assert.strictEqual(state.rows[0].device_status, 'suspended');
  assert.strictEqual(state.rows[0].sim_status, 'suspended');

  const deadline = await db.query(`select (($1::date + interval '6 months')::date = $2::date) as ok`, [
    (await db.query(`select (timezone('America/New_York', now()))::date as today`)).rows[0].today,
    suspended.auto_cancel_on,
  ]);
  assert.strictEqual(deadline.rows[0].ok, true);

  const requests = await db.query(`select request_type, status from service_requests where device_id = $1`, [deviceA]);
  assert.strictEqual(requests.rows[0].request_type, 'suspend');
  assert.strictEqual(requests.rows[0].status, 'new');
  const outbox = await db.query(`select kind, to_email from coverage_email_outbox where subscription_id is not null`);
  assert.ok(outbox.rows.some((row) => row.kind === 'admin_action' && row.to_email === 'ops@example.com'));

  const reactivated = await asRole(db, 'service_role', null, async () => {
    return (await q(db,
      `select public.apply_customer_coverage($1, $2, 'reactivate', 'ops@example.com', 'http://local/?portal=1') as result`,
      [customerA, deviceA]
    )).rows[0].result;
  }, true);
  assert.strictEqual(reactivated.coverage, 'active');
  const activeAgain = await db.query(`select status, next_billing_date is not null as billing from subscriptions where device_enduser_id = $1`, [linkA]);
  assert.strictEqual(activeAgain.rows[0].status, 'active');
  assert.strictEqual(activeAgain.rows[0].billing, true);

  await db.query(`update subscriptions set status = 'suspended', auto_cancel_on = (timezone('America/New_York', now()))::date + 6, next_billing_date = null where device_enduser_id = $1`, [linkA]);
  await db.query(`update device_enduser set status = 'suspended' where id = $1`, [linkA]);
  const warned = await asRole(db, 'service_role', null, async () => {
    return (await q(db, `select public.run_coverage_schedule('ops@example.com', 'http://local/?portal=1') as result`)).rows[0].result;
  }, true);
  assert.strictEqual(Number(warned.warnings), 1);
  assert.strictEqual(Number(warned.cancellations), 0);
  const warning = await db.query(`select warning_slot, to_email from coverage_email_outbox where kind = 'warning'`);
  assert.strictEqual(warning.rows[0].warning_slot, 7);
  assert.strictEqual(warning.rows[0].to_email, 'ada@example.com');

  await db.query(`update subscriptions set auto_cancel_on = (timezone('America/New_York', now()))::date - 1 where device_enduser_id = $1`, [linkA]);
  const canceled = await asRole(db, 'service_role', null, async () => {
    return (await q(db, `select public.run_coverage_schedule('ops@example.com', 'http://local/?portal=1') as result`)).rows[0].result;
  }, true);
  assert.strictEqual(Number(canceled.cancellations), 1);
  const finalState = await db.query(`
    select s.status as sub_status, de.status as link_status, d.status as device_status, sim.status as sim_status
    from subscriptions s
    join device_enduser de on de.id = s.device_enduser_id
    join devices d on d.id = de.device_id
    join sim_cards sim on sim.device_id = d.id
    where de.id = $1
  `, [linkA]);
  assert.strictEqual(finalState.rows[0].sub_status, 'cancelled');
  assert.strictEqual(finalState.rows[0].link_status, 'cancelled');
  assert.strictEqual(finalState.rows[0].device_status, 'inactive');
  assert.strictEqual(finalState.rows[0].sim_status, 'deactivated');

  let reactivateBlocked = false;
  try {
    await asRole(db, 'service_role', null, async () => {
      await q(db,
        `select public.apply_customer_coverage($1, $2, 'reactivate', 'ops@example.com', 'http://local/?portal=1')`,
        [customerA, deviceA]
      );
    });
  } catch (err) {
    reactivateBlocked = /new SIM/.test(err.message);
  }
  assert.strictEqual(reactivateBlocked, true);

  const snap = await asRole(db, 'service_role', null, async () => {
    return (await q(db, `select public.customer_portal_snapshot($1) as result`, [customerB])).rows[0].result;
  });
  assert.strictEqual(snap.email, 'bea@example.com');
  assert.strictEqual(snap.devices.length, 1);
  assert.strictEqual(snap.devices[0].imei, '222222222222222');
  assert.ok(!JSON.stringify(snap).includes('SECRET-CODE'));

  const brendenDevice = '9b5f038d-009f-4d49-a976-d5422621fef9';
  await db.query(
    `insert into devices (id, serial_number, imei, status) values ($1, '861157040036945', '861157040036945', 'active')`,
    [brendenDevice]
  );
  await db.query(
    `insert into sim_cards (iccid, status, device_id, data_plan) values ('8901240384117033679F', 'active', $1, '50 GB Monthly')`,
    [brendenDevice]
  );
  const craig = (await db.query(
    `insert into end_users (first_name, last_name, email) values ('Craig', 'Isom', 'cisom@example.com') returning id`
  )).rows[0].id;
  await db.query(
    `insert into device_enduser (device_id, end_user_id, status) values ($1, $2, 'cancelled'), ($1, $2, 'cancelled')`,
    [brendenDevice, craig]
  );
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261114120000_customer_portal.sql'), 'utf8');
  const seedSql = migration.slice(migration.indexOf('-- Brenden Milstead'));
  await db.query(seedSql);
  await db.query(seedSql);
  const seeded = await db.query(
    `select eu.email, de.status from device_enduser de
     join end_users eu on eu.id = de.end_user_id
     where de.device_id = $1 order by eu.email, de.status`,
    [brendenDevice]
  );
  assert.deepStrictEqual(seeded.rows, [
    { email: 'brendenmilstead@yahoo.com', status: 'active' },
    { email: 'cisom@example.com', status: 'cancelled' },
    { email: 'cisom@example.com', status: 'cancelled' },
  ]);
  const seededSub = await db.query(
    `select s.plan_name, s.status, s.monthly_amount::float as amount
     from subscriptions s join device_enduser de on de.id = s.device_enduser_id
     where de.device_id = $1 and de.status = 'active'`,
    [brendenDevice]
  );
  assert.strictEqual(seededSub.rows[0].plan_name, '50 GB Monthly');
  assert.strictEqual(seededSub.rows[0].status, 'active');
  const brendenAuth = await db.query(`select id from auth.users where lower(email) = 'brendenmilstead@yahoo.com'`);
  assert.strictEqual(brendenAuth.rows.length, 0);

  await db.end();
  console.log('portal rls tests ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
