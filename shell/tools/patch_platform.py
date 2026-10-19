#!/usr/bin/env python3
"""构建期改平台文件的小工具（Android 清单 / Windows 窗口标题与资源）。

为什么用脚本而不是一长串 sed/正则：这些文件都是 `flutter create` 现生成的，
格式会随 Flutter 版本变化。Python 里"找得到就替换、找不到就明说"比管道里的
静默替换好调试得多 —— 静默失败打出来的包会带着错误的图标名或标题，很难发现。

用法：
  patch_platform.py manifest <AndroidManifest.xml> <App 名字>
  patch_platform.py windows  <windows 目录>        <App 名字>
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys


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

    safe_label = label.replace('"', "&quot;").replace("<", "&lt;").replace("&", "&amp;")
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


def main() -> int:
    ap = argparse.ArgumentParser(description="构建期平台文件补丁")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("manifest", help="改 AndroidManifest.xml")
    m.add_argument("path")
    m.add_argument("label")

    w = sub.add_parser("windows", help="改 Windows runner（窗口标题/资源）")
    w.add_argument("dir")
    w.add_argument("app_name")

    args = ap.parse_args()
    if args.cmd == "manifest":
        patch_manifest(args.path, args.label)
    elif args.cmd == "windows":
        patch_windows(args.dir, args.app_name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
