---
name: passkey-box
description: 用户要在 Passkey Box（自托管通行密钥管理器）上查询、共享、转移或删除通行密钥，修改它们的名称、备注和自定义字段，或者以管理员身份批量管理用户、交接离职人员的账号、查看操作日志时使用。
---

# Passkey Box API 使用说明

Passkey Box 是多用户、自托管的通行密钥（passkey）管理器：Chrome 扩展用服务端保存的私钥替用户完成网站的 WebAuthn 注册和登录，Web 后台管理通行密钥和用户。这份说明告诉你如何通过 HTTP API 替用户完成管理操作。

- 服务器地址：`{{base_url}}`
- 所有 API 都在 `{{base_url}}/api/v1` 下
- 本说明：`{{base_url}}/skill.md`

## 1. 认证：API 令牌

1. 请用户在 Web 后台的「Agent 接入」页（`{{base_url}}/#/agent`）创建一个 API 令牌，可以设为只读、可以设有效期。令牌以 `pkb_` 开头，共 47 个字符，明文只在创建时显示一次，请用户直接交给你。
2. 每个请求带请求头 `Authorization: Bearer pkb_…`。
3. 开始前先调用 `GET /api/v1/me`：`user.is_admin` 为 `true` 才能调用 `/api/v1/admin/*`；`auth.read_only` 为 `true` 表示这个令牌只能发 GET 请求。

```bash
export PKB_URL="{{base_url}}"
export PKB_TOKEN="pkb_…"        # 用户交给你的令牌
AUTH="Authorization: Bearer $PKB_TOKEN"
JSON="Content-Type: application/json"
curl -sS "$PKB_URL/api/v1/me" -H "$AUTH"
```

令牌的边界：

- 令牌继承用户的角色：管理员的令牌能调用管理员接口，普通用户的令牌只能操作自己的通行密钥和共享给自己的通行密钥。
- 令牌**永远拿不到私钥**，响应里没有 `private_key` 字段。但可写的令牌能把通行密钥共享或转移给别人；只在用户明确要求时才这样做，并且先 dry run 确认对象。
- 令牌不能修改密码，也不能创建、查看或吊销令牌：`PUT /api/v1/me/password` 和 `/api/v1/me/tokens` 系列接口返回 403 `token_not_allowed`；通过管理员接口修改令牌自己用户的密码返回 400。
- 管理员的令牌能做管理员能做的一切。不要用创建用户、重置密码再用 HTTP Basic 登录的办法绕过「令牌拿不到私钥」，这是安全守则第 2 条明令禁止的。
- 令牌无效、过期或已被吊销时返回 401 `unauthorized`；账户被停用时返回 403 `account_disabled`；只读令牌发起写请求返回 403 `read_only_token`。遇到这些情况，停下来告诉用户，不要换别的方式重试。

## 2. 概念

- **用户**：登录 Passkey Box 的人。用户名大小写不敏感地唯一（`Alice` 和 `alice` 是同一个人）。用户可以是管理员（`is_admin`），可以被停用（`disabled`，停用后无论哪种方式都登录不了）。管理员可以给用户写备注（`note`）。
- **通行密钥（credential，也叫凭据）**：某个用户在某个网站（`rp_id`，例如 `github.com`）上的一个账号（`user_name`，例如 `alice@example.com`）。`id` 是全站唯一的 base64url 字符串。
- **名称与自定义字段**：网站名称（`rp_name`，列表标题）、用户名（`user_name`）、显示名（`user_display_name`）是注册时网站给的，只用于展示，可以修改。每条通行密钥还可以带最多 50 个**自定义字段**（`fields`），像 1Password 一样记录密码、恢复码、TOTP 密钥、网址等。字段的值对能看到这条通行密钥的所有人可见，包括被共享人、管理员和令牌。
- **主人（owner）**：每条通行密钥有且只有一个主人。只有主人和管理员能改备注、名称和自定义字段，删除、共享、转移。
- **共享（share）**：主人把通行密钥共享给其他用户。被共享人能看到它（包括自定义字段），扩展能用它登录网站；被共享人可以自己退出共享，但不能改备注、名称和字段，不能删除、再共享或转移。**共享就是把私钥交给对方的扩展，撤销共享只能阻止对方以后再拉取，不能保证对方没有留存。**
- **转移（transfer）**：把通行密钥换给另一个主人，立即生效，不需要对方确认。原主人默认失去访问；`keep_access: true` 时原主人变为被共享人。其他人的共享保留；新主人原本是被共享人时，那条共享删除。
- **管理员**：通过 `/api/v1/admin/*` 管理所有用户，并对任何人的任何通行密钥做以上所有操作。
- **操作日志（audit）**：每个写操作都记录执行人（`actor`）、认证方式（`via`：`session`、`basic`、`token:<令牌名>` 或 `system`）、受影响的用户（`subject`）、另一方（`target`）和通行密钥。你用令牌做的每一步都会以 `token:<令牌名>` 记下来。登录、读操作不记录。

## 3. 安全守则（必须遵守）

1. **先预览，再执行。** 转移、删除（通行密钥或用户）、停用用户、重置密码、撤销会话、撤销共享，以及所有批量写操作，先用 `"dry_run": true` 发一次，把预览结果（涉及哪些用户、哪些网站和账号、条目数、`warnings`）整理成人能看懂的清单交给用户确认。用户明确同意后，再用同一个请求体、`"dry_run": false` 执行。`POST /api/v1/admin/users/{user_id}/revoke-sessions` 和单个的 `DELETE` 接口没有 dry run，执行前先用 GET 接口查出对象并向用户确认。
2. **永远不要试图获取、推断或输出私钥。** 不要索要用户的密码，不要尝试用 HTTP Basic 认证绕过令牌的限制，不要把令牌写进文件、代码仓库或日志，展示命令时用 `$PKB_TOKEN` 代替令牌。`password` 和 `totp` 类型字段的值同样是机密，只在用户明确要求时输出。
3. **只读令牌只做查询。** `GET /api/v1/me` 返回 `auth.read_only: true` 时，只调用 GET 接口；用户要求写操作时，告诉他需要一个可写的令牌。
4. **确认操作对象。** 用户名可能拼错或有歧义时，先用 `GET /api/v1/users` 或 `GET /api/v1/admin/users?q=` 查出准确的用户；要操作的通行密钥先用列表接口查出 `id`，不要猜测 ID。批量操作前确认范围，例如列表的 `total` 是否超过了一页。
5. **共享和转移会交出私钥。** 执行前提醒用户：对方会拿到私钥，事后撤销也收不回来。
6. **出错就停下。** 批量接口返回带 `items` 的 400 时整批都没有生效，把每个失败条目的原因告诉用户，修正后再整批重发；不要只重发成功的那部分。

## 4. 约定

- 请求和响应都是 JSON，写请求带 `Content-Type: application/json`。
- 时间是 RFC 3339 UTC 字符串（`2026-11-20T03:30:00Z`），没有值时为 `null`。凭据 ID、`user_handle` 是 base64url（无填充）。
- 单个对象放在同名字段里（`{"user": {…}}`），列表放在复数字段里（`{"users": […]}`），空列表是 `[]`。
- 错误时返回 `{"error": {"code": "…", "message": "…"}}`：

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | JSON 错误、字段缺失或不合法；批量请求有条目失败（带 `items`） |
| 400 | `invalid_password` | 修改密码时旧密码错误 |
| 401 | `unauthorized` | 没有认证、令牌无效或过期 |
| 403 | `forbidden` | 不是管理员却调用 `/api/v1/admin/*`；被共享人做只有主人能做的操作 |
| 403 | `account_disabled` | 账户已被停用 |
| 403 | `read_only_token` | 只读令牌发起写请求 |
| 403 | `token_not_allowed` | 这个接口不接受 API 令牌 |
| 403 | `registration_disabled` | 服务端没有开放自助注册 |
| 404 | `not_found` | 资源不存在，或者你无权访问这条通行密钥 |
| 409 | `conflict` | 用户名已存在、凭据 ID 已存在 |
| 500 | `internal` | 服务端错误 |

### 批量接口

`share`、`unshare`、`transfer`、`leave` 和路径里带 `batch-` 的接口都是批量接口。

- **全有或全无**：所有条目在一个事务里校验和执行，任何一条失败整批都不生效，返回 400，`error.items` 列出每个失败的条目：

  ```json
  {"error": {"code": "invalid_request", "message": "2 items failed",
    "items": [
      {"field": "ids", "index": 1, "value": "Y3JlZA", "code": "not_found", "message": "credential not found"},
      {"field": "users", "index": 0, "value": "bob", "code": "not_found", "message": "user not found"}
    ]}}
  ```

  `field` 是出错的请求字段（`ids`、`users`、`items`、`to`、`transfer_credentials_to`），`index` 是它在数组里的下标（`to` 这类单值字段为 0），`value` 是请求里的原值（`batch-create` 里是用户名），`code` 是 `not_found`、`forbidden`、`conflict` 或 `invalid_request`。数组里重复的条目报 `invalid_request`（`duplicate item`）。请求体本身不合法（JSON 错误、缺字段、数组为空或超过上限）时返回不带 `items` 的普通 400。
- **`dry_run`**：带 `"dry_run": true` 时完整执行校验和计算，返回与真实执行形状相同的结果，然后全部回滚：不落库、不写操作日志。响应里有 `"dry_run": true` 或 `false`。
- 每条结果的 `warnings` 总是数组，没有警告时为 `[]`。
- **上限**：`ids` 最多 1000 个；`share`、`unshare` 和 `admin/users/batch-delete` 的 `users` 最多 100 个；凭据数 × 用户数最多 10000；`batch-create` 最多 200 个用户；`batch-update` 最多 1000 条。

### 用户引用

请求体里引用用户时，**JSON 数字是用户 ID，JSON 字符串是用户名**（大小写不敏感），例如 `"to": "bob"` 和 `"to": 3` 都可以。路径参数 `{user_id}` 只接受数字 ID。

### 分页

- 操作日志（`GET /api/v1/me/activity`、`GET /api/v1/admin/audit`）：`limit` 默认 50，范围 1–200；`before` 只返回 ID 小于它的事件，新的在前。响应里的 `next_before` 不为 `null` 时，把它作为下一页的 `before`；为 `null` 表示没有更多了。
- `GET /api/v1/admin/credentials`：`limit` 默认 100，范围 1–500；`offset` 默认 0；响应里的 `total` 是符合条件的总数。
- 参数越界或格式不对（例如 `limit=0`、`limit=1000`、`user_id=abc`）返回 400，不会自动截断。

## 5. 接口

「主人」指通行密钥的 owner。没有特别说明时：资源不存在返回 404，没有认证返回 401，不是管理员调用管理员接口返回 403。

### 公共（无需认证）

| 方法与路径 | 说明 |
|---|---|
| `GET /skill.md` | 本说明 |
| `GET /healthz` | `{"status": "ok", "version": "…"}` |
| `GET /downloads/passkey-box-extension.zip` | 扩展安装包，没有配置时 404 |
| `GET /api/v1/info` | `{"version", "allow_register", "extension_download", "skill_url"}` |
| `POST /api/v1/auth/login` | Web 后台用密码登录并设置会话 Cookie。Agent 不要使用 |
| `POST /api/v1/auth/logout` | 退出 Web 后台会话，204 |
| `POST /api/v1/auth/register` | 自助注册（服务端开启时），Agent 不要使用 |

### 当前用户

| 方法与路径 | 请求 | 响应与规则 |
|---|---|---|
| `GET /api/v1/me` | — | `{"user": User, "auth": {"method": "token", "read_only": false, "token": Token}}` |
| `PUT /api/v1/me/password` | `{"old_password", "new_password"}` | 204。令牌不能调用（403 `token_not_allowed`） |
| `GET /api/v1/me/tokens` | — | `{"tokens": [Token]}`。令牌不能调用 |
| `POST /api/v1/me/tokens` | `{"name", "read_only", "expires_in_days"}` | 201 `{"token": Token, "secret": "pkb_…"}`。令牌不能调用 |
| `DELETE /api/v1/me/tokens/{token_id}` | — | 204。令牌不能调用 |
| `GET /api/v1/me/activity` | 参数 `before`、`limit` | `{"events": [AuditEvent], "next_before": 41}`：与我有关（我是执行人、受影响的用户或另一方）的操作日志；不是管理员时，管理员备注的内容显示为 `"note": true` |
| `GET /api/v1/users` | — | `{"users": [UserBrief]}`：所有未停用的用户，按用户名排序，用来选择共享对象 |

### 通行密钥（当前用户）

| 方法与路径 | 请求 | 响应与规则 |
|---|---|---|
| `GET /api/v1/credentials` | 参数 `rp_id`（大小写不敏感精确匹配）、`access`（`all` 默认、`owned`、`shared`） | `{"credentials": [Credential]}`：我拥有的和共享给我的，按创建时间倒序 |
| `POST /api/v1/credentials` | Credential 的注册字段 | 扩展注册通行密钥时调用，Agent 不要使用 |
| `GET /api/v1/credentials/{id}` | — | `{"credential": Credential}`；无权访问 404 |
| `PATCH /api/v1/credentials/{id}` | `{"label"?, "rp_name"?, "user_name"?, "user_display_name"?, "fields"?}`，至少带一个 | `{"credential": Credential}`。只写变化的项；`fields` **整体替换**字段列表（见第 6 节 Field 和第 7 节的例子）。名称去掉首尾空白后最多 1000 个字符，可以为空。只有主人能改，被共享人 403 `forbidden`。什么都没带或值不合法返回 400，`message` 说明原因，例如 `fields[3]: invalid TOTP secret` |
| `POST /api/v1/credentials/{id}/use` | — | 扩展每次签名后调用，用于使用统计。Agent 不要调用 |
| `DELETE /api/v1/credentials/{id}` | — | 204。主人调用时删除这条通行密钥（共享一并删除）；被共享人调用时只退出共享 |
| `POST /api/v1/credentials/share` | `{"ids": […], "users": [ref…], "dry_run": false}` | 只能共享自己拥有的。结果每个（凭据, 用户）一条：`{"credential": CredentialBrief, "user": UserBrief, "status": "shared"或"unchanged", "warnings": []}`。对象是主人本人报 `invalid_request`；对象已停用时成功但带警告 `user is disabled` |
| `POST /api/v1/credentials/unshare` | `{"ids": […], "users": [ref…]}` 或 `{"ids": […], "all": true}`（两者恰好给一个），可带 `dry_run` | 结果同上，`status` 为 `unshared` 或 `unchanged`；`all: true` 时每条现有共享一条结果 |
| `POST /api/v1/credentials/transfer` | `{"ids": […], "to": ref, "keep_access": false, "dry_run": false}` | 只能转移自己拥有的。结果 `{"credential", "from", "to", "status": "transferred"或"unchanged", "keep_access", "warnings"}`。`to` 已停用、`to` 已有同一网站同一账号的通行密钥时带警告 |
| `POST /api/v1/credentials/leave` | `{"ids": […], "dry_run": false}` | 退出别人共享给我的。结果 `{"credential", "status": "left", "warnings"}`；不是共享给我的报 `not_found` |
| `POST /api/v1/credentials/batch-delete` | `{"ids": […], "dry_run": false}` | 拥有的删除，共享给我的退出共享。结果 `status` 为 `deleted` 或 `left` |

批量条目里，无权访问的 ID 报 `not_found`；是共享给我的、但操作需要主人时报 `forbidden`。

### 管理员：概览与操作日志

| 方法与路径 | 请求 | 响应与规则 |
|---|---|---|
| `GET /api/v1/admin/overview` | — | `{"users": {"total", "admins", "disabled"}, "credentials": {"total", "shared", "shares", "sites"}, "sites": [{"rp_id", "credentials", "owners"}], "recent_events": [AuditEvent]}`。`credentials.shared` 是有共享的通行密钥数，`shares` 是共享关系数，`sites` 是不同网站数；`sites` 列表按通行密钥数取前 20；`recent_events` 是最近 10 条操作日志 |
| `GET /api/v1/admin/audit` | 参数 `user_id`（执行人、受影响的用户或另一方之一）、`actor_id`、`action`（精确匹配；以 `.` 结尾时按前缀，例如 `credential.`）、`credential_id`、`before`、`limit` | `{"events": [AuditEvent], "next_before": id或null}`，新的在前 |

### 管理员：用户

| 方法与路径 | 请求 | 响应与规则 |
|---|---|---|
| `GET /api/v1/admin/users` | 参数 `q`（用户名或备注里的子串，大小写不敏感）、`role`（`admin`、`user`）、`status`（`active`、`disabled`） | `{"users": [AdminUser]}`，按 ID 升序 |
| `POST /api/v1/admin/users` | `{"username", "password", "is_admin"?, "note"?}` | 201 `{"user": AdminUser}`；重名 409 |
| `GET /api/v1/admin/users/{user_id}` | — | `{"user": AdminUser}` |
| `PATCH /api/v1/admin/users/{user_id}` | `{"username"?, "password"?, "is_admin"?, "disabled"?, "note"?}` | `{"user": AdminUser}`。不能取消自己的管理员身份、不能停用自己、不能用令牌修改自己的密码（400）；改名重名 409。密码最多 72 个字节。改名后旧用户名立即失效，该用户要在扩展里用新用户名重新登录 |
| `DELETE /api/v1/admin/users/{user_id}` | — | 204。一并删除他拥有的通行密钥、共享给他的关系、会话和令牌；不能删除自己（400）。要保留他的通行密钥请用 batch-delete 的 `transfer_credentials_to` |
| `POST /api/v1/admin/users/{user_id}/revoke-sessions` | — | `{"sessions": n, "tokens": n}`：删除他的全部会话和 API 令牌。密码不变，扩展照常可用；要彻底阻止访问请停用账户或重置密码 |
| `GET /api/v1/admin/users/{user_id}/credentials` | 参数 `access` 同 `GET /api/v1/credentials` | `{"credentials": [Credential]}`：他拥有的和共享给他的，`access` 相对于他 |
| `DELETE /api/v1/admin/users/{user_id}/credentials/{id}` | — | 204。他拥有的通行密钥被删除；共享给他的只撤销这条共享 |
| `POST /api/v1/admin/users/batch-create` | `{"users": [{"username", "password"?, "is_admin"?, "note"?}], "dry_run": false}` | `{"dry_run", "results": [{"user": AdminUser, "password": "…"}]}`。省略 `password` 时服务端生成 16 位字母数字随机密码，只在这次响应里出现一次；dry run 不返回密码，`user.id` 是临时值。用户名已存在或批内重名报 `conflict` |
| `POST /api/v1/admin/users/batch-update` | `{"items": [{"user": ref, "username"?, "password"?, "generate_password"?, "is_admin"?, "disabled"?, "note"?}], "dry_run": false}` | `{"dry_run", "results": [{"user": AdminUser, "changes": ["disabled"], "password": "…"}]}`。`changes` 是实际变化的字段；`password` 只在 `generate_password: true` 且不是 dry run 时出现。`password` 与 `generate_password` 互斥（400）。同一用户出现两次、取消自己的管理员、停用自己报 `invalid_request` |
| `POST /api/v1/admin/users/batch-delete` | `{"users": [ref…], "transfer_credentials_to": ref?, "dry_run": false}` | `{"dry_run", "results": [{"user": UserBrief, "credentials_deleted": n, "credentials_transferred": n}]}`。给了交接对象时，先把这些用户拥有的全部通行密钥转给他（其他共享保留，交接对象原本对它们的共享删除），再删除用户；否则通行密钥随用户删除。交接对象不能在删除列表里、不能是停用用户（条目错误的 `field` 为 `transfer_credentials_to`）；不能删除自己 |

### 管理员：通行密钥

| 方法与路径 | 请求 | 响应与规则 |
|---|---|---|
| `GET /api/v1/admin/credentials` | 参数见下 | `{"credentials": [Credential], "total": n, "limit": n, "offset": n}`，按创建时间倒序 |
| `GET /api/v1/admin/credentials/{id}` | — | `{"credential": Credential}` |
| `PATCH /api/v1/admin/credentials/{id}` | 同 `PATCH /api/v1/credentials/{id}` | `{"credential": Credential}`，任何人的通行密钥 |
| `DELETE /api/v1/admin/credentials/{id}` | — | 204 |
| `POST /api/v1/admin/credentials/share` | 同 `POST /api/v1/credentials/share` | 可以共享任何人的通行密钥 |
| `POST /api/v1/admin/credentials/unshare` | 同 `POST /api/v1/credentials/unshare` | 任何人的通行密钥 |
| `POST /api/v1/admin/credentials/transfer` | 同 `POST /api/v1/credentials/transfer` | 任何人的通行密钥 |
| `POST /api/v1/admin/credentials/batch-delete` | `{"ids": […], "dry_run": false}` | 结果 `status` 一律为 `deleted` |

`GET /api/v1/admin/credentials` 的参数：`owner` / `owner_id`（主人的用户名 / ID）、`shared_with` / `shared_with_id`（共享给了这个用户）、`rp_id`（大小写不敏感精确匹配）、`q`（在 `rp_id`、`rp_name`、`user_name`、`user_display_name`、`label`、自定义字段的 `label`（不含字段的值）和主人用户名里做大小写不敏感的子串匹配）、`shared`（`true` 只看有共享的，`false` 只看没有共享的）、`limit`、`offset`。引用的用户不存在时返回空列表。

## 6. 数据对象

**User**

```json
{"id": 1, "username": "alice", "is_admin": false, "disabled": false,
 "created_at": "2026-11-20T03:30:00Z", "credential_count": 3, "shared_in_count": 1, "shared_out_count": 2,
 "last_used_at": "2026-11-20T04:00:00Z"}
```

`credential_count` 是拥有的通行密钥数，`shared_in_count` 是别人共享给他的数量，`shared_out_count` 是他拥有的、至少共享给了一个人的数量，`last_used_at` 是他拥有的通行密钥最近一次使用的时间。管理员接口返回的 **AdminUser** 额外带 `"note"`（管理员备注）。

**UserBrief**：`{"id": 1, "username": "alice"}`。

**Credential**（令牌看到的版本，没有 `private_key`）

```json
{"id": "q3Jt7c2pYgS2b6l1vV2kQw", "rp_id": "github.com", "rp_name": "GitHub",
 "user_handle": "MTIzNDU2", "user_name": "alice@example.com", "user_display_name": "Alice",
 "alg": -7, "public_key": "MFkw…", "sign_count": 0, "label": "工作号",
 "fields": [{"id": "Xk3pQ9aB", "label": "恢复码", "type": "password", "value": "abcd-efgh"}],
 "origin": "https://github.com", "created_at": "2026-11-20T03:30:00Z", "last_used_at": null, "use_count": 0,
 "owner": {"id": 1, "username": "alice"}, "access": "owner", "shared_at": null,
 "shared_with": [{"user": {"id": 2, "username": "bob"}, "shared_at": "2026-11-21T08:00:00Z",
                  "shared_by": {"id": 1, "username": "alice"}, "last_used_at": null}]}
```

- `owner` 总是有。`access` 是 `"owner"` 或 `"shared"`，相对于这份列表所属的用户（`/api/v1/credentials` 是你，`/api/v1/admin/users/{user_id}/credentials` 是该用户）；`/api/v1/admin/credentials` 和批量结果里没有 `access`。
- `shared_at` 只在 `access` 为 `"shared"` 时有值。`shared_with` 列出共享给了谁，主人和管理员能看到，被共享人看不到。
- 能访问一条通行密钥的人 = `owner` + `shared_with` 里的每个 `user`。
- `fields` 总是数组（没有字段时为 `[]`），顺序就是用户排列的顺序。

**Field**（自定义字段）：`{"id": "Xk3pQ9aB", "label": "恢复码", "type": "password", "value": "abcd-efgh"}`

- `id` 由服务端分配（8 个字符）。修改时带回已有字段的 `id` 保持它的身份；新字段不带 `id`。
- `label` 去掉首尾空白后最多 100 个字符，可以为空。
- `type` 是 `text`、`password`、`url`、`email`、`phone`、`date`、`multiline`、`totp` 之一。
- `value` 最多 10000 个字符。`date` 为空或 `YYYY-MM-DD`；`totp` 是 base32 密钥（如 `JBSWY3DPEHPK3PXP`，不区分大小写，空格和 `-` 会被忽略）或 `otpauth://totp/…?secret=…` 链接（可带 `issuer`、`algorithm`=`SHA1`/`SHA256`/`SHA512`、`digits`=6–8、`period`=1–300）。服务端不计算验证码。
- 每次 PATCH 最多 50 个字段，label 最多 100 个字符，value 最多 10000 个字符；备注（`label`）和三个名称最多 1000 个字符。`url`、`email`、`phone` 不能含控制字符，其中的 Unicode 双向格式字符保存时会被去掉。
- PATCH 凭据的请求体最大 8 MiB，其他接口 1 MiB，超过返回 413。

**CredentialBrief**（批量结果里，不带 `fields`）：`{"id", "rp_id", "user_name", "owner": UserBrief}`。

**Token**：`{"id": 3, "name": "claude", "prefix": "pkb_AbCdEfGh", "read_only": false, "created_at": "…", "expires_at": null, "last_used_at": null}`。

**AuditEvent**

```json
{"id": 42, "at": "2026-11-22T10:00:00Z", "actor": {"id": 1, "username": "admin"}, "via": "token:claude",
 "action": "credential.transfer", "subject": {"id": 2, "username": "alice"}, "target": {"id": 3, "username": "bob"},
 "credential": {"id": "q3Jt7c2pYgS2b6l1vV2kQw", "rp_id": "github.com", "user_name": "alice@example.com"},
 "detail": {"keep_access": false}}
```

`actor` 为 `null` 表示服务端自己做的操作；`target`、`credential` 没有时为 `null`；`detail` 没有内容时为 `{}`。事件里的用户名是当时的名字，用户删除后保留。

| action | subject | target | detail |
|---|---|---|---|
| `user.create` | 新用户 | — | `{"is_admin": bool}` |
| `user.update` | 被修改的用户（修改前的名字） | — | `{"changes": {…}}`，只列实际变化的项：`username`、`is_admin`、`disabled`、`note` 为 `{"from", "to"}`，`password` 为 `true` |
| `user.delete` | 被删除的用户 | 交接对象或 `null` | `{"credentials_deleted": n, "credentials_transferred": n}` |
| `user.revoke_sessions` | 用户 | — | `{"sessions": n, "tokens": n}` |
| `credential.create` | 主人 | — | `{}` |
| `credential.update` | 主人 | — | 只列变化的项：`label`、`rp_name`、`user_name`、`user_display_name` 为 `{"from", "to"}`；`fields` 为 `{"added", "removed", "changed"}`，各是字段 label 的数组，不记字段的值 |
| `credential.delete` | 主人 | — | `{}` |
| `credential.share` | 主人 | 被共享人 | `{}` |
| `credential.unshare` | 主人 | 被共享人 | `{}` |
| `credential.leave` | 主人 | 被共享人（即执行人） | `{}` |
| `credential.transfer` | 原主人 | 新主人 | `{"keep_access": bool}` |
| `token.create` / `token.revoke` | 令牌主人 | — | `{"name": "…", "read_only": bool}` |

## 7. 常用操作

下面的命令沿用第 1 节的 `PKB_URL`、`AUTH`、`JSON` 变量，`jq` 只用来整理输出。

### 批量创建用户

```bash
# 1. 预览：省略 password 的用户由服务端生成随机密码
curl -sS -X POST "$PKB_URL/api/v1/admin/users/batch-create" -H "$AUTH" -H "$JSON" \
  -d '{"users": [{"username": "alice"}, {"username": "bob", "note": "市场部"}, {"username": "carol", "is_admin": true}], "dry_run": true}'
# 2. 用户确认后正式执行；生成的密码只在这次响应里出现，原样交给用户保存
curl -sS -X POST "$PKB_URL/api/v1/admin/users/batch-create" -H "$AUTH" -H "$JSON" \
  -d '{"users": [{"username": "alice"}, {"username": "bob", "note": "市场部"}, {"username": "carol", "is_admin": true}], "dry_run": false}' \
  | jq -r '.results[] | [.user.username, .password // ""] | @csv'
```

### 批量停用、重置密码、改备注

```bash
curl -sS -X POST "$PKB_URL/api/v1/admin/users/batch-update" -H "$AUTH" -H "$JSON" \
  -d '{"items": [{"user": "dave", "disabled": true}, {"user": "erin", "generate_password": true}, {"user": 7, "note": "外包"}], "dry_run": true}'
# 确认后把 dry_run 改成 false 再发一次
```

### 把 alice 在 github.com 的全部账号转给 bob

```bash
# 1. 查出 alice 拥有的 github.com 通行密钥（total 超过 limit 时要用 offset 翻页）
curl -sS "$PKB_URL/api/v1/admin/credentials?owner=alice&rp_id=github.com&limit=500" -H "$AUTH" \
  | jq '{total, credentials: [.credentials[] | {id, user_name, label}]}'
IDS=$(curl -sS "$PKB_URL/api/v1/admin/credentials?owner=alice&rp_id=github.com&limit=500" -H "$AUTH" | jq -c '[.credentials[].id]')
# 2. 预览转移，检查 results 和 warnings，交给用户确认
curl -sS -X POST "$PKB_URL/api/v1/admin/credentials/transfer" -H "$AUTH" -H "$JSON" \
  -d "{\"ids\": $IDS, \"to\": \"bob\", \"keep_access\": false, \"dry_run\": true}"
# 3. 确认后执行
curl -sS -X POST "$PKB_URL/api/v1/admin/credentials/transfer" -H "$AUTH" -H "$JSON" \
  -d "{\"ids\": $IDS, \"to\": \"bob\", \"keep_access\": false, \"dry_run\": false}"
```

普通用户转移自己的通行密钥用 `POST /api/v1/credentials/transfer`，ID 从 `GET /api/v1/credentials?access=owned&rp_id=github.com` 查。

### 离职交接：删除 alice，把她的通行密钥交给 bob

```bash
# 1. 先看 alice 有哪些通行密钥
curl -sS "$PKB_URL/api/v1/admin/credentials?owner=alice&limit=500" -H "$AUTH" | jq '[.credentials[] | {rp_id, user_name}]'
# 2. 预览：结果里的 credentials_transferred 是会交给 bob 的数量
curl -sS -X POST "$PKB_URL/api/v1/admin/users/batch-delete" -H "$AUTH" -H "$JSON" \
  -d '{"users": ["alice"], "transfer_credentials_to": "bob", "dry_run": true}'
# 3. 用户确认后执行
curl -sS -X POST "$PKB_URL/api/v1/admin/users/batch-delete" -H "$AUTH" -H "$JSON" \
  -d '{"users": ["alice"], "transfer_credentials_to": "bob", "dry_run": false}'
```

只想暂时禁止访问、保留账户时，用 batch-update 的 `"disabled": true`。

### 修改名称和自定义字段

`PATCH` 没有 dry run，并且 `fields` 是整体替换：请求里没带上的已有字段会被删除。先取出现有字段，在它的基础上修改，发之前把改动告诉用户。

```bash
ID=q3Jt7c2pYgS2b6l1vV2kQw
# 1. 看现有的名称和字段
curl -sS "$PKB_URL/api/v1/credentials/$ID" -H "$AUTH" | jq '.credential | {rp_name, user_name, user_display_name, label, fields}'
# 2. 改网站名称，并在现有字段后面加一个 TOTP 字段（已有字段原样带上，包括 id）
FIELDS=$(curl -sS "$PKB_URL/api/v1/credentials/$ID" -H "$AUTH" \
  | jq -c '.credential.fields + [{"label": "两步验证", "type": "totp", "value": "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"}]')
curl -sS -X PATCH "$PKB_URL/api/v1/credentials/$ID" -H "$AUTH" -H "$JSON" \
  -d "{\"rp_name\": \"GitHub（公司）\", \"fields\": $FIELDS}" | jq '.credential | {rp_name, fields}'
```

只改名称或备注时不要带 `fields`。返回 400 时 `message` 指出哪个字段不合法（`fields[1]: …`，下标从 0 开始）。管理员修改别人的通行密钥时，把两个路径都换成 `/api/v1/admin/credentials/$ID`。在网站上重新注册同一账号时，改过的名称、备注和字段会保留。

### 盘点谁能访问某个账号

```bash
curl -sS "$PKB_URL/api/v1/admin/credentials?rp_id=github.com&q=alice%40example.com" -H "$AUTH" \
  | jq '.credentials[] | {id, user_name, owner: .owner.username, shared_with: [.shared_with[] | {user: .user.username, shared_at, shared_by: .shared_by.username}]}'
# 某条通行密钥的历史：谁创建、共享、转移过
curl -sS "$PKB_URL/api/v1/admin/audit?credential_id=q3Jt7c2pYgS2b6l1vV2kQw" -H "$AUTH"
```

### 共享与撤销

```bash
# 把自己的一条通行密钥共享给 bob 和 carol（先预览）
curl -sS -X POST "$PKB_URL/api/v1/credentials/share" -H "$AUTH" -H "$JSON" \
  -d '{"ids": ["q3Jt7c2pYgS2b6l1vV2kQw"], "users": ["bob", "carol"], "dry_run": true}'
# 撤销 bob 的共享
curl -sS -X POST "$PKB_URL/api/v1/credentials/unshare" -H "$AUTH" -H "$JSON" \
  -d '{"ids": ["q3Jt7c2pYgS2b6l1vV2kQw"], "users": ["bob"], "dry_run": true}'
# 撤销这条通行密钥的全部共享
curl -sS -X POST "$PKB_URL/api/v1/credentials/unshare" -H "$AUTH" -H "$JSON" \
  -d '{"ids": ["q3Jt7c2pYgS2b6l1vV2kQw"], "all": true, "dry_run": true}'
```

管理员操作别人的通行密钥时，把路径换成 `/api/v1/admin/credentials/share`、`/api/v1/admin/credentials/unshare`。

### 查操作日志

```bash
# 先查出 alice 的用户 ID
curl -sS "$PKB_URL/api/v1/admin/users?q=alice" -H "$AUTH" | jq '.users[] | {id, username}'
# 与 alice（ID 2）有关的凭据操作，每页 50 条
curl -sS "$PKB_URL/api/v1/admin/audit?user_id=2&action=credential.&limit=50" -H "$AUTH"
# 下一页：before 取上一页的 next_before
curl -sS "$PKB_URL/api/v1/admin/audit?user_id=2&action=credential.&limit=50&before=41" -H "$AUTH"
# 普通用户查看与自己有关的动态
curl -sS "$PKB_URL/api/v1/me/activity?limit=20" -H "$AUTH"
```
