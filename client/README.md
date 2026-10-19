# CF-Workers-TXT 客户端（Android + Windows）

一个**不依赖浏览器**的原生客户端：Flutter 自带渲染引擎（Impeller / Skia），
不塞 Chromium，也不套系统 WebView。**服务端 `worker.js` 一行都没改**，只吃它现有的
`/<ADMIN_UUID>/api` 接口。

- 目标平台：**Android**（侧载 APK）+ **Windows**（解压即用的 zip）
- 站点地址：**运行时可改**（换域名 / 换 Workers 项目都不用重装）
- 构建：GitHub Actions 全自动出包，不需要 Mac，也不需要签名证书

---

## 为什么是 Flutter（而不是 Electron / Tauri）

| 方案 | 是否碰浏览器 | 结论 |
| --- | --- | --- |
| Electron | ❌ 自带一整个 Chromium | 直接违反"不依赖浏览器" |
| Tauri | ❌ 用系统 WebView（Windows 上是 WebView2） | 同上，而且 Windows 7/精简系统常缺 WebView2 |
| **Flutter** | ✅ 自己画像素 | 选定：一套代码出 Android + Windows |
| Compose Multiplatform | ✅ | 备选；Android 生态好，Windows 端成熟度不如 Flutter |
| .NET MAUI | ✅ | 备选；Windows 很顺，Android 端体积与表现一般 |

详细取舍（含"为什么只做这两个平台"）见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 目录结构

```
client/
├── ARCHITECTURE.md        架构判断与设计（先读这个）
├── core/                  ★ 纯 Dart，零第三方依赖，CI 里 `dart test` 跑单测
│   ├── lib/src/config.dart        站点地址解析 / URL 拼接
│   ├── lib/src/transport.dart     dart:io HttpClient 封装（流式下载 + .part 原子落盘）
│   ├── lib/src/session.dart       表单登录 + 会话 Cookie + 401 自愈
│   ├── lib/src/api.dart           全部管理端接口的类型化封装
│   ├── lib/src/rate_limit.dart    并发闸门 + 滑动窗口限速
│   ├── lib/src/models.dart        响应模型（缺字段一律退化，不抛异常）
│   ├── lib/src/state_store.dart   本地同步账本（一个 JSON 文件）
│   ├── lib/src/sync.dart          pull / push 增量同步 + 冲突处理
│   └── test/                      单测（含一个照 worker.js 语义写的内存服务端）
└── app/                   Flutter UI（手机与桌面共用逻辑，只分叉布局）
    └── lib/
        ├── main.dart
        └── src/
            ├── store.dart              站点档案 / 密码与 Cookie 的安全存储
            ├── util.dart               体积、时间、路径、扩展名小工具
            ├── widgets/entry_tile.dart 列表行
            ├── widgets/icons.dart      扩展名 → Material 图标
            └── pages/{setup,home,editor,search,shares,sync}_page.dart
```

**为什么分两层**：`core` 不 import 任何 Flutter，所以 CI 能用 `dart test` 在几秒内
把 URL 解析、认证、API 形状、同步冲突这些"错了会丢数据"的逻辑跑一遍；而 Flutter 编译
（尤其 Windows）要好几分钟，不该用来发现拼写错误。

**为什么仓库里没有 `android/` 和 `windows/`**：那些是 `flutter create` 生成的脚手架，
Gradle / AGP / CMake 模板会随 Flutter 版本变化，存进仓库迟早和 SDK 打架。
CI 里现生成再拷回来（见 `.github/workflows/client-build.yml`），仓库只保留 `lib/` 这个真相源。

---

## 构建

### 用 GitHub Actions（推荐）

推送到 GitHub 后，Actions 里会出现 **client-build**：

| Job | Runner | 产物 |
| --- | --- | --- |
| `test-core` | ubuntu-latest | 无（`dart test`，秒级） |
| `android` | ubuntu-latest | `cfwtxt-android-apk`（zip 里是 `cfwtxt-N.apk`） |
| `windows` | windows-latest | `cfwtxt-windows-x64.zip` |

也可以在 Actions 页面手动 `Run workflow`。产物在对应 run 的 **Artifacts** 里，保留 30 天。

- **APK 直接装**：Flutter 模板的 release 默认用 debug keystore 签名，所以不配 Secrets
  也能装。要正式签名再往 Secrets 里加 `KEYSTORE_BASE64` / `KEY_ALIAS` / `KEY_PASSWORD` /
  `STORE_PASSWORD` 并在 `android/app/build.gradle(.kts)` 里接上。
- **Windows 解压即用**：`cfwtxt.exe` 必须和同目录的 `flutter_windows.dll`、`data/` 待在一起，
  所以不要只把 exe 拷出来。

### 本地构建

```bash
# core 单测（不需要 Flutter，几秒钟）
cd client/core && dart pub get && dart test

# Android
cd client/app
flutter create --platforms=android --org dev.cfwtxt --project-name cfwtxt /tmp/scaffold
cp -r /tmp/scaffold/android ./android
flutter pub get && flutter build apk --release

# Windows（PowerShell）
cd client/app
flutter create --platforms=windows --org dev.cfwtxt --project-name cfwtxt "$env:TEMP\scaffold"
Copy-Item -Recurse "$env:TEMP\scaffold\windows" ".\windows"
flutter config --enable-windows-desktop
flutter pub get; flutter build windows --release
# 产物：build\windows\x64\runner\Release\ 整个目录
```

> 建议首次 `flutter pub get` 后把 `client/app/pubspec.lock` 提交进来，锁定依赖版本。

---

## 首次使用

1. 打开 App → **添加站点**。
2. 把浏览器地址栏里那条管理入口**整条粘进去**，例如
   `https://你的域名/a1b2c3d4`。客户端会自己拆成 `域名` + `ADMIN_UUID`，
   并在输入框下面实时显示"我理解成了什么"。
3. 站点设了 `PASSWORD` 就填密码；点 **测试连接** 确认能列出根目录。
4. 以后**域名变了**：回到「设置 → 站点 → 编辑」，只改地址那一格。密码、本地缓存、
   同步账本都保留。

密码存在平台安全存储里（Android Keystore / Windows 凭据管理器），
**不写进 `shared_preferences`，也不进任何导出文件**。

---

## 功能对照

| 能力 | 客户端 | 说明 |
| --- | --- | --- |
| 浏览目录 / 排序 / 分页 | ✅ | 与网页端同一套 `list` 参数 |
| 目录树（含每层项数与递归体积） | ✅ | `treeFull`，宽屏常驻左栏 |
| 读 / 写文本 | ✅ | `read` 上限 2MB；超了转为"下载后用系统程序打开" |
| 新建文本 / 文件夹 / 受保护文件夹 | ✅ | 受保护文件夹的删除需要再输密码 |
| 重命名 / 移动 / 批量删除 / 批量移动 | ✅ | 跨保护区边界时按服务端要求补密码 |
| 上传（含大文件分片 + 断点续传） | ✅ | ≤8MB 走 PUT，更大走 `mpCreate/mpPart/mpComplete`；中断后重试会跳过已传分片 |
| 下载 | ✅ | 流式写 `.part` 再改名；**服务端不支持 Range，所以不能中途续传** |
| 搜索（文件名 / 路径 / 正文） | ✅ | 四类命中用芯片分开计数，与网页端一致 |
| 全文深搜（带行号） | ✅ | `deepsearch`，索引只有前 8K，行号它给不了 |
| 重建正文索引 | ✅ | 服务端每批只处理几个文件，UI 会显示批数 |
| 分享（生成 / 列表 / 取消 / 全部取消） | ✅ | 链接可在系统浏览器打开 |
| 发布 / 撤回 / 一键补发 | ✅ | 发布=复制到影子树；撤回只删影子副本，链接仍保留 |
| 与本机目录增量同步 | ✅ | `size + mtime` 判据；冲突策略四选一，默认"都保留" |
| Markdown 渲染 | ✅ | `flutter_markdown` 原生渲染，不是 WebView |
| 图片预览 | ✅ | 直接请求 `<ADMIN>/f/<路径>` 并带会话 Cookie |
| HTML 沙箱预览 | ❌ 故意不做 | 需要 WebView/iframe，与"不依赖浏览器"冲突。可下载后用系统浏览器打开**本地副本** |
| 打 ZIP 下载整个目录 | ⏳ 未做 | 服务端只给清单（`packList`），ZIP 要在客户端打；这一期先不做 |
| iOS / macOS / Linux | ❌ 本期不做 | 只要 Android + Windows；以后加也就几行 CI |

---

## 已知限制（都是刻意的，不是漏了）

1. **HTML 不在客户端里跑**。本地沙箱预览要么 WebView 要么 iframe，两条路都违反前提。
   给的是"源码视图 + 下载后打开"。注意：直接让外部浏览器访问 `/f/...` 会 401
   （它没有你的会话 Cookie），所以必须先落地成本地文件。
   Windows 上可以"下载后用系统程序打开"；**Android 上不行** —— 把文件交给别的 App
   需要 FileProvider + `content://`，本期没做，所以只提示文件落在应用私有目录里的位置。
2. **下载不能断点续传**，因为服务端不处理 `Range`。好的一面是失败时不会留下一个
   "看起来完整"的半截文件（先写 `.part`，成功后改名）。
3. **同步靠 `size + mtime`，不是内容哈希**。服务端没有给客户端内容哈希接口，
   而这一期约束是不改 `worker.js`。两边都改过时**默认不覆盖**，而是把本机版本另存一份
   （`xxx (本机冲突 2026-10-19 1530).txt`）。
4. **Android 的同步目录是应用私有目录**。系统不允许普通应用随意写外部存储，
   要写到 `Download/` 需要 SAF 或 `MANAGE_EXTERNAL_STORAGE`，代价大于收益。
   桌面端可以换成任意目录（比如 Obsidian 仓库）。
5. **正文编辑上限 2MB**（服务端 `read` 的限制），不是客户端偷懒。
6. **清单上限 20000 个对象**。超了服务端回 `truncated: true`，同步页会**明确告警**，
   不会假装"全都同步好了"。

---

## 排错

| 症状 | 原因 / 处理 |
| --- | --- |
| release APK 装上去所有请求都失败，debug 却正常 | Flutter 模板只在 debug manifest 里给 `INTERNET` 权限。CI 已自动补进 `src/main/AndroidManifest.xml`；本地构建记得自己补 |
| Windows 版双击没反应 | 只拷了 exe。必须连同 `flutter_windows.dll` 和 `data/` 整个目录一起 |
| 登录总提示密码错 | 服务端连续 8 次失败会锁 10 分钟（KV `loginfail:`）。等一会儿，别连点 |
| 搜索搜不到正文 | 站点没绑 KV，或索引没建。搜索页横幅里有「重建索引」 |
| 分享页看不到新内容 | 链接指向的是影子副本，改完要再点一次「发布」（或分享页的「重新发布」） |
| `http://192.168.x.x` 连不上 | Android 默认禁明文。CI 已给 manifest 加 `usesCleartextTraffic="true"`；自建时注意同一件事 |

---

## 安全说明

- **不发 `Origin` 头**。服务端的 CSRF 校验只在"带 Origin 且跨站"时拒绝，
  原生客户端天然不满足这个条件，因此不需要任何额外处理（也不该伪造 Origin）。
- **密码不落盘到配置**。配置里只有 `hasPassword` 标记；密码本身进平台安全存储。
- **不本地派生会话令牌**。客户端走表单登录拿 `Set-Cookie`，而不是自己算
  `sha256(PASSWORD::ADMIN_UUID)` —— 后者会把服务端实现细节焊死在已发布的 App 里。
- **路径穿越防护**。服务端返回的路径在落盘前过 `SyncEngine.safeRel()`，
  拒绝 `..`、绝对路径与 Windows 盘符。
- **限速**。并发 4 + 每分钟 200 次（服务端默认 240），429 时按 `Retry-After` 退避。
  管理端 PUT/POST/DELETE 不计入服务端限速，所以上传不会因此变慢。
