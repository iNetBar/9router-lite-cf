# 9router-lite Cloudflare Pages + D1 部署

全球 CDN 加速、免费额度充足、无需服务器、自动 HTTPS。

## 自动部署（GitHub Actions）

推送到 main 分支即自动部署到 Cloudflare Pages。

### 首次配置

**1. 设置 GitHub Secrets**（仓库 → Settings → Secrets and variables → Actions）

| Secret 名称 | 说明 | 获取方式 |
|---|---|---|
| `CF_API_TOKEN` | Cloudflare API Token | Dashboard → My Profile → API Tokens → Create Token，权限选 "Edit Cloudflare Workers" 模板（含 Pages + D1） |
| `CF_ACCOUNT_ID` | Cloudflare Account ID | Dashboard 右侧栏 → Account ID |
| `ENCRYPTION_KEY` | 加密密钥 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成 |

**2. 推送代码**

```bash
git push origin main
```

GitHub Actions 自动完成：创建 D1 → 初始化表 → 部署到 Pages。首次约 1-2 分钟。

**3. 查看部署状态**

仓库 → Actions 标签页查看运行日志。部署成功后输出 Pages URL。

### 后续更新

修改代码 → `git push` → 自动部署。

## 手动部署（替代方案）

```bash
cd cloudflare
./deploy.sh          # 完整部署
./deploy.sh init     # 仅初始化（创建 D1 + 建表 + 打印密钥）
```

## 可选操作

- **绑定自定义域名**：Cloudflare Dashboard → Pages → 自定义域名
- **设置提供商 API Key**：访问部署 URL → 管理后台 → 提供商设置
- **本地开发**：`npx wrangler pages dev . --d1 DB=9router-lite-db`

## 限制

- Workers 免费版 CPU 限制 10ms/请求（聊天请求主要等外部 API，不计 CPU 时间）
- 密码哈希用 PBKDF2（Node 版用 scrypt，两者不互通）
- 与 Node 版数据不互通（独立 D1 数据库）

## 文件结构

```
├── .github/workflows/deploy.yml  # GitHub Actions 自动部署
├── deploy.sh                     # 手动部署脚本
├── index.html                    # Web UI
├── functions/[[path]].js         # Pages Functions 入口
├── lib/
│   ├── api.js                    # API 逻辑
│   ├── db.js                     # D1 适配层
│   └── crypto.js                 # Web Crypto 加密
├── schema.sql                    # D1 建表 SQL
├── wrangler.toml                 # Cloudflare 配置
└── package.json
```
