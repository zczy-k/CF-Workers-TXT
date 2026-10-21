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
#                          先读首页 HTML 里 <link rel="...icon..."> 声明的图标，
#                          再兜底试站点根目录的 apple-touch-icon.png / favicon.ico / favicon.png
#                          （现在多数站点只写在 HTML 里，固定路径上什么都没有）
#   4) 都没有              用站点名/App 名的首字母画一个
# 第 4 条是刻意的：永远有图标，绝不会打出"没有图标"的包。
#
# 用法（在仓库根目录）：
#   APP_NAME='公司 OA' APP_ID=com.corp.oa PRESET_URL=oa.corp.com bash shell/tools/branding.sh out
set -euo pipefail

# say 放在最前面：下面每一步（包括环境自检）都可能要报一句人话，
# 定义晚一步就会变成 "say: command not found"，把报错信息本身搞得更难懂。
say() { printf '%s\n' "---- $*"; }

OUT_DIR="${1:-branding-out}"
APP_NAME="${APP_NAME:-WebShell}"
APP_ID="${APP_ID:-dev.webshell.webshell}"
PRESET_URL="${PRESET_URL:-}"
PRESET_NAME="${PRESET_NAME:-}"
THEME_COLOR="${THEME_COLOR:-#2962FF}"
LOGO_URL="${LOGO_URL:-}"
LOGO_PATH="${LOGO_PATH:-}"
AUTO_ICON="${AUTO_ICON:-true}"
ALLOW_ADD_SITE="${ALLOW_ADD_SITE:-true}"
# 更新检查源：一个 JSON（{"version":"1.2.0","url":"…","note":"…"}）。
# 留空 = 这个包不启用更新检查（设置页入口也跟着隐藏）。
UPDATE_URL="${UPDATE_URL:-}"

# 抓站点图标时用的 UA。写清楚自己是谁（而不是冒充 Chrome），同时带 compatible 前缀，
# 让那些只拒绝"空 UA/爬虫 UA"的 CDN 放行；实测 flutter.dev / php.net / wikipedia 都能过。
UA="Mozilla/5.0 (compatible; WebShellBranding/1.0; +https://github.com/zczy-k/CF-Workers-TXT)"

if command -v magick >/dev/null 2>&1; then IM="magick"; elif command -v convert >/dev/null 2>&1; then IM="convert"; else
  # 实测：ubuntu-22.04 的镜像自带 ImageMagick，**ubuntu-24.04 起就没有了**，
  # 所以由 shell-build.yml 用 apt 装（哪怕装了也要留着这条，脚本单独跑时能说清原因）。
  say "找不到 ImageMagick（CI 里由 shell-build.yml 用 apt 安装；本地跑请先装 imagemagick），没法生成图标"
  exit 1
fi

# 画首字母要字体。runner 上不保证装了字体，所以显式找一个 DejaVu/Liberation，
# 一个都找不到就退化成几何图形——总之不能让"没有字体"变成构建失败。
FONT=""
for f in \
  /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  /usr/share/fonts/TTF/DejaVuSans-Bold.ttf \
  /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf ; do
  if [ -f "$f" ]; then FONT="$f"; break; fi
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

# 主题色只认 #RRGGBB。手填的输入不能直接喂给 shell 算术与 ImageMagick：
# 一个拼错的颜色会让 `16#FFZZZZZZ` 当场报错退出，看起来像脚本坏了。
case "$THEME_COLOR" in
  \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
  *)
    say "主题色 '$THEME_COLOR' 不是 #RRGGBB，改用默认 #2962FF"
    THEME_COLOR="#2962FF"
    ;;
esac

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
# 下面三个小工具只在 AUTO_ICON 那段用；放在这里是因为它们都要用 $WORK / $UA。
#
# 从首页 HTML 里挖 <link rel="...icon..."> 的 href（每行一个，保持文档顺序）。
# 只做"够用"的解析：先按标签把 HTML 切成一行一个（正文里的 href 因此不会被误抓），
# 再挑 rel 里带 icon / apple-touch 的 link，最后取 href。为什么要这么麻烦：实测
# flutter.dev 的 /favicon.ico 是 404，图标只在 HTML 里写着一个带 hash 的 png。
# rel 的值里允许有空格（"shortcut icon"），但**不能**跨过引号或尖括号——否则
# rel="preload" href="/icons/x.png" 这类会被误当成图标。
html_icon_hrefs() {
  sed -E 's/></>\n</g' "$1" | tr -d '\r' \
    | grep -iE '^[[:space:]]*<link[[:space:]]' \
    | grep -iE 'rel=["'"'"']?[^"'"'"'>]*icon' \
    | sed -nE 's/.*[Hh][Rr][Ee][Ff]=["'"'"']?([^"'"'"' >]+).*/\1/p'
}

# 把 href 补成绝对地址：绝对、协议相对、根相对、页内相对四种，够用了。
# 依赖调用方先设好 ORIGIN（scheme://host）与 DIRPART（页面所在目录）。
abs_url() {
  case "$2" in
    http://*|https://*) printf '%s\n' "$2" ;;
    //*)                printf 'https:%s\n' "$2" ;;
    /*)                 printf '%s%s\n' "$ORIGIN" "$2" ;;
    *)                  printf '%s/%s\n' "$DIRPART" "$2" ;;
  esac
}

# 下载一个候选图标。顺手挡掉"服务器把 404 页面当 200 返回"的情况：那种情况
# curl 会成功、文件非空，但内容是 HTML，拿去切图标只会得到一个白块。
try_download_icon() {
  curl -fsSL --max-time 25 -A "$UA" "$1" -o "$WORK/logo-src" 2>/dev/null || return 1
  [ -s "$WORK/logo-src" ] || return 1
  if head -c 512 "$WORK/logo-src" | grep -qiE '<!doctype|<html|<head|<body'; then
    say "候选返回的是网页不是图片，跳过：$1"
    return 1
  fi
  return 0
}

SRC=""
if [ -n "$LOGO_PATH" ] && [ -f "$LOGO_PATH" ]; then
  SRC="$LOGO_PATH"
  say "图标来源：仓库文件 $LOGO_PATH"
else
  [ -z "$LOGO_PATH" ] || say "logo_path 指向的文件不存在：$LOGO_PATH（继续往下找）"
  if [ -n "$LOGO_URL" ]; then
    if curl -fsSL --max-time 30 "$LOGO_URL" -o "$WORK/logo-src"; then
      SRC="$WORK/logo-src"
      say "图标来源：$LOGO_URL"
    else
      say "图标 URL 下载失败，继续往下找"
    fi
  fi
fi

if [ -z "$SRC" ] && [ "$AUTO_ICON" = "true" ] && [ -n "$PRESET_URL" ]; then
  BASE="$PRESET_URL"
  case "$BASE" in
    *://*) ;;
    *) BASE="https://$BASE" ;;
  esac
  ORIGIN="$(printf '%s' "$BASE" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*#\1#')"
  case "$BASE" in
    *://*/*) DIRPART="${BASE%/*}" ;;   # 地址带路径：相对地址以它所在目录为基准
    *)       DIRPART="$ORIGIN" ;;
  esac

  # 先读首页 HTML：站点在那里声明的图标通常分辨率最高（apple-touch-icon 一般 180+），
  # 而且是唯一能拿到 flutter.dev 这类站点图标的办法（它的 /favicon.ico 是 404）。
  if curl -fsSL --max-time 25 -A "$UA" "$BASE" -o "$WORK/page.html" 2>/dev/null && [ -s "$WORK/page.html" ]; then
    say "读首页，找图标声明：$BASE"
    HREFS="$(html_icon_hrefs "$WORK/page.html" || true)"
    [ -n "$HREFS" ] || say "首页里没有 <link rel=...icon...> 声明"
    # 分组试探，组内保持文档顺序：apple-touch-icon 一般分辨率最高 → 其他位图 → SVG
    # （SVG 放最后：ImageMagick 不一定带 librsvg，切图失败的概率高）
    AT="$(printf '%s\n' "$HREFS" | grep -i 'apple-touch' || true)"
    RASTER="$(printf '%s\n' "$HREFS" | grep -vi 'apple-touch' | grep -viE '\.svg([?#]|$)' || true)"
    VECTOR="$(printf '%s\n' "$HREFS" | grep -vi 'apple-touch' | grep -iE '\.svg([?#]|$)' || true)"
    for href in $AT $RASTER $VECTOR; do
      URL="$(abs_url "$BASE" "$href")"
      if try_download_icon "$URL"; then
        SRC="$WORK/logo-src"
        say "图标来源：首页声明 $URL"
        break
      fi
    done
  else
    say "首页打不开（网络或反爬），只试固定路径"
  fi

  # 兜底：老站点确实会在根目录放这几个文件（一次小下载就能拿到，不需要读 HTML）。
  if [ -z "$SRC" ]; then
    for cand in apple-touch-icon.png apple-touch-icon-precomposed.png favicon.ico favicon.png; do
      if try_download_icon "$ORIGIN/$cand"; then
        SRC="$WORK/logo-src"
        say "图标来源：站点文件 $ORIGIN/$cand"
        break
      fi
    done
  fi

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
  say "图标来源：首字母 $LETTER（字体：${FONT:-无，改用几何图形}）"
  if [ -n "$FONT" ]; then
    $IM -size 1024x1024 "xc:$THEME_COLOR" -gravity center -font "$FONT" \
        -pointsize 560 -fill white -annotate 0 "$LETTER" \
        "$OUT_DIR/logo.png"
  else
    # 没有字体也要出图：白色圆环 + 圆心实点，朴素但很清楚
    $IM -size 1024x1024 "xc:$THEME_COLOR" -fill white \
        -draw "circle 512,512 512,110" -fill "$THEME_COLOR" \
        -draw "circle 512,512 512,210" "$OUT_DIR/logo.png"
  fi
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

# 版本号单一真相源：shell/app/pubspec.yaml 的 `version: 0.1.0+1`。
# 构建号（+1）留给平台构建用，preset.json 只带用户可见的 0.1.0。
# 读不到时退回 0.0.0 —— 版本显示宁缺毋滥，也别让构建挂在这。
APP_VERSION="$(sed -n 's/^version:[[:space:]]*\([0-9][0-9A-Za-z.\-]*\)\(+[0-9]*\)\{0,1\}$/\1/p' \
  "$(dirname "$0")/../app/pubspec.yaml" | head -1)"
[ -n "$APP_VERSION" ] || APP_VERSION="0.0.0"

# 可选字段：无条件写键。UPDATE_URL 为空时写空串，Dart 侧按 isNotEmpty
# 判空跳过（空串与缺键等价）——比 heredoc 里拼条件行干净，也没有尾逗号问题。
cat > "$OUT_DIR/preset.json" <<JSON
{
  "appName": "$(json_escape "$APP_NAME")",
  "appId": "$(json_escape "$APP_ID_EFFECTIVE")",
  "themeColor": $COLOR_INT,
  "presetUrl": "$(json_escape "$PRESET_URL")",
  "presetName": "$(json_escape "$PRESET_NAME")",
  "allowAddSite": $ADD_SITE_JSON,
  "showAddressBar": true,
  "appVersion": "$APP_VERSION",
  "updateUrl": "$(json_escape "$UPDATE_URL")"
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
# 加 || true：set -o pipefail 下 head 提前关管道会让 ls 收到 SIGPIPE 而"失败"，
# 脚本会在最后一步无谓地退出码非 0。
ls -R "$OUT_DIR" | head -40 || true
say "preset.json:"
cat "$OUT_DIR/preset.json"
