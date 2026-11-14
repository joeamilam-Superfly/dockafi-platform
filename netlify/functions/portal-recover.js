'use strict';

const { json, options, fail, parseBody } = require('./_lib');
const { recoverPassword } = require('./_portal');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    let body;
    try { body = parseBody(event); } catch { return json(400, { error: 'Invalid JSON' }); }
    const result = await recoverPassword(body.email, event);
    return json(200, result);
  } catch (err) {
    return fail(err);
  }
};
