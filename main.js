// main.js - Deno Deploy 兼容的 OpenAI API 封装

const UPSTREAM_URL = "https://ai-chatbot-starter.edgeone.app/api/ai";

// 模型映射关系
const MODEL_MAPPING = {
  "deepseek-reasoner": "DeepSeek-R1",
  "deepseek-chat": "DeepSeek-V3"
};

// CORS 响应头
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// 处理 /v1/models 端点
async function handleModels() {
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
    headers: CORS_HEADERS
  });
}

// 处理 /v1/chat/completions 端点
async function handleChatCompletions(request) {
  try {
    const requestBody = await request.json();
    
    // 验证请求体
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return new Response(JSON.stringify({
        error: {
          message: "Messages array is required",
          type: "invalid_request_error",
          param: "messages",
          code: null
        }
      }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    // 构建上游请求体，使用映射后的模型名
    const upstreamModel = MODEL_MAPPING[requestBody.model] || requestBody.model || "deepseek-chat";
    const upstreamBody = {
      model: upstreamModel,
      messages: requestBody.messages,
      temperature: requestBody.temperature || 1,
      top_p: requestBody.top_p || 1,
      n: requestBody.n || 1,
      stream: requestBody.stream || false,
      max_tokens: requestBody.max_tokens,
      presence_penalty: requestBody.presence_penalty || 0,
      frequency_penalty: requestBody.frequency_penalty || 0,
      user: requestBody.user
    };

    // 移除未定义的字段
    Object.keys(upstreamBody).forEach(key => 
      upstreamBody[key] === undefined && delete upstreamBody[key]
    );

    // 处理流式响应
    if (requestBody.stream) {
      return handleStreamResponse(upstreamBody, requestBody.model);
    }

    // 发送请求到上游服务
    const upstreamResponse = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0 (compatible; DenoProxy/1.0)"
      },
      body: JSON.stringify(upstreamBody)
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      return new Response(JSON.stringify({
        error: {
          message: `Upstream service error: ${errorText}`,
          type: "upstream_error",
          code: upstreamResponse.status
        }
      }), {
        status: upstreamResponse.status,
        headers: CORS_HEADERS
      });
    }

    const responseData = await upstreamResponse.json();
    
    // 转换为 OpenAI 格式的响应
    const openAIResponse = {
      id: `chatcmpl-${generateId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestBody.model || "deepseek-chat",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: responseData.content || responseData.message || responseData.text || "No response content"
        },
        finish_reason: "stop"
      }],
      usage: responseData.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: CORS_HEADERS
    });

  } catch (error) {
    console.error("Error in handleChatCompletions:", error);
    return new Response(JSON.stringify({
      error: {
        message: error.message,
        type: "internal_error",
        code: null
      }
    }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }
}

// 处理流式响应
async function handleStreamResponse(upstreamBody, modelName) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 发送SSE数据
        const sendSSE = (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // 模拟流式响应（实际应从上游获取）
        const response = await fetch(UPSTREAM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "*/*"
          },
          body: JSON.stringify(upstreamBody)
        });

        const responseData = await response.json();
        const content = responseData.content || responseData.message || responseData.text || "";
        
        // 分块发送内容
        const chunks = content.match(/.{1,10}/g) || [];
        for (const chunk of chunks) {
          sendSSE({
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName || "deepseek-chat",
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          });
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        // 发送结束标记
        sendSSE({
          id: `chatcmpl-${generateId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName || "deepseek-chat",
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// 生成随机ID
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

// 主请求处理器
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理 OPTIONS 请求（CORS 预检）
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // 路由处理
  switch (path) {
    case "/v1/models":
      if (request.method === "GET") {
        return handleModels();
      }
      break;
    
    case "/v1/chat/completions":
      if (request.method === "POST") {
        return handleChatCompletions(request);
      }
      break;

    case "/":
      return new Response(JSON.stringify({
        message: "OpenAI API Proxy for DeepSeek",
        endpoints: {
          models: "/v1/models",
          chat: "/v1/chat/completions"
        },
        supported_models: Object.keys(MODEL_MAPPING)
      }), {
        status: 200,
        headers: CORS_HEADERS
      });
    
    default:
      return new Response(JSON.stringify({
        error: {
          message: `Path ${path} not found`,
          type: "invalid_request_error",
          code: "not_found"
        }
      }), {
        status: 404,
        headers: CORS_HEADERS
      });
  }

  return new Response(JSON.stringify({
    error: {
      message: `Method ${request.method} not allowed for ${path}`,
      type: "invalid_request_error",
      code: "method_not_allowed"
    }
  }), {
    status: 405,
    headers: CORS_HEADERS
  });
}

// Deno Deploy 入口点 - 只使用 addEventListener
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

// 仅在本地开发环境使用 Deno.serve
// 通过环境变量 DENO_DEPLOYMENT_ID 判断是否在 Deno Deploy 环境
if (typeof Deno !== "undefined" && !Deno.env.get("DENO_DEPLOYMENT_ID")) {
  // 只在本地运行时才使用 Deno.serve
  if (Deno.serve) {
    console.log("Running in local development mode on http://localhost:8000");
    Deno.serve({ port: 8000 }, handleRequest);
  }
}
