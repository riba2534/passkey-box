# Passkey Box

自托管的通行密钥（Passkey）管理工具，交互参照 1Password：Chrome 扩展接管网站的通行密钥注册和登录，通行密钥统一保存在你自己的服务端，多台电脑、多个浏览器共用同一份数据。

> **只用于测试和自用场景。** 本项目刻意不做任何安全设计：私钥明文保存在服务端，扩展不加锁、不二次确认，用户验证（UV）标志直接置位。不要用它保管重要账号。

## 功能

- **扩展当认证器**：网站调用 `navigator.credentials.create/get` 时由扩展生成密钥和签名，不会唤起系统的指纹、Windows Hello 或手机扫码。
- **自动登录**：当前网站只匹配到一个通行密钥时直接登录；有多个时弹出选择框；网站带了指定凭据（先输用户名再登录）时只用匹配的那个。
- **自动保存**：网站创建通行密钥时直接保存到服务端，同一网站同一账号重复注册会覆盖旧的。
- **多用户服务端**：每个用户有自己的通行密钥；Web 后台可以查看、备注、删除通行密钥，管理员可以管理所有用户。
- **页面打开即登录**：网站在页面加载时发起的自动填充式请求（conditional mediation），只有一个候选时直接完成登录。

## 使用

1. 打开服务端 Web 后台（例如 `https://password.riba2534.cn`），用管理员账号登录，在「用户管理」里创建用户。
2. 在「安装插件」页下载扩展安装包并解压，打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」选择解压后的目录。
3. 点击扩展图标，填入服务器地址、用户名和密码并登录。
4. 之后在任意网站注册或使用通行密钥，扩展都会自动处理。弹出窗口里可以查看当前网站和全部通行密钥，也可以关闭「只匹配到一个时自动登录」「页面打开时自动登录」。

在对话框里点「使用其他方式」会交还给浏览器原生实现（这时才可能出现系统认证）。

## 目录

| 目录 | 内容 |
|---|---|
| `server/` | Go 服务端：REST API + 内嵌 Web 后台，SQLite 存储 |
| `extension/` | Chrome MV3 扩展（TypeScript） |
| `e2e/` | 端到端测试：自带测试网站，用 Playwright 加载扩展跑完整流程 |
| `docs/API.md` | 服务端 HTTP API |
| `deploy/` | 部署脚本和 Caddy 配置示例 |

## 开发

需要 Go 1.26+ 和 Node.js 22+。

```bash
make test        # 服务端与扩展的单元测试
make e2e         # 端到端测试（构建服务端和扩展，启动测试网站，在 Chromium 里跑）
make run         # 本地启动服务端：http://127.0.0.1:8080，管理员 admin / admin
make zip-extension PKB_DEFAULT_SERVER_URL=https://your.server   # 打包扩展，登录页预填服务器地址
```

开发扩展时可以直接加载 `extension/dist`（`make build-extension` 生成）。

### 服务端配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PKB_LISTEN` | `:8080` | 监听地址 |
| `PKB_DB` | `./data/passkey-box.db` | SQLite 文件路径 |
| `PKB_ADMIN_USERNAME` / `PKB_ADMIN_PASSWORD` | 空 | 启动时确保该管理员存在（已存在时不改密码） |
| `PKB_ALLOW_REGISTER` | `false` | 是否允许在 Web 后台自助注册 |
| `PKB_COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `PKB_EXTENSION_ZIP` | 空 | 扩展安装包路径，供 Web 后台下载 |

### 部署

`deploy/deploy.sh` 在本地静态编译服务端、打包扩展，上传到 Docker 主机后用 `FROM scratch` 镜像运行，容器只监听 `127.0.0.1:18300`，由反向代理（Caddy 示例见 `deploy/Caddyfile.snippet`）提供 HTTPS：

```bash
DEPLOY_HOST=ubuntu@your-host SSH_KEY=~/.ssh/id_ed25519 PUBLIC_URL=https://your.domain ./deploy/deploy.sh
```

首次部署会在服务器的部署目录生成 `passkey-box.env`，里面是随机生成的管理员密码。

## 实现说明

扩展在页面主环境（MAIN world）的 `document_start` 阶段替换 `navigator.credentials.create/get`，请求经内容脚本转给 service worker；service worker 从服务端拉取当前网站的通行密钥，用 WebCrypto 完成 ES256（或 RS256）签名，生成 `none` 格式的证明。签名计数固定为 0，备份标志（BE/BS）置位，网站会把它当作可同步的通行密钥。详见 [docs/API.md](docs/API.md)。
