'use strict';

const { json, options, fail, parseBody } = require('./_lib');
const { requireAdmin, inviteCustomer, resendCustomer, runSchedule, regenerateDraft } = require('./_portal');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    await requireAdmin(event);
    let body;
    try { body = parseBody(event); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');
    if (action === 'invite') return json(200, await inviteCustomer(body, event));
    if (action === 'resend') return json(200, await resendCustomer(body, event));
    if (action === 'regenerate') return json(200, await regenerateDraft(body.draft_id, event));
    if (action === 'run_schedule') return json(200, await runSchedule(event));
    return json(400, { error: 'action must be invite, resend, regenerate, or run_schedule' });
  } catch (err) {
    return fail(err);
  }
};
