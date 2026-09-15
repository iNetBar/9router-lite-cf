#!/usr/bin/env bash
# 9router-lite Cloudflare Pages 一键部署脚本
# 用法: ./deploy.sh
# 首次运行自动完成: 创建 D1 → 初始化表 → 生成加密密钥 → 部署
# 后续运行: 同步 index.html → 部署

set -euo pipefail
cd "$(dirname "$0")"

DB_NAME="9router-lite-db"
TOML="wrangler.toml"
ROOT_DIR="$(cd .. && pwd)"

echo "🚀 9router-lite Cloudflare 部署"
echo "=============================="

# ---- 1. 同步 index.html ----
echo "📋 [1/5] 同步 index.html ..."
cp "$ROOT_DIR/index.html" ./index.html
echo "   ✓ 已同步"

# ---- 2. 检查/创建 D1 数据库 ----
echo "🗄️  [2/5] 检查 D1 数据库 ..."

DB_ID=$(grep -oP 'database_id\s*=\s*"\K[^"]+' "$TOML" 2>/dev/null || echo "")

if [ -z "$DB_ID" ] || [ "$DB_ID" = "在此填入你的数据库ID" ]; then
  echo "   首次部署，创建 D1 数据库 ..."
  CREATE_OUTPUT=$(npx wrangler d1 create "$DB_NAME" 2>&1) || {
    # 库已存在时 wrangler 报错，尝试从 list 获取 ID
    echo "   数据库可能已存在，尝试获取 ID ..."
    CREATE_OUTPUT=$(npx wrangler d1 list 2>&1)
  }
  DB_ID=$(echo "$CREATE_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' | head -1)

  if [ -z "$DB_ID" ]; then
    # 兜底：从输出中提取 UUID 格式的 ID
    DB_ID=$(echo "$CREATE_OUTPUT" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  fi

  if [ -z "$DB_ID" ]; then
    echo "   ✗ 无法获取 database_id，请手动创建: npx wrangler d1 create $DB_NAME"
    echo "   然后将输出的 database_id 填入 wrangler.toml"
    exit 1
  fi

  # 写入 wrangler.toml
  sed -i.bak "s/database_id = .*/database_id = \"$DB_ID\"/" "$TOML" && rm -f "$TOML.bak"
  echo "   ✓ 数据库已创建，ID: $DB_ID"
else
  echo "   ✓ 已配置 (ID: $DB_ID)"
fi

# ---- 3. 初始化数据库表 ----
echo "📝 [3/5] 初始化数据库表 ..."
npx wrangler d1 execute "$DB_NAME" --file=./schema.sql --remote 2>&1 | grep -E '(✅|✓|executed|error|Error)' || true
echo "   ✓ 表结构已就绪"

# ---- 4. 检查/生成加密密钥 ----
echo "🔐 [4/5] 检查加密密钥 ..."

KEY_EXISTS=$(grep -oP 'ENCRYPTION_KEY\s*=\s*"\K[^"]+' "$TOML" 2>/dev/null || echo "")

if [ -z "$KEY_EXISTS" ]; then
  echo "   首次部署，生成 32 字节加密密钥 ..."
  NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  # 在 [vars] 下添加 ENCRYPTION_KEY
  if grep -q '\[vars\]' "$TOML"; then
    sed -i.bak "/\[vars\]/a\\ENCRYPTION_KEY = \"$NEW_KEY\"" "$TOML" && rm -f "$TOML.bak"
  else
    echo "" >> "$TOML"
    echo "[vars]" >> "$TOML"
    echo "ENCRYPTION_KEY = \"$NEW_KEY\"" >> "$TOML"
  fi
  echo "   ✓ 密钥已生成并写入 wrangler.toml"
  echo "   ⚠️  密钥已写入配置文件，请勿提交到公开仓库"
  echo "   （生产环境建议改用: npx wrangler pages secret put ENCRYPTION_KEY）"
else
  echo "   ✓ 密钥已配置"
fi

# ---- 5. 部署 ----
echo "📤 [5/5] 部署到 Cloudflare Pages ..."
npx wrangler pages deploy .

echo ""
echo "=============================="
echo "✅ 部署完成！"
echo ""
echo "后续更新只需再次运行: ./deploy.sh"
echo ""
echo "可选操作:"
echo "  - 绑定自定义域名: Cloudflare Dashboard → Pages → 自定义域名"
echo "  - 设置提供商 API Key: 访问部署 URL → 管理后台 → 提供商设置"
echo "  - 迁移密钥到 secret: npx wrangler pages secret put ENCRYPTION_KEY"
