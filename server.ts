// server.ts — OpenAI-compatible proxy for DeepSeek (Deno Deploy + Hono)
// - Endpoints: GET /v1/models, POST /v1/chat/completions (stream & non-stream)
// - Models: deepseek-chat (DeepSeek-V3), deepseek-reasoner (DeepSeek-R1)
// - Upstream defaults to DeepSeek API; can be overridden via env UPSTREAM_API_URL
// - API key resolution (priority): Authorization header from client -> UPSTREAM_API_KEY env
// Deploy: Deno Deploy / any Deno runtime

// === Imports ===
import { Hono } from "https://deno.land/x/hono@v4.4.7/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.4.7/middleware/cors/index.ts";
import { stream } from "https://deno.land/x/hono@v4.4.7/streaming/index.ts";

// === Types (subset of OpenAI spec for our use) ===
type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';

interface ChatMessage {
  role: ChatRole;
  content: string | Array<unknown>;
  name?: string;
  tool_call_id?: string;
}

interface OpenAIChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[] | null;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  response_format?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  // pass-through of any unknown fields
  [k: string]: unknown;
}

interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: 'list';
  data: OpenAIModelItem[];
}

// === Config ===
const SUPPORTED_MODELS = [
  'deepseek-chat',      // DeepSeek-V3
  'deepseek-reasoner',  // DeepSeek-R1
] as const;

const DEFAULT_UPSTREAM_URL = 'https://api.deepseek.com/v1/chat/completions';

// === Utilities ===
const isValidModel = (model: string): boolean =>
  (SUPPORTED_MODELS as readonly string[]).includes(model);

const pick = <T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
};

function readEnv(name: string, c: any): string | undefined {
  return c?.env?.[name] ?? (typeof Deno !== 'undefined' ? Deno.env.get(name) ?? undefined : undefined);
}

function resolveUpstream(c: any): string {
  return readEnv('UPSTREAM_API_URL', c) || DEFAULT_UPSTREAM_URL;
}

function resolveApiKey(c: any, req: Request): string | undefined {
  const fromHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (fromHeader?.toLowerCase().startsWith('bearer ')) return fromHeader.slice(7).trim();
  return readEnv('UPSTREAM_API_KEY', c);
}

function randomIp(): string {
  return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
}

function randomUA(): string {
  const uas = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

function generateForwardHeaders(apiKey: string | undefined, isStreaming: boolean): HeadersInit {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'accept': isStreaming ? 'text/event-stream' : 'application/json',
    'user-agent': randomUA(),
    'x-forwarded-for': randomIp(),
    // DeepSeek/OpenAI compatible auth
    ...(apiKey ? { 'authorization': `Bearer ${apiKey}` } : {}),
  };
  return h;
}

function openAIError(message: string, type = 'invalid_request_error', code?: string, status = 400) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Format standard CORS headers for our responses (streaming sets headers directly)
const COMMON_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-requested-with, x-client-info',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '86400',
};

// === Handlers ===
async function handleModels(c: any) {
  const now = Math.floor(Date.now() / 1000);
  const res: OpenAIModelsResponse = {
    object: 'list',
    data: SUPPORTED_MODELS.map((id) => ({ id, object: 'model', created: now, owned_by: id === 'deepseek-chat' ? 'DeepSeek-V3' : 'DeepSeek-R1' })),
  };
  return c.json(res, 200, { 'content-type': 'application/json', ...COMMON_CORS_HEADERS });
}

async function handleChatCompletions(c: any) {
  try {
    const body = (await c.req.json()) as OpenAIChatCompletionRequest;

    // Basic validation
    if (!body?.model) return openAIError('Missing required field: model', 'invalid_request_error', 'missing_required_field', 400);
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      return openAIError('Missing required field: messages', 'invalid_request_error', 'missing_required_field', 400);
    if (!isValidModel(body.model))
      return openAIError(`Model ${body.model} not found`, 'invalid_request_error', 'model_not_found', 404);

    const upstreamUrl = resolveUpstream(c);
    if (!upstreamUrl)
      return openAIError('Upstream API URL not configured', 'server_error', 'configuration_error', 500);

    const apiKey = resolveApiKey(c, c.req.raw);
    if (!apiKey)
      return openAIError('Missing API key. Provide Authorization: Bearer <key> or set UPSTREAM_API_KEY env.', 'invalid_request_error', 'missing_api_key', 401);

    // Build forward body: pass through known OpenAI fields + any extra fields
    const known = pick(body as Record<string, unknown>, [
      'model','messages','temperature','max_tokens','top_p','frequency_penalty','presence_penalty','stop','n','stream','logit_bias','user','response_format','tools','tool_choice'
    ]);

    const isStreaming = body.stream === true;

    const forwardHeaders = generateForwardHeaders(apiKey, isStreaming);

    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(known),
    });

    if (!upstreamResp.ok) {
      // Try extracting upstream error for better messaging
      let upstreamErrText = '';
      let upstreamErrJson: any = null;
      try { upstreamErrText = await upstreamResp.clone().text(); } catch {}
      try { upstreamErrJson = JSON.parse(upstreamErrText); } catch {}

      // Detect quota style error message variants
      const errorStr = typeof upstreamErrJson?.error === 'string' ? upstreamErrJson.error : (upstreamErrJson?.error?.message ?? upstreamErrText);
      if (typeof errorStr === 'string' && /daily\s+usage\s+limit\s+exceeded/i.test(errorStr)) {
        return c.json({
          error: {
            message: 'API调用次数已达每日限制，请明天再试。如需更多使用量，请联系服务提供商。',
            type: 'quota_exceeded',
            code: 'daily_limit_exceeded',
            details: errorStr,
            remaining: upstreamErrJson?.remaining ?? 0,
          },
        }, 429, { 'content-type': 'application/json', ...COMMON_CORS_HEADERS });
      }

      const status = upstreamResp.status || 500;
      const message = errorStr || `Upstream API error: ${upstreamResp.status} ${upstreamResp.statusText}`;
      return c.json({ error: { message, type: 'server_error', code: 'upstream_error', status } }, status, { 'content-type': 'application/json', ...COMMON_CORS_HEADERS });
    }

    // Streaming passthrough
    if (isStreaming) {
      c.header('content-type', 'text/event-stream; charset=utf-8');
      c.header('cache-control', 'no-cache');
      c.header('connection', 'keep-alive');
      c.header('content-encoding', 'identity');
      c.header('x-content-type-options', 'nosniff');
      c.header('access-control-allow-origin', '*');

      return stream(c, async (writer) => {
        const body = upstreamResp.body;
        if (!body) {
          await writer.write('data: [DONE]\n\n');
          return;
        }
        const reader = body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(decoder.decode(value, { stream: true }));
          }
        } catch {
          // swallow to finalize SSE
        } finally {
          try { reader.releaseLock(); } catch {}
          await writer.write('\n');
        }
      });
    }

    // Non-stream JSON passthrough
    const data = await upstreamResp.json();
    return c.json(data, 200, { 'content-type': 'application/json', ...COMMON_CORS_HEADERS });
  } catch (err) {
    console.error('Chat completions error:', err);
    return new Response(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' } }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...COMMON_CORS_HEADERS },
    });
  }
}

// === App ===
const app = new Hono();

// CORS (handles OPTIONS automatically)
app.use('*', cors({
  origin: '*',
  allowHeaders: ['authorization', 'content-type', 'x-requested-with', 'x-client-info'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400,
}));

// Health
app.get('/health', (c) => c.text('ok'));

// Models
app.get('/v1/models', handleModels);

// Chat Completions
app.post('/v1/chat/completions', handleChatCompletions);

// Root
app.get('/', (c) => c.json({ name: 'openai-compatible-proxy', status: 'ok', endpoints: ['/v1/models', '/v1/chat/completions'] }));

// === Serve ===
Deno.serve(app.fetch);
