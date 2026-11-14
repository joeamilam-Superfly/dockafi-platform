'use strict';

// Matches Postgres `date + interval 'N months'`, which clamps the day to the
// last day of the target month.
function addMonths(isoDate, months) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const index = (m - 1) + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return year + '-' + mm + '-' + dd;
}

function etToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// daysLeft is auto_cancel_on minus today. Null means no email is due.
function warningSlot(daysLeft, flags) {
  const sent30 = flags && flags.warning_30_sent_on;
  const sent7 = flags && flags.warning_7_sent_on;
  const sent1 = flags && flags.warning_1_sent_on;
  if (daysLeft <= 0) return 'cancel';
  if (daysLeft <= 1) return sent1 ? null : 1;
  if (daysLeft <= 7) return sent7 ? null : 7;
  if (daysLeft <= 30) return sent30 ? null : 30;
  return null;
}

module.exports = { addMonths, etToday, warningSlot };
