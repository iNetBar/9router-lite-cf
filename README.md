# 9router-lite Cloudflare Pages + D1 部署

全球 CDN 加速、免费额度充足、无需服务器、自动 HTTPS。

## 一键部署

```bash
cd cloudflare
./deploy.sh
```

脚本自动完成：同步 index.html → 创建 D1 数据库 → 初始化表 → 生成加密密钥 → 部署。

首次运行前需登录 Wrangler：`npx wrangler login`

## 前置条件

- [Cloudflare 账号](https://cloudflare.com)（免费）
- Node.js + Wrangler（`npx wrangler login` 登录）

## 后续更新

```bash
./deploy.sh
```

## 可选操作

**绑定自定义域名**：Cloudflare Dashboard → Pages → 自定义域名

**设置提供商 API Key**：访问部署 URL → 管理后台 → 提供商设置

**迁移加密密钥到 secret**（更安全，不进仓库）：
```bash
npx wrangler pages secret put ENCRYPTION_KEY
# 然后从 wrangler.toml 的 [vars] 中删除 ENCRYPTION_KEY 行
```

**本地开发**：
```bash
npx wrangler pages dev . --d1 DB=9router-lite-db
```

## 限制

- Workers 免费版 CPU 限制 10ms/请求（聊天请求主要等外部 API，不计 CPU 时间）
- 密码哈希用 PBKDF2（Node 版用 scrypt，两者不互通）
- 与 Node 版数据不互通（独立 D1 数据库）

## 文件结构

```
cloudflare/
├── deploy.sh               # 一键部署脚本
├── index.html              # Web UI（部署时自动从根目录同步）
├── functions/[[path]].js   # Pages Functions 入口
├── lib/
│   ├── api.js              # API 逻辑
│   ├── db.js               # D1 适配层
│   └── crypto.js           # Web Crypto 加密
├── schema.sql              # D1 建表 SQL
├── wrangler.toml           # Cloudflare 配置
└── package.json
```
