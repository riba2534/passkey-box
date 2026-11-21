<p align="center">
  <img src="docs/images/logo.png" alt="Passkey Box Logo" width="128" />
</p>

<h1 align="center">Passkey Box</h1>

<p align="center">
  <strong>自托管的通行密钥（Passkey）管理器</strong>
  <br />
  Chrome 扩展接管网站的通行密钥注册与登录，密钥统一存放在你自己的服务器上。
  <br />
  自动匹配账号，直接完成网站登录。
</p>

<p align="center">
  <a href="https://github.com/riba2534/passkey-box/releases/latest"><img src="https://img.shields.io/github/v/release/riba2534/passkey-box?style=for-the-badge&color=0572EC&label=Release" alt="Release" /></a>
  <a href="https://github.com/riba2534/passkey-box/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/riba2534/passkey-box/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI" /></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.26-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go 1.26" /></a>
  <a href="https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3"><img src="https://img.shields.io/badge/Chrome-MV3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome MV3" /></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/riba2534/passkey-box/stargazers"><img src="https://img.shields.io/github/stars/riba2534/passkey-box?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-0F766E?style=for-the-badge" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#passkey-box-是什么">介绍</a> ·
  <a href="#功能总览">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用说明">使用说明</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#配置">配置</a> ·
  <a href="#开发与测试">开发</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="docs/images/showcase.jpg" alt="Passkey Box：在 webauthn.io 上弹出的账号选择框，以及扩展弹出窗口" width="880" />
</p>

---

> [!WARNING]
> **请保护 Passkey Box 服务端和账号。** Passkey Box 的用户名和密码是唯一的保护：扩展登录后直接生成网站凭据和签名，不再做设备或生物识别验证。凭据私钥以明文保存在服务端，拿到账号密码或私钥的一方都可以替你登录网站。

## Passkey Box 是什么

Passkey Box 由两部分组成：

- **Chrome 扩展**处理顶层网页的 WebAuthn 请求，用服务器上的私钥生成网站凭据或签名。
- **服务端**使用 Go 和 SQLite，提供多用户凭据同步和 Web 管理后台。

同一台服务器可以同步多个网站和账号的通行密钥。

### 为什么选择 Passkey Box

- **自动匹配** — 只有一个通行密钥时直接签名，自动向网站提交。
- **多账号清楚可控** — 网站指定了账号（先输用户名再登录）时精确匹配；同一网站有多个账号时，在页面右上角弹出 1Password 风格的选择框。
- **密钥在自己手里** — 通行密钥保存在你部署的服务器上，多台电脑、多个浏览器共用同一份数据；签名计数固定为 0，多端同时使用也不会冲突。
- **多用户 Web 后台** — 每个用户只能看到自己的通行密钥；管理员可以创建用户、重置密码，并查看所有用户的通行密钥。
- **部署简单** — 服务端是一个静态编译的二进制，`FROM scratch` 镜像，一个 SQLite 文件就是全部数据。
- **随时回到系统方式** — 对话框里点「使用其他方式」，请求原样交还给浏览器原生实现。

## 功能总览

| 模块 | 能力 |
|---|---|
| **注册** | 生成并保存通行密钥。同一网站同一账号重复注册会覆盖旧的。命中 `excludeCredentials` 时返回 `InvalidStateError`。 |
| **登录** | 按 `allowCredentials` 匹配，多个候选可选账号。支持 conditional mediation。 |
| **认证器** | ES256（P-256）与 RS256；`none` 证明；BE/BS 备份标志置位；返回对象通过 `instanceof PublicKeyCredential`，实现 `toJSON()` 等 WebAuthn L3 方法 |
| **扩展界面** | 页面内选择框与提示条；弹出窗口按「当前网站 / 全部」列出通行密钥，可搜索、查看详情、删除；两个自动登录开关 |
| **Web 后台** | 我的通行密钥（按网站分组、搜索、备注、使用统计）、用户管理（管理员）、账户设置、插件下载与安装指引；适配手机宽度，可添加到手机主屏幕 |
| **服务端 API** | REST + JSON，Basic 认证或会话 Cookie，详见 [docs/API.md](docs/API.md) |

### 界面预览

<table>
  <tr>
    <td width="50%"><img src="docs/images/console-passkeys.png" alt="Web 后台：我的通行密钥" /></td>
    <td width="50%"><img src="docs/images/console-users.png" alt="Web 后台：用户管理" /></td>
  </tr>
  <tr>
    <td align="center"><sub>我的通行密钥：按网站分组，右侧查看详情、编辑备注</sub></td>
    <td align="center"><sub>用户管理：管理员查看每个用户的通行密钥</sub></td>
  </tr>
</table>

## 快速开始

### 1. 部署服务端

需要一台能被你的浏览器访问到的机器。三种方式任选其一。

**Docker**

```bash
git clone https://github.com/riba2534/passkey-box.git && cd passkey-box
docker build -t passkey-box --build-arg VERSION=0.1.0 server
docker run -d --name passkey-box --restart unless-stopped \
  -p 8080:8080 \
  -e PKB_ADMIN_USERNAME=admin \
  -e PKB_ADMIN_PASSWORD=change-me \
  -v passkey-box-data:/data \
  passkey-box
```

**直接运行二进制**（需要 Go 1.26+、Node.js 22+）

```bash
make run    # 构建服务端和扩展安装包，在 http://127.0.0.1:8080 启动，管理员 admin / admin
```

**部署到带 Caddy 的 Docker 主机**：`deploy/deploy.sh` 在本地编译、上传，在服务器上构建镜像并替换容器，健康检查失败自动回滚。

```bash
DEPLOY_HOST=ubuntu@your-host SSH_KEY=~/.ssh/id_ed25519 PUBLIC_URL=https://passkey.example.com ./deploy/deploy.sh
```

容器只监听 `127.0.0.1:18300`，由反向代理提供 HTTPS，Caddy 配置见 [deploy/Caddyfile.snippet](deploy/Caddyfile.snippet)。首次部署会在服务器上生成 `passkey-box.env`，里面是随机的管理员密码。

> [!TIP]
> 部署在公网时请走 HTTPS，并设置 `PKB_COOKIE_SECURE=true`。扩展用 HTTP Basic 认证访问服务端，局域网里用 HTTP 也能工作。

### 2. 创建用户

用管理员账号登录 Web 后台，在「用户管理」里点「新建用户」。每个用户的通行密钥彼此隔离。

### 3. 安装扩展

三种方式任选其一获取安装包：

- 从 [GitHub Releases](https://github.com/riba2534/passkey-box/releases/latest) 下载 `passkey-box-extension-<版本>.zip`，可用同名 `.sha256` 文件校验；
- 在 Web 后台的「安装插件」页下载（服务端设置了 `PKB_EXTENSION_ZIP` 时可用，登录表单里已预填服务器地址）；
- 自己构建：

```bash
make zip-extension PKB_DEFAULT_SERVER_URL=https://passkey.example.com
# 生成 dist/passkey-box-extension.zip，登录表单里预填服务器地址
```

解压后打开 `chrome://extensions`，开启右上角的「开发者模式」，点「加载已解压的扩展程序」，选择解压出来的目录。

### 4. 登录扩展

点击工具栏上的 Passkey Box 图标，填入服务器地址、用户名和密码。登录后即可使用，不需要其他设置。

从 v0.1.0 升级后，固定的扩展 ID 会创建一份新的本地扩展设置，请重新登录。服务器上的网站凭据可以继续使用。

## 使用说明

### 登录时用哪个账号

| 情况 | 行为 |
|---|---|
| 网站指定了凭据（先输用户名再登录，`allowCredentials` 非空） | 只在指定的凭据里匹配 |
| 只匹配到 1 个通行密钥 | 直接签名，自动提交给网站 |
| 匹配到多个通行密钥 | 选中账号后签名 |
| 一个也没有 | 提示未找到，可「使用其他方式」交给浏览器原生实现，或取消 |
| 页面打开时的自动填充式请求（conditional mediation） | 单个候选直接签名，多个候选先选账号。无候选或服务器不可用时保持静默。 |

### 注册

网站请求注册时，扩展直接生成密钥并保存到服务器。同一网站、同一账号（相同 `user.id`）再次注册会覆盖旧的。

### 扩展设置

弹出窗口的「设置」里有两个开关，默认都打开：

- **只有一个账号时跳过选择**。关闭后，单候选也先打开选择框。
- **响应页面的自动填充请求**。打开后，当前标签页的自动填充请求也能带出 Passkey Box 的账号选择或直接登录。

> [!NOTE]
> 嵌入式页面的 WebAuthn 由浏览器原生实现处理。更换设备后，在新的浏览器 Profile 里重新登录即可。

### 预置账号

用 `--load-extension` 加载解压目录的启动器（例如 [AnyBrowser](https://github.com/riba2534/anybrowser)）可以在 `manifest.json` 旁放一个 `managed-config.json`：

```json
{ "serverUrl": "https://passkey.example.com", "username": "alice", "password": "…" }
```

扩展每次启动时读取这个文件，三项齐全就用它登录，覆盖之前保存的账号；文件不存在或内容不完整时保持原样。文件里是明文密码，请只放在当前用户可读的目录。

## 工作原理

```mermaid
sequenceDiagram
    participant Site as 网站页面
    participant Inject as inject.js<br/>页面主环境
    participant Content as content.js<br/>扩展隔离环境
    participant SW as Service Worker
    participant Server as Passkey Box 服务端

    Site->>Inject: navigator.credentials.get()
    Inject->>Content: postMessage
    Content->>SW: chrome.runtime.sendMessage
    SW->>Server: GET /api/v1/credentials?rp_id=…
    Server-->>SW: 该网站的通行密钥
    opt 需要选择账号
        SW-->>Content: 候选账号
        Content->>Content: 页面右上角显示选择框
        Content->>SW: 用户选中的账号
    end
    SW->>SW: 用该账号的私钥生成网站签名
    SW-->>Inject: 断言结果
    Inject-->>Site: PublicKeyCredential
```

- `inject.js` 在 `document_start` 阶段注入页面主环境（MAIN world），替换 `CredentialsContainer.prototype.create/get`，并让能力检测方法返回「支持通行密钥」。这也是 1Password、Bitwarden 等浏览器扩展采用的做法；Chrome 没有提供让扩展充当通行密钥提供方的专用 API。
- `content.js` 运行在扩展的隔离环境，负责转发请求和绘制页面内界面（放在 open shadow root 里，不受页面样式影响）。
- Service Worker 核对请求来自顶层页面、rpId 属于该页面的域名，然后用 WebCrypto 生成网站凭据或签名。

| 认证器参数 | 取值 |
|---|---|
| 算法 | ES256（优先）、RS256 |
| 证明格式 | `none` |
| 标志位 | 注册返回 `UP UV BE BS AT`，登录返回 `UP UV BE BS` |
| 签名计数 | 恒为 0，多端共用同一把密钥不会触发计数回退 |
| 凭据 ID | 32 字节随机数 |

## 配置

服务端通过环境变量配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PKB_LISTEN` | `:8080` | 监听地址 |
| `PKB_DB` | `./data/passkey-box.db` | SQLite 文件路径，目录不存在时自动创建 |
| `PKB_ADMIN_USERNAME` / `PKB_ADMIN_PASSWORD` | 空 | 启动时确保该管理员存在；已存在时只设为管理员，不改密码 |
| `PKB_ALLOW_REGISTER` | `false` | 是否允许在 Web 后台自助注册 |
| `PKB_COOKIE_SECURE` | `false` | 会话 Cookie 是否带 `Secure`，HTTPS 部署时设为 `true` |
| `PKB_EXTENSION_ZIP` | 空 | 扩展安装包路径，Web 后台「安装插件」页提供下载 |

HTTP API 的完整说明见 [docs/API.md](docs/API.md)：认证方式、错误格式、凭据与用户管理接口。

## 开发与测试

```bash
make test           # 服务端 go vet + go test，扩展类型检查 + 单元测试
make e2e            # 端到端测试：构建服务端和扩展，启动自带的测试网站，在 Chromium 里跑完整流程
make build          # 构建服务端二进制和扩展（extension/dist 可直接「加载已解压的扩展程序」）
make zip-extension  # 打包扩展
```

- **单元测试**：扩展的认证器输出用 [`@simplewebauthn/server`](https://simplewebauthn.dev/) 校验，覆盖 ES256 / RS256 的注册与登录。
- **端到端测试**使用本地网站、真实扩展、服务端和 Chromium 测试认证器，覆盖注册、登录、账号选择、要求 UV 的网站和浏览器原生回退。
- CI 在每次推送和 PR 上运行以上全部测试。

```text
passkey-box/
├── server/        Go 服务端：REST API、SQLite 存储、内嵌 Web 后台
├── extension/     Chrome MV3 扩展（TypeScript + esbuild）
├── e2e/           Playwright 端到端测试与测试网站
├── deploy/        部署脚本与 Caddy 配置示例
├── docs/          API 文档、图片与品牌素材
└── scripts/       图标生成脚本
```

图标由 AI 生成的母版派生，替换方法见 [docs/brand](docs/brand/README.md)。

## FAQ

<details>
<summary><b>为什么不会弹出系统的指纹或 Windows Hello？</b></summary>

扩展在页面里接管了 WebAuthn 调用，由扩展自己签名，请求根本不会到达操作系统。只有你在对话框里点「使用其他方式」时，才会交给浏览器原生实现。

</details>

<details>
<summary><b>能和 1Password、Bitwarden 等扩展同时使用吗？</b></summary>

它们也会替换同一个 `navigator.credentials` 接口，同时启用会互相抢。使用 Passkey Box 时，请关闭其他密码管理器扩展的通行密钥功能。

</details>

<details>
<summary><b>保存在 Passkey Box 里的通行密钥能导入 1Password 吗？</b></summary>

数据层面是兼容的：Passkey Box 保存了凭据 ID、rpId、userHandle、用户名和 PKCS#8 私钥，与 FIDO 联盟的 [Credential Exchange Format](https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html) 中 passkey 条目的字段一致，签名计数也满足规范要求的 0。但 1Password 目前不支持从文件导入通行密钥，只能在 iOS/iPadOS 26 及以上通过系统的 Credential Exchange 在应用之间直接传输（见 [1Password 导入说明](https://support.1password.com/import/)），所以现在没有直接导入的路径。

</details>

<details>
<summary><b>哪些网站用不了？</b></summary>

要求硬件证明（attestation）或限定认证器型号（AAGUID 白名单）的网站会拒绝软件生成的通行密钥，常见于部分企业身份平台。大多数面向个人用户的网站接受 `none` 证明，可以正常使用。

</details>

<details>
<summary><b>同一个网站的多个账号能同时保持登录吗？</b></summary>

这取决于浏览器而不是通行密钥：同一个 Chrome 用户配置里，同一网站的 Cookie 是共享的，后登录的账号会顶掉前一个。需要同时在线时，可以为每个账号建一个 Chrome 用户配置，各自安装扩展、连接同一个服务端。

</details>

<details>
<summary><b>服务器连不上会怎样？</b></summary>

点击登录时会弹出错误提示，可以选择交给浏览器原生实现；页面加载时的自动填充式请求则保持静默，不会打扰你。

</details>

## 许可证

[MIT](LICENSE) © riba2534
