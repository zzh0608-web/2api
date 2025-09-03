// main.js - Deno Deploy 入口文件

const UPSTREAM_URL = "https://ai-chatbot-starter.edgeone.app/api/ai";

// 模型映射配置
const MODEL_MAPPING = {
  "deepseek-reasoner": "DeepSeek-R1",
  "deepseek-chat": "DeepSeek-V3"
};

// CORS 头配置
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// 主请求处理函数
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理 OPTIONS 预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // 路由处理
  switch (path) {
    case "/v1/models":
      return handleModelsRequest();
    case "/v1/chat/completions":
      return handleChatCompletions(request);
    default:
      return new Response(JSON.stringify({
        error: {
          message: `Path ${path} not found`,
          type: "invalid_request_error",
          code: "404"
        }
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
  }
}

// 处理 /v1/models 端点
function handleModelsRequest() {
  const models = [
    {
      id: "deepseek-reasoner",
      object: "model",
      created: 1735689600,
      owned_by: "deepseek",
      permission: [],
      root: "deepseek-reasoner",
      parent: null
    },
    {
      id: "deepseek-chat",
      object: "model",
      created: 1735689600,
      owned_by: "deepseek",
      permission: [],
      root: "deepseek-chat",
      parent: null
    }
  ];

  return new Response(JSON.stringify({
    object: "list",
    data: models
  }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}

// 处理 /v1/chat/completions 端点
async function handleChatCompletions(request) {
  try {
    // 解析请求体
    const body = await request.json();
    
    // 验证必需字段
    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({
        error: {
          message: "Messages array is required",
          type: "invalid_request_error",
          code: "invalid_messages"
        }
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }

    // 设置默认模型
    if (!body.model) {
      body.model = "deepseek-chat";
    }

    // 检查是否为流式请求
    const isStream = body.stream === true;

    // 构建上游请求
    const upstreamRequest = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature || 1.0,
      top_p: body.top_p || 1.0,
      max_tokens: body.max_tokens,
      stream: isStream,
      presence_penalty: body.presence_penalty || 0,
      frequency_penalty: body.frequency_penalty || 0,
      n: body.n || 1,
      stop: body.stop
    };

    // 发送请求到上游 API
    const upstreamResponse = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Origin": "https://ai-chatbot-starter.edgeone.app",
        "Referer": "https://ai-chatbot-starter.edgeone.app/",
        "User-Agent": "Mozilla/5.0 (compatible; DenoProxy/1.0)"
      },
      body: JSON.stringify(upstreamRequest)
    });

    // 处理流式响应
    if (isStream) {
      return handleStreamResponse(upstreamResponse, body.model);
    }

    // 处理非流式响应
    const responseData = await upstreamResponse.text();
    
    // 尝试解析响应
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseData);
    } catch (e) {
      // 如果上游返回的是纯文本，构造标准响应
      parsedResponse = {
        id: `chatcmpl-${generateId()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: responseData
          },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
    }

    // 确保响应格式符合 OpenAI 标准
    const standardResponse = {
      id: parsedResponse.id || `chatcmpl-${generateId()}`,
      object: "chat.completion",
      created: parsedResponse.created || Math.floor(Date.now() / 1000),
      model: body.model,
      choices: parsedResponse.choices || [{
        index: 0,
        message: {
          role: "assistant",
          content: parsedResponse.content || parsedResponse.message || responseData
        },
        finish_reason: "stop"
      }],
      usage: parsedResponse.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    return new Response(JSON.stringify(standardResponse), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });

  } catch (error) {
    console.error("Error in handleChatCompletions:", error);
    return new Response(JSON.stringify({
      error: {
        message: error.message || "Internal server error",
        type: "internal_error",
        code: "internal_error"
      }
    }), {
      status: 500,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
}

// 处理流式响应
async function handleStreamResponse(upstreamResponse, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  // 创建转换流
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      
      for (const line of lines) {
        if (line.trim() === '') continue;
        
        // 转换为 SSE 格式
        if (line.startsWith('data: ')) {
          controller.enqueue(encoder.encode(line + '\n\n'));
        } else {
          // 构造 SSE 数据
          const sseData = {
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {
                content: line
              },
              finish_reason: null
            }]
          };
          
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseData)}\n\n`));
        }
      }
    }
  });

  return new Response(upstreamResponse.body.pipeThrough(transformStream), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

// 生成随机 ID
function generateId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Deno Deploy 入口点
Deno.serve({ port: 8000 }, handleRequest);  return json(
    { error: { message: msg, type: "invalid_request_error", ...extra } },
    { status: 400 },
  );
}

function notFound(msg = "Not found") {
  return json({ error: { message: msg, type: "invalid_request_error" } }, {
    status: 404,
  });
}

function toUnixSeconds(d = new Date()) {
  return Math.floor(d.getTime() / 1000);
}

// --- GET /v1/models ---
function handleModels() {
  const data = [
    { id: "deepseek-reasoner", object: "model", owned_by: "selfhost" },
    { id: "deepseek-chat", object: "model", owned_by: "selfhost" },
  ];
  return json({ object: "list", data });
}

function buildCompletion({ id = crypto.randomUUID(), model, content }) {
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
      prompt_tokens: 0,
      completion_tokens: Math.max(1, Math.ceil(content.length / 3)),
      total_tokens: Math.max(1, Math.ceil(content.length / 3)),
    },
  };
}

function localMockReply(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
    ?.content || "";
  return lastUser.trim()
    ? `你说：“${lastUser}”。这是本地 mock 回复（无密钥情况下）。`
    : "这是本地 mock 回复（无密钥情况下）。";
}

async function streamMock(model, content) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const id = crypto.randomUUID();

      send({
        id,
        object: "chat.completion.chunk",
        created: toUnixSeconds(),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });

      const pieces = content.match(/[\s\S]{1,25}/g) || [content];
      let i = 0;

      const interval = setInterval(() => {
        if (i >= pieces.length) {
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

async function callDeepSeek({ model, messages, stream }) {
  const DS_KEY = Deno.env.get("DEEPSEEK_API_KEY");
  if (!DS_KEY) return null;

  const mapped = MODEL_MAP[model];
  if (!mapped) throw new Error(`Unsupported model: ${model}`);

  const body = { model: mapped, messages, stream: !!stream };

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
    return badRequest("DeepSeek API error", { status: resp.status, detail: text });
  }

  if (stream) {
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(resp.body, { headers, status: 200 });
  }

  const data = await resp.json();
  return json(data);
}

async function handleChatCompletions(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const { model, messages, stream = false } = body || {};
  if (!model) return badRequest("Missing 'model'");
  if (!Array.isArray(messages)) return badRequest("Missing or invalid 'messages'");

  const dsResponse = await callDeepSeek({ model, messages, stream });
  if (dsResponse) return dsResponse;

  const mapped = MODEL_MAP[model];
  if (!mapped) return badRequest(`Unsupported model: ${model}`);

  const content = localMockReply(messages);

  if (stream) {
    return streamMock(mapped, content);
  } else {
    return json(buildCompletion({ model: mapped, content }));
  }
}

function router(req) {
  const url = new URL(req.url);
  const { pathname } = url;

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
  fetch: (req) => router(req),
};
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
