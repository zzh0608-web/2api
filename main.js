// main.js - 修复 SSE 响应解析的版本

const UPSTREAM_URL = "https://ai-chatbot-starter.edgeone.app/api/ai";

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

// 解析 SSE 格式的数据
function parseSSEData(text) {
  const lines = text.split('\n');
  const messages = [];
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6); // 移除 "data: " 前缀
      if (data === '[DONE]') {
        break;
      }
      try {
        const parsed = JSON.parse(data);
        messages.push(parsed);
      } catch (e) {
        console.error('Failed to parse SSE data:', data);
      }
    }
  }
  
  return messages;
}

// 从 SSE 消息中提取完整内容
function extractContentFromSSE(messages) {
  let fullContent = '';
  
  for (const msg of messages) {
    // 处理不同的响应格式
    if (msg.content) {
      fullContent += msg.content;
    } else if (msg.message) {
      fullContent += msg.message;
    } else if (msg.text) {
      fullContent += msg.text;
    } else if (msg.choices && msg.choices[0]) {
      const choice = msg.choices[0];
      if (choice.delta && choice.delta.content) {
        fullContent += choice.delta.content;
      } else if (choice.message && choice.message.content) {
        fullContent += choice.message.content;
      } else if (choice.text) {
        fullContent += choice.text;
      }
    } else if (msg.delta && msg.delta.content) {
      fullContent += msg.delta.content;
    }
  }
  
  return fullContent || '无响应内容';
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

    const modelName = requestBody.model || "deepseek-chat";
    
    // 构建上游请求体
    const upstreamBody = {
      model: modelName,
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

    // 读取响应文本
    const responseText = await upstreamResponse.text();
    console.log("Raw response:", responseText.substring(0, 200)); // 调试日志
    
    let content = '';
    
    // 检查响应是否是 SSE 格式
    if (responseText.startsWith('data: ')) {
      // 解析 SSE 格式
      const messages = parseSSEData(responseText);
      content = extractContentFromSSE(messages);
    } else {
      // 尝试作为普通 JSON 解析
      try {
        const responseData = JSON.parse(responseText);
        // 提取内容
        if (typeof responseData === "string") {
          content = responseData;
        } else if (responseData.content) {
          content = responseData.content;
        } else if (responseData.message) {
          content = responseData.message;
        } else if (responseData.text) {
          content = responseData.text;
        } else if (responseData.choices && responseData.choices[0]) {
          const choice = responseData.choices[0];
          content = choice.message?.content || choice.text || '';
        } else {
          content = JSON.stringify(responseData);
        }
      } catch (e) {
        // 如果不是 JSON，直接使用原始文本
        content = responseText;
      }
    }

    // 如果用户请求流式响应
    if (requestBody.stream) {
      return createStreamResponse(content, modelName);
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
      usage: {
        prompt_tokens: estimateTokens(JSON.stringify(requestBody.messages)),
        completion_tokens: estimateTokens(content),
        total_tokens: 0
      }
    };
    
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

// 创建流式响应
function createStreamResponse(content, modelName) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendSSE = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // 分块发送内容
      const chunkSize = 30;
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
        await new Promise(resolve => setTimeout(resolve, 20));
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
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// 生成随机ID
function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// 估算token数量
function estimateTokens(text) {
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
        version: "1.0.1",
        endpoints: {
          models: "GET /v1/models",
          chat: "POST /v1/chat/completions"
        },
        supported_models: ["deepseek-chat", "deepseek-reasoner"],
        note: "Compatible with OpenAI SDK"
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
