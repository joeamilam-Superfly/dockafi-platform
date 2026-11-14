'use strict';

function mailerConfigured() {
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM) return 'smtp';
  return null;
}

function mailerSetupMessage() {
  return 'Password and coverage email is not configured. Set RESEND_API_KEY and RESEND_FROM (a verified sender), or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.';
}

function htmlFromText(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">' +
    escaped.replace(/\n/g, '<br>') + '</div>';
}

async function sendViaResend({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [to],
      subject,
      text,
      html: htmlFromText(text),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'Resend rejected the email');
    err.status = 502;
    throw err;
  }
  return { sent: true, provider: 'resend' };
}

async function sendViaSmtp({ to, subject, text }) {
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
    html: htmlFromText(text),
  });
  return { sent: true, provider: 'smtp' };
}

async function sendEmail({ to, subject, text }) {
  const which = mailerConfigured();
  if (!which) return { sent: false, reason: mailerSetupMessage() };
  if (which === 'resend') return sendViaResend({ to, subject, text });
  return sendViaSmtp({ to, subject, text });
}

module.exports = { mailerConfigured, mailerSetupMessage, sendEmail };
