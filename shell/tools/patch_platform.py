#!/usr/bin/env python3
"""构建期改平台文件的小工具（Android 清单 / Windows 窗口标题与资源）。

为什么用脚本而不是一长串 sed/正则：这些文件都是 `flutter create` 现生成的，
格式会随 Flutter 版本变化。Python 里"找得到就替换、找不到就明说"比管道里的
静默替换好调试得多 —— 静默失败打出来的包会带着错误的图标名或标题，很难发现。

用法：
  patch_platform.py manifest <AndroidManifest.xml> <App 名字>
  patch_platform.py windows  <windows 目录>        <App 名字>
  patch_platform.py cmake    <windows/CMakeLists.txt>
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

# 微软在 STL1011 报错里给出的逃生宏（见 patch_windows_cmake 的说明）
_COROUTINE_SILENCE_MACRO = "_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS"


def _force_utf8_output() -> None:
    """让本脚本的中文输出在 Windows 上也能打印出来。

    Windows 上 Python 的 stdout 默认跟随控制台代码页（cp437 / cp1252），
    打印"已改："这种中文会直接抛 UnicodeEncodeError 崩掉——在 CI 里表现为
    "exit code 1、却看不到任何原因"，非常难查（本仓库真的踩过一次）。
    errors="replace" 是兜底：即便重设失败，也只是显示成问号，不会让构建挂掉。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def patch_manifest(path: str, label: str) -> None:
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")

    # release 包默认**没有** INTERNET 权限（模板只给了 debug/profile）。
    # 漏了这一步的典型症状：debug 装上去能用，release 装上去全部请求失败。
    if "android.permission.INTERNET" not in s:
        s = s.replace(
            "<application",
            '<uses-permission android:name="android.permission.INTERNET"/>\n'
            '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>\n\n'
            "    <application",
            1,
        )

    # 内网 http:// 站点（很常见）要能用；https 的安全性完全不受影响。
    if "usesCleartextTraffic" not in s:
        s = s.replace(
            "<application",
            '<application\n        android:usesCleartextTraffic="true"',
            1,
        )

    # 顺序要紧：& 必须先换，否则后面产生的 &quot; 会被二次转义成 &amp;quot;
    safe_label = label.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    s, count = re.subn(r'android:label="[^"]*"', 'android:label="%s"' % safe_label, s, count=1)
    if count == 0:
        print("警告：清单里没找到 android:label，应用名没改上", file=sys.stderr)

    p.write_text(s, encoding="utf-8")
    print("已改：", p)


# ---------------------------------------------------------------------------
# Android 下载通知 + 前台服务（构建期注入）
#
# 为什么走注入而不是加 Flutter 插件：通知要贴着下载状态机（core 的
# DownloadManager）走，而 MethodChannel + 纯平台 API 的 Notification 就够用，
# 引 local_notification / flutter_background_service 这类插件反而带一串
# 传递依赖，AGP/Gradle 两头都可能翻车。见 shell/app/lib/src/download_notifier.dart。
# ---------------------------------------------------------------------------

_KT_SERVICE = '''package {PKG}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * 下载前台服务（由 shell/tools/patch_platform.py 构建期注入）。
 *
 * 本体不承载下载（下载在 Flutter/Dart 层），职责只有两件：
 *  1. 进度通知：单一通知槽（NOTIFICATION_ID），内容随下载状态更新；
 *  2. 前台保活：活跃下载期间让系统别杀进程，全部结束后退出并把通知转成终态。
 *
 * 全部用平台 API（不用 androidx），不对脚手架依赖树做任何假设。
 */
class DownloadService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService() 启动后必须尽快 startForeground（否则 ANR）。
        // 先放一条"准备中"；真正的进度通知随后由 Dart 侧的 update 覆盖。
        startForeground(NOTIFICATION_ID, build(this, "下载", "准备中…", PROGRESS_INDETERMINATE))
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        // DETACH：通知与前台服务解绑并保留（此刻已是"完成/失败"文案，可正常滑掉）。
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_DETACH)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(false)
        }
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_ID = "webshell_downloads"
        const val NOTIFICATION_ID = 1001
        const val PROGRESS_NONE: Int = -2            // 终态：不带进度条
        const val PROGRESS_INDETERMINATE: Int = -1   // 未知大小：转圈
        const val PROGRESS_MAX: Int = 100

        @Volatile
        var running: Boolean = false

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= 26) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                    val ch = NotificationChannel(
                        CHANNEL_ID, "下载进度", NotificationManager.IMPORTANCE_LOW
                    )
                    ch.setShowBadge(false)
                    nm.createNotificationChannel(ch)
                }
            }
        }

        private fun build(context: Context, title: String, text: String, progress: Int): Notification {
            val builder = if (Build.VERSION.SDK_INT >= 26) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
            }
            builder.setContentTitle(title)
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setSmallIcon(android.R.drawable.stat_sys_download)
            when {
                progress >= 0 -> builder.setProgress(PROGRESS_MAX, progress, false)
                progress == PROGRESS_INDETERMINATE -> builder.setProgress(0, 0, true)
                else -> {} // 终态：无进度条
            }
            return builder.build()
        }

        private fun nm(context: Context): NotificationManager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        /** 活跃下载的进度更新；服务没在跑就先把它拉起来（前台保活）。 */
        fun update(context: Context, title: String, text: String, progress: Int) {
            ensureChannel(context)
            if (!running) {
                val intent = Intent(context, DownloadService::class.java)
                try {
                    if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                    else context.startService(intent)
                    running = true
                } catch (_: Exception) {
                    // 个别 ROM 起不了前台服务：退化为普通通知（保活没有，进度还在）
                    nm(context).notify(NOTIFICATION_ID, build(context, title, text, progress))
                    return
                }
            }
            nm(context).notify(NOTIFICATION_ID, build(context, title, text, progress))
        }

        /** 全部结束（完成/失败/取消）：通知转终态，服务退出。 */
        fun finish(context: Context, title: String, text: String) {
            ensureChannel(context)
            nm(context).notify(NOTIFICATION_ID, build(context, title, text, PROGRESS_NONE))
            context.stopService(Intent(context, DownloadService::class.java))
        }
    }
}
'''

_KT_BRIDGE = '''package {PKG}

import android.content.Context
import android.os.Build
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Dart ↔ 原生的下载通知桥（构建期注入）。
 * Dart 侧：MethodChannel("webshell/download_notify")，方法 progress / done / permission。
 */
object DownloadNotify {
    const val CHANNEL = "webshell/download_notify"

    fun bind(context: Context, engine: FlutterEngine) {
        MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "progress" -> {
                            DownloadService.update(
                                context,
                                call.argument<String>("title") ?: "下载",
                                call.argument<String>("text") ?: "",
                                call.argument<Int>("progress")
                                    ?: DownloadService.PROGRESS_INDETERMINATE
                            )
                            result.success(null)
                        }
                        "done" -> {
                            DownloadService.finish(
                                context,
                                call.argument<String>("title") ?: "下载结束",
                                call.argument<String>("text") ?: ""
                            )
                            result.success(null)
                        }
                        "permission" -> {
                            requestPermission(context)
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    result.error("download_notify", e.message, null)
                }
            }
    }

    /** Android 13+ 通知需要运行时权限；低版本由系统设置开关管，不用请求。 */
    private fun requestPermission(context: Context) {
        if (Build.VERSION.SDK_INT >= 33 && context is android.app.Activity) {
            if (context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                context.requestPermissions(
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 10086
                )
            }
        }
    }
}
'''

_MAIN_ACTIVITY_BODY = '''package {PKG}

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {{
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {{
        super.configureFlutterEngine(flutterEngine)
        DownloadNotify.bind(this, flutterEngine)
    }}
}}
'''


def patch_notify(manifest_path: str, kotlin_dir: str) -> None:
    """注入 Android 下载通知/前台服务的三样东西：

    1. manifest：POST_NOTIFICATIONS + FOREGROUND_SERVICE(_DATA_SYNC) 权限、
       <service android:name=".DownloadService" foregroundServiceType="dataSync"/>；
    2. Kotlin：DownloadService.kt / DownloadNotify.kt（写到 MainActivity 同目录同包）；
    3. MainActivity.kt：注册 MethodChannel（模板无体就整体重写，有体就在花括号后插）。
    """
    # --- 找 MainActivity：package 与目录都以它为准（大小写、路径点全部照抄）
    kdir = pathlib.Path(kotlin_dir)
    main_file = None
    for kt in sorted(kdir.rglob("*.kt")):
        if "class MainActivity" in kt.read_text(encoding="utf-8"):
            main_file = kt
            break
    if main_file is None:
        raise SystemExit(
            "错误：%s 下没找到含 class MainActivity 的 .kt（脚手架结构变了？），"
            "通知注入中止，请人工看一眼" % kdir
        )
    pkg_match = re.search(r"^package\s+([\w.]+)", main_file.read_text(encoding="utf-8"), re.M)
    if pkg_match is None:
        raise SystemExit("错误：%s 里读不到 package 声明" % main_file)
    pkg = pkg_match.group(1)
    target_dir = main_file.parent
    print("MainActivity：", main_file, "package =", pkg)

    # --- 1) Kotlin 文件
    (target_dir / "DownloadService.kt").write_text(
        _KT_SERVICE.replace("{PKG}", pkg), encoding="utf-8"
    )
    (target_dir / "DownloadNotify.kt").write_text(
        _KT_BRIDGE.replace("{PKG}", pkg), encoding="utf-8"
    )
    print("已写：", target_dir / "DownloadService.kt")
    print("已写：", target_dir / "DownloadNotify.kt")

    # --- 2) MainActivity：注册通道
    src = main_file.read_text(encoding="utf-8")
    if "DownloadNotify.bind" in src:
        print("MainActivity 已注册通道，跳过：", main_file)
    elif re.search(r"class MainActivity\s*:\s*FlutterActivity\(\)\s*\{", src):
        # 有类体：在第一个 { 后插 override（import 已有，不重复加）
        inject = (
            "\n    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {\n"
            "        super.configureFlutterEngine(flutterEngine)\n"
            "        DownloadNotify.bind(this, flutterEngine)\n"
            "    }\n"
        )
        if "io.flutter.embedding.engine.FlutterEngine" not in src:
            src = src.replace(
                "import io.flutter.embedding.android.FlutterActivity",
                "import io.flutter.embedding.android.FlutterActivity\n"
                "import io.flutter.embedding.engine.FlutterEngine",
                1,
            )
        src = re.sub(
            r"(class MainActivity\s*:\s*FlutterActivity\(\)\s*\{)",
            lambda m: m.group(1) + inject,
            src,
            count=1,
        )
        main_file.write_text(src, encoding="utf-8")
        print("已改（类体注入）：", main_file)
    elif "class MainActivity : FlutterActivity()" in src:
        # 模板无体形式：直接整体重写（模板就这几行，重写比正则稳）
        main_file.write_text(_MAIN_ACTIVITY_BODY.replace("{PKG}", pkg), encoding="utf-8")
        print("已改（整体重写）：", main_file)
    else:
        raise SystemExit(
            "错误：%s 的 MainActivity 不是认识的模板形状，通知注入中止，请人工看一眼" % main_file
        )

    # --- 3) manifest：权限 + service 声明
    mpath = pathlib.Path(manifest_path)
    m = mpath.read_text(encoding="utf-8")
    if "android.permission.POST_NOTIFICATIONS" not in m:
        m = m.replace(
            "<application",
            '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>\n'
            '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>\n'
            '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>\n'
            "    <application",
            1,
        )
    if "DownloadService" not in m:
        m = m.replace(
            "</application>",
            '        <service\n'
            '            android:name=".DownloadService"\n'
            '            android:exported="false"\n'
            '            android:foregroundServiceType="dataSync"/>\n'
            "    </application>",
            1,
        )
    mpath.write_text(m, encoding="utf-8")
    print("已改：", mpath)


def patch_windows(dir_path: str, app_name: str) -> None:
    d = pathlib.Path(dir_path)
    # 中文写进 C++ 源文件有编码风险（rc.exe / MSVC 对源码编码的解释并不统一），
    # 所以转成 \uXXXX 转义：源码保持纯 ASCII，运行时正确。
    escaped = "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in app_name)

    main = d / "runner" / "main.cpp"
    if main.exists():
        s = main.read_text(encoding="utf-8")
        s2, n = re.subn(r'(window\.Create\(\s*L")[^"]*(")', lambda m: m.group(1) + escaped + m.group(2), s, count=1)
        if n == 0:
            s2, n = re.subn(r'L"[^"]*"', 'L"%s"' % escaped, s, count=1)
        if n == 0:
            print("警告：main.cpp 里没找到窗口标题字面量", file=sys.stderr)
        main.write_text(s2, encoding="utf-8")
        print("已改：", main)

    rc = d / "runner" / "Runner.rc"
    if rc.exists():
        if app_name.isascii():
            s = rc.read_text(encoding="utf-8")
            for field in ("FileDescription", "ProductName"):
                s = re.sub(
                    r'(VALUE\s+"%s"\s*,\s*")[^"]*(")' % field,
                    lambda m: m.group(1) + app_name + m.group(2),
                    s,
                )
            rc.write_text(s, encoding="utf-8")
            print("已改：", rc)
        else:
            print("提示：App 名不是纯 ASCII，跳过 Runner.rc（窗口标题仍然会改）")


def patch_windows_cmake(path: str) -> None:
    """给 windows/CMakeLists.txt 注入一个编译宏，让上游插件能被新 MSVC 编过。

    真事：MSVC 14.51（VS 18）起，`/await` 与 <experimental/coroutine> 会直接硬报
    STL1011（"deprecated by Microsoft and will be REMOVED SOON"），而
    flutter_inappwebview_windows 经 WebView2 / WIL 的 cppcoro 代码还在用它们，
    于是 Windows 端在编译插件时就挂了。

    微软在报错信息里直接给了逃生门：定义
    `_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS` 即可压住。
    这里把定义加到**应用自己的** windows/CMakeLists.txt（不是去改 pub cache），
    位置紧跟 project()，这样后面 add_subdirectory 进来的各插件目标都能吃到。
    上游改用 C++20 coroutine 后，这段就只剩一个无害的宏定义。
    """
    p = pathlib.Path(path)
    if not p.exists():
        raise SystemExit("错误：找不到 %s（Windows 脚手架没生成？）" % p)
    s = p.read_text(encoding="utf-8")
    if _COROUTINE_SILENCE_MACRO in s:
        print("已有静音宏，无需改：", p)
        return

    inject = (
        "\n"
        "# === 构建期注入（CI）：见 shell/tools/patch_platform.py 同名函数 ===\n"
        "# MSVC 14.51 起 /await 与 <experimental/coroutine> 是硬错误，上游插件还在用，\n"
        "# 用微软自己给的宏压住（放在 project() 之后，插件目标才能继承到）。\n"
        "add_compile_definitions(%s)\n" % _COROUTINE_SILENCE_MACRO
    )
    # 锚点优先 project(...)：它一定在所有 add_subdirectory / generated_plugins 之前。
    for pattern in (r"^project\(.*\)\s*$", r"^cmake_minimum_required\(.*\)\s*$"):
        new, n = re.subn(pattern, lambda m: m.group(0) + inject, s, count=1, flags=re.M)
        if n:
            p.write_text(new, encoding="utf-8")
            print("已改：", p)
            return
    raise SystemExit(
        "错误：%s 里没找到 project(...) 或 cmake_minimum_required(...)，"
        "不敢盲插（Flutter 模板可能变了），请人工看一眼" % p
    )


def main() -> int:
    _force_utf8_output()
    ap = argparse.ArgumentParser(description="构建期平台文件补丁")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("manifest", help="改 AndroidManifest.xml")
    m.add_argument("path")
    m.add_argument("label")

    w = sub.add_parser("windows", help="改 Windows runner（窗口标题/资源）")
    w.add_argument("dir")
    w.add_argument("app_name")

    c = sub.add_parser("cmake", help="给 windows/CMakeLists.txt 注入 MSVC 静音宏")
    c.add_argument("path")

    n = sub.add_parser(
        "notify", help="注入 Android 下载通知/前台服务（Kotlin + manifest 权限）"
    )
    n.add_argument("manifest", help="AndroidManifest.xml 路径")
    n.add_argument("kotlin_dir", help="android/app/src/main/kotlin 目录")

    args = ap.parse_args()
    if args.cmd == "manifest":
        patch_manifest(args.path, args.label)
    elif args.cmd == "windows":
        patch_windows(args.dir, args.app_name)
    elif args.cmd == "cmake":
        patch_windows_cmake(args.path)
    elif args.cmd == "notify":
        patch_notify(args.manifest, args.kotlin_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
