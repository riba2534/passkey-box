# 品牌素材

`icon-master.png` 是 Passkey Box 图标的母版（1024×1024，满版无圆角），由 AI 生图生成（`codex/gpt-image-2`），提示词要点：

> App icon for 'Passkey Box', a self-hosted passkey manager. Symbol: a bold solid white key whose round bow is shaped as a rounded square box with a small keyhole cut-out in its center; short sturdy shaft with two simple teeth, placed diagonally. Full-bleed square artwork, no rounded corners, no text. Background: smooth rich blue gradient from #3B9BFF to #0352C4. Flat modern style, legible at 16×16.

所有尺寸都由脚本从母版派生，替换母版后重新运行即可：

```bash
./scripts/make-icons.py   # 需要 uv；会覆盖扩展、Web 后台和 docs/images 里的图标
```

| 产物 | 用途 |
|---|---|
| `extension/static/icons/icon-{16,32,48,128}.png` | 扩展工具栏与扩展管理页 |
| `extension/static/icons/logo-128.png` | 扩展弹出窗口、设置页 |
| `extension/src/assets/logo-64.png` | 页面内选择框（构建时内联为 data URL） |
| `server/internal/web/static/assets/favicon.ico`、`favicon-32.png` | 浏览器标签页图标 |
| `server/internal/web/static/assets/logo-128.png` | Web 后台侧栏与登录页 |
| `server/internal/web/static/assets/apple-touch-icon.png` | iOS 主屏幕 |
| `server/internal/web/static/assets/icon-{192,512}.png`、`icon-maskable-512.png` | PWA（`manifest.json`） |
| `docs/images/logo.png` | README |

主色 `#0572EC`，与 Web 后台和扩展界面的主色一致。
