// D1 数据库适配层 - 提供与原版 db.js 相同的接口
// 使用 Cloudflare D1 binding + Web Crypto API

import { encrypt, decrypt, hashPassword, verifyPassword, randomUUID } from './crypto.js';

export function createDb(env) {
  const D1 = env.DB;
  const KEY_HEX = env.ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000';

  // D1 查询封装
  async function execute(sql, params = []) {
    const stmt = D1.prepare(sql);
    if (params.length) stmt.bind(...params);
    try {
      const result = await stmt.all();
      return { rows: result.results || [], rowsAffected: result.meta?.changes || 0 };
    } catch (e) {
      throw new Error(`D1 execute failed: ${e.message} | SQL: ${sql.slice(0, 80)} | params: ${params.length}`);
    }
  }

  async function run(sql, params = []) {
    const stmt = D1.prepare(sql);
    if (params.length) stmt.bind(...params);
    try {
      const result = await stmt.run();
      return result.meta?.changes || 0;
    } catch (e) {
      throw new Error(`D1 run failed: ${e.message} | SQL: ${sql.slice(0, 80)} | params: ${params.length} | values: ${JSON.stringify(params).slice(0, 200)}`);
    }
  }

  async function first(sql, params = []) {
    const stmt = D1.prepare(sql);
    if (params.length) stmt.bind(...params);
    try {
      return await stmt.first();
    } catch (e) {
      throw new Error(`D1 first failed: ${e.message} | SQL: ${sql.slice(0, 80)} | params: ${params.length}`);
    }
  }

  // ==================== Settings ====================
  async function getSetting(key, fallback = null) {
    const row = await first('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  }

  async function getSettingJSON(key, fallback = null) {
    const val = await getSetting(key);
    if (val === null) return fallback;
    try { return JSON.parse(val); } catch (_) { return fallback; }
  }

  async function setSettingJSON(key, value) {
    await setSetting(key, JSON.stringify(value));
  }

  // ==================== 管理密码 ====================
  async function setAdminPassword(password) {
    await setSetting('admin_password_hash', await hashPassword(password));
  }

  async function verifyAdminPassword(password) {
    const hash = await getSetting('admin_password_hash');
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  async function hasAdminPassword() {
    const hash = await getSetting('admin_password_hash');
    return !!hash;
  }

  // ==================== API Key ====================
  async function setApiKey(key) {
    if (!key) { await run('DELETE FROM settings WHERE key = ?', ['api_key_enc']); return; }
    await setSetting('api_key_enc', await encrypt(key, KEY_HEX));
  }

  async function getApiKey() {
    const enc = await getSetting('api_key_enc');
    if (!enc) return '';
    return (await decrypt(enc, KEY_HEX)) || '';
  }

  async function hasApiKey() {
    const enc = await getSetting('api_key_enc');
    return !!enc;
  }

  // ==================== 提供商 CRUD ====================
  async function getProviders() {
    const { rows } = await execute('SELECT * FROM providers ORDER BY priority ASC, id ASC');
    // 批量并行解密 API Key（复用缓存的 AES 密钥，避免重复 importKey）
    const decryptedKeys = await Promise.all(
      rows.map(r => r.api_key_enc ? decrypt(r.api_key_enc, KEY_HEX) : null)
    );
    return rows.map((r, i) => ({
      id: r.id, name: r.name, type: r.type, baseUrl: r.base_url,
      models: JSON.parse(r.models), free: !!r.free,
      requiresApiKey: !!r.requires_api_key, priority: r.priority,
      custom: true, disabled: !!r.disabled,
      apiKey: decryptedKeys[i] || ''
    }));
  }

  async function getProviderById(id) {
    const row = await first('SELECT * FROM providers WHERE id = ?', [id]);
    if (!row) return null;
    return {
      id: row.id, name: row.name, type: row.type, baseUrl: row.base_url,
      models: JSON.parse(row.models), free: !!row.free,
      requiresApiKey: !!row.requires_api_key, priority: row.priority,
      custom: true, disabled: !!row.disabled,
      apiKey: row.api_key_enc ? (await decrypt(row.api_key_enc, KEY_HEX)) || '' : ''
    };
  }

  async function addProvider(p) {
    const now = new Date().toISOString();
    await run(
      `INSERT INTO providers (id, name, type, base_url, models, free, requires_api_key, priority, api_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.name, p.type, p.baseUrl, JSON.stringify(p.models), p.free ? 1 : 0, p.requiresApiKey ? 1 : 0, p.priority || 10, p.apiKey ? await encrypt(p.apiKey, KEY_HEX) : null, now, now]
    );
    return getProviderById(p.id);
  }

  async function updateProvider(id, p) {
    const existing = await first('SELECT * FROM providers WHERE id = ?', [id]);
    if (!existing) return null;
    const now = new Date().toISOString();
    const apiKeyEnc = p.apiKey !== undefined && p.apiKey !== '' ? await encrypt(p.apiKey, KEY_HEX) : existing.api_key_enc;
    await run(
      `UPDATE providers SET name=?, type=?, base_url=?, models=?, free=?, requires_api_key=?, priority=?, api_key_enc=?, updated_at=? WHERE id=?`,
      [p.name, p.type, p.baseUrl, JSON.stringify(p.models), p.free ? 1 : 0, p.requiresApiKey ? 1 : 0, p.priority || 10, apiKeyEnc, now, id]
    );
    return getProviderById(id);
  }

  async function deleteProvider(id) {
    const changes = await run('DELETE FROM providers WHERE id = ?', [id]);
    return changes > 0;
  }

  async function providerExists(id) {
    const row = await first('SELECT 1 FROM providers WHERE id = ?', [id]);
    return !!row;
  }

  async function setProviderDisabled(id, disabled) {
    const row = await first('SELECT 1 FROM providers WHERE id = ?', [id]);
    if (!row) return false;
    await run('UPDATE providers SET disabled=? WHERE id=?', [disabled ? 1 : 0, id]);
    return true;
  }

  async function getDisabledBuiltinProviders() {
    return getSettingJSON('disabled_builtin_providers', []);
  }

  async function setDisabledBuiltinProviders(list) {
    await setSettingJSON('disabled_builtin_providers', list);
  }

  // ==================== 使用日志 ====================
  async function logUsage({ provider, model, tokens, success, ip }) {
    try {
      await run(
        `INSERT INTO usage_logs (provider, model, tokens, success, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [provider || null, model || null, tokens || 0, success ? 1 : 0, ip || null, new Date().toISOString()]
      );
    } catch (_) {}
  }

  async function getUsageStats() {
    const total = (await first('SELECT COUNT(*) as count FROM usage_logs')).count;
    const successCount = (await first('SELECT COUNT(*) as count FROM usage_logs WHERE success = 1')).count;
    const { rows: byProvider } = await execute('SELECT provider, COUNT(*) as count, SUM(tokens) as tokens FROM usage_logs GROUP BY provider');
    return { total, successCount, failCount: total - successCount, byProvider };
  }

  async function getDetailedStats() {
    const total = (await first('SELECT COUNT(*) as count FROM usage_logs')).count;
    const successCount = (await first('SELECT COUNT(*) as count FROM usage_logs WHERE success = 1')).count;
    const totalTokens = (await first('SELECT COALESCE(SUM(tokens),0) as tokens FROM usage_logs')).tokens;
    const { rows: byDay } = await execute(`SELECT DATE(created_at) as date, COUNT(*) as count, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as successCount, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failCount, COALESCE(SUM(tokens),0) as tokens FROM usage_logs WHERE created_at >= datetime('now','-7 days') GROUP BY DATE(created_at) ORDER BY date ASC`);
    const { rows: byModel } = await execute(`SELECT model, COUNT(*) as count, COALESCE(SUM(tokens),0) as tokens, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as successCount FROM usage_logs GROUP BY model ORDER BY count DESC`);
    const { rows: byProvider } = await execute(`SELECT provider, COUNT(*) as count, COALESCE(SUM(tokens),0) as tokens, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as successCount, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failCount FROM usage_logs GROUP BY provider ORDER BY count DESC`);
    const { rows: recent } = await execute('SELECT provider, model, tokens, success, created_at FROM usage_logs ORDER BY id DESC LIMIT 20');
    return { total, successCount, failCount: total - successCount, totalTokens, byDay, byModel, byProvider, recent };
  }

  // ==================== 对话历史 ====================
  async function createConversation(title, model) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await run('INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, title || '新对话', model || null, now, now]);
    return { id, title: title || '新对话', model: model || null, created_at: now, updated_at: now };
  }

  async function getConversations() {
    const { rows } = await execute('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count FROM conversations c ORDER BY c.updated_at DESC');
    return rows;
  }

  async function getConversation(id) {
    return first('SELECT * FROM conversations WHERE id = ?', [id]);
  }

  async function updateConversation(id, { title, model }) {
    const existing = await first('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) return null;
    const now = new Date().toISOString();
    await run('UPDATE conversations SET title=?, model=?, updated_at=? WHERE id=?', [title !== undefined ? title : existing.title, model !== undefined ? model : existing.model, now, id]);
    return first('SELECT * FROM conversations WHERE id = ?', [id]);
  }

  async function deleteConversation(id) {
    await run('DELETE FROM messages WHERE conversation_id = ?', [id]);
    const changes = await run('DELETE FROM conversations WHERE id = ?', [id]);
    return changes > 0;
  }

  async function addMessage(conversationId, { role, content, model, provider }) {
    const now = new Date().toISOString();
    await run('INSERT INTO messages (conversation_id, role, content, model, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)', [conversationId, role, content, model || null, provider || null, now]);
    await run('UPDATE conversations SET updated_at=? WHERE id=?', [now, conversationId]);
    return first('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversationId]);
  }

  async function getMessages(conversationId) {
    const { rows } = await execute('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC', [conversationId]);
    return rows;
  }

  return {
    getSetting, setSetting, getSettingJSON, setSettingJSON,
    setAdminPassword, verifyAdminPassword, hasAdminPassword,
    setApiKey, getApiKey, hasApiKey,
    getProviders, getProviderById, addProvider, updateProvider, deleteProvider, providerExists, setProviderDisabled, getDisabledBuiltinProviders, setDisabledBuiltinProviders,
    logUsage, getUsageStats, getDetailedStats,
    createConversation, getConversations, getConversation, updateConversation, deleteConversation, addMessage, getMessages,
    encrypt: (p) => encrypt(p, KEY_HEX),
    decrypt: (c) => decrypt(c, KEY_HEX),
  };
}
