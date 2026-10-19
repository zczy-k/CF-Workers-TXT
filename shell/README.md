# 万能壳（WebShell）—— 使用与构建

把**任意网站**装进一个自己的 Android / Windows App 里：翻页、登录、上传、下载都和浏览器一样，
而且下载直接落到本机。不依赖用户装没装浏览器（用的是系统自带的网页引擎：Android WebView / Windows WebView2）。

设计取舍、能力矩阵、平台限制的来龙去脉都在 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，本文只讲**怎么用**。

---

## 一、用户拿到的 App 长什么样

| 版本 | 启动后看到 | 用户还能做什么 |
| --- | --- | --- |
| **通用壳** | 站点列表（空的），点"添加站点"输网址 | 想加多少站点加多少，每个站点独立保存 Cookie，等同于一个"多站点浏览器 + 全功能下载器" |
| **白标版** | 直接是那个网站（名字、图标、主题色都是它的） | 默认站点固定，但设置里**仍然可以再加别的站点**（除非构建时把 `allow_add_site` 关掉） |

两种产物是**同一份代码**，白标版只是构建时覆盖了 `assets/preset.json` 和图标，不是另开一套分支。

App 的主界面：
- **首页**：站点卡片列表（长按可编辑名称/地址/请求头/Basic Auth、换图标、清登录态、删除）；
- **浏览页**：网页 + 顶栏（标题/地址、刷新、更多）+ 底栏（后退/前进/回到首页/下载）；
- **下载页**：进度、暂停/继续/取消/重试、打开文件、另存为、在文件夹中显示、路径可复制；
- **设置页**：同时下载数、下载位置、省流（不加载图片）、清空 Cookie、清空下载记录。

---

## 二、出包

### A. 通用壳（不用填任何东西）

改 `shell/` 下的代码并 push 到 `main`（或对 `shell/**` 发 PR），`shell-build` 流水线自动跑，
产物在 Actions 那次运行的 **Artifacts** 里：

- `webshell-android-apk` → `webshell-<包名>-<构建号>.apk`
- `webshell-windows-x64` → `webshell-windows-<包名>.zip`

> GitHub 的 Actions 日志和产物**必须登录**才能看/下。

### B. 白标版（手动填参数）

仓库 **Actions → shell-build → Run workflow**，填下表后运行。只有这条入口能带参数。

| 输入 | 留空时 | 说明 |
| --- | --- | --- |
| `app_name` | `WebShell` | App 显示名。安卓桌面图标名、Windows 窗口标题都用它。**可以中文** |
| `app_id` | `dev.webshell.app` | 包名/应用 ID，如 `com.corp.oa`。最后一段会规整成合法标识符（小写、字母数字下划线、不以数字开头），Windows 的 exe 名也取自这一段 |
| `preset_url` | 无预置站点（= 通用壳） | 预置站点入口，如 `oa.corp.com`、`http://192.168.1.10:8080`。只写域名会自动补 `https://` |
| `preset_name` | 用域名 | 预置站点在列表里显示的名字 |
| `theme_color` | `#2962FF` | 主题色，`#RRGGBB` |
| `logo_url` | 自动（见下） | 图标图片地址（PNG/JPG/ICO）。⚠️ 必须是**直链**，不能是网页 |
| `logo_path` | 自动（见下） | 仓库里的图标文件路径。先把图片提交到仓库，再填 `shell/branding/logo.png` |
| `auto_icon` | 开 | 没给图标时，抓预置站点的 `apple-touch-icon` / `favicon.ico` / `favicon.png` |
| `allow_add_site` | 开 | 白标版是否允许用户自己再加站点 |

三个常见用法：

1. **只要一个专属 App**：`app_name=公司OA`、`app_id=com.corp.oa`、`preset_url=oa.corp.com`、`theme_color=#0B6BCB`
2. **用自己的图标**：再填 `logo_url=https://cdn.corp.com/logo.png`（或把图片提交进仓库后填 `logo_path`）
3. **内网 http 站点**：`preset_url=http://192.168.1.10:8080` —— 已经默认允许明文 http，不用额外配置

### 图标是怎么定的（优先级从高到低）

1. `logo_path` 指定的仓库文件；
2. `logo_url` 下载的图片；
3. `auto_icon=true` 且给了 `preset_url`：抓站点自己的 `apple-touch-icon.png` / `apple-touch-icon-precomposed.png`
   / `favicon.ico` / `favicon.png`；
4. 都没有：用 App 名（或域名）的首字母 + 主题色画一个。

第 4 条是刻意的：**永远不会打出没有图标的包**。生成的是 Android 五档 `mipmap` + 自适应图标
（前景按 2/3 缩进安全区）+ 多尺寸 Windows `.ico`。

> 想换图标又懒得重新出包：Android 端卸载重装才会刷新桌面图标（系统缓存，不是 bug）。

### 签名（重要）

CI 打的是 **debug keystore 签名**的 release 包，能侧载安装、能正常使用，但**不能上架应用商店**，
而且和别的机器打的同包名包互相覆盖安装会失败。要正式签名：把 keystore 放进仓库 Secrets，
在生成的 `android/app/build.gradle(.kts)` 里加 `signingConfigs` 并让 `release` 用它
（这几行得在 `shell-build.yml` 的 Android job 里加，因为 `android/` 是 CI 现生成的）。

---

## 三、本机开发

```bash
# 纯逻辑（秒级，78 个用例）
cd shell/core && dart pub get && dart test

# 壳 App（需要 Flutter 3.44+）
cd shell/app && flutter pub get
flutter run -d windows      # 或 -d <安卓设备>
```

注意两点：

- **`shell/app/android/` 和 `shell/app/windows/` 不在仓库里**，需要在本地生成一次：
  在 `shell/app` 下跑 `flutter create --platforms=android,windows --org dev.webshell --project-name webshell .`
  （CI 也是这么做的；仓库只保留 `lib/` 作为唯一真相源）。
- **静态分析的 flag 不一样**：`dart analyze` 从 Dart 3.13 起**不能**传 `--no-fatal-infos`（传了直接退出 64），
  而 `flutter analyze` 默认把 info 也算致命，必须传 `--no-fatal-infos --no-fatal-warnings`。
  两边 CI 都按这个写了，本地跟着来就不会被"假报错"骗。

Windows 上跑还需要 **WebView2 运行时**（Win10/11 通常随 Edge 自带；没有的话装一次
[Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)）。
本机 `flutter build windows` 还要求装了 **Visual Studio（含 C++ 桌面负载）** 和 CMake 用的 **nuget**。

---

## 四、功能清单（对"残废壳"的逐条对照）

| 能力 | 状态 |
| --- | --- |
| 网页里能做的操作（翻页、表单、SPA、POST 跳转） | ✅ 导航不拦，只把非 http(s) 协议交给系统 |
| `target="_blank"` / `window.open` | ✅ 在同一个视图里打开（不是"点了没反应"） |
| 普通文件下载（带 Cookie / UA / Referer / 自定义头） | ✅ 自己的下载器，断点续传、暂停/继续/取消/重试 |
| 前端生成的文件（`blob:` / `data:`）下载 | ✅ 注入脚本分片 + 消息桥落盘 |
| 长按链接下载 / 复制 / 交给系统浏览器 | ✅ |
| 上传（`<input type=file>`、多选、相机、Windows 拖拽） | ✅ 引擎原生选择器 |
| 下载落点 | ✅ Android 到 `Android/data/<包名>/files/Download`（免存储权限），"另存为"走系统选择器；Windows 默认 `下载\WebShell`，可改任意目录 |
| 打开下载好的文件 / 在文件夹中显示 | ✅ Android 交给系统关联应用；Windows 用资源管理器 |
| 登录状态保持 | ✅ Cookie 存在 App 自己的 profile 里，重启仍在 |
| 每个站点单独的登录态清理 | ✅ 按域名清 Cookie，不影响别的站点 |
| 自定义 UA / 自定义请求头 / Basic Auth | ✅ 密码进系统安全存储（Keystore / DPAPI），不进配置文件 |
| 网页权限（摄像头/麦克风/定位） | ✅ 弹框询问；非 https 直接拒 |
| 站点图标 | ✅ 自动抓 favicon / apple-touch-icon，抓不到用首字母 |
| 省流模式（不加载图片）、同时下载数 | ✅ 设置页可调 |
| 流媒体（`m3u8` / 分片）下载 | ❌ 不承诺，请用专门的下载工具 |
| 系统通知栏下载进度 | ❌ 未做（进度在 App 内下载列表 + 角标） |
| 每站点 profile 严格隔离（多进程/独立数据目录） | ❌ 未做：目前共用一份 profile，按域名清 Cookie；见 ARCHITECTURE §6 |
| Windows 的下载拦截 / 上传对话框 / Basic Auth / 全屏事件 | ⚠️ 引擎不提供：下载与全屏有注入脚本兜底，Basic Auth 等第二步自写 WebView2 宿主 |
| iOS / macOS / Linux | ❌ 不在范围 |

---

## 五、排错

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| 装完还是旧图标 | 系统桌面图标缓存 | 卸载重装；安卓换图标必须重装 |
| Windows 端窗口打不开 / 白屏 | 缺 WebView2 运行时 | 装 Evergreen Runtime；或确认系统 Edge 是新的 |
| release APK 里所有请求都失败 | 安卓模板的 release 清单**默认没有** INTERNET 权限（只有 debug/profile 有） | 流水线已自动加上；如果你手动改过清单，检查这一条 |
| 下载全部 403 / 下到的是登录页 | 少带了 Cookie / UA / Referer | 确认站点是先从 App 内登录的（不是系统浏览器）；必要时在该站点设置里配 UA 或请求头 |
| 某个按钮点了没反应 | 站点用了 `window.open`、`blob:` 或特殊协议 | 已在引擎回调里覆盖；仍有问题请附网址反馈 |
| Windows 构建报找不到 `nuget` / 拉 WebView2 SDK 失败 | 插件在 CMake 阶段要拉 nuget 包 | 流水线已确保 nuget 可用；网络抖动重跑一次 |
| CI 里 `dart analyze --no-fatal-infos` 报 "Cannot negate option" | Dart 3.13 起该选项已移除 | 别传它（本仓库的流水线已修正） |
| 看不到 CI 日志 / 下不了产物 | 未登录 | 登录 GitHub 后看 Actions |

---

## 六、用到的依赖（及为什么是它）

| 依赖 | 用途 | 为什么选它 |
| --- | --- | --- |
| `flutter_inappwebview ^6.1.5` | 两端引擎（Android WebView / Windows WebView2） | 6.x 是目前唯一在两端都暴露"下载事件 / 文件选择 / 新窗口 / Cookie / 注入脚本"的插件——这几项正是"残废壳"缺的东西 |
| `path_provider` | 应用私有目录、Android 外部目录 | 官方维护，Android/Windows 都有实现 |
| `url_launcher` | `tel:` / `mailto:` / 交给系统浏览器 | 同上 |
| `file_picker ^13.1.0` | Windows 选目录 | 版本必须 ≥12（Windows 实现要 `win32 ^6`），且与 `flutter_secure_storage ^11` 同升，否则 win32 冲突 |
| `flutter_file_dialog ^3.3.3` | Android "另存为"（系统 SAF 选择器） | 不需要存储权限就能写用户选的目录 |
| `open_filex ^5.0.0` | Android 打开下载好的文件 | 只支持 Android/iOS；Windows 端用 `explorer.exe` 自己实现 |
| `flutter_secure_storage ^11.2.0` | Basic Auth 密码 | 走 Keystore / DPAPI，密码不落明文文件 |

---

## 七、文件一览

| 路径 | 作用 |
| --- | --- |
| `shell/core/` | 纯 Dart 核心（站点档案、配置持久化、URL 规则、请求头、下载队列），`dart test` 78 用例 |
| `shell/app/lib/src/pages/` | 首页 / 浏览页 / 站点设置 / 下载 / 设置 |
| `shell/app/lib/src/engine/scripts.dart` | 注入脚本（blob 导出、补请求头、长按、全屏兜底） |
| `shell/app/lib/src/state.dart` | 接线层：配置落盘、下载队列接引擎 Cookie/UA、blob 通道、密码安全存储 |
| `shell/app/assets/preset.json` | 通用壳默认值；白标构建时被 CI 覆盖 |
| `shell/tools/branding.sh` | 生成各平台图标 + `preset.json`（ImageMagick） |
| `shell/tools/patch_platform.py` | 改 Android 清单 / Windows 窗口标题 |
| `.github/workflows/shell-build.yml` | `test-core → branding → android / windows` |
