'use strict';

const { json, options, fail, parseBody, header, bearer } = require('./_lib');
const { requireAdmin, runSchedule } = require('./_portal');

// Netlify scheduled functions are not URL-invokable on published deploys.
// The scheduler posts {"next_run":"..."} and that is the authorization for
// the daily run. Manual runs use the operator session or X-Cron-Secret.
function fromScheduler(event) {
  try {
    const body = parseBody(event);
    return !!(body && typeof body.next_run === 'string' && body.next_run);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const secret = process.env.CRON_SECRET || '';
    const given = String(header(event, 'x-cron-secret') || '');
    let allowed = fromScheduler(event) || (!!secret && given === secret);
    if (!allowed && bearer(event)) {
      await requireAdmin(event);
      allowed = true;
    }
    if (!allowed) return json(401, { error: 'Not authorized' });
    return json(200, await runSchedule(event));
  } catch (err) {
    return fail(err);
  }
};
