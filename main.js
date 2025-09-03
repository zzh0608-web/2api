// main.ts — OpenAI 兼容 + /api/ai 无需前端鉴权
type ChatMessage = { role: "system" | "user" | "assistant" | "tool" | "function"; content: string } & Record<string, unknown>;
type ChatBody = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
} & Record<string, unknown>;

const MODEL_MAP: Record<string, string> = {
  "deepseek-chat": "deepseek-chat",         // DeepSeek-V3
  "DeepSeek-V3": "deepseek-chat",
  "deepseek-reasoner": "deepseek-reasoner", // DeepSeek-R1
  "DeepSeek-R1": "deepseek-reasoner",
};

const upstreamBase = Deno.env.get("DEEPSEEK_BASE_URL")?.replace(/\/+$/, "") || "https://api.deepseek.com";
const upstreamChatURL = `${upstreamBase}/v1/chat/completions`;
const apiKey = Deno.env.get("DEEPSEEK_API_KEY");

// 可选：限制允许的来源（逗号分隔），不设则为 *
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map(s => s.trim()).filter(Boolean);
function corsHeaders(origin: string | null) {
  const allowOrigin = allowedOrigins.length ? (origin && allowedOrigins.includes(origin) ? origin : "") : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin || "null",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept,Origin,Referer,User-Agent,Sec-CH-UA,Sec-CH-UA-Mobile,Sec-CH-UA-Platform",
  };
}
function json(data: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function handleModels(origin: string | null) {
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
