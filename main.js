// deno-lint-ignore-file no-explicit-any
/**
 * Minimal OpenAI-compatible API for Deno Deploy
 * Endpoints:
 *   - GET /v1/models
 *   - POST /v1/chat/completions   (supports stream=true via SSE)
 *
 * Model mapping:
 *   deepseek-reasoner -> DeepSeek-R1
 *   deepseek-chat     -> DeepSeek-V3
 *
 * API key (optional):
 *   If DEEPSEEK_API_KEY is set, calls DeepSeek's API.
 *   Otherwise, returns a local mock completion so you can integrate without a key.
 */

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-requested-with, accept, origin, user-agent",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

type ChatMessage = { role: "system" | "user" | "assistant" | "tool" | "function"; content: string };

const MODEL_MAP: Record<string, string> = {
  "deepseek-reasoner": "DeepSeek-R1",
  "deepseek-chat": "DeepSeek-V3",
};

function json(data: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...(init.headers ?? {}) },
    status: init.status ?? 200,
  });
}

function badRequest(msg: string, extra?: Record<string, unknown>) {
  return json({ error: { message: msg, type: "invalid_request_error", ...extra } }, { status: 400 });
}

function notFound(msg = "Not found") {
  return json({ error: { message: msg, type: "invalid_request_error" } }, { status: 404 });
}

function toUnixSeconds(d = new Date()) {
  return Math.floor(d.getTime() / 1000);
}

/** --- GET /v1/models --- */
function handleModels() {
  const data = [
    { id: "deepseek-reasoner", object: "model", owned_by: "selfhost" },
    { id: "deepseek-chat", object: "model", owned_by: "selfhost" },
  ];
  return json({ object: "list", data });
}

/** Build OpenAI-compatible completion JSON */
function buildCompletion({
  id = crypto.randomUUID(),
  model,
  content,
  promptTokens = 0,
  completionTokens = 0,
}: {
  id?: string;
  model: string;
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}) {
  return {
    id,
    object: "chat.completion",
    created: toUnixSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens || Math.max(1, Math.ceil(content.length / 3)),
      total_tokens: promptTokens + (completionTokens || Math.max(1, Math.ceil(content.length / 3))),
    },
  };
}

/** Simple local mock answer when no API key is provided */
function localMockReply(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  // 极简“思考+回答”示例（非真实推理）
  const reply =
    lastUser.trim()
      ? `你说：“${lastUser}”。这是来自本地无密钥 mock 的回复，用于验证你的 OpenAI 兼容接口已打通。`
      : "这是本地无密钥 mock 的回复，用于验证你的 OpenAI 兼容接口已打通。";
  return reply;
}

/** Stream (SSE) helper for mock */
async function streamMock(model: string, content: string) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const id = crypto.randomUUID();

      // header chunk
      send({
        id,
        object: "chat.completion.chunk",
        created: toUnixSeconds(),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });

      // token-by-token (very rough: split by ~25 chars)
      const pieces = content.match(/[\s\S]{1,25}/g) ?? [content];
      let i = 0;

      const interval = setInterval(() => {
        if (i >= pieces.length) {
          // end chunk
          send({
            id,
            object: "chat.completion.chunk",
            created: toUnixSeconds(),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          clearInterval(interval);
          controller.close();
          return;
        }
        send({
          id,
          object: "chat.completion.chunk",
          created: toUnixSeconds(),
          model,
          choices: [{ index: 0, delta: { content: pieces[i++] }, finish_reason: null }],
        });
      }, 30);
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/** Call DeepSeek official API if key is present; returns OpenAI-compatible JSON or SSE Response */
async function callDeepSeek({
  model,
  messages,
  stream,
  temperature,
  top_p,
  max_tokens,
}: {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}) {
  const DS_KEY = Deno.env.get("DEEPSEEK_API_KEY");
  if (!DS_KEY) return null; // Let caller fall back to mock

  const mapped = MODEL_MAP[model];
  if (!mapped) throw new Error(`Unsupported model: ${model}`);

  const body = {
    model: mapped,
    messages,
    stream: !!stream,
    temperature,
    top_p,
    max_tokens,
  };

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${DS_KEY}`,
    },
    body: JSON.stringify(body),
  });

  
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return badRequest("Upstream DeepSeek API error", { status: resp.status, detail: text });
  }

  if (stream) {
    // Pass-through SSE stream from DeepSeek
    const headers = new Headers(resp.headers);
    // Ensure CORS
    CORS_HEADERS["vary"] && headers.set("vary", CORS_HEADERS["vary"]);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);

    return new Response(resp.body, {
      headers,
      status: 200,
    });
  }

  // Non-stream: DeepSeek returns OpenAI-compatible JSON already; add CORS
  const data = await resp.json();
  return json(data);
}

/** --- POST /v1/chat/completions --- */
async function handleChatCompletions(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const {
    model,
    messages,
    stream = false,
    temperature,
    top_p,
    max_tokens,
  } = body || {};

  if (!model || typeof model !== "string") return badRequest("Missing 'model'");
  if (!Array.isArray(messages)) return badRequest("Missing or invalid 'messages'");

  // Try DeepSeek (if key provided)
  const dsResponse = await callDeepSeek({ model, messages, stream, temperature, top_p, max_tokens });
  if (dsResponse instanceof Response) return dsResponse;
  if (dsResponse) return dsResponse as Response; // may be error JSON

  // No API key → local mock
  const mapped = MODEL_MAP[model];
  if (!mapped) return badRequest(`Unsupported model: ${model}`);

  const content = localMockReply(messages);

  if (stream) {
    return streamMock(mapped, content);
  } else {
    const result = buildCompletion({
      model: mapped,
      content,
      promptTokens: Math.max(1, JSON.stringify(messages).length / 4 | 0),
    });
    return json(result);
  }
}

/** Router */
function router(req: Request) {
  const url = new URL(req.url);
  const { pathname } = url;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    return handleModels();
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletions(req);
  }

  return notFound("Route not found");
}

export default {
  fetch: (req: Request) => router(req),
};function handleModels(origin: string | null) {
  const now = Math.floor(Date.now() / 1000);
  return json({
    object: "list",
    data: [
      { id: "deepseek-chat", object: "model", created: now, owned_by: "deepseek" },
      { id: "deepseek-reasoner", object: "model", created: now, owned_by: "deepseek" },
    ],
  }, 200, origin);
}

async function proxyChat(body: ChatBody, origin: string | null) {
  if (!apiKey) {
    return json({ error: { message: "DEEPSEEK_API_KEY is not set", type: "config_error" } }, 500, origin);
  }

  const { model, messages } = body || {};
  if (!model || !Array.isArray(messages)) {
    return json({ error: { message: "`model` and `messages` are required", type: "invalid_request_error" } }, 400, origin);
  }

  const upstreamModel = MODEL_MAP[model];
  if (!upstreamModel) {
    return json({
      error: { message: `Unsupported model: ${model}. Use "deepseek-chat" or "deepseek-reasoner".`, type: "model_not_found" },
    }, 400, origin);
  }

  const { stream = false, ...rest } = body;
  const upstreamPayload = { ...rest, model: upstreamModel, messages, stream };

  const upstreamRes = await fetch(upstreamChatURL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(upstreamPayload),
  });

  if (stream) {
    // 透传 SSE
    const headers = new Headers(corsHeaders(origin));
    headers.set("Content-Type", upstreamRes.headers.get("Content-Type") || "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
  }

  const text = await upstreamRes.text();
  const headers = new Headers({ ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" });
  return new Response(text, { status: upstreamRes.ok ? 200 : upstreamRes.status, headers });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const { pathname } = url;
  const origin = req.headers.get("Origin");

  // 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // 健康检查
  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return json({ ok: true, upstream: upstreamBase, models: ["deepseek-chat", "deepseek-reasoner"] }, 200, origin);
  }

  // GET /v1/models
  if (req.method === "GET" && pathname === "/v1/models") {
    return handleModels(origin);
  }

  // POST /v1/chat/completions  (OpenAI 兼容)
  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    try {
      const body = await req.json();
      return proxyChat(body, origin);
    } catch {
      return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400, origin);
    }
  }

  // POST /api/ai  (前端无需鉴权，等价于上面)
  if (req.method === "POST" && pathname === "/api/ai") {
    try {
      const body = await req.json();
      return proxyChat(body, origin);
    } catch {
      return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400, origin);
    }
  }

  return json({ error: { message: "Not Found", type: "invalid_request_error" } }, 404, origin);
});
