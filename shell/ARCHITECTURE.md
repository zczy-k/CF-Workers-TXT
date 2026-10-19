# WebShell —— 万能壳的架构

> 一句话：**把系统自带的浏览器引擎当成库装进 App 里，然后在它外面套一层原生外壳**
> （多站点、下载器、上传、Cookie 持久化、品牌定制）。网站跑在引擎里，所以网站上能干的事它都能干；
> 外壳负责补上"浏览器做得到、但普通网页做不到"的那些事（存到手机/电脑本地、断点续传、独立的登录态）。

本文所有"支持/不支持"都是**查过插件源码或实测**的结论，不是照着宣传语写的。与代码不一致的地方，
以代码为准，并回来改本文。

---

## 0. 先回答两个容易搞混的问题

**"不依赖浏览器"是什么意思？**
不是"不用浏览器引擎"。任意网站要能跑，必须有一个真正的渲染引擎，这是物理事实。区别只在引擎从哪来：

| | 引擎来源 | 包体积 | 说明 |
| --- | --- | --- | --- |
| **本项目采用** | Android `android.webkit.WebView`（系统组件）+ Windows WebView2 运行时 | APK 30–60MB / 便携包 ~20MB | 不打开用户的 Chrome/Edge，不共享它的标签页、书签、Cookie、扩展；用户装不装浏览器都无所谓 |
| 备选（未采用） | 自带 Chromium（CEF） | 200MB+ | 完全自包含，但构建与升级都重，且本机没有 VS/Android SDK 无法验证 |

**为什么"网页转 APP"的工具会残废？**
不是引擎不行，是它们少做了几件事——而这几件事恰好就是"翻页 / 下载 / 上传"：

| 症状 | 真实原因 | 本项目的做法 |
| --- | --- | --- |
| 点链接没反应、翻不了页 | 拦了导航、只放行白名单域名，`target="_blank"`/`window.open` 直接丢 | 引擎导航全放行；`window.open` 在**同一个视图里**打开（不是丢弃）；只有 `tel:` `mailto:` `intent://` `weixin://` 等交给系统 |
| 下载不了 | 没接下载事件，请求静默丢失 | 三条下载路径全覆盖，见 §4 |
| 前端生成的文件（`blob:`/`data:`）下不来 | 这两类不走网络层，拦不到 | 注入脚本 + 消息桥把字节流出来再落盘 |
| 上传点不动 | 没实现文件选择回调 | 交给引擎原生的文件选择器（`<input type=file>` / 拖拽） |
| 登录一会儿就掉 | Cookie 没持久化到 App 私有目录 | Cookie 落 App 自己的 profile，重启仍在，见 §6 |
| 视频不能全屏、权限弹不出来 | 没处理全屏事件与权限请求 | 逐项接上（Windows 全屏用注入脚本兜底） |

---

## 1. 形态：一个仓库，两种产物

同一份代码，靠**构建期配置**切换：

| 产物 | 怎么来 | 行为 |
| --- | --- | --- |
| **通用壳** | 默认构建（push 就出） | 启动是站点列表，用户自己输网址添加，多站点随意切换 |
| **白标版（专属 APP）** | CI 里手动 Run workflow，填 `app_name` / `app_id` / `preset_url` / 主题色 / logo | 装上就是那个网站的样子（名字、图标、主题色都是它的），但设置里**仍然可以再加别的站点** |

白标版不是另一份代码，只是构建期多覆盖两个文件：`assets/preset.json`（预置站点 + 名字 + 主题色）
和平台图标。App 首次启动把预置站点写进站点列表并设为默认，所以"以后再想加第二个网站"不需要重新出包。

---

## 2. 分层架构

```
┌───────────────────────────────────────────────────────────────┐
│ 壳 UI 层（Flutter，纯 Dart）                                    │
│  站点列表 · 浏览页（前进/后退/刷新/回到首页）· 下载队列           │
│  站点设置（UA / 自定义头 / Basic Auth / 站内导航）· 全局设置       │
└──────────────────────────┬────────────────────────────────────┘
                           │ 只依赖下面的抽象接口
┌──────────────────────────▼────────────────────────────────────┐
│ 壳逻辑层 webshell_core（纯 Dart，零 Flutter / 零第三方依赖）      │
│  站点档案 · 配置持久化 · URL 规整 · 请求头组装 · 下载队列/续传     │
│  → 可 dart test，78 个用例                                        │
└──────────────────────────┬────────────────────────────────────┘
┌──────────────────────────▼────────────────────────────────────┐
│ 引擎适配层（每个平台一份薄实现）                                 │
│  Android: flutter_inappwebview（系统 WebView）                  │
│  Windows: flutter_inappwebview（WebView2）                     │
│  统一抽象：加载 · 前进后退 · 注入脚本 · 取 Cookie · 新窗口 · 下载 │
└──────────────────────────┬────────────────────────────────────┘
┌──────────────────────────▼────────────────────────────────────┐
│ 桥接层（"全功能"就靠它）                                        │
│  下载拦截 · blob/data 导出 · 文件选择 · 新窗口→当前视图 ·         │
│  外部协议 · 权限请求 · Basic Auth · 自定义请求头 · 注入脚本       │
└───────────────────────────────────────────────────────────────┘
```

为什么把"壳逻辑"单独抽成纯 Dart 包：这部分（配置、URL 规则、下载队列）最容易写错、也最值得写单测，
而它完全不需要 Flutter——所以能在 CI 里几秒钟跑完 `dart test`，不用等几分钟的 APK / EXE 构建。
`core/` 里连第三方包都没有，是为了"十年后还能 `dart pub get` 装上"。

---

## 3. 导航 / 翻页

- 引擎的标准导航**不做任何限制**：翻页、表单提交、SPA 路由、POST 跳转全部放行。
- `window.open` / `target="_blank"` → **在同一个视图里打开**（`onCreateWindow` 返回 `false`，
  自己接管这次加载）。早期版本这里返回"什么都不发生"，正是"点了按钮没反应"的元凶。
- `shouldOverrideUrlLoading` 只处理**非 http(s) 协议**：`tel:` `mailto:` `sms:` `intent://` `weixin://`
  等交给系统（`url_launcher`）；没有能处理的应用就复制链接并提示。其余一律交回引擎。
- "只在本站内导航"是**每站点可选**设置（默认关）。打开后，跳到别的域的链接交给系统浏览器，
  不会把用户带出这个 App；代价是跨域登录/支付会跳到外部浏览器。
- 后退键 / 后退手势优先走网页历史，历史到头才退出，符合直觉。
- **本版不做多标签**：一个站点 = 一个浏览页，站点之间用列表切换。原因见 §7 的引擎限制——
  Windows 端多标签要自己管 WebView 池，收益小于复杂度；真要并行开两个站点，现在也能开两个页。

### 注入脚本（`lib/src/engine/scripts.dart`）

document-start 注入，只做四件事，且都对失败宽容（单页脚本出错不能拖垮网站）：

1. 拦 `a[download]` / `blob:` / `data:` 的下载点击 → 转成消息桥导出（§4 路径 B）；
2. 给 `fetch` / `XMLHttpRequest` 补自定义请求头（WebView 平台不允许在请求层改内部请求头，
   只能在这一层补；顶层导航由原生带头）；
3. 长按链接 → 消息桥回原生弹"下载 / 复制 / 用浏览器打开"菜单；
4. 监听 `fullscreenchange` → 通知原生隐藏顶栏底栏（Windows 没有全屏事件，这条是兜底）。

---

## 4. 下载：三条路径（这是与"网页转 APP"最大的差距）

**下载不交给引擎**，交给壳自己的下载器：带 Cookie、UA、Referer、自定义头，
支持 `Range` 断点续传、暂停/继续/取消/重试、并发闸门、失败自动重试。
下载器本体在 `webshell_core/lib/src/download.dart`，传输层是可注入接口（`FileDownloadTransport`），
所以断点续传 / 文件名解析 / 并发 / 取消这些逻辑**有单测**，不依赖 UI 和平台。

**路径 A：普通文件下载（覆盖绝大多数）**

引擎抛"要下载"事件（`onDownloadStartRequest`）→ 壳接管：

1. 从站点档案取 Cookie + UA + 自定义头，补上 `Referer`（少一样就有站点回 403）；
2. 从 `Content-Disposition: filename*` / URL 末段推文件名，非法字符折叠（`sanitizeFileName`）；
3. 落盘（见下面的落点表），文件名冲突自动加序号（`uniquePath`）；
4. 服务端支持 `Accept-Ranges` 就续传，不支持就整段重来，UI 会说明"服务器不支持续传"。

**路径 B：`blob:` / `data:`（前端生成的文件）**

这两类不走网络层，拦不到，所以在 document-start 注入脚本里：
`fetch(blobUrl)` → 按 256KB 分片 `FileReader.readAsDataURL` → 逐片经消息桥传给原生（base64 字符串）
→ 原生按同一个下载器落盘、按同一个列表显示进度。分片是为了不把大文件一次性 base64 撑爆内存。

**路径 C：流媒体（`m3u8` / 分片 mp4）**

不承诺。这是另一套工程（嗅探 + 分片合并 + 解密），单独排期。UI 上明确说"这类链接请用专门的下载工具"，
不假装支持。

### 落点（各平台不同，都写在设置/下载页上）

| | 默认目录 | 要不要权限 | "另存为" | 打开文件 |
| --- | --- | --- | --- | --- |
| **Android** | 应用外部目录 `Android/data/<包名>/files/Download`（文件管理器可见） | **不需要**（不用 MANAGE_EXTERNAL_STORAGE，弹窗少一大截） | `flutter_file_dialog` 的系统 SAF 选择器，复制到用户选的目录 | `open_filex` 交给系统关联应用 |
| **Windows** | `%USERPROFILE%\Downloads\WebShell`（可在设置里改成任意目录） | — | 选目标目录 + 复制（不把整文件读进内存） | `explorer.exe` 交给系统关联程序 |

> 进度显示在 App 内的下载列表（列表项 + 角标数字），**没有系统通知栏进度**——那要额外处理
> 通知权限与前台服务，属于 P3，README 的"已知边界"里写明了。

---

## 5. 上传 / 文件选择 / 权限

- `<input type=file>` / 多选 / `capture=相机` / Windows 拖拽 → 全部交给引擎原生通道，
  绝不用"把文件 base64 塞进 JS"的土办法。
- 网页权限请求（摄像头 / 麦克风 / 定位 / 通知 / 剪贴板）→ 弹原生对话框让用户决定；
  非 https（非安全上下文）下的请求**直接拒绝**，与浏览器行为一致。

---

## 6. 认证信息：三种，按站点选

| 方式 | 适用 | 实现 |
| --- | --- | --- |
| **页面登录（默认）** | 99% 的站点 | 用户第一次在网页里正常登录，Cookie 存进 App 自己的 profile，之后保持登录。**不做任何自动填充**，避免触发风控 |
| **Basic Auth（401）** | 服务端弹原生认证框 | 用户名/密码存系统安全存储（Android Keystore / Windows DPAPI），收到 401 时自动应答（`HttpAuthResponse`）；Windows 端引擎没有这个回调，见 §7 |
| **自定义请求头** | 没有登录页的 API 型站点 | 每站点可配 `Authorization: Bearer xxx` 等固定头：顶层导航由原生带，页面内部 `fetch`/XHR 由注入脚本补（`Cookie` 这类禁改头会被跳过） |

配置文件里**只有"有没有密码"这个标记**（`hasBasicAuth`），密码本体永远不进 `json`，
只进 `flutter_secure_storage`。

### 关于 profile 隔离：本版是"共享 profile + 按域名清 Cookie"

- 一个 App 进程里只有一个引擎 profile，**所有站点共用**一份 Cookie / LocalStorage / 缓存。
- "清除该站点的登录态"= 按该站点的域名删 Cookie（`CookieManager.deleteCookies`），别的站点不受影响。
- 因此：**同一站点开多个站点也不会互相顶登录态**，但严格隔离（每个站点一个进程 + 独立数据目录后缀 /
  独立 WebView2 user data folder）**没有做**——它要 Android 多进程 WebView 与 Windows 多目录，
  复杂度不低，且对绝大多数用户没有感知。留到 P5，届时"公司 OA 与私人网盘互不可见"才成立。
- 关掉某个站点的数据 = 只删它的 Cookie，**不动系统浏览器**，也不动别的站点。

---

## 7. 引擎能力矩阵（查过 6.1.5 源码，非推测）

对 `flutter_inappwebview 6.1.5`（Android `1.1.3` / Windows `0.6.0`）逐个 API 查源码：

| 能力 | Android | Windows | 缺口怎么办 |
| --- | --- | --- | --- |
| 导航 / 历史 / 标题 / 进度 | ✅ | ✅ | — |
| 新窗口（`window.open`） | ✅ | ✅ | — |
| document-start 注入脚本 | ✅ | ✅（DevTools 协议） | — |
| JS ↔ 原生消息桥 | ✅ | ✅ | — |
| Cookie 管理 / 按域名清理 | ✅ | ✅ | — |
| **下载事件拦截** | ✅ `onDownloadStartRequest` | ❌ | 注入脚本接管常见按钮/链接/blob；剩下的走 WebView2 自带下载（落到系统"下载"文件夹） |
| **文件上传选择器** | ✅ | ❌（用 WebView2 内建选择器） | 引擎内建通道可用，不额外补 |
| **Basic Auth 弹窗** | ✅ `onReceivedHttpAuthRequest` | ❌ | 罕见；凭据照常存起来（UI 与 Android 一致），Windows 端等第二步 |
| 全屏视频事件 | ✅ | ❌ | 注入脚本监听 `fullscreenchange` 兜底 |
| **"另存为"系统对话框** | ✅（SAF，不需要存储权限） | ❌（用"选目录 + 复制"替代） | Android 更顺，Windows 功能等价 |

**第二步补齐路线（触发条件：Windows 用户反馈下载/上传不灵）**：
自写一个薄 Windows 插件（C++/WinRT，把 WebView2 作为子窗口宿主），直接接
`DownloadStarting` / `ShowFilePicker` / `BasicAuthenticationRequested` / `ContainsFullScreenElementChanged`，
把上表四个 ❌ 填掉。之所以不现在做：约 800 行 C++，而本机没有 Visual Studio，写完只能靠 CI 反复试错
——先把两条流水线跑通、有真机反馈再动它。

> 另一个 Windows 相关的构建事实：`flutter_inappwebview_windows` 在 CMake 配置阶段要用 **nuget**
> 拉 WebView2 / WIL / nlohmann.json 的 SDK，所以 CI 里显式确保 nuget 可用（见 `shell-build.yml`）。

---

## 8. 白标与 CI 输入

`workflow_dispatch` 的输入项（GitHub 只支持文本/布尔输入，**不能上传文件**，所以 logo 走三条路）：

| 输入 | 说明 |
| --- | --- |
| `app_name` | App 显示名（Android `android:label`、Windows 窗口标题） |
| `app_id` | 包名 / 应用 ID，如 `com.example.oa`；**最后一段会被规整成合法 Dart 标识符**，Windows 的 exe 名也用它 |
| `preset_url` | 预置站点入口（就是一个普通 URL，支持内网 `http://`，会自动补 `https://`） |
| `preset_name` | 预置站点在列表里显示的名字（留空用域名） |
| `theme_color` | 主色 `#RRGGBB`（顶栏、图标底色、assets 里的 `themeColor`） |
| `logo_url` | ② 给一个图片 URL，CI 下载后做图标（PNG/JPG/ICO 都行） |
| `logo_path` | ① 仓库里放好文件（如 `shell/branding/logo.png`），CI 直接读 |
| `auto_icon` | ③ 都没给就从预置站点抓 `apple-touch-icon*` / `favicon.ico` / `favicon.png` |
| `allow_add_site` | 白标版是否允许用户再加站点（默认允许） |

**三条路都没结果时不会打出"没有图标"的包**：用 App 名/域名的首字母按主题色画一个
（`shell/tools/branding.sh`，之所以取 ASCII 字母是因为 CI 上不保证有中文字体，画汉字会变方框）。

图标生成**不引第三方依赖**：ubuntu runner 自带 ImageMagick，`branding.sh` 用它切出
Android 五档 `mipmap-*/ic_launcher.png` + 自适应图标（前景按 2/3 缩进安全区）+ 多尺寸
Windows `.ico`；`patch_platform.py` 负责改 Android 清单（INTERNET 权限、允许明文、
`android:label`）和 Windows 的窗口标题（中文转 `\uXXXX` 转义，源码保持纯 ASCII）。

Android `minSdk` 用 Flutter 模板默认的 **24**，正好等于本套插件里要求最高的那个
（`flutter_secure_storage 11` / `flutter_file_dialog` / `url_launcher_android`），所以不必改。

---

## 9. 目录结构

```
shell/
  ARCHITECTURE.md              ← 本文件
  README.md                    ← 使用说明 / 构建 / 白标输入 / 排错
  core/                        ← 纯 Dart：站点档案、配置、URL 规则、请求头、下载队列（dart test）
    lib/src/{models,config,url_utils,headers,download}.dart
    test/                      ← 78 个用例
  app/                         ← Flutter 壳 UI + 引擎适配（CI 现生成 android/windows 脚手架）
    assets/preset.json         ← 通用壳默认值；白标构建时被 CI 覆盖
    lib/src/{state,paths,open,icons}.dart
    lib/src/engine/scripts.dart
    lib/src/pages/{home,browser,site_edit,downloads,settings}_page.dart
    lib/src/widgets/site_avatar.dart
  tools/
    branding.sh                ← 生成图标（Android 各密度 + 自适应 + Windows .ico）与 preset.json
    patch_platform.py          ← 改 Android 清单 / Windows 窗口标题
  branding/                    ← 可选：把 logo.png 放这里，然后给 logo_path 填 shell/branding/logo.png
.github/workflows/
  shell-build.yml              ← test-core → branding → android / windows
```

平台脚手架（`android/`、`windows/`）**不入库**：CI 里 `flutter create` 现生成再拷进 `app/`，
仓库只留 `lib/` 作为唯一真相源——和现有客户端一样的做法，好处是 Flutter 升级时不会跟模板打架。

---

## 10. 阶段计划与现状

| 阶段 | 内容 | 验收 | 现状 |
| --- | --- | --- | --- |
| **P1** | 纯 Dart 核心：站点档案、配置持久化、URL 规则、请求头组装、下载队列（含续传）+ 单测 | `dart test` 全绿 | ✅ 78 用例全绿，`dart analyze` 干净 |
| **P2** | Flutter 壳 UI + 引擎适配：站点列表、添加站点、浏览页、前进后退、下载页、设置页 | 能装能跑，网页操作与浏览器一致 | ✅ 代码完成；`flutter analyze` 无 issue，真机/构建待 CI 验证 |
| **P3** | 桥接层补齐：下载三条路径、上传、外部协议、权限 | 下载能进手机/电脑本地，上传能选文件 | 🟡 已完成：三条下载路径 / 上传交引擎 / 外部协议 / 权限弹窗 / 按域名清 Cookie；未做：系统通知栏进度、每站点 profile 严格隔离、下载历史入库 |
| **P4** | 白标 CI：`workflow_dispatch` 输入 + 图标生成 + 产物命名 | 输入名字/图标/网址 → 拿到专属 APP | 🟡 代码完成，等 CI 跑通 |
| **P5** | （按需）自写 Windows WebView2 宿主，补齐 §7 的四个 ❌；每站点 profile 严格隔离 | Windows 下载/上传与 Android 一致 | ⏳ 未开始（触发条件见 §7） |

---

## 11. 明确的边界（做不到就说做不到）

- **DRM 视频**（Netflix 之类）：引擎层面就不支持，任何壳都做不到。
- **需要浏览器扩展的站点**：引擎能跑，但扩展体系没有，靠注入脚本只能补一部分。
- **HLS / `m3u8` 流媒体下载**：见 §4 路径 C，不承诺。
- **风控识别 WebView UA**：可以按站点改 UA 缓解，但不能保证 100% 绕过；不做规避风控的对抗性改动。
- **Windows 依赖 WebView2 运行时**：Win10/11 通常自带（随 Edge 更新）；没有的机器给出安装引导，
  另可提供"自带运行时"的离线包版本（体积 +150MB）。
- **Windows 的下载/上传/Basic Auth/全屏**：见 §7，四个 ❌ 是引擎限制，兜底见同表。
- **iOS / macOS / Linux**：不在交付范围。
