/**
 * Deno Deploy - OpenAI-compatible proxy for DeepSeek (V3 & R1)
 *
 * Endpoints:
 *  - GET /v1/models
 *  - POST /v1/chat/completions
 *
 * Env vars (set in Deno Deploy project):
 *  - DEEPSEEK_API_KEY (required) — your DeepSeek API key
 *  - DEEPSEEK_BASE_URL (optional) — defaults to https://api.deepseek.com
 *  - PROXY_SECRET (optional) — if set, clients must send Authorization: Bearer <PROXY_SECRET>
 */

const DS_BASE = Deno.env.get('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
const DS_KEY = Deno.env.get('DEEPSEEK_API_KEY');
const PROXY_SECRET = Deno.env.get('PROXY_SECRET') || '';

// Exposed models (OpenAI-compatible IDs)
const MODELS = [
  { id: 'deepseek-chat', created: 1719870000 },      // DeepSeek-V3
  { id: 'deepseek-reasoner', created: 1725312000 },  // DeepSeek-R1
];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, OpenAI-Organization, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extra,
    },
  });
}

function error(message, type = 'invalid_request_error', code = 400, extra = {}) {
  return json({ error: { message, type, code } }, code, extra);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin') ?? '*';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors(origin) });
  }

  // Health check
  if (url.pathname === '/' || url.pathname === '/health') {
    return json({ ok: true }, 200, cors(origin));
  }

  // Optional proxy auth
  if (PROXY_SECRET) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${PROXY_SECRET}`) {
      return error('Unauthorized', 'authentication_error', 401, cors(origin));
    }
  }

  if (!DS_KEY) {
    return error('Server misconfigured: missing DEEPSEEK_API_KEY', 'config_error', 500, cors(origin));
  }

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const data = MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: m.created,
      owned_by: 'deepseek',
    }));
    return json({ object: 'list', data }, 200, cors(origin));
  }

  // POST /v1/chat/completions
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try {
      body = await req.json();
    } catch {
      return error('Invalid JSON body', 'invalid_request_error', 400, cors(origin));
    }

    if (!body || typeof body !== 'object') {
      return error('Request body must be a JSON object', 'invalid_request_error', 400, cors(origin));
    }

    const model = body.model;
    if (!model || !MODELS.some((m) => m.id === model)) {
      return error(
        'Unsupported model. Use one of: deepseek-chat, deepseek-reasoner',
        'model_not_found',
        400,
        cors(origin),
      );
    }

    // Pass-through to DeepSeek (OpenAI-compatible API)
    const upstreamUrl = `${DS_BASE}/v1/chat/completions`;
    const stream = !!body.stream;

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${DS_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Stream passthrough via SSE
    if (stream) {
      const headers = {
        ...cors(origin),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      };

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => upstream.statusText);
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: errText, code: upstream.status } })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(readable, { status: upstream.status, headers });
      }

      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // Non-streaming JSON passthrough
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      return json(data, upstream.status, cors(origin));
    } else {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          ...cors(origin),
          'content-type': contentType || 'text/plain; charset=utf-8',
        },
      });
    }
  }

  // 404
  return error(`Route not found: ${url.pathname}`, 'not_found', 404, cors(origin));
});
