# Passkey Box 端到端测试

用 Playwright 驱动加载了 Passkey Box 扩展的 Chromium，在自带的测试站点（RP）上注册、登录通行密钥，并通过服务端 API 核对保存结果。

## 运行

需要 Node ≥ 22.18（直接运行 `.ts`）、Go，以及 Playwright 的 Chromium（`npx playwright install chromium`）。

```bash
cd e2e
npm ci
npx tsc --noEmit                              # 类型检查
npx playwright test                           # 全部：构建并启动服务端、构建扩展、跑所有用例
npx playwright test --project=harness         # 只验证测试 RP（CDP 虚拟认证器，不需要服务端和扩展）
npx playwright test --project=extension       # 只跑扩展用例（会自动带上准备步骤）
npx playwright test --list                    # 列出用例
```

`--headed` 可以看到浏览器窗口。设置 `PKB_E2E_CHROMIUM` 可用指定的 Chromium 可执行文件替代 Playwright 自带版本，测试仍会使用独立的临时 Profile。

### 用旧版扩展测试新服务端

已安装的旧版扩展不会自动升级，新服务端必须继续支持它们。设置 `PKB_E2E_EXTENSION_DIR` 为一个已经构建好的扩展解压目录时，准备步骤不再构建 `extension/`，直接加载这个目录（服务端照常从当前代码构建）：

```bash
git worktree add --detach /tmp/ext-e2e/v050 v0.5.0
(cd /tmp/ext-e2e/v050/extension && npm ci && npm run build)
PKB_E2E_EXTENSION_DIR=/tmp/ext-e2e/v050/extension/dist npx playwright test --project=extension
git worktree remove /tmp/ext-e2e/v050
```

用例用 `extensionSince(stack, '<版本>')` 按这个目录里 `manifest.json` 的版本判断扩展有哪些界面，只在版本够新时断言新界面的文案。不设置这个变量时测试的是 `extension/` 的当前代码，无论它的版本号是多少。

## 结构

| 路径 | 作用 |
|---|---|
| `rp/server.ts` | 测试 RP：Node HTTP 服务 + `@simplewebauthn/server`，内存存储，`http://localhost:18422`，rpId `localhost` |
| `rp/public/` | RP 页面；元素约定见 `index.html` 注释，结果字符串见 `client.js` 开头 |
| `tests/setup/` | 准备与收尾（Playwright 项目依赖）：`rp.setup` 启动 RP；`stack.setup` 构建服务端与扩展、用临时数据库启动服务端、用管理员 `e2e-admin` 创建测试账号 `e2e-user-a` / `e2e-user-b`；对应的 teardown 按 PID 停进程、删临时目录 |
| `tests/rp-harness.spec.ts` | RP 冒烟用例，只用 CDP 虚拟认证器 |
| `tests/extension/` | 扩展 + 服务端用例 |
| `support/` | 端口与路径、进程管理、服务端 API 客户端、RP 页面对象、扩展 fixture、虚拟认证器 |

扩展 fixture 每个用例都新建一个持久化 Chromium 上下文（`channel: 'chromium'`，headless shell 不能加载扩展），从扩展 service worker 写 `chrome.storage.local` 的 `pkb_config` / `pkb_settings` 完成配置，扩展登录后即可签名，不需要其他设置。网站测试页可挂上 CDP 虚拟认证器，供原生回退用例使用，也用来确认请求没有落到浏览器原生实现。每个用例开始前重置 RP，并用管理员接口删除服务端的全部凭据（共享和转移会让凭据跨账号，所以不按账号逐个删）。模拟多个浏览器 Profile 的用例用 `launchProfile` 和 `extensionIn` 另开独立上下文；预置账号的用例（`managed.spec.ts`）像 AnyBrowser 那样为每个上下文复制一份扩展并写入 `managed-config.json`。

## RP 页面约定

- `#username`（`autocomplete="username webauthn"`）、`#exclude`（注册时带 `excludeCredentials`）、`#register`、`#login`（无用户名，`allowCredentials` 为空）、`#login-username`（`allowCredentials` 为该用户的凭据）。
- `/?conditional=1` 在页面加载时发起 `mediation: 'conditional'` 登录。点击按钮会中止该请求。
- `/?uv=required` 让 RP 在选项中请求 UV，并在通过 SimpleWebAuthn 校验响应时要求 UV。
- `#result`：`registered:<用户名>`、`authenticated:<用户名>`（服务端校验通过，用户名由 `userHandle` 找回）、`error:<DOMException name>`、`rejected:<RP 拒绝原因>`、`pending:<动作>`。
- 接口：`POST /api/reset` 清空状态，`GET /api/state` 查看用户和凭据，`GET /healthz`。

## 端口与临时文件

- 服务端 `127.0.0.1:18421`，RP `18422`；可用 `PKB_E2E_SERVER_PORT` / `PKB_E2E_RP_PORT` 覆盖。
- 运行时文件默认位于 `/tmp/pkb-e2e/`，可用 `PKB_E2E_TMP_ROOT` 指定独立目录。`rp/`、`stack/`（服务端二进制、数据库、日志、随机生成的账号密码）运行结束即删除，设 `PKB_E2E_KEEP_TMP=1` 保留；`test-results/` 存失败现场。
