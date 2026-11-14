'use strict';

const crypto = require('crypto');
const { supabase, supabaseEnv, bearer, HttpError } = require('./_lib');
const { sendEmail, mailerConfigured, mailerSetupMessage } = require('./_email');
const { addMonths, etToday } = require('./_coverage');

const ADMIN_EMAIL_DEFAULT = 'joeamilam@gmail.com';

function adminEmail() {
  return (process.env.ADMIN_NOTIFY_EMAIL || ADMIN_EMAIL_DEFAULT).trim();
}

function portalUrl(event) {
  let origin = (process.env.PORTAL_SITE_URL || '').trim().replace(/\/$/, '');
  if (!origin && event && event.headers) {
    const host = event.headers.host || event.headers.Host || '';
    const proto = event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'] ||
      (String(host).startsWith('localhost') || String(host).startsWith('127.0.0.1') ? 'http' : 'https');
    if (host) origin = proto + '://' + host;
  }
  if (!origin) origin = 'https://dockafiplatform.netlify.app';
  return origin + '/?portal=1';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function requireService() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(501, 'SUPABASE_SERVICE_ROLE_KEY is not set on the Netlify site. Portal changes run only with the service role.');
  }
}

async function rpc(name, args) {
  requireService();
  return supabase('/rest/v1/rpc/' + name, {
    method: 'POST',
    body: JSON.stringify(args || {}),
  });
}

async function getAuthUser(token) {
  if (!token) return null;
  const { url, key } = supabaseEnv();
  if (!key) return null;
  const res = await fetch(url + '/auth/v1/user', {
    headers: { apikey: key, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) return null;
  return res.json();
}

async function requireUser(event) {
  const user = await getAuthUser(bearer(event));
  if (!user || !user.id) throw new HttpError(401, 'Sign in required');
  return user;
}

async function requireAdmin(event) {
  const user = await requireUser(event);
  requireService();
  const rows = await supabase('/rest/v1/user_roles?user_id=eq.' + encodeURIComponent(user.id) + '&select=role');
  if (!rows || !rows[0] || rows[0].role !== 'admin') {
    throw new HttpError(403, 'Operator access required');
  }
  return user;
}

async function adminAuth(path, opts) {
  requireService();
  const { url } = supabaseEnv();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(url + path, {
    method: (opts && opts.method) || 'GET',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: opts && opts.body ? opts.body : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const message = (data && (data.msg || data.message || data.error_description || data.error)) || 'Auth admin request failed';
    const err = new HttpError(res.status || 500, message);
    err.details = data;
    throw err;
  }
  return data;
}

function randomPassword() {
  return crypto.randomBytes(24).toString('base64url') + 'Aa1!';
}

async function deliverOutbox(extraFilter) {
  requireService();
  const rows = await supabase(
    '/rest/v1/coverage_email_outbox?sent_at=is.null&select=id,to_email,subject,body_text&order=created_at.asc' +
    (extraFilter || '')
  );
  const results = [];
  for (const row of rows || []) {
    let sent = { sent: false, reason: mailerSetupMessage() };
    if (mailerConfigured()) {
      try {
        sent = await sendEmail({ to: row.to_email, subject: row.subject, text: row.body_text });
      } catch (err) {
        sent = { sent: false, reason: err.message };
      }
    }
    if (sent.sent) {
      await supabase('/rest/v1/coverage_email_outbox?id=eq.' + encodeURIComponent(row.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ sent_at: new Date().toISOString() }),
      });
    }
    results.push({ id: row.id, to: row.to_email, sent: !!sent.sent, reason: sent.reason || null });
  }
  return results;
}

async function accountFor(userId) {
  const snap = await rpc('customer_portal_snapshot', { p_auth_user: userId });
  return snap || null;
}

async function act(userId, deviceId, action, event) {
  if (!['suspend', 'reactivate', 'cancel'].includes(action)) {
    throw new HttpError(400, 'Action must be suspend, reactivate, or cancel');
  }
  if (!isUuid(deviceId)) throw new HttpError(400, 'A device id is required');
  const result = await rpc('apply_customer_coverage', {
    p_auth_user: userId,
    p_device: deviceId,
    p_action: action,
    p_admin_email: adminEmail(),
    p_portal_url: portalUrl(event),
  });
  let notified = false;
  if (result && result.outbox_id) {
    const delivery = await deliverOutbox('&id=eq.' + encodeURIComponent(result.outbox_id));
    notified = !!(delivery[0] && delivery[0].sent);
  }
  return {
    ok: true,
    unchanged: !!(result && result.unchanged),
    coverage: result && result.coverage,
    auto_cancel_on: result && result.auto_cancel_on,
    reference: result && result.reference,
    device_id: result && result.device_id,
    admin_notified: notified,
  };
}

async function runSchedule(event) {
  const summary = await rpc('run_coverage_schedule', {
    p_admin_email: adminEmail(),
    p_portal_url: portalUrl(event),
  });
  const delivery = await deliverOutbox('');
  return {
    ok: true,
    warnings: summary && summary.warnings,
    cancellations: summary && summary.cancellations,
    emails: delivery,
    mailer: mailerConfigured() || null,
  };
}

function passwordMessage(kind, name, link) {
  const greeting = name ? 'Hi ' + name + ',\n\n' : '';
  const lead = kind === 'invite'
    ? 'Use this link to set your DockaFi customer portal password. You will sign in with this email address.'
    : 'Use this link to reset your DockaFi customer portal password.';
  return {
    subject: kind === 'invite' ? 'Set your DockaFi portal password' : 'Reset your DockaFi portal password',
    text: greeting + lead + '\n\n' + link + '\n\nIf you did not expect this email, you can ignore it. The link expires after a short time.',
  };
}

async function recoveryLink(email, event) {
  const data = await adminAuth('/auth/v1/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({
      type: 'recovery',
      email,
      redirect_to: portalUrl(event),
    }),
  });
  const link = data && (data.action_link || data.actionLink);
  if (!link) throw new HttpError(502, 'Supabase did not return a password link');
  return link;
}

async function ensureCustomerAuth(email, first, last) {
  const found = await rpc('lookup_auth_email', { p_email: email });
  const row = Array.isArray(found) ? found[0] : null;
  if (row && row.role === 'admin') {
    throw new HttpError(409, 'That email belongs to an operator account');
  }
  if (!row) {
    try {
      await adminAuth('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: randomPassword(),
          email_confirm: true,
          app_metadata: { role: 'customer' },
          user_metadata: { first_name: first, last_name: last },
        }),
      });
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      if (!(err.status === 422 || msg.includes('already'))) throw err;
    }
  } else {
    await adminAuth('/auth/v1/admin/users/' + row.id, {
      method: 'PUT',
      body: JSON.stringify({
        email_confirm: true,
        app_metadata: { role: 'customer' },
        user_metadata: { first_name: first, last_name: last },
      }),
    });
  }
  const again = await rpc('lookup_auth_email', { p_email: email });
  const user = Array.isArray(again) ? again[0] : null;
  if (!user || !user.id) throw new HttpError(500, 'Could not create the customer login');
  if (user.role === 'admin') throw new HttpError(409, 'That email belongs to an operator account');
  try {
    await supabase('/rest/v1/user_roles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: user.id, role: 'customer' }),
    });
  } catch (err) {
    if (err.status !== 409) throw err;
    await supabase('/rest/v1/user_roles?user_id=eq.' + encodeURIComponent(user.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ role: 'customer' }),
    });
  }
  return user;
}

async function loadEndUserByEmail(email) {
  const rows = await supabase(
    '/rest/v1/end_users?email_normalized=eq.' + encodeURIComponent(email) +
    '&select=id,first_name,last_name,email,phone,status,auth_user_id&limit=1'
  );
  return rows && rows[0] ? rows[0] : null;
}

async function ensureSubscription(linkId, deviceId) {
  const subs = await supabase(
    '/rest/v1/subscriptions?device_enduser_id=eq.' + encodeURIComponent(linkId) +
    '&select=id,status&order=created_at.desc'
  );
  if ((subs || []).some((s) => s.status === 'active' || s.status === 'suspended')) return;
  const sims = await supabase(
    '/rest/v1/sim_cards?device_id=eq.' + encodeURIComponent(deviceId) + '&select=data_plan&limit=1'
  );
  const plan = (sims && sims[0] && sims[0].data_plan) || '50 GB Monthly';
  const next = addMonths(etToday(), 1);
  await supabase('/rest/v1/subscriptions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      device_enduser_id: linkId,
      plan_name: plan,
      monthly_amount: 60,
      status: 'active',
      next_billing_date: next,
    }),
  });
}

async function linkDevice(endUser, device) {
  const links = device.device_enduser || [];
  const current = links.find((link) => link.status === 'active' || link.status === 'suspended');
  if (current && current.end_user_id !== endUser.id) {
    throw new HttpError(409, 'This device is already linked to another customer');
  }
  if (current) {
    await ensureSubscription(current.id, device.id);
    return current.id;
  }
  const created = await supabase('/rest/v1/device_enduser', {
    method: 'POST',
    body: JSON.stringify({
      device_id: device.id,
      end_user_id: endUser.id,
      status: 'active',
      activated_at: new Date().toISOString(),
      notes: 'Linked from the customer portal invite.',
    }),
  });
  const link = Array.isArray(created) ? created[0] : created;
  if (!link || !link.id) throw new HttpError(500, 'Could not link the device');
  if (device.status === 'unassigned' || device.status === 'inactive' || device.status === 'assigned') {
    await supabase('/rest/v1/devices?id=eq.' + encodeURIComponent(device.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'active' }),
    });
  }
  await ensureSubscription(link.id, device.id);
  return link.id;
}

async function sendPasswordLink(kind, email, name, event) {
  const link = await recoveryLink(email, event);
  const message = passwordMessage(kind, name, link);
  if (!mailerConfigured()) {
    return { emailed: false, setup_link: link, reason: mailerSetupMessage() };
  }
  try {
    await sendEmail({ to: email, subject: message.subject, text: message.text });
    return { emailed: true, setup_link: null };
  } catch (err) {
    return { emailed: false, setup_link: link, reason: err.message };
  }
}

async function inviteCustomer(body, event) {
  const first = String(body.first_name || '').trim();
  const last = String(body.last_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const imei = String(body.imei || '').replace(/\D/g, '');
  if (!first || !last) throw new HttpError(400, 'First and last name are required');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (!imei) throw new HttpError(400, 'IMEI is required');

  const devices = await supabase(
    '/rest/v1/devices?imei=eq.' + encodeURIComponent(imei) +
    '&select=id,imei,status,device_enduser(id,status,end_user_id)&limit=1'
  );
  const device = devices && devices[0];
  if (!device) throw new HttpError(400, 'No device with that IMEI is in the registry');

  let endUser = await loadEndUserByEmail(email);
  if (!endUser) {
    const created = await supabase('/rest/v1/end_users', {
      method: 'POST',
      body: JSON.stringify({
        first_name: first,
        last_name: last,
        email,
        phone: phone || null,
        status: 'active',
      }),
    });
    endUser = Array.isArray(created) ? created[0] : created;
  } else {
    await supabase('/rest/v1/end_users?id=eq.' + encodeURIComponent(endUser.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        first_name: first,
        last_name: last,
        phone: phone || endUser.phone || null,
        status: 'active',
      }),
    });
  }
  if (!endUser || !endUser.id) throw new HttpError(500, 'Could not save the customer');

  await linkDevice(endUser, device);
  const authUser = await ensureCustomerAuth(email, first, last);
  await supabase('/rest/v1/end_users?id=eq.' + encodeURIComponent(endUser.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      auth_user_id: authUser.id,
      portal_invited_at: new Date().toISOString(),
    }),
  });
  const mail = await sendPasswordLink('invite', email, first, event);
  return {
    ok: true,
    end_user_id: endUser.id,
    emailed: mail.emailed,
    setup_link: mail.setup_link,
    reason: mail.reason || null,
  };
}

async function resendCustomer(body, event) {
  const endUserId = body.end_user_id;
  const emailInput = String(body.email || '').trim().toLowerCase();
  let endUser = null;
  if (isUuid(endUserId)) {
    const rows = await supabase(
      '/rest/v1/end_users?id=eq.' + encodeURIComponent(endUserId) +
      '&select=id,first_name,last_name,email,phone,status,auth_user_id,device_enduser(id,status)&limit=1'
    );
    endUser = rows && rows[0];
  } else if (emailInput) {
    endUser = await loadEndUserByEmail(emailInput);
    if (endUser) {
      const links = await supabase(
        '/rest/v1/device_enduser?end_user_id=eq.' + encodeURIComponent(endUser.id) + '&select=id,status'
      );
      endUser.device_enduser = links || [];
    }
  }
  if (!endUser) throw new HttpError(404, 'Customer not found');
  const links = endUser.device_enduser || [];
  if (!links.some((link) => link.status === 'active' || link.status === 'suspended')) {
    throw new HttpError(400, 'Link a device before sending a portal password email');
  }
  const email = String(endUser.email || '').trim().toLowerCase();
  const authUser = await ensureCustomerAuth(email, endUser.first_name, endUser.last_name);
  await supabase('/rest/v1/end_users?id=eq.' + encodeURIComponent(endUser.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      auth_user_id: authUser.id,
      portal_invited_at: new Date().toISOString(),
    }),
  });
  const kind = endUser.auth_user_id ? 'recovery' : 'invite';
  const mail = await sendPasswordLink(kind, email, endUser.first_name, event);
  return {
    ok: true,
    end_user_id: endUser.id,
    emailed: mail.emailed,
    setup_link: mail.setup_link,
    reason: mail.reason || null,
  };
}

async function recoverPassword(email, event) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new HttpError(400, 'A valid email is required');
  if (!mailerConfigured()) throw new HttpError(503, mailerSetupMessage());
  const found = await rpc('lookup_auth_email', { p_email: normalized });
  const row = Array.isArray(found) ? found[0] : null;
  if (!row) return { ok: true };
  const endUser = await loadEndUserByEmail(normalized);
  const mail = await sendPasswordLink('recovery', normalized, endUser && endUser.first_name, event);
  if (!mail.emailed) throw new HttpError(502, mail.reason || 'Could not send the password email');
  return { ok: true };
}

module.exports = {
  adminEmail,
  portalUrl,
  isUuid,
  requireUser,
  requireAdmin,
  accountFor,
  act,
  runSchedule,
  inviteCustomer,
  resendCustomer,
  recoverPassword,
  deliverOutbox,
};
