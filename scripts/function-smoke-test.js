'use strict';

const assert = require('assert');
const submit = require('../netlify/functions/submit-request');
const help = require('../netlify/functions/help-assistant');
const account = require('../netlify/functions/portal-account');
const action = require('../netlify/functions/portal-action');
const recover = require('../netlify/functions/portal-recover');
const admin = require('../netlify/functions/customer-admin');
const schedule = require('../netlify/functions/coverage-schedule');

async function run() {
  const optSubmit = await submit.handler({ httpMethod: 'OPTIONS' });
  assert.strictEqual(optSubmit.statusCode, 204);

  const getSubmit = await submit.handler({ httpMethod: 'GET' });
  assert.strictEqual(getSubmit.statusCode, 405);

  const badJson = await submit.handler({ httpMethod: 'POST', body: '{' });
  assert.strictEqual(badJson.statusCode, 400);

  const missing = await submit.handler({
    httpMethod: 'POST',
    body: JSON.stringify({ submitted_name: 'A', submitted_email: 'not-an-email', submitted_imei_last5: '12', request_type: 'pause' }),
  });
  assert.strictEqual(missing.statusCode, 400);

  const optHelp = await help.handler({ httpMethod: 'OPTIONS' });
  assert.strictEqual(optHelp.statusCode, 204);

  const helpReply = await help.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      system: '1. Adding a New Device\nRegister every DockaFI unit when you receive inventory.\n\n6. Linking a Device to an End User\nLinking connects a device to a customer.',
      messages: [{ role: 'user', content: 'How do I add a new device?' }],
    }),
  });
  assert.strictEqual(helpReply.statusCode, 200);
  const parsed = JSON.parse(helpReply.body);
  assert.ok(parsed.content?.[0]?.text);
  assert.match(parsed.content[0].text, /device/i);

  const optAccount = await account.handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.strictEqual(optAccount.statusCode, 204);

  const noAccount = await account.handler({ httpMethod: 'GET', headers: {} });
  assert.strictEqual(noAccount.statusCode, 401);

  const noAction = await action.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.strictEqual(noAction.statusCode, 401);

  const badRecover = await recover.handler({ httpMethod: 'POST', headers: {}, body: '{"email":"nope"}' });
  assert.strictEqual(badRecover.statusCode, 400);

  const unconfigured = await recover.handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ email: 'customer@example.com' }),
  });
  assert.strictEqual(unconfigured.statusCode, 503);

  const noAdmin = await admin.handler({ httpMethod: 'POST', headers: {}, body: '{"action":"invite"}' });
  assert.strictEqual(noAdmin.statusCode, 401);

  const noSchedule = await schedule.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.strictEqual(noSchedule.statusCode, 401);

  console.log('function smoke tests ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
