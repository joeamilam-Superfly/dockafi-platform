'use strict';

const { json, options } = require('./_lib');

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function localGuideAnswer(system, messages) {
  const question = lastUserMessage(messages).trim();
  const guide = String(system || '');
  if (!question) {
    return 'Ask about a DockaFI ops task — adding a device, linking an end user, processing an order, or handling a request.';
  }

  const stop = new Set(['this', 'that', 'with', 'from', 'what', 'when', 'where', 'have', 'does', 'do', 'the', 'and', 'how', 'for', 'are']);
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !stop.has(w));
  const chunks = guide.split(/\n(?=\d+\. |\n[A-Z][^\n]{8,}\n)/);
  let best = '';
  let bestScore = 0;
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = chunk.trim();
    }
  }

  if (bestScore < 1 || !best) {
    return 'I have the operations guide loaded, but I need a more specific question. Try: adding a device, linking a device, processing a shop order, handling a suspension, or finding an IMEI.';
  }
  if (best.length > 1600) best = best.slice(0, 1600) + '\n\n(Ask a follow-up if you need the next step.)';
  return best;
}

async function claudeAnswer(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: String(system || '').slice(0, 20000),
      messages: (Array.isArray(messages) ? messages : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .slice(-12)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Claude request failed');
    err.details = data;
    throw err;
  }
  const text = (data.content || []).map((c) => c.text || '').join('\n').trim();
  return text || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const system = body.system || '';
  const messages = body.messages || [];

  try {
    const ai = await claudeAnswer(system, messages);
    const text = ai || localGuideAnswer(system, messages);
    return json(200, {
      content: [{ type: 'text', text }],
      source: ai ? 'claude' : 'local-guide',
    });
  } catch (e) {
    const text = localGuideAnswer(system, messages);
    return json(200, {
      content: [{ type: 'text', text }],
      source: 'local-guide',
      warning: String(e.message || 'AI fallback'),
    });
  }
};
