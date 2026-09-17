'use strict';

const { json, options, supabase } = require('./_lib');

function bad(msg) {
  return json(400, { error: msg });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return bad('Invalid JSON');
  }

  const name = String(body.submitted_name || '').trim();
  const email = String(body.submitted_email || '').trim().toLowerCase();
  const imei = String(body.submitted_imei_last5 || '').replace(/\D/g, '');
  const requestType = String(body.request_type || '').trim();
  const detail = body.detail ? String(body.detail).slice(0, 500) : null;
  const notes = body.notes ? String(body.notes).slice(0, 2000) : null;
  const reference = String(body.reference || ('REQ-' + Date.now().toString(36).toUpperCase())).slice(0, 32);

  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return bad('Name and a valid email are required');
  if (!/^\d{5}$/.test(imei)) return bad('IMEI last 5 must be exactly 5 digits');
  if (requestType !== 'suspend' && requestType !== 'cancel') return bad('request_type must be suspend or cancel');

  try {
    const devices = await supabase(
      '/rest/v1/devices?imei_last5=eq.' + encodeURIComponent(imei) +
      '&select=id,imei,serial_number,status,device_enduser(status,end_users(id,email,email_normalized,reseller_org_id))'
    );
    if (!Array.isArray(devices) || !devices.length) {
      return json(404, { error: 'No matching device' });
    }

    const emailNorm = email.toLowerCase();
    let matchedDevice = null;
    let matchedUser = null;
    for (const d of devices) {
      const links = (d.device_enduser || []).filter((l) => l.status === 'active');
      for (const link of links) {
        const u = link.end_users;
        const uEmail = (u?.email_normalized || u?.email || '').toLowerCase();
        if (u && uEmail === emailNorm) {
          matchedDevice = d;
          matchedUser = u;
          break;
        }
      }
      if (matchedUser) break;
    }

    // Portal identity is email + last 5. If the IMEI exists but email does not match an active link, reject.
    if (!matchedUser) {
      return json(404, { error: 'No matching device for that email and IMEI' });
    }

    const rows = await supabase('/rest/v1/service_requests', {
      method: 'POST',
      body: JSON.stringify({
        reference,
        request_type: requestType,
        submitted_name: name.slice(0, 200),
        submitted_email: email,
        submitted_imei_last5: imei,
        detail,
        notes,
        device_id: matchedDevice.id,
        end_user_id: matchedUser.id,
        reseller_org_id: matchedUser.reseller_org_id || null,
        status: 'new',
      }),
    });

    return json(200, { ok: true, request: Array.isArray(rows) ? rows[0] : rows, reference });
  } catch (e) {
    if (e.code === 'NO_KEY') {
      return json(501, { error: e.message, hint: 'Set SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in Netlify env.' });
    }
    const msg = String(e.message || '');
    if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
      return json(409, { error: 'A request with this reference already exists' });
    }
    return json(500, { error: msg || 'Submission failed' });
  }
};
