'use strict';

const { supabase, supabaseEnv, bearer, HttpError } = require('./_lib');
const { sendEmail, mailerConfigured } = require('./_email');
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

const FROM_ADDRESS = 'support@dockafi.com';
const LINK_HOURS = 1;

function defaultPassword() {
  return process.env.PORTAL_DEFAULT_PASSWORD || 'Dockafi1234';
}

function sendingEnabled() {
  return process.env.PORTAL_SEND_EMAIL === 'true' && !!mailerConfigured();
}

async function queueDraft(fields) {
  requireService();
  const created = await supabase('/rest/v1/email_drafts', {
    method: 'POST',
    body: JSON.stringify({
      from_address: FROM_ADDRESS,
      to_email: fields.to,
      subject: fields.subject,
      body_text: fields.text,
      kind: fields.kind,
      end_user_id: fields.endUserId || null,
      device_id: fields.deviceId || null,
      status: 'draft',
    }),
  });
  const row = Array.isArray(created) ? created[0] : created;
  if (row && row.id) await maybeSendDraft(row.id);
  return row;
}

async function maybeSendDraft(id) {
  if (!sendingEnabled() || !id) return { sent: false };
  const rows = await supabase(
    '/rest/v1/email_drafts?id=eq.' + encodeURIComponent(id) + '&status=eq.draft&select=id,to_email,subject,body_text'
  );
  const row = rows && rows[0];
  if (!row) return { sent: false };
  try {
    await sendEmail({ to: row.to_email, subject: row.subject, text: row.body_text });
  } catch (err) {
    return { sent: false, reason: err.message };
  }
  await supabase('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString(), sent_by: 'portal' }),
  });
  return { sent: true };
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
  if (result && result.draft_id) {
    const delivery = await maybeSendDraft(result.draft_id);
    notified = !!delivery.sent;
  }
  return {
    ok: true,
    unchanged: !!(result && result.unchanged),
    coverage: result && result.coverage,
    auto_cancel_on: result && result.auto_cancel_on,
    reference: result && result.reference,
    device_id: result && result.device_id,
    draft_saved: !!(result && result.draft_id),
    admin_notified: notified,
  };
}

async function runSchedule(event) {
  const summary = await rpc('run_coverage_schedule', {
    p_admin_email: adminEmail(),
    p_portal_url: portalUrl(event),
  });
  if (sendingEnabled()) {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fresh = await supabase(
      '/rest/v1/email_drafts?status=eq.draft&created_at=gte.' + encodeURIComponent(since) + '&select=id'
    );
    for (const row of fresh || []) await maybeSendDraft(row.id);
  }
  return { ok: true, warnings: summary && summary.warnings, cancellations: summary && summary.cancellations };
}

function welcomeMessage(name, email, portal) {
  return {
    subject: 'Your DockaFi customer portal login',
    text:
      (name ? 'Hi ' + name + ',\n\n' : '') +
      'Your DockaFi customer portal login is ready.\n\n' +
      'Sign in: ' + portal + '\n' +
      'Email: ' + email + '\n' +
      'Temporary password: ' + defaultPassword() + '\n\n' +
      'Please change this password after you sign in. You can keep using the portal if you wait, and the page will keep reminding you until you do.',
  };
}

function resetMessage(name, link) {
  return {
    subject: 'Reset your DockaFi portal password',
    text:
      (name ? 'Hi ' + name + ',\n\n' : '') +
      'Use this link to set a new DockaFi customer portal password:\n\n' +
      link + '\n\n' +
      'The link expires about ' + LINK_HOURS + ' hour after it was created. If it has expired, an operator can regenerate it in Email drafts before sending.\n\n' +
      'If you did not ask for this, you can ignore it.',
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
          password: defaultPassword(),
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
  user.existed = !!row;
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

async function saveResetDraft(email, name, endUserId, deviceId, event) {
  const link = await recoveryLink(email, event);
  const message = resetMessage(name, link);
  const row = await queueDraft({
    to: email,
    subject: message.subject,
    text: message.text,
    kind: 'password_reset',
    endUserId,
    deviceId,
  });
  return { ok: true, draft_id: row && row.id };
}

async function saveWelcomeDraft(email, name, endUserId, deviceId, event) {
  const message = welcomeMessage(name, email, portalUrl(event));
  const row = await queueDraft({
    to: email,
    subject: message.subject,
    text: message.text,
    kind: 'welcome',
    endUserId,
    deviceId,
  });
  return { ok: true, draft_id: row && row.id, draft_kind: 'welcome' };
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
  const already = authUser.existed;
  await supabase('/rest/v1/end_users?id=eq.' + encodeURIComponent(endUser.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      auth_user_id: authUser.id,
      portal_invited_at: new Date().toISOString(),
      must_change_password: !already,
    }),
  });
  const mail = already
    ? await saveResetDraft(email, first, endUser.id, device.id, event)
    : await saveWelcomeDraft(email, first, endUser.id, device.id, event);
  return { ok: true, end_user_id: endUser.id, draft_id: mail.draft_id, draft_kind: already ? 'password_reset' : 'welcome' };
}

async function resendCustomer(body, event) {
  const endUserId = body.end_user_id;
  const emailInput = String(body.email || '').trim().toLowerCase();
  let endUser = null;
  if (isUuid(endUserId)) {
    const rows = await supabase(
      '/rest/v1/end_users?id=eq.' + encodeURIComponent(endUserId) +
      '&select=id,first_name,last_name,email,phone,status,auth_user_id,device_enduser(id,status,device_id)&limit=1'
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
  await ensureCustomerAuth(email, endUser.first_name, endUser.last_name);
  const authUser = (await rpc('lookup_auth_email', { p_email: email }));
  const authRow = Array.isArray(authUser) ? authUser[0] : null;
  await supabase('/rest/v1/end_users?id=eq.' + encodeURIComponent(endUser.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      auth_user_id: authRow && authRow.id,
      portal_invited_at: new Date().toISOString(),
    }),
  });
  const deviceId = (links.find((link) => link.status === 'active' || link.status === 'suspended') || {}).device_id;
  const mail = await saveResetDraft(email, endUser.first_name, endUser.id, deviceId, event);
  return { ok: true, end_user_id: endUser.id, draft_id: mail.draft_id, draft_kind: 'password_reset' };
}

async function recoverPassword(email, event) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new HttpError(400, 'A valid email is required');
  const found = await rpc('lookup_auth_email', { p_email: normalized });
  const row = Array.isArray(found) ? found[0] : null;
  if (row && row.role !== 'admin') {
    const endUser = await loadEndUserByEmail(normalized);
    let deviceId = null;
    if (endUser) {
      const links = await supabase(
        '/rest/v1/device_enduser?end_user_id=eq.' + encodeURIComponent(endUser.id) +
        '&status=in.(active,suspended)&select=device_id&limit=1'
      );
      deviceId = links && links[0] && links[0].device_id;
    }
    await saveResetDraft(normalized, endUser && endUser.first_name, endUser && endUser.id, deviceId, event);
  }
  return { ok: true };
}

async function changePassword(user, password) {
  const next = String(password || '');
  if (next.length < 8) throw new HttpError(400, 'Use at least 8 characters');
  if (next === defaultPassword()) throw new HttpError(400, 'Choose a different password');
  await adminAuth('/auth/v1/admin/users/' + user.id, {
    method: 'PUT',
    body: JSON.stringify({ password: next }),
  });
  await supabase('/rest/v1/end_users?auth_user_id=eq.' + encodeURIComponent(user.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ must_change_password: false }),
  });
  return { ok: true };
}

async function regenerateDraft(draftId, event) {
  if (!isUuid(draftId)) throw new HttpError(400, 'Draft id is required');
  const rows = await supabase('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draftId) + '&select=*');
  const draft = rows && rows[0];
  if (!draft) throw new HttpError(404, 'Draft not found');
  if (draft.kind !== 'password_reset') throw new HttpError(400, 'Only password-reset drafts have a link to regenerate');
  const endUser = await loadEndUserByEmail(draft.to_email);
  const message = resetMessage(endUser && endUser.first_name, await recoveryLink(draft.to_email, event));
  await supabase('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draftId), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      subject: message.subject,
      body_text: message.text,
      status: 'draft',
      sent_at: null,
      sent_by: null,
    }),
  });
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
  changePassword,
  regenerateDraft,
  defaultPassword,
};
