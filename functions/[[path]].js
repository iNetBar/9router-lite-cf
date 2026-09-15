// Cloudflare Pages Functions 入口
// 拦截所有请求，API 路径交给 handleApi，其余交给静态资源服务

import { handleApi } from '../lib/api.js';
import { createDb } from '../lib/db.js';

const API_PREFIXES = ['/api/', '/v1/', '/health'];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // API 路径交给后端处理
  if (API_PREFIXES.some(p => path === p || path.startsWith(p))) {
    try {
      return await handleApi(request, env, context.ctx);
    } catch (err) {
      try { await createDb(env).addLog('error', `${path}: ${err.message}`); } catch (_) {}
      return Response.json(
        { error: { message: err.message || 'Internal error', type: 'server_error' } },
        { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
  }

  // 其余路径交给 Pages 静态资源服务（index.html 等）
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}
