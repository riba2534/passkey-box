## 安装 Chrome 扩展

1. 下载下方的 `passkey-box-extension-<版本>.zip` 并解压到一个固定目录（之后不要删除或移动它）。
2. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择解压出来的目录。
4. 点击工具栏上的 Passkey Box 图标，填入服务器地址、用户名和密码。
5. 打开「设置 → 设备验证」，通过 Chromium 注册一个设备凭据。

v0.2.0 为扩展增加固定 ID。从 v0.1.0 升级后，请重新登录扩展并设置设备验证，服务器上的网站凭据可以继续使用。

服务端的部署方式见 [README](https://github.com/riba2534/passkey-box#快速开始)；已部署的服务端也可以在 Web 后台的「安装插件」页下载预填了服务器地址的安装包。

校验文件完整性：

```bash
sha256sum -c passkey-box-extension-<版本>.zip.sha256
```

## 设备验证

匹配到站点凭据时，扩展会打开标注请求网站的验证窗口。设备完成 WebAuthn 用户验证后，扩展会自动提交网站签名。

`passkey-box-extension-anybrowser-<版本>.zip` 是 AnyBrowser 内置版本，预填其指定的服务器地址。
