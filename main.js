// main.js - 修复后的版本

const UPSTREAM_URL = "https://ai-chatbot-starter.edgeone.app/api/ai";

// 反向模型映射（用于显示，但不用于上游请求）
const MODEL_DISPLAY_NAMES = {
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

    // **重要修改：不进行模型名映射，直接使用原始模型名**
    const modelName = requestBody.model || "deepseek-chat";
    
    // 构建上游请求体
    const upstreamBody = {
      model: modelName,  // 直接传递原始模型名
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
      return handleStreamResponse(upstreamBody, modelName);
    }

    // 发送请求到上游服务
    const upstreamResponse = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Origin": "https://ai-chatbot-starter.edgeone.app",
        "Referer": "https://ai-chatbot-starter.edgeone.app/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(upstreamBody)
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error("Upstream error:", errorText);
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
    
    // 提取响应内容 - 处理不同的响应格式
    let content = "";
    if (typeof responseData === "string") {
      content = responseData;
    } else if (responseData.content) {
      content = responseData.content;
    } else if (responseData.message) {
      content = responseData.message;
    } else if (responseData.text) {
      content = responseData.text;
    } else if (responseData.choices && responseData.choices[0]) {
      content = responseData.choices[0].message?.content || responseData.choices[0].text || "";
    } else {
      // 如果都没有，尝试将整个响应转为字符串
      content = JSON.stringify(responseData);
    }
    
    // 转换为 OpenAI 格式的响应
    const openAIResponse = {
      id: `chatcmpl-${generateId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content
        },
        finish_reason: "stop"
      }],
      usage: responseData.usage || {
        prompt_tokens: estimateTokens(JSON.stringify(requestBody.messages)),
        completion_tokens: estimateTokens(content),
        total_tokens: 0
      }
    };
    
    // 计算总tokens
    openAIResponse.usage.total_tokens = openAIResponse.usage.prompt_tokens + openAIResponse.usage.completion_tokens;

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
        // 发送SSE数据的辅助函数
        const sendSSE = (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // 请求上游服务
        const response = await fetch(UPSTREAM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://ai-chatbot-starter.edgeone.app",
            "Referer": "https://ai-chatbot-starter.edgeone.app/",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
          },
          body: JSON.stringify(upstreamBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upstream error: ${errorText}`);
        }

        const responseData = await response.json();
        
        // 提取内容
        let content = "";
        if (typeof responseData === "string") {
          content = responseData;
        } else if (responseData.content) {
          content = responseData.content;
        } else if (responseData.message) {
          content = responseData.message;
        } else if (responseData.text) {
          content = responseData.text;
        } else if (responseData.choices && responseData.choices[0]) {
          content = responseData.choices[0].message?.content || responseData.choices[0].text || "";
        } else {
          content = JSON.stringify(responseData);
        }
        
        // 分块发送内容
        const chunkSize = 20; // 每块字符数
        const chunks = [];
        for (let i = 0; i < content.length; i += chunkSize) {
          chunks.push(content.slice(i, i + chunkSize));
        }
        
        for (const chunk of chunks) {
          sendSSE({
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          });
          await new Promise(resolve => setTimeout(resolve, 30));
        }

        // 发送结束标记
        sendSSE({
          id: `chatcmpl-${generateId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        console.error("Stream error:", error);
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
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// 估算token数量（简单实现）
function estimateTokens(text) {
  // 粗略估算：每4个字符约等于1个token
  return Math.ceil(text.length / 4);
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
        version: "1.0.0",
        endpoints: {
          models: "/v1/models",
          chat: "/v1/chat/completions"
        },
        supported_models: ["deepseek-chat", "deepseek-reasoner"],
        model_mappings: MODEL_DISPLAY_NAMES
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

// Deno Deploy 入口点
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
