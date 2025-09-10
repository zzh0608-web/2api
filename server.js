
// 仅为兼容性演示用途；生产请自行加固。

/* ====================== 配置与模型映射 ====================== */

const MaxContextTokens = 2000; 

const modelMap = {
  "deepseek-reasoner": "deepseek_r1",
  "deepseek-chat": "deepseek_v3",
  "o3-mini-high": "openai_o3_mini_high",
  "o1": "openai_o1",
  "gpt5": "gpt_5",
  "gpt5-mini": "gpt_5_mini",
  "gpt-4o": "gpt_4o",
  "gpt-4o-mini": "gpt_4o_mini",
  "claude-3-opus": "claude_3_opus",
  "claude-3.5-sonnet": "claude_3_5_sonnet",
  "gemini-1.5-pro": "gemini_1_5_pro",
  "gemini-2.0-flash": "gemini_2_flash",
  "llama-3.3-70b": "llama3_3_70b",
  "llama-4-maverick": "llama4_maverick",
  "llama-4-scout": "llama4_scout",
  "mistral-large-2": "mistral_large_2",
  "qwen3-235b": "qwen3_235b",
  "qwq-32b": "qwq_32b",
  "qwen-2.5-72b": "qwen2p5_72b",
  "qwen-2.5-coder-32b": "qwen2p5_coder_32b",
  "command-r-plus": "command_r_plus",
  "claude-3-7-sonnet": "claude_3_7_sonnet",
  "claude-3-7-sonnet-think": "claude_3_7_sonnet_thinking",
  "claude-4-sonnet": "claude_4_sonnet",
  "claude-4-sonnet-think": "claude_4_sonnet_thinking",
  "claude-4-opus": "claude_4_opus",
  "claude-4-1-opus": "claude_4_1_opus",
  "claude-4-opus-think": "claude_4_opus_thinking",
  "claude-4-1-opus-think": "claude_4_1_opus_thinking",
  "gemini-2.5-pro": "gemini_2_5_pro_preview",
  "o3": "openai_o3",
  "o3-pro": "openai_o3_pro",
  "o4-mini-high": "openai_o4_mini_high",
  "gpt-4.1": "gpt_4_1",
  "grok-4": "grok_4",
  "grok-3-beta": "grok_3",
  "grok-3-mini": "grok_3_mini",
  "grok-2": "grok_2",
  "nous-hermes-2": "nous_hermes_2",
};

function getReverseModelMap() {
  const rev = {};
  for (const k in modelMap) rev[modelMap[k]] = k;
  return rev;
}
function mapModelName(openAIModel) {
  return modelMap[openAIModel] ?? "deepseek_v3";
}
const reverseMap = getReverseModelMap();

const agentModelIDs =
  (Deno.env.get("AGENT_MODEL_IDS")?.split(",").map((s) => s.trim()) ?? []);
function isAgentModel(id) {
  return agentModelIDs.includes(id);
}

/* ====================== 类型帮助======================
OpenAI-like Request:
{
  "model": "deepseek-chat",
  "stream": true|false,
  "messages": [
    { "role":"system"|"user"|"assistant",
      "content": string | [
         { "type":"text", "text":"..." } |
         { "type":"image_url", "image_url":{"url":"http.. or data:"} }
      ]
    }
  ]
}
============================================================= */

/* ====================== 工具函数 ====================== */

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p?.type === "text" && typeof p.text === "string" ? p.text : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function hasImageContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (p) => p && p.type === "image_url" && p.image_url && p.image_url.url,
  );
}

function countTokens(content) {
  const text = extractTextContent(content);
  const base = text.trim() ? text.trim().split(/\s+/).length : 0;
  let imageCount = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "image_url") imageCount++;
    }
  }
  return base + imageCount * 85; 
}

function countTokensForMessages(messages) {
  let total = 0;
  for (const m of messages) total += countTokens(m.content ?? m.Content) + 2;
  return total;
}

function convertSystemToUserMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages ?? [];
  let sys = "";
  const rest = [];
  for (const m of messages) {
    if (m.role === "system") {
      const t = extractTextContent(m.content);
      sys += (sys ? "\n" : "") + t;
    } else {
      rest.push(m);
    }
  }
  if (sys) {
    return [{ role: "user", content: sys }, ...rest];
  }
  return rest;
}

function ensurePlainText(str) {
  // 只保留：ASCII 可打印(32-126)、基本汉字(4E00-9FA5)、中文标点(3000-303F)、\n \r；其余替空格
  let out = "";
  for (const ch of str ?? "") {
    const c = ch.codePointAt(0);
    if (
      (c >= 32 && c <= 126) || (c >= 0x4E00 && c <= 0x9FA5) ||
      (c >= 0x3000 && c <= 0x303F) || c === 0x0A || c === 0x0D
    ) out += ch;
    else out += " ";
  }
  return out;
}

function addUTF8BOM(str) {
  const enc = new TextEncoder();
  const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const bytes = enc.encode(ensurePlainText(str ?? ""));
  const buff = new Uint8Array(BOM.length + bytes.length);
  buff.set(BOM, 0);
  buff.set(bytes, BOM.length);
  return buff;
}

function generateShortFileName() {
  const charset = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += charset[Math.floor(Math.random() * charset.length)];
  }
  return s;
}
function generateRandomString(length = 6) {
  const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < length; i++) {
    s += charset[Math.floor(Math.random() * charset.length)];
  }
  return s;
}

function getCookies(ds) {
  return {
    guest_has_seen_legal_disclaimer: "true",
    youchat_personalization: "true",
    DS: ds, // 关键 cookie
    you_subscription: "youpro_standard_year",
    youpro_subscription: "true",
    ai_model: "deepseek_r1",
    youchat_smart_learn: "true",
  };
}
function cookieHeaderStr(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join(";");
}

/* ====================== you.com 上传 ====================== */

async function getNonce(dsToken) {
  const resp = await fetch("https://you.com/api/get_nonce", {
    headers: { Cookie: `DS=${dsToken}` },
  });
  const text = await resp.text();
  return { uuid: text.trim() };
}

async function uploadFile(dsToken, bytes, filename) {
  const form = new FormData();
  // 以 text/plain 为主（.txt 一致），也能上传图像
  form.append("file", new File([bytes], filename));
  const resp = await fetch("https://you.com/api/upload", {
    method: "POST",
    headers: { Cookie: `DS=${dsToken}` },
    body: form,
  });
  console.log("文件上传响应状态码:", resp.status);
  const body = await resp.text();
  if (!resp.ok) {
    console.log("文件上传错误响应内容:", body);
    throw new Error(`上传文件失败，状态码: ${resp.status}`);
  }
  console.log("文件上传响应内容:", body);
  const parsed = JSON.parse(body);
  console.log(
    "上传文件成功: filename=%s, user_filename=%s",
    parsed?.filename,
    parsed?.user_filename,
  );
  return { Filename: parsed.filename, UserFilename: parsed.user_filename };
}

function inferExtByMime(mime) {
  if (!mime) return ".png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

function decodeDataUrl(dataUrl) {
  // data:[mime];base64,XXXX
  const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error("无效的 data URL");
  const mime = m[1];
  const raw = m[2];
  const bin = atob(raw);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const filename = `${generateRandomString(6)}_image${inferExtByMime(mime)}`;
  return { bytes: u8, filename };
}

async function downloadImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`);
  const arr = new Uint8Array(await resp.arrayBuffer());
  let filename;
  try {
    const u = new URL(url);
    filename = u.pathname.split("/").pop() || "downloaded_image.jpg";
  } catch {
    filename = "downloaded_image.jpg";
  }
  return { bytes: arr, filename };
}

async function processImageContent(content, dsToken) {
  // 提取文本 + 上传每张图片，返回 sources JSON 字符串
  let text = "";
  const sources = [];
  if (!Array.isArray(content)) return { text: extractTextContent(content), sourcesJSON: "[]" };
  for (const part of content) {
    if (part?.type === "text") text += (text ? "\n" : "") + (part.text ?? "");
    if (part?.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      let bytes, filename;
      if (url.startsWith("data:")) {
        ({ bytes, filename } = decodeDataUrl(url));
      } else {
        ({ bytes, filename } = await downloadImage(url));
      }
      const up = await uploadFile(dsToken, bytes, filename);
      sources.push({
        source_type: "user_file",
        filename: up.Filename,
        user_filename: up.UserFilename,
        size_bytes: bytes.byteLength,
      });
    }
  }
  return { text, sourcesJSON: JSON.stringify(sources) };
}

/* ====================== SSE 解析（youChatToken） ====================== */

async function collectYouTokensStream(resp) {
  // 解析 SSE，收集 youChatToken
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let expectData = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("event:")) {
        expectData = line.startsWith("event: youChatToken");
      } else if (expectData && line.startsWith("data:")) {
        const j = line.slice(6);
        try {
          const obj = JSON.parse(j);
          const t = obj?.youChatToken ?? "";
          full += t;
        } catch {
          // ignore
        }
        expectData = false;
      }
    }
  }
  return full;
}

async function streamOpenAIChunks(youUrl, youHeaders, modelForResp) {
  // 第二次请求 you.com，并把 youChatToken 转成 OpenAI 流式 chunk
  const resp = await fetch(youUrl, { headers: youHeaders });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    return new Response(text || "upstream error", { status: resp.status || 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let expectData = false;

      // 设置 OpenAI SSE 响应头的起始（不发送 role 起始帧，保持与原代码兼容性）
      // 注意：没有发送 [DONE]，这里也不发送。

      function sendChunk(content) {
        const chunk = {
          id: "chatcmpl-" + Math.floor(Date.now() / 1000),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelForResp,
          choices: [{ delta: { content }, index: 0, finish_reason: "" }],
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }

      controller.enqueue(enc.encode(`:`)); // comment to kick off stream for some clients

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);

          if (line.startsWith("event:")) {
            expectData = line.startsWith("event: youChatToken");
          } else if (expectData && line.startsWith("data:")) {
            const j = line.slice(6);
            try {
              const obj = JSON.parse(j);
              const t = obj?.youChatToken ?? "";
              if (t) sendChunk(t);
            } catch { /* ignore */ }
            expectData = false;
          }
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/* ====================== 路由与主处理 ====================== */

let originalModel = ""; 

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

Deno.serve(async (req) => {
  // 统一处理 OPTIONS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const url = new URL(req.url);

  // /v1/models 或 /api/v1/models
  if (url.pathname === "/v1/models" || url.pathname === "/api/v1/models") {
    const created = Math.floor(Date.now() / 1000);
    const base = Object.keys(modelMap).map((id) => ({
      id, object: "model", created, owned_by: "organization-owner",
    }));
    const agents = agentModelIDs.map((id) => ({
      id, object: "model", created, owned_by: "organization-owner",
    }));
    const body = { object: "list", data: [...base, ...agents] };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  // 非 chat-completions 
  if (
    url.pathname !== "/v1/chat/completions" &&
    url.pathname !== "/none/v1/chat/completions" &&
    url.pathname !== "/such/chat/completions"
  ) {
    return new Response(
      JSON.stringify({ status: "You2Api Service Running...", message: "MoLoveSze..." }),
      { headers: { "Content-Type": "application/json", ...corsHeaders() } },
    );
  }

  // 认证：Authorization: Bearer <DS>
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Missing or invalid authorization header", {
      status: 401,
      headers: corsHeaders(),
    });
  }
  const dsToken = auth.slice("Bearer ".length);

  // 解析 OpenAI 兼容请求
  let openAIReq;
  try {
    openAIReq = await req.json();
  } catch {
    return new Response("Invalid request body", { status: 400, headers: corsHeaders() });
  }
  originalModel = openAIReq?.model || "";

  // 折叠 system 到首条 user
  openAIReq.messages = convertSystemToUserMessages(openAIReq.messages);

  // 构建聊天历史（Q/A 列表，不包含最后一条）
  const chatHistory = [];
  let currentQuestion = "", currentAnswer = "";
  let hasQuestion = false, hasAnswer = false;

  for (let i = 0; i < (openAIReq.messages?.length ?? 0) - 1; i++) {
    const msg = openAIReq.messages[i];
    if (msg.role === "user") {
      if (hasQuestion && hasAnswer) {
        chatHistory.push({ Question: currentQuestion, Answer: currentAnswer });
        currentQuestion = extractTextContent(msg.content);
        currentAnswer = "";
        hasQuestion = true; hasAnswer = false;
      } else if (hasQuestion) {
        currentQuestion += "\n" + extractTextContent(msg.content);
      } else {
        currentQuestion = extractTextContent(msg.content);
        hasQuestion = true;
      }
    } else if (msg.role === "assistant") {
      if (hasQuestion) {
        currentAnswer = extractTextContent(msg.content); hasAnswer = true;
      } else if (hasAnswer) {
        currentAnswer += "\n" + extractTextContent(msg.content);
      } else {
        currentQuestion = ""; currentAnswer = extractTextContent(msg.content);
        hasQuestion = true; hasAnswer = true;
      }
    }
  }
  if (hasQuestion) {
    chatHistory.push({ Question: currentQuestion, Answer: hasAnswer ? currentAnswer : "" });
  }

  // 针对过长的历史问答上传文件（>=30“token”估算），并替换为“查看这个文件…”
  const sources = [];
  for (let i = 0; i < chatHistory.length; i++) {
    const entry = chatHistory[i];

    if (entry.Question) {
      const tk = countTokensForMessages([{ role: "user", content: entry.Question }]);
      if (tk >= 30) {
        await getNonce(dsToken).catch(() => {}); 
        const fileName = generateShortFileName() + ".txt";
        const bytes = addUTF8BOM(entry.Question);
        const up = await uploadFile(dsToken, bytes, fileName);
        sources.push({
          source_type: "user_file", filename: up.Filename, user_filename: up.UserFilename,
          size_bytes: entry.Question.length,
        });
        entry.Question = `查看这个文件并且直接与文件内容进行聊天：${up.UserFilename.replace(/\.txt$/i, "")}.txt`;
      }
    }

    if (entry.Answer) {
      const tk = countTokensForMessages([{ role: "assistant", content: entry.Answer }]);
      if (tk >= 30) {
        await getNonce(dsToken).catch(() => {});
        const fileName = generateShortFileName() + ".txt";
        const bytes = addUTF8BOM(entry.Answer);
        const up = await uploadFile(dsToken, bytes, fileName);
        sources.push({
          source_type: "user_file", filename: up.Filename, user_filename: up.UserFilename,
          size_bytes: entry.Answer.length,
        });
        entry.Answer = `查看这个文件并且直接与文件内容进行聊天：${up.UserFilename.replace(/\.txt$/i, "")}.txt`;
      }
    }
  }

  // 处理最后一条消息
  const lastMessage = openAIReq.messages[openAIReq.messages.length - 1];
  const lastTokens = countTokensForMessages([lastMessage]);
  let finalQuery = "", imageSourcesJSON = "";

  if (hasImageContent(lastMessage.content)) {
    try {
      const r = await processImageContent(lastMessage.content, dsToken);
      finalQuery = r.text;
      imageSourcesJSON = r.sourcesJSON;
    } catch (e) {
      console.log("处理图片内容失败:", e);
      return new Response("Failed to process image content", { status: 500, headers: corsHeaders() });
    }
  } else {
    finalQuery = extractTextContent(lastMessage.content);
  }

  if (lastTokens > MaxContextTokens) {
    await getNonce(dsToken).catch(() => {});
    const fileName = generateShortFileName() + ".txt";
    const bytes = addUTF8BOM(finalQuery);
    const up = await uploadFile(dsToken, bytes, fileName);
    sources.push({
      source_type: "user_file", filename: up.Filename, user_filename: up.UserFilename,
      size_bytes: finalQuery.length,
    });
    finalQuery = `查看这个文件并且直接与文件内容进行聊天：${up.UserFilename.replace(/\.txt$/i, "")}.txt`;
  }

  if (imageSourcesJSON) {
    try {
      const arr = JSON.parse(imageSourcesJSON);
      for (const s of arr) sources.push(s);
    } catch { /* ignore */ }
  }

  // 组装 you.com 请求
  const chatId = crypto.randomUUID();
  const conversationTurnId = crypto.randomUUID();
  const traceId = `${chatId}|${conversationTurnId}|${new Date().toISOString()}`;
  const params = new URLSearchParams({
    page: "1",
    count: "10",
    safeSearch: "Moderate",
    mkt: "zh-HK",
    enable_worklow_generation_ux: "true",
    domain: "youchat",
    use_personalization_extraction: "true",
    queryTraceId: chatId,
    chatId,
    conversationTurnId,
    pastChatLength: String(chatHistory.length),
    enable_agent_clarification_questions: "true",
    traceId,
    use_nested_youchat_updates: "true",
  });

  if (isAgentModel(openAIReq.model)) {
    console.log("使用Agent模型:", openAIReq.model);
    params.set("selectedChatMode", openAIReq.model);
  } else {
    console.log("使用默认模型:", openAIReq.model, "(映射为:", mapModelName(openAIReq.model), ")");
    params.set("selectedAiModel", mapModelName(openAIReq.model));
    params.set("selectedChatMode", "custom");
  }

  if (sources.length > 0) params.set("sources", JSON.stringify(sources));
  params.set("q", finalQuery);
  params.set("chat", JSON.stringify(chatHistory));

  const youUrl = "https://you.com/api/streamingSearch?" + params.toString();

  // 请求头与 Cookie（包括 DS 与大量 UA 伪装）
  const youHeaders = {
    "Accept": "text/event-stream",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
    "sec-ch-ua-platform": "Windows",
    "sec-ch-ua": `"Not(A:Brand";v="99", "Microsoft Edge";v="133", "Chromium";v="133"`,
    "sec-ch-ua-mobile": "?0",
    "Cache-Control": "no-cache",
    "Cookie": cookieHeaderStr(getCookies(dsToken)),
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Host": "you.com",
  };

  // （第一次）发送请求探测状态码
  console.log("\n=== 完整请求信息 ===");
  console.log("请求 URL:", youUrl);
  console.log("请求头（部分）:", Object.keys(youHeaders));
  console.log("Cookie:", youHeaders.Cookie);
  const probe = await fetch(youUrl, { headers: youHeaders });
  console.log("响应状态码:", probe.status);
  if (!probe.ok) {
    const errBody = await probe.text().catch(() => "");
    console.log("错误响应内容:", errBody);
    return new Response(`API returned status ${probe.status}`, {
      status: probe.status,
      headers: corsHeaders(),
    });
  }
  probe.body?.cancel(); // 不复用，保持与原“再次请求”一致

  // 根据 stream 参数选择处理函数（会再请求一次 you.com）
  const modelForResp = reverseMap[mapModelName(originalModel)] ?? "deepseek-chat";
  if (!openAIReq.stream) {
    // 非流式：收集完整内容后一次性返回
    const resp2 = await fetch(youUrl, { headers: youHeaders, signal: AbortSignal.timeout(60000) });
    if (!resp2.ok) {
      const t = await resp2.text().catch(() => "");
      return new Response(t || "upstream error", { status: resp2.status, headers: corsHeaders() });
    }
    const full = await collectYouTokensStream(resp2);
    const openAIResp = {
      id: "chatcmpl-" + Math.floor(Date.now() / 1000),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelForResp, // 映射回 OpenAI 名称
      choices: [{
        message: { role: "assistant", content: full },
        index: 0,
        finish_reason: "stop",
      }],
    };
    return new Response(JSON.stringify(openAIResp), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  // 流式：逐 token 转发为 OpenAI chunk
  const streamResp = await streamOpenAIChunks(youUrl, youHeaders, modelForResp);
  const h = new Headers(streamResp.headers);
  corsHeaders() && Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
  return new Response(streamResp.body, { headers: h, status: 200 });
});
