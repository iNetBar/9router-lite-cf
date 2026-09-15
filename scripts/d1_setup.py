#!/usr/bin/env python3
"""D1 数据库设置：查询或创建，输出 UUID"""
import json, os, sys, urllib.request

API_TOKEN = os.environ['CLOUDFLARE_API_TOKEN'].strip()
ACCOUNT_ID = os.environ['CLOUDFLARE_ACCOUNT_ID'].strip()
DB_NAME = '9router-lite-db'
API = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database'
HEADERS = {'Authorization': f'Bearer {API_TOKEN}', 'Content-Type': 'application/json'}

# 1. 查询已有数据库
print('Querying existing D1 databases ...')
req = urllib.request.Request(API, headers=HEADERS)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)

if not data.get('success'):
    print(f'API error: {data.get("errors")}', file=sys.stderr)
    sys.exit(1)

dbs = data.get('result', [])
print(f'Found {len(dbs)} databases:')
for d in dbs:
    print(f'  - {d.get("name")} : {d.get("uuid")}')

match = [d for d in dbs if d.get('name') == DB_NAME]
if match:
    print(f'Found existing D1: {match[0]["uuid"]}')
    print(match[0]['uuid'])
    sys.exit(0)

# 2. 不存在则创建
print(f'Creating D1 database {DB_NAME} ...')
req = urllib.request.Request(API, data=json.dumps({'name': DB_NAME}).encode(), headers=HEADERS, method='POST')
try:
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    if data.get('success'):
        uuid = data.get('result', {}).get('uuid', '')
        print(f'Created D1: {uuid}')
        print(uuid)
        sys.exit(0)
    else:
        print(f'Create error: {data.get("errors")}', file=sys.stderr)
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f'Create failed (HTTP {e.code}): {body}', file=sys.stderr)

sys.exit(1)
