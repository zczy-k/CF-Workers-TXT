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

    args = ap.parse_args()
    if args.cmd == "manifest":
        patch_manifest(args.path, args.label)
    elif args.cmd == "windows":
        patch_windows(args.dir, args.app_name)
    elif args.cmd == "cmake":
        patch_windows_cmake(args.path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
