// 9router-lite Cloudflare Pages API 逻辑层
// 移植自 server.js，适配 Workers runtime + D1

import { createDb } from './db.js';
import { randomUUID } from './crypto.js';

// ==================== 内置提供商 ====================
const BUILTIN_PROVIDERS = [
  { id: 'ollama', name: 'Ollama (本地)', type: 'ollama', baseUrl: 'http://localhost:11434', models: ['llama3','mistral','phi3'], free: true, priority: 1 },
  { id: 'huggingface', name: 'HuggingFace Inference', type: 'huggingface', baseUrl: 'https://api-inference.huggingface.co', models: ['meta-llama/Llama-3-8b-Inst','mistralai/Mistral-7B-In'], free: true, requiresApiKey: true, priority: 2 },
  { id: 'openrouter', name: 'OpenRouter', type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['free','claude-3-haiku','gpt-4o-mini'], free: true, requiresApiKey: true, priority: 3 },
  { id: 'groq', name: 'Groq', type: 'groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama3-8b','llama3-70b','mixtral-8x7b'], free: false, requiresApiKey: true, priority: 4 },
  { id: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022','claude-3-opus-20240229'], free: false, requiresApiKey: true, priority: 5 },
  { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-1.5-flash','gemini-1.5-pro','gemini-2.0-flash-exp'], free: false, requiresApiKey: true, priority: 6 },
  { id: 'echo', name: '演示回显 (Echo)', type: 'echo', baseUrl: 'internal://echo', models: ['echo'], free: true, priority: 99 }
];
const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDERS.map(p => p.id));

// ==================== 工具函数 ====================
function isAllowedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (h.startsWith('10.') || h.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^169\.254\./.test(h)) return false;
    return true;
  } catch (_) { return false; }
}

function getProviderApiKey(provider, env) {
  const envKey = provider.id.toUpperCase() + '_API_KEY';
  if (env[envKey]) return env[envKey];
  if (provider.custom && provider.apiKey) return provider.apiKey;
  return null;
}

async function getAllProviders(db, env) {
  const custom = await db.getProviders();
  const disabledBuiltin = await db.getDisabledBuiltinProviders();
  const builtins = BUILTIN_PROVIDERS.map(p => ({ ...p, disabled: disabledBuiltin.includes(p.id) }));
  return [...builtins, ...custom];
}

function getProviderUrl(provider, stream = false) {
  switch (provider.type) {
    case 'anthropic': return `${provider.baseUrl}/messages`;
    case 'gemini': return `${provider.baseUrl}/models/${stream ? 'streamGenerateContent' : 'generateContent'}`;
    default: return `${provider.baseUrl}/chat/completions`;
  }
}

function transformRequest(request, provider, env) {
  const apiKey = getProviderApiKey(provider, env);
  const model = request.model || provider.models[0];
  if (provider.type === 'anthropic') {
    const messages = (request.messages || []).filter(m => m.role !== 'system');
    const systemMsgs = (request.messages || []).filter(m => m.role === 'system');
    return {
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
      data: { model, messages: messages.map(m => ({ role: m.role, content: m.content })), max_tokens: request.max_tokens || 1024, temperature: request.temperature ?? 0.7, stream: request.stream || false, ...(systemMsgs.length > 0 && { system: systemMsgs.map(m => m.content).join('\n\n') }) }
    };
  }
  if (provider.type === 'gemini') {
    const contents = (request.messages || []).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return { headers: { 'Content-Type': 'application/json' }, params: { key: apiKey || '' }, data: { contents, generationConfig: { temperature: request.temperature ?? 0.7, maxOutputTokens: request.max_tokens || 1024 } } };
  }
  return {
    headers: { 'Content-Type': 'application/json', ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }), ...(provider.type === 'openrouter' && apiKey && { 'X-Title': '9router-lite', 'HTTP-Referer': 'https://9router-lite.vercel.app' }) },
    data: { model, messages: request.messages, temperature: request.temperature || 0.7, max_tokens: request.max_tokens || 1024, stream: request.stream || false, ...(request.tools && { tools: request.tools }), ...(request.tool_choice && { tool_choice: request.tool_choice }) }
  };
}

function transformResponse(data, provider) {
  if (provider.type === 'anthropic') {
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return { id: data.id || `cmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: data.model || provider.models[0], choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: data.stop_reason || 'stop' }], usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0, total_tokens: (data.usage?.input_tokens||0)+(data.usage?.output_tokens||0) } };
  }
  if (provider.type === 'gemini') {
    const text = (data.candidates || []).flatMap(c => (c.content?.parts || []).filter(p => p.text).map(p => p.text)).join('');
    return { id: `cmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: provider.models[0], choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: data.candidates?.[0]?.finishReason || 'stop' }], usage: { prompt_tokens: data.usageMetadata?.promptTokenCount || 0, completion_tokens: data.usageMetadata?.candidatesTokenCount || 0, total_tokens: data.usageMetadata?.totalTokenCount || 0 } };
  }
  return { id: data.id || `cmpl-${randomUUID()}`, object: 'chat.completion', created: data.created || Math.floor(Date.now()/1000), model: data.model || provider.models[0], choices: (data.choices || []).map(c => ({ index: c.index || 0, message: { role: c.message?.role || 'assistant', content: c.message?.content || '' }, finish_reason: c.finish_reason || 'stop' })), usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

async function buildEchoResponse(request, provider) {
  const lastMsg = request.messages[request.messages.length - 1];
  const userContent = lastMsg?.content || '';
  const content = `🎤 演示回显\n\n你发送了：「${userContent}」\n\n这是 9router-lite 内置的演示提供商，无需任何外部依赖即可体验聊天界面。配置真实 API Key 或启动 Ollama 后，将自动切换到真实 AI 服务。`;
  return { id: `cmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: provider.models[0] || 'echo', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

// ==================== 提供商选择 ====================
async function getActiveProviders(db, env) {
  const all = await getAllProviders(db, env);
  return all.filter(p => !p.disabled && (p.free || getProviderApiKey(p, env))).sort((a, b) => a.priority - b.priority);
}

// ==================== 非流式路由 ====================
async function routeRequest(request, db, env, maxRetries = 3) {
  const providers = await getActiveProviders(db, env);
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (providers.length === 0) break;
    const provider = providers[attempt % providers.length];
    const apiKey = getProviderApiKey(provider, env);
    if (!apiKey && provider.requiresApiKey) continue;
    if (provider.type === 'echo') return buildEchoResponse(request, provider);
    const { headers, data, params } = transformRequest(request, provider, env);
    try {
      const url = getProviderUrl(provider);
      const fetchUrl = params ? `${url}?${new URLSearchParams(params)}` : url;
      const resp = await fetch(fetchUrl, { method: 'POST', headers, body: JSON.stringify(data) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json().catch(() => null);
      if (!json) throw new Error('上游返回非 JSON 响应');
      await db.logUsage({ provider: provider.id, model: data.model, success: true });
      return transformResponse(json, provider);
    } catch (err) {
      lastError = err;
      await db.logUsage({ provider: provider.id, model: data?.model, success: false });
    }
  }
  const echo = BUILTIN_PROVIDERS.find(p => p.type === 'echo');
  if (echo) return buildEchoResponse(request, echo);
  throw lastError || new Error('无可用提供商');
}

// ==================== 流式路由 ====================
function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function routeRequestStream(request, db, env) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (s) => controller.enqueue(encoder.encode(s));
      try {
        const providers = await getActiveProviders(db, env);
        let done = false;
        for (const provider of providers) {
          if (done) break;
          const apiKey = getProviderApiKey(provider, env);
          if (!apiKey && provider.requiresApiKey) continue;

          if (provider.type === 'echo') {
            const echoResp = await buildEchoResponse(request, provider);
            const content = echoResp.choices[0].message.content;
            for (let i = 0; i < content.length; i += 32) {
              enqueue(sseChunk({ id: echoResp.id, object: 'chat.completion.chunk', created: echoResp.created, model: echoResp.model, choices: [{ index: 0, delta: { content: content.slice(i, i + 32) }, finish_reason: null }] }));
            }
            enqueue(sseChunk({ id: echoResp.id, object: 'chat.completion.chunk', created: echoResp.created, model: echoResp.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            enqueue('data: [DONE]\n\n');
            await db.logUsage({ provider: provider.id, model: echoResp.model, success: true });
            done = true; break;
          }

          const { headers, data, params } = transformRequest(request, provider, env);
          data.stream = true;
          try {
            const streamUrl = provider.type === 'gemini' ? `${provider.baseUrl}/models/${request.model || provider.models[0]}:streamGenerateContent` : getProviderUrl(provider, true);
            const fetchUrl = params ? `${streamUrl}?${new URLSearchParams(params)}` : streamUrl;
            const resp = await fetch(fetchUrl, { method: 'POST', headers, body: JSON.stringify(data) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await db.logUsage({ provider: provider.id, model: data.model, success: true });

            if (provider.type === 'anthropic' || provider.type === 'gemini') {
              // 转换 SSE 格式
              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buf = '';
              const cmpId = `cmpl-${randomUUID()}`;
              const created = Math.floor(Date.now() / 1000);
              while (true) {
                const { done: rd, value } = await reader.read();
                if (rd) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop() || '';
                for (const line of lines) {
                  const t = line.trim();
                  if (!t || !t.startsWith('data:')) continue;
                  const jsonStr = t.slice(5).trim();
                  if (jsonStr === '[DONE]') continue;
                  try {
                    const event = JSON.parse(jsonStr);
                    if (provider.type === 'anthropic') {
                      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') enqueue(sseChunk({ id: cmpId, object: 'chat.completion.chunk', created, model: data.model, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] }));
                      else if (event.type === 'message_stop') enqueue(sseChunk({ id: cmpId, object: 'chat.completion.chunk', created, model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
                    } else if (provider.type === 'gemini') {
                      const text = (event.candidates || []).flatMap(c => (c.content?.parts || []).filter(p => p.text).map(p => p.text)).join('');
                      if (text) enqueue(sseChunk({ id: cmpId, object: 'chat.completion.chunk', created, model: data.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
                      if (event.candidates?.[0]?.finishReason) enqueue(sseChunk({ id: cmpId, object: 'chat.completion.chunk', created, model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
                    }
                  } catch (_) {}
                }
              }
            } else {
              // OpenAI 兼容，直接转发
              const reader = resp.body.getReader();
              while (true) {
                const { done: rd, value } = await reader.read();
                if (rd) break;
                controller.enqueue(value);
              }
            }
            enqueue('data: [DONE]\n\n');
            done = true; break;
          } catch (err) {
            await db.logUsage({ provider: provider.id, model: data?.model, success: false });
            continue;
          }
        }
        if (!done) {
          const echo = BUILTIN_PROVIDERS.find(p => p.type === 'echo');
          if (echo) {
            const echoResp = await buildEchoResponse(request, echo);
            const content = echoResp.choices[0].message.content;
            for (let i = 0; i < content.length; i += 32) enqueue(sseChunk({ id: echoResp.id, object: 'chat.completion.chunk', created: echoResp.created, model: echoResp.model, choices: [{ index: 0, delta: { content: content.slice(i, i + 32) }, finish_reason: null }] }));
            enqueue(sseChunk({ id: echoResp.id, object: 'chat.completion.chunk', created: echoResp.created, model: echoResp.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            enqueue('data: [DONE]\n\n');
          }
        }
      } catch (err) {
        enqueue(sseChunk({ error: { message: err.message, type: 'stream_error' } }));
        enqueue('data: [DONE]\n\n');
      }
      controller.close();
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } });
}

// ==================== 认证 ====================
async function requireAdmin(request, db) {
  if (!await db.hasAdminPassword()) return true;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return db.verifyAdminPassword(token);
}

async function requireApiKey(request, db) {
  const apiKey = await db.getApiKey();
  if (!apiKey) return true;
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return key === apiKey;
}

function unauthorized() {
  return Response.json({ success: false, error: '未授权：请先登录管理后台', code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
}

// ==================== 健康检查 ====================
async function checkProviderHealth(provider, env) {
  const result = { id: provider.id, name: provider.name, type: provider.type, status: 'offline', latency: null, keyValid: null, hasKey: !!getProviderApiKey(provider, env), requiresApiKey: !!provider.requiresApiKey, disabled: !!provider.disabled, models: [], error: null, checkedAt: new Date().toISOString() };
  if (provider.disabled) { result.status = 'disabled'; return result; }
  if (provider.type === 'echo') { result.status = 'online'; result.latency = 0; result.models = provider.models; return result; }
  const apiKey = getProviderApiKey(provider, env);
  if (provider.requiresApiKey && !apiKey) { result.status = 'degraded'; result.keyValid = false; result.error = '需要 API Key 但未设置'; return result; }
  const headers = { 'Content-Type': 'application/json', ...(provider.type === 'anthropic' && apiKey && { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }), ...(provider.type !== 'anthropic' && apiKey && { 'Authorization': `Bearer ${apiKey}` }) };
  const healthUrl = provider.type === 'ollama' ? `${provider.baseUrl}/api/tags` : `${provider.baseUrl}/models`;
  const start = Date.now();
  try {
    const resp = await fetch(healthUrl, { headers });
    result.latency = Date.now() - start;
    if (resp.status === 401 || resp.status === 403) { result.status = 'offline'; result.keyValid = false; result.error = `API Key 无效 (HTTP ${resp.status})`; return result; }
    if (!resp.ok) { result.status = 'offline'; result.error = `HTTP ${resp.status}`; return result; }
    result.status = 'online'; result.keyValid = apiKey ? true : null;
    const json = await resp.json().catch(() => null);
    if (provider.type === 'ollama' && json?.models) result.models = json.models.map(m => m.name || m).filter(Boolean);
    else if (json?.data) result.models = json.data.map(m => m.id).filter(Boolean);
    else result.models = provider.models;
    return result;
  } catch (err) { result.latency = Date.now() - start; result.error = err.message; return result; }
}

// ==================== 主路由处理 ====================
export async function handleApi(request, env, ctx) {
  const db = createDb(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS 预检
  if (method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } });

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  // ----- 公开路由 -----
  if (path === '/health') {
    const providers = await getAllProviders(db, env);
    return Response.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.3.0', providers: providers.map(p => ({ id: p.id, name: p.name, free: p.free, models: p.models })) }, { headers: corsHeaders });
  }

  if (path === '/api/providers' && method === 'GET') {
    const providers = await getAllProviders(db, env);
    return Response.json({ providers: providers.map(p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, free: p.free, models: p.models, priority: p.priority, requiresApiKey: p.requiresApiKey, custom: !BUILTIN_PROVIDER_IDS.has(p.id), disabled: !!p.disabled })), fallback: { enabled: true, maxRetries: 3, timeout: 30000 } }, { headers: corsHeaders });
  }

  if (path === '/api/auth/status' && method === 'GET') {
    return Response.json({ adminRequired: await db.hasAdminPassword(), apikeyRequired: await db.hasApiKey() }, { headers: corsHeaders });
  }

  if (path === '/api/auth/verify' && method === 'POST') {
    const { token } = await request.json();
    if (!await db.hasAdminPassword()) return Response.json({ valid: true }, { headers: corsHeaders });
    return Response.json({ valid: await db.verifyAdminPassword(token || '') }, { headers: corsHeaders });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    if (await db.hasAdminPassword()) return Response.json({ success: false, error: '管理密码已设置，请使用修改密码功能' }, { status: 403, headers: corsHeaders });
    const { password } = await request.json();
    if (!password || password.length < 6) return Response.json({ success: false, error: '密码至少 6 个字符' }, { status: 400, headers: corsHeaders });
    await db.setAdminPassword(password);
    await db.addLog('info', '管理密码已设置');
    return Response.json({ success: true, message: '管理密码已设置' }, { headers: corsHeaders });
  }

  // ----- API Key 认证路由 -----
  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!await requireApiKey(request, db)) return Response.json({ error: { message: 'Invalid API key', type: 'invalid_api_key' } }, { status: 401, headers: corsHeaders });
    const body = await request.json();
    await db.addLog('info', `chat/completions model=${body.model || 'default'} stream=${!!body.stream}`);
    if (body.stream) return routeRequestStream(body, db, env);
    try {
      const result = await routeRequest(body, db, env);
      return Response.json(result, { headers: corsHeaders });
    } catch (err) {
      await db.addLog('error', `chat/completions failed: ${err.message}`);
      return Response.json({ error: { message: err.message, type: 'provider_error' } }, { status: 500, headers: corsHeaders });
    }
  }

  if (path === '/v1/models' && method === 'GET') {
    if (!await requireApiKey(request, db)) return Response.json({ error: { message: 'Invalid API key' } }, { status: 401, headers: corsHeaders });
    const providers = await getActiveProviders(db, env);
    const models = providers.flatMap(p => p.models.map(m => ({ id: m, object: 'model', created: Math.floor(Date.now()/1000), owned_by: p.id })));
    return Response.json({ data: models, object: 'list' }, { headers: corsHeaders });
  }

  // ----- 以下路由需要管理员认证 -----
  const isAdmin = await requireAdmin(request, db);
  if (!isAdmin) return unauthorized();

  // 修改密码
  if (path === '/api/auth/change-password' && method === 'POST') {
    const { currentPassword, newPassword } = await request.json();
    if (!newPassword || newPassword.length < 6) return Response.json({ success: false, error: '新密码至少 6 个字符' }, { status: 400 });
    if (await db.hasAdminPassword() && !await db.verifyAdminPassword(currentPassword || '')) return Response.json({ success: false, error: '当前密码不正确' }, { status: 403 });
    await db.setAdminPassword(newPassword);
    return Response.json({ success: true, message: '管理密码已更新' });
  }

  // API Key 管理
  if (path === '/api/auth/api-key' && method === 'GET') return Response.json({ apiKey: await db.getApiKey(), required: await db.hasApiKey() });
  if (path === '/api/auth/api-key' && method === 'POST') {
    const { newApiKey } = await request.json();
    await db.setApiKey(newApiKey);
    return Response.json({ success: true, apiKey: await db.getApiKey(), message: await db.hasApiKey() ? 'API Key 已更新' : 'API Key 认证已禁用' });
  }

  // 提供商 CRUD
  if (path === '/api/providers' && method === 'POST') {
    const body = await request.json();
    const errors = validateProvider(body);
    if (errors.length) return Response.json({ success: false, errors }, { status: 400 });
    const { name, type, baseUrl, models, free, requiresApiKey, priority, apiKey } = body;
    const id = randomUUID().slice(0, 8);
    const p = await db.addProvider({ id, name: name.trim(), type, baseUrl: baseUrl.trim(), models: models.map(m => String(m).trim()).filter(Boolean), free: !!free, requiresApiKey: requiresApiKey !== undefined ? !!requiresApiKey : true, priority: priority || 10, apiKey: apiKey || '' });
    const { apiKey: _, ...safe } = p;
    return Response.json({ success: true, provider: safe });
  }

  // 提供商 :id 路由
  const providerMatch = path.match(/^\/api\/providers\/([^/]+)(\/.*)?$/);
  if (providerMatch) {
    const id = providerMatch[1];
    const sub = providerMatch[2];

    if (!sub && method === 'PUT') {
      if (BUILTIN_PROVIDER_IDS.has(id)) return Response.json({ success: false, error: '内置提供商不可修改' }, { status: 403 });
      if (!await db.providerExists(id)) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      const body = await request.json();
      const errors = validateProvider(body);
      if (errors.length) return Response.json({ success: false, errors }, { status: 400 });
      const { name, type, baseUrl, models, free, requiresApiKey, priority, apiKey } = body;
      const updated = await db.updateProvider(id, { name: name.trim(), type, baseUrl: baseUrl.trim(), models: models.map(m => String(m).trim()).filter(Boolean), free: !!free, requiresApiKey: requiresApiKey !== undefined ? !!requiresApiKey : true, priority: priority || 10, apiKey: apiKey || '' });
      const { apiKey: _, ...safe } = updated;
      return Response.json({ success: true, provider: safe });
    }

    if (!sub && method === 'DELETE') {
      if (BUILTIN_PROVIDER_IDS.has(id)) return Response.json({ success: false, error: '内置提供商不可删除' }, { status: 403 });
      if (!await db.deleteProvider(id)) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      return Response.json({ success: true });
    }

    if (sub === '/toggle' && method === 'POST') {
      const { disabled } = await request.json();
      if (BUILTIN_PROVIDER_IDS.has(id)) {
        const list = await db.getDisabledBuiltinProviders();
        const idx = list.indexOf(id);
        if (disabled && idx === -1) list.push(id);
        if (!disabled && idx !== -1) list.splice(idx, 1);
        await db.setDisabledBuiltinProviders(list);
      } else {
        if (!await db.setProviderDisabled(id, disabled)) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      }
      return Response.json({ success: true, disabled: !!disabled });
    }

    if (sub === '/health' && method === 'POST') {
      const all = await getAllProviders(db, env);
      const p = all.find(p => p.id === id);
      if (!p) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      return Response.json({ success: true, health: await checkProviderHealth(p, env) });
    }

    if (sub === '/discover-models' && method === 'POST') {
      const all = await getAllProviders(db, env);
      const p = all.find(p => p.id === id);
      if (!p) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      if (p.type === 'echo') return Response.json({ success: true, models: p.models, current: p.models });
      const apiKey = getProviderApiKey(p, env);
      if (p.requiresApiKey && !apiKey) return Response.json({ success: false, error: '需要先设置 API Key' }, { status: 400 });
      try {
        const discoverUrl = p.type === 'ollama' ? `${p.baseUrl}/api/tags` : `${p.baseUrl}/models`;
        const headers = { 'Content-Type': 'application/json', ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }) };
        const resp = await fetch(discoverUrl, { headers });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return Response.json({ success: false, error: `提供商返回 HTTP ${resp.status}: ${text.slice(0, 100)}` }, { status: 502 });
        }
        const json = await resp.json().catch(() => null);
        if (!json) return Response.json({ success: false, error: '提供商返回了非 JSON 响应' }, { status: 502 });
        let discovered = [];
        if (p.type === 'ollama' && json?.models) discovered = json.models.map(m => m.name || m).filter(Boolean);
        else if (json?.data) discovered = json.data.map(m => m.id).filter(Boolean);
        else if (Array.isArray(json?.models)) discovered = json.models.map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean);
        return Response.json({ success: true, models: discovered, current: p.models });
      } catch (err) { return Response.json({ success: false, error: '模型发现失败: ' + err.message }, { status: 500 }); }
    }

    if (sub === '/api-key' && method === 'GET') {
      const p = await db.getProviderById(id);
      if (!p && !BUILTIN_PROVIDER_IDS.has(id)) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      const envKey = id.toUpperCase() + '_API_KEY';
      return Response.json({ success: true, hasKey: !!(env[envKey] || (p && p.apiKey)) });
    }
    if (sub === '/api-key' && method === 'POST') {
      const { apiKey: key } = await request.json();
      if (BUILTIN_PROVIDER_IDS.has(id)) return Response.json({ success: true, message: key ? 'API Key 已设置' : 'API Key 已清除' });
      if (!await db.providerExists(id)) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      const existing = await db.getProviderById(id);
      await db.updateProvider(id, { name: existing.name, type: existing.type, baseUrl: existing.baseUrl, models: existing.models, free: existing.free, requiresApiKey: existing.requiresApiKey, priority: existing.priority, apiKey: key || '' });
      return Response.json({ success: true, message: key ? 'API Key 已设置' : 'API Key 已清除' });
    }
  }

  // 批量健康检查
  if (path === '/api/health/check-all' && method === 'POST') {
    const all = await getAllProviders(db, env);
    const results = await Promise.all(all.map(p => checkProviderHealth(p, env).catch(err => ({ id: p.id, name: p.name, status: 'offline', error: err.message, latency: null, keyValid: null, models: [], checkedAt: new Date().toISOString() }))));
    return Response.json({ success: true, results, summary: { total: results.length, online: results.filter(r => r.status === 'online').length, offline: results.filter(r => r.status === 'offline').length, degraded: results.filter(r => r.status === 'degraded').length, disabled: results.filter(r => r.status === 'disabled').length } });
  }

  // 系统设置
  if (path === '/api/settings' && method === 'GET') {
    const fallback = await db.getSettingJSON('fallback', { enabled: true, maxRetries: 3, timeout: 30000 });
    const rateLimit = await db.getSettingJSON('rate_limit', { enabled: true, points: 100, duration: 60 });
    const logging = await db.getSettingJSON('logging', { enabled: true, level: 'info' });
    return Response.json({ fallback, rateLimit, logging });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const { fallback, rateLimit, logging } = await request.json();
    if (fallback !== undefined) await db.setSettingJSON('fallback', fallback);
    if (rateLimit !== undefined) await db.setSettingJSON('rate_limit', rateLimit);
    if (logging !== undefined) await db.setSettingJSON('logging', logging);
    return Response.json({ success: true, message: '设置已更新' });
  }

  // 统计
  if (path === '/api/stats' && method === 'GET') return Response.json(await db.getUsageStats());
  if (path === '/api/stats/detailed' && method === 'GET') return Response.json(await db.getDetailedStats());

  // 日志（从 D1 读取）
  if (path === '/api/logs' && method === 'GET') {
    const url = new URL(request.url);
    const level = url.searchParams.get('level') || 'all';
    const limit = url.searchParams.get('limit') || 200;
    return Response.json({ success: true, ...(await db.getLogs({ level, limit })) });
  }

  // 对话历史
  if (path === '/api/conversations' && method === 'GET') return Response.json({ success: true, conversations: await db.getConversations() });
  if (path === '/api/conversations' && method === 'POST') {
    const { title, model } = await request.json();
    return Response.json({ success: true, conversation: await db.createConversation(title, model) });
  }
  if (path === '/api/conversations/export' && method === 'GET') {
    const convs = await db.getConversations();
    const exportConvs = [];
    for (const c of convs) exportConvs.push({ ...c, messages: await db.getMessages(c.id) });
    return Response.json({ version: '2.4.0', exportedAt: new Date().toISOString(), conversations: exportConvs });
  }
  if (path === '/api/conversations/import' && method === 'POST') {
    const data = await request.json();
    const conversations = data.conversations || [];
    let imported = 0, skipped = 0;
    for (const c of conversations) {
      if (!c.messages || !Array.isArray(c.messages)) { skipped++; continue; }
      try { const nc = await db.createConversation(c.title || '导入的对话', c.model || null); for (const m of c.messages) { if (!m.role || !m.content) continue; await db.addMessage(nc.id, { role: m.role, content: m.content, model: m.model || null, provider: m.provider || null }); } imported++; } catch (_) { skipped++; }
    }
    return Response.json({ success: true, imported, skipped, message: `已导入 ${imported} 个对话` });
  }
  const convMatch = path.match(/^\/api\/conversations\/([^/]+)(\/.*)?$/);
  if (convMatch) {
    const id = convMatch[1]; const sub = convMatch[2];
    if (!sub && method === 'GET') { const c = await db.getConversation(id); if (!c) return Response.json({ success: false, error: '不存在' }, { status: 404 }); return Response.json({ success: true, conversation: c, messages: await db.getMessages(id) }); }
    if (!sub && method === 'PATCH') { const u = await db.updateConversation(id, await request.json()); if (!u) return Response.json({ success: false, error: '不存在' }, { status: 404 }); return Response.json({ success: true, conversation: u }); }
    if (!sub && method === 'DELETE') { if (!await db.deleteConversation(id)) return Response.json({ success: false, error: '不存在' }, { status: 404 }); return Response.json({ success: true }); }
    if (sub === '/messages' && method === 'POST') { const { role, content, model, provider } = await request.json(); if (!role || !content) return Response.json({ success: false, error: '缺少 role 或 content' }, { status: 400 }); const msg = await db.addMessage(id, { role, content, model, provider }); return Response.json({ success: true, message: msg }); }
    if (sub === '/export' && method === 'GET') {
      const c = await db.getConversation(id);
      if (!c) return Response.json({ success: false, error: '不存在' }, { status: 404 });
      const messages = await db.getMessages(id);
      let md = `# ${c.title}\n\n> 模型: ${c.model || '默认'} · 创建时间: ${c.created_at}\n\n---\n\n`;
      for (const msg of messages) {
        const label = msg.role === 'user' ? '🧑 用户' : msg.role === 'assistant' ? '🤖 助手' : `📋 ${msg.role}`;
        md += `### ${label}\n\n${msg.content}\n\n---\n\n`;
      }
      const safeName = (c.title || 'conversation').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
      return new Response(md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.md` } });
    }
  }

  // 404
  return Response.json({ error: { message: 'Not found', type: 'invalid_request' } }, { status: 404 });
}

function validateProvider(payload) {
  const errors = [];
  const { name, type, baseUrl, models } = payload || {};
  if (!name || !name.trim()) errors.push('名称不能为空');
  if (!type) errors.push('类型不能为空');
  if (!baseUrl || !baseUrl.trim()) errors.push('Base URL 不能为空');
  if (baseUrl && type !== 'echo' && !isAllowedUrl(baseUrl.trim())) errors.push('Base URL 不合法或指向内网地址');
  if (!Array.isArray(models) || models.length === 0) errors.push('至少需要一个模型');
  return errors;
}
