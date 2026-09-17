'use strict';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

module.exports = { CORS, json, options, supabaseEnv, supabase };
