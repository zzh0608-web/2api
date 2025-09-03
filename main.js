// main.js - OpenAI 兼容接口封装（纯 JavaScript）
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const TARGET_API_URL = "https://ai-chatbot-starter.edgeone.app/api/ai";

// 模型映射
const MODEL_MAPPING = {
  "deepseek-reasoner": "DeepSeek-R1",
  "deepseek-chat": "DeepSeek-V3"
};

// CORS 头部配置
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * 处理 /v1/models 请求
 */
async function handleModels() {
  const models = [
    {
      id: "deepseek-reasoner",
      object: "model",
      created: Date.now(),
      owned_by: "deepseek",
      permission: [],
      root: "deepseek-reasoner",
      parent: null,
    },
    {
      id: "deepseek-chat",
      object: "model",
      created: Date.now(),
      owned_by: "deepseek",
      permission: [],
      root: "deepseek-chat",
      parent: null,
    }
  ];

  return new Response(
    JSON.stringify({
      object: "list",
      data: models
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * 处理非流式响应
 */
async function handleNonStreamingChat(messages, model) {
  const targetModel = MODEL_MAPPING[model] || model;
  
  const response = await fetch(TARGET_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "accept": "*/*",
      "origin": "https://ai-chatbot-starter.edgeone.app",
      "referer": "https://ai-chatbot-starter.edgeone.app/",
    },
    body: JSON.stringify({
      model: targetModel,
      messages: messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`Target API error: ${response.status}`);
  }

  const data = await response.json();
  
  // 转换为 OpenAI 格式
  const openaiResponse = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    system_fingerprint: "fp_" + crypto.randomUUID().substring(0, 8),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: data.content || data.message || data.text || "No response",
        },
        logprobs: null,
        finish_reason: "stop",
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(openaiResponse), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

/**
 * 处理流式响应
 */
async function handleStreamingChat(messages, model) {
  const targetModel = MODEL_MAPPING[model] || model;
  
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // 异步处理流
  (async () => {
    try {
      const response = await fetch(TARGET_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "accept": "*/*",
          "origin": "https://ai-chatbot-starter.edgeone.app",
          "referer": "https://ai-chatbot-starter.edgeone.app/",
        },
        body: JSON.stringify({
          model: targetModel,
          messages: messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Target API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") continue;
          
          // 处理 SSE 格式
          if (line.startsWith("data: ")) {
            const data = line.substring(6);
            if (data === "[DONE]") {
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              break;
            }

            try {
              const parsed = JSON.parse(data);
              
              // 转换为 OpenAI 流格式
              const chunk = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                system_fingerprint: "fp_" + crypto.randomUUID().substring(0, 8),
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: parsed.content || parsed.text || "",
                    },
                    logprobs: null,
                    finish_reason: null,
                  }
                ],
              };
              
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch (e) {
              // 如果不是 JSON，直接转发内容
              const chunk = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: data,
                    },
                    finish_reason: null,
                  }
                ],
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }
        }
      }

      // 发送结束信号
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      console.error("Stream error:", error);
      const errorChunk = {
        error: {
          message: error.message,
          type: "stream_error",
        }
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * 处理 /v1/chat/completions 请求
 */
async function handleChatCompletion(request) {
  try {
    const body = await request.json();
    const { messages, model = "deepseek-chat", stream = false } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Messages array is required",
            type: "invalid_request_error",
          }
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // 检查模型是否支持
    if (!MODEL_MAPPING[model]) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Model ${model} not found. Available models: ${Object.keys(MODEL_MAPPING).join(", ")}`,
            type: "invalid_request_error",
          }
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (stream) {
      return await handleStreamingChat(messages, model);
    } else {
      return await handleNonStreamingChat(messages, model);
    }
  } catch (error) {
    console.error("Chat completion error:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || "Internal server error",
          type: "internal_error",
        }
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
}

/**
 * 主请求处理器
 */
async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理 CORS 预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // 路由处理
  switch (path) {
    case "/v1/models":
      if (request.method === "GET") {
        return await handleModels();
      }
      break;
    
    case "/v1/chat/completions":
      if (request.method === "POST") {
        return await handleChatCompletion(request);
      }
      break;
    
    case "/":
      return new Response(
        JSON.stringify({
          message: "DeepSeek OpenAI Compatible API",
          version: "1.0.0",
          endpoints: [
            "GET /v1/models",
            "POST /v1/chat/completions"
          ]
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    
    default:
      return new Response(
        JSON.stringify({
          error: {
            message: `Path ${path} not found`,
            type: "not_found",
          }
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
  }

  return new Response(
    JSON.stringify({
      error: {
        message: `Method ${request.method} not allowed for ${path}`,
        type: "method_not_allowed",
      }
    }),
    {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

// 启动服务器
serve(handler, {
  port: 8000,
  onListen: ({ hostname, port }) => {
    console.log(`🚀 Server running at http://${hostname}:${port}`);
  },
});
