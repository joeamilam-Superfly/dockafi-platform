'use strict';

const { json, options, fail } = require('./_lib');
const { requireUser, accountFor } = require('./_portal');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  try {
    const user = await requireUser(event);
    const account = await accountFor(user.id);
    if (!account) return json(403, { error: 'This login is not a customer account' });
    return json(200, { role: 'customer', account });
  } catch (err) {
    return fail(err);
  }
};
