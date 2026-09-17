'use strict';

const assert = require('assert');
const submit = require('../netlify/functions/submit-request');
const help = require('../netlify/functions/help-assistant');

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

  console.log('function smoke tests ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
