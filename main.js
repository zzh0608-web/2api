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
Deno.serve({ port: 8000 }, handleRequest);
