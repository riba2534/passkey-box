# Passkey Box 服务端 HTTP API

服务端与 Chrome 扩展、Web 后台和 Agent 之间的接口约定。所有接口都在 `/api/v1` 下，请求和响应都是 JSON（`Content-Type: application/json; charset=utf-8`）。面向 Agent 的精简说明在服务端的 [`/skill.md`](#get-skillmd)。

## 约定

- **二进制字段**统一用 base64url（RFC 4648 §5，无 `=` 填充）：凭据 ID、`user_handle`、私钥、公钥。
- **时间**统一用 RFC 3339 UTC 字符串，例如 `2026-11-20T03:30:00Z`；没有值时为 `null`。
- **响应包装**：单个对象放在同名字段里（`{"user": {...}}`、`{"credential": {...}}`），列表放在复数字段里（`{"users": [...]}`、`{"credentials": [...]}`）。空列表返回 `[]`，不返回 `null`。
- **用户引用**：请求体里引用用户时，JSON 数字是用户 ID，JSON 字符串是用户名（大小写不敏感）。路径参数 `{user_id}` 只接受数字 ID。
- **错误**：非 2xx 时返回

  ```json
  {"error": {"code": "not_found", "message": "credential not found"}}
  ```

  | HTTP | code | 场景 |
  |---|---|---|
  | 400 | `invalid_request` | JSON 解析失败、字段缺失或不合法；批量请求有条目失败（带 `items`，见下文） |
  | 400 | `invalid_password` | 修改密码时旧密码错误 |
  | 401 | `unauthorized` | 未登录、Basic 认证失败、令牌无效或过期、会话过期 |
  | 403 | `forbidden` | 非管理员访问 `/api/v1/admin/*`；被共享人做只有主人能做的操作 |
  | 403 | `account_disabled` | 账户已被管理员停用 |
  | 403 | `read_only_token` | 只读令牌发起 GET 以外的请求 |
  | 403 | `token_not_allowed` | 该接口不接受 API 令牌（修改密码、管理令牌） |
  | 403 | `registration_disabled` | 未开启自助注册时调用注册接口 |
  | 404 | `not_found` | 资源不存在（包括无权访问的凭据） |
  | 409 | `conflict` | 用户名已存在、凭据 ID 已存在 |
  | 500 | `internal` | 其他错误 |

- **401 响应不带 `WWW-Authenticate` 头**，避免浏览器弹出原生 Basic 认证框。
- **CORS**：`/api/*` 对任意来源返回 `Access-Control-Allow-Origin: *`，允许 `Authorization, Content-Type` 头和 `GET, POST, PUT, PATCH, DELETE, OPTIONS` 方法；`OPTIONS` 预检直接返回 204。扩展在 service worker 里请求时并不依赖它，只是为了让其他客户端也能直接调用。

### 批量接口

名字里带 `batch-` 的接口，以及 `share`、`unshare`、`transfer`、`leave`，都是批量接口：

- **全有或全无**：所有条目在一个事务里校验和执行，任何一条失败就整批不生效，返回 400：

  ```json
  {"error": {"code": "invalid_request", "message": "2 items failed",
    "items": [
      {"field": "ids", "index": 1, "value": "Y3JlZA", "code": "not_found", "message": "credential not found"},
      {"field": "users", "index": 0, "value": "bob", "code": "not_found", "message": "user not found"}
    ]}}
  ```

  `field` 是出错的请求字段，`index` 是它在数组里的下标（`to` 这类单值字段为 0），`value` 是请求里的原值，`code` 与单个接口的错误码含义相同。数组里的重复条目报 `invalid_request`（`duplicate item`）。请求体本身不合法（JSON 错误、缺字段、数组为空或超过上限）时返回不带 `items` 的普通 400。
- **`dry_run`**：请求带 `"dry_run": true` 时完整执行校验和计算，返回与真实执行相同形状的结果，然后回滚，不落库、不写操作日志。响应带 `"dry_run": true|false`。破坏性操作建议先 dry run 再执行。
- **请求体**最大 1 MiB；`PATCH /credentials/{id}` 和 `PATCH /admin/credentials/{id}` 最大 8 MiB（够放最大的字段列表，即使所有字符都被转义）。超过返回 413 `invalid_request`。
- **上限**：`ids` 最多 1000 个；共享、撤销共享的 `users` 最多 100 个，凭据数 × 用户数最多 10000；`batch-create` 最多 200 个用户；`batch-update` 最多 1000 条。
- 每个条目结果里的 `warnings` 总是数组，没有警告时为 `[]`。

## 认证

三种方式，所有需要登录的接口都接受（个别接口不接受令牌，见下文）：

1. **HTTP Basic**：`Authorization: Basic base64(utf8(username + ":" + password))`。扩展每个请求都带这个头。**只有这种方式能拿到凭据私钥**。
2. **API 令牌**：`Authorization: Bearer pkb_…`。在 Web 后台「Agent 接入」页或 `POST /api/v1/me/tokens` 创建，明文只在创建时返回一次，服务端只保存 SHA-256。令牌继承用户的角色（管理员的令牌能调管理员接口），可以设为只读、可以设过期时间。**令牌的响应里永远没有私钥**；令牌不能修改自己用户的密码（包括通过管理员接口），也不能管理令牌。
   注意：管理员的令牌能做管理员能做的一切，包括创建用户、重置其他用户的密码、转移通行密钥，因此拿到管理员令牌的一方可以间接用 HTTP Basic 取得任何通行密钥。管理员令牌只交给完全信任的 Agent；只需要查询时用只读令牌。
3. **会话 Cookie**：Web 后台通过 `POST /api/v1/auth/login` 登录后拿到 `pkb_session` Cookie（HttpOnly、SameSite=Lax、Path=/、有效期 30 天；`PKB_COOKIE_SECURE=true` 时加 Secure）。会话也拿不到私钥。

请求带 `Authorization` 头且方案是 Basic 或 Bearer 时只用它认证，失败或格式不对都返回 401，不会再看 Cookie。被停用的用户无论用哪种方式都得到 403 `account_disabled`。

用会话 Cookie 发起的写请求（GET、HEAD 以外）必须来自同源页面：浏览器带的 `Sec-Fetch-Site` 不是 `same-origin`，或者没有它时 `Origin` 的主机与请求的 Host 不一致，返回 403 `forbidden`。这防止同一站点下的其他子域借用户的 Cookie 发起操作。Basic 和令牌不受影响。

可写的令牌能做令牌主人能做的写操作，包括把通行密钥共享或转移给别人，所以令牌泄露的影响范围包括主人全部通行密钥的私钥；只需要查询时请用只读令牌。

用户名去掉首尾空白后为 1–64 个字符，大小写不敏感地唯一（`Alice` 和 `alice` 是同一个用户），保存时保留原始大小写。密码 1–72 个字节（bcrypt 的上限），服务端用 bcrypt 存储。

## 数据对象

### User

```json
{
  "id": 1,
  "username": "alice",
  "is_admin": false,
  "disabled": false,
  "created_at": "2026-11-20T03:30:00Z",
  "credential_count": 3,
  "shared_in_count": 1,
  "shared_out_count": 2,
  "last_used_at": "2026-11-20T04:00:00Z"
}
```

| 字段 | 说明 |
|---|---|
| `credential_count` | 拥有的凭据数 |
| `shared_in_count` | 别人共享给他的凭据数 |
| `shared_out_count` | 他拥有的、至少共享给了一个人的凭据数 |
| `last_used_at` | 拥有的凭据里最近一次使用的时间，从没用过为 `null` |

管理员接口返回的用户额外带 `note`（管理员备注，默认空字符串）。

### UserBrief

`{"id": 1, "username": "alice"}`，用于凭据的主人、共享对象和操作日志。

### Credential

```json
{
  "id": "q3Jt7c2pYgS2b6l1vV2kQw",
  "rp_id": "github.com",
  "rp_name": "GitHub",
  "user_handle": "MTIzNDU2",
  "user_name": "alice@example.com",
  "user_display_name": "Alice",
  "alg": -7,
  "private_key": "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...",
  "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
  "sign_count": 0,
  "label": "",
  "fields": [
    {"id": "Xk3pQ9aB", "label": "恢复码", "type": "password", "value": "abcd-efgh"}
  ],
  "origin": "https://github.com",
  "created_at": "2026-11-20T03:30:00Z",
  "last_used_at": null,
  "use_count": 0,
  "owner": {"id": 1, "username": "alice"},
  "access": "owner",
  "shared_at": null,
  "shared_with": [
    {"user": {"id": 2, "username": "bob"}, "shared_at": "2026-11-21T08:00:00Z",
     "shared_by": {"id": 1, "username": "alice"}, "last_used_at": null}
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 凭据 ID（base64url），全站唯一 |
| `rp_id` | 依赖方 ID，即注册时生效的 rpId（如 `github.com`） |
| `rp_name` | 网站名称：注册时网站给的 `rp.name`，可为空字符串。主人和管理员可以修改 |
| `user_handle` | 注册时网站给的 `user.id`（base64url），登录时原样返回给网站 |
| `user_name` / `user_display_name` | 用户名 / 显示名：注册时网站给的 `user.name` / `user.displayName`。主人和管理员可以修改；这三个名称只用于展示，不参与签名 |
| `alg` | COSE 算法：`-7`（ES256）或 `-257`（RS256） |
| `private_key` | PKCS#8 DER 私钥（base64url），明文保存。**只在 HTTP Basic 认证下的 `GET /credentials`、`GET /credentials/{id}`、`POST /credentials`、`PATCH /credentials/{id}` 里出现**，其他情况省略这个字段 |
| `public_key` | SPKI DER 公钥（base64url） |
| `sign_count` | 签名计数，扩展固定写 0 |
| `label` | 主人的备注，默认空字符串 |
| `fields` | 自定义字段（[Field](#field)）的数组，按主人排列的顺序，没有时为 `[]`。凭据出现的地方都带它，被共享人、管理员和 API 令牌看到的值也不做隐藏 |
| `origin` | 注册时页面的 origin，仅供展示 |
| `use_count` / `last_used_at` | 使用统计（所有能用它的人合计），由 `POST .../use` 更新 |
| `owner` | 主人 |
| `access` | `"owner"` 或 `"shared"`：相对于这份列表所属的用户（`/credentials` 是调用者，`/admin/users/{user_id}/credentials` 是该用户）。`/admin/credentials` 和批量结果里没有这个字段 |
| `shared_at` | `access` 为 `"shared"` 时是共享给该用户的时间，否则为 `null`；没有 `access` 时省略 |
| `shared_with` | 共享给了谁，按时间升序。主人和管理员能看到，被共享人看不到（省略字段）。`shared_by` 是执行共享的人，已删除时为 `null`；`last_used_at` 是该用户最近一次使用 |

### Field

凭据的一个自定义字段：

```json
{"id": "Xk3pQ9aB", "label": "恢复码", "type": "password", "value": "abcd-efgh"}
```

| 字段 | 说明 |
|---|---|
| `id` | 服务端分配：6 个随机字节的 base64url，8 个字符。修改时带回已有字段的 `id` 以保持它的身份；没带、格式不对（不匹配 `^[A-Za-z0-9_-]{1,32}$`）或在同一个请求里重复的，一律当作新字段分配新 `id`，不报错 |
| `label` | 去掉首尾空白后 0–100 个字符，可以为空（界面显示类型名） |
| `type` | `text`、`password`、`url`、`email`、`phone`、`date`、`multiline`、`totp` 之一 |
| `value` | 0–10000 个字符。`date` 为空或 `YYYY-MM-DD` 格式的合法日期，`totp` 见下，其他类型不检查格式。`url`、`email`、`phone` 不能含控制字符和 Unicode 双向格式字符（U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069），避免链接显示的文字和实际打开的地址不一致。`date` 和 `totp` 的值去掉首尾空白后保存，其他类型原样保存 |

每个凭据最多 50 个字段。

`totp` 的值是下面两种之一（去掉首尾空白后）：

1. **base32 密钥**，例如 `JBSWY3DPEHPK3PXP`：删掉其中的 ASCII 空白（空格、`\t`、`\n`、`\r`、`\f`、`\v`）和 `-`，不区分大小写（只认 ASCII 字母；其他空白字符，例如 U+0085、U+00A0、U+FEFF，都算非法字符）；只能在末尾带 `=`（数量不限），其他位置出现 `=` 不合法；剩下的只能是 `A–Z` 和 `2–7`，长度除以 8 的余数不能是 1、3 或 6；至少解出 1 个字节。
2. **otpauth 链接**：`otpauth://totp/<label>?secret=<base32>[&issuer=…][&algorithm=SHA1|SHA256|SHA512][&digits=6|7|8][&period=1..300]`。`secret` 必填，按上面的规则校验；`algorithm` 默认 `SHA1`，`digits` 默认 6，`period` 默认 30（秒）。scheme、`totp`、参数名和 `algorithm` 的值不区分大小写；可选参数为空值时视为没有；同一参数出现多次时取第一次；其他参数忽略。

服务端只校验和保存，不计算验证码。Web 后台和扩展按 RFC 6238 计算：`T = floor(Unix 秒 / period)`，用 HMAC-`algorithm` 和 RFC 4226 的动态截断取 `digits` 位，左侧补 0。

### CredentialBrief

`{"id": "…", "rp_id": "github.com", "user_name": "alice@example.com", "owner": {"id": 1, "username": "alice"}}`，用于批量结果，不带 `fields`。

### Token

```json
{"id": 3, "name": "claude", "prefix": "pkb_AbCdEfGh", "read_only": false,
 "created_at": "2026-11-22T10:00:00Z", "expires_at": null, "last_used_at": null}
```

`prefix` 是令牌明文的前 12 个字符，用来辨认。`last_used_at` 最多每分钟更新一次。

### AuditEvent

```json
{"id": 42, "at": "2026-11-22T10:00:00Z",
 "actor": {"id": 1, "username": "admin"}, "via": "token:claude",
 "action": "credential.transfer",
 "subject": {"id": 2, "username": "alice"}, "target": {"id": 3, "username": "bob"},
 "credential": {"id": "q3Jt7c2pYgS2b6l1vV2kQw", "rp_id": "github.com", "user_name": "alice@example.com"},
 "detail": {"keep_access": false}}
```

| 字段 | 说明 |
|---|---|
| `actor` | 执行人；服务端自己做的操作（例如启动时创建管理员）为 `null` |
| `via` | `session`、`basic`、`token:<令牌名>` 或 `system` |
| `subject` | 受影响的用户：凭据操作是操作前的主人，用户管理操作是被管理的用户 |
| `target` | 另一方：共享对象、转移的新主人、交接对象；没有为 `null` |
| `credential` | 涉及的凭据，没有为 `null` |
| `detail` | 附加信息，没有内容时为 `{}` |

用户和凭据删除后，事件里记录的 ID 和名字保留不变。

| action | subject | target | detail |
|---|---|---|---|
| `user.create` | 新用户 | — | `{"is_admin": bool}` |
| `user.update` | 被修改的用户 | — | `{"changes": {...}}`：只列实际变化的项，`username`、`is_admin`、`disabled`、`note` 为 `{"from", "to"}`，`password` 为 `true` |
| `user.delete` | 被删除的用户 | 交接对象或 `null` | `{"credentials_deleted": n, "credentials_transferred": n}` |
| `user.revoke_sessions` | 用户 | — | `{"sessions": n, "tokens": n}` |
| `credential.create` | 主人 | — | `{}` |
| `credential.update` | 主人 | — | 只列实际变化的项：`label`、`rp_name`、`user_name`、`user_display_name` 为 `{"from", "to"}`；`fields` 为 `{"added": [label…], "removed": [label…], "changed": [label…]}` |
| `credential.delete` | 主人 | — | `{}` |
| `credential.share` | 主人 | 被共享人 | `{}` |
| `credential.unshare` | 主人 | 被共享人 | `{}` |
| `credential.leave` | 主人 | 被共享人（即执行人） | `{}` |
| `credential.transfer` | 原主人 | 新主人 | `{"keep_access": bool}` |
| `token.create` / `token.revoke` | 令牌主人 | — | `{"name": "…", "read_only": bool}` |

`credential.update` 的 `fields` 按 `id` 比较新旧字段：新出现的算 added，不见了的算 removed，`id` 相同但 `label`、`type` 或 `value` 变了的算 changed（记新的 label）。**只记 label，不记字段的值**；只调整了顺序时三个数组都为空。事件的 `credential.user_name` 是修改前的用户名。

登录、`/use` 和读操作不记录。

## 共享与转移

- 每条凭据有唯一的**主人**。主人可以把凭据**共享**给本站其他用户：被共享人在 `GET /credentials` 里能看到它（包括自定义字段的值），扩展可以用它登录网站，被共享人也可以自己退出共享；但只有主人能改备注、名称和自定义字段，删除、再共享或转移。
- **共享就是把私钥交给对方的扩展**。撤销共享只能阻止对方以后再拉取，不能保证对方没有留存。
- **转移**把凭据换给另一个主人，立即生效，不需要对方确认。原主人默认失去访问；`keep_access: true` 时原主人变为被共享人。其他人的共享保留；新主人原本是被共享人时，那条共享删除。新主人已经有同一网站同一账号（`rp_id` 大小写不敏感、`user_handle` 相同）的凭据时，结果带警告，两条凭据并存。
- 主人重新注册同一网站的同一账号时，旧凭据连同它的共享一起被替换：新的私钥在主人再次共享之前不会给任何人。备注、自定义字段和改过的名称保留（见 `POST /api/v1/credentials`）。
- 管理员通过 `/api/v1/admin/*` 可以对任何人的任何凭据做以上所有操作。

## 公共接口

### `GET /healthz`

无需认证。返回 `{"status": "ok", "version": "<构建版本>"}`。

### `GET /skill.md`

无需认证。返回面向 Agent 的使用说明（`Content-Type: text/markdown; charset=utf-8`），带 YAML frontmatter，可以直接保存为 Claude Code 等工具的 `SKILL.md`。文中的服务器地址按请求的 Host 头和 `X-Forwarded-Proto`（或 TLS）渲染。

### `GET /api/v1/info`

无需认证。

```json
{"version": "0.6.0", "allow_register": false, "extension_download": true, "skill_url": "/skill.md"}
```

`extension_download` 表示 `GET /downloads/passkey-box-extension.zip` 是否可用（见下文）。

### `GET /downloads/passkey-box-extension.zip`

无需认证。返回环境变量 `PKB_EXTENSION_ZIP` 指向的扩展安装包（`Content-Type: application/zip`，带 `Content-Disposition: attachment`）。未配置或文件不存在时返回 404。

## 账户

### `POST /api/v1/auth/login`

请求 `{"username": "alice", "password": "secret"}`。成功返回 200 `{"user": User}` 并设置 `pkb_session` Cookie；用户名或密码错误返回 401；密码正确但账户已停用返回 403 `account_disabled`。

### `POST /api/v1/auth/logout`

删除当前会话并清除 Cookie，返回 204。未登录时也返回 204。

### `POST /api/v1/auth/register`

请求同登录。`PKB_ALLOW_REGISTER=true` 时创建普通用户，返回 201 `{"user": User}` 并设置会话 Cookie；用户名已存在，或者是 `PKB_ADMIN_USERNAME` 指定的管理员用户名，返回 409；未开启返回 403 `registration_disabled`。

### `GET /api/v1/me`

返回 200：

```json
{"user": User, "auth": {"method": "token", "read_only": false, "token": Token}}
```

`auth.method` 是 `basic`、`session` 或 `token`；`auth.token` 只在令牌认证时有值，否则为 `null`。扩展用这个接口校验服务器地址、用户名和密码；Agent 可以用它确认令牌的权限。

### `PUT /api/v1/me/password`

请求 `{"old_password": "...", "new_password": "..."}`，成功返回 204。旧密码错误返回 400 `invalid_password`。修改后已有会话保持有效。不接受 API 令牌（403 `token_not_allowed`）。

### API 令牌

以下三个接口不接受 API 令牌（403 `token_not_allowed`），需要用密码或会话调用。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/me/tokens` | — | 200 `{"tokens": [Token]}`，新的在前 |
| `POST /api/v1/me/tokens` | `{"name": "claude", "read_only": false, "expires_in_days": 90}` | 201 `{"token": Token, "secret": "pkb_…"}`。`name` 去掉首尾空白后 1–64 个字符；`expires_in_days` 省略表示永不过期，否则为 1–3650；每个用户最多 50 个令牌 |
| `DELETE /api/v1/me/tokens/{token_id}` | — | 204；不存在或不是自己的返回 404 |

### `GET /api/v1/me/activity`

与我有关（我是执行人、受影响的用户或另一方）的操作日志。调用者不是管理员时，`user.update` 事件里管理员备注的内容替换为 `"note": true`，只说明备注改过。200 `{"events": [AuditEvent], "next_before": 41}`，新的在前。查询参数 `limit`（默认 50，范围 1–200，越界返回 400）、`before`（只返回 ID 小于它的事件，用上一页的 `next_before` 翻页；没有更多时 `next_before` 为 `null`）。

### `GET /api/v1/users`

用户名录，用于选择共享对象：200 `{"users": [UserBrief]}`，包含所有未停用的用户，按用户名排序。

## 凭据（当前用户）

### `GET /api/v1/credentials`

返回当前用户拥有的和共享给他的凭据 `{"credentials": [Credential]}`，按 `created_at` 倒序。

- `rp_id`：只返回 `rp_id` 完全相等（大小写不敏感）的凭据。扩展处理登录请求时用它。
- `access`：`all`（默认）、`owned`（只看拥有的）、`shared`（只看共享给我的）。

### `POST /api/v1/credentials`

扩展在网站创建通行密钥后调用。请求体是 Credential 去掉统计字段、共享字段和 `fields`（请求里的 `fields` 被忽略）：

```json
{
  "id": "...", "rp_id": "github.com", "rp_name": "GitHub",
  "user_handle": "...", "user_name": "alice@example.com", "user_display_name": "Alice",
  "alg": -7, "private_key": "...", "public_key": "...", "origin": "https://github.com",
  "label": ""
}
```

- 必填：`id`、`rp_id`、`user_handle`、`private_key`、`alg`；`alg` 只接受 `-7` 和 `-257`。其余字段缺省为空字符串。`label` 最多 1000 个字符。
- `origin` 非空时必须是 `http://` 或 `https://` 开头的 URL，否则返回 400。
- **同一网站同一账号覆盖旧凭据**：如果当前用户已拥有 `rp_id`（大小写不敏感）和 `user_handle` 都相同的凭据，先删除它们（连同它们的共享）再插入新凭据。这与真实认证器的行为一致，网站重新注册同一个账号时不会留下重复项。别人共享给你的同账号凭据不受影响。
- **保留主人做的修改**（共享不保留）：
  - 所有被覆盖凭据的 `fields` 都留到新凭据上，按最新的凭据在前排列（转移可能让一个账号有几条凭据，它们的字段都不会丢；别人转移给你的同账号凭据上的字段也会合并进来）；
  - 被覆盖的凭据里最新创建的那一条（`created_at` 最大，相同时取最后插入的）的 `label`，除非请求带了非空的 `label`（扩展注册时总是发空字符串）；
  - 用 `PATCH` 改过的名称（`rp_name`、`user_name`、`user_display_name` 中改过的那几个）不取请求里的新值，以后再注册也继续保留；没改过的名称取请求里的值。
- `id` 已经存在（任何用户的，且不属于上面被覆盖的那批）返回 409。
- 成功返回 201 `{"credential": Credential}`。

### `GET /api/v1/credentials/{id}`

返回 200 `{"credential": Credential}`；不是自己拥有、也没有共享给自己的返回 404。

### `PATCH /api/v1/credentials/{id}`

修改备注、名称和自定义字段，只有主人能改。请求体的成员都可选，但至少要带一个：

```json
{"label": "工作号", "rp_name": "GitHub（公司）", "user_name": "alice@corp.com", "user_display_name": "Alice",
 "fields": [{"id": "Xk3pQ9aB", "label": "恢复码", "type": "password", "value": "abcd-efgh"},
            {"label": "两步验证", "type": "totp", "value": "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"}]}
```

- `label`：备注，原样保存，最多 1000 个字符。
- `rp_name`、`user_name`、`user_display_name`：去掉首尾空白后最多 1000 个字符，可以为空字符串（`rp_name` 为空时界面标题显示 `rp_id`）。凭据 ID、`rp_id`、`user_handle`、密钥和 `alg` 不能修改。实际改变了的名称会被记住，重新注册时保留（见 `POST /credentials`）。
- `fields`：**整体替换**字段列表，按数组顺序保存，规则见 [Field](#field)。已有字段要带回它的 `id`，否则会被当作删掉旧字段、新加一个字段；`[]` 删除全部字段。
- 只写实际变化的项；有变化时记一条 `credential.update` 操作日志，没有变化时不记。
- 返回 200 `{"credential": Credential}`。一个成员都没带返回 400 `invalid_request`（`nothing to update`）；值不合法返回 400 `invalid_request`，`message` 说明原因，字段的错误带下标（从 0 开始），例如 `fields[3]: invalid TOTP secret`、`fields[50]: at most 50 fields are allowed`、`user_name must be at most 1000 characters`。校验在查找凭据之前进行。被共享人返回 403 `forbidden`；无权访问返回 404。

0.6.0 及更早的扩展只发 `{"label": "…"}`，行为不变。

### `POST /api/v1/credentials/{id}/use`

扩展每次用该凭据签名成功后调用：`use_count` 加 1，`last_used_at` 设为当前时间；调用者是被共享人时，同时更新那条共享的 `last_used_at`。返回 204；无权访问返回 404。

### `DELETE /api/v1/credentials/{id}`

主人调用时删除凭据（它的共享一并删除）；被共享人调用时退出共享，凭据仍归主人。都返回 204；无权访问返回 404。

### `POST /api/v1/credentials/share`

把自己拥有的凭据共享给其他用户。

```json
{"ids": ["q3Jt7c2pYgS2b6l1vV2kQw"], "users": ["bob", 3], "dry_run": false}
```

返回 200，每个（凭据, 用户）一条结果：

```json
{"dry_run": false, "results": [
  {"credential": CredentialBrief, "user": {"id": 2, "username": "bob"}, "status": "shared", "warnings": []}
]}
```

`status` 为 `shared`（新共享）或 `unchanged`（原本就共享了）。条目错误：凭据无权访问 `not_found`；凭据是别人共享给我的 `forbidden`；用户不存在 `not_found`；用户就是主人 `invalid_request`。共享给停用的用户会成功，结果带警告 `user is disabled`。

### `POST /api/v1/credentials/unshare`

撤销共享。请求 `{"ids": [...], "users": [...]}`，或 `{"ids": [...], "all": true}` 撤销这些凭据的全部共享，两者必须恰好给一个。结果形状同上，`status` 为 `unshared` 或 `unchanged`（原本没有共享）；`all: true` 时每条现有共享一条结果。

### `POST /api/v1/credentials/transfer`

把自己拥有的凭据转给另一个用户。

```json
{"ids": ["q3Jt7c2pYgS2b6l1vV2kQw"], "to": "bob", "keep_access": false, "dry_run": true}
```

```json
{"dry_run": true, "results": [
  {"credential": CredentialBrief, "from": {"id": 1, "username": "alice"}, "to": {"id": 2, "username": "bob"},
   "status": "transferred", "keep_access": false, "warnings": ["bob already has a passkey for this account"]}
]}
```

`status` 为 `transferred`，或 `unchanged`（`to` 已经是主人）。警告：`to` 已停用（`user is disabled`）；`to` 已经拥有同一网站同一账号的凭据。

### `POST /api/v1/credentials/leave`

退出别人共享给我的凭据：请求 `{"ids": [...], "dry_run": false}`，结果 `{"credential": CredentialBrief, "status": "left", "warnings": []}`。不是共享给我的凭据报条目错误 `not_found`。

### `POST /api/v1/credentials/batch-delete`

请求 `{"ids": [...], "dry_run": false}`。拥有的删除，共享给我的退出共享（与 `DELETE /credentials/{id}` 相同）。结果 `{"credential": CredentialBrief, "status": "deleted" | "left", "warnings": []}`。

## 管理员接口

以下接口要求当前用户 `is_admin=true`，否则返回 403 `forbidden`。管理员接口返回的凭据都不含 `private_key`。用户不存在时返回 404。

### 概览与操作日志

| 方法与路径 | 说明 |
|---|---|
| `GET /api/v1/admin/overview` | 200 `{"users": {"total", "admins", "disabled"}, "credentials": {"total", "shared", "shares", "sites"}, "sites": [{"rp_id", "credentials", "owners"}], "recent_events": [AuditEvent]}`。`credentials.shared` 是有共享的凭据数，`shares` 是共享关系总数，`sites` 是不同网站数；`sites` 列表按凭据数取前 20；`recent_events` 是最近 10 条操作日志 |
| `GET /api/v1/admin/audit` | 全站操作日志：200 `{"events": [AuditEvent], "next_before": id}`，新的在前。参数：`user_id`（执行人、受影响的用户或另一方之一是他）、`actor_id`、`action`（精确匹配；以 `.` 结尾时按前缀，例如 `credential.`）、`credential_id`、`before`、`limit`（默认 50，最大 200） |

### 用户

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/admin/users` | 参数 `q`（用户名或备注里的子串，大小写不敏感）、`role`（`admin` / `user`）、`status`（`active` / `disabled`） | 200 `{"users": [User]}`，按 `id` 升序 |
| `POST /api/v1/admin/users` | `{"username", "password", "is_admin"?, "note"?}` | 201 `{"user": User}`；重名 409 |
| `GET /api/v1/admin/users/{user_id}` | — | 200 `{"user": User}` |
| `PATCH /api/v1/admin/users/{user_id}` | `{"username"?, "password"?, "is_admin"?, "disabled"?, "note"?}` | 200 `{"user": User}`。不能取消自己的管理员身份、不能停用自己、不能用 API 令牌修改自己的密码（400）；改名重名 409。改名后该用户要在扩展里用新用户名重新登录 |
| `DELETE /api/v1/admin/users/{user_id}` | — | 204，同时删除该用户拥有的凭据、共享给他的关系、会话和令牌；不能删除自己（400） |
| `POST /api/v1/admin/users/{user_id}/revoke-sessions` | — | 200 `{"sessions": n, "tokens": n}`：删除该用户的全部会话和 API 令牌。密码不变，扩展的 Basic 认证不受影响；要彻底阻止访问请停用账户或重置密码 |
| `GET /api/v1/admin/users/{user_id}/credentials` | 参数 `access` 同 `GET /credentials` | 200 `{"credentials": [Credential]}`：该用户拥有的和共享给他的，`access` 相对于该用户 |
| `DELETE /api/v1/admin/users/{user_id}/credentials/{id}` | — | 204：该用户拥有的凭据被删除；共享给该用户的凭据只撤销这条共享；都不是返回 404 |

批量：

**`POST /api/v1/admin/users/batch-create`**

```json
{"users": [{"username": "u01"}, {"username": "u02", "password": "secret", "is_admin": false, "note": "测试组"}], "dry_run": false}
```

返回 200 `{"dry_run": false, "results": [{"user": User, "password": "Xy3…"}]}`。省略 `password` 时服务端生成 16 位字母数字随机密码，只在这次响应里出现；dry run 不返回密码，`user.id` 是临时值。用户名已存在或批内重名报条目错误 `conflict`。

**`POST /api/v1/admin/users/batch-update`**

```json
{"items": [{"user": "u01", "disabled": true}, {"user": 5, "username": "carol", "note": "改名"}, {"user": "u02", "generate_password": true}], "dry_run": false}
```

每个条目可以带 `username`、`password`、`generate_password`（与 `password` 互斥）、`is_admin`、`disabled`、`note`。返回 200 `{"dry_run": false, "results": [{"user": User, "changes": ["disabled"], "password": "…"}]}`：`changes` 是实际变化的字段，`password` 只在 `generate_password` 时出现。同一用户在批内出现两次、取消自己的管理员身份、停用自己，或者用 API 令牌修改自己的密码，报条目错误 `invalid_request`。

**`POST /api/v1/admin/users/batch-delete`**

```json
{"users": ["u01", "u02"], "transfer_credentials_to": "carol", "dry_run": true}
```

返回 200 `{"dry_run": true, "results": [{"user": UserBrief, "credentials_deleted": 0, "credentials_transferred": 3}]}`。给了 `transfer_credentials_to` 时，先把这些用户拥有的全部凭据转给交接对象（这些凭据上的其他共享保留，交接对象原本对它们的共享删除），再删除用户；否则这些凭据随用户一起删除。交接对象不能在删除列表里，也不能是停用的用户；不能删除自己。

### 凭据

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/admin/credentials` | 参数见下 | 200 `{"credentials": [Credential], "total": 120, "limit": 100, "offset": 0}`，按 `created_at` 倒序 |
| `GET /api/v1/admin/credentials/{id}` | — | 200 `{"credential": Credential}` |
| `PATCH /api/v1/admin/credentials/{id}` | 同 `PATCH /credentials/{id}`：`{"label"?, "rp_name"?, "user_name"?, "user_display_name"?, "fields"?}` | 200 `{"credential": Credential}`，任何人的凭据 |
| `DELETE /api/v1/admin/credentials/{id}` | — | 204 |
| `POST /api/v1/admin/credentials/share` | 同 `POST /credentials/share` | 任何人的凭据 |
| `POST /api/v1/admin/credentials/unshare` | 同 `POST /credentials/unshare` | 任何人的凭据 |
| `POST /api/v1/admin/credentials/transfer` | 同 `POST /credentials/transfer` | 任何人的凭据 |
| `POST /api/v1/admin/credentials/batch-delete` | `{"ids": [...], "dry_run": false}` | 结果 `status` 一律为 `deleted` |

`GET /api/v1/admin/credentials` 的查询参数：

| 参数 | 说明 |
|---|---|
| `owner` / `owner_id` | 主人的用户名 / ID |
| `shared_with` / `shared_with_id` | 共享给了这个用户（用户名 / ID） |
| `rp_id` | 网站，大小写不敏感精确匹配 |
| `q` | 在 `rp_id`、`rp_name`、`user_name`、`user_display_name`、`label`、自定义字段的 `label`（不含字段的值）和主人用户名里做大小写不敏感的子串匹配 |
| `shared` | `true` 只看有共享的，`false` 只看没有共享的 |
| `limit` / `offset` | 分页，`limit` 默认 100、范围 1–500，`offset` 默认 0 |

引用的用户不存在时返回空列表。参数越界或格式不对（`limit` 超出范围、ID 不是数字、`shared` 不是 `true`/`false`）返回 400。

## 服务端配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PKB_LISTEN` | `:8080` | 监听地址 |
| `PKB_DB` | `./data/passkey-box.db` | SQLite 文件路径，所在目录不存在时自动创建 |
| `PKB_ADMIN_USERNAME` / `PKB_ADMIN_PASSWORD` | 空 | 两者都设置时，启动时确保该用户存在且是管理员；用户不存在则用该密码创建，已存在则只把它设为管理员，不改密码。这个用户名不能被改掉，其他用户也不能改名或注册成它 |
| `PKB_ALLOW_REGISTER` | `false` | 是否允许在 Web 后台自助注册 |
| `PKB_COOKIE_SECURE` | `false` | 会话 Cookie 是否加 Secure（HTTPS 部署时设为 `true`） |
| `PKB_EXTENSION_ZIP` | 空 | 扩展安装包路径，供 Web 后台下载 |

## 数据库升级

数据库结构的版本记在 SQLite 的 `PRAGMA user_version` 里：

| 版本 | 程序 | 变化 |
|---|---|---|
| 0 | 0.5.0 及更早 | 用户、会话、凭据 |
| 1 | 0.6.0 | 共享、API 令牌、操作日志三张表，用户的停用和备注两列，凭据 ID 全站唯一 |
| 2 | 0.7.0 | 凭据加 `fields`（自定义字段的 JSON 数组，默认 `'[]'`）和 `edited`（改过的名称，默认 `''`）两列 |

启动时如果数据库版本低于程序版本，服务端会先用 `VACUUM INTO` 在数据库旁边留一份完整副本（例如 `passkey-box.pre-v2-20261123T010203Z.db`，`pre-v2` 表示升级到版本 2 之前，副本里的版本号还是升级前的；权限与数据库文件相同；日志里会打印路径），再在一个事务里一次升级到程序的版本（版本 0 的数据库直接升到 2）。升级只增加表、列和索引，不改写已有数据；失败时整体回滚，服务拒绝启动，数据库保持原样。旧版本的程序可以继续打开升级后的数据库（它们按列名读写，新列有默认值），回滚部署不需要恢复数据。回滚时注意：

- 旧版本不认识「停用」，回滚后被停用的用户又能登录，回滚前请先重置他们的密码。
- 回滚期间在旧版本里重新注册或删除通行密钥，会连带删掉它们的共享；再升级回来后这些共享不会恢复。
- 0.6.0 不显示自定义字段（改过的名称照常显示），也不会改动它们；但在 0.6.0 里重新注册的通行密钥不保留备注、自定义字段和改过的名称。

需要恢复到升级前的副本时：先停止服务，删除数据库旁边的 `-wal`、`-shm` 文件，再用副本覆盖数据库文件，最后启动旧版本。不删 `-wal` 就覆盖，SQLite 会把升级后写入的日志重放到副本上，得到一个损坏的数据库。

备份请用 SQLite 的 `.backup`、`VACUUM INTO` 或在服务停止时复制文件。用 `.dump` 恢复的数据库会丢失结构版本号，服务端会根据表结构自动认出它升级到了哪个版本（包括 0.6.0 打开过、把版本记成 1 的版本 2 数据库），不会重复升级；只有某个版本的一部分表或列时拒绝启动。

0.6.0 起凭据 ID 全站唯一。如果旧数据库里有两个用户存着相同 ID 的凭据，升级会在复制数据库之前失败，并在日志里给出这个 ID，需要先删掉其中一条再启动。
