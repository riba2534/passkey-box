# Passkey Box 服务端 HTTP API

服务端与 Chrome 扩展、Web 后台之间的接口约定。所有接口都在 `/api/v1` 下，请求和响应都是 JSON（`Content-Type: application/json; charset=utf-8`）。

## 约定

- **二进制字段**统一用 base64url（RFC 4648 §5，无 `=` 填充）：凭据 ID、`user_handle`、私钥、公钥。
- **时间**统一用 RFC 3339 UTC 字符串，例如 `2026-11-20T03:30:00Z`；没有值时为 `null`。
- **响应包装**：单个对象放在同名字段里（`{"user": {...}}`、`{"credential": {...}}`），列表放在复数字段里（`{"users": [...]}`、`{"credentials": [...]}`）。空列表返回 `[]`，不返回 `null`。
- **错误**：非 2xx 时返回

  ```json
  {"error": {"code": "not_found", "message": "credential not found"}}
  ```

  | HTTP | code | 场景 |
  |---|---|---|
  | 400 | `invalid_request` | JSON 解析失败、字段缺失或不合法 |
  | 400 | `invalid_password` | 修改密码时旧密码错误 |
  | 401 | `unauthorized` | 未登录、Basic 认证失败、会话过期 |
  | 403 | `forbidden` | 非管理员访问 `/api/v1/admin/*` |
  | 403 | `registration_disabled` | 未开启自助注册时调用注册接口 |
  | 404 | `not_found` | 资源不存在（包括访问别人的凭据） |
  | 409 | `conflict` | 用户名已存在、凭据 ID 已存在 |
  | 500 | `internal` | 其他错误 |

- **401 响应不带 `WWW-Authenticate` 头**，避免浏览器弹出原生 Basic 认证框。
- **CORS**：`/api/*` 对任意来源返回 `Access-Control-Allow-Origin: *`，允许 `Authorization, Content-Type` 头和 `GET, POST, PUT, PATCH, DELETE, OPTIONS` 方法；`OPTIONS` 预检直接返回 204。扩展在 service worker 里请求时并不依赖它，只是为了让其他客户端也能直接调用。

## 认证

两种方式任选其一，所有需要登录的接口都同时接受：

1. **HTTP Basic**：`Authorization: Basic base64(utf8(username + ":" + password))`。扩展每个请求都带这个头。
2. **会话 Cookie**：Web 后台通过 `POST /api/v1/auth/login` 登录后拿到 `pkb_session` Cookie（HttpOnly、SameSite=Lax、Path=/、有效期 30 天；`PKB_COOKIE_SECURE=true` 时加 Secure）。

用户名去掉首尾空白后为 1–64 个字符，大小写不敏感地唯一（`Alice` 和 `alice` 是同一个用户），保存时保留原始大小写。密码至少 1 个字符，服务端用 bcrypt 存储。

## 数据对象

### User

```json
{
  "id": 1,
  "username": "alice",
  "is_admin": false,
  "created_at": "2026-11-20T03:30:00Z",
  "credential_count": 3,
  "last_used_at": "2026-11-20T04:00:00Z"
}
```

`credential_count` 和 `last_used_at`（该用户所有凭据里最近一次使用的时间，从没用过为 `null`）是统计字段。

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
  "origin": "https://github.com",
  "created_at": "2026-11-20T03:30:00Z",
  "last_used_at": null,
  "use_count": 0
}
```

| 字段 | 说明 |
|---|---|
| `id` | 凭据 ID（base64url），同一用户下唯一 |
| `rp_id` | 依赖方 ID，即注册时生效的 rpId（如 `github.com`） |
| `rp_name` | 注册时网站给的 `rp.name`，可为空字符串 |
| `user_handle` | 注册时网站给的 `user.id`（base64url），登录时原样返回给网站 |
| `user_name` / `user_display_name` | 注册时网站给的 `user.name` / `user.displayName` |
| `alg` | COSE 算法：`-7`（ES256）或 `-257`（RS256） |
| `private_key` | PKCS#8 DER 私钥（base64url），明文保存 |
| `public_key` | SPKI DER 公钥（base64url） |
| `sign_count` | 签名计数，扩展固定写 0 |
| `label` | 用户备注，默认空字符串 |
| `origin` | 注册时页面的 origin，仅供展示 |
| `use_count` / `last_used_at` | 使用统计，由 `POST .../use` 更新 |

## 公共接口

### `GET /healthz`

无需认证。返回 `{"status": "ok", "version": "<构建版本>"}`。

### `GET /api/v1/info`

无需认证。

```json
{"version": "0.1.0", "allow_register": false, "extension_download": true}
```

`extension_download` 表示 `GET /downloads/passkey-box-extension.zip` 是否可用（见下文）。

### `GET /downloads/passkey-box-extension.zip`

无需认证。返回环境变量 `PKB_EXTENSION_ZIP` 指向的扩展安装包（`Content-Type: application/zip`，带 `Content-Disposition: attachment`）。未配置或文件不存在时返回 404。

## 账户

### `POST /api/v1/auth/login`

请求 `{"username": "alice", "password": "secret"}`。成功返回 200 `{"user": User}` 并设置 `pkb_session` Cookie；用户名或密码错误返回 401。

### `POST /api/v1/auth/logout`

删除当前会话并清除 Cookie，返回 204。未登录时也返回 204。

### `POST /api/v1/auth/register`

请求同登录。`PKB_ALLOW_REGISTER=true` 时创建普通用户，返回 201 `{"user": User}` 并设置会话 Cookie；用户名已存在返回 409；未开启返回 403 `registration_disabled`。

### `GET /api/v1/me`

返回 200 `{"user": User}`。扩展用它校验服务器地址、用户名和密码。

### `PUT /api/v1/me/password`

请求 `{"old_password": "...", "new_password": "..."}`，成功返回 204。旧密码错误返回 400 `invalid_password`。修改后已有会话保持有效。

## 凭据（当前用户）

### `GET /api/v1/credentials`

返回当前用户的凭据 `{"credentials": [Credential]}`，按 `created_at` 倒序。

可选查询参数 `rp_id`：只返回 `rp_id` 完全相等（大小写不敏感）的凭据。扩展处理登录请求时用它。

### `POST /api/v1/credentials`

扩展在网站创建通行密钥后调用。请求体是 Credential 去掉统计字段：

```json
{
  "id": "...", "rp_id": "github.com", "rp_name": "GitHub",
  "user_handle": "...", "user_name": "alice@example.com", "user_display_name": "Alice",
  "alg": -7, "private_key": "...", "public_key": "...", "origin": "https://github.com",
  "label": ""
}
```

- 必填：`id`、`rp_id`、`user_handle`、`private_key`、`alg`；`alg` 只接受 `-7` 和 `-257`。其余字段缺省为空字符串。
- **同一网站同一账号覆盖旧凭据**：如果当前用户已有 `rp_id`（大小写不敏感）和 `user_handle` 都相同的凭据，先删除它们再插入新凭据。这与真实认证器的行为一致，网站重新注册同一个账号时不会留下重复项。
- 同一用户下 `id` 已存在（且不属于上面被覆盖的那批）返回 409。
- 成功返回 201 `{"credential": Credential}`。

### `PATCH /api/v1/credentials/{id}`

请求 `{"label": "工作号"}`，目前只允许修改 `label`。返回 200 `{"credential": Credential}`；不存在返回 404。

### `POST /api/v1/credentials/{id}/use`

扩展每次用该凭据签名成功后调用：`use_count` 加 1，`last_used_at` 设为当前时间。返回 204；不存在返回 404。

### `DELETE /api/v1/credentials/{id}`

返回 204；不存在返回 404。

## 管理员接口

以下接口要求当前用户 `is_admin=true`，否则返回 403 `forbidden`。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/v1/admin/users` | — | 200 `{"users": [User]}`，按 `id` 升序 |
| `POST /api/v1/admin/users` | `{"username", "password", "is_admin"?}` | 201 `{"user": User}`；重名 409 |
| `PATCH /api/v1/admin/users/{user_id}` | `{"password"?, "is_admin"?}` | 200 `{"user": User}`；不能取消自己的管理员身份（400） |
| `DELETE /api/v1/admin/users/{user_id}` | — | 204，同时删除该用户的凭据和会话；不能删除自己（400） |
| `GET /api/v1/admin/users/{user_id}/credentials` | — | 200 `{"credentials": [Credential]}` |
| `DELETE /api/v1/admin/users/{user_id}/credentials/{id}` | — | 204 |

用户不存在时返回 404。

## 服务端配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PKB_LISTEN` | `:8080` | 监听地址 |
| `PKB_DB` | `./data/passkey-box.db` | SQLite 文件路径，所在目录不存在时自动创建 |
| `PKB_ADMIN_USERNAME` / `PKB_ADMIN_PASSWORD` | 空 | 两者都设置时，启动时确保该用户存在且是管理员；用户不存在则用该密码创建，已存在则只把它设为管理员，不改密码 |
| `PKB_ALLOW_REGISTER` | `false` | 是否允许在 Web 后台自助注册 |
| `PKB_COOKIE_SECURE` | `false` | 会话 Cookie 是否加 Secure（HTTPS 部署时设为 `true`） |
| `PKB_EXTENSION_ZIP` | 空 | 扩展安装包路径，供 Web 后台下载 |
