## 安装 Chrome 扩展

1. 下载下方的 `passkey-box-extension-<版本>.zip` 并解压到一个固定目录（之后不要删除或移动它）。
2. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择解压出来的目录。
4. 点击工具栏上的 Passkey Box 图标，填入服务器地址、用户名和密码。

升级时用新版本覆盖同一目录，再在 `chrome://extensions` 里点扩展卡片上的刷新按钮。

服务端的部署方式见 [README](https://github.com/riba2534/passkey-box#快速开始)；已部署的服务端也可以在 Web 后台的「安装插件」页下载预填了服务器地址的安装包。

校验文件完整性：

```bash
sha256sum -c passkey-box-extension-<版本>.zip.sha256
```

> Passkey Box 面向测试与自用场景，刻意不做安全设计，详见 README 中的说明。
