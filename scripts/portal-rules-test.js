'use strict';

const assert = require('assert');
const { addMonths, warningSlot } = require('../netlify/functions/_coverage');
const { mailerConfigured, mailerSetupMessage } = require('../netlify/functions/_email');

assert.strictEqual(addMonths('2026-11-14', 6), '2027-05-14');
assert.strictEqual(addMonths('2026-08-31', 6), '2027-02-28');
assert.strictEqual(addMonths('2024-08-31', 6), '2025-02-28');
assert.strictEqual(addMonths('2023-08-31', 6), '2024-02-29');

assert.strictEqual(warningSlot(30, {}), 30);
assert.strictEqual(warningSlot(8, {}), 30);
assert.strictEqual(warningSlot(7, {}), 7);
assert.strictEqual(warningSlot(2, { warning_7_sent_on: '2026-01-01' }), null);
assert.strictEqual(warningSlot(1, { warning_7_sent_on: '2026-01-01' }), 1);
assert.strictEqual(warningSlot(0, {}), 'cancel');
assert.strictEqual(warningSlot(-3, { warning_1_sent_on: '2026-01-01' }), 'cancel');
assert.strictEqual(warningSlot(40, {}), null);

if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
  assert.strictEqual(mailerConfigured(), null);
  assert.match(mailerSetupMessage(), /RESEND_API_KEY/);
}

console.log('portal rules ok');
