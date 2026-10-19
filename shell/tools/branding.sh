#!/usr/bin/env bash
# 白标产物生成：图标（Android 各密度 + 自适应图标 + Windows .ico）与 preset.json。
#
# 为什么要放在 CI 里做：图标要按 5 档密度切、还要转多尺寸 .ico，本机得先装 ImageMagick；
# 而 GitHub 的 ubuntu runner 自带 ImageMagick，一条命令就能出全套，
# 打出来的两个平台包图标完全一致。
#
# logo 三种来源，优先级从高到低：
#   1) LOGO_PATH           仓库里的图片文件（例如 shell/branding/logo.png）
#   2) LOGO_URL            一个图片地址（PNG / JPG / ICO 都行）
#   3) AUTO_ICON=true 且给了 PRESET_URL
#                          抓站点自己的 apple-touch-icon / favicon.ico / favicon.png
#   4) 都没有              用站点名/App 名的首字母画一个
# 第 4 条是刻意的：永远有图标，绝不会打出"没有图标"的包。
#
# 用法（在仓库根目录）：
#   APP_NAME='公司 OA' APP_ID=com.corp.oa PRESET_URL=oa.corp.com bash shell/tools/branding.sh out
set -euo pipefail

OUT_DIR="${1:-branding-out}"
APP_NAME="${APP_NAME:-WebShell}"
APP_ID="${APP_ID:-dev.webshell.app}"
PRESET_URL="${PRESET_URL:-}"
PRESET_NAME="${PRESET_NAME:-}"
THEME_COLOR="${THEME_COLOR:-#2962FF}"
LOGO_URL="${LOGO_URL:-}"
LOGO_PATH="${LOGO_PATH:-}"
AUTO_ICON="${AUTO_ICON:-true}"
ALLOW_ADD_SITE="${ALLOW_ADD_SITE:-true}"

if command -v magick >/dev/null 2>&1; then IM="magick"; else IM="convert"; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

say() { printf '%s\n' "---- $*"; }

# ---------------------------------------------------------------- App 标识
# Android 包名的最后一段必须是合法标识符（Flutter 拿它当 Dart 包名用），
# 所以这里做一次规整，并把最终生效的值写出来给后面的构建 job 用。
ORG_PART="${APP_ID%.*}"
NAME_PART="${APP_ID##*.}"
if [ "$ORG_PART" = "$APP_ID" ] || [ -z "$NAME_PART" ] || [ -z "$ORG_PART" ]; then
  ORG_PART="dev.webshell"
  NAME_PART="webshell"
fi
NAME_PART="$(printf '%s' "$NAME_PART" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_]+/_/g; s/^([0-9])/_\1/')"
[ -n "$NAME_PART" ] || NAME_PART="webshell"
case "$NAME_PART" in
  abstract|as|assert|async|await|break|case|catch|class|const|continue|default|deferred|do|dynamic|else|enum|export|extends|extension|external|factory|false|final|finally|for|function|get|hide|if|implements|import|in|interface|is|library|mixin|new|null|on|operator|part|required|rethrow|return|set|show|static|super|switch|sync|this|throw|true|try|typedef|var|void|while|with|yield)
    NAME_PART="app_${NAME_PART}" ;;
esac
APP_ID_EFFECTIVE="${ORG_PART}.${NAME_PART}"
say "包名：$APP_ID_EFFECTIVE（组织 $ORG_PART / 名称 $NAME_PART）"

# ---------------------------------------------------------------- 1) 找源图
SRC=""
if [ -n "$LOGO_PATH" ] && [ -f "$LOGO_PATH" ]; then
  SRC="$LOGO_PATH"
  say "图标来源：仓库文件 $LOGO_PATH"
elif [ -n "$LOGO_URL" ]; then
  if curl -fsSL --max-time 30 "$LOGO_URL" -o "$WORK/logo-src"; then
    SRC="$WORK/logo-src"
    say "图标来源：$LOGO_URL"
  else
    say "图标 URL 下载失败，继续往下找"
  fi
fi

if [ -z "$SRC" ] && [ "$AUTO_ICON" = "true" ] && [ -n "$PRESET_URL" ]; then
  BASE="$PRESET_URL"
  case "$BASE" in
    *://*) ;;
    *) BASE="https://$BASE" ;;
  esac
  ORIGIN="$(printf '%s' "$BASE" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*#\1#')"
  for cand in apple-touch-icon.png apple-touch-icon-precomposed.png favicon.ico favicon.png; do
    if curl -fsSL --max-time 20 "$ORIGIN/$cand" -o "$WORK/logo-src" && [ -s "$WORK/logo-src" ]; then
      SRC="$WORK/logo-src"
      say "图标来源：站点文件 $ORIGIN/$cand"
      break
    fi
  done
  [ -n "$SRC" ] || say "站点没有可用的图标文件"
fi

# ---------------------------------------------------------------- 2) 统一成 1024 方图
if [ -n "$SRC" ]; then
  if ! $IM "$SRC[0]" -background none -alpha on -strip \
      -resize 820x820 -gravity center -extent 1024x1024 \
      "$OUT_DIR/logo.png" 2>"$WORK/im.log"; then
    say "源图转换失败（见下），改用首字母图标"
    cat "$WORK/im.log" >&2 || true
    rm -f "$OUT_DIR/logo.png"
    SRC=""
  fi
fi

if [ ! -s "$OUT_DIR/logo.png" ]; then
  # 首字母兜底。注意取的是 ASCII 字母数字：中文字体在 runner 上不一定有，
  # 用汉字会画成方框，那就白做了。
  LETTER="$(printf '%s' "$APP_NAME" | tr -cd 'A-Za-z0-9' | cut -c1)"
  if [ -z "$LETTER" ] && [ -n "$PRESET_URL" ]; then
    HOST="$(printf '%s' "$PRESET_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##')"
    LETTER="$(printf '%s' "$HOST" | tr -cd 'A-Za-z0-9' | cut -c1)"
  fi
  [ -n "$LETTER" ] || LETTER="W"
  LETTER="$(printf '%s' "$LETTER" | tr '[:lower:]' '[:upper:]')"
  say "图标来源：首字母 $LETTER"
  $IM -size 1024x1024 "xc:$THEME_COLOR" -gravity center \
      -pointsize 560 -fill white -annotate 0 "$LETTER" \
      "$OUT_DIR/logo.png"
fi

# ---------------------------------------------------------------- 3) Android
RES="$OUT_DIR/android-res"
DENSITIES="mdpi hdpi xhdpi xxhdpi xxxhdpi"
for d in $DENSITIES; do
  case "$d" in
    mdpi)    launcher=48;  adaptive=108 ;;
    hdpi)    launcher=72;  adaptive=162 ;;
    xhdpi)   launcher=96;  adaptive=216 ;;
    xxhdpi)  launcher=144; adaptive=324 ;;
    xxxhdpi) launcher=192; adaptive=432 ;;
  esac
  mkdir -p "$RES/mipmap-$d"
  $IM "$OUT_DIR/logo.png" -resize "${launcher}x${launcher}" "$RES/mipmap-$d/ic_launcher.png"
  cp "$RES/mipmap-$d/ic_launcher.png" "$RES/mipmap-$d/ic_launcher_round.png"
  # 自适应图标：108dp 画布上只有中间 72dp 是安全区，内容按 2/3 缩进去才不会被动效裁掉
  inner=$(( adaptive * 2 / 3 ))
  $IM "$OUT_DIR/logo.png" -resize "${inner}x${inner}" -background none -gravity center \
      -extent "${adaptive}x${adaptive}" "$RES/mipmap-$d/ic_launcher_foreground.png"
done

mkdir -p "$RES/mipmap-anydpi-v26"
for name in ic_launcher ic_launcher_round; do
  cat > "$RES/mipmap-anydpi-v26/$name.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
XML
done
mkdir -p "$RES/values"
cat > "$RES/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$THEME_COLOR</color>
</resources>
XML

# ---------------------------------------------------------------- 4) Windows
$IM "$OUT_DIR/logo.png" -define icon:auto-resize=256,128,64,48,32,16 "$OUT_DIR/app_icon.ico"

# ---------------------------------------------------------------- 5) preset.json
HEX="$(printf '%s' "$THEME_COLOR" | tr -d '# ' | tr '[:lower:]' '[:upper:]')"
if [ "${#HEX}" -eq 6 ]; then
  COLOR_INT=$((16#FF$HEX))
else
  COLOR_INT=$((16#FF2962FF))
  HEX="2962FF"
fi
if [ "$ALLOW_ADD_SITE" = "true" ]; then ADD_SITE_JSON="true"; else ADD_SITE_JSON="false"; fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

cat > "$OUT_DIR/preset.json" <<JSON
{
  "appName": "$(json_escape "$APP_NAME")",
  "themeColor": $COLOR_INT,
  "presetUrl": "$(json_escape "$PRESET_URL")",
  "presetName": "$(json_escape "$PRESET_NAME")",
  "allowAddSite": $ADD_SITE_JSON,
  "showAddressBar": true
}
JSON

# 给后面的构建 job 用（也方便人看这一次到底打的是什么）
cat > "$OUT_DIR/app-id.env" <<ENV
APP_ID_EFFECTIVE=$APP_ID_EFFECTIVE
ORG=$ORG_PART
NAME=$NAME_PART
SLUG=$NAME_PART
APP_NAME_EFFECTIVE=$APP_NAME
PRESET_URL_EFFECTIVE=$PRESET_URL
ENV

say "产物："
ls -R "$OUT_DIR" | head -40
say "preset.json:"
cat "$OUT_DIR/preset.json"
