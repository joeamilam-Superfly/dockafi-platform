'use strict';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Cron-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

function options() {
  return { statusCode: 204, headers: CORS, body: '' };
}

function supabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.DOCKAFI_SUPABASE_URL || 'https://ldgbghjjzbhtrgdnmlmv.supabase.co';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.DOCKAFI_SUPABASE_ANON_KEY ||
    '';
  return { url, key, usingServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) };
}

async function supabase(path, opts = {}) {
  const { url, key } = supabaseEnv();
  if (!key) {
    const err = new Error('Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY on the Netlify site');
    err.code = 'NO_KEY';
    throw err;
  }
  const res = await fetch(url + path, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error_description || 'Supabase request failed');
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function rawBody(event) {
  if (!event || event.body == null || event.body === '') return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf8');
  return String(event.body);
}

function parseBody(event) {
  const raw = rawBody(event);
  if (!raw) return {};
  return JSON.parse(raw);
}

function bearer(event) {
  const headers = event && event.headers ? event.headers : {};
  const raw = headers.authorization || headers.Authorization || '';
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function header(event, name) {
  const headers = event && event.headers ? event.headers : {};
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key];
  }
  return '';
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

function fail(error) {
  const status = error.status || (error.code === 'NO_KEY' || error.code === 'NO_SERVICE' ? 501 : 500);
  const body = { error: error.message || 'Request failed' };
  if (error.extra && typeof error.extra === 'object') Object.assign(body, error.extra);
  return json(status, body);
}

module.exports = {
  CORS, json, options, supabaseEnv, supabase,
  rawBody, parseBody, bearer, header, HttpError, fail,
};
