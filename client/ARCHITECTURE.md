# CF-Workers-TXT 客户端 · 架构设计

> 目标：给 CF-Workers-TXT 做一个**不依赖浏览器**的客户端。
> **交付范围：Android App + Windows 桌面应用**（只要这两个，不做 iOS / macOS / Linux）。
> 约束：**不改 `worker.js`**，只吃现有的 `/<ADMIN_UUID>/api` 接口。
> 关键需求：**站点地址必须运行时可改**（域名/Workers 项目以后会变）。

---

## 1. 技术选型：为什么是 Flutter

"不依赖浏览器"这条是硬约束，它直接把两个最流行的方案排除掉了：

| 方案 | 渲染层 | 判定 |
| --- | --- | --- |
| **Electron** | 自带 Chromium | ❌ 本质就是一个浏览器，包体 100MB+ |
| **Tauri** | 系统 WebView（Windows=WebView2、macOS=WKWebView、Linux=WebKitGTK） | ❌ 依赖系统浏览器内核；Windows 上还要用户预装 WebView2 运行时；三平台渲染行为还不一致 |
| **Flutter** | 自带 Impeller / Skia，**完全不碰 WebView** | ✅ 选定（我们要 Android + Windows，一套码两个端） |
| Compose Multiplatform | 原生绘制 | ⚠️ 备选。桌面端是 JVM 目标，iOS 需 Swift 导出，Markdown/代码高亮生态与 CI 成熟度都不如 Flutter |
| .NET MAUI | WinUI3 / 原生控件 | ⚠️ 备选。iOS/macOS 必须在 macOS runner 上构建，工具链更重 |
| React Native | 原生控件 + JS 引擎 | ⚠️ 手机端成熟，但 Windows/macOS 端（rn-windows / rn-macos）维护状态差，四平台一码的目标达不成 |

选 Flutter 的三个实际理由，都对应这个项目的具体处境：

1. **一份代码同时出 Android 和 Windows**。而我们**只要这两个**，所以几乎没有"为多平台付出的额外成本"—— 反过来，如果只做 Windows，Flutter 相对 WPF/WinUI 的唯一优势（跨端）就没了，那时直接用 .NET 更省事。既然手机端也要，Flutter 是唯一"一套码覆盖这两个端"的成熟选择。
2. **自带渲染引擎，两端像素一致**。Windows 上有大量高 DPI 屏幕，用 WPF/WinUI 要额外处理缩放；Flutter 的 Impeller 在 Android 和 Windows 上输出一致，同一个目录树/编辑器布局不用写两遍。
3. **中文与自定义字体可控**。Windows 上默认取微软雅黑，Android 取思源黑体；要绝对一致就 bundle 一份 Noto Sans SC（约 8MB，可选）。
4. **能在 GitHub Actions 上全自动出包**：Android 用 `ubuntu-latest` + `flutter build apk`，Windows 用 `windows-latest` + `flutter build windows`，**都不需要 Mac**，也不需要签名证书（APK 可以自签，Windows 出便携 zip 免签名）。

> 顺带说明为什么 Windows 端不选 WPF/WinUI 或 Electron：Electron 是浏览器（见上表）；
> 而单做 Windows 的话 WPF 确实更轻，但**这份代码要同时喂给 Android**，两端各写一套 UI
> 的维护成本远大于 Flutter 的体积代价（Windows 包约 30-40MB，可接受）。

### 唯一一处"原生做不到"的地方：HTML 预览

网页端能把上传的 `.html` 塞进沙箱 iframe 渲染（`?doc=1` + CSP 三道闸）。**原生 App 没有 iframe**，这是个绕不开的取舍：

| 处理方式 | 说明 |
| --- | --- |
| **默认：显示源码**（推荐） | 复用客户端的代码高亮查看器，安全、跨平台一致 |
| 可选：交给系统浏览器打开 | `url_launcher` 打开远端 `/s/<token>/x.html`，把风险与渲染都交给浏览器 |
| 可选（不建议默认开）：`webview_flutter` | 只用于预览面板，等于局部引入浏览器内核；与"不依赖浏览器"的初衷冲突，做成设置项且默认关闭 |

**其它所有类型（Markdown / JSON / CSV / 代码 / 图片 / 音视频 / PDF）都能纯原生渲染，不需要浏览器。**

---

## 2. 两层结构：core（纯 Dart） + app（Flutter）

```
client/
├── core/                        # 纯 Dart 包：零第三方依赖，`dart test` 可跑
│   └── lib/
│       ├── cfwtxt_core.dart     # 唯一出口
│       └── src/
│           ├── config.dart      # ServerConfig：站点地址解析 / 规范化 / 持久化格式
│           ├── errors.dart      # ApiException（含 needPw / noPwSet / pwFor 语义）
│           ├── transport.dart   # 传输层抽象 + dart:io 实现（含流式上传/下载/进度）
│           ├── models.dart      # 所有响应模型（不可变 + fromJson）
│           ├── session.dart     # 认证：表单登录拿 Cookie、401 自动重登、Cookie 持久化
│           ├── api.dart         # 全部 action 的类型化封装
│           ├── rate_limit.dart  # 令牌桶 + 429/Retry-After 退避
│           ├── state_store.dart # 本地状态（同步基线、清单缓存）
│           └── sync.dart        # pull / push 增量同步引擎
└── app/                         # Flutter UI（手机 + 桌面共用状态，仅布局分叉）
    └── lib/
        ├── main.dart
        └── src/
            ├── app_state.dart           # ChangeNotifier 全局状态（无第三方状态库）
            ├── pages/setup_page.dart    # 首启向导 + 站点管理 + 设置
            ├── pages/home_page.dart     # 目录树 + 列表（桌面双栏 / 手机抽屉）
            ├── pages/editor_page.dart   # 编辑器（自动保存 + 发布/撤回）
            ├── pages/search_page.dart   # 全文搜索
            ├── pages/shares_page.dart   # 分享管理
            └── widgets/entry_tile.dart
```

**为什么必须分层**：这个客户端的难点 90% 在网络层 —— Cookie 登录、无 Range 的断点续传、分片上传、每分钟 240 次限流、`d/` 与 `__pub__/` 两棵树的发布语义。把这些放进纯 Dart 包，就能在 CI 里用**不装模拟器的单测**覆盖掉最危险的部分；UI 只是壳，将来崩了换掉不影响业务逻辑。

---

## 3. 站点地址：运行时可改（核心需求）

### 3.1 用户填什么

网页端的"管理入口"就是 `https://<域名>/<ADMIN_UUID>`。客户端不应该逼用户拆成两格填，所以**接受任意一种形式**：

| 用户输入 | `baseUrl` | `adminUuid` |
| --- | --- | --- |
| `https://mysite.workers.dev/a1b2c3d4` | `https://mysite.workers.dev` | `a1b2c3d4` |
| `mysite.workers.dev/a1b2c3d4` | `https://mysite.workers.dev` | `a1b2c3d4` |
| `https://txt.example.com/secret-path/`（尾斜杠） | `https://txt.example.com` | `secret-path` |
| `https://mysite.workers.dev`（只有域名） | `https://mysite.workers.dev` | 需再填一次 |

解析规则（见 `core/lib/src/config.dart`）：

1. 没有 `://` 就补 `https://`（Cloudflare 上不可能有 http 站点）。
2. 取 path 里的**非空段**：最后一段 = `adminUuid`，其余丢掉（`ADMIN_UUID` 预期是单段）。
3. `baseUrl` 只保留 scheme + host（丢弃 query/fragment/端口以外的全部 path）。
4. **不预先校验 `adminUuid` 的字符集** —— 用户可能填错，让服务端回 404 更直观。

### 3.2 多站点档案

```jsonc
{
  "version": 1,
  "activeId": "site_1",
  "sites": [
    {
      "id": "site_1",
      "label": "我的文本盘",          // 用户起的名字，用于切换
      "baseUrl": "https://mysite.workers.dev",
      "adminUuid": "a1b2c3d4",
      "hasPassword": true
    }
  ]
}
```

- **密码不落进这个文件**：`hasPassword` 只是个布尔标记。真正的令牌是登录后拿到的 Cookie，存进平台安全存储（Android Keystore / iOS Keychain / Windows DPAPI，用 `flutter_secure_storage`）。
- 每个站点有独立的 Cookie 与本地缓存目录（`<appData>/cfwtxt/<siteId>/`），互不污染。
- **换域名不需要重装**：改 `baseUrl` 即可，`adminUuid` 与密码都还在。

---

## 4. 认证：为什么只走表单登录

服务端的登录态是一个 Cookie：

```
wbauth = sha256(PASSWORD + '::' + ADMIN_UUID)
验证：cookie.match(/(?:^|;\s*)wbauth=([^;]+)/)[1] === 期望值
```

客户端有两条路：

| 路线 | 做法 | 评价 |
| --- | --- | --- |
| A. 本地派生 | 自己算 `sha256(密码::ADMIN_UUID)`，直接塞 `Cookie` 头 | 省一次往返，但**把服务端实现细节焊死进客户端**。服务端改哈希算法/加盐/换 token 方案 → **所有已发布的 App 全挂**，且用户无法自救（只能用网页版） |
| B. **表单登录**（选定） | `POST /<ADMIN>?action=login`，body 是 `application/x-www-form-urlencoded` 的 `password=xxx`，从 302 响应的 `Set-Cookie` 里取出 `wbauth` | 多一次请求，但**只依赖公开行为**。服务端怎么变都跟着走 |

选 B。客户端不是浏览器，但**完全能吃表单**（`formData()` 对任何 HTTP 客户端都成立），所以这个"妥协"没有任何实现代价。

### 4.1 登录流程

```
ensureSession():
  if password == null:                        # 站点没设 PASSWORD
      return                                  # 服务端不鉴权，直接放行
  if cookie == null or expired:
      POST {base}/{admin}?action=login
      headers: Content-Type: application/x-www-form-urlencoded
      body:    password=<urlencoded>
      followRedirects = false                 # 必须关掉，否则读不到 302 的 Set-Cookie
      → 302 + Set-Cookie: wbauth=...   ⇒ 提取并保存
      → 401                           ⇒ 密码错，抛 ApiException("密码错误")
      → 429                           ⇒ 失败次数过多（服务端 10 分钟锁 8 次），如实提示
```

### 4.2 401 自愈

任何请求收到 `401` 时，**自动清 Cookie → 重新登录 → 原请求重放一次**（只重放一次，避免死循环）。这一层在 `transport` 与 `api` 之间做成拦截器，业务代码永远不用管登录态。

### 4.3 CSRF 与限流：正好对我们有利

- 服务端只在 `Origin` 头存在且跨站时拒绝写操作。**原生客户端默认不发 `Origin`** → 天然通过，不需要任何额外处理。
- 通用限流默认 **240 次/分钟/IP**；**管理端的 PUT/POST/DELETE 不计入**（上传文件夹会一次发几十上百个请求，属于正常使用）。
- 但 `GET` 类的批量下载/读取**会计入** 240/min。所以客户端的批量操作必须有并发闸门（默认 4）与 429 退避，见 §6。

---

## 5. 接口映射表（客户端能力 ↔ 服务端 action）

全部挂在 `{baseUrl}/{adminUuid}/api` 下。**服务端一行都不用改。**

### 5.1 读取（GET，`?action=`）

| action | 参数 | 客户端用途 |
| --- | --- | --- |
| `list` | `path,pageSize,cursor,sort,desc` | 单层目录列表（排序/分页由服务端做） |
| `tree` | `path` | 单层子目录（懒加载树，兼容用） |
| `treeFull` | — | **一次拿整棵树**（含每层子项数与体积）→ 客户端侧栏 |
| `manifest` | `path` | **递归清单** `[{p,s,m,t}]`，上传前比对 + 同步引擎的 ground truth |
| `search` | `q,ftype,limit,offset` | 全文搜索（索引在 R2，服务端算） |
| `idxstat` | — | 索引状态（"已索引 N 个文件"） |
| `deepsearch` | `path,q` | 单文件深搜，**带行号** → 客户端可跳转到行 |
| `read` | `path` | 文本正文（服务端已做 GBK/Big5 编码识别；**上限 2MB**） |
| `download` | `path` | 原字节 + `attachment` |
| `raw` | `path` | 原字节 + 真实 `Content-Type`（图片/音视频/PDF 预览用） |
| `packList` | `path` | 递归清单（客户端本地打 zip 用） |

### 5.2 写入

| 方法 | 路径/body | 说明 |
| --- | --- | --- |
| `PUT` | `?path=` + 原始字节；头 `Content-Type`、`X-File-Mtime` | 写文件（上传/保存文本）。**`X-File-Mtime` 一定要带**，服务端存进 `customMetadata.mtime`，`manifest` 会回传它 —— 这是同步判断"文件变没变"的依据 |
| `DELETE` | `?path=&type=dir&password=` | 删文件/目录（受保护区需密码；返回 `needPw`） |
| `POST` | JSON body `{action:...}` | 见下 |

`POST` 的动作全集：

| action | 用途 |
| --- | --- |
| `mkdir` | 建目录（可带 `protected:true`） |
| `rename` | 改名（`path,newName,isDir`） |
| `move` | 移动（`path,toDir,newName,isDir,password`） |
| `deleteBatch` / `moveBatch` | 批量（`items:[{path,isDir}],password`） |
| `share` | 建分享（`path,token?,expiresIn`）→ 返回 `url` |
| `shares` | 分享列表（含 `published` / `synced`） |
| `unshare` / `unshareAll` | 取消分享 |
| `publish` / `unpublish` | **发布 / 撤回**（本产品的核心语义，客户端必须暴露） |
| `pubState` | 查"再发布一次会不会有变化"（`states:{path:bool\|null}`） |
| `publishAll` | 存量分享一键补发 |
| `setProtected` | 上锁（免密）/ 解锁（要密码） |
| `reindex` | 分批重建索引（循环调用到 `done:true`） |
| `mpCreate` / `mpPart` / `mpComplete` / `mpAbort` / `mpList` | 分片上传（大文件）。`mpPart` 是 **POST + 查询参数 + 原始字节 body**，不是 JSON |

---

## 6. 传输层的硬约束（决定了客户端能做什么）

这几条是设计时必须知道的，全部来自服务端实现：

| 约束 | 影响 | 客户端的应对 |
| --- | --- | --- |
| **不支持 Range**（`read`/`download`/`raw` 都是整包返回） | 下载中断只能**从头再来**，不能续传 | 1) 流式写盘，不要 `readAsBytes` 进内存；2) 写 `.part` 临时文件；3) 重试时整包重下并**如实提示"需要重下"**；4) 想真续传就得改服务端（本期不做） |
| `read` 上限 **2MB** | 编辑器打不开大文件 | >2MB 走 `download` 落盘 + 系统编辑器打开；编辑器中明确提示 |
| `deepsearch` 上限 **4MB** | 大文件搜不了正文 | 客户端自己落盘后本地搜 |
| 大文件只能走 **分片上传**（8MB/片） | 单次 PUT 传超大文件容易断 | 阈值 8MB：超过就走 `mpCreate/mpPart/mpComplete`，3 片并发，`mpList` 支持**断点续传**（服务端 KV 存了已传分片） |
| 通用限流 **240 次/分钟/IP**（默认） | 批量下载/读取会被 429 | 令牌桶（默认 4 并发、240/min）+ 读 `Retry-After` 指数退避 |
| `packList` 上限 300 文件 / 200MB / 1000 目录 | 大批量打包会被截断 | 客户端本地打 zip（store 模式），并**如实展示"已截断"** |
| `search` 每页最多 200 条 | 结果分页 | 客户端做"加载更多"，`offset` 累加 |
| `publish` 目录上限 500 对象 | 大目录发布会失败 | 客户端提前按 `packList`/`manifest` 计数，超限时明确报错而不是静默失败 |

---

## 7. 同步引擎（pull / push）

同步的**唯一判据是 `manifest` 的 `(size, mtime)`**，不是"上传时间"。因为 `PUT` 会带上 `X-File-Mtime`，服务端把原文件的修改时间存了下来，所以**往返一圈 mtime 不丢** —— 这让"内容没变就不同步"变得可靠。

### 7.1 本地状态（`state_store.dart`）

```
<appData>/cfwtxt/<siteId>/
├── config.json                 # 站点档案（不含密码）
├── remote-manifest.json        # 上次拉到的远端清单 {path: {s, m}}
├── sync-baseline.json          # 同步基线 {localRel: {remotePath, s, m}} —— "上次双方一致的快照"
├── files/<相对路径>             # 已下载/已同步的文件
└── parts/<uploadId>.json       # 未完成的分片上传（配合服务端 mpList 续传）
```

`sync-baseline.json` 是**判断冲突的关键**：只有它才能区分"本地改了"和"远端改了"。

### 7.2 pull（远端 → 本地）

```
1. GET manifest（递归）
2. 对每条远端 entry：
     baseline 里没有                       → 新增，下载
     baseline 有但 (s,m) 变了              → 远端变了：
         本地文件 (s,m) 也 != baseline     → ⚠️ 冲突 → 按策略处理
         否则                              → 下载覆盖
3. baseline 里有、manifest 里没有         → 远端删了 → 本地删除（可配置为移入 .trash/）
4. 更新 baseline 与 manifest
```

### 7.3 push（本地 → 远端）

```
1. 遍历本地目录，算 (size, mtime)
2. 与 baseline 比对，挑出"新增 / 已改"
3. 冲突检测同上（参照 manifest 里的远端 mtime）
4. 上传：< 8MB 走 PUT；>= 8MB 走分片（可续传）
5. 成功后把 metadata 写进 baseline
```

### 7.4 冲突策略（设置项）

| 策略 | 行为 |
| --- | --- |
| `keepBoth`（默认） | 本地改名留一份（`x (本机冲突 2026-10-19).txt`），另一份按远端覆盖，两份都不丢 |
| `preferLocal` | 本机优先，直接覆盖远端 |
| `preferRemote` | 远端优先，本地被覆盖 |
| `skip` | 记进冲突清单，交给用户手动处理 |

**绝不做"静默覆盖"** —— 这是个人文本盘，丢一个字用户都会恨你。

---

## 8. GitHub Actions 构建（只要两个平台）

`.github/workflows/client-build.yml`：

| Job | Runner | 产物 | 说明 |
| --- | --- | --- | --- |
| `test-core` | ubuntu-latest | — | `dart test` 跑 core 的纯单测（不需要模拟器，秒级） |
| `android` | ubuntu-latest | `cfwtxt-android.apk` | **自签 release APK**，直接侧载安装；也可出 AAB 上架 |
| `windows` | windows-latest | `cfwtxt-windows.zip` | 便携版（解压即用），免签名 |

四个实践要点：

1. **`test-core` 必须独立且先跑**。core 是纯 Dart，`dart test` 几秒钟出结果，能在编译 Flutter 之前就把 URL 解析 / 认证 / API 封装的逻辑错误挡掉 —— 而 Flutter 编译（尤其 Windows）要几分钟，别浪费那个时间。
2. **Android 签名**：release APK 必须签名，否则装不上。在仓库 Secrets 里放 `KEYSTORE_BASE64` / `KEY_ALIAS` / `KEY_PASSWORD` / `STORE_PASSWORD` 四个值，CI 里 `base64 -d` 还原 keystore 再 `flutter build apk --release`。**没配 Secrets 时退化为 Debug 构筑**（照样能装，只是体积大一点）—— 这样仓库刚建好、Secrets 还没填的时候 Action 也不会红。
3. **Windows 上要先开桌面支持**：`flutter config --enable-windows-desktop`。产物在 `build/windows/x64/runner/Release/`，把整个目录压成 zip 才是可用的便携版（**只拷 exe 会缺 `flutter_windows.dll` 和 `data/`**，这是新手最常踩的坑）。
4. **两个平台都不需要 Mac、不需要代码签名证书**，所以整套流水线完全可以白嫖 GitHub 免费额度跑通。

---

## 9. 明确不做的事（以及为什么）

| 不做 | 原因 |
| --- | --- |
| 本地全文索引 | 服务端已经有 R2 索引 + 补扫兜底（"索引只是加速层，R2 才是真相"）。客户端再建一份只会不同步 |
| iOS / macOS / Linux 端 | 本期只要 Android + Windows。Flutter 以后要加也就几行 CI，但现在不写、不测、不承诺 |
| 下载断点续传 | 服务端不支持 `Range`。要做得先改 `worker.js`，本期约束是不改 |
| 分享页的网页浏览 | 那本来就是给访客的只读 HTML 页，浏览器打开最合适。客户端只做**管理**分享（建/查/发布/撤回） |
| HTML 文件的沙箱渲染 | 原生没有 iframe。默认显示源码；想渲染就交给系统浏览器（见 §1） |
| 把 `PASSWORD` 存进 config.json | 令牌存平台安全存储；配置文件里只有 `hasPassword` 布尔标记 |

---

## 10. 落地顺序建议

1. **core + 单测**（本文档已给出实现）：`dart test` 在 CI 里跑通 —— 认证、URL 解析、API 封装、限流退避
2. **Flutter 壳**：首启向导（站点地址）→ 目录浏览 → 编辑器（自动保存 + 发布）
3. **分享管理 / 搜索**：把网页端的既有能力补齐
4. **同步引擎 UI**：选定本地目录 → pull/push，带冲突清单
5. **打包分发**：Action 出 APK + Windows zip 两个构件
