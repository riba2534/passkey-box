## 安装 Chrome 扩展

1. 下载下方的 `passkey-box-extension-<版本>.zip` 并解压到一个固定目录（之后不要删除或移动它）。
2. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择解压出来的目录。
4. 点击工具栏上的 Passkey Box 图标，填入服务器地址、用户名和密码，登录后即可使用。

v0.2.0 为扩展增加固定 ID。从 v0.1.0 升级后，请重新登录扩展，服务器上的网站凭据可以继续使用。

服务端的部署方式见 [README](https://github.com/riba2534/passkey-box#快速开始)；已部署的服务端也可以在 Web 后台的「安装插件」页下载预填了服务器地址的安装包。

校验文件完整性：

```bash
sha256sum -c passkey-box-extension-<版本>.zip.sha256
```

## AnyBrowser

`passkey-box-extension-anybrowser-<版本>.zip` 是 AnyBrowser 内置版本，预填其指定的服务器地址。
