'use strict';

const { json, options, fail, parseBody } = require('./_lib');
const { requireUser, changePassword } = require('./_portal');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const user = await requireUser(event);
    let body;
    try { body = parseBody(event); } catch { return json(400, { error: 'Invalid JSON' }); }
    return json(200, await changePassword(user, body.password));
  } catch (err) {
    return fail(err);
  }
};
