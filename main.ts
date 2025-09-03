// deno-lint-ignore-file no-explicit-any
/**
 * Minimal OpenAI-compatible gateway for Deno Deploy / deno.dev
 * Endpoints:
 *   - GET  /v1/models
 *   - POST /v1/chat/completions   (stream: true/false)
 *
 * Mapping:
 *   - deepseek-reasoner  -> DeepSeek-R1 (对外展示名；ID 按 OpenAI 习惯仍用 deepseek-reasoner)
 *   - deepseek-chat      -> DeepSeek-V3
 *
 * Upstream:
 *   - 默认转发到 https://ai-chatbot-starter.edgeone.app/api/ai
 *   - 可通过环境变量 UPSTREAM_URL 覆盖
 */

const UPSTREAM_URL =
  Deno.env.get("UPSTREAM_URL") ??
  "https://ai-chatbot-starter.edgeone.app/api/ai";

/** 公开的模型 ID（对 OpenAI 客户端暴露） */
const SUPPORTED_MODELS = [
  "deepseek-chat",      // 对应 DeepSeek-V3
  "deepseek-reasoner",  // 对应 DeepSeek-R1
] as const;

/** 固定 created（秒级）用于更好缓存；这里填一个固定时间戳 */
const FIXED_TS = 1727740800; // 2024-10-01 00:00:00 UTC（示例）

/** CORS 辅助 */
function withCors(headers: HeadersInit = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, OpenAI-Organization, X-Requested-With",
    ...headers,
  };
}

function json(data: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: withCors({
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    }),
  });
}

/** 健康检查 */
function handleHealth() {
  return json({ ok: true, upstream: UPSTREAM_URL });
}

/** /v1/models */
function handleModels(req: Request) {
  // 可选：这里可以做鉴权、按套餐过滤模型
  const data = SUPPORTED_MODELS.map((id) => ({
    id,
    object: "model",
    created: FIXED_TS,
    owned_by: id === "deepseek-reasoner" ? "DeepSeek-R1" : "DeepSeek-V3",
  }));

  // 便于缓存
  const headers = withCors({
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  });

  return new Response(
    JSON.stringify({ object: "list", data }),
    { headers }
  );
}

/** 把 OpenAI ChatCompletions 请求 转为上游能接受的请求体 */
function buildUpstreamBody(body: any) {
  // 你的上游已经兼容 { model, messages, ... } 结构
  // 根据需要可做字段映射/约束，以下直接透传常用字段
  const {
    model,
    messages,
    temperature,
    top_p,
    max_tokens,
    // 其他字段（tools, tool_choice, response_format 等）按需扩展
  } = body ?? {};

  if (!model || !messages) {
    throw new Error("`model` and `messages` are required.");
  }
  if (!SUPPORTED_MODELS.includes(model)) {
    throw new Error(
      `Unsupported model '${model}'. Supported: ${SUPPORTED_MODELS.join(", ")}`
    );
  }

  const upstream: Record<string, unknown> = {
    model,
    messages,
  };

  if (typeof temperature === "number") upstream.temperature = temperature;
  if (typeof top_p === "number") upstream.top_p = top_p;
  if (typeof max_tokens === "number") upstream.max_tokens = max_tokens;

  return upstream;
}

/** 把上游 JSON 结果 转为 OpenAI ChatCompletions 非流式响应 */
function toOpenAIChatCompletion({
  upstreamJSON,
  model,
}: {
  upstreamJSON: any;
  model: string;
}) {
  // 兼容两种情况：
  //  1) 上游已返回 OpenAI 结构（含 choices），则尽量透传
  //  2) 上游仅返回 { content: "xxx" } 或 { response: "xxx" }，则我们包壳
  const nowSec = Math.floor(Date.now() / 1000);

  // 已经是 choices 结构
  if (upstreamJSON?.choices?.length) {
    // 填补模型名（如果缺失）
    const fixed = {
      id: upstreamJSON.id ?? `chatcmpl_${crypto.randomUUID()}`,
      object: "chat.completion",
      created: upstreamJSON.created ?? nowSec,
      model: upstreamJSON.model ?? model,
      choices: upstreamJSON.choices,
      usage: upstreamJSON.usage ?? undefined,
    };
    return fixed;
  }

  // 简单文本 -> 包装成 choices
  const text =
    upstreamJSON?.content ??
    upstreamJSON?.response ??
    upstreamJSON?.text ??
    upstreamJSON?.message ??
    "";

  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: nowSec,
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: String(text),
        },
      },
    ],
    // usage 可选：如需，可根据上游 token 用量填充
  };
}

/** 生成 SSE 数据行 */
function sseData(payload: any) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** /v1/chat/completions */
async function handleChatCompletions(req: Request) {
  const body = await req.json().catch(() => ({}));
  const stream = !!body.stream;
  const model = body.model;

  // 构造上游请求体
  let upstreamBody: any;
  try {
    upstreamBody = buildUpstreamBody(body);
  } catch (err) {
    return json(
      { error: { message: (err as Error).message, type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  // 发起上游请求（非流式）
  // （若你的上游未来支持流式，可在此做条件分支把原始 ReadableStream 透传为 SSE）
  const upstreamResp = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 这里如需鉴权，可加 Authorization: Bearer ...（例如 Deno.env.get('UPSTREAM_KEY')）
    },
    body: JSON.stringify(upstreamBody),
  });

  // 上游错误 -> 映射为 OpenAI 风格错误
  if (!upstreamResp.ok) {
    const text = await upstreamResp.text().catch(() => "");
    return json(
      {
        error: {
          message: `Upstream error ${upstreamResp.status}: ${text || upstreamResp.statusText}`,
          type: "upstream_error",
        },
      },
      { status: 502 }
    );
  }

  // 读取上游 JSON
  const upstreamJSON = await upstreamResp.json().catch(() => ({}));

  // 非流式：直接返回 OpenAI 结构
  if (!stream) {
    const payload = toOpenAIChatCompletion({ upstreamJSON, model });
    return json(payload);
  }

  // 流式：把完整结果“打包成 SSE”
  // 说明：即便上游不流式，我们也能以单个增量的形式输出，最后补 [DONE]
  const openaiObj = toOpenAIChatCompletion({ upstreamJSON, model });
  const fullText =
    openaiObj?.choices?.[0]?.message?.content ??
    "";

  const encoder = new TextEncoder();
  const streamBody = new ReadableStream({
    start(controller) {
      // OpenAI ChatCompletions 的 SSE 增量格式：{"choices":[{"delta":{"content":"..."}}]}
      controller.enqueue(encoder.encode(sseData({
        id: openaiObj.id,
        object: "chat.completion.chunk",
        created: openaiObj.created,
        model: openaiObj.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      })));

      if (fullText) {
        controller.enqueue(encoder.encode(sseData({
          id: openaiObj.id,
          object: "chat.completion.chunk",
          created: openaiObj.created,
          model: openaiObj.model,
          choices: [
            {
              index: 0,
              delta: { content: fullText },
              finish_reason: null,
            },
          ],
        })));
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(streamBody, {
    headers: withCors({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // 为了兼容某些代理/浏览器
      "Transfer-Encoding": "chunked",
    }),
  });
}

/** 路由分发 */
function route(req: Request) {
  const { pathname } = new URL(req.url);

  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: withCors() });
  }

  if (pathname === "/" || pathname === "/healthz") {
    return handleHealth();
  }

  // OpenAI 兼容接口
  if (req.method === "GET" && pathname === "/v1/models") {
    return handleModels(req);
  }

  if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
    // 可选：单模型查询
    const id = pathname.split("/").pop()!;
    if (!SUPPORTED_MODELS.includes(id as (typeof SUPPORTED_MODELS)[number])) {
      return json(
        { error: { message: `Model '${id}' not found`, type: "invalid_request_error" } },
        { status: 404 }
      );
    }
    return json({
      id,
      object: "model",
      created: FIXED_TS,
      owned_by: id === "deepseek-reasoner" ? "DeepSeek-R1" : "DeepSeek-V3",
    });
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletions(req);
  }

  return json(
    { error: { message: "Not Found", type: "invalid_request_error" } },
    { status: 404 }
  );
}

Deno.serve((req) => route(req));
