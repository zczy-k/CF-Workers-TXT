// ============= Cloudflare 网盘 / 文本管理器（Workers + R2 + KV） =============
// 管理员入口： https://<域名>/<ADMIN_UUID>
// 访客只读 ： https://<域名>/s/<分享口令>
//
// ==== 必须绑定的资源 ====
//   R2 存储桶    变量名必须为  R2    （存放文件夹与文件，真正的上传能力）
//   KV 命名空间  变量名必须为  KV    （存放分享口令 / 登录态校验，可选）
//
// ==== 环境变量 ====
//   ADMIN_UUID  必填  管理员入口路径，任意字符串
//   FILENAME    可选  页面标题，默认 CF-Workers-TXT
//   PASSWORD    可选  设置后管理页需要输入密码登录
//
// ==== 数据布局（R2 内部） ====
//   d/<目录>/           空对象，作为"文件夹"占位（空文件夹靠它存在）
//   d/<目录>/<文件名>    真实文件

const ROOT = 'd/';

// 已发布影子树：结构镜像 ROOT，但只装"发布过"的对象。分享端（/s/*）只读这里，
// 所以编辑草稿（ROOT）永远不会立刻出现在分享页上 —— 必须显式发布才可见。
// 与 ROOT 一样放在顶层，不会被 `__sys__` 那类系统前缀扫到。
const PUB = '__pub__/';

// ===== 工具 =====
function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// 归一化路径：统一分隔符、剔除 . 与 ..，从根上阻断目录穿越
function normPath(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s && s !== '.' && s !== '..')
    .join('/');
}

// 文件名安全化：去掉路径分隔符与非法字符
function safeName(n) {
  let s = String(n == null ? '' : n).trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_');
  if (s.length > 180) s = s.slice(0, 180);
  return s;
}

// 分享口令安全化：只留 URL 安全字符，避免编码/转发时出问题
function safeToken(t) {
  return String(t == null ? '' : t).trim()
    .replace(/[^A-Za-z0-9._~-]/g, '')
    .slice(0, 64);
}

// 目录路径安全化：逐段清洗，保证与写入时一致的 key
function safeDir(p) {
  return normPath(p).split('/').map(safeName).filter(Boolean).join('/');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status, extra) {
  const h = new Headers(extra || {});
  h.set('Content-Type', 'application/json;charset=utf-8');
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function text(msg, status) {
  return new Response(msg, {
    status: status || 200,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
  });
}

function html(body, status, extra) {
  const h = new Headers(extra || {});
  h.set('Content-Type', 'text/html;charset=utf-8');
  return new Response(body, { status: status || 200, headers: h });
}

// ===== 安全基建 =====
function ipOf(request) {
  return request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'unknown';
}

function numEnv(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : dflt;
}

// 每个 isolate 一份的滑动窗口计数，属"尽力而为"的第一道闸；
// 要硬性限流请到 Cloudflare 控制台配 Rate Limiting 规则（免费版就有一条额度）。
const rateBuckets = new Map();
function rateTake(key, limit, now) {
  if (!limit || limit <= 0) return null;          // 0 或负数 = 关闭
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + 60000 }; rateBuckets.set(key, b); }
  b.n++;
  if (rateBuckets.size > 10000) {                 // 防止 Map 无限膨胀
    for (const k of rateBuckets) if (rateBuckets.get(k).reset < now) rateBuckets.delete(k);
    if (rateBuckets.size > 30000) rateBuckets.clear();
  }
  return { ok: b.n <= limit, retry: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
}

// 所有响应统一带上的安全头
// ⚠️ 头部一律**复制到新 Response 上**再改，绝不直接在原响应上 set：
// Cache API（caches.default.match）与 fetch 返回的 Response 头部是**不可变**的，
// 直接改会抛 "Can't modify immutable headers"。踩过的现场：分享直连命中边缘缓存后
// 再走 applySecurity 就抛异常 → Worker 1101，症状是"分享链接第一次能打开、
// 60 秒内（缓存 TTL）再打开就 500"。重建 Response 只是套一层流，不缓冲，成本可忽略。
function applySecurity(res) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');          // 禁止 MIME 嗅探
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 防点击劫持。例外：响应自己带了 CSP 的 frame-ancestors 时以它为准 ——
  // 那条指令更精确（能只放行"自己的壳页面"），而 X-Frame-Options 只有"全禁"一档。
  // 例：HTML 单文档分享的 ?doc=1 文档必须能被我们自己的壳页面 iframe 嵌进来。
  const csp = h.get('Content-Security-Policy') || '';
  if (csp.indexOf('frame-ancestors') < 0) h.set('X-Frame-Options', 'DENY');
  const ct = (h.get('Content-Type') || '').toLowerCase();
  if (ct.indexOf('text/html') === 0) h.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ===== R2 操作 =====
const SORT_KEYS = ['name', 'type', 'size', 'time'];

function serverExtOf(name){
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
}
function cmpName(a, b){ return String(a).localeCompare(String(b), 'zh'); }

// opts：pageSize>0 分页；sort/desc 排序；cursor 是**数字偏移**（不再是 R2 的不透明游标）。
// 为什么要先把目录列全：R2 的 list 不支持排序，要按大小/时间/类型排就只能先全部拿到再排。
// 分页因此改用偏移切片 —— R2 的 cursor 只能"接着往下读"，没法"从第 N 条开始"。
async function listDir(bucket, dir, opts, root) {
  const o = opts || {};
  const pageSize = Math.max(0, parseInt(o.pageSize, 10) || 0);
  const offset = Math.max(0, parseInt(o.cursor, 10) || 0);
  const by = SORT_KEYS.indexOf(o.sort) >= 0 ? o.sort : 'name';
  const desc = !!o.desc;
  const prefix = (root || ROOT) + (dir ? dir + '/' : '');
  const folders = [];
  const files = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const p of res.delimitedPrefixes) {
      const name = p.slice(prefix.length).replace(/\/+$/, '');
      if (name) folders.push(name);
    }
    for (const obj of res.objects) {
      if (obj.key.endsWith('/')) continue;          // 文件夹占位对象，不当作文件
      const name = obj.key.slice(prefix.length);
      if (!name) continue;
      files.push({
        name,
        size: obj.size,
        ct: (obj.httpMetadata && obj.httpMetadata.contentType) || '',
        mtime: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded || '')
      });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  // 文件夹永远排在最前并按名称排（它们没有大小/时间可比），文件按选中的字段排
  folders.sort(cmpName);
  const s = desc ? -1 : 1;
  if (by === 'size') {
    files.sort((a, b) => (s * ((a.size || 0) - (b.size || 0))) || cmpName(a.name, b.name));
  } else if (by === 'time') {
    files.sort((a, b) => (s * String(a.mtime || '').localeCompare(String(b.mtime || ''))) || cmpName(a.name, b.name));
  } else if (by === 'type') {
    files.sort((a, b) => (s * cmpName(serverExtOf(a.name), serverExtOf(b.name))) || cmpName(a.name, b.name));
  } else {
    files.sort((a, b) => s * cmpName(a.name, b.name));
  }

  const total = folders.length + files.length;
  if (!pageSize) return { folders, files, more: false, pageSize: 0, total, sort: by, desc };

  const end = Math.min(total, offset + pageSize);
  const fc = folders.length;
  const folderSlice = folders.slice(offset, end);
  const fileSlice = end > fc ? files.slice(Math.max(0, offset - fc), Math.max(0, end - fc)) : [];
  return {
    folders: folderSlice, files: fileSlice,
    cursor: end < total ? String(end) : undefined,
    more: end < total, pageSize, total, sort: by, desc, offset
  };
}

// 一次性扫描整棵树（左侧导航用）：
// 返回嵌套结构 + 每一层的子项数量，这样折叠状态下也能看到"里面有多少东西"，
// 展开时无需再发请求。扫描与节点数都有上限，避免超大目录把响应撑爆。
async function buildFullTree(bucket, opts) {
  const o = opts || {};
  const MAX_SCAN = o.maxScan || 12000;      // 最多读取多少个对象
  const MAX_FILES = o.maxFiles || 500;      // 单个目录最多列出多少个文件
  const scanBase = o.prefix != null ? o.prefix : ROOT;   // 只读访客只扫分享目录内部
  const withProtected = !!o.withProtected;   // 管理端才收集"受保护文件夹"标记
  const protectedPaths = [];
  const root = { path: '', dirs: new Map(), files: [], extra: 0 };
  let cursor;
  let scanned = 0;
  let truncated = false;

  do {
    const listOpt = { prefix: scanBase, cursor, limit: 1000 };
    // 一次 list 顺带取回 customMetadata，就能标出所有受保护文件夹 —— 不需要逐个 head()
    if (withProtected) listOpt.include = ['customMetadata'];
    const res = await bucket.list(listOpt);
    for (const obj of res.objects) {
      const rel = obj.key.slice(scanBase.length);
      if (!rel) continue;
      const isMarker = obj.key.endsWith('/');       // 文件夹占位对象
      const segs = rel.split('/');
      if (isMarker) segs.pop();
      if (!segs.length) continue;
      if (isMarker && withProtected && obj.customMetadata && obj.customMetadata.protected === '1') {
        protectedPaths.push(segs.join('/'));
      }

      let node = root;
      let p = '';
      for (let i = 0; i < segs.length; i++) {
        p = p ? p + '/' + segs[i] : segs[i];
        const isLast = i === segs.length - 1;
        if (isLast && !isMarker) {
          if (node.files.length >= MAX_FILES) { node.extra++; truncated = true; }
          else {
            node.files.push({
              n: segs[i],
              s: obj.size || 0,
              t: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : ''
            });
          }
        } else {
          let d = node.dirs.get(segs[i]);
          if (!d) {
            d = { path: p, dirs: new Map(), files: [], extra: 0 };
            node.dirs.set(segs[i], d);
          }
          node = d;
        }
      }
      scanned++;
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && scanned < MAX_SCAN);
  if (cursor) truncated = true;

  const protectedSet = new Set(protectedPaths);
  function pack(node, name) {
    const dirs = [];
    // 受保护的文件夹永远排在兄弟节点的最前面，其余按名称 —— 前后端一致
    const keys = [...node.dirs.keys()].sort((a, b) => {
      const pa = protectedSet.has(node.dirs.get(a).path) ? 0 : 1;
      const pb = protectedSet.has(node.dirs.get(b).path) ? 0 : 1;
      return (pa - pb) || a.localeCompare(b, 'zh');
    });
    let size = 0;
    for (const k of keys) {
      const sub = pack(node.dirs.get(k), k);
      dirs.push(sub);
      size += sub.z;
    }
    const files = node.files.sort((a, b) => a.n.localeCompare(b.n, 'zh'));
    for (const f of files) size += f.s;
    // c = 直接子项数量（文件夹数 + 文件数），用于折叠时显示徽标；pr = 该文件夹是否受保护
    return { n: name, p: node.path, d: dirs, f: files, c: dirs.length + files.length + (node.extra || 0), z: size, x: node.extra || 0, pr: (node.path && protectedSet.has(node.path)) ? 1 : 0 };
  }

  return { tree: pack(root, o.rootName || '根目录'), nodes: scanned, truncated, protected: protectedPaths };
}

async function collectKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteMany(bucket, keys) {
  for (let i = 0; i < keys.length; i += 40) {
    await Promise.all(keys.slice(i, i + 40).map(k => bucket.delete(k)));
  }
}

// 收集「一个目录下」的全部对象，并**保证目录自身的占位键在内**。
// 不能假设 list() 一定会返回与 prefix 完全相同的那个键（也兼容历史上可能出现的无斜杠键），
// 否则删/搬之后会留下一个空壳文件夹 —— 用户看到"文件夹还在，里面空了"。
async function collectDirAll(bucket, dirPrefix) {
  const keys = await collectKeys(bucket, dirPrefix);
  const seen = new Set(keys);
  const bare = dirPrefix.replace(/\/+$/, '');
  for (const k of [dirPrefix, bare]) {
    if (!seen.has(k) && await bucket.head(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

// root 默认草稿树；传 PUB 就能用同一套逻辑删影子树里的副本
async function deletePath(bucket, path, isDir, root) {
  const base = root || ROOT;
  if (isDir) {
    const prefix = base + path + '/';
    const keys = await collectDirAll(bucket, prefix);
    await deleteMany(bucket, keys);
    // 删完再确认一次占位键真的没了；万一前面漏了，这里补一刀
    let extra = 0;
    for (const k of [prefix, base + path]) {
      if (await bucket.head(k)) { await bucket.delete(k); extra++; }
    }
    return keys.length + extra;
  }
  const key = base + path;
  const obj = await bucket.head(key);
  await bucket.delete(key);
  return obj ? 1 : 0;
}

// 把 srcPrefix 下的全部对象搬到 dstPrefix（R2 没有服务端 copy，只能读+写+删）
async function moveObjects(bucket, srcPrefix, dstPrefix) {
  const isDir = srcPrefix.slice(-1) === '/';
  // 目录要连占位键一起搬，否则源位置会留下一个空壳文件夹；
  // 文件必须用**精确 key** —— collectKeys 是字符串前缀匹配，
  // 用 'd/a.txt' 去列会把 'd/a.txt.bak' 这种同前缀的邻居一起搬走。
  const keys = isDir ? await collectDirAll(bucket, srcPrefix) : [srcPrefix];
  if (keys.length > 500) {
    return { ok: false, error: '该项目下文件过多（>' + keys.length + '），请分批处理' };
  }
  let moved = 0;
  for (const k of keys) {
    const obj = await bucket.get(k);
    if (!obj) continue;
    const dst = dstPrefix + k.slice(srcPrefix.length);
    const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
    const cm = obj.customMetadata || {};
    const opt = { httpMetadata: { contentType: ct } };
    const keep = {};
    if (cm.mtime) keep.mtime = cm.mtime;
    if (cm.protected) keep.protected = cm.protected;   // 受保护标记随文件夹一起搬，改名/移动后不丢
    if (Object.keys(keep).length) opt.customMetadata = keep;
    await bucket.put(dst, obj.body, opt);
    moved++;
  }
  await deleteMany(bucket, keys);
  if (isDir) {
    for (const k of [srcPrefix, srcPrefix.slice(0, -1)]) {
      if (await bucket.head(k)) await bucket.delete(k);
    }
  }
  return { ok: true, moved };
}

// ===== 发布：草稿树 ROOT → 已发布影子树 PUB =====
// R2 没有服务端 copy，只能读+写。发布是低频动作，写法与 moveObjects 一致。
// 单文件必须用**精确 key**：collectKeys 是字符串前缀匹配，用前缀会把 d/a.txt.bak
// 这种同前缀的邻居一起卷进来。
async function copyOne(bucket, srcKey, dstKey) {
  const o = await bucket.get(srcKey);
  if (!o) return false;
  const ct = (o.httpMetadata && o.httpMetadata.contentType) || 'application/octet-stream';
  const cm = o.customMetadata || {};
  const opt = { httpMetadata: { contentType: ct } };
  const keep = {};
  if (cm.mtime) keep.mtime = cm.mtime;
  if (cm.protected) keep.protected = cm.protected;   // 受保护标记随复制一起带过去
  if (Object.keys(keep).length) opt.customMetadata = keep;
  await bucket.put(dstKey, o.body, opt);
  return true;
}

// 影子树里那份副本，是否和草稿当前内容**完全一致** —— 一致就说明"再发布一次什么都不会变"。
// 判据是内容指纹（size + etag），不是 uploaded 时间戳：发布本身就是一次重新上传，时间戳必然更新；
// 而 etag 是内容的哈希，同一份字节流重新上传得到的 etag 相同，所以能准确回答"内容变没变"。
// 目录则把两侧的 "相对路径:体积:etag" 排序后整体比对 —— 只比数量会漏掉"改名但内容没变"这类情况。
// 返回 null = 判断不了（对象数超过发布上限，或 etag 形态不可比），调用方按"需要发布"处理（保守放行）。
async function listKeyEtags(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) {
      if (out.length >= 500) return null;        // 与 publishPath 的 500 上限一致，超过就不比了
      // etag 是这里的"内容指纹"。拿不到指纹绝不能装作一致 —— 那会把"改了内容"误判成
      // "没改"，导致该发布的不让发布。宁可返回 null（判断不了），让调用方保守放行。
      const et = o.etag || o.httpEtag || '';
      if (!et) return null;
      out.push(o.key + ':' + o.size + ':' + et);
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

async function publishSynced(bucket, path, isDir) {
  if (!path) return null;
  if (!isDir) {
    const pair = await Promise.all([bucket.head(ROOT + path), bucket.head(PUB + path)]);
    const draft = pair[0], pub = pair[1];
    if (!draft || !pub) return false;            // 缺一边 → 肯定谈不上一致
    // 与目录那条同理：拿不到内容指纹就返回 null（判断不了），绝不误判成"一致"
    const de = draft.etag || draft.httpEtag || '';
    const pe = pub.etag || pub.httpEtag || '';
    if (!de || !pe) return null;
    return draft.size === pub.size && de === pe;
  }
  const pair = await Promise.all([
    listKeyEtags(bucket, ROOT + path + '/'),
    listKeyEtags(bucket, PUB + path + '/')
  ]);
  const dk = pair[0], pk = pair[1];
  if (!dk || !pk) return null;
  if (dk.length !== pk.length) return false;
  // 两侧前缀长度不同（d/ 与 __pub__/），各自切掉前缀，剩下的就是同一套相对路径
  const a = dk.map(s => s.slice(ROOT.length)).sort();
  const b = pk.map(s => s.slice(PUB.length)).sort();
  return a.join('\n') === b.join('\n');
}

// 把 d/<path> 复制到 __pub__/<path>；目录连占位键一起复制，空文件夹也能保留
async function publishPath(bucket, path, isDir) {
  if (!path) return { ok: false, error: '缺少 path 参数' };
  if (!isDir) {
    const ok = await copyOne(bucket, ROOT + path, PUB + path);
    if (!ok) return { ok: false, error: '文件不存在' };
    return { ok: true, published: 1 };
  }
  const srcPrefix = ROOT + path + '/';
  const keys = await collectDirAll(bucket, srcPrefix);
  if (!keys.length) return { ok: false, error: '目录不存在或为空' };
  if (keys.length > 500) return { ok: false, error: '目录下对象过多（' + keys.length + ' 个），请分批发布' };
  let n = 0;
  for (const k of keys) {
    if (await copyOne(bucket, k, PUB + k.slice(ROOT.length))) n++;
  }
  return { ok: true, published: n };
}

// 撤回发布：只删影子树里的副本，草稿树不动
async function unpublishPath(bucket, path, isDir) {
  if (!path) return { ok: false, error: '缺少 path 参数' };
  if (!isDir) {
    const key = PUB + path;
    const o = await bucket.head(key);
    await bucket.delete(key);
    return { ok: true, removed: o ? 1 : 0 };
  }
  const keys = await collectDirAll(bucket, PUB + path + '/');
  await deleteMany(bucket, keys);
  return { ok: true, removed: keys.length };
}

// 改名 / 移动后，影子树里若已有该副本，跟着一起搬；没有就跳过。
// 失败不影响草稿树的结果（分享内容最多暂时不同步，下次发布即修正）。
async function movePublished(bucket, from, to, isDir) {
  const src = PUB + from + (isDir ? '/' : '');
  const exists = await bucket.head(isDir ? src : PUB + from);
  if (!exists) return;
  try { await moveObjects(bucket, src, PUB + to + (isDir ? '/' : '')); } catch (e) {}
}

// 判断给定路径是否位于某个"受保护文件夹"内部（或自身就是受保护文件夹）。
// 受保护标记存储在 R2 文件夹占位对象的 customMetadata.protected === '1'。
// 逐级向上检查所有祖先目录，只要任一层被标记，即视为受保护。
async function isProtectedPath(bucket, fullPath, isDir) {
  const segs = fullPath.split('/');
  const dirsToCheck = [];
  if (isDir) dirsToCheck.push(fullPath);            // 目录自身也要检查
  let acc = '';
  for (let i = 0; i < segs.length - 1; i++){       // 所有祖先目录
    acc = acc ? acc + '/' + segs[i] : segs[i];
    dirsToCheck.push(acc);
  }
  const seen = new Set();
  for (const d of dirsToCheck) {
    if (seen.has(d)) continue;
    seen.add(d);
    try {
      const h = await bucket.head(ROOT + d + '/');
      const cm = h.customMetadata || {};
      if (cm.protected === '1') return true;
    } catch (e) { /* 忽略单个目录元数据读取失败 */ }
  }
  return false;
}

// 受保护的内容只能在保护区内移动：源受保护、目标目录不受保护、且不是同目录改名 → 拒绝。
// 同目录改名放行：标记跟着占位对象/文件一起走，保护域不变。
// （下载/预览/分享不受此限制；往保护区里搬——源不受保护——也放行，等于往保险箱里放东西。）
async function moveLeavesProtection(bucket, full, isDir, toDir) {
  const srcProt = await isProtectedPath(bucket, full, isDir);
  if (!srcProt) return false;
  const parent = full.split('/').slice(0, -1).join('/');
  if ((toDir || '') === parent) return false;
  if (!toDir) return true;                       // 根目录不受保护
  return !(await isProtectedPath(bucket, toDir, true));
}

// 移入保护区：普通内容搬进受保护文件夹，需要管理员密码（服务端强制）。
// 源本身已受保护 → 保护区内互搬，不额外要密码；同目录改名不可能触发（目标=父目录无保护则源必无保护）。
async function moveIntoProtection(bucket, full, isDir, toDir) {
  if (!toDir) return false;
  if (await isProtectedPath(bucket, full, isDir)) return false;
  return await isProtectedPath(bucket, toDir, true);
}

// 发布/撤回后清掉单文件分享的边缘缓存，否则最多 60 秒还能看到旧内容。
// 目录分享返回的是 appHtml（不写边缘缓存），这里一并清也无害。
async function purgeShareCache(origin, kv, path) {
  const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  if (!cache || !kv || !path) return;
  const all = await readShares(kv);
  const hit = all.filter(s =>
    s.path === path || s.path.startsWith(path + '/') || path.startsWith(s.path + '/'));
  for (const s of hit) {
    const bases = [origin + '/s/' + s.token, origin + '/sub/' + s.token];
    const urls = [];
    for (const b of bases) {
      urls.push(b);
      if (s.kind === 'file') {
        const f = b + '/' + encodeURIComponent(s.path.split('/').pop());
        // HTML 单文档分享有四个 URL 变体（普通导航 / ?doc=1 真文档 / ?raw=1 原文 / ?dl=1 下载），
        // 缓存键各不相同；不一起清的话重新发布后分享页会拿到旧内容。带不带文件名两种形式都清。
        // （页面内的静态资源不清：数量不可枚举，靠 max-age=60 自然过期。）
        urls.push(f, f + '?doc=1', f + '?raw=1', f + '?dl=1');
        urls.push(b + '?doc=1', b + '?raw=1', b + '?dl=1');
      }
    }
    for (const u of urls) { try { await cache.delete(u); } catch (e) {} }
  }
}

// ===== 文本编码识别 =====
// Workers 的 TextDecoder 支持 WHATWG 定义的全量编码集（含 gb18030 / big5），
// 所以老式的 GBK 中文 txt 不会再被当成 UTF-8 解出一堆乱码。
// 思路：BOM 优先 → 严格 UTF-8 试解（成功即 UTF-8）→ 失败则用候选编码在**前 64KB 采样**上打分，
// 取"替换字符最少"的那个，最后用胜出的编码整篇解一次。采样是为了控 CPU。
const ENC_CANDIDATES = ['gb18030', 'big5', 'euc-kr', 'shift-jis', 'windows-1252'];
const ENC_SNIFF_BYTES = 64 * 1024;

function tryDecode(u8, enc, fatal) {
  try { return new TextDecoder(enc, fatal ? { fatal: true } : undefined).decode(u8); }
  catch (e) { return null; }
}

// 返回 { enc, bom }；只做识别，不做整篇解码
function sniffEncoding(u8) {
  const n = u8.length;
  if (n >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { enc: 'utf-8', bom: 3 };
  if (n >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { enc: 'utf-16le', bom: 2 };
  if (n >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { enc: 'utf-16be', bom: 2 };
  const sample = u8.subarray(0, Math.min(n, ENC_SNIFF_BYTES));
  if (tryDecode(sample, 'utf-8', true) !== null) return { enc: 'utf-8', bom: 0 };
  let best = 'gb18030', bestBad = Infinity;
  for (const c of ENC_CANDIDATES) {
    const t = tryDecode(sample, c, false);
    if (t === null) continue;
    let bad = 0;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 0xFFFD) bad++;
    const ratio = t.length ? bad / t.length : 1;
    if (ratio < bestBad) { bestBad = ratio; best = c; }
  }
  return { enc: best, bom: 0 };
}

// 整篇解码成 JS 字符串，并去掉 BOM
function decodeBytes(u8) {
  const { enc, bom } = sniffEncoding(u8);
  const body = bom ? u8.subarray(bom) : u8;
  let t = tryDecode(body, enc, false);
  if (t === null) t = tryDecode(body, 'utf-8', false);
  if (t === null) t = '';
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return { text: t, enc };
}

// ===== 全文搜索索引 =====
// 索引存在 **R2** 的 `__sys__/idx.json`（故意放在 ROOT 之外，不会被目录列表/删除扫到）。
// 曾经存 KV，但 KV 没有 CAS：上传文件夹时的并发"读整份→改→写回"会互相覆盖、静默丢条目。
// R2 的 put 支持 `onlyIf: { etag }` 条件写 —— 冲突时重读重放，**从根上消灭丢更新**。
// 结构：{ v, at, tb, files: { '<相对路径>': [r, size, ct, mtimeMs, text] } }
//   r = 0 正文完整索引 / 1 只索引了前 N 字（截断）/ 2 未索引正文（改走文件名匹配）
const IDX_KEY = 'idx:v1';                 // 旧 KV 索引（首次访问时自动迁移到 R2 后删除）
const IDX_R2_KEY = '__sys__/idx.json';
function freshIdx(){ return { v: 2, at: 0, tb: 0, files: {} }; }
const IDX_PER_FILE = 8 * 1024;            // 每个文件最多索引前 8K 字符
const IDX_PER_FILE_MIN = 512;             // 配额快满时单文件正文最少留这么多，再少就只按文件名
// 索引正文总量上限。免费版 Worker 每次请求只有 10ms CPU，JSON.parse 一个大索引会把它吃掉，
// 所以默认压在 1MB（解析约 5-10ms）。付费版（30s CPU）可以用环境变量 INDEX_TEXT_CAP 调大。
const IDX_TEXT_CAP = 1024 * 1024;
// 硬上限：即使 INDEX_TEXT_CAP 被调得很大，索引也不许超过这个体积。
// 搜索每次都要 JSON.parse 整份索引，体积失控会把搜索请求直接打成 1102（CPU 超限）。
const IDX_TEXT_HARD_CAP = 1536 * 1024;
const IDX_MAX_FILES = 3000;               // 最多索引多少个文件
const IDX_FILE_SIZE_LIMIT = 512 * 1024;   // 超过此大小的文件不索引正文
const IDX_SAMPLE_BYTES = 64 * 1024;       // 建索引时最多解码多少字节
const IDX_SCAN_MAX = 5000;                // 搜索时补扫 R2 文件名的最多对象数
// 打包下载的清单上限：一次最多列这么多文件。
// 定这个数是因为**前端要把所有内容塞进浏览器内存**里拼 zip，
// 上百 MB 会把标签页吃崩，所以宁可少打一点并如实告诉用户「已截断」。
const ZIP_MAX_FILES = 300;
const ZIP_MAX_BYTES = 200 * 1024 * 1024;  // 合计 200MB 上限
// 目录条目的**总量**上限（跨所有选中项累计）。
// 为什么单独设一个：ZIP 的中央目录用 16 位存条目数，条目总数超过 65535 整个包就损坏；
// 而目录条目没有体积代价（size=0），不设限时多选几百个大目录就会把 zip 撑爆结构上限。
const ZIP_MAX_DIRS = 1000;

// 读出索引（带 etag 供条件写）。R2 没有时回读一次旧 KV 索引并**自动迁移**——
// 老部署平滑升级：第一次访问就把 KV 里的索引搬进 R2，之后 KV 那份删除。
async function idxLoad(bucket, kv){
  const o = await bucket.get(IDX_R2_KEY);
  if (o){
    let idx = null;
    try {
      const d = JSON.parse(await o.text());
      if (d && typeof d === 'object' && d.files) idx = d;
    } catch (e) {}
    if (!idx) idx = freshIdx();           // 损坏：用空索引覆盖（etag 保留，条件写照常工作）
    return { idx, etag: o.etag };
  }
  if (kv){
    const old = await readKvIndex(kv);
    if (old && Object.keys(old.files).length){
      const res = await bucket.put(IDX_R2_KEY, JSON.stringify(old));   // R2 无此 key，无竞争
      try { await kv.delete(IDX_KEY); } catch (e) {}
      return { idx: old, etag: res && res.etag };
    }
  }
  return { idx: freshIdx(), etag: null };
}

async function readKvIndex(kv){
  if (!kv) return null;
  const raw = await kv.get(IDX_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && d.files) return d;
  } catch (e) {}
  return null;
}

// 条件写通用骨架：mutate(idx) 原地修改索引并返回 true 表示有变更；
// etag 冲突时**重读最新索引重放同一份变更**（mutate 必须是可重放的纯逻辑），
// 最多 6 次。返回 false = 重放次数用尽（极罕见：同 key 毫秒级并发写）。
async function idxUpdate(bucket, kv, mutate){
  for (let i = 0; i < 6; i++){
    const cur = await idxLoad(bucket, kv);
    const idx = cur.idx;
    if (!mutate(idx)) return true;          // 没有需要落盘的变更
    // 索引还不存在时 cur.etag 为 null —— 若此时不带条件，多路并发会各自"无条件覆盖写"，
    // 最后一路胜出，**其余全部静默丢失**（实测 4 路并发只剩 1 条，且不会自愈）。
    // 用 etagDoesNotMatch:'*'（S3 If-None-Match:* 语义）把它变成"仅当不存在时创建"，
    // 于是并发建索引同样只有一路能成，其余走重试分支重读重放。
    const opt = cur.etag ? { onlyIf: { etag: cur.etag } } : { onlyIf: { etagDoesNotMatch: '*' } };
    const res = await bucket.put(IDX_R2_KEY, JSON.stringify(idx), opt);
    if (res && res.etag) return true;       // 条件满足，写入成功
    // etag 冲突 → 循环重读重放
  }
  return false;
}

// 没带 Content-Type 时，靠扩展名判断"这个文件值不值得索引正文"
const IDX_EXT_RE = /\.(txt|text|md|markdown|mdx|rst|adoc|org|log|csv|tsv|psv|json|json5|jsonc|jsonl|ndjson|geojson|ipynb|js|mjs|cjs|jsx|ts|tsx|mts|cts|vue|svelte|astro|css|scss|sass|less|styl|html?|xhtml|svg|xml|xsl|xslt|rss|atom|ya?ml|toml|ini|cfg|conf|config|cnf|properties|env|editorconfig|rc|lock|sh|bash|zsh|fish|ksh|bat|cmd|ps1|py|pyw|rb|go|mod|sum|rs|java|kt|kts|scala|groovy|gradle|c|h|cc|cpp|cxx|hpp|hh|cs|m|mm|swift|dart|lua|pl|pm|r|jl|php|sql|graphql|gql|proto|thrift|tex|bib|srt|vtt|diff|patch|pem|crt|cer|key|pub|asc|dockerfile|makefile|cmake|mk|tf|tfvars|hcl|nix|desktop|service|conf)$/i;
const IDX_MIME_TEXTY = /^(text\/|application\/(json|xml|javascript|ecmascript|x-yaml|yaml|toml|sql|graphql|x-sh|x-httpd-php|x-python|x-ruby|x-perl|x-latex|ld\+json|manifest\+json|x-ndjson|csv|rtf))/i;

function idxShouldRead(name, ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (c === 'application/octet-stream' || !c) return IDX_EXT_RE.test(String(name || ''));
  if (IDX_MIME_TEXTY.test(c)) return true;
  if (c.indexOf('image/') === 0 || c.indexOf('video/') === 0 || c.indexOf('audio/') === 0) return false;
  if (c.indexOf('application/vnd.openxmlformats') === 0) return false;
  return IDX_EXT_RE.test(String(name || ''));
}

function idxTextBytes(idx) {
  if (typeof idx.tb === 'number') return idx.tb;
  let n = 0;
  for (const k in idx.files) { const t = idx.files[k][4]; if (t) n += t.length; }
  idx.tb = n;
  return n;
}

// 环境变量 INDEX_TEXT_CAP 的上限也要夹在硬上限之内 —— 否则有人把它调到 10MB，
// 搜索请求会因为 JSON.parse 超 CPU 而直接 500/1102。
function idxCapOf(env){
  const c = numEnv(env && env.INDEX_TEXT_CAP, IDX_TEXT_CAP);
  return Math.min(c > 0 ? c : IDX_TEXT_CAP, IDX_TEXT_HARD_CAP);
}

// 索引正文配额快满时**渐进降级**：单文件片段 8K → … → 1K，
// 而不是原来的"要么整段留、要么完全不留"。这样配额能被用满，
// 索引体积又始终有界（搜索每次都要 JSON.parse 它）。
// 返回 0 = 放不下正文，该文件只按文件名参与搜索。
function idxAllowance(cap, total){
  const room = (cap > 0 ? cap : IDX_TEXT_CAP) - total;
  if (room >= IDX_PER_FILE) return IDX_PER_FILE;
  if (room >= IDX_PER_FILE_MIN) return room;
  return 0;
}

// 从原始字节里抽出用于搜索的正文（受 IDX_PER_FILE / IDX_SAMPLE_BYTES 双重约束）
function idxExtract(buf) {
  const u8 = new Uint8Array(buf);
  const cut = u8.subarray(0, Math.min(u8.length, IDX_SAMPLE_BYTES));
  const { enc, bom } = sniffEncoding(cut);
  const slice = idxSlice(cut, bom ? bom : 0);   
  let t = tryDecode(slice, enc, false);
  if (t === null) t = tryDecode(slice, 'utf-8', false) || '';
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  let truncated = (u8.length > slice.length);
  if (t.length > IDX_PER_FILE) { t = t.slice(0, IDX_PER_FILE); truncated = true; }
  return { text: t, truncated };
}
function idxSlice(u8, from) { return u8.subarray(Math.min(from, u8.length)); }

// 造一个索引条目：[状态, 体积, 类型, 修改时间, 正文片段]
// 状态 r：0=正文完整、1=可能截断、2=只有文件名（没索引正文）
// 返回的 keep 为 null 表示这次不保留正文（文件太大 / 类型不该索引 / 配额满了）。
function idxEntry(path, size, ct, mtimeMs, buf, cap, total){
  let text = null, truncated = false;
  if (buf && size > 0 && size <= IDX_FILE_SIZE_LIMIT && idxShouldRead(String(path).split('/').pop(), ct)) {
    const ex = idxExtract(buf);            // 解码只做一次（重放时直接复用结果）
    text = ex.text || null; truncated = ex.truncated;
  }
  let r = 2, keep = null, tr = truncated;
  const allow = idxAllowance(cap, total);        // 配额快满时自动缩短片段
  if (text && allow > 0){
    keep = text.length > allow ? text.slice(0, allow) : text;
    if (keep.length < text.length) tr = true;
    r = tr ? 1 : 0;
  }
  return [r, size, String(ct || ''), mtimeMs || Date.now(), keep];
}

// 写入（新增/覆盖）一个文件的索引。失败不影响主流程 —— 索引只是加速层。
// cap 由环境变量 INDEX_TEXT_CAP 决定，默认 1MB。
// **不 await**：调用方用 exec.waitUntil 把它挂到响应之后，上传不再等索引写完；
// 条件写保证并发/乱序也不会丢条目（冲突时重读重放）。
function idxUpsert(bucket, kv, path, buf, ct, mtimeMs, cap, exec){
  if (!path) return;
  const size = buf ? buf.byteLength : 0;
  const mutate = function(idx){
    const isNew = !idx.files[path];
    if (isNew && Object.keys(idx.files).length >= IDX_MAX_FILES) return false;
    const prev = idx.files[path];
    const prevLen = prev && prev[4] ? prev[4].length : 0;
    const total = idxTextBytes(idx) - prevLen;
    const e = idxEntry(path, size, ct, mtimeMs, buf, cap, total);
    idx.files[path] = e;
    idx.tb = total + (e[4] ? e[4].length : 0); idx.at = Date.now();
    return true;
  };
  const run = idxUpdate(bucket, kv, mutate);
  if (exec && exec.waitUntil) exec.waitUntil(run);
  return run;
}

// 单个路径失效（改名后也要同步搬走，所以拆成 remove + upsert 两步）
function idxRemove(bucket, kv, path, isDir, exec){
  if (!path) return;
  const mutate = function(idx){
    let hit = 0, total = idxTextBytes(idx);
    const pre = path + '/';
    for (const k in idx.files) {
      const match = (k === path) || (isDir && k.indexOf(pre) === 0);
      if (!match) continue;
      const t = idx.files[k][4];
      if (t) total -= t.length;
      delete idx.files[k];
      hit++;
    }
    if (!hit) return false;
    idx.tb = total; idx.at = Date.now();
    return true;
  };
  const run = idxUpdate(bucket, kv, mutate);
  if (exec && exec.waitUntil) exec.waitUntil(run);
  return run;
}

// 改名 / 移动后，把索引里的路径一起搬过去（否则搜索到的还是旧路径，点了会 404）
function idxRetarget(bucket, kv, from, to, isDir, exec){
  if (!from || !to || from === to) return;
  const mutate = function(idx){
    const pre = from + '/';
    const moves = [];
    for (const k in idx.files) {
      if (k === from) moves.push([k, to]);
      else if (isDir && k.indexOf(pre) === 0) moves.push([k, to + k.slice(from.length)]);
    }
    if (!moves.length) return false;
    for (const m of moves) { idx.files[m[1]] = idx.files[m[0]]; delete idx.files[m[0]]; }
    idx.at = Date.now();
    return true;
  };
  const run = idxUpdate(bucket, kv, mutate);
  if (exec && exec.waitUntil) exec.waitUntil(run);
  return run;
}

// ===== 分享 =====
// 分享文件：/s/<token> 直接吐出内容（浏览器里就是"一条链接看到正文"）
// 分享目录：/s/<token> 是只读浏览页
const TEXTY = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/i;

// HTML 单文档分享里"页面自己的"静态资源：按**扩展名**决定能不能放行、以及用什么类型回。
// 只放行被动资源（样式 / 图片 / 字体）—— 脚本类一律不在表里；加上 iframe 的沙箱与
// 响应头 CSP，一共三道闸。类型由这张表给出而不是照抄存储值，避免类型混淆。
const SHARE_ASSET_MIME = {
  css: 'text/css;charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
};
const HTML_EXT_RE = /^(html?|xhtml)$/i;
function isHtmlSharePath(p){ return HTML_EXT_RE.test(serverExtOf(p)); }

// 读出全部分享记录（带 token）
async function readShares(kv) {
  const out = [];
  if (!kv) return out;
  let cursor;
  do {
    const res = await kv.list({ prefix: 'share:', cursor, limit: 1000 });
    for (const k of (res.keys || [])) {
      const raw = await kv.get(k.name);
      if (!raw) continue;                       // 已过期被 KV 自动清掉的，直接跳过
      try {
        const d = JSON.parse(raw);
        out.push({
          key: k.name, token: k.name.slice(6), path: d.path || '',
          kind: d.kind === 'file' ? 'file' : 'dir', at: d.at || 0, exp: d.exp || 0
        });
      } catch (e) { /* 坏记录忽略 */ }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && out.length < 800);
  return out;
}

// 对象被删除后，把指向它的分享记录一并清掉，别留在列表里骗人
async function purgeShares(kv, path) {
  if (!kv || !path) return 0;
  const all = await readShares(kv);
  const hit = all.filter(s => s.path === path || s.path.startsWith(path + '/'));
  for (let i = 0; i < hit.length; i += 40) {
    await Promise.all(hit.slice(i, i + 40).map(s => kv.delete(s.key)));
  }
  return hit.length;
}

// 重命名 / 移动后，把分享记录指向新路径，避免链接突然失效
async function retargetShares(kv, oldPath, newPath) {
  if (!kv || !oldPath || oldPath === newPath) return 0;
  const all = await readShares(kv);
  let n = 0;
  for (const s of all) {
    let np = null;
    if (s.path === oldPath) np = newPath;
    else if (s.path.startsWith(oldPath + '/')) np = newPath + s.path.slice(oldPath.length);
    if (np === null) continue;
    const ttl = s.exp ? Math.floor((s.exp - Date.now()) / 1000) : 0;
    if (s.exp && ttl < 60) { await kv.delete(s.key); continue; }   // 快过期了，直接清掉
    await kv.put(s.key, JSON.stringify({ path: np, kind: s.kind, at: s.at, exp: s.exp }),
      ttl ? { expirationTtl: ttl } : undefined);
    n++;
  }
  return n;
}

// 分享状态：影子树（分享端真正读的）里有没有 → published；草稿树里有没有 → draft。
// 只要两边都空，这条分享记录才真的没意义了（可以清）；只在草稿里有 = 还没发布，
// 链接打得开但内容是空的 —— 列表里要如实标出来，引导用户去发布，而不是偷偷删掉。
async function shareState(bucket, s) {
  const suffix = s.kind === 'dir' ? '/' : '';
  const pub = await bucket.head(PUB + s.path + suffix);
  if (pub) return { published: true, draft: true, alive: true };
  const draft = await bucket.head(ROOT + s.path + suffix);
  return { published: false, draft: !!draft, alive: !!draft };
}

// 只读分享内容的实际构造（拆出来是为了让外层能套边缘缓存）。
// 注意读的是**已发布影子树** PUB，不是草稿树 ROOT —— 这样改草稿不会立刻影响分享链接。
async function buildSharedFile(bucket, path, url, cachable, shareBase) {
  const obj = await bucket.get(PUB + path);
  if (!obj) return html('<!doctype html><meta charset="utf-8"><h1>文件已被删除或分享已失效</h1>', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  let ct = headers.get('Content-Type') || 'application/octet-stream';
  const forceDl = url.searchParams.get('dl') === '1';
  const wantsRaw = url.searchParams.get('raw') === '1';
  const wantsDoc = url.searchParams.get('doc') === '1';
  // image/svg+xml 不在 TEXTY 里，但独立 SVG 文档同样能跑脚本 —— 直链一并按纯文本钉死。
  const isSvg = /^image\/svg/i.test(ct);
  const isTexty = TEXTY.test(ct) || isSvg;
  // HTML 单文档分享（text/html 与 application/xhtml+xml）四条出口：
  //   普通导航 → 壳页面（原文经 iframe 加载 ?doc=1，脚本不执行、跨源隔离）
  //   ?doc=1   → 原文 + 注入 <base>，给壳页面的 iframe 当"真文档"用（相对资源才解析得对）
  //   ?raw=1   → 纯文本原文（源码视图 / 脚本类客户端用）
  //   ?dl=1    → 强制下载；超过 HTML_SHELL_MAX → 一律退回纯文本源码
  const isHtml = /^(text\/html|application\/xhtml\+xml)/i.test(ct) || HTML_EXT_RE.test(serverExtOf(path));
  if (isHtml && !forceDl && obj.size <= HTML_SHELL_MAX) {
    if (wantsDoc) return sharedHtmlDoc(path, obj, shareBase || '/', cachable);
    if (!wantsRaw) return sharedHtmlShell(path, obj, cachable);
  }
  // 文本类内联显示一律按纯文本输出，浏览器才会直接显示正文而不是弹下载。
  // 注意：SVG 也走这条（独立 SVG 文档能跑脚本）；HTML 只有 ?raw=1 / 超过
  // HTML_SHELL_MAX 才会落到这里。强制下载（?dl=1）保留原类型 —— 下载看的是
  // Content-Disposition，与 Content-Type 无关，没必要把文件身份也改掉。
  if (isTexty && !forceDl) ct = 'text/plain;charset=utf-8';
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', cachable ? 'public, max-age=60' : 'no-store');
  headers.set('ETag', obj.httpEtag || '');
  if (obj.httpEtag) headers.set('X-Content-Etag', obj.httpEtag);

  const name = path.split('/').pop();

  // 文本且不是强制下载 → 顺手做编码识别，GBK 老文件也能正常显示，不设 Content-Disposition
  if (isTexty && !forceDl && obj.size <= 4 * 1024 * 1024) {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const sniff = sniffEncoding(bytes);
    // UTF-8 且无 BOM：原字节就是正确内容，直接回传，省掉整篇解码 + 重编码。
    // 内容没有变，ETag 依然代表响应体，保留它（转码路径才需要删）。
    if (sniff.enc === 'utf-8' && !sniff.bom) {
      headers.set('X-Text-Encoding', 'utf-8');
      return new Response(bytes, { headers });
    }
    const dec = decodeBytes(bytes);
    headers.set('X-Text-Encoding', dec.enc);
    headers.delete('ETag');                 // 转码后原始 etag 不再代表响应体
    return new Response(dec.text, { headers });
  }

  if (forceDl || !isTexty) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    headers.set('Content-Disposition',
      (forceDl ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
  }
  return new Response(obj.body, { headers });
}

// HTML 单文档分享的壳页面：原文只经 fetch(?raw=1) 取回、塞进 sandbox iframe 的 srcdoc，
// 不给 allow-scripts / allow-same-origin —— 脚本不执行、与主站跨源隔离，
// 与目录分享页里预览 HTML 是同一套机制（见前端 renderText 的 html 分支）。
// 为什么浏览器导航不能直接拿到 text/html：那等于让上传者的页面脚本跑在本站源上，
// 能带着会话 Cookie 打管理接口（HttpOnly 只防"读"cookie，不防"用"cookie）。
// 壳页面自身只注入文件名 / 体积 / 时间（转义或数字），不含任何用户内容。
const HTML_SHELL_MAX = 4 * 1024 * 1024;
function sharedHtmlShell(path, obj, cachable) {
  const name = path.split('/').pop();
  const mt = obj.uploaded instanceof Date ? obj.uploaded.getTime() : 0;
  const h = new Headers({
    'Content-Type': 'text/html;charset=utf-8',
    'Cache-Control': cachable ? 'public, max-age=60' : 'no-store'
  });
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)} · 分享预览</title>
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src data:; media-src data:; font-src data:; form-action 'none'; base-uri 'none'">
<style>
html,body{margin:0;height:100%;background:#fff;color:#2c2c2a;font:14px/1.6 system-ui,sans-serif}
#bar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#faf8f2;border-bottom:1px solid #e3dfd2;box-sizing:border-box;z-index:2}
#nm{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mt{color:#8a8678;font-size:12px;white-space:nowrap}
#warn{color:#a32d2d;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#bar .sp{flex:1}
.btn{appearance:none;border:1px solid #d3d1c7;background:#fff;color:#444;border-radius:6px;padding:3px 10px;font-size:12px;line-height:20px;cursor:pointer;text-decoration:none;flex:none}
.btn:hover{background:#f1efe8}
.btn.on{background:#d4a02a;border-color:#b8891f;color:#fff}
/* iframe 是替换元素：绝对定位时 top/bottom 同时设置会忽略 bottom、退回固有高度（默认 150px），
   所以必须显式写 height:calc(100% - 44px)（与顶栏等高抵消），只写 bottom:0 是不够的 */
#frame{position:fixed;top:44px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 44px);border:0;background:#fff}
#src{position:fixed;top:44px;left:0;right:0;bottom:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;box-sizing:border-box}
#tip{position:fixed;inset:44px 0 auto 0;z-index:1;margin:0;padding:24px 16px;background:#fff;color:#8a8678;font-size:13px}
[hidden]{display:none!important}
@media(max-width:720px){#warn{display:none}}
</style>
</head>
<body>
<div id="bar">
  <span id="nm">${escapeHtml(name)}</span>
  <span id="mt"></span>
  <span id="warn" title="隔离预览：页面脚本不会执行（防止上传的页面偷登录态）。页面自己的样式 / 图片会正常加载，第三方外链（别的域名上的 CSS / 图片 / JS）一律不加载。">隔离预览 · 脚本已禁用 · 只加载本分享内的资源</span>
  <span class="sp"></span>
  <button class="btn" id="bView" type="button">渲染</button>
  <button class="btn" id="bSrc" type="button">源码</button>
  <a class="btn" id="bDl" href="?dl=1" download>下载</a>
</div>
<iframe id="frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="HTML 预览（隔离）"></iframe>
<pre id="src" hidden></pre>
<p id="tip">载入中…</p>
<noscript><p style="padding:12px;color:#8a8678">此页面需要 JavaScript 才能渲染预览，可<a href="?raw=1">查看源码</a>或<a href="?dl=1">下载文件</a>。</p></noscript>
<script>
(function(){
  var frame = document.getElementById('frame'), src = document.getElementById('src'), tip = document.getElementById('tip');
  var bView = document.getElementById('bView'), bSrc = document.getElementById('bSrc');
  var text = null;      // 源码**按需**才取：打开页面只走"真文档"一条路，不再多打一次请求
  function fmtSize(n){ var u = ['B','KB','MB','GB'], i = 0; while(n >= 1024 && i < 3){ n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
  document.getElementById('mt').textContent = fmtSize(${obj.size || 0}) + (${mt} ? ' · ' + new Date(${mt}).toLocaleString() : '');
  function urlWith(k, v){ var u = new URL(location.href); u.searchParams.set(k, v); return u.pathname + u.search; }
  function show(m){
    frame.hidden = m !== 'rich';
    src.hidden = m !== 'src';
    bView.className = 'btn' + (m === 'rich' ? ' on' : '');
    bSrc.className = 'btn' + (m === 'src' ? ' on' : '');
    if (m === 'src' && text === null) loadSrc();
  }
  function loadSrc(){
    tip.hidden = false;
    tip.textContent = '正在取源码…';
    fetch(urlWith('raw', '1'), { credentials: 'same-origin' }).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function(t){
      text = t;
      src.textContent = t;        // 原样写入纯文本，不解析成 HTML
      tip.hidden = true;
    }).catch(function(e){
      tip.hidden = false;
      tip.textContent = '源码加载失败（' + e.message + '），可点「下载」把文件取回本地打开。';
    });
  }
  bView.onclick = function(){ show('rich'); };
  bSrc.onclick = function(){ show('src'); };
  // 「真文档」模式：iframe 直接加载 ?doc=1 —— 浏览器按**真实 URL** 解析相对路径，
  // 页面自己的 css / 图片 / 字体于是都能加载（服务端那条资源通道只放行被动类型）。
  // 沙箱不给 allow-scripts / allow-same-origin，文档自己还带一份服务端 CSP，脚本依旧死路。
  frame.addEventListener('load', function(){ tip.hidden = true; });
  frame.src = urlWith('doc', '1');
  bView.className = 'btn on';
})();
</script>
</body>
</html>`, { headers: h });
}

// ===== HTML 单文档分享的「真文档」模式（?doc=1）=====
// 把原文原样返回，只在文档开头附近注入一个 <base href="/s/<口令>/" target="_blank">，让页面里的
// 相对路径（自己的 css / 图片 / 字体）解析到**本分享范围内**的资源（由 serveShareAsset 提供），
// 同时让文档里的链接默认开新标签（否则点一下会把正文帧顶成错误页，见 sharedHtmlDoc 里的说明）。
// 为什么不改写相对路径：改写要解析 HTML，注入只要在开头找个锚点。
// 为什么走**字节拼接**而不是解码再编码：① 免掉整篇 decode + encode（免费版单请求只有
// 10ms CPU）；② 不动原文的编码声明，GBK / Big5 页面照样按原编码发给浏览器。
// 锚点是纯 ASCII，在 UTF-8 / GBK / Big5 里都能按字节找到；UTF-16 里找不到 → 跳过注入
// （页面照样能看，只是相对资源不解析 —— 属于极少数情况）。
const SHARE_DOC_CSP = "default-src 'none'; script-src 'none'; base-uri 'self'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "media-src 'self' data:; connect-src 'none'; form-action 'none'; " +
  "frame-src 'none'; object-src 'none'; frame-ancestors 'self'";
async function sharedHtmlDoc(path, obj, shareBase, cachable) {
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const sniff = sniffEncoding(bytes);
  const headers = new Headers({
    'Content-Type': 'text/html;charset=' + (sniff.enc || 'utf-8'),
    'Cache-Control': cachable ? 'public, max-age=60' : 'no-store',
    'Content-Security-Policy': SHARE_DOC_CSP
  });
  if (/^utf-16/i.test(sniff.enc || '')) return new Response(bytes, { headers });
  const base = shareBase.charAt(shareBase.length - 1) === '/' ? shareBase : shareBase + '/';
  // 注入的 <base> 顺带带上 target="_blank"，让文档里的链接**默认开新标签**。
  // 不加会怎样（无头 Chrome 实测过）：沙箱 iframe 里点一个没有 target 的外链，帧自身开始导航，
  // 被壳页面 CSP 的 frame-src 'self' 拦下 → Chrome 把整个正文帧换成 chrome-error:// 错误页，
  // 存档当场"废掉"，要刷新才回得来。论坛类页面（Discourse 等）正文链接绝大多数都不带 target，
  // 命中率极高 —— 实测一份 linux.do 存档：85 条链接里 70 条属于这一类。
  // 带 target="_blank" 后走 sandbox 的 allow-popups（+ escape-sandbox），新标签直接打开原站，
  // 存档页安然不动。这是"让链接可用"的最小改动：纯 HTML，不需要脚本。
  // 已知取舍：页内 #锚点也会跟着开新标签（Discourse 的 # 多是回复/分享按钮，在静态存档里
  // 本来就没意义）。<base target> 没有"只对跨站链接生效"的写法，而文档被关在无 allow-scripts
  // 的沙箱里，注入脚本那条路根本走不通 —— 这已经是纯 HTML 能做到的上限。
  return new Response(injectBaseTag(bytes, '<base href="' + escapeHtml(base) + '" target="_blank">'), { headers });
}

// 在 <head> 之后插入一段 ASCII 标记；退而求其次 doctype / <html> 之后，最后才前置。
// 只在前 8KB 里找锚点：正常的 head 一定在文档开头附近，全文扫描纯属浪费 CPU。
function injectBaseTag(u8, tag) {
  const mark = new TextEncoder().encode(tag);
  const limit = Math.min(u8.length, 8192);
  let pos = -1;
  const anchors = ['<head', '<!doctype', '<html'];
  for (let a = 0; a < anchors.length && pos < 0; a++) {
    const i = asciiIndexOf(u8, limit, anchors[a]);
    if (i < 0) continue;
    for (let j = i; j < limit; j++) {
      if (u8[j] === 62) { pos = j + 1; break; }      // 62 = '>'
    }
  }
  if (pos < 0) pos = 0;
  const out = new Uint8Array(u8.length + mark.length);
  out.set(u8.subarray(0, pos), 0);
  out.set(mark, pos);
  out.set(u8.subarray(pos), pos + mark.length);
  return out;
}

// ASCII 子串查找（大小写不敏感）—— 只做英文字母的大小写折叠，别把标点也一起"折叠"了
function asciiIndexOf(u8, limit, s) {
  const n = s.length;
  outer: for (let i = 0; i + n <= limit; i++) {
    for (let j = 0; j < n; j++) {
      const c = u8[i + j], t = s.charCodeAt(j);
      if (c !== t && !(t >= 97 && t <= 122 && c === t - 32)) continue outer;
    }
    return i;
  }
  return -1;
}

// 分享内的静态资源（页面里的相对引用打到这条）。
// rootDir = 资源根目录（相对存储根）：单文件分享是"被分享文件所在目录"，
// 目录分享就是"被分享的那个目录"。rel 是相对 rootDir 的路径。
// 三重限制：
//   ① 只放行 SHARE_ASSET_MIME 里的扩展名 —— 脚本类永远拿不到；
//   ② 路径必须落在 rootDir 内（复用 normPath + safeDir 归一化，与分享 API 同一套，
//      目录穿越从根上不成立）；
//   ③ 类型由白名单给出，不照抄存储值 —— 避免类型混淆（nosniff 之外再加一层）。
// 返回 null 表示"这不是一次资源请求"，交给上层按原来的逻辑处理。
// 结果整体走**边缘缓存**（与壳页面同一套）：命中时完全不碰 R2，省一次 Class B 读。
// 代价：改了 css / 图片重新发布后最多 60 秒才生效 —— 资源 URL 不可枚举，
// purgeShareCache 清不了它们，只能靠 max-age 自然过期。
async function serveShareAsset(bucket, rootDir, rel, url, exec) {
  const mime = SHARE_ASSET_MIME[serverExtOf(rel)];
  if (!mime) return null;
  const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  const key = url ? url.toString() : '';
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存不可用时直接回源 */ }
  }
  const obj = await bucket.get(PUB + safeDir(normPath(rootDir + '/' + normPath(rel))));
  if (!obj) return null;
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': cache ? 'public, max-age=60' : 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  // SVG 自己也是"文档"：单独再钉一份最严的 CSP，就算有人把它的地址直接打开也跑不了脚本
  if (serverExtOf(rel) === 'svg') {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }
  const resp = new Response(obj.body, { headers });
  if (cache && exec && exec.waitUntil) {
    try { exec.waitUntil(cache.put(key, resp.clone())); } catch (e) {}
  }
  return resp;
}

// 热门分享走边缘缓存：命中时完全不碰 R2，省一次 Class B 读。
// 缓存键就是原始请求 URL（含 token），所以取消分享后旧链接不会再命中。
async function serveSharedFile(bucket, path, url, exec, shareBase) {
  const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  if (!cache) return buildSharedFile(bucket, path, url, false, shareBase);

  const key = url.toString();
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch (e) { /* 缓存不可用时直接回源 */ }

  const resp = await buildSharedFile(bucket, path, url, true, shareBase);
  if (resp.status === 200 && exec && exec.waitUntil) {
    try { exec.waitUntil(cache.put(key, resp.clone())); } catch (e) {}
  }
  return resp;
}

// 真文档（?doc=1）也走边缘缓存，与壳页面同一套：命中时**完全不碰 R2**。
// 目录分享这条原来直接调 sharedHtmlDoc，每次加载文档都要读一次 R2 —— 成本测试逮到的
// 不一致（单文件分享走缓存、目录分享不走）。顺带把"必须是 html 且不太大"的校验也收进来，
// 不合格返回 null，让调用方照旧回落到资源通道 / 浏览页。
async function serveShareDoc(bucket, r2Path, url, exec, shareBase) {
  const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  const key = url ? url.toString() : '';
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (e) { /* 缓存不可用时直接回源 */ }
  }
  const obj = await bucket.get(PUB + r2Path);
  if (!obj) return null;
  const hct = (obj.httpMetadata && obj.httpMetadata.contentType) || '';
  // 后缀也认：有些 .html 存进来时 Content-Type 是空的（上传端没给），只看存储类型会永远进不了预览
  if ((!/^text\/html|^application\/xhtml/i.test(hct) && !HTML_EXT_RE.test(serverExtOf(r2Path))) || obj.size > HTML_SHELL_MAX) return null;
  const resp = await sharedHtmlDoc(r2Path, obj, shareBase, !!cache);
  if (cache && resp.status === 200 && exec && exec.waitUntil) {
    try { exec.waitUntil(cache.put(key, resp.clone())); } catch (e) {}
  }
  return resp;
}

// ===== PWA：动态图标 + manifest + service worker =====
// 让手机"添加到主屏幕"后是全屏独立 App 的样子（Android 的"安装"能力要求站点有 SW + manifest，
// iOS Safari 则看 apple-mobile-web-app-* 那组 meta）。全部动态生成，不引入任何二进制资源文件。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data){
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// 图标像素：琥珀色圆角方块 + 三道白线（"文本"的抽象，和应用logo同一套语言）。
// 线条画在内 30%~70% 的安全区里，同时满足 maskable（Android 圆形裁切）的要求。
// 只输出**索引**（0=透明 1=琥珀 2=白）而不是 RGBA —— 每像素写 1 字节而不是 4 字节，
// 配合索引色 PNG，512×512 的生成 CPU 从几十 ms 压到几 ms：Worker 免费版单请求
// CPU 限额 10ms，这是刻意把最重的计算压进限额里的关键。
function iconPixels(size){
  const w = size, h = size;
  const px = new Uint8Array(w * h);
  const r = Math.round(size * 0.22);
  const half = Math.max(1, Math.round(size * 0.036));
  const Ls = [[0.30, 0.70, 0.34], [0.30, 0.70, 0.50], [0.30, 0.56, 0.66]].map(L => ({
    y0: Math.round(L[2] * h) - half, y1: Math.round(L[2] * h) + half,
    x0: Math.round(L[0] * w), x1: Math.round(L[1] * w)
  }));
  const r2 = r * r;
  for (let y = 0; y < h; y++){
    let lx0 = -1, lx1 = -1;
    for (let k = 0; k < 3; k++){
      if (y >= Ls[k].y0 && y <= Ls[k].y1){ lx0 = Ls[k].x0; lx1 = Ls[k].x1; break; }
    }
    const cy = y < r ? r : (y >= h - r ? h - 1 - r : y);
    const row = y * w;
    for (let x = 0; x < w; x++){
      const cx = x < r ? r : (x >= w - r ? w - 1 - r : x);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;                   // 圆角外：保持 0（透明）
      px[row + x] = 1;                                        // 琥珀
      if (lx0 >= 0 && x >= lx0 && x <= lx1) px[row + x] = 2;  // 白线
    }
  }
  return px;
}

async function iconPng(size){
  const w = size, h = size;
  const px = iconPixels(size);
  const stride = w + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++){
    raw[y * stride] = 0;                            // PNG filter: None
    raw.set(px.subarray(y * w, (y + 1) * w), y * stride + 1);
  }
  // CompressionStream('deflate') 输出的正是 zlib 格式 —— PNG 的 IDAT 要的就是它
  const cs = new CompressionStream('deflate');
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 3;                         // 8bit 索引色（colorType 3）
  const plte = new Uint8Array([0, 0, 0, 212, 160, 42, 255, 255, 255]);
  const trns = new Uint8Array([0, 255, 255]);       // 索引 0 全透明，其余不透明
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0))
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts){ out.set(p, off); off += p.length; }
  return out;
}

// 同一 isolate 内只生成一次；响应再加浏览器长缓存，基本不会反复进到这里
const ICON_CACHE = new Map();
async function iconResponse(size){
  let png = ICON_CACHE.get(size);
  if (!png){
    png = await iconPng(size);
    ICON_CACHE.set(size, png);
  }
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}

function manifestResponse(title, adminPath){
  const name = title || '文本云盘';
  const m = {
    name: name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: '基于 Cloudflare Workers + R2 的文本云盘',
    // 必须指向管理路径而不是站点根：根路径在这个单文件 Worker 里没有页面，
    // start_url 填 '/' 的话，从主屏图标打开就是 404
    start_url: adminPath,
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#d4a02a',
    lang: 'zh-CN',
    icons: [
      { src: '/icon/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
  return new Response(JSON.stringify(m), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

// SW 只做两件安全的事：① 图标/manifest 走缓存优先（省流量）② 导航请求断网时给一个像样的离线页。
// **绝不缓存页面与 API 响应** —— 页面带着每次随机的 CSP nonce 和登录态，
// 缓存重放既可能失效也可能把"别人登录过的状态"留在共享设备上，得不偿失。
// SW 源码用数组拼装而不是模板字符串：它内部大量使用单引号字符串，
// 塞进外层模板串还得逐个双写反斜杠，没必要冒这个险。
function swResponse(){
  const SW_SRC = [
    "const SHELL_CACHE = 'cfwtxt-shell-v1';",
    "self.addEventListener('install', function(){ self.skipWaiting(); });",
    "self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });",
    "",
    "self.addEventListener('fetch', function(e){",
    "  var req = e.request;",
    "  if (req.method !== 'GET') return;",
    "  var url = new URL(req.url);",
    "  if (url.origin !== self.location.origin) return;",
    "  var p = url.pathname;",
    "  var isStatic = p.indexOf('/icon/') === 0 || p === '/manifest.webmanifest';",
    "  if (isStatic){",
    "    e.respondWith(caches.open(SHELL_CACHE).then(function(c){",
    "      return c.match(req).then(function(hit){",
    "        if (hit) return hit;",
    "        return fetch(req).then(function(res){",
    "          if (res && res.ok) c.put(req, res.clone());",
    "          return res;",
    "        });",
    "      });",
    "    }));",
    "    return;",
    "  }",
    "  if (req.mode === 'navigate'){",
    "    e.respondWith(fetch(req).catch(function(){",
    "      var body = '<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">'",
    "        + '<body style=\"margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9\">'",
    "        + '<div style=\"text-align:center;color:#57606a;font-family:system-ui\">'",
    "        + '<div style=\"font-size:42px\">&#9729;</div>'",
    "        + '<p style=\"font-size:15px;margin:10px 0 2px\">当前离线</p>'",
    "        + '<p style=\"font-size:13px;margin:0\">网络恢复后再试一次</p></div>';",
    "      return new Response(body, { status: 200,",
    "        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });",
    "    }));",
    "  }",
    "});"
  ].join('\n');
  return new Response(SW_SRC, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    }
  });
}

// ===== 主入口 =====
async function handleRequest(request, env, exec) {
    const bucket = env.R2 || env.BUCKET || env.MY_BUCKET;
    const kv = env.KV || null;
    const title = env.FILENAME || 'CF-Workers-TXT';
    const adminUuid = env.ADMIN_UUID;

    if (!adminUuid) {
      return html('<!doctype html><meta charset="utf-8"><h1>⚠️ 请先设置环境变量 ADMIN_UUID</h1>', 400);
    }
    if (!bucket) {
      return html('<!doctype html><meta charset="utf-8">' +
        '<h1>⚠️ 未绑定 R2 存储桶</h1>' +
        '<p>请在项目设置的「绑定 / Bindings」中新增一个 <b>R2 存储桶</b>，变量名必须填 <b>R2</b>，然后重新部署。</p>' +
        '<p>本项目需要 R2 来存放文件；KV 为可选项，仅用于分享链接与登录态。</p>', 400);
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const adminPath = '/' + adminUuid;

    // ---- PWA 静态件（放在限速之前：无存储访问、结果在 isolate 内缓存、浏览器长缓存） ----
    // 只认 GET/HEAD；图标尺寸限制在 16..1024，避免被当成任意尺寸图片生成器刷 CPU
    if (request.method === 'GET' || request.method === 'HEAD'){
      if (pathname === '/manifest.webmanifest') return manifestResponse(title, adminPath);
      if (pathname === '/sw.js') return swResponse();
      const mIcon = /^\/icon\/(\d+)\.png$/.exec(pathname);
      if (mIcon){
        const sz = parseInt(mIcon[1], 10);
        if (sz >= 16 && sz <= 1024) return iconResponse(sz);
        return new Response('Not Found', { status: 404 });
      }
    }

    // ---- CSRF：所有写操作必须来自同源（浏览器一定会带 Origin 头） ----
    // 不带 Origin 的客户端（curl 等）不构成 CSRF，放行；它们本来也拿不到登录 Cookie
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('Origin');
      if (origin) {
        let sameOrigin = false;
        try { sameOrigin = new URL(origin).host === url.host; } catch (e) { sameOrigin = false; }
        if (!sameOrigin) return json({ ok: false, error: '跨站请求已被拒绝' }, 403);
      }
    }

    // ---- 限速：每 IP 每分钟请求上限（RATE_LIMIT，0 关闭），防恶意刷 ----
    // 管理端的写操作（PUT 上传 / POST 建目录）不计入通用限速：
    // 上传文件夹会一次发出几十上百个请求，属于正常使用；
    // 这些操作本来就受密码 + CSRF 保护，公开放限速的 /s/* 访客面不受影响
    const nowMs = Date.now();
    const ip = ipOf(request);
    const isAdminWrite = (pathname === adminPath + '/api') &&
      (request.method === 'PUT' || request.method === 'POST' || request.method === 'DELETE');
    // 任何写操作都可能改动 R2 的 key 集合 → 补扫清单立刻作废，
    // 否则刚删掉的文件还能按文件名搜到最多 60 秒
    if (isAdminWrite) clearScanCache();
    const gen = isAdminWrite ? { ok: true } : rateTake('g:' + ip, numEnv(env.RATE_LIMIT, 240), nowMs);
    if (gen && !gen.ok) {
      return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429, { 'Retry-After': String(gen.retry) });
    }

    // ---------- 访客只读 ----------
    // 支持这些形式（末尾的文件名只是为了好看/给订阅类客户端识别后缀，不参与查找）：
    //   /s/<token>
    //   /s/<token>/光速雷达.yaml
    //   /sub/<token>            ← 兼容旧链接
    //   /sub/<token>/光速雷达.yaml
    const segs0 = pathname.split('/').filter(Boolean);
    if (segs0[0] === 's' || segs0[0] === 'sub') {
      const ns = segs0[0];
      const token = segs0[1] || url.searchParams.get('token') || '';
      if (!token) return html('<!doctype html><meta charset="utf-8"><h1>分享链接无效</h1>', 404);
      if (!kv) return html('<!doctype html><meta charset="utf-8"><h1>该站点未启用分享功能（未绑定 KV）</h1>', 404);
      const raw = await kv.get('share:' + token);
      if (!raw) return html('<!doctype html><meta charset="utf-8"><h1>分享链接无效或已被取消</h1>', 404);

      let scope = '';
      let kind = 'dir';
      try {
        const rec = JSON.parse(raw);
        scope = safeDir(rec.path || '');
        kind = rec.kind === 'file' ? 'file' : 'dir';
      } catch (e) { scope = ''; }

      const base = '/' + ns + '/' + token;
      const rest = segs0.slice(2);          // [] | ['api'] | ['文件名']

      // 单文件分享 → 直连返回内容（带不带文件名后缀都可以）
      if (kind === 'file') {
        if (rest[0] !== 'api') {
          // HTML 单文档分享：页面自己的 css / 图片 / 字体（相对路径）打到这条。它们**不吃
          // DOWNLOAD_LIMIT**（一个页面几十个资源是正常的），只受通用限速约束。
          // 只有"被分享的文件本身就是 HTML"才开资源通道：别的类型没这个需求，
          // 也不该顺手把同目录的资源暴露出去。
          if (isHtmlSharePath(scope) && rest.length) {
            const rel = rest.map(function(s){ try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
            if (rest.length > 1 || SHARE_ASSET_MIME[serverExtOf(rel)]) {
              const assetRoot = scope.indexOf('/') >= 0 ? scope.slice(0, scope.lastIndexOf('/')) : '';
              const asset = await serveShareAsset(bucket, assetRoot, rel, url, exec);
              if (asset) return asset;
              if (rest.length > 1) return text('Not Found', 404);   // 深层路径不是白名单资源 → 不再兜底
            }
          }
          // 分享内容是公开的，最容易被刷，单独一道更严的闸（DOWNLOAD_LIMIT，0 关闭）
          const dl = rateTake('d:' + ip, numEnv(env.DOWNLOAD_LIMIT, 60), nowMs);
          if (dl && !dl.ok) {
            return text('下载过于频繁，请稍后再试', 429, { 'Retry-After': String(dl.retry) });
          }
          return serveSharedFile(bucket, scope, url, exec, base);
        }
        return text('Not Found', 404);
      }

      // 目录分享 → 只读浏览页
      if (rest[0] === 'api') {
        return serveApi(request, url, { bucket, kv, readonly: true, scope, base, title, exec, env });
      }
      // /s/<口令>/<路径>：分享范围内的「真文档」与「静态资源」两条出口。
      // 为什么目录分享也要这两条：分享一个带 css / 图片的页面目录时，页面自己的资源
      // 必须能加载，否则分享出去的是个破图页。其余路径仍然回落到浏览页（保持原来的宽容）。
      if (rest.length) {
        const rel = rest.map(function(s){ try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
        if (url.searchParams.get('doc') === '1' && HTML_EXT_RE.test(serverExtOf(rel))) {
          const full = safeDir(normPath(scope + '/' + normPath(rel)));
          if (full) {
            const relDir = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
            const doc = await serveShareDoc(bucket, full, url, exec, base + '/' + relDir);
            if (doc) return doc;
          }
        }
        const asset = await serveShareAsset(bucket, scope, rel, url, exec);
        if (asset) return asset;
      }
      return html(appHtml({
        title, base, readonly: true,
        shareName: scope ? scope.split('/').pop() : '分享内容'
      }));
    }

    // ---------- 管理员 ----------
    if (pathname === adminPath || pathname === adminPath + '/api' || pathname.indexOf(adminPath + '/f/') === 0) {
      const isApi = pathname === adminPath + '/api';
      const hasPw = !!env.PASSWORD;

      // 登录态保持天数：默认 30 天；设 0 表示关闭浏览器即退出
      let sessDays = parseInt(env.SESSION_DAYS, 10);
      if (!isFinite(sessDays) || sessDays < 0) sessDays = 30;
      if (sessDays > 365) sessDays = 365;
      const cookieAttrs = '; Path=/; HttpOnly; Secure; SameSite=Lax';

      // 退出登录：清掉 Cookie 并回到登录页（放在鉴权之前，未登录时点也无害）
      if (!isApi && url.searchParams.get('action') === 'logout') {
        return html('<!doctype html><meta charset="utf-8"><script>location.replace(' +
          JSON.stringify(adminPath) + ');</script>', 302, {
          'Set-Cookie': 'wbauth=' + cookieAttrs + '; Max-Age=0',
          'Location': adminPath,
          'Cache-Control': 'no-store'
        });
      }

      // 登录（仅在设置了 PASSWORD 时存在）
      if (!isApi && request.method === 'POST' && url.searchParams.get('action') === 'login') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const failKey = 'loginfail:' + ip;

        // 失败次数限制：10 分钟内错 8 次就锁一会儿（KV 最终一致，属尽力而为）
        if (kv) {
          const n = parseInt(await kv.get(failKey), 10) || 0;
          if (n >= 8) return html(loginPage(title, '密码错误次数过多，请 10 分钟后再试'), 429);
        }

        const form = await request.formData().catch(() => null);
        const pass = form ? (form.get('password') || '') : '';

        if (String(pass) === String(env.PASSWORD || '')) {
          const val = await sha256Hex(env.PASSWORD + '::' + adminUuid);
          if (kv) await kv.delete(failKey);
          const maxAge = sessDays > 0 ? '; Max-Age=' + (sessDays * 86400) : '';
          return html('<!doctype html><meta charset="utf-8"><script>location.replace(' +
            JSON.stringify(adminPath) + ');</script>', 302, {
            'Set-Cookie': 'wbauth=' + val + cookieAttrs + maxAge,
            'Location': adminPath,
            'Cache-Control': 'no-store'
          });
        }

        if (kv) {
          const n = (parseInt(await kv.get(failKey), 10) || 0) + 1;
          await kv.put(failKey, String(n), { expirationTtl: 600 });
        }
        return html(loginPage(title, '密码错误'), 401);
      }

      // 鉴权（仅当设置了 PASSWORD）
      if (hasPw) {
        const cookie = request.headers.get('Cookie') || '';
        const m = cookie.match(/(?:^|;\s*)wbauth=([^;]+)/);
        const expect = await sha256Hex(env.PASSWORD + '::' + adminUuid);
        if (!m || m[1] !== expect) {
          return isApi
            ? json({ ok: false, error: '登录已过期，请刷新页面重新登录' }, 401)
            : html(loginPage(title, ''), 401);
        }
      }

      // ---- 管理端文件直出：/<ADMIN>/f/<路径> ----
      // 给编辑器里的 HTML 预览当"真文档"用：iframe 直接加载它，相对路径才解析得对，
      // 页面自己的 css / 图片才会加载。原理与分享页的 ?doc=1 完全一样（同一个构建器），
      // 只是前缀换成管理端路径、数据源是**草稿树**，并且同样受登录态保护。
      if (pathname.indexOf(adminPath + '/f/') === 0) {
        // 路径是百分号编码过的（前端 encPath），必须先逐段解码再归一化 ——
        // 否则带中文 / 空格的目录名对不上 R2 里的 key，一律 404。
        const rawRel = pathname.slice((adminPath + '/f/').length);
        const rel = safeDir(rawRel.split('/').filter(Boolean)
          .map(function(s){ try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/'));
        if (!rel) return text('Not Found', 404);
        const obj = await bucket.get(ROOT + rel);
        if (!obj) return text('Not Found', 404);
        const fct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
        const fdir = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
        // 后缀也认：存进来时 Content-Type 可能是空的（上传端没给 file.type），只看存储类型预览会坏
        if ((/^text\/html/i.test(fct) || HTML_EXT_RE.test(serverExtOf(rel))) && url.searchParams.get('doc') === '1' && obj.size <= HTML_SHELL_MAX) {
          return sharedHtmlDoc(rel, obj, adminPath + '/f/' + fdir, false);
        }
        const fh = new Headers({ 'Content-Type': fct, 'Cache-Control': 'private, max-age=30' });
        if (obj.httpEtag) fh.set('ETag', obj.httpEtag);
        if (/^image\/svg/i.test(fct)) fh.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        return new Response(obj.body, { headers: fh });
      }

      if (!isApi) {
        return html(appHtml({ title, base: adminPath, readonly: false, hasPw: hasPw, sessDays: sessDays }));
      }
      return serveApi(request, url, { bucket, kv, readonly: false, scope: '', base: adminPath, title, exec, env });
    }

    return html('<!doctype html><meta charset="utf-8"><h1>Not Found</h1>', 404);
  }

// 索引条目 → 搜索结果的公共形状
function idxToResult(path, e) {
  return {
    path,
    size: e[1] || 0,
    ct: e[2] || '',
    mtime: e[3] ? new Date(e[3]).toISOString() : ''
  };
}

// 大小写不敏感的查找，且**不对正文做 toLowerCase**（那是几十 MB 的临时分配，
// 会把免费版 10ms 的 CPU 配额直接吃光）。改成对原文查两遍，零额外分配。
// 大小写不敏感查找。旧实现只尝试"全小写 / 全大写"两种形式，混合大小写会漏配 ——
// 现在文本 ≤256KB 时统一 toLowerCase（索引片段只有 8K，毫无压力）；
// 超大文本（深搜大文件）才退回两次 indexOf，避免 toLowerCase 的 CPU 开销。
// word=true 时要求命中两侧都不是字母/数字/下划线（"cat" 不再命中 category）。
function wordOkAt(low, i, len){
  const a = i > 0 ? low[i - 1] : '';
  const b = i + len < low.length ? low[i + len] : '';
  return !/[a-z0-9_]/i.test(a) && !/[a-z0-9_]/i.test(b);
}

// 解析搜索框里的轻量语法（服务端、前端共用一套规则）：
//   ext:md      → 只搜 Markdown（后缀过滤，可带点）
//   path:笔记    → 只搜「笔记」目录下的内容
//   "cat"       → 双引号包裹 = 整词匹配（cat 不再命中 category）
// 剩余部分按空白拆成**多个关键词，全部命中才算匹配（AND）** ——
// 「fniao 去重」只返回同时含这两个词的文件，而不是去匹配「fniao 去重」这个整串。
// 语法可以混用：ext:log path:日志 timeout 失败
function parseSearchQuery(raw){
  let ext = '', dir = '', word = false, q = String(raw || '');
  q = q.replace(/(^|\s)ext:(\S+)/i, (m, sp, v) => { ext = v.replace(/^\./, ''); return sp; });
  q = q.replace(/(^|\s)path:(\S+)/i, (m, sp, v) => { dir = v; return sp; });
  q = q.trim();
  if (q.length >= 2 && q.charAt(0) === '"' && q.charAt(q.length - 1) === '"'){
    word = true; q = q.slice(1, -1);
  }
  const terms = [];
  const parts = q.split(/\s+/);
  for (let i = 0; i < parts.length; i++){
    if (parts[i]) terms.push(parts[i]);
  }
  if (terms.length > 8) terms.length = 8;      // 上限，防止超长查询把 CPU 拖爆
  return { q, terms, ext, dir, word };
}

// 与 ciFind 同一套规则，但**调用方已经给好小写文本**。
// 多关键词搜索会对同一个文件名 / 路径 / 正文反复匹配多个词，
// 每词都 toLowerCase 一次纯属浪费 —— 统一在调用方转一次小写再传进来。
function ciFindLow(lowText, lowQ, from, word) {
  if (!lowText || !lowQ) return -1;
  let i = lowText.indexOf(lowQ, from || 0);
  while (word && i >= 0) {
    if (wordOkAt(lowText, i, lowQ.length)) return i;
    i = lowText.indexOf(lowQ, i + 1);
  }
  return i;
}

function ciFind(text, q, qUpper, from, word) {
  if (!text) return -1;
  const st = from || 0;
  if (text.length <= 262144){
    const low = text.toLowerCase();
    const ql = (q || '').toLowerCase();
    if (!ql) return -1;
    let i = low.indexOf(ql, st);
    while (word && i >= 0){
      if (wordOkAt(low, i, ql.length)) return i;
      i = low.indexOf(ql, i + 1);
    }
    return i;
  }
  let i = text.indexOf(q, st);
  if (i < 0 && qUpper !== q) i = text.indexOf(qUpper, st);
  return i;
}

// 在正文里找出命中位置，截取上下文片段（给前端做高亮用）
function hitSnippet(text, q, qUpper, span, word) {
  if (!text) return null;
  const i = ciFind(text, q, qUpper, 0, word);
  if (i < 0) return null;
  const s = Math.max(0, i - (span || 40));
  const e = Math.min(text.length, i + q.length + (span || 60));
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/[\r\n\t]+/g, ' ') + (e < text.length ? '…' : '');
}

// 搜索时的 R2 补扫：列出 R2 里所有对象，返回 [[相对路径, size, contentType, mtimeMs], ...]。
// 这是"索引只是加速层、R2 才是真相"的兜底，保证文件名永远搜得到。
// 但它每次搜索都要跑一遍：索引完整时扫完一个缺失文件都没有，却仍要付 1~5 次 list 的延迟。
// 所以给结果加 60 秒内存缓存 —— 窗口内的重复搜索（改词、再搜一次）直接复用。
// 代价只有"从 Worker 之外写进 R2 的文件最多晚 60 秒才能按文件名搜到"；
// 经本 Worker 的写操作（上传/删除/重命名/移动/建目录）会调 clearScanCache() 立即失效。
const SCAN_TTL = 60 * 1000;
const SCAN_CACHE_MAX = 4;                 // 每个 bucket 最多缓存几个前缀（管理端 + 若干分享目录）
// 按 bucket 分桶：缓存绝不能跨 bucket 复用 —— 否则换一个 R2 绑定（或多盘部署）会读到别人的清单。
let scanCache = new WeakMap();            // bucket -> Map(prefix -> { at, items })
function scanCacheOf(bucket){
  let m = scanCache.get(bucket);
  if (!m){ m = new Map(); scanCache.set(bucket, m); }
  return m;
}
function clearScanCache(){ scanCache = new WeakMap(); }
function scanIsCached(bucket, prefix){
  const m = scanCache.get(bucket);
  if (!m) return false;
  const hit = m.get(prefix);
  return !!(hit && Date.now() - hit.at < SCAN_TTL);
}

// rootLen：从 key 里切掉多少字符才能得到"相对根目录"的路径。
// 管理端扫 ROOT（'d/'，2 字符），分享端扫 PUB（'__pub__/'，8 字符）——
// 长度不同，所以必须由调用方传进来，不能写死 ROOT.length。
async function scanR2(bucket, prefix, rootLen){
  const rl = rootLen == null ? ROOT.length : rootLen;
  const now = Date.now();
  const m = scanCacheOf(bucket);
  const hit = m.get(prefix);
  if (hit && now - hit.at < SCAN_TTL) return hit.items;
  const items = [];
  let cursor, scanned = 0;
  do {
    const res = await bucket.list({ prefix, cursor, limit: 1000,
      include: ['httpMetadata', 'customMetadata'] });
    for (const o of res.objects) {
      scanned++;
      if (o.key.endsWith('/')) continue;          // 目录占位对象不算文件
      const rp = o.key.slice(rl);                 // 与索引 key 保持同一坐标系
      if (!rp) continue;
      const cm = o.customMetadata || {};
      const mt = parseInt(cm.mtime || '', 10);
      items.push([rp, o.size, (o.httpMetadata && o.httpMetadata.contentType) || '',
        isFinite(mt) ? mt : (o.uploaded instanceof Date ? o.uploaded.getTime() : 0)]);
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && scanned < IDX_SCAN_MAX);
  if (m.size >= SCAN_CACHE_MAX) m.delete(m.keys().next().value);
  m.set(prefix, { at: now, items });
  return items;
}

// ===== API =====
async function serveApi(request, url, ctx) {
  const { bucket, kv, readonly, scope, base, exec, env } = ctx;
  const method = request.method;
  // 索引正文总量上限，可用 INDEX_TEXT_CAP 覆盖（付费版 CPU 充裕时可以调大），
  // 但一律夹在 IDX_TEXT_HARD_CAP 之内
  const idxCap = idxCapOf(ctx.env);

  // 访客的全部路径都挂到分享目录下，天然无法越界
  const toFull = rel => safeDir(readonly ? normPath(scope + '/' + normPath(rel)) : normPath(rel));
  // 读取根：管理员读草稿树，访客读已发布影子树。本函数内所有 R2 读路径都走 R，
  // 这样"编辑"与"分享"物理隔离 —— 改草稿不会影响分享页，必须发布才可见。
  const R = readonly ? PUB : ROOT;
  // 全盘扫描类接口（目录树 / 搜索）也必须只扫分享目录内部，
  // 否则访客能从左侧树或搜索里看到分享范围之外的东西
  const scanBase = readonly ? PUB + (scope ? scope + '/' : '') : ROOT;
  const shareName = scope ? scope.split('/').pop() : '分享内容';

  try {
    // ---- GET：列表 / 读文件 / 下载 ----
    if (method === 'GET') {
      const action = url.searchParams.get('action') || 'list';
      const rel = url.searchParams.get('path') || '';

      if (action === 'list') {
        const dir = toFull(rel);
        const pageSize = parseInt(url.searchParams.get('pageSize') || '', 10) || 0;
        const cursor = url.searchParams.get('cursor') || '';
        const sort = url.searchParams.get('sort') || 'name';
        const desc = url.searchParams.get('desc') === '1';
        const data = await listDir(bucket, dir, { pageSize, cursor, sort, desc }, R);
        return json({ ok: true, path: dir, ...data });
      }

      // 左侧导航树：只返回某一层的子文件夹，前端按需展开（保留兼容）
      if (action === 'tree') {
        const dir = toFull(rel);
        const data = await listDir(bucket, dir, null, R);
        return json({ ok: true, path: dir, folders: data.folders, files: data.files.map(f => f.name) });
      }

      // 文件清单（用于上传前判断"云端是不是已经有同名文件"）
      // 只回传路径 / 大小 / 原始修改时间，不回传内容
      if (action === 'manifest') {
        const dir = toFull(rel);
        const base = R + (dir ? dir + '/' : '');
        const entries = [];
        let cursor, scanned = 0, truncated = false;
        do {
          const res = await bucket.list({ prefix: base, cursor, limit: 1000, include: ['customMetadata'] });
          for (const o of res.objects) {
            if (o.key.slice(-1) === '/') continue;          // 目录占位不算文件
            const rp = o.key.slice(base.length);
            if (!rp) continue;
            const cm = o.customMetadata || {};
            const mt = parseInt(cm.mtime || '', 10);
            entries.push({
              p: rp,
              s: o.size,
              m: isFinite(mt) ? mt : 0,
              t: o.uploaded instanceof Date ? o.uploaded.getTime() : 0
            });
          }
          scanned += res.objects.length;
          cursor = res.truncated ? res.cursor : undefined;
        } while (cursor && scanned < 20000);
        if (cursor) truncated = true;
        return json({ ok: true, path: dir, entries, truncated });
      }

      // 完整目录树：一次请求拿到整棵结构 + 每层子项数量，左侧导航据此渲染
      if (action === 'treeFull') {
        const r = await buildFullTree(bucket, {
          prefix: scanBase,
          rootName: readonly ? shareName : '根目录',
          withProtected: !readonly
        });
        return json({ ok: true, ...r });
      }

      // ---- 搜索（管理端全文索引版；分享页仅文件名/路径）----
      // 索引负责正文匹配（不读 R2 对象），但**索引只是加速层，R2 才是真相**：
      // 凡是在 R2 里、却不在索引里的文件（在 Worker 之外传进来的、索引写入失败的、
      // 重建到一半的），这里用一次"只列 key、不读正文"的扫描补进来，
      // 保证文件名永远搜得到。代价只有 1~5 次 list，不会因为索引不完整而静默漏文件。
      // 分享页（访客）**不加载索引**：files 完全由 R2 补扫建出来，因此只支持
      // 文件名/路径命中，正文不参与匹配 —— 这样就不必为影子树单独维护一份索引，
      // 也杜绝了"把没发布的草稿正文泄进搜索结果"的可能。
      if (action === 'search') {
        // 语法直接内嵌在 q 里由服务端解析（ext:/path:/"整词"/空格=AND），URL 保持单参数
        const parsed = parseSearchQuery(url.searchParams.get('q'));
        const terms = parsed.terms;
        const lows = terms.map(function(t){ return t.toLowerCase(); });
        const word = parsed.word || url.searchParams.get('word') === '1';
        const extF = (parsed.ext || '').toLowerCase();
        const dirF = parsed.dir || '';
        // 只有过滤词（ext:/path:）没有关键词时 = "列出这一类文件"，允许关键词为空
        if (!lows.length && !extF && !dirF) {
          return json({ ok: true, results: [], total: 0, terms: [], indexed: false, full: true });
        }
        const hasQ = lows.length > 0;
        // 结果类型筛选（服务端过滤 —— 分页、总数、"还有 N 条"都跟着一起变，
        // 不会出现"只筛了当前这一页"的假象）：
        //   name = 只看文件名命中 / path = 只看路径命中 / text = 只看正文命中 / dir = 只看文件夹
        const ftypeRaw = (url.searchParams.get('ftype') || '').toLowerCase();
        const ftype = (ftypeRaw === 'name' || ftypeRaw === 'path' ||
          ftypeRaw === 'text' || ftypeRaw === 'dir') ? ftypeRaw : '';
        // 分页：默认一页 60 条、最多 200 条 —— 结果多时前端「加载更多」再取下一页，
        // 而不是像以前那样一次塞 300 条进 DOM（大列表渲染反而更慢、更卡）。
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '', 10) || 60, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '', 10) || 0, 0);

        const il = readonly ? null : await idxLoad(bucket, kv);
        const idx = il && il.idx;
        const files = (idx && idx.files) ? idx.files : {};
        const idxCount = Object.keys(files).length;   // 索引里到底有多少条（补扫前的真数）
        const hadIdx = idxCount > 0;

        // 补扫：把 R2 里有、索引里没有的文件按「仅文件名」补进来（r=2，不参与正文匹配）。
        // 索引为空时也走这条 —— 此时 files 完全由 R2 建出来，等价于"无索引直扫"。
        // 索引只是加速层、R2 才是真相：这样文件名永远不会因为索引缺失而静默搜不到。
        // （正常情况下这个集合是空的：保存时同步建了索引。只有从控制台/S3/rclone 直接
        //   放进 R2 的文件才会落到这里 —— 那种点一下"重建 / 更新正文索引"即可补上正文。）
        let stale = 0;
        var scanHit = false;
        {
          const seen = new Set(Object.keys(files));
          scanHit = scanIsCached(bucket, scanBase);      // 本次是否直接复用了 60s 内的清单
          const items = await scanR2(bucket, scanBase, R.length);   // 60 秒内复用同一份清单，重复搜索不再重扫 R2
          for (const it of items) {
            const rp = it[0];
            if (seen.has(rp)) continue;
            files[rp] = [2, it[1], it[2], it[3], null];
            seen.add(rp);
            if (hadIdx) stale++;
          }
        }
        const total = Object.keys(files).length;

        const all = [];                          // { s: 相关度分, r: 结果行 }
        const dirs = {};                         // 目录名命中的祖先目录 → 独立「文件夹」条目
        let nameHits = 0, pathHits = 0, dirHits = 0, textHits = 0, cutHits = 0;
        const extRe = extF ? new RegExp('\\.' + extF.replace(/[^a-z0-9.]/g, '') + '$', 'i') : null;
        const COLLECT_MAX = 5000;                // 最多评分多少个文件，防止超大网盘把 CPU 吃光

        {
          const pre = (readonly && scope) ? scope + '/' : '';
          for (const p in files) {
            // 访客只能看到分享范围；而且返回的路径要相对分享根目录，
            // 否则分享页里的 openPath 会拼成 .. / 分享目录 的重复路径
            let relPath = p;
            if (pre){
              if (p.indexOf(pre) !== 0) continue;
              relPath = p.slice(pre.length);
            }
            if (!relPath) continue;
            if (extRe && !extRe.test(relPath)) continue;
            if (dirF && relPath !== dirF && relPath.indexOf(dirF + '/') !== 0) continue;
            const e = files[p];
            const segs = relPath.split('/');
            const base = segs.pop();              // basename（原始大小写，给前端显示）
            const lowName = base.toLowerCase();
            const lowPath = relPath.toLowerCase();

            // ---- 多关键词 AND + 相关度评分 ----
            // 每个关键词都必须落在「文件名 / 路径 / 正文」三者之一，否则整条不匹配。
            // 命中越"靠前"（文件名 > 路径 > 正文）分越高，多词全中再加成。
            let score = 0, allName = true, allPath = true, allBody = true, miss = false;
            let lowBody = null, bodyReady = false;      // 正文小写只在真正需要时才转换
            let firstBodyAt = -1, firstBodyTerm = '';
            for (let ti = 0; ti < lows.length; ti++) {
              const t = lows[ti];
              const ni = ciFindLow(lowName, t, 0, word);
              const pi = (ni >= 0) ? -1 : ciFindLow(lowPath, t, 0, word);
              let bi = -1;
              if (ni < 0 && pi < 0) {
                if (!bodyReady) { bodyReady = true; lowBody = e[4] ? e[4].toLowerCase() : ''; }
                bi = ciFindLow(lowBody, t, 0, word);
                if (bi < 0) { miss = true; break; }   // 有一个词哪儿都没有 → 整条淘汰
              }
              if (ni >= 0) score += 60; else allName = false;
              if (pi >= 0) score += 15; else allPath = false;
              if (bi >= 0) {
                score += 5;
                if (firstBodyAt < 0 || bi < firstBodyAt) { firstBodyAt = bi; firstBodyTerm = t; }
              } else allBody = false;
            }
            if (miss) continue;

            // 命中位置细分：文件名命中（basename）≠ 路径命中（目录段带着命中）
            // —— 搜「fniao」时 fniao/x.txt 是**路径**命中，不该标成「文件名」
            const nameHit = hasQ ? allName : true;
            const pathHit = hasQ ? (!allName && allPath) : false;
            if (nameHit) score += 120;                  // 关键词全在文件名里
            if (pathHit) score += 30;
            if (allBody) score += 10;
            if (hasQ && lows.length === 1) {
              const dot = base.lastIndexOf('.');
              const stem = dot > 0 ? base.slice(0, dot) : base;
              if (stem.toLowerCase() === lows[0]) score += 400;   // 去掉扩展名后完全相等
            }
            if (hasQ && lowName.indexOf(lows[0]) === 0) score += 80;  // 文件名以首个关键词开头

            // 正文片段：以**最早那次正文命中**为中心截取，保证关键词落在片段里（前端才能高亮）。
            // 旧实现取片段/行首，长行里的命中会被切掉，于是"一个高亮都没有"。
            let snip = null, cnt = 0;
            if (firstBodyAt >= 0 && e[4]) {
              const s = Math.max(0, firstBodyAt - 40);
              const en = Math.min(e[4].length, firstBodyAt + firstBodyTerm.length + 60);
              snip = (s > 0 ? '…' : '') + e[4].slice(s, en).replace(/[\r\n\t]+/g, ' ') +
                (en < e[4].length ? '…' : '');
              let from = firstBodyAt;                 // 该词在这段正文里的出现次数（上限 200）
              while (cnt < 200) {
                const j = ciFindLow(lowBody, firstBodyTerm, from, word);
                if (j < 0) break;
                cnt++; from = j + Math.max(1, firstBodyTerm.length);
              }
            }

            // 目录名命中：把命中的祖先目录收集起来，稍后作为「文件夹」条目返回
            if (pathHit){
              let acc = '';
              for (let si = 0; si < segs.length; si++){
                acc = acc ? acc + '/' + segs[si] : segs[si];
                const segLow = segs[si].toLowerCase();
                let ok = true;
                for (let ti = 0; ti < lows.length; ti++) {
                  if (ciFindLow(segLow, lows[ti], 0, word) < 0) { ok = false; break; }
                }
                if (ok) dirs[acc] = 1;
              }
            }

            if (nameHit) nameHits++;
            else if (pathHit) pathHits++;
            else {
              textHits++;
              // 正文只索引了前 8K，命中可能截断 —— 标记出来，前端会提示"深搜此文件"
              if (e[0] === 1) cutHits++;
            }
            // 类型筛选放在计数之后：计数要如实反映各类型的总量（筛选芯片上要显示），
            // 但结果列表只留当前选中的那一类。
            if (ftype === 'name' && !nameHit) continue;
            if (ftype === 'path' && !pathHit) continue;
            if (ftype === 'text' && (nameHit || pathHit)) continue;
            if (ftype === 'dir') continue;              // 只看文件夹：文件一个都不留
            const r = idxToResult(relPath, e);
            r.nameHit = nameHit;
            r.pathHit = pathHit;
            r.snippet = snip;
            r.cnt = cnt;
            r.cut = e[0] == null ? 2 : e[0];
            all.push({ s: score, r: r });
            if (all.length >= COLLECT_MAX) break;
          }
        }

        // 文件夹条目排最前：搜目录名时，大众最想看到的先是那个文件夹本身
        const dirNames = Object.keys(dirs).sort(function(a, b){ return a.localeCompare(b, 'zh'); });
        for (const dn of dirNames){
          dirHits++;
          if (ftype && ftype !== 'dir') continue;     // 只看某类命中时，不塞文件夹条目
          all.push({ s: 1e6, r: { path: dn, isDir: true, dirHit: true, nameHit: false, pathHit: true,
            snippet: null, cnt: 0, cut: 2, size: 0, ct: '', mtime: '' } });
        }

        // 相关度降序；同分按中文路径序 —— 同一个查询每次顺序都一样（结果稳定，不会跳来跳去）
        all.sort(function(a, b){
          if (b.s !== a.s) return b.s - a.s;
          return a.r.path.localeCompare(b.r.path, 'zh');
        });
        const matched = all.length;
        const page = all.slice(offset, offset + limit).map(function(x){ return x.r; });

        return json({
          ok: true, results: page, terms: terms, total: matched, offset: offset, limit: limit,
          hasMore: offset + page.length < matched, ftype: ftype,
          indexed: hadIdx, indexedCount: idxCount, stale,
          nameHits, pathHits, dirHits, textHits, cutHits, at: idx ? idx.at : 0,
          capFull: !!(idx && idxTextBytes(idx) >= idxCap), scanCached: scanHit
        });
      }

      // 索引状态：前端用它显示"已索引 N 个文件"并决定要不要提示建索引
      if (action === 'idxstat') {
        const il = await idxLoad(bucket, kv);
        const idx = il.idx;
        let full = 0, part = 0, none = 0, count = 0;
        const files = (idx && idx.files) ? idx.files : {};
        const pre = (readonly && scope) ? scope + '/' : '';
        for (const p in files) {
          if (pre && p.indexOf(pre) !== 0) continue;    // 访客只统计分享范围内的
          const r = files[p][0];
          if (r === 0) full++; else if (r === 1) part++; else none++;
          count++;
        }
        return json({
          ok: true, hasKv: !!kv, count, full, part, none,
          at: idx ? idx.at : 0, textCap: idxCap
        });
      }

      // 深搜单个文件：索引只留了前 8K，怀疑正文深处还有命中时用它精确验证
      if (action === 'deepsearch') {
        const parsed = parseSearchQuery(url.searchParams.get('q'));
        const terms = parsed.terms;
        const lows = terms.map(function(t){ return t.toLowerCase(); });
        const word = parsed.word || url.searchParams.get('word') === '1';
        const full = toFull(rel);
        if (!full || !lows.length) return json({ ok: false, error: '缺少 path 或 q' }, 400);
        const obj = await bucket.get(R + full);
        if (!obj) return json({ ok: false, error: '文件不存在' }, 404);
        if (obj.size > 4 * 1024 * 1024) return json({ ok: false, error: '文件超过 4MB，无法在线深搜' }, 413);
        const dec = decodeBytes(new Uint8Array(await obj.arrayBuffer()));

        // 某一行是否**同时含全部关键词**（与搜索列表同一套 AND 语义）
        const lineOk = function(lineLow){
          for (let i = 0; i < lows.length; i++){
            if (ciFindLow(lineLow, lows[i], 0, word) < 0) return false;
          }
          return true;
        };
        // 某个词在一段（小写）文本里的出现次数，带上限防止超长行空转
        const occIn = function(low, t, cap){
          let n = 0, from = 0;
          while (n < cap){
            const j = ciFindLow(low, t, from, word);
            if (j < 0) break;
            n++; from = j + Math.max(1, t.length);
          }
          return n;
        };

        // 命中行号列表（≤512KB 的文件才生成：超大文本 split 行数组会吃掉免费版 CPU 预算），
        // 前端用它做"点击跳到那一行"。
        // count = 全文命中总次数（处），lines = 同时含全部关键词的行数 ——
        // 两个数都要给：标题里"共 N 处（M 行）"才是用户想知道的。
        let hits = null, hitsMore = false, count = 0, lines = 0;
        if (dec.text.length <= 512 * 1024){
          hits = [];
          const arr = dec.text.split('\n');
          for (let li = 0; li < arr.length; li++){
            const ln = arr[li];
            const lnLow = ln.toLowerCase();
            if (!lineOk(lnLow)) continue;
            lines++;
            const occ = occIn(lnLow, lows[0], 200);   // 该行里首个关键词的出现次数
            count += occ;
            if (hits.length >= 200){ hitsMore = true; continue; }   // 继续数，只是不再列出来
            // 片段以**命中位置为中心**截取。原来是取行首 200 字符，
            // 长行（JSON 单行、长段落）里的命中会被切掉 → 弹窗里一个高亮都没有。
            hits.push({ n: li + 1, c: occ,
              t: hitSnippet(ln, terms[0], terms[0].toUpperCase(), 60, word) });
          }
        } else {
          // 超大文件不建行表（split 会吃掉免费版 CPU）：只统计**首个关键词**的出现次数，
          // 用 approx 告诉前端"这是近似值"，避免给出一个看起来精确其实不对的数字。
          // 这里用 ciFind 而不是 toLowerCase —— 几 MB 的整篇小写是免费版 CPU 吃不下的。
          let n = 0, from = 0;
          while (n < 1000){
            const i = ciFind(dec.text, terms[0], terms[0].toUpperCase(), from, word);
            if (i < 0) break;
            n++; from = i + Math.max(1, terms[0].length);
          }
          count = n;
        }
        return json({
          ok: true, path: full, found: count > 0, count: count, lines: lines, approx: hits === null,
          terms: terms, enc: dec.enc, size: obj.size, hits: hits, hitsMore: hitsMore,
          snippet: (count && hits === null) ? hitSnippet(dec.text, terms[0], terms[0].toUpperCase(), 60, word) : null
        });
      }

      // 原始字节：媒体预览用（保留真实 Content-Type，不加 attachment）
      if (action === 'raw') {
        const key = R + toFull(rel);
        const obj = await bucket.get(key);
        if (!obj) return json({ ok: false, error: '文件不存在' }, 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        headers.set('Cache-Control', 'private, max-age=30');
        return new Response(obj.body, { headers });
      }

      if (action === 'read' || action === 'download') {
        const key = R + toFull(rel);
        const obj = await bucket.get(key);
        if (!obj) return json({ ok: false, error: '文件不存在' }, 404);

        // 条件请求：内容没变就直接 304，省下传输与（文本的）转码 CPU
        const inm = request.headers.get('If-None-Match');
        if (inm && obj.httpEtag && inm.indexOf(obj.httpEtag) >= 0) {
          return new Response(null, {
            status: 304,
            headers: { 'ETag': obj.httpEtag, 'Cache-Control': 'no-store' }
          });
        }

        // 在线编辑器不适合拉超大文件，避免浏览器卡死
        if (action === 'read' && obj.size > 2 * 1024 * 1024) {
          return json({ ok: false, error: '文件超过 2MB，请下载后用本地编辑器打开' }, 413);
        }

        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        headers.set('Cache-Control', 'no-store');
        if (action === 'download') {
          const name = key.split('/').pop();
          const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          headers.set('Content-Disposition',
            'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
          return new Response(obj.body, { headers });
        }
        // 在线读取：做编码识别，GBK 老文件也正常显示
        headers.set('Content-Type', 'text/plain;charset=utf-8');
        const bytes = new Uint8Array(await obj.arrayBuffer());
        // UTF-8 快路径：内容本身就是 UTF-8 字节，直接原样回传，
        // 省掉"整篇解码成 JS 字符串 → Response 再编码回 UTF-8"的往返
        // （1.8MB 实测约 20ms，免费版每次请求只有 10ms CPU，这条最容易被吃穿）。
        // sniffEncoding 只在前 64KB 上做严格 UTF-8 试解，廉价且可靠。
        // 带 BOM 的不能走这里 —— 原样回传会把 BOM 留给前端显示，得走解码路径剥掉。
        const sniff = sniffEncoding(bytes);
        if (sniff.enc === 'utf-8' && !sniff.bom) {
          headers.set('X-Text-Encoding', 'utf-8');
          return new Response(bytes, { headers });
        }
        const dec = decodeBytes(bytes);
        headers.set('X-Text-Encoding', dec.enc);
        return new Response(dec.text, { headers });
      }

      // ---- 批量下载的清单接口：递归列出一个文件夹下的所有文件 ----
      // ZIP 在**浏览器端**打包（前端有内存和网络，Worker 只有 10ms CPU / 128MB），
      // 所以后端只负责"把要打的文件清单给出来"，内容由前端逐个取。
      if (action === 'packList') {
        const dir = safeDir(rel);
        const files = [];
        let truncated = false, cursor;
        let bytes = 0;
        // path 既可能是文件夹也可能是**单个文件**（右键「下载为 zip」走的就是文件）。
        // R2 没有目录概念，list 前缀 'd/a.txt' 会精确命中那一个 key，
        // 但 path 也可能刚好是某个文件夹的前缀（如 'd/ab' 撞上 'd/abc.txt'），
        // 所以先 head 确认：命中且不以 / 结尾 → 就是文件，直接返回它自己。
        if (dir) {
          const direct = await bucket.head(R + dir);
          if (direct && (direct.httpMetadata || {}).contentType !== 'application/x-directory') {
            return json({
              ok: true, dir, isFile: true,
              files: [{ p: dir, s: direct.size }],
              truncated: false, count: 1, bytes: direct.size || 0,
              maxFiles: ZIP_MAX_FILES, maxBytes: ZIP_MAX_BYTES
            });
          }
        }
        const scanRoot = R + (dir ? dir + '/' : '');
        const dirs = [];
        do {
          const res = await bucket.list({ prefix: scanRoot, cursor, limit: 1000 });
          for (const o of res.objects) {
            if (o.key.endsWith('/')){
              // 空目录（只有占位符、里面没文件）也要出现在 zip 里，
              // 否则「打包这个文件夹」会把空子目录整个丢掉，解压后少了层目录。
              // 注意：占位符 key 本身以 / 结尾（'pack/empty1/'），判断层级前要先剥掉末尾斜杠，
              // 否则 indexOf('/') 恒 >= 0，一条都报不出来。
              // 空目录**也要受 ZIP_MAX_FILES 约束**：不然 3000 个空目录会全塞进 zip，
              // 纯属噪音（实测 3000 个目录条目要多花 17ms 建包，且解压出来一片空壳）。
              if (dirs.length < ZIP_MAX_FILES){
                const rp = o.key.slice(R.length, o.key.length - 1);   // 去掉末尾的 /
                const rel = dir ? rp.slice(dir.length + 1) : rp;       // 相对当前目录
                // 只报**直接子目录**（rel 里不能再有 /），也不报当前目录自己
                if (rel && rel !== dir && rel.indexOf('/') < 0) dirs.push(rp);
              } else {
                truncated = true;                                     // 目录也超上限了，如实回报
              }
              continue;
            }
            const rp = o.key.slice(R.length);
            if (!rp) continue;
            files.push({ p: rp, s: o.size });
            bytes += o.size || 0;
            // 撞上限就停：前端内存装不下更多，如实回报 truncated 让用户知道
            if (files.length >= ZIP_MAX_FILES || bytes >= ZIP_MAX_BYTES) { truncated = true; break; }
          }
          cursor = res.truncated ? res.cursor : undefined;
        } while (cursor && !truncated);
        return json({
          ok: true, dir, isFile: false, files, dirs, truncated,
          count: files.length, bytes,
          hasDirs: dirs.length > 0,
          maxFiles: ZIP_MAX_FILES, maxBytes: ZIP_MAX_BYTES
        });
      }

      return json({ ok: false, error: '未知操作' }, 400);
    }

    // ---- 访客只读：禁止一切写操作 ----
    if (readonly) return json({ ok: false, error: '只读分享，无权修改' }, 403);

    // ---- PUT：写入文件（上传 / 保存文本，均为原始字节流） ----
    if (method === 'PUT') {
      const full = normPath(url.searchParams.get('path') || '');
      if (!full) return json({ ok: false, error: '缺少 path 参数' }, 400);

      const segs = full.split('/').map(safeName).filter(Boolean);
      if (!segs.length) return json({ ok: false, error: '文件名不合法' }, 400);
      const name = segs.pop();
      const dir = segs.join('/');
      const rel = dir ? dir + '/' + name : name;
      const key = ROOT + rel;

      // 不允许写到同名的「文件夹」占位上
      if (await bucket.head(ROOT + rel + '/')) {
        return json({ ok: false, error: '该路径是文件夹，请指定具体的文件名' }, 409);
      }

      const ct = request.headers.get('Content-Type') || 'application/octet-stream';
      // 用 arrayBuffer() 读取而不是直接透传 request.body 流：
      // Cloudflare 运行时两种都行，但部分环境（Node undici）里 body 流不可直接消费
      const buf = await request.arrayBuffer();
      const putOpt = { httpMetadata: { contentType: ct } };
      // 记下原文件的修改时间，供之后"同名文件是不是同一份"的比对用（老文件没有这个字段）
      const mt = parseInt(request.headers.get('X-File-Mtime') || '', 10);
      putOpt.customMetadata = { mtime: String(isFinite(mt) && mt > 0 ? mt : Date.now()) };
      await bucket.put(key, buf, putOpt);
      // 【同步建索引】保存时立刻把这个文件写进搜索索引 —— 挂 waitUntil，响应不等它，
      // 但**这一次请求内就会完成**，所以用户改完立刻搜索一定能搜到新内容（不用"再搜一次"）。
      // 挂在响应之后是为了不拖慢保存本身；而"内容没变就不保存"（前端逐字比对）已经把
      // 无谓的写入挡掉了，所以这里只处理"真的改了"的情况。
      idxUpsert(bucket, kv, rel, buf, ct, isFinite(mt) && mt > 0 ? mt : Date.now(), idxCap, exec);
      return json({ ok: true, path: rel });
    }

    // ---- DELETE：删除文件或文件夹 ----
    if (method === 'DELETE') {
      const full = safeDir(url.searchParams.get('path') || '');
      if (!full) return json({ ok: false, error: '缺少 path 参数' }, 400);
      const isDir = url.searchParams.get('type') === 'dir';
      const password = url.searchParams.get('password') || '';
      // 受保护文件夹内的删除必须验证管理员密码
      if (await isProtectedPath(bucket, full, isDir)) {
        if (!env.PASSWORD || String(password) !== String(env.PASSWORD)) {
          return json({
            ok: false, needPw: true,
            error: env.PASSWORD ? '该路径位于受保护文件夹内，删除需要管理员密码' : '站点未设置管理密码（PASSWORD），无法删除受保护内容'
          }, 403);
        }
      }
      const n = await deletePath(bucket, full, isDir);
      // 影子树里的已发布副本同步删掉，否则分享页还会留着"已删除"的内容
      await deletePath(bucket, full, isDir, PUB);
      const shares = await purgeShares(kv, full);
      idxRemove(bucket, kv, full, isDir, exec);
      return json({ ok: true, removed: n, shares });
    }

    // ---- POST：JSON 操作 ----
    if (method === 'POST') {
      const qAction = url.searchParams.get('action');

      // ---- 分片上传：传分片时 body 是原始字节，不能走 JSON 解析，所以单独放前面 ----
      if (qAction === 'mpPart') {
        if (!kv) return json({ ok: false, error: '未绑定 KV，无法使用分片上传' }, 400);
        const uploadId = url.searchParams.get('uploadId') || '';
        const partNumber = parseInt(url.searchParams.get('part') || '', 10);
        if (!uploadId || !(partNumber >= 1)) return json({ ok: false, error: '缺少 uploadId / part' }, 400);
        const rec = await kv.get('mp:' + uploadId);
        if (!rec) return json({ ok: false, error: '上传会话已失效，请重新开始' }, 404);
        const info = JSON.parse(rec);
        const mp = bucket.resumeMultipartUpload(info.key, uploadId);
        const buf = await request.arrayBuffer();
        const part = await mp.uploadPart(partNumber, buf);
        // 把分片的 etag 记回会话：这样"继续上传"时能跳过已经传好的分片，
        // 而且 complete 时前端不必自己攒 parts（刷新过一次也不会丢）
        info.parts = info.parts || {};
        info.parts[String(part.partNumber)] = part.etag;
        await kv.put('mp:' + uploadId, JSON.stringify(info), { expirationTtl: 86400 });
        return json({ ok: true, partNumber: part.partNumber, etag: part.etag, size: buf.byteLength });
      }

      const body = await request.json().catch(() => ({}));
      const action = body.action || qAction;

      // ---- 大文件分片上传（R2 multipart）----
      // 只有超过阈值的文件才走这里：CreateMultipartUpload / UploadPart 都算 Class A 操作，
      // 小文件走多段反而更贵，前端会自己判断。
      if (action === 'mpCreate') {
        if (typeof bucket.createMultipartUpload !== 'function') {
          return json({ ok: false, error: '当前存储不支持分片上传' }, 400);
        }
        if (!kv) return json({ ok: false, error: '未绑定 KV，无法使用分片上传' }, 400);
        const full = safeDir(body.path || '');
        if (!full) return json({ ok: false, error: '缺少 path 参数' }, 400);
        if (await bucket.head(ROOT + full + '/')) {
          return json({ ok: false, error: '该路径是文件夹，请指定具体的文件名' }, 409);
        }
        const ct = body.ct || 'application/octet-stream';
        const size = parseInt(body.size, 10) || 0;
        const mt = parseInt(body.mtime, 10) || 0;
        const mp = await bucket.createMultipartUpload(ROOT + full, { httpMetadata: { contentType: ct } });
        await kv.put('mp:' + mp.uploadId,
          JSON.stringify({ key: ROOT + full, rel: full, ct, size, mt, at: Date.now(), parts: {} }),
          { expirationTtl: 86400 });
        return json({ ok: true, uploadId: mp.uploadId, path: full, partSize: 8 * 1024 * 1024 });
      }

      if (action === 'mpComplete') {
        const uploadId = String(body.uploadId || '');
        if (!uploadId) return json({ ok: false, error: '缺少 uploadId' }, 400);
        if (!kv) return json({ ok: false, error: '未绑定 KV' }, 400);
        const rec = await kv.get('mp:' + uploadId);
        if (!rec) return json({ ok: false, error: '上传会话已失效，请重新开始' }, 404);
        const info = JSON.parse(rec);
        // 优先用会话里记下的分片（容忍刷新页面）；前端也可以显式传 parts 覆盖
        let partsIn = Array.isArray(body.parts) && body.parts.length ? body.parts : null;
        if (!partsIn) {
          partsIn = Object.keys(info.parts || {}).map(n => ({ partNumber: Number(n), etag: info.parts[n] }));
        }
        const uploaded = [];
        for (const p of partsIn) {
          const n = parseInt(p && (p.partNumber != null ? p.partNumber : p.n), 10);
          const et = String((p && p.etag) || '');
          if (n >= 1 && et) uploaded.push({ partNumber: n, etag: et });
        }
        uploaded.sort((a, b) => a.partNumber - b.partNumber);
        if (!uploaded.length) return json({ ok: false, error: '没有有效的分片' }, 400);
        const mp = bucket.resumeMultipartUpload(info.key, uploadId);
        await mp.complete(uploaded);
        await kv.delete('mp:' + uploadId);
        // 【同步建索引】大文件本来就不索引正文（超过 IDX_FILE_SIZE_LIMIT），
        // 但仍要登记元数据，好让搜索至少能按文件名/路径命中它。
        idxUpsert(bucket, kv, info.rel, null, info.ct, info.mt, idxCap, exec);
        return json({ ok: true, path: info.rel, size: info.size, parts: uploaded.length });
      }

      if (action === 'mpAbort') {
        const uploadId = String(body.uploadId || '');
        if (kv && uploadId) {
          const rec = await kv.get('mp:' + uploadId);
          if (rec) {
            const info = JSON.parse(rec);
            try { await bucket.resumeMultipartUpload(info.key, uploadId).abort(); } catch (e) {}
          }
          await kv.delete('mp:' + uploadId);
        }
        return json({ ok: true });
      }

      // 未完成的分片上传（页面刷新后前端用它提示"继续上传"）
      if (action === 'mpList') {
        if (!kv) return json({ ok: true, sessions: [] });
        const res = await kv.list({ prefix: 'mp:', limit: 200 });
        const out = [];
        for (const k of (res.keys || [])) {
          const raw = await kv.get(k.name);
          if (!raw) continue;
          try {
            const d = JSON.parse(raw);
            const have = Object.keys(d.parts || {}).map(n => Number(n)).sort((a, b) => a - b);
            out.push({
              uploadId: k.name.slice(3), path: d.rel, size: d.size, ct: d.ct, at: d.at,
              parts: have, totalParts: Math.max(1, Math.ceil((d.size || 0) / (8 * 1024 * 1024)))
            });
          } catch (e) {}
        }
        out.sort((a, b) => (b.at || 0) - (a.at || 0));
        return json({ ok: true, sessions: out });
      }

      // ---- 重建搜索索引 ----
      // 老文件是在索引上线之前传的，需要一次性补建。分批执行：免费版每次请求只有 10ms CPU，
      // 一次解码几百个文件必然超限，所以每批只处理 limit 个，前端循环调用直到 done。
      // 本批先把要写的内容全部解码好（读 R2 只做一次），再交给 idxUpdate 的条件写骨架提交 ——
      // etag 冲突时骨架会自动重读重放同一批内容，不会再出现"一次并发上传就让整批重建作废"。
      if (action === 'reindex') {
        const resumeAfter = String(body.lastKey || '');
        const il = await idxLoad(bucket, kv);
        const curFiles = il.idx.files || {};
        let total = idxTextBytes(il.idx);
        let fcount = Object.keys(curFiles).length;
        let scanned = 0, indexed = 0, skipped = 0;
        let lastProc = resumeAfter;
        let more = false;
        let cursor;
        const pending = [];                    // [rel, [r, size, ct, mtimeMs, text]]，重放时直接复用

        // 批大小按**索引现有体积**自适应，不写死。
        // 每一轮都有「JSON.parse(整份索引) + JSON.stringify(整份索引) + 写回」这份固定开销，
        // 实测 1.1MB 索引时 parse 1.65ms + stringify 3.17ms ≈ 4.8ms，已经吃掉免费版 10ms
        // CPU 预算的一半；再叠上几十个文件的解码，整轮就可能踩线报 1102。
        // 所以：索引小的时候多取点没负担，索引大了必须少取 —— limit 跟着体积走。
        // 估算用已有字段（tb = 正文字节数 + 条目数 × 均摊元数据），
        // 不额外 stringify 一遍整份索引 —— 那正是要省的开销。
        const approxKB = (idxTextBytes(il.idx) + fcount * 120) / 1024;
        const fixedMs = approxKB / 230;               // 1.1MB → 约 4.8ms，与实测吻合
        // 注意：这里必须先把 parseInt 结果归一化成「没传 = 0」，
        // 否则 Math.max(1, 0) 会得到 1，`if (!limit)` 永不成立，自适应形同虚设（每轮只处理 1 个）。
        const wantLimit = parseInt(body.limit, 10);
        let limit = (isFinite(wantLimit) && wantLimit > 0) ? Math.min(120, wantLimit) : 0;
        if (!limit){
          // 每文件成本实测：40 个 8KB 文件解码只要 0.09ms → 约 0.0023ms/个。
          // 真正的大头是上面那份固定开销，所以索引小的时候能给很大的批。
          const room = 6 - fixedMs;                  // 单轮总预算 6ms，留 4ms 余量给别处
          limit = room > 0.5 ? Math.floor(room / 0.01) : 8;
          limit = Math.max(8, Math.min(120, limit));
        }

        scan: do {
          const res = await bucket.list({ prefix: ROOT, cursor, limit: 1000, include: ['customMetadata'] });
          for (const o of res.objects) {
            if (o.key.endsWith('/')) continue;
            if (resumeAfter && o.key <= resumeAfter) continue;
            // 控批用 scanned 而不是 indexed：indexed 只在"成功索引正文"时才 +1，
            // 而超配额/二进制/大文件都走 r=2 分支不涨它 —— 拿 indexed 当闸门，
            // 这些文件会让本轮一直扫下去（自适应 limit 也就形同虚设）。
            if (scanned >= limit) { more = true; break scan; }
            scanned++;
            // 断点记在**处理完之后**：lastProc 是"本轮最后一个已处理的 key"，
            // 下一轮用 `o.key <= resumeAfter` 跳过它及之前的。若在判闸门之前就记，
            // 那个被闸门拦下、尚未处理的 key 会被当成断点，下一轮直接跳过它
            // → 隔一个文件丢一个（实测 30 个文件只索引了 8 个）。
            const rel = o.key.slice(ROOT.length);
            if (!rel) continue;
            const ct = (o.httpMetadata && o.httpMetadata.contentType) || '';
            const cm = o.customMetadata || {};
            const mt = parseInt(cm.mtime || '', 10);
            const mtv = isFinite(mt) ? mt : (o.uploaded instanceof Date ? o.uploaded.getTime() : 0);
            const name = rel.split('/').pop();
            let r = 2, text = null;
            const allow = idxAllowance(idxCap, total);      // 配额快满 → 自动缩短片段
            const wanted = allow > 0 && o.size > 0 && o.size <= IDX_FILE_SIZE_LIMIT && idxShouldRead(name, ct);
            if (wanted && fcount < IDX_MAX_FILES) {
              const obj = await bucket.get(o.key);
              if (obj) {
                const ex = idxExtract(await obj.arrayBuffer());
                if (ex.text) {
                  text = ex.text.length > allow ? ex.text.slice(0, allow) : ex.text;
                  r = (ex.truncated || text.length < ex.text.length) ? 1 : 0;
                  total += text.length;
                  indexed++;
                }
              }
            }
            if (r === 2) skipped++;
            if (!curFiles[rel]) fcount++;
            pending.push([rel, [r, o.size, ct, mtv, text]]);
            lastProc = o.key;          // 断点 = 本轮最后一个已完整处理的 key
          }
          cursor = res.truncated ? res.cursor : undefined;
        } while (cursor && scanned < 20000);

        // 提交：条件写 + 冲突自动重读重放（重放的是同一批 pending，不重复读 R2）
        let finalFiles = fcount, finalText = total;
        const ok = await idxUpdate(bucket, kv, function(idx){
          idx.files = idx.files || {};
          let t = idxTextBytes(idx);
          let fc = Object.keys(idx.files).length;
          for (let i = 0; i < pending.length; i++){
            const rel = pending[i][0], e = pending[i][1];
            const prev = idx.files[rel];
            const prevLen = prev && prev[4] ? prev[4].length : 0;
            const base = t - prevLen;
            let r = e[0], text = e[4];
            // 重放时按**最新**索引重核配额：被并发上传挤占后自动降级成"只按文件名"
            if (text && (prev || fc < IDX_MAX_FILES) && base + text.length <= idxCap){
              t = base + text.length;
            } else {
              r = 2; text = null; t = base;
            }
            if (!prev) fc++;
            idx.files[rel] = [r, e[1], e[2], e[3], text];
          }
          finalFiles = fc; finalText = t;
          idx.tb = t; idx.at = Date.now();
          return pending.length > 0;
        });
        if (!ok) return json({ ok: false, error: '索引并发冲突过多，请重试本批' }, 409);
        return json({
          ok: true, done: !more, scanned, indexed, skipped, lastKey: lastProc,
          files: finalFiles, textBytes: finalText, textCap: idxCap
        });
      }

      if (action === 'mkdir') {
        const dir = safeDir(body.path || '');
        const name = safeName(body.name);
        const isProtected = !!body.protected;
        if (!name) return json({ ok: false, error: '文件夹名不合法' }, 400);
        const key = ROOT + (dir ? dir + '/' : '') + name + '/';
        const asFile = ROOT + (dir ? dir + '/' : '') + name;
        if (await bucket.head(key)) return json({ ok: false, error: '同名文件夹已存在' }, 409);
        if (await bucket.head(asFile)) return json({ ok: false, error: '同名文件已存在，无法创建文件夹' }, 409);
        const putOpt = { httpMetadata: { contentType: 'application/x-directory' } };
        if (isProtected) putOpt.customMetadata = { protected: '1' };
        await bucket.put(key, new Uint8Array(0), putOpt);
        return json({ ok: true, path: (dir ? dir + '/' : '') + name, protected: isProtected });
      }

      // 给已存在的文件夹设置 / 取消"受保护"标记（重写一次占位对象即可，R2 不支持局部改元数据）
      // 上锁不需要密码；**解锁必须验证管理员密码** —— 防止手滑点一下就解除保护
      if (action === 'setProtected') {
        const dir = safeDir(body.path || '');
        if (!dir) return json({ ok: false, error: '缺少 path 参数' }, 400);
        const on = !!body.protected;
        const key = ROOT + dir + '/';
        const cur = await bucket.head(key);
        if (!cur) return json({ ok: false, error: '目标不是文件夹，或文件夹不存在' }, 404);
        const cm = cur.customMetadata || {};
        const wasProtected = cm.protected === '1';
        if (wasProtected && !on) {
          const pw = String(body.password || '');
          if (!env.PASSWORD) {
            // noPwSet 让前端知道"再弹窗也没用"，直接报错而不是无限重试
            return json({ ok: false, needPw: true, noPwSet: true, error: '站点未设置管理密码（PASSWORD），无法取消保护' }, 403);
          }
          if (pw !== env.PASSWORD) {
            return json({ ok: false, needPw: true, error: pw ? '管理员密码错误' : '取消受保护需要验证管理员密码' }, 403);
          }
        }
        const ct = (cur.httpMetadata && cur.httpMetadata.contentType) || 'application/x-directory';
        const putOpt = { httpMetadata: { contentType: ct } };
        const keep = {};
        if (cm.mtime) keep.mtime = cm.mtime;
        if (on) keep.protected = '1';
        if (Object.keys(keep).length) putOpt.customMetadata = keep;
        await bucket.put(key, new Uint8Array(0), putOpt);
        return json({ ok: true, path: dir, protected: on });
      }

      if (action === 'rename') {
        const full = safeDir(body.path || '');
        if (!full) return json({ ok: false, error: '缺少 path 参数' }, 400);
        const segs = full.split('/');
        const oldName = segs.pop();
        const dir = segs.join('/');
        const newName = safeName(body.newName);
        if (!newName) return json({ ok: false, error: '新名称不合法' }, 400);
        if (newName === oldName) return json({ ok: true, path: full });

        const isDir = !!body.isDir;
        const to = (dir ? dir + '/' : '') + newName;
        if (await bucket.head(ROOT + to + '/')) {
          return json({ ok: false, error: '目标位置已有同名文件夹' }, 409);
        }
        if (await bucket.head(ROOT + to)) {
          return json({ ok: false, error: '目标位置已有同名文件' }, 409);
        }

        const moved = await moveObjects(
          bucket,
          ROOT + full + (isDir ? '/' : ''),
          ROOT + to + (isDir ? '/' : '')
        );
        if (!moved.ok) return json({ ok: false, error: moved.error }, 400);

        await movePublished(bucket, full, to, isDir);
        await retargetShares(kv, full, to);
        idxRetarget(bucket, kv, full, to, isDir, exec);
        return json({ ok: true, path: to });
      }

      // 移动到另一个目录（可同时改名）
      if (action === 'move') {
        const full = safeDir(body.path || '');
        const toDir = safeDir(body.toDir || '');
        if (!full) return json({ ok: false, error: '缺少 path 参数' }, 400);

        const segs = full.split('/');
        const oldName = segs.pop();
        const isDir = !!body.isDir;
        let newName = safeName(body.newName) || oldName;

        if (toDir === segs.join('/') && newName === oldName) {
          return json({ ok: false, error: '目标和原位置相同' }, 400);
        }
        // 不允许把目录移进它自己或它的子目录
        if (isDir && (toDir === full || toDir.startsWith(full + '/'))) {
          return json({ ok: false, error: '不能把文件夹移动到它自己内部' }, 400);
        }
        // 搬出保护区：受保护→普通（同目录改名除外），需要验证管理员密码。
        // 通过后允许移动；文件夹自身的保护标记会跟着走（保护跟着文件夹，不因为换位置就自动解除）。
        if (await moveLeavesProtection(bucket, full, isDir, toDir)) {
          const pwOut = String(body.password || '');
          if (!env.PASSWORD) {
            return json({ ok: false, needPw: true, noPwSet: true, pwFor: 'out', error: '站点未设置管理密码（PASSWORD），无法将受保护内容移出保护区' }, 403);
          }
          if (pwOut !== env.PASSWORD) {
            return json({ ok: false, needPw: true, pwFor: 'out', error: pwOut ? '管理员密码错误' : '把受保护内容移出保护区需要验证管理员密码' }, 403);
          }
        }
        // 移入保护区：普通内容搬进受保护文件夹，需要验证管理员密码
        if (await moveIntoProtection(bucket, full, isDir, toDir)) {
          const pw = String(body.password || '');
          if (!env.PASSWORD) {
            return json({ ok: false, needPw: true, noPwSet: true, pwFor: 'in', error: '站点未设置管理密码（PASSWORD），无法移入受保护文件夹' }, 403);
          }
          if (pw !== env.PASSWORD) {
            return json({ ok: false, needPw: true, pwFor: 'in', error: pw ? '管理员密码错误' : '把内容移入受保护文件夹需要验证管理员密码' }, 403);
          }
        }
        // 目标目录必须存在（根目录除外）
        if (toDir && !(await bucket.head(ROOT + toDir + '/'))) {
          return json({ ok: false, error: '目标目录不存在' }, 404);
        }

        const to = (toDir ? toDir + '/' : '') + newName;
        if (to === full) return json({ ok: false, error: '目标和原位置相同' }, 400);
        if (await bucket.head(ROOT + to + '/')) {
          return json({ ok: false, error: '目标位置已有同名文件夹' }, 409);
        }
        if (await bucket.head(ROOT + to)) {
          return json({ ok: false, error: '目标位置已有同名文件' }, 409);
        }

        const moved = await moveObjects(
          bucket,
          ROOT + full + (isDir ? '/' : ''),
          ROOT + to + (isDir ? '/' : '')
        );
        if (!moved.ok) return json({ ok: false, error: moved.error }, 400);

        await movePublished(bucket, full, to, isDir);
        await retargetShares(kv, full, to);
        idxRetarget(bucket, kv, full, to, isDir, exec);
        return json({ ok: true, path: to });
      }

      if (action === 'share') {
        if (!kv) return json({ ok: false, error: '未绑定 KV，无法创建分享链接' }, 400);
        const target = safeDir(body.path || '');
        if (!target) return json({ ok: false, error: '请指定要分享的文件或目录' }, 400);

        // 自动判断是文件还是目录：有同名目录占位就是目录
        const asDir = !!(await bucket.head(ROOT + target + '/'));
        if (!asDir && !(await bucket.get(ROOT + target))) {
          return json({ ok: false, error: '目标不存在' }, 404);
        }

        // 有效期：秒；0 或省略 = 永久。KV 的 expirationTtl 最小 60 秒
        let ttl = parseInt(body.expiresIn, 10);
        if (!isFinite(ttl) || ttl < 0) ttl = 0;
        if (ttl > 0 && ttl < 60) ttl = 60;
        if (ttl > 31536000) ttl = 31536000;              // 上限 1 年

        const want = safeToken(body.token);
        if (want && want.length < 6) {
          return json({ ok: false, error: '自定义口令至少 6 位（字母、数字、. _ ~ -），太短容易被猜到' }, 400);
        }
        const token = want || uuidv4().replace(/-/g, '').slice(0, 12);
        const rec = {
          path: target, kind: asDir ? 'dir' : 'file', at: Date.now(),
          exp: ttl ? Date.now() + ttl * 1000 : 0
        };
        await kv.put('share:' + token, JSON.stringify(rec), ttl ? { expirationTtl: ttl } : undefined);

        // 建分享即发布当前版本：分享端只读影子树，不先复制过去链接就是空的。
        // 失败不算致命（记录已建，列表里会标"待发布"），但要把错误如实回传。
        let published = 0, pubErr = '';
        try {
          const pr = await publishPath(bucket, target, asDir);
          if (pr.ok) published = pr.published;
          else pubErr = pr.error || '发布失败';
        } catch (e) { pubErr = String(e && e.message || e); }

        // 单文件分享把文件名带在链接末尾，便于订阅类客户端识别后缀、也更好认
        const suffix = asDir ? '' : '/' + encodeURIComponent(target.split('/').pop());
        return json({
          ok: true, token, path: target, kind: rec.kind, exp: rec.exp,
          published, publishError: pubErr,
          url: url.origin + '/s/' + token + suffix,
          urlNoName: url.origin + '/s/' + token
        });
      }

      if (action === 'shares') {
        if (!kv) return json({ ok: true, shares: [] });
        const all = await readShares(kv);

        // 自愈：目标已经彻底不在了（草稿、影子树都空）的记录直接清掉，不留在列表里。
        // 只在草稿里、还没发布的**不能清** —— 那只是"待发布"，链接仍然有效可用。
        const alive = [];
        const dead = [];
        for (let i = 0; i < all.length; i++) {
          if (i < 200 && all[i].path) {
            const st = await shareState(bucket, all[i]);
            if (!st.alive) { dead.push(all[i]); continue; }
            all[i].published = st.published;
            // 顺带告诉前端"再发布一次会不会有变化"，前端据此把「发布」按钮置灰。
            // 只在"已发布且草稿还在"时才比；目录分享要多两次 list，所以条数多就不逐个算了
            // （留 undefined，前端当作"不确定"→ 按钮照旧可点，不会误拦）。
            if (i < 60 && st.published && st.draft) {
              all[i].synced = await publishSynced(bucket, all[i].path, all[i].kind === 'dir');
            }
          } else if (all[i].path) {
            all[i].published = false;
          }
          alive.push(all[i]);
        }
        for (let i = 0; i < dead.length; i += 40) {
          await Promise.all(dead.slice(i, i + 40).map(s => kv.delete(s.key)));
        }

        alive.sort((a, b) => (b.at || 0) - (a.at || 0));
        return json({ ok: true, shares: alive, cleaned: dead.length, origin: url.origin });
      }

      if (action === 'unshare') {
        if (!kv) return json({ ok: false, error: '未绑定 KV' }, 400);
        const token = safeToken(body.token);
        if (token) await kv.delete('share:' + token);
        return json({ ok: true });
      }

      if (action === 'unshareAll') {
        if (!kv) return json({ ok: false, error: '未绑定 KV' }, 400);
        const res = await kv.list({ prefix: 'share:', limit: 1000 });
        const keys = (res.keys || []).map(k => k.name);
        for (let i = 0; i < keys.length; i += 40) {
          await Promise.all(keys.slice(i, i + 40).map(k => kv.delete(k)));
        }
        return json({ ok: true, removed: keys.length });
      }

      // ---- 发布：把草稿树当前版本复制到影子树，分享端立刻可见 ----
      if (action === 'publish') {
        const p = safeDir(body.path || '');
        if (!p) return json({ ok: false, error: '缺少 path 参数' }, 400);
        const isDir = !!body.isDir;
        // 内容与影子树里那份完全一致 → 直接返回，不复制、不清缓存。
        // 否则"一个字都没改也点发布"会白写一遍 R2（目录分享是整棵子树重写），
        // 分享页看到的内容却不会有任何变化 —— 纯浪费。前端也会提前拦掉，这里是兜底。
        if (await publishSynced(bucket, p, isDir) === true) {
          return json({ ok: true, published: 0, unchanged: true, path: p, isDir });
        }
        const r = await publishPath(bucket, p, isDir);
        if (!r.ok) return json({ ok: false, error: r.error }, 404);
        await purgeShareCache(url.origin, kv, p);
        return json({ ok: true, published: r.published, path: p, isDir });
      }

      // ---- 发布状态查询：告诉前端"再发布一次会不会有变化" ----
      // 前端用它把「发布」按钮在"没有改动"时置灰，而不是让用户点完才发现没意义。
      // 只读状态、不做任何修改；也不走边缘缓存（要看的就是当下的实时值）。
      if (action === 'pubState') {
        const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
        const states = {};
        for (let i = 0; i < items.length; i += 8) {           // 小批并发，避免一条条串着等
          const got = await Promise.all(items.slice(i, i + 8).map(async (it) => {
            const p = safeDir(it && it.path || '');
            if (!p) return null;
            return [p, await publishSynced(bucket, p, !!(it && it.isDir))];
          }));
          for (const g of got) if (g) states[g[0]] = g[1];
        }
        return json({ ok: true, states });
      }

      // ---- 撤回发布：删影子树副本，草稿与分享记录都不动 ----
      if (action === 'unpublish') {
        const p = safeDir(body.path || '');
        if (!p) return json({ ok: false, error: '缺少 path 参数' }, 400);
        const isDir = !!body.isDir;
        const r = await unpublishPath(bucket, p, isDir);
        if (!r.ok) return json({ ok: false, error: r.error }, 404);
        await purgeShareCache(url.origin, kv, p);
        return json({ ok: true, removed: r.removed, path: p, isDir });
      }

      // ---- 一键迁移：把存量分享（影子树里还没有的）全部发布一遍 ----
      // 老版本没有影子树，历史分享记录对应的内容只在草稿树里，分享页会打不开。
      if (action === 'publishAll') {
        if (!kv) return json({ ok: false, error: '未绑定 KV' }, 400);
        const all = await readShares(kv);
        let published = 0, skipped = 0, objects = 0;
        const failed = [];
        for (const s of all) {
          if (!s.path) { skipped++; continue; }
          try {
            const st = await shareState(bucket, s);
            if (st.published) { skipped++; continue; }
            if (!st.draft) { failed.push(s.path); continue; }
            const r = await publishPath(bucket, s.path, s.kind === 'dir');
            if (!r.ok) { failed.push(s.path); continue; }
            published++; objects += r.published;
            await purgeShareCache(url.origin, kv, s.path);
          } catch (e) { failed.push(s.path); }
        }
        return json({ ok: true, published, objects, skipped, failed, count: all.length });
      }

      if (action === 'deleteBatch') {
        const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
        if (!items.length) return json({ ok: false, error: '没有选中任何项目' }, 400);
        const password = String(body.password || '');

        let removed = 0;
        let shares = 0;
        let needPw = false;
        const failed = [];
        for (const it of items) {
          const p = safeDir(it && it.path || '');
          if (!p) continue;
          const isDir = !!(it && it.isDir);
          // 受保护文件夹内的删除必须验证管理员密码
          if (await isProtectedPath(bucket, p, isDir)) {
            if (!env.PASSWORD || password !== env.PASSWORD) {
              needPw = true;
              failed.push(p + '（受保护，需要管理员密码）');
              continue;
            }
          }
          try {
            removed += await deletePath(bucket, p, isDir);
            // 影子树里的已发布副本同步删掉，否则分享页还会留着"已删除"的内容
            await deletePath(bucket, p, isDir, PUB);
            shares += await purgeShares(kv, p);
            idxRemove(bucket, kv, p, isDir, exec);
          } catch (e) {
            failed.push(p);
          }
        }
        return json({ ok: true, removed, shares, failed, needPw, count: items.length });
      }

      // 批量移动
      if (action === 'moveBatch') {
        const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
        const toDir = safeDir(body.toDir || '');
        if (!items.length) return json({ ok: false, error: '没有选中任何项目' }, 400);
        if (toDir && !(await bucket.head(ROOT + toDir + '/'))) {
          return json({ ok: false, error: '目标目录不存在' }, 404);
        }
        // 整批只要有一项跨越保护区边界（搬出或搬入），就先验一次密码（原子：密码不对整批都不动）
        let batchNeedPw = false;
        let batchPwFor = '';
        for (const it of items) {
          const p0 = safeDir(it && it.path || '');
          if (!p0) continue;
          const isDir0 = !!(it && it.isDir);
          if (await moveLeavesProtection(bucket, p0, isDir0, toDir)) { batchNeedPw = true; batchPwFor = 'out'; break; }
          if (await moveIntoProtection(bucket, p0, isDir0, toDir)) { batchNeedPw = true; batchPwFor = 'in'; break; }
        }
        if (batchNeedPw) {
          const pw0 = String(body.password || '');
          if (!env.PASSWORD) {
            return json({ ok: false, needPw: true, noPwSet: true, pwFor: batchPwFor, error: '站点未设置管理密码（PASSWORD），无法移动涉及保护区的内容' }, 403);
          }
          if (pw0 !== env.PASSWORD) {
            return json({ ok: false, needPw: true, pwFor: batchPwFor, error: pw0 ? '管理员密码错误' : '批量移动中有内容要移入或移出受保护文件夹，需要验证管理员密码' }, 403);
          }
        }

        const failed = [];
        let moved = 0;
        for (const it of items) {
          const p = safeDir(it && it.path || '');
          const isDir = !!(it && it.isDir);
          if (!p) continue;
          const name = p.split('/').pop();
          const to = (toDir ? toDir + '/' : '') + name;
          if (to === p) continue;
          if (isDir && (toDir === p || toDir.startsWith(p + '/'))) { failed.push(p); continue; }
          try {
            if (await bucket.head(ROOT + to + '/')) { failed.push(p); continue; }
            if (await bucket.head(ROOT + to)) { failed.push(p); continue; }
            const r = await moveObjects(bucket, ROOT + p + (isDir ? '/' : ''), ROOT + to + (isDir ? '/' : ''));
            if (!r.ok) { failed.push(p); continue; }
            await movePublished(bucket, p, to, isDir);   // 已发布副本跟着搬，分享页不至于 404
            await retargetShares(kv, p, to);
            idxRetarget(bucket, kv, p, to, isDir, exec);
            moved++;
          } catch (e) {
            failed.push(p);
          }
        }
        return json({ ok: true, moved, failed, count: items.length });
      }

      return json({ ok: false, error: '未知操作' }, 400);
    }

    return json({ ok: false, error: '不支持的请求方法' }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

// ===== 登录页 =====
function loginPage(title, tip) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${escapeHtml(title)} · 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#d4a02a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(title)}">
<link rel="apple-touch-icon" href="/icon/180.png">
<link rel="icon" type="image/png" href="/icon/192.png">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:26px;width:100%;max-width:340px}
h2{margin:0 0 16px;font-size:16px}
input{width:100%;box-sizing:border-box;border:1px solid #d0d7de;border-radius:6px;padding:9px;font-size:14px}
button{width:100%;margin-top:14px;border:none;border-radius:6px;background:#1f883d;color:#fff;padding:9px;font-size:14px;cursor:pointer}
button:hover{background:#1a7f37}
.err{color:#c0392b;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form class="card" method="post" action="?action=login">
  <h2>${escapeHtml(title)} · 管理登录</h2>
  <input type="password" name="password" placeholder="请输入访问密码" autofocus>
  <button type="submit">进入</button>
  <div class="err">${escapeHtml(tip || '')}</div>
</form>
</body></html>`;
}

// ===== 管理 / 浏览界面 =====
function appHtml(o) {
  const base = o.base;
  const readonly = !!o.readonly;
  const title = o.title;
  const hasPw = !!o.hasPw;
  const sessDays = o.sessDays || 0;
  const shareName = o.shareName || '';      // 只读页用来替代"根目录"这种管理端叫法
  // 每次页面加载生成一个随机 nonce，只允许带它的内联脚本运行
  const nb = new Uint8Array(16);
  crypto.getRandomValues(nb);
  const nonce = Array.prototype.map.call(nb, function(b){ return b.toString(16).padStart(2, '0'); }).join('');
  // 媒体预览需要 blob:（图片灯箱 / 音视频 / PDF 都用 createObjectURL 喂给标签），
  // 所以 img-src / media-src / frame-src 放行 blob:；object-src 仍然是 none。
  // HTML 预览走 sandbox iframe（不带 allow-same-origin、不带 allow-scripts），与主站源隔离。
  const CSP = "default-src 'self'; script-src 'self' 'nonce-" + nonce +
    "' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; " +
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#d4a02a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(title)}">
<link rel="apple-touch-icon" href="/icon/180.png">
<link rel="icon" type="image/png" href="/icon/192.png">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
*{box-sizing:border-box}
[hidden]{display:none!important}
html{height:100%}
body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:#f6f7f9;color:#1f2328;font-size:14px;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:#0969da;text-decoration:none}
button{font-family:inherit}
header{flex:0 0 auto;background:#fff;border-bottom:1px solid #e3e6ea;padding:9px 14px;display:flex;align-items:center;gap:10px;
position:relative;z-index:21}
.brand{font-weight:600;font-size:15px;display:flex;align-items:center;gap:7px;white-space:nowrap}
.crumb{display:flex;align-items:center;gap:4px;flex:1;min-width:120px;flex-wrap:wrap;font-size:13px;color:#57606a}
.crumb a{color:#0969da;padding:2px 4px;border-radius:4px;text-decoration:none}
.crumb a:hover{background:#eef4fd}
.crumb .sep{color:#8c959f}
.btn{border:1px solid #d0d7de;background:#fff;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;color:#1f2328;
display:inline-flex;align-items:center;gap:6px;white-space:nowrap;line-height:1.3}
.btn:hover{background:#f3f4f6}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.btn.primary:hover:not(:disabled){background:#1a60d0}
.btn.primary:disabled{background:#e6e8eb;border-color:#d0d7de;color:#8b949e;opacity:1}
.btn.ghost{border-color:transparent;background:transparent;color:#57606a}
.btn.ghost:hover{background:#eef0f2;color:#1f2328}
.btn.sm{padding:4px 9px;font-size:12.5px;border-radius:7px}
#acct{display:flex;align-items:center;gap:6px}
#acct #btnLogout:hover{color:#c0392b;background:#fdeaea}
#sideBtn{display:none}

/* 全宽铺开：以前这里有 max-width:1560px + margin:0 auto，
   结果视口一超过 1560px，侧栏就被居中的边距推离左边缘，而 header 仍是全宽 ——
   两者对不齐，左侧就出现一条灰带（1920 屏上宽达 180px）。
   文件列表本来就该用满宽度，所以直接去掉上限。 */
.layout{flex:1;min-height:0;display:flex;width:100%;align-items:stretch}

/* 侧栏宽度走 CSS 变量，拖拽时只改这一个值，不用碰每个元素 */
:root{--side-w:256px}
aside{width:var(--side-w,256px);flex:0 0 var(--side-w,256px);background:#fff;border-right:1px solid #e3e6ea;
display:flex;flex-direction:column;height:100%}
/* 侧栏与正文之间的拖拽手柄。压在边框上，平时透明，悬停/拖拽时露出蓝色竖条 */
.sideGrip{flex:0 0 5px;width:5px;margin-left:-1px;padding:0;border:none;background:transparent;
cursor:col-resize;position:relative;z-index:6}
.sideGrip::after{content:"";position:absolute;left:1px;top:50%;transform:translateY(-50%);width:2px;height:36px;
border-radius:2px;background:transparent;transition:background .15s}
.sideGrip:hover::after,.sideGrip.on::after,.sideGrip:focus-visible::after{background:#1f6feb}
.sideGrip:focus{outline:none}
.sideGrip:focus-visible{outline:2px solid #1f6feb;outline-offset:-3px;border-radius:3px}
body.grip-ing,body.grip-ing *{cursor:col-resize!important}
body.grip-ing{user-select:none}

/* 框选（橡皮筋选择）的选框 */
.marq{position:fixed;z-index:130;pointer-events:none;border:1px solid #1f6feb;
background:rgba(31,111,235,.12);border-radius:2px}
body.marq-ing{user-select:none}
body.marq-ing *{cursor:crosshair!important}

/* 排序控件 */
.sortBox{display:inline-flex;align-items:center;gap:6px;margin-left:2px}
.sortBox select{border:1px solid #d0d7de;border-radius:7px;padding:5px 8px;font-size:12.5px;
font-family:inherit;background:#fff;color:inherit;cursor:pointer}
.sortBox select:focus{outline:none;border-color:#1f6feb}
th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
th.sortable:hover{background:#f1f3f5;color:#1f2328}
th.sortable .sar{color:#0969da;font-weight:600;margin-left:3px}

/* 侧栏左右内边距和 header 的 14px 对齐，这样"文件管理"、搜索框、logo 在同一条竖线上 */
.side-top{display:flex;align-items:center;gap:6px;padding:11px 14px 7px;font-weight:600;font-size:13px;color:#1f2328}
.side-top .sp{flex:1}
.side-search{padding:0 14px 9px}
.side-search input{width:100%;border:1px solid #d0d7de;border-radius:8px;padding:7px 10px;font-size:13px;background:#f6f7f9;color:inherit}
.side-search input:focus{outline:none;border-color:#1f6feb;background:#fff}
.side-scroll{flex:1;overflow:auto;padding:0 8px 20px;-webkit-overflow-scrolling:touch}
.side-label{font-size:11px;color:#8c959f;padding:12px 8px 5px;letter-spacing:.04em;display:flex;justify-content:space-between;align-items:center}
.side-label .sw{display:flex;gap:2px}
.mini{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;
background:transparent;color:#8c959f;border-radius:5px;cursor:pointer}
.mini:hover{background:#eef0f2;color:#1f2328}
#tree{font-size:13px}
.tnode{min-width:0}
.trow{display:flex;align-items:center;gap:2px;border-radius:7px;padding:1px 6px 1px 0;cursor:default;min-width:0}
.trow:hover{background:#f3f4f6}
.trow.cur{background:#eaf3fe}
.trow.cur .tname{color:#0969da;font-weight:500}
.trow.f .tname{color:#424a53}
.tcar{display:inline-flex;width:18px;height:18px;flex:0 0 18px;align-items:center;justify-content:center;color:#8c959f;
cursor:pointer;border-radius:4px;transition:transform .18s cubic-bezier(.3,.7,.4,1)}
.tcar:hover{background:#e3e6ea;color:#1f2328}
.tcar.open{transform:rotate(90deg)}
.tcar.none{cursor:default;visibility:hidden}
.tico{display:inline-flex;flex:0 0 auto;color:#d4a02a;margin-right:5px}
.tico.f{color:#8c959f}
.tname{flex:1;min-width:0;cursor:pointer;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 2px}
.tcnt{flex:0 0 auto;font-size:11px;color:#6e7781;padding:0 4px;background:#f0f2f4;border-radius:9px;line-height:16px;
min-width:18px;text-align:center;font-variant-numeric:tabular-nums}
.tcnt.dim{background:transparent;color:#a9b1ba}
.trow.cur .tcnt{background:#d7e8fd;color:#0969da}
.tact{flex:0 0 auto;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;
padding:0;border:none;background:transparent;color:#8c959f;border-radius:5px;cursor:pointer;opacity:0;
transition:opacity .12s}
.trow:hover .tact,.trow.cur .tact{opacity:1}
.tact:hover,.tact:focus{background:#e3e6ea;color:#1f2328;opacity:1}
@media (hover:none){ .tact{opacity:1} }
/* 触屏设备（iOS 不支持 webkitdirectory）不显示文件夹上传按钮 */
@media (hover:none) and (pointer:coarse){ #btnUpDir{display:none} }
/* 目录树操作菜单（右键 / ⋯） */
#ctx{position:fixed;left:0;top:0;z-index:120;min-width:150px;background:#fff;border:1px solid #e3e6ea;
border-radius:10px;box-shadow:0 8px 26px rgba(31,35,40,.16);padding:5px;display:none}
#ctx.on{display:block}
#ctx .ctop{font-size:11px;color:#8c959f;padding:5px 9px 6px;max-width:210px;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #eef0f2;margin-bottom:4px}
#ctx .ci{display:flex;align-items:center;width:100%;border:none;background:transparent;text-align:left;
padding:7px 10px;border-radius:7px;font-size:13px;color:#1f2328;cursor:pointer;font-family:inherit}
#ctx .ci:hover{background:#f3f4f6}
/* 置灰的菜单项（「发布」在无改动时禁用）：悬停不能有可点的反馈 */
#ctx .ci:disabled,#ctx .ci:disabled:hover{color:#b3b8be;background:transparent;cursor:not-allowed}
#ctx .ci.danger{color:#c0392b}
#ctx .ci.danger:hover{background:#fdeaea}
#ctx .csep{height:1px;background:#eef0f2;margin:4px 6px}
/* 展开/折叠：grid-template-rows 0fr → 1fr，无需测量高度，也不会整块重绘 */
.tkids{display:grid;grid-template-rows:0fr;transition:grid-template-rows .24s cubic-bezier(.22,.61,.36,1);
margin-left:14px}
.tkids.open{grid-template-rows:1fr}
.tkids-in{overflow:hidden;min-height:0}
/* 目录树分区：受保护 / 普通文件夹各占一个带边框的独立板块 */
.tsec{border:1px solid #e0e4e9;border-radius:9px;margin:5px 2px 7px 0;padding:3px 3px 4px;background:#fbfcfd}
.tsec-t{font-size:11px;font-weight:700;color:#57606a;padding:3px 8px 5px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsec-c{margin-left:6px;font-weight:400;color:#8c959f}
.tsec-prot{border-color:#e3c46a;background:#fffdf3;box-shadow:0 0 0 1px #f5e9c8}
.tsec-prot .tsec-t{color:#9a6700}
.tsec-prot .tsec-c{color:#b08a2e}
.sfile{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;cursor:pointer;font-size:13px}
.sfile:hover{background:#f3f4f6}
.sfile.cur{background:#eaf3fe;color:#0969da}
.sfile .fname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sfile .fsz{font-size:11px;color:#8c959f;flex:0 0 auto}
.side-hint{color:#8c959f;font-size:12px;padding:10px 8px}

main{flex:1;min-width:0;height:100%;overflow:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column}
.wrap{flex:1;display:flex;flex-direction:column;padding:14px 18px 60px;min-height:0}
/* 编辑器不留那 60px"呼吸空白"：文本区已经 flex:1，底部多出来的空白只会让人觉得"没铺满"。
   列表页保留 60px（最后一个文件不贴边）。 */
#viewEdit{padding-bottom:14px}

.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.bar .sp{flex:1}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eef0f2;font-size:13px}
th{background:#fafbfc;font-weight:600;color:#57606a;font-size:12px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fafbfc}
tbody tr.picked td{background:#f2f7ff}
.nm{display:flex;align-items:center;gap:8px;min-width:0}
.ico{display:inline-flex;flex:0 0 auto}
.ico.dir{color:#d4a02a}
.ico.f{color:#8c959f}
.ck{width:15px;height:15px;margin:0;flex:0 0 auto;cursor:pointer;accent-color:#1f6feb}
/* 多选模式（触屏长按进入）：整行都能点，不用去戳那个小方框 */
body.multi #list tbody tr{cursor:pointer}
body.multi #list tbody tr.picked td{background:#e8f1ff}
a.link{color:#1f2328;text-decoration:none;word-break:break-all}
a.link:hover{text-decoration:underline;color:#0969da}
/* 文件后缀徽标：目录树里长名字会被省略号截断（"节点链接_主要…"），
   把后缀单独做成徽标挂在名字旁边，截断了也照样能一眼看出是什么类型 */
.extb{flex:0 0 auto;font-size:10px;line-height:1.55;padding:0 5px;border-radius:4px;margin-left:6px;
font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;letter-spacing:.03em;
text-transform:uppercase;white-space:nowrap;user-select:none;vertical-align:1px}
.trow .extb,.sfile .extb{font-size:9.5px;padding:0 4px;margin-left:5px;line-height:1.45}
.ops{display:flex;gap:2px;flex-wrap:nowrap;justify-content:flex-end}
.op{border:none;background:transparent;color:#57606a;cursor:pointer;font-size:12px;padding:3px 7px;border-radius:6px;white-space:nowrap}
.op:hover{background:#eef0f2;color:#1f2328}
/* 置灰的操作按钮（「发布」在"没有改动"时禁用）：要看起来真的不可点，且悬停不能有反馈 */
.op:disabled,.op:disabled:hover{color:#b3b8be;background:transparent;cursor:not-allowed}
.op.del:hover{background:#fdeaea;color:#c0392b}
/* 图标形态的操作按钮（分享管理里的「打开」） */
.op.iconb{padding:3px 6px;display:inline-flex;align-items:center;color:#0969da}
.op.iconb svg{display:block}
.op.iconb:hover{background:#eaf2fd;color:#0969da}
.mgrHead .mgrLocate{color:#0f6e56;margin-left:6px}
.mgrHead .mgrLocate:hover{background:#e1f5ee;color:#085041}
/* 列表行的 ⋯ 按钮：悬停该行 / 选中该行 / 键盘聚焦时出现（树行的 .trow 规则也保留） */
tbody tr:hover .tact,tbody tr.picked .tact,tbody tr:focus-within .tact{opacity:1}
.empty{text-align:center;color:#8c959f;padding:46px 0}
.tip{margin:10px 2px 0;color:#8c959f;font-size:12px}

.editTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.editTop .sp{flex:1}
/* 编辑器顶部的路径条：和顶栏那条面包屑同一套样式，但**不换行、可横向滑动**，
   否则长路径会把工具条撑成两行。目录级可点，点一下直接跳到那一级。 */
.edCrumb{flex:1;min-width:0;flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;font-size:12.5px;
scrollbar-width:none;padding-bottom:1px}
.edCrumb::-webkit-scrollbar{display:none}
.edCrumb .curfile{color:#1f2328;font-weight:500}
.zoom{display:inline-flex;align-items:center;gap:2px;border:1px solid #d0d7de;border-radius:8px;background:#fff;overflow:hidden}
.zoom button{border:none;background:transparent;cursor:pointer;padding:5px 8px;font-size:12px;color:#57606a}
.zoom button:hover{background:#f3f4f6;color:#1f2328}
.zoom span{font-size:12px;color:#57606a;min-width:30px;text-align:center}
#edt{flex:1;min-height:300px;width:100%;border:1px solid #cfe0f7;border-radius:10px;padding:14px 16px;
font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:13px;line-height:1.7;resize:none;
background:#fff;color:#1f2328;tab-size:2}
/* 自动换行：开启时连无空格的长串（base64 / 订阅链接）也强制断行；关闭时长行横向滚动 */
#edt.wrapon{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}
#edt.wrapoff{white-space:pre;overflow-x:auto}
#viewer.wrapoff{white-space:pre;word-break:normal;overflow-x:auto}
/* 换行开关：像 VS Code 那样的状态按钮，开启时高亮 */
.wtog{display:inline-flex;align-items:center;gap:5px;font-family:inherit;font-size:12px;padding:4px 10px;
border:1px solid #d0d7de;border-radius:7px;background:#fff;color:#57606a;cursor:pointer;white-space:nowrap}
.wtog:hover{border-color:#8c959f;color:#1f2328}
.wtog.on{background:#eaf3fe;border-color:#cfe0f7;color:#0969da;font-weight:500}
.wtog svg{flex:0 0 auto}
#edt:focus{outline:none;border-color:#1f6feb;box-shadow:0 0 0 3px rgba(31,111,235,.12)}
.editFoot{display:flex;justify-content:flex-end;gap:14px;font-size:12px;color:#8c959f;padding:6px 2px 2px}
.editFoot .sp{flex:1}
.chip{font-size:11.5px;color:#0969da;background:#eaf3fe;border:1px solid #cfe0f7;border-radius:20px;
padding:2px 9px;white-space:nowrap;font-weight:500}
.roTag{font-size:11.5px;color:#6e7781;background:#f0f2f4;border-radius:20px;padding:2px 9px;white-space:nowrap}
/* 只读查看器：不是输入框，用户一眼就知道改不了 */
.vHead{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:10px}
.vHead .ico{color:#8c959f}
.vName{font-size:14px;font-weight:600;color:#1f2328;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vMeta{font-size:12px;color:#8c959f}
.vHead .sp{flex:1}
#viewer{flex:1;min-height:320px;margin:0;overflow:auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;
padding:16px 18px;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:13px;
line-height:1.75;white-space:pre-wrap;word-break:break-word;color:#1f2328;tab-size:2;
-webkit-overflow-scrolling:touch;user-select:text;cursor:text}


.hint{color:#57606a;font-size:12.5px;line-height:1.7}
.hint.dim{color:#8c959f}
.shform{display:flex;gap:8px;margin-top:11px;flex-wrap:wrap}
.shform input{flex:1;min-width:150px}
.shform select{border:1px solid #d0d7de;border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;background:#fff;color:inherit}
.okbox{margin-top:12px;border:1px solid #bfe3c8;background:#f2fbf5;border-radius:9px;padding:11px 12px}
.okhead{display:flex;align-items:center;gap:8px;font-size:13px;color:#1a7f37;font-weight:500;margin-bottom:8px}
.okhead .sp{flex:1}
input.linkbox{width:100%;border:1px solid #cfe0f7;border-radius:8px;padding:8px 10px;font-size:12.5px;background:#fff;color:#1f2328;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer}
input.linkbox:focus{outline:none;border-color:#1f6feb}
.lnk{border:none;background:transparent;color:#0969da;font-size:12px;cursor:pointer;padding:0;font-family:inherit;text-decoration:underline}
.lnk:hover{color:#1a60d0}
.qrbox{margin-top:11px;display:flex;flex-direction:column;align-items:center;gap:6px}
.qrbox .qr{background:#fff;padding:8px;border:1px solid #e3e6ea;border-radius:8px;line-height:0;min-height:0}
.qrbox .qr img,.qrbox .qr canvas{display:block}
.shares{margin-top:12px;border:1px solid #e3e6ea;border-radius:9px;overflow:hidden}
.shrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid #eef0f2;flex-wrap:wrap}
.shrow:last-child{border-bottom:none}
.shmeta{display:flex;align-items:center;gap:7px;min-width:0;flex:1;flex-wrap:wrap}
.tag{flex:0 0 auto;font-size:11px;padding:1px 6px;border-radius:5px;background:#eef0f2;color:#57606a}
.tag.warn{background:#faeeda;color:#854f0b}
.tag.pub{background:#eaf7ee;color:#1a7f37}
/* 发布 / 撤回：与「取消分享」区分开，撤回只影响分享页可见性，不删链接 */
.op.pub{color:#1a7f37}
.op.pub:hover{background:#eaf7ee;color:#146c2e}
.op.unpub{color:#854f0b}
.op.unpub:hover{background:#faeeda;color:#6f420a}
.shbadge{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;line-height:1.5;padding:1px 6px;
border-radius:20px;background:#eaf7ee;color:#1a7f37;border:1px solid #cbe8d3;cursor:pointer;font-family:inherit;
flex:0 0 auto;margin-left:6px}
.shbadge:hover{background:#ddf1e4}
.shdot{display:inline-flex;align-items:center;color:#1a7f37;flex:0 0 auto;margin-left:4px;
border:0;background:transparent;padding:2px;border-radius:5px;cursor:pointer;font:inherit}
.shdot:hover{background:#e6f4ea;color:#0d5c22}
.shdot:focus-visible{outline:2px solid #1a7f37;outline-offset:1px}
/* 受保护文件夹：列表里的红色锁徽标 + 行左侧金色色条，一眼可辨 */
.prot{display:inline-flex;align-items:center;gap:3px;margin-left:8px;padding:1px 7px;border-radius:999px;background:#fdecea;color:#c0392b;font-size:11px;font-weight:600;border:1px solid #f3b7b3;vertical-align:middle;white-space:nowrap}
.prot-row{background:#fffdf5}
.prot-row:hover{background:#fff8e6}
.prot-row>td:first-child{box-shadow:inset 3px 0 0 #e0a800}
.tprot{flex:0 0 auto;margin-left:4px;font-size:11px;line-height:1}
/* 列表分区栏：把「受保护」与「普通」文件夹分成两条带 */
/* 主列表分区栏：整幅色带 + 左侧粗色条 + 板块间白色隔离带，两个区间一眼分开 */
.sect>td{padding:0;border-top:0;border-bottom:0}
tbody>.sect:not(:first-child)>td{border-top:12px solid #fff}
.sect .band{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#edf0f3;border-top:1px solid #d8dde3;border-bottom:2px solid #cfd5db;border-left:7px solid #6b7280}
.sect-t{font-size:13px;font-weight:700;color:#37414c;letter-spacing:.02em}
.sect-h{margin-left:8px;font-size:11.5px;color:#6b7480;font-weight:400}
.sect-prot .band{background:#fdf3d0;border-top-color:#e8cd85;border-bottom-color:#dfba5c;border-left-color:#d4a017}
.sect-prot .sect-t{color:#8a5f00}
.sect-prot .sect-h{color:#a07c1f}
.mgrGrp{margin-top:14px;border:1px solid #e3e6ea;border-radius:9px;overflow:hidden}
.mgrHead{display:flex;align-items:center;gap:7px;padding:7px 10px;background:#f7f8fa;border-bottom:1px solid #eef0f2}
.mgrPath{font-size:12.5px;color:#1f2328;word-break:break-all}
.mcactions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.polstat{margin-top:8px;border:1px solid #e3e6ea;border-radius:9px;padding:9px 11px;font-size:12.5px;color:#57606a}
.polstat div{display:flex;align-items:center;gap:7px;padding:2px 0}
.pdot{width:8px;height:8px;border-radius:50%;flex:0 0 8px;display:inline-block;background:#8c959f}
.pdot.ok{background:#1a7f37}
.pdot.warn{background:#bf8700}
.pol{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border:1px solid #e3e6ea;border-radius:8px;
margin-top:7px;cursor:pointer;font-size:13px;color:#1f2328}
.pol:hover{background:#f7f8fa}
.pol input{margin:2px 0 0;flex:0 0 auto}
.pol code{background:#f1efE8;padding:0 4px;border-radius:4px;font-size:12px}
.shpath{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all;color:#1f2328}
.hop{display:flex;gap:2px;flex:0 0 auto}

input[type=text],input[type=password],input[type=search]{border:1px solid #d0d7de;border-radius:8px;padding:8px 10px;font-size:13px;
font-family:inherit;background:#fff;color:#1f2328}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:#1f6feb}

.mask{position:fixed;inset:0;background:rgba(31,35,40,.45);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
.mask.on{display:flex}
.dlg{background:#fff;border-radius:12px;width:100%;max-width:780px;min-width:0;padding:18px;max-height:92vh;display:flex;flex-direction:column}
.dlg.sm{max-width:440px}
.dlg h3{margin:0 0 12px;font-size:15px}
.dlg .body{overflow:auto;min-height:0}
.dlg .body textarea{width:100%;height:44vh;border:1px solid #d0d7de;border-radius:8px;padding:10px;font-size:13px;resize:vertical;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.6}
.dlg .foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex:0 0 auto}
.msg{font-size:13px;color:#57606a;line-height:1.75;word-break:break-all}
.mvbar{display:flex;align-items:center;gap:8px;margin-top:8px}
.mvpath{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#57606a;word-break:break-all;flex:1;min-width:0}
.mvlist{margin-top:8px;max-height:230px;overflow:auto;border:1px solid #e3e6ea;border-radius:9px}
.mvrow{display:flex;align-items:center;gap:6px;padding:7px 10px;font-size:13px;cursor:pointer;border-bottom:1px solid #eef0f2}
.mvrow:last-child{border-bottom:none}
.mvrow:hover{background:#f3f4f6}
.mvrow.dis{opacity:.4;cursor:not-allowed;background:#fafbfc}

#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1f2328;color:#fff;padding:9px 18px;border-radius:9px;
font-size:13px;opacity:0;transition:opacity .18s;pointer-events:none;z-index:99;max-width:88vw;text-align:center}
#toast.on{opacity:1}
#drop{position:fixed;inset:0;background:rgba(31,111,235,.06);border:3px dashed #1f6feb;display:none;align-items:center;
justify-content:center;z-index:60;font-size:16px;color:#1a60d0;font-weight:600}
#drop.on{display:flex}
#up{position:fixed;right:18px;bottom:18px;width:310px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #e3e6ea;
border-radius:10px;padding:12px;z-index:70;display:none}
#up h4{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
#up .it{font-size:12px;color:#57606a;margin-top:8px}
#up .bar{height:5px;background:#eef0f2;border-radius:3px;margin-top:4px;overflow:hidden;margin-bottom:0}
#up .bar i{display:block;height:100%;background:#1f6feb;width:0;transition:width .15s}
#up .x{border:none;background:transparent;cursor:pointer;color:#8c959f;font-size:14px;padding:0 2px}
#batch{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:40;display:none;align-items:center;flex-wrap:wrap;
justify-content:center;gap:10px;background:#1f2328;color:#fff;border-radius:10px;padding:9px 14px;font-size:13px;max-width:calc(100vw - 24px)}
#batch.on{display:flex}
#batch button{border:1px solid rgba(255,255,255,.28);background:transparent;color:#fff;border-radius:7px;padding:4px 10px;
font-size:12.5px;cursor:pointer;white-space:nowrap}
#batch button:hover{background:rgba(255,255,255,.12)}
#batch button.danger{background:#d1453b;border-color:#d1453b}
#batch button.danger:hover{background:#b93c33}
body.has-batch #toast{bottom:76px}
#sideMask{position:fixed;inset:0;background:rgba(31,35,40,.4);z-index:44;display:none}
body.side-open #sideMask{display:block}

@media(max-width:900px){
  /* 高度链必须一直传下去：body(至少一屏高·列方向) → .layout → main → .wrap → #edt 各自 flex:1。
     以前这里是 body{display:block} + main{height:auto}，高度改成"由内容决定"，
     于是打开一个只有几行的文件时，整页高度只够那几行，文本框下面空出一大片。
     页面本身仍然是整页滚动（body overflow:auto），不是容器内滚动。 */
  body{display:flex;flex-direction:column;height:auto;min-height:100vh;overflow:auto}
  .layout{display:flex;max-width:none}   /* 保持 flex：aside 已经是 fixed，不占流，main 自然独占 */
  main{height:auto;overflow:visible}
  .wrap{padding:12px 12px 72px}
  /* 编辑器里没有底部批量条，那 72px 留给"操作条"的余量用不上，还给文本框 */
  #viewEdit{padding-bottom:12px}
  aside{position:fixed;top:0;left:0;bottom:0;width:274px;height:auto;z-index:45;transform:translateX(-100%);
  transition:transform .2s;box-shadow:0 0 26px rgba(0,0,0,.14)}
  body.side-open aside{transform:none}
  .sideGrip{display:none}          /* 抽屉模式下不需要调宽手柄 */
  #sideBtn{display:inline-flex}
  /* 手机上更需要知道"自己在哪一级"：收起站点标题，把这块位置让给路径面包屑。
     长路径横向滑动即可，点任意一级直接跳过去 —— 不必再开左侧抽屉。 */
  .brand span{display:none}
  .crumb{display:flex;flex-wrap:nowrap;overflow-x:auto;min-width:0;font-size:12.5px;
  scrollbar-width:none;white-space:nowrap;padding-bottom:1px}
  .crumb::-webkit-scrollbar{display:none}
  thead{display:none}
  .hide-s{display:none}
  table,tbody,tr,td{display:block;width:100%}
  tr{padding:10px 12px;border-bottom:1px solid #eef0f2}
  tbody tr:last-child{border-bottom:none}
  td{padding:0;border:none}
  td:last-child{margin-top:8px}
  .ops{justify-content:flex-start;flex-wrap:wrap}
  .empty{padding:34px 12px}
  .mask{padding:12px}
  .dlg{max-width:100%;padding:15px}
  .dlg.sm{max-width:100%}
  #edt{min-height:46vh}
  /* 查看器小屏：文件名一行，操作按钮单独一行且等宽，避免"返回列表"被挤下去 */
  .vHead{gap:6px 8px}
  .vHead .sp{flex:1 0 100%;height:0}
  .vHead .btn.sm{flex:1;justify-content:center}
  .vHead .btn.sm.ghost{border-color:#d0d7de;background:#fff;color:#1f2328}
  #viewer{padding:13px 14px}
  /* 底部批量条：小屏改成通栏 + 按钮等分，否则几个按钮挤成一坨，手指点不中 */
  #batch{left:8px;right:8px;bottom:8px;transform:none;max-width:none;gap:8px;padding:9px 10px;border-radius:12px}
  #batchInfo{flex:1 0 100%;text-align:center;font-size:12.5px;color:#d8dee4}
  #batch button{flex:1 1 0;min-width:0;padding:8px 4px;font-size:12.5px}
  body.has-batch #toast{bottom:122px}
  body.has-batch .wrap{padding-bottom:172px}
}

/* ===== 渲染层（Markdown / 代码 / JSON / 表格 / 媒体）===== */
.rBox{flex:1;min-height:320px;overflow:auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;
padding:16px 20px;color:#1f2328;line-height:1.75;-webkit-overflow-scrolling:touch;user-select:text}
.rBox>*:first-child{margin-top:0}
.rBox>*:last-child{margin-bottom:0}
.rBox h1,.rBox h2,.rBox h3,.rBox h4,.rBox h5,.rBox h6{margin:1.3em 0 .55em;line-height:1.35;font-weight:600}
.rBox h1{font-size:1.6em;padding-bottom:.28em;border-bottom:1px solid #eef0f2}
.rBox h2{font-size:1.34em;padding-bottom:.24em;border-bottom:1px solid #eef0f2}
.rBox h3{font-size:1.16em}.rBox h4{font-size:1.03em}.rBox h5,.rBox h6{font-size:.95em;color:#57606a}
.rBox p{margin:.75em 0}
.rBox ul,.rBox ol{margin:.6em 0;padding-left:1.6em}
.rBox li{margin:.28em 0}
.rBox li>ul,.rBox li>ol{margin:.2em 0}
.rBox blockquote{margin:.8em 0;padding:.15em 1em;border-left:3px solid #d0d7de;color:#57606a;background:#fafbfc}
.rBox hr{border:none;border-top:1px solid #e3e6ea;margin:1.4em 0}
.rBox a{color:#0969da}
.rBox img{max-width:100%;height:auto;border-radius:8px}
.rBox code{background:#f1f3f5;padding:.15em .4em;border-radius:4px;font-size:.88em;
font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}
.rBox pre{background:#f7f8fa;border:1px solid #eef0f2;border-radius:9px;padding:12px 14px;overflow:auto;margin:.85em 0}
.rBox pre code{background:transparent;padding:0;font-size:12.5px;line-height:1.65}
.rBox table{border-collapse:collapse;width:auto;min-width:52%;margin:.9em 0;font-size:13px;background:#fff;
border:1px solid #e3e6ea;border-radius:8px}
.rBox th,.rBox td{border:1px solid #eef0f2;padding:6px 11px;text-align:left}
.rBox th{background:#fafbfc;font-weight:600;color:#57606a}
.rBox thead th:first-child{border-top-left-radius:8px}
.rBox .task{list-style:none;margin-left:-1.25em}
.rBox .task input{margin-right:.45em;vertical-align:-1px}
.rBox .tocInline{border:1px solid #e3e6ea;background:#fafbfc;border-radius:9px;padding:10px 14px;margin:.9em 0}
.rBox .tocInline b{display:block;font-size:12px;color:#57606a;margin-bottom:5px;font-weight:600}
.rBox .tocInline a{display:block;font-size:12.5px;padding:1px 0;color:#0969da}
.rBox .tocInline a.lv2{padding-left:12px}
.rBox .tocInline a.lv3{padding-left:24px}
.rBox .tocInline a.lv4,.rBox .tocInline a.lv5,.rBox .tocInline a.lv6{padding-left:36px}

/* 语法高亮（GitHub 亮色系） */
.tk-c{color:#6e7781;font-style:italic}
.tk-s{color:#0a5f2e}
.tk-n{color:#0550ae}
.tk-k{color:#cf222e}
.tk-p{color:#57606a}
.tk-a{color:#953800}

/* JSON 折叠树 */
.jt{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.75}
.jtRow{white-space:pre-wrap;word-break:break-word}
.jtTog{display:inline-block;width:13px;cursor:pointer;color:#8c959f;user-select:none;text-align:center}
.jtTog:hover{color:#1f2328}
.jtKids{margin-left:15px;border-left:1px solid #eef0f2;padding-left:7px}
.jtKids.hide{display:none}
.jtKey{color:#0550ae}
.jtStr{color:#0a5f2e}
.jtNum{color:#953800}
.jtBool{color:#cf222e}
.jtNull{color:#8250df}
.jtSum{color:#8c959f;font-size:11.5px}

/* ===== HTML 预览（sandbox iframe）===== */
/* 渲染全部交给用户浏览器，Worker 只传已在 action=read 拿到的同一份文本，增量开销为 0。
   容器不留白边：预览要尽量贴近"真实页面"，多一层 padding 会让窄页面在手机上也缩在中间。
   flex-direction 必须显式写 column：.rBox 本身没写方向，默认是 row ——
   那样 iframe 和下面的说明会**横向并排**，iframe 被说明文字挤到只剩几百 px（实测 312px）。 */
.rBox.htmlBox{padding:0;overflow:hidden;display:flex;flex-direction:column;background:#fff}
.rBox.htmlBox iframe{flex:1 1 auto;width:100%;min-height:320px;border:0;background:#fff}
.htmlNote{flex:0 0 auto;padding:9px 13px;border-top:1px solid #eef0f2;background:#fafbfc;
  border-radius:0 0 9px 9px;font-size:12px;color:#57606a;line-height:1.6}
.htmlNote b{color:#953800;font-weight:600}

/* CSV 表格 */
.csvWrap{overflow:auto;border:1px solid #e3e6ea;border-radius:9px;max-height:none}
.csv{border-collapse:separate;border-spacing:0;font-size:12.5px;background:#fff;white-space:nowrap}
.csv th,.csv td{border-bottom:1px solid #eef0f2;border-right:1px solid #f4f5f7;padding:6px 11px;text-align:left}
.csv th{position:sticky;top:0;background:#fafbfc;font-weight:600;color:#57606a;z-index:1;cursor:pointer}
.csv th:hover{background:#f1f3f5}
.csv tbody tr:hover td{background:#fafbfc}
.csv td.num{text-align:right;font-variant-numeric:tabular-nums}

/* 媒体预览 */
.mediaBox{flex:1;min-height:320px;display:flex;align-items:center;justify-content:center;background:#1f2328;
border-radius:10px;overflow:hidden;position:relative}
.mediaBox img{max-width:100%;max-height:72vh;display:block;transition:transform .15s;cursor:zoom-in}
.mediaBox video,.mediaBox audio{max-width:100%;max-height:72vh;background:#000}
.mediaBox audio{width:min(560px,92%)}
.frameBox{flex:1;min-height:420px;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
.frameBox iframe{width:100%;height:100%;min-height:420px;border:0;display:block;background:#fff}
.mediaBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.rawNote{font-size:12.5px;color:#8c959f;background:#fafbfc;border:1px solid #eef0f2;border-radius:8px;
padding:8px 11px;margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}

/* 查看器 / 编辑器 视图切换 */
.vseg{display:inline-flex;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;background:#fff}
.vseg button{border:none;background:transparent;padding:4px 11px;font-size:12.5px;cursor:pointer;color:#57606a;
font-family:inherit;white-space:nowrap}
.vseg button+button{border-left:1px solid #e3e6ea}
.vseg button.on{background:#eaf3fe;color:#0969da;font-weight:500}
.vseg button:hover:not(.on){background:#f3f4f6}

/* ===== 编辑器：行号 + 查找替换 ===== */
.edRow{flex:1;min-height:300px;display:flex;min-width:0;position:relative}
.edGutter{flex:0 0 52px;width:52px;overflow:hidden;position:relative;background:#fafbfc;
border:1px solid #e3e6ea;border-right:none;border-radius:10px 0 0 10px}
.edGutterIn{position:absolute;top:0;left:0;right:0;will-change:transform}
.edGutNum{position:absolute;right:8px;color:#b4b2a9;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
font-size:12px;line-height:1;user-select:none}
.edGutNum.cur{color:#1f6feb;font-weight:600}
.edTA{position:relative;flex:1;min-width:0;display:flex}
#edt.withGut{border-radius:0 10px 10px 0}
/* 读取中的半透明态：给"载入中…"一个看得见的对应物，消除"点了没反应"的错觉 */
#edt.edt-loading{opacity:.45;transition:opacity .12s}
#edHl{position:absolute;inset:0;overflow:hidden;pointer-events:none;border:1px solid transparent;
border-radius:10px;z-index:2}
#edHlIn{padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;color:transparent;will-change:transform}
#edHlIn .hmark{background:rgba(255,196,77,.42);border-radius:2px}
/* 多关键词各给一种底色（与侧栏结果同一套色），一眼看出"哪个词命中哪一段"。
   必须排在 .cur 之前：两者特异性相同，靠后者胜出，当前命中要盖过按词分色。 */
#edHlIn .hmark.t1{background:#cfe8ff}
#edHlIn .hmark.t2{background:#d6f5e3}
#edHlIn .hmark.t3{background:#ffd9e0}
#edHlIn .hmark.cur{background:rgba(255,146,0,.62)}
/* 编辑器里正文中的完整网址：不做任何颜色/底纹覆盖，只在网址末尾挂一个极小的链接图标，
   点图标即在新标签打开。图标绝对定位、不占正文位置，所以排版和纯文本完全一致，
   不会出现"底色块错位/盖住文字"的问题。只显示图标、不带文字。
   尺寸压到 11px 并抬高成"上标"，这是躲开后面那个字的唯一办法：文本框的排版动不了，
   图标只要平着放就必然压住后一个字的字身，抬到字身之上才不打架。
   （只读分享页是纯文本视图，不挂图标，避免分享内容被前端改动。） */
.lnkico{display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;
padding:0;border:none;background:transparent;border-radius:3px;cursor:pointer;
color:#6aa9e0;vertical-align:1px;text-decoration:none}
.lnkico:hover{color:#0969da;background:rgba(9,105,218,.12)}
.lnkico svg{display:block;width:9px;height:9px;pointer-events:none}
/* 编辑器里的图标层：与文本叠层同一坐标系，随文本框滚动一起位移。
   层本身不吃鼠标（pointer-events:none），只有图标本身可点 —— 点空白处仍然是放光标。
   这里 margin 归零：绝对定位的 left 已经精确落在网址末尾，不能再被 margin 推走。 */
#edLinkIcons{position:absolute;inset:0;overflow:hidden;pointer-events:none;will-change:transform}
#edLinkIcons .lnkico{position:absolute;margin:0;vertical-align:baseline;pointer-events:auto}
/* 量行高用的隐形镜像层。
   坑：只写 overflow:hidden 是不够的 —— height:auto 时盒子会跟着内容一起长高（实测能到 4400px），
   它就是 main 的绝对定位后代，于是把 main 的可滚动区域撑出一大截空白，
   用户能往下滑几千像素只看到白屏。必须同时给它 inset:0 把盒子钉在编辑器范围内，
   children 仍然会正常参与布局，所以 offsetHeight 量出来还是真实高度，测量不受影响。
   #edMeasure 是同一套几何，专供"量网址坐标"用 —— 镜像层的内容会被行号槽反复重写，不能共用。 */
#edMirror,#edMeasure{position:absolute;inset:0;visibility:hidden;pointer-events:none;overflow:hidden;
padding:14px 16px;border:1px solid transparent;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;
font-size:13px}

.fbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:9px;padding:8px 10px;
background:#fafbfc;border:1px solid #e3e6ea;border-radius:9px}
.fbar input[type=text]{padding:5px 9px;font-size:12.5px;width:170px;font-family:inherit}
.fbar .fbtn{border:1px solid #d0d7de;background:#fff;border-radius:7px;padding:5px 10px;font-size:12.5px;
cursor:pointer;color:#1f2328;font-family:inherit;white-space:nowrap}
.fbar .fbtn:hover{background:#f3f4f6}
.fbar .fbtn.on{background:#eaf3fe;border-color:#cfe0f7;color:#0969da;font-weight:500}
.fbar .fstat{font-size:12px;color:#8c959f;min-width:76px;font-variant-numeric:tabular-nums}
.fbar .sp{flex:1}

.edPrev{flex:1;min-height:300px}

/* Markdown 大纲 */
.outline{position:absolute;right:0;top:44px;width:206px;max-height:56%;overflow:auto;background:#fff;
border:1px solid #e3e6ea;border-radius:9px;padding:8px 10px;z-index:5;box-shadow:0 6px 20px rgba(31,35,40,.1)}
.outline b{display:block;font-size:11px;color:#8c959f;margin-bottom:5px;letter-spacing:.03em}
.outline a{display:block;font-size:12.5px;color:#1f2328;padding:2px 4px;border-radius:5px;text-decoration:none;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.outline a:hover{background:#eef4fd;color:#0969da}
.outline a.lv2{padding-left:14px}.outline a.lv3{padding-left:26px}
.outline a.lv4,.outline a.lv5,.outline a.lv6{padding-left:38px}

/* 搜索结果里的正文命中片段 */
.sr-snip{display:block;font-size:11.5px;color:#57606a;margin-top:2px;line-height:1.5;
white-space:normal;word-break:break-word}
/* 关键词高亮。多关键词时按词轮换底色 —— 一眼看出"哪个词命中了哪一段"。
   底色统一走 --hlbg 变量，容器规则只负责排版、不再写死 background，
   否则容器规则的特异性更高，会把 .hl-1/.hl-2 的换色压回同一个黄。 */
.hl{--hlbg:#ffe9a8;background:var(--hlbg);color:#1f2328;border-radius:2px;padding:0 1px}
.hl-1{--hlbg:#cfe8ff}
.hl-2{--hlbg:#d6f5e3}
.hl-3{--hlbg:#ffd9e0}
.sr-snip .hl{border-radius:2px;padding:0 1px}
.sr-cut{display:inline-block;font-size:10.5px;color:#854f0b;background:#faeeda;border-radius:4px;
padding:0 4px;margin-left:4px}
/* 深搜结果的行号列表：点一行 → 打开文件并跳到那一行 */
.dllist{max-height:46vh;overflow:auto;border:1px solid #e3e6ea;border-radius:8px;margin-top:10px}
.dlrow{display:flex;gap:8px;align-items:baseline;padding:7px 10px;cursor:pointer;
border-bottom:1px solid #eef0f2}
.dlrow:last-child{border-bottom:none}
.dlrow:hover{background:#f0f6ff}
.dlrow .dln{flex:0 0 auto;font-size:11.5px;color:#0969da;font-variant-numeric:tabular-nums}
.dlrow .dlt{flex:1;min-width:0;font-size:12px;color:#1f2328;white-space:normal;word-break:break-all}
.dlrow .dlt .hl{border-radius:2px;padding:0 1px}
.dlrow .dlc{flex:0 0 auto;font-size:11px;color:#8c959f;font-variant-numeric:tabular-nums}
.sr-tag{font-size:10px;padding:0 4px;border-radius:4px;background:#eaf3fe;color:#0969da;margin-left:4px}
.sr-tag.path{background:#f1efe8;color:#5f5e5a}
.sr-tag.dir{background:#e1f5ee;color:#0f6e56}
.sr-tag.cnt{background:#faeeda;color:#854f0b}
/* 结果行里的目录路径 / 修改时间：都是 fname 内部的整行块（fname 本身是 nowrap） */
.sr-dir{display:block;font-size:11px;color:#8c959f;margin-top:1px;
white-space:normal;word-break:break-all}
.sr-meta{display:block;font-size:10.5px;color:#a0a8b0;margin-top:2px}
/* 文件名 / 路径 / 时间里的命中也要高亮（原来只给正文片段和深搜行写了 .hl） */
.sfile .fname .hl,.sr-dir .hl,.sr-meta .hl{border-radius:2px;padding:0 1px}
.sr-end{font-size:11.5px;color:#8c959f}
/* 搜索结果行里的 ⋯ 按钮：悬停才显形（和目录树 / 列表行一致），触屏常显 */
.sfile:hover .tact,.sfile:focus-within .tact{opacity:1}
.sfile.sdir .fname{font-weight:500}
.side-note{font-size:11.5px;color:#8c959f;padding:4px 8px 8px;line-height:1.55}
.idxBtn{width:100%;margin-top:6px;border:1px solid #d0d7de;background:#fff;border-radius:7px;
padding:5px 8px;font-size:12px;cursor:pointer;font-family:inherit;color:#1f2328}
.idxBtn:hover{background:#f3f4f6}

/* ---- 搜索框：历史下拉 + 「只在当前目录内搜索」开关 ---- */
.side-search{position:relative}
.qhist{position:absolute;left:14px;right:14px;top:100%;margin-top:4px;z-index:30;
background:#fff;border:1px solid #d0d7de;border-radius:9px;padding:4px;display:none;
max-height:264px;overflow:auto;box-shadow:0 8px 24px rgba(31,35,40,.14)}
.qhist.on{display:block}
.qhist .qh{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;
cursor:pointer;font-size:12.5px;color:#1f2328}
.qhist .qh:hover,.qhist .qh.on{background:#eef4fd;color:#0969da}
.qhist .qh .qt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qhist .qempty{font-size:11.5px;color:#8c959f;padding:6px 8px}
.qhist .qsep{height:1px;background:#eef0f2;margin:4px 6px}
.qhist .qclr{display:block;width:100%;text-align:left;border:0;background:none;cursor:pointer;
padding:6px 8px;border-radius:6px;font-size:11.5px;color:#8c959f;font-family:inherit}
.qhist .qclr:hover{background:#f3f4f6;color:#1f2328}
.side-scope{display:flex;align-items:center;gap:5px;padding:0 14px 7px;font-size:11.5px;
color:#57606a;cursor:pointer;user-select:none}
.side-scope input{margin:0;flex:0 0 auto;cursor:pointer}
.side-scope b{font-weight:500;color:#1f2328}

/* ---- 结果类型筛选芯片 ---- */
.sr-chips{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px 2px}
.sr-chips button{border:1px solid #d0d7de;background:#fff;border-radius:999px;padding:2px 9px;
font-size:11px;color:#57606a;cursor:pointer;font-family:inherit;line-height:1.6}
.sr-chips button:hover{background:#f3f4f6}
.sr-chips button.on{background:#eaf3fe;border-color:#1f6feb;color:#0969da;font-weight:500}

/* ---- 结果分组标题（文件名命中 / 路径命中 / 正文命中 / 文件夹） ---- */
.sr-group{font-size:10.5px;color:#8c959f;padding:9px 8px 3px;letter-spacing:.03em;font-weight:500}
.sr-group b{color:#57606a;font-weight:500}

/* ---- 「返回搜索结果」条：清空搜索框后还找得回来 ---- */
.sr-back{display:flex;align-items:center;gap:6px;margin:4px 8px 6px;padding:6px 8px;
border:1px solid #d0d7de;border-radius:8px;background:#f6f7f9;font-size:11.5px;color:#57606a}
.sr-back .bk{flex:1;min-width:0;text-align:left;border:0;background:none;padding:0;cursor:pointer;
font-family:inherit;font-size:11.5px;color:#0969da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-back .x{flex:0 0 auto;border:0;background:none;cursor:pointer;color:#8c959f;
font-size:14px;line-height:1;padding:0 2px;font-family:inherit}
.sr-back .x:hover{color:#1f2328}

/* ---- 结果行的键盘选中态（↑↓ 移动、Enter 打开） ---- */
.sfile.sel{background:#eef4fd;box-shadow:inset 2px 0 0 #1f6feb}

/* 大目录"加载更多" */
.moreRow{display:flex;justify-content:center;padding:12px 0}
.moreRow button{border:1px solid #d0d7de;background:#fff;border-radius:8px;padding:6px 16px;font-size:13px;
cursor:pointer;font-family:inherit;color:#1f2328}
.moreRow button:hover{background:#f3f4f6}

@media(max-width:900px){
  .edGutter{display:none}
  #edt.withGut{border-radius:10px}
  .outline{display:none}
  .fbar input[type=text]{width:120px}
  .rBox{padding:13px 14px}
  .mediaBox img{max-height:54vh}
}

/* ===== 触屏专属：长按 = 进入多选 =====
   必须放在所有桌面规则之后 —— .ck 的桌面规则特异性相同，
   CSS 同特异性下"后写的赢"，放前面会被上面那条直接压掉。
   ① -webkit-touch-callout:none 挡掉 iOS 长按弹出的「拷贝 / 查询」气泡，
      否则长按到一半就被系统菜单抢走，用户会以为"长按没反应"；
   ② user-select:none 防止长按变成选文字；
   ③ touch-action:pan-y 让纵向滑动照常滚页 —— 手指一旦划动，浏览器会发
      pointercancel，长按计时器随之取消，不会误触发；
   ④ 复选框 15px → 21px。它才是"多选"的常驻可见入口（点它就能逐个多选），
      长按只是让"不用瞄准"的快捷方式，所以这里不再另设一个「多选」按钮
      —— 那会和长按完全重复，还把每行操作区从 6 个按钮挤到 7 个。 */
@media (hover:none) and (pointer:coarse){
  #list tbody tr{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;touch-action:pan-y}
  .ck{width:21px;height:21px}
}
</style>
</head>
<body>

<header>
  <button class="btn ghost sm" id="sideBtn" title="文件管理">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>
  </button>
  <div class="brand">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d4a02a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
    <span>${escapeHtml(title)}</span>
  </div>
  ${readonly ? '<span class="chip">只读分享</span>' : ''}
  <nav class="crumb" id="crumb"></nav>
  <div id="acct"></div>
</header>

<div class="layout">
  <aside>
    <div class="side-top">
      <span>${readonly ? escapeHtml(shareName || '分享内容') : '文件管理'}</span>
      <span class="sp"></span>
    </div>
    <div class="side-search">
      <input type="search" id="q" placeholder="${readonly ? '按文件名 / 目录搜索…' : '搜索文件...'}" autocomplete="off">
      <div class="qhist" id="qHist"></div>
    </div>
    <label class="side-scope" id="sideScope" hidden>
      <input type="checkbox" id="qScope"><span>只在当前目录内搜索 <b id="qScopeName"></b></span>
    </label>
    <div class="side-scroll" id="sideScroll"></div>
  </aside>

  <button class="sideGrip" id="sideGrip" type="button" tabindex="0" role="separator" aria-orientation="vertical"
    aria-label="拖动调整左侧文件管理栏宽度（双击按内容自适应，方向键微调）"
    title="左右拖动调整宽度 · 双击按最长文件名自适应 · 方向键微调"></button>

  <main>
    <section class="wrap" id="viewList">
      <div class="bar" id="listBar"></div>
      <div id="list"></div>
      <div class="tip" id="tip"></div>
    </section>

    ${readonly ? `<section class="wrap" id="viewEdit" hidden>
      <div class="vHead">
        <span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></span>
        <b class="vName" id="vName">—</b>
        <span class="vMeta" id="vMeta"></span>
        <span class="sp"></span>
        <span id="vSeg"></span>
        <button class="wtog" id="vWrap" title="自动换行（快捷键 Alt+Z）" aria-pressed="true">自动换行</button>
        <button class="btn sm" id="vCopy"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>复制全文</button>
        <button class="btn sm" id="vDl">下载</button>
        <button class="btn sm ghost" id="vBack">返回列表</button>
      </div>
      <div id="vNote"></div>
      <pre class="viewer" id="viewer"></pre>
      <div class="rBox" id="vRender" hidden></div>
      <div class="editFoot">
        <span class="roTag">只读查看</span>
        <span id="edtStatus"></span>
        <span class="sp"></span>
        <span id="vCount"></span>
      </div>
    </section>` : `<section class="wrap" id="viewEdit" hidden>
      <div class="editTop">
        <button class="btn primary" id="btnSave" title="把当前文件发布到分享页；编辑会随时自动保存（Ctrl+S 也可立即保存）">发布</button>
        <div class="zoom">
          <button id="zOut" title="缩小字号">A-</button><span id="zVal">13</span><button id="zIn" title="放大字号">A+</button>
        </div>
        <button class="wtog" id="btnWrap" title="自动换行（快捷键 Alt+Z）" aria-pressed="true">自动换行</button>
        <button class="btn sm" id="btnFind" title="查找替换（Ctrl+F / Ctrl+H）">查找替换</button>
        <button class="btn sm" id="edCopy" title="复制当前编辑器的全部内容">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>复制全文</button>
        <span id="edSeg"></span>
        <nav class="crumb edCrumb" id="edCrumb"></nav>
        <div id="editOps" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>
      <div class="fbar" id="findBar" hidden>
        <input type="text" id="fQ" placeholder="查找…" autocomplete="off">
        <span class="fstat" id="fStat">未查找</span>
        <button class="fbtn" id="fPrev" title="上一个（Shift+Enter）">上一个</button>
        <button class="fbtn" id="fNext" title="下一个（Enter）">下一个</button>
        <button class="fbtn" id="fCase" title="区分大小写">Aa</button>
        <button class="fbtn" id="fRe" title="正则表达式">.*</button>
        <span class="sp"></span>
        <input type="text" id="fR" placeholder="替换为…" autocomplete="off">
        <button class="fbtn" id="fRep">替换</button>
        <button class="fbtn" id="fRepAll">全部替换</button>
        <button class="fbtn" id="fClose">关闭</button>
      </div>
      <div class="edRow" id="edRow">
        <div class="edGutter" id="edGutter"><div class="edGutterIn" id="edGutterIn"></div></div>
        <div class="edTA">
          <div id="edHl" hidden><div id="edHlIn"></div><div id="edLinkIcons"></div></div>
          <textarea id="edt" spellcheck="false" wrap="off"></textarea>
          <div id="edMirror"></div>
          <div id="edMeasure"></div>
        </div>
        <div class="outline" id="edOutline" hidden></div>
      </div>
      <div class="rBox edPrev" id="edPrev" hidden></div>
      <div class="editFoot">
        <span id="edtStatus"></span>
        <span class="sp"></span>
        <span id="edtCount">0 字</span>
      </div>
    </section>`}
  </main>
</div>
<div id="sideMask"></div>

${readonly ? '' : `<input type="file" id="fileInput" multiple hidden>
<input type="file" id="dirInput" webkitdirectory multiple hidden>
<div id="drop">松开鼠标即可上传到当前文件夹（支持整个文件夹）</div>

<div id="up">
  <h4><span id="upTitle">上传中…</span><button class="x" id="upClose">&times;</button></h4>
  <div id="upList"></div>
</div>`}

<div class="mask" id="mMask">
  <div class="dlg" id="mDlg">
    <h3 id="mTitle"></h3>
    <div class="body" id="mBody"></div>
    <div class="foot">
      <button class="btn" id="mCancel">取消</button>
      <button class="btn primary" id="mOk">确定</button>
    </div>
  </div>
</div>

<div id="toast"></div>

${readonly ? '' : `<div id="batch">
  <span id="batchInfo">已选 0 项</span>
  <button id="batchAll">全选本页</button>
  <button id="batchClear">取消选择</button>
  <button id="batchDl">批量下载</button>
  <button id="batchMove">批量移动</button>
  <button class="danger" id="batchDel">批量删除</button>
</div>`}

<script nonce="${nonce}">
var BASE = ${JSON.stringify(base)};
var RO = ${readonly ? 'true' : 'false'};
var HAS_PW = ${hasPw ? 'true' : 'false'};
var SESS_DAYS = ${sessDays};
var SHARE_NAME = ${JSON.stringify(shareName)};

var state = { path: '', folders: [], files: [], sel: {}, view: 'list', q: '',
              more: '', total: 0, lastPick: null, sort: { by: 'name', desc: false },
              multi: false, suppressClickUntil: 0, suppressRowKey: '' };
// savedText = 最近一次「已确认与云端一致」的正文（载入时或保存成功后更新）。
// dirty 只是个"用户可能改过"的粗标志：打过字就置 true，撤销也不会撤销回来。
// 所以真正决定"要不要发请求"的，是 edt.value 和 ed.savedText 的**逐字比较**——
// 打了错字又删掉、Ctrl+Z 撤销回原样，这些"改了个寂寞"的操作一个请求都不该发。
// 这层比较纯在浏览器里做，不消耗任何 Cloudflare 资源。
var ed = { path: '', name: '', dirty: false, timer: null, savedText: null };
// 自动换行：默认开启（打开文本主要是为了读），偏好记在本地，和字号一样
var wrapOn = true;
try { if (localStorage.getItem('cfwtxt_wrap') === '0') wrapOn = false; } catch (e) {}

function applyWrap(){
  var t = document.getElementById('edt');
  if (t){
    t.setAttribute('wrap', wrapOn ? 'soft' : 'off');
    // 保留 withGut：换行状态变化不能把"有行号槽"这件事一起抹掉
    var gut = t.classList.contains('withGut');
    t.className = (wrapOn ? 'wrapon' : 'wrapoff') + (gut ? ' withGut' : '');
  }
  var v = document.getElementById('viewer');
  if (v) v.className = 'viewer' + (wrapOn ? ' wrapon' : ' wrapoff');
  var btns = [document.getElementById('btnWrap'), document.getElementById('vWrap')];
  for (var i = 0; i < btns.length; i++){
    var b = btns[i];
    if (!b) continue;
    b.classList[wrapOn ? 'add' : 'remove']('on');
    b.setAttribute('aria-pressed', wrapOn ? 'true' : 'false');
    b.title = (wrapOn ? '自动换行：已开启' : '自动换行：已关闭（长行可横向滚动）') + ' · 快捷键 Alt+Z';
  }
  // 换行方式变了，行号定位与命中高亮的排版都要跟着重算
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}

function toggleWrap(){
  wrapOn = !wrapOn;
  try { localStorage.setItem('cfwtxt_wrap', wrapOn ? '1' : '0'); } catch (e) {}
  applyWrap();
  toast(wrapOn ? '已开启自动换行' : '已关闭自动换行（长行可横向滚动）');
}

var edFont = 13;
try { var savedFont = parseInt(localStorage.getItem('cfwtxt_font'), 10); if (savedFont >= 10 && savedFont <= 28) edFont = savedFont; } catch (e) {}

var E = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };

var ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
var ICON_LINK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
var ICON_OPEN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
var ICON_LOCATE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
var ICON_MORE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
var ICON_FOLDER_S = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#d4a02a"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
// 目录图标按层级配色：根目录琥珀、一级蓝、二级紫、三级绿、四级橙，循环
var DIR_COLORS = ['#d4a02a', '#378ADD', '#7F77DD', '#1D9E75', '#D85A30'];
function depthOf(path){
  if (!path) return 0;
  var n = 0;
  for (var i = 0; i < path.length; i++) if (path.charAt(i) === '/') n++;
  return n;
}
function dirIcon(path, open, prot){
  // 受保护文件夹用完全不同的图标：金色实心文件夹 + 小锁，和普通文件夹（按层级配色的描边文件夹）一眼区分
  if (prot){
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b8860b" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#fdf1cf"/>' +
      '<rect x="8.6" y="11.6" width="6.8" height="5.2" rx="1.2" fill="#fff8e1" stroke="#b8860b"/>' +
      '<path d="M10.3 11.6v-1.3a1.7 1.7 0 0 1 3.4 0v1.3" stroke="#b8860b"/>' +
      '<circle cx="12" cy="14.2" r="0.9" fill="#b8860b" stroke="none"/>' +
      '</svg>';
  }
  // 根目录单独占一个色位，下面每深一层换一个颜色：
  // 根=琥珀，一级=蓝，二级=紫，三级=绿 …（这样根与它的一级子目录也不会撞色）
  var idx = path ? depthOf(path) + 1 : 0;
  var c = DIR_COLORS[idx % DIR_COLORS.length];
  var path2 = open
    ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1"/><path d="M3 9h16.5a1.5 1.5 0 0 1 1.45 1.9l-1.6 6A2 2 0 0 1 17.4 18.5H5a2 2 0 0 1-2-2z"/>'
    : '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + c +
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path2 + '</svg>';
}

// ===== 文件后缀徽标 =====
// 目录树里长文件名会被省略号截断（"节点链接_主要…"），用户就不知道它是什么类型了。
// 所以把后缀单独做成一个小徽标挂在名字旁边、按类别着色 —— 名字可以截断，后缀始终看得见。
var EXT_DOC = kwSet('md markdown mdx txt text rst adoc asciidoc org log srt vtt tex bib cls sty');
var EXT_DATA = kwSet('csv tsv psv xls xlsx ods');
var EXT_CFG = kwSet('json json5 jsonc jsonl ndjson geojson yml yaml toml ini cfg conf config cnf properties env editorconfig rc lock prefs');
var EXT_WEB = kwSet('html htm xhtml css scss sass less styl xml xsl xslt svg rss atom vue svelte astro');
var EXT_MEDIA = kwSet('png jpg jpeg gif webp avif bmp ico pdf mp3 wav ogg m4a flac aac mp4 webm mov m4v mkv');
// 「类型」列用的细分集合（比大类更具体：图片 / 视频 / 音频 / 压缩包）
var EXT_MEDIA_IMG = kwSet('png jpg jpeg gif webp avif bmp ico svg');
var EXT_MEDIA_VID = kwSet('mp4 webm mov m4v mkv avi');
var EXT_MEDIA_AUD = kwSet('mp3 wav ogg m4a flac aac oga opus');
var EXT_ARCHIVE = kwSet('zip rar 7z gz tgz tar bz2 xz zst');
var EXT_CODE = kwSet('js mjs cjs jsx ts tsx mts cts py pyw rb go rs java kt kts scala groovy gradle ' +
  'c h cc cpp cxx hpp hh cs m mm swift dart lua pl pm php sql sh bash zsh fish ksh bat cmd ps1 psm1 psd1 ' +
  'graphql gql proto thrift diff patch pem crt cer key pub asc ipynb');

var EXT_STYLE = {
  doc: 'background:#eaf3fe;color:#0969da',
  data: 'background:#e3f7f0;color:#0f6e56',
  cfg: 'background:#fdf1e0;color:#9a6700',
  web: 'background:#fdeaea;color:#c0392b',
  media: 'background:#eaf7ee;color:#1a7f37',
  code: 'background:#f0ecfe;color:#6f42c1',
  other: 'background:#f0f2f4;color:#6e7781'
};

function extCat(name, ct){
  var e = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (e){
    if (EXT_DOC[e]) return 'doc';
    if (EXT_DATA[e]) return 'data';
    if (EXT_CFG[e]) return 'cfg';
    if (EXT_WEB[e]) return 'web';
    if (EXT_MEDIA[e]) return 'media';
    if (EXT_CODE[e]) return 'code';
    return 'other';
  }
  if (c.indexOf('image/') === 0 || c.indexOf('video/') === 0 || c.indexOf('audio/') === 0) return 'media';
  return 'other';
}

// 输出徽标 HTML；没有扩展名就返回空串（避免到处冒出一堆灰块）
// 直接输出大写文本（而不是靠 CSS text-transform），这样复制出来、读屏软件读到的也是大写
function extBadge(name, ct){
  var e = extOf(name);
  if (!e) return '';
  var label = e.length > 5 ? e.slice(0, 5) : e;
  var style = EXT_STYLE[extCat(name, ct)] || EXT_STYLE.other;
  return '<span class="extb" style="' + style + '" title="' + E(e) + ' 格式">' + E(label.toUpperCase()) + '</span>';
}

var ICON_CARET = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
var ICON_MORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
var ICON_EXPAND = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l5 5 5-5"/><path d="M7 13l5 5 5-5"/></svg>';
var ICON_COLLAPSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13l5-5 5 5"/><path d="M7 20l5-5 5 5"/></svg>';
var ICON_FITW = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>';

// ===== 文本格式识别 =====
var TEXT_EXT = ('txt text md markdown mdx rst adoc asciidoc org log csv tsv psv json json5 jsonc jsonl ndjson geojson ' +
'ipynb js mjs cjs jsx ts tsx mts cts vue svelte astro css scss sass less styl html htm xhtml svg xml xsl xslt rss atom plist ' +
'yml yaml toml ini cfg conf config cnf properties env editorconfig prefs rc lock exp ' +
'sh bash zsh fish ksh bat cmd ps1 psm1 psd1 ' +
'py pyw rb erb gemspec go mod sum rs java kt kts scala groovy gradle ' +
'c h cc cpp cxx hpp hh hxx cs m mm swift dart lua pl pm r jl php phtml ' +
'sql graphql gql proto thrift avsc ' +
'tex bib cls sty srt vtt ass ssa sub m3u m3u8 pls cue oxt ' +
'diff patch pem crt cer key pub asc ' +
'gitignore gitattributes gitmodules dockerfile makefile cmake mk tf tfvars hcl nomad bicep nix dhall ' +
'desktop service socket rules sln csproj vcxproj pom launch manifest webmanifest').split(' ');

var TEXT_APP = ['application/json','application/xml','application/javascript','application/x-javascript',
'application/ecmascript','application/x-sh','application/x-yaml','application/yaml','application/toml',
'application/sql','application/graphql','application/x-httpd-php','application/x-python','application/x-ruby',
'application/x-perl','application/x-latex','application/ld+json','application/manifest+json',
'application/x-ndjson','application/csv'];   // x-yaml 已在上一行组里出现，不再重复

var BIN_PREFIX = ['image/','video/','audio/','font/','binary/'];
var BIN_APP = ['application/pdf','application/zip','application/gzip','application/x-gzip','application/x-tar',
'application/x-rar','application/x-7z-compressed','application/msword','application/vnd.ms-excel',
'application/vnd.ms-powerpoint','application/x-msdownload','application/x-msdos-program',
'application/x-apple-diskimage','application/x-bzip2','application/x-xz','application/wasm'];

function isBinaryMime(c){
  if (!c) return false;
  for (var i = 0; i < BIN_PREFIX.length; i++) { if (c.indexOf(BIN_PREFIX[i]) === 0) return true; }
  if (c.indexOf('application/vnd.openxmlformats') === 0) return true;
  return BIN_APP.indexOf(c) >= 0;
}

function isText(name, ct){
  var c = String(ct || '').toLowerCase().split(';')[0].trim();
  if (c === 'application/octet-stream') c = '';
  if (c && TEXT_APP.indexOf(c) >= 0) return true;
  if (c && c.indexOf('text/') === 0) return true;
  if (c && isBinaryMime(c)) return false;
  var s = String(name || '');
  var i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return !isBinaryMime(c);
  return TEXT_EXT.indexOf(s.slice(i + 1).toLowerCase()) >= 0;
}

function fmtSize(n){
  if (n == null || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtTime(s){
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  var p = function(x){ return (x < 10 ? '0' : '') + x; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

var toastTimer = null;
function toast(msg){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('on'); }, 2300);
}

async function req(url, init){
  var r = await fetch(url, init);
  if (r.status === 401){ location.reload(); throw new Error('登录已过期'); }
  return r;
}

async function api(action, params){
  var q = new URLSearchParams();
  q.set('action', action);
  if (params){
    for (var k in params){
      if (k === 'action') continue;
      if (params[k] == null) continue;
      q.set(k, params[k]);
    }
  }
  var r = await req(BASE + '/api?' + q.toString());
  if (!r.ok) { var t = await r.text(); throw new Error(t || ('HTTP ' + r.status)); }
  return r.json();
}

function post(obj){
  return req(BASE + '/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  }).then(function(r){ return r.json(); });
}

function joinPath(dir, name){ return dir ? dir + '/' + name : name; }
function metaFor(name){
  for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === name) return state.files[i]; }
  return {};
}

// ===== 视图切换 =====
function switchView(v){
  state.view = v;
  document.getElementById('viewList').hidden = (v !== 'list');
  document.getElementById('viewEdit').hidden = (v !== 'edit');
  if (v === 'edit') {
    document.body.classList.remove('side-open');
    // 这里**故意不自动 focus**：
    // 手机上 focus 一个 textarea 会立刻弹出软键盘，半个屏幕被盖住 ——
    // 用户只是想"看一眼这个文件"，结果页面被键盘顶掉，非常烦；
    // 桌面同理，打开文件通常先读，光标闪在正文里反而容易误输入。
    // 真要编辑，点一下正文就能开始输入。
  }
  if (typeof refreshTreeSel === 'function') refreshTreeSel();
  // 切到编辑器就退出多选模式：留着选中状态，返回列表时会突然冒出一堆勾选，很突兀
  if (v !== 'list' && state.multi) exitMulti();
  // 切回列表要重绘一次：比如在编辑器里生成了分享（乐观更新只改了缓存），
  // 回到列表时如果沿用旧 DOM，「已分享」徽标就看不见，像没生效一样
  if (v === 'list' && typeof renderList === 'function') renderList();
  // 批量条只在列表视图出现。切到编辑器时不清一下，它会一直飘在底部挡住分享设置。
  if (typeof syncSelection === 'function') syncSelection();
}

// ===== 左侧目录树 =====
// 数据：一次 treeFull 拿到整棵结构（含每层子项数量），之后展开/折叠零请求
// 渲染：折叠时 DOM 里只留一行，展开时才把子节点建出来
// 动画：.tkids 用 grid-template-rows 0fr→1fr 过渡，不需要测量高度，也不整块重绘
var treeData = null;      // 完整树数据
var treeIdx = {};         // path -> 节点
var treeRefs = {};        // path -> { row, wrap, caret }
var treeOpen = { '': true };
var treeTotal = 0;
var treeLoading = null;
// 受保护文件夹的完整路径集合（来自 treeFull 一次扫描）：删除前判断、列表与目录树打标记都用它。
// 放在树数据里而不是每个目录的 list 响应里 —— 这样不管当前在哪个子目录，祖先是否为受保护都判断得出来。
var treeProtected = {};
var TREE_NODE_CAP = 1200; // "展开全部"时的安全上限

function indexTree(node){
  treeIdx[node.p] = node;                      // 文件夹
  treeTotal++;
  for (var i = 0; i < node.f.length; i++){
    var f = node.f[i];
    // 服务端为了省体积只发文件名，这里补出完整路径
    if (f.p == null) f.p = node.p ? node.p + '/' + f.n : f.n;
    treeIdx[f.p] = f;                          // 文件也进索引，路径 -> 节点 保持统一
    treeTotal++;
  }
  for (var j = 0; j < node.d.length; j++) indexTree(node.d[j]);
}

function loadTree(force){
  if (treeData && !force) return Promise.resolve(treeData);
  if (treeLoading) return treeLoading;
  var box = document.getElementById('sideScroll');
  if (!treeData && box) box.innerHTML = '<div class="side-label"><span>目录</span></div><div class="side-hint">加载中…</div>';
  treeLoading = api('treeFull', {}).then(function(d){
    treeData = d.tree || { n: '根目录', p: '', d: [], f: [], c: 0, z: 0, x: 0 };
    treeData.t = !!d.truncated;
    // 受保护文件夹集合（整棵树一次到位）
    treeProtected = {};
    var tp = d.protected || [];
    for (var pi = 0; pi < tp.length; pi++) treeProtected[tp[pi]] = true;
    treeIdx = {}; treeTotal = 0;
    indexTree(treeData);
    treeLoading = null;
    return treeData;
  }).catch(function(){
    treeLoading = null;
    if (box) box.innerHTML = '<div class="side-label"><span>目录</span></div><div class="side-hint">目录加载失败，请刷新页面</div>';
    return null;
  });
  return treeLoading;
}

function invalidateTree(){
  // 文件系统变了（上传 / 删除 / 重命名 / 移动），搜索结果缓存必须一起作废，
  // 否则刚删掉的文件还会在搜索结果里"活着"最多 30 秒。
  clearSearchCache();
  loadTree(true).then(function(d){ if (d) renderSide(); });
}

// 把某个路径及其所有上级标记为展开
function markOpen(path){
  treeOpen[''] = true;
  var parts = path ? path.split('/') : [];
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    treeOpen[acc] = true;
  }
}

// ---- 生成节点 HTML ----
function rowHtml(node, isDir, hasKids, open){
  var p = node.p;
  var isCur = isDir ? (p === state.path) : (state.view === 'edit' && p === ed.path);
  var h = '<div class="trow' + (isDir ? ' d' : ' f') + (isCur ? ' cur' : '') + '" data-p="' + E(p) + '"' +
    (isDir ? ' data-goto="' + E(p) + '"' : ' data-openpath="' + E(p) + '"') + '>';
  if (isDir){
    h += hasKids
      ? '<span class="tcar' + (open ? ' open' : '') + '" data-tog="' + E(p) + '">' + ICON_CARET + '</span>'
      : '<span class="tcar none"></span>';
    h += '<span class="tico">' + dirIcon(p, open, !RO && !!(node.pr || treeProtected[p])) + '</span>';
  } else {
    h += '<span class="tcar none"></span>';
    h += '<span class="tico f">' + ICON_FILE + '</span>';
  }
  h += '<span class="tname" title="' + E(node.p || node.n) + '">' + E(node.n) + '</span>';
  if (isDir && !RO && (node.pr || (p && treeProtected[p]))) h += '<span class="tprot" title="受保护文件夹：删除需要管理员密码，取消保护也要密码">🔒</span>';
  if (!isDir) h += extBadge(node.n);
  h += shDot(node.p);
  if (isDir){
    if (node.c > 0) h += '<span class="tcnt">' + node.c + '</span>';
    else h += '<span class="tcnt dim" title="空文件夹">0</span>';
  } else {
    h += '<span class="tcnt dim">' + fmtSize(node.s) + '</span>';
  }
  // 行尾的操作入口：悬停（触屏常显）出现，也可直接右键。访客没有写操作，就不给这个入口
  if (p && !RO) h += '<button class="tact" data-tact="1" data-p="' + E(p) + '" data-dir="' + (isDir ? 1 : 0) +
    '" title="更多操作（右键也可以）" tabindex="-1">' + ICON_MORE + '</button>';
  return h + '</div>';
}

// 受保护的子目录（管理页才有标记；分享页 treeProtected 为空，全部走普通）
function isProtDir(c){
  return !RO && !!(c.pr || (c.p && treeProtected[c.p]));
}
function dirNodeHtml(c){
  var hasKids = c.c > 0;
  var open = !!treeOpen[c.p];
  return '<div class="tnode" data-n="' + E(c.p) + '">' + rowHtml(c, true, hasKids, open) +
    '<div class="tkids' + (open ? ' open' : '') + '"><div class="tkids-in">' +
    (open ? kidsHtml(c) : '') + '</div></div></div>';
}
function kidsHtml(node){
  var h = '';
  // 同一层的子目录按"受保护 / 普通"分成两个带边框的独立板块；文件不受影响，照旧排在后面
  var prot = [], norm = [], i, k;
  for (i = 0; i < node.d.length; i++){
    if (isProtDir(node.d[i])) prot.push(node.d[i]); else norm.push(node.d[i]);
  }
  if (prot.length){
    h += '<div class="tsec tsec-prot"><div class="tsec-t">🔒 受保护<span class="tsec-c">' + prot.length + '</span></div>';
    for (k = 0; k < prot.length; k++) h += dirNodeHtml(prot[k]);
    h += '</div>';
  }
  if (norm.length){
    if (prot.length){
      // 只有当受保护板块存在时，普通文件夹才需要自己的板块；否则保持原样，避免满屏框线
      h += '<div class="tsec tsec-norm"><div class="tsec-t">📁 普通文件夹<span class="tsec-c">' + norm.length + '</span></div>';
      for (k = 0; k < norm.length; k++) h += dirNodeHtml(norm[k]);
      h += '</div>';
    } else {
      for (k = 0; k < norm.length; k++) h += dirNodeHtml(norm[k]);
    }
  }
  for (var j = 0; j < node.f.length; j++){
    h += '<div class="tnode" data-n="' + E(node.f[j].n) + '">' + rowHtml(node.f[j], false, false, false) + '</div>';
  }
  if (node.x > 0){
    h += '<div class="side-hint">还有 ' + node.x + ' 个文件未列出，请在右侧查看</div>';
  }
  return h;
}

function renderSide(){
  var box = document.getElementById('sideScroll');
  if (!box) return;
  if (!treeData){ loadTree().then(function(){ renderSide(); }); return; }

  var st = box.scrollTop;
  treeRefs = {};

  var h = '<div class="side-label"><span>目录</span><span class="sw">' +
    '<button class="mini" data-fitw="1" title="按最长的文件名自适应侧栏宽度（双击分隔条也行）">' + ICON_FITW + '</button>' +
    '<button class="mini" data-treeall="1" title="展开全部">' + ICON_EXPAND + '</button>' +
    '<button class="mini" data-treeall="0" title="收起全部">' + ICON_COLLAPSE + '</button>' +
    '</span></div>';

  var rootOpen = !!treeOpen[''];
  var rootHasKids = treeData.c > 0;
  h += '<div class="tnode" data-n="__root__">' + rowHtml(treeData, true, rootHasKids, rootOpen) +
    '<div class="tkids' + (rootOpen ? ' open' : '') + '"><div class="tkids-in">' +
    (rootOpen ? kidsHtml(treeData) : '') + '</div></div></div>';

  if (treeData.t) h += '<div class="side-hint">目录过大，仅显示了前 ' + treeTotal + ' 项</div>';

  box.innerHTML = backBarHtml() + '<div id="tree">' + h + '</div>';
  syncScopeRow();                     // 「只在当前目录内搜索」开关只在子目录里才有意义

  registerRefs(box);
  box.scrollTop = st;
}

// 登记 path -> 元素 的引用（避免用属性选择器拼名字，中文/引号都不用转义）
function registerRefs(scope){
  var rows = scope.querySelectorAll('.trow[data-p]');
  for (var i = 0; i < rows.length; i++){
    var row = rows[i];
    var path = row.getAttribute('data-p');
    var wrap = row.nextElementSibling;
    if (wrap && wrap.className.indexOf('tkids') < 0) wrap = null;
    treeRefs[path] = { row: row, wrap: wrap, caret: row.querySelector('.tcar') };
  }
}

// 展开/折叠（只改 class，不重建 DOM —— 这是"丝滑"的关键）
function toggleNode(path, force){
  var ref = treeRefs[path];
  if (!ref || !ref.wrap) return;
  var open = (force == null) ? !ref.wrap.classList.contains('open') : !!force;
  if (open && !ref.wrap.getAttribute('data-built')){
    var node = treeIdx[path];
    var inner = ref.wrap.firstElementChild;
    inner.innerHTML = node ? kidsHtml(node) : '';
    ref.wrap.setAttribute('data-built', '1');
    registerRefs(inner);          // 新长出来的行也要登记，否则下一级三角点了没反应
  }
  if (open) treeOpen[path] = true; else delete treeOpen[path];
  if (ref.caret) ref.caret.classList.toggle('open', open);
  ref.wrap.classList.toggle('open', open);
  // 展开的节点若里面已有展开的子节点，折叠时其"已展开"状态要保留（下次再点开还是原样）
}

function treeAll(open){
  if (!treeData) return;
  if (open){
    if (treeTotal > TREE_NODE_CAP){ toast('目录项太多（' + treeTotal + '），请逐级展开'); return; }
    for (var k in treeIdx) if (treeIdx[k].c > 0) treeOpen[k] = true;
  } else {
    treeOpen = { '': true };
  }
  renderSide();
}

// ===== 目录树操作菜单（右键 / ⋯ 按钮）=====
var ctxEl = null;

function closeCtx(){
  if (!ctxEl) return;
  if (ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
  ctxEl = null;
}

// withReveal=true 时多一项「在目录中显示」—— 搜索结果行专用：
// 搜到文件后想看看它周围还有什么，比"打开它"更常用的下一步。
// deepQ 非空时再补一项「深搜此文件」（读全文精确匹配，正文命中被 8K 索引截断时用）。
var ctxDeepQ = '';                    // 当前右键菜单对应的搜索词（深搜要用）
function openCtx(x, y, path, isDir, withReveal, deepQ){
  closeCtx();
  if (!path) return null;                       // 根目录不给操作
  ctxDeepQ = deepQ || '';
  var items = [{ c: 'open', t: '打开' }];
  if (withReveal) items.push({ c: 'reveal', t: '在目录中显示' });
  if (ctxDeepQ && !isDir && !RO) items.push({ c: 'deep', t: '深搜此文件（读全文精确匹配）' });
  var pk = isDir ? '' : kindOf(path.split('/').pop(), '');
  if (!isDir && (pk === 'image' || pk === 'av' || pk === 'pdf')) items.push({ c: 'preview', t: '预览' });
  if (!isDir) items.push({ c: 'download', t: '下载' });
  // 打包下载：文件夹本来就不能单文件下载，给它一个 zip 出口；
  // 文件也提供这一项，方便"连目录结构一起带走"。
  items.push({ c: 'pack', t: isDir ? '打包下载本目录（zip）' : '下载为 zip' });
  if (!RO){
    items.push({ c: 'sep' });
    items.push({ c: 'rename', t: '重命名' });
    items.push({ c: 'move', t: '移动到…' });
    items.push({ c: 'share', t: isDir ? '分享本目录…' : '分享…' });
    if (isDir){
      // 受保护的文件夹删除需要管理员密码；这里给它一个开关，方便随时给已有文件夹上锁/解锁
      var protHere = !!treeProtected[path];
      items.push({ c: protHere ? 'unprotect' : 'protect', t: protHere ? '取消受保护 🔒（需密码）' : '设为受保护文件夹 🔒' });
    }
    // 发布只对"分享页能看到的路径"有意义：路径本身被分享，或在某个被分享的目录里。
    // 否则点下去只是往影子树里拷一份没人会读的内容，纯属浪费请求。
    // 另外，内容与影子树里那份完全一致时（pubSynced）发布同样没有意义 —— 置灰。
    // 这条只在"知道结论"时生效；不知道（刚打开页面还没问过服务端）就保持可点，宁多勿拦。
    if (isSharedPath(path)){
      var pubDis = pubSynced[path] === true;
      items.push({ c: 'sep' });
      items.push({ c: 'publish', dis: pubDis,
        t: (isDir ? '发布本目录' : '发布') + '到分享页' + (pubDis ? '（无改动）' : (pubSynced[path] === false ? '（有未发布的改动）' : '')) });
      items.push({ c: 'unpublish', t: '撤回发布（分享页先隐藏）' });
    }
    items.push({ c: 'sep' });
    items.push({ c: 'del', t: '删除', danger: true });
  }
  var h = '<div class="ctop">' + E(path.split('/').pop()) + '</div>';
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    if (it.c === 'sep'){ h += '<div class="csep"></div>'; continue; }
    h += '<button class="ci' + (it.danger ? ' danger' : '') + '"' + (it.dis ? ' disabled title="内容与分享页当前一致，没有需要发布的变化"' : '') +
      ' data-cmd="' + it.c +
      '" data-cp="' + E(path) + '" data-cdir="' + (isDir ? 1 : 0) + '">' + it.t + '</button>';
  }
  var box = document.createElement('div');
  box.id = 'ctx';
  box.innerHTML = h;
  box.classList.add('on');            // 必须先显示，否则测到的宽高是 0，夹边会失效
  document.body.appendChild(box);
  var r = box.getBoundingClientRect();
  var left = (x + r.width > innerWidth - 8) ? x - r.width : x;
  var top = (y + r.height > innerHeight - 8) ? y - r.height : y;
  box.style.left = Math.max(8, Math.min(left, innerWidth - r.width - 8)) + 'px';
  box.style.top = Math.max(8, Math.min(top, innerHeight - r.height - 8)) + 'px';
  ctxEl = box;
  return box;
}

function openCtxAt(btn, withReveal){
  var r = btn.getBoundingClientRect();
  // 搜索结果行的 ⋯ 按钮：从所在行取搜索词，菜单里才带得出「深搜此文件」
  var dq = '';
  if (withReveal){
    var row = (btn.closest ? btn.closest('.sfile[data-openpath]') : null);
    if (row && row.getAttribute('data-snip') === '1') dq = row.getAttribute('data-sq') || '';
  }
  // 贴着按钮右侧展开；超出视口时 openCtx 会自动夹回来
  var box = openCtx(r.right + 4, r.bottom + 4, btn.getAttribute('data-p'),
    btn.getAttribute('data-dir') === '1', withReveal, dq);
  if (box) box.__owner = btn;
}

function runCtx(cmd, path, isDir){
  if (cmd === 'open'){
    if (isDir){ document.body.classList.remove('side-open'); load(path); }
    else openPath(path);
    return;
  }
  if (cmd === 'reveal'){ revealInTree(path, isDir); return; }
  if (cmd === 'deep'){ deepSearch(path, ctxDeepQ, false); return; }
  if (cmd === 'download'){ location.href = dlUrl('', path); return; }
  if (cmd === 'pack'){ packOne(path, isDir); return; }
  if (cmd === 'preview'){ openMediaModal(path, path.split('/').pop()); return; }
  if (cmd === 'rename'){ openRename(path, isDir); return; }
  if (cmd === 'move'){ openMove(path, isDir); return; }
  if (cmd === 'share'){ openShareModal(path, isDir); return; }
  if (cmd === 'publish'){ doPublish(path, isDir); return; }
  if (cmd === 'unpublish'){ doUnpublish(path, isDir); return; }
  if (cmd === 'protect'){ doSetProtected(path, isDir, true); return; }
  if (cmd === 'unprotect'){ doSetProtected(path, isDir, false); return; }
  if (cmd === 'del'){ doDelete(path, isDir); return; }
}

// 给文件夹上锁 / 解锁。标记存在文件夹占位对象的 customMetadata 上，改完整棵树的标记一起刷新。
// 上锁不需要密码；**解锁必须验证管理员密码**（服务端强制），避免手滑点一下就解除保护。
// 这里不预先弹窗 —— 一律先发请求，由服务端回 needPw 决定要不要验密码（服务端才是唯一权威）。
function doSetProtected(path, isDir, on){
  if (!isDir){ toast('只有文件夹可以设为受保护'); return; }
  return sendSetProtected(path, on, '', 0);
}

// 实际发送 setProtected。服务端回 needPw 就地弹密码框并重试；密码错可以重输（最多 3 次）。
function sendSetProtected(path, on, pw, tries){
  var payload = { action: 'setProtected', path: path, protected: on };
  if (pw) payload.password = pw;
  return post(payload).then(function(d){
    if (!d.ok){
      if (d.needPw && !d.noPwSet && tries < 3){
        var why = '取消「' + path + '」的受保护状态需要验证管理员密码。' +
          (tries ? '（上次密码不正确，请重新输入）' : '');
        return askAdminPassword(why, '确认取消保护').then(function(p2){
          return sendSetProtected(path, on, p2, tries + 1);
        });
      }
      throw new Error(d.error);
    }
    toast(on ? '已设为受保护文件夹 🔒' : '已取消受保护');
    invalidateTree();                       // 重新拉整棵树 → treeProtected 更新
    return load(state.path);
  }).catch(function(e){ toast('操作失败：' + e.message); return false; });
}

// 发布 / 撤回发布（列表右键、行菜单、分享面板共用）。
// 发布是"把草稿当前版本复制到影子树"，分享页立刻可见；撤回只删影子树副本，草稿不动。
function doPublish(path, isDir){
  // 内容与分享页当前那份完全一致 → 发布没有任何意义，直接给反馈、不发请求。
  // （右键菜单与分享面板共用这条；面板里的按钮本身也会置灰。）
  if (pubSynced[path] === true){
    toast('内容没有变化，无需发布');
    return Promise.resolve();
  }
  toast('正在发布…');
  return post({ action: 'publish', path: path, isDir: !!isDir })
    .then(function(d){
      if (!d.ok) throw new Error(d.error || '发布失败');
      // 目录是整棵子树一起刷新的，里面每个文件"有没有改动"的旧结论一律作废，
      // 让它们按需重新问一次；单文件则直接记成"已同步"。
      if (isDir) forgetPubSynced(); else pubSynced[path] = true;
      if (d.unchanged) toast('内容没有变化，无需发布');
      else toast('已发布 ' + d.published + ' 个对象');
      if (ed.path && (ed.path === path || ed.path.indexOf(path + '/') === 0)) setStatus('已发布 ' + hhmm());
      updPubBtn();
      reloadShares();
    })
    .catch(function(e){ toast('发布失败：' + e.message); });
}
// 一键补发：老版本没有影子树，历史分享记录对应的内容只在草稿树里，分享页会打不开。
// 这个动作把"还没发布过"的那些分享补一遍，已发布的跳过（不会重复拷、也不会覆盖更新的版本）。
function doPublishAll(){
  showModal({
    title: '全部发布', small: true, okText: '开始发布',
    body: '<div class="msg">把还没有发布过的分享内容复制到分享页。<b>已发布的不会重复发布</b>，' +
      '所以正在编辑、还没点发布的版本不会被这里覆盖。</div>',
    onOk: function(){
      return post({ action: 'publishAll' })
        .then(function(d){
          if (!d.ok) throw new Error(d.error || '发布失败');
          var msg = '新发布 ' + d.published + ' 条';
          if (d.skipped) msg += '，跳过已发布/无需发布 ' + d.skipped + ' 条';
          if (d.failed && d.failed.length) msg += '，失败 ' + d.failed.length + ' 条（内容可能已删除）';
          toast(msg);
          if (d.failed && d.failed.length) console.warn('publishAll 失败路径', d.failed);
          reloadShares();
        })
        .catch(function(e){ toast('发布失败：' + e.message); return false; });
    }
  });
}

function doUnpublish(path, isDir){
  showModal({
    title: '撤回发布', small: true, okText: '撤回',
    body: '<div class="msg">撤回后 <b>' + E(path) + '</b> 会先从分享页隐藏，<b>草稿内容不受影响</b>；' +
      '随时可以再发布回来。</div>',
    onOk: function(){
      return post({ action: 'unpublish', path: path, isDir: !!isDir })
        .then(function(d){
          if (!d.ok) throw new Error(d.error || '撤回失败');
          // 撤回后影子树里没有这份内容了 → 不再"一致"，「发布」按钮要重新可点
          if (isDir) forgetPubSynced(); else pubSynced[path] = false;
          toast('已撤回 ' + d.removed + ' 个对象');
          updPubBtn();
          reloadShares();
        })
        .catch(function(e){ toast('撤回失败：' + e.message); return false; });
    }
  });
}

// 「在目录中显示」：展开左侧目录树到目标所在层级，把目标行滚进视野。
// 搜索结果是个"扁平列表"，看完之后用户常想知道"这文件在哪个目录、旁边还有什么"。
function revealInTree(path, isDir){
  closeCtx();
  rememberSearch();                     // 离开搜索结果前留快照，侧栏顶部给「返回搜索结果」
  var dir = isDir ? path : path.split('/').slice(0, -1).join('/');
  markOpen(dir);                        // 逐级展开祖先目录
  var q = document.getElementById('q');
  if (q) q.value = '';
  state.q = '';
  searchState = null;
  abortSearch();
  var done = function(){
    var ref = treeRefs[path];
    if (ref && ref.row && ref.row.scrollIntoView) ref.row.scrollIntoView({ block: 'center' });
    toast('已定位到「' + (path || '根目录') + '」');
  };
  if (!treeData){ loadTree().then(function(){ renderSide(); done(); }); return; }
  renderSide();
  done();
}

document.addEventListener('contextmenu', function(ev){
  var t = ev.target;
  if (RO) return;                       // 访客只用左侧浏览，不需要操作菜单
  var row = (t && t.closest) ? t.closest('#tree .trow[data-p]') : null;
  if (row){
    var p = row.getAttribute('data-p');
    if (!p) return;
    ev.preventDefault();
    openCtx(ev.clientX, ev.clientY, p, row.hasAttribute('data-goto'));
    return;
  }
  // 搜索结果行：右键直接出同一套操作菜单，并且多一项「在目录中显示」
  var srow = (t && t.closest) ? t.closest('#sideScroll .sfile[data-openpath]') : null;
  if (!srow) return;
  var sp = srow.getAttribute('data-openpath');
  if (!sp) return;
  ev.preventDefault();
  var sdq = (srow.getAttribute('data-snip') === '1') ? (srow.getAttribute('data-sq') || '') : '';
  openCtx(ev.clientX, ev.clientY, sp, srow.getAttribute('data-isdir') === '1', true, sdq);
});
document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') closeCtx(); });
window.addEventListener('resize', closeCtx);
(function(){
  var sc = document.getElementById('sideScroll');
  if (sc) sc.addEventListener('scroll', closeCtx);
})();

// 只切换高亮，不重建 DOM（打开文件时用，避免整棵树重绘）
function refreshTreeSel(){
  for (var p in treeRefs){
    var r = treeRefs[p];
    if (!r.row) continue;
    var isDir = r.row.hasAttribute('data-goto');
    var cur = isDir ? (p === state.path) : (state.view === 'edit' && p === ed.path);
    if (r.row.classList.contains('cur') !== cur) r.row.classList.toggle('cur', cur);
  }
}

// ===== 搜索结果 =====
var searchTimer = null;
var SEARCH_PAGE = 60;              // 一页 60 条：够看，又不会一次渲染几百行把侧栏拖卡
var SEARCH_CACHE_TTL = 30000;      // 结果缓存 30 秒：来回改词 / 退回上一个词不再打服务器
var SEARCH_CACHE_MAX = 24;         // 缓存上限（LRU），防止无限增长
var searchCache = {};              // key = 查询 + 目录 + 类型 + 偏移 → { at, data }
var searchCacheKeys = [];
var searchAbort = null;            // 正在飞的搜索请求（新搜索 / 清空输入时取消掉）
var searchSeq = 0;                 // 请求序号：只有最后一次的结果允许上屏
var searchState = null;            // { q, pq, dir, ftype, terms, results, total, hasMore, meta }
var lastSearch = null;             // 上一次搜索的快照：清空搜索框后还能一键"返回搜索结果"
var srSel = -1;                    // 结果列表里键盘选中的行号（↑↓ 移动，-1 = 未选）
var srFilter = '';                 // 结果类型筛选：'' | name | path | text | dir
var searchScopeCur = false;        // 「只在当前目录内搜索」开关

// ---- 搜索历史（只存浏览器本地，不上传）----
var SEARCH_HIST_KEY = 'cfw_srch_hist';
var SEARCH_HIST_MAX = 12;
var searchHist = [];
var qhSel = -1;                    // 历史下拉里键盘选中的项
var histTimer = null;
function histLoad(){
  searchHist = [];
  try {
    var a = JSON.parse(localStorage.getItem(SEARCH_HIST_KEY) || '[]');
    if (Object.prototype.toString.call(a) === '[object Array]'){
      for (var i = 0; i < a.length && searchHist.length < SEARCH_HIST_MAX; i++){
        if (typeof a[i] === 'string' && a[i]) searchHist.push(a[i]);
      }
    }
  } catch (e) {}
}
function histSave(){
  try { localStorage.setItem(SEARCH_HIST_KEY, JSON.stringify(searchHist)); } catch (e) {}
}
function histPush(q){
  q = String(q || '').trim();
  if (!q) return;
  var i = searchHist.indexOf(q);
  if (i >= 0) searchHist.splice(i, 1);
  searchHist.unshift(q);
  if (searchHist.length > SEARCH_HIST_MAX) searchHist.length = SEARCH_HIST_MAX;
  histSave();
}
function histRender(){
  var box = document.getElementById('qHist');
  if (!box) return;
  if (!searchHist.length){
    box.innerHTML = '<div class="qempty">还没有搜索记录，搜过的词会自动留在这里</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < searchHist.length; i++){
    h += '<div class="qh' + (i === qhSel ? ' on' : '') + '" data-hq="' + E(searchHist[i]) + '">' +
      '<span class="qt">' + E(searchHist[i]) + '</span></div>';
  }
  h += '<div class="qsep"></div><button class="qclr" data-hclr="1">清除搜索记录</button>';
  box.innerHTML = h;
}
function histOpen(){
  var box = document.getElementById('qHist');
  if (!box) return;
  qhSel = -1;
  histRender();
  box.classList.add('on');
}
function histClose(){
  var box = document.getElementById('qHist');
  if (box) box.classList.remove('on');
  qhSel = -1;
}
// 输入停下来 1.4 秒才把词记进历史 —— 否则 f / fn / fni / fnia 这些半成品会全被记下来
function histSchedule(q){
  clearTimeout(histTimer);
  histTimer = setTimeout(function(){ if (state.q === q) histPush(q); }, 1400);
}

function clearSearchCache(){
  searchCache = {};
  searchCacheKeys = [];
}
function searchCacheGet(key){
  var c = searchCache[key];
  if (!c) return null;
  if (Date.now() - c.at > SEARCH_CACHE_TTL){ delete searchCache[key]; return null; }
  return c.data;
}
function searchCacheSet(key, data){
  if (!searchCache[key]) searchCacheKeys.push(key);
  searchCache[key] = { at: Date.now(), data: data };
  while (searchCacheKeys.length > SEARCH_CACHE_MAX){
    delete searchCache[searchCacheKeys.shift()];
  }
}
function abortSearch(){
  if (searchAbort){ try { searchAbort.abort(); } catch (e) {} searchAbort = null; }
}

// 搜索视图栈：清空搜索框 / 点「在目录中显示」会离开搜索结果，
// 这里留一份快照，侧栏顶部给一条「返回搜索结果」，不用把词重新敲一遍。
function rememberSearch(){
  if (searchState && searchState.results && searchState.results.length){
    lastSearch = { q: searchState.q, filter: srFilter, total: searchState.total };
  }
}
function restoreSearch(){
  if (!lastSearch) return;
  var q = document.getElementById('q');
  if (q) q.value = lastSearch.q;
  srFilter = lastSearch.filter || '';
  runSearch(lastSearch.q);
}
function dismissRestore(){
  lastSearch = null;
  renderSide();
}
function backBarHtml(){
  if (!lastSearch) return '';
  return '<div class="sr-back"><button class="bk" data-srback="1" title="回到上一次的搜索结果">' +
    '返回搜索结果：' + E(lastSearch.q) + '</button>' +
    '<button class="x" data-srbackx="1" title="不再显示">×</button></div>';
}

// 结果类型筛选芯片：切换只重跑搜索（服务端 ftype 过滤），不重新渲染整棵树。
function setSrFilter(f){
  f = (f === 'name' || f === 'path' || f === 'text' || f === 'dir') ? f : '';
  if (f === srFilter) return;
  srFilter = f;
  srSel = -1;
  if (state.q) runSearch(state.q);
}

// 「只在当前目录内搜索」：勾选后给搜索补一个 dir 参数（服务端本来就支持 dir 过滤）。
// 框里手打的 path:xxx 优先 —— 用户明确写的意图不该被一个复选框悄悄改掉。
function effDir(pq){
  if (pq.dir) return pq.dir;
  if (searchScopeCur && state.path) return state.path;
  return '';
}
function syncScopeRow(){
  var row = document.getElementById('sideScope');
  if (!row) return;
  var on = !!state.path;                       // 根目录 = 全库，这个开关没有意义
  row.hidden = !on;
  var cb = document.getElementById('qScope');
  if (cb) cb.checked = searchScopeCur;
  var nm = document.getElementById('qScopeName');
  if (nm) nm.textContent = on ? '（' + state.path.split('/').pop() + '）' : '';
}
function onScopeToggle(){
  var cb = document.getElementById('qScope');
  searchScopeCur = !!(cb && cb.checked);
  var q = document.getElementById('q');
  if (q && q.value.trim()) runSearch(q.value.trim());
}

function onSearchInput(){
  clearTimeout(searchTimer);
  clearTimeout(histTimer);
  histClose();
  var v = document.getElementById('q').value.trim();
  if (v !== state.q) srFilter = '';            // 换了词就从「全部」重新看，别让上一轮的筛选把人挡在门外
  if (v) histSchedule(v);                      // 停手 1.4 秒才记进历史，半成品词不落库
  searchTimer = setTimeout(function(){ runSearch(v); }, 260);
}

// 解析搜索框里的轻量语法：
//   ext:md      → 只搜 Markdown（后缀过滤，可带点）
//   path:笔记    → 只搜「笔记」目录下的内容
//   "cat"       → 双引号包裹 = 整词匹配（cat 不再命中 category）
// 剩余部分按空白拆成**多个关键词，全部命中才算匹配（AND）** ——
// 搜「fniao 去重」返回同时含这两个词的文件，而不是去找「fniao 去重」这个整串。
// 语法可混用：ext:log path:日志 timeout 失败
function parseSearchQuery(raw){
  var ext = '', dir = '', word = false, q = raw || '';
  q = q.replace(/(^|\\s)ext:(\\S+)/i, function(m, sp, v){ ext = v.replace(/^\\./, ''); return sp; });
  q = q.replace(/(^|\\s)path:(\\S+)/i, function(m, sp, v){ dir = v; return sp; });
  q = q.replace(/^\\s+|\\s+$/g, '');
  if (q.length >= 2 && q.charAt(0) === '"' && q.charAt(q.length - 1) === '"'){
    word = true; q = q.slice(1, -1);
  }
  var terms = q.split(/\\s+/).filter(function(x){ return !!x; });
  if (terms.length > 8) terms = terms.slice(0, 8);   // 与服务端同一个上限
  return { q: q, terms: terms, ext: ext, dir: dir, word: word };
}

// 片段里的关键词高亮。用 indexOf 扫描而不是正则替换 —— 关键词可能含正则元字符。
// terms 可以是字符串（单关键词）或数组（多关键词 AND 查询）。
// 多关键词的命中区间会互相重叠（比如 "abc" 与 "bc"），所以先收集区间 → 排序 →
// 合并重叠部分再输出；否则会嵌套出 <span class="hl"><span class="hl"> 这种脏 DOM。
function hlText(s, terms){
  if (!s) return E(s || '');
  if (typeof terms === 'string') terms = terms ? [terms] : [];
  if (!terms || !terms.length) return E(s);
  var multi = terms.length > 1;              // 单关键词不必换色，多关键词才按词轮换底色
  var low = s.toLowerCase();
  var iv = [];
  for (var ti = 0; ti < terms.length; ti++){
    var ql = String(terms[ti] || '').toLowerCase();
    if (!ql) continue;
    var i = 0, guard = 0;
    while (guard++ < 200){
      var k = low.indexOf(ql, i);
      if (k < 0) break;
      iv.push([k, k + ql.length, ti]);        // 记下"这一命中属于第几个关键词"
      i = k + ql.length;
    }
  }
  if (!iv.length) return E(s);
  iv.sort(function(a, b){ return a[0] - b[0] || b[1] - a[1]; });
  var out = '', pos = 0;
  for (var j = 0; j < iv.length; j++){
    var a = iv[j][0], b = iv[j][1], t = iv[j][2];
    if (a < pos){ if (b > pos) pos = b; continue; }   // 与上一段重叠 → 直接合并（保留先出现那个词的底色）
    if (a > pos) out += E(s.slice(pos, a));
    out += '<span class="hl' + (multi ? ' hl-' + (t % 3 + 1) : '') + '">' + E(s.slice(a, b)) + '</span>';
    pos = b;
  }
  out += E(s.slice(pos));
  return out;
}

function idxBtnHtml(hasIdx){
  return '<button class="idxBtn" id="idxBuild">' +
    (hasIdx ? '重建 / 更新正文索引' : '建立正文索引') + '</button>';
}

// more=true 表示「加载更多」：在现有结果后面追加下一页，而不是从头搜一遍。
function runSearch(q, more){
  state.q = q;
  var box = document.getElementById('sideScroll');
  if (!box) return;
  if (!q){ abortSearch(); rememberSearch(); searchState = null; renderSide(); return; }
  var pq = parseSearchQuery(q);
  if (!pq.q && !pq.ext && !pq.dir){ abortSearch(); rememberSearch(); searchState = null; renderSide(); return; }

  var fresh = !more || !searchState || searchState.q !== q;
  var offset = fresh ? 0 : searchState.results.length;
  var useDir = effDir(pq);                       // path: 手写优先，其次「只在当前目录内搜索」开关
  if (fresh){
    searchState = { q: q, pq: pq, terms: pq.terms, results: [], total: 0, hasMore: false, meta: null };
    srSel = -1;                                // 新查询 → 清掉上一轮的键盘选中
  }
  // 同一查询（含分页 + 类型筛选 + 目录范围）30 秒内直接命中缓存 ——
  // 反复改词 / 切筛选芯片不再打服务器，既省一次 R2 list 补扫 + 评分，又让侧栏"秒出"。
  var key = q + '\u0001' + offset + '\u0001' + srFilter + '\u0001' + useDir;
  var hit = searchCacheGet(key);
  if (hit){ applySearchData(hit, fresh); return; }

  abortSearch();                                   // 上一笔还没回来就取消掉，别浪费配额
  searchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var seq = ++searchSeq;
  if (fresh) box.innerHTML = '<div class="side-hint">搜索中…</div>';
  var url = BASE + '/api?action=search&q=' + encodeURIComponent(pq.q) +
    (pq.ext ? '&ext=' + encodeURIComponent(pq.ext) : '') +
    (useDir ? '&dir=' + encodeURIComponent(useDir) : '') +
    (pq.word ? '&word=1' : '') +
    (srFilter ? '&ftype=' + srFilter : '') + '&offset=' + offset + '&limit=' + SEARCH_PAGE;
  req(url, searchAbort ? { signal: searchAbort.signal } : undefined)
    .then(function(r){ return r.json(); }).then(function(d){
    if (seq !== searchSeq || state.q !== q) return;   // 已被更新的输入取代 → 丢弃
    searchAbort = null;
    searchCacheSet(key, d);
    applySearchData(d, fresh);
  }).catch(function(e){
    if (seq !== searchSeq || state.q !== q) return;
    searchAbort = null;
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;
    var b = document.getElementById('sideScroll');
    if (b) b.innerHTML = '<div class="side-hint">搜索失败：' + E(e.message) + '</div>';
  });
}

function applySearchData(d, fresh){
  if (!searchState) return;
  var list = d.results || [];
  searchState.results = fresh ? list.slice() : searchState.results.concat(list);
  searchState.total = d.total || 0;
  searchState.hasMore = !!d.hasMore;
  searchState.meta = d;
  if (d.terms && d.terms.length) searchState.terms = d.terms;
  renderSearchResults();
}

// 结果归类：文件夹 / 文件名命中 / 路径命中 / 正文命中。
// 分组和筛选芯片都按这套归类，前后端口径一致。
function srKind(it){
  if (it.isDir) return 'dir';
  if (it.nameHit) return 'name';
  if (it.pathHit) return 'path';
  return 'text';
}
var SR_KINDS = [
  { k: 'name', t: '文件名命中', n: 'nameHits' },
  { k: 'path', t: '路径命中', n: 'pathHits' },
  { k: 'text', t: '正文命中', n: 'textHits' },
  { k: 'dir', t: '文件夹', n: 'dirHits' }
];

// 一条搜索结果行。信息层级：文件名（主）→ 目录 → 正文片段 → 修改时间。
// 深搜入口不再挤在行里（一行三个按钮太吵），收进 ⋯ / 右键菜单。
function srRowHtml(it, terms, q, idx){
  var segs = it.path.split('/');
  var nm = segs.pop();
  var dirPart = segs.join('/');
  var kind = srKind(it);
  var tag = kind === 'dir' ? '<span class="sr-tag dir">文件夹</span>'
    : (kind === 'name' ? '<span class="sr-tag">文件名</span>'
    : (kind === 'path' ? '<span class="sr-tag path">路径</span>' : ''));
  var cut = (kind === 'text' && it.cut === 1)
    ? '<span class="sr-cut" title="该文件较大，只索引了前 8K 正文，命中可能被截断；可右键「深搜此文件」读全文">可能截断</span>' : '';
  // 正文命中次数：告诉用户"这个词在这份文件里出现了几处"，不用点进去数
  var cntTag = (kind === 'text' && it.cnt > 1)
    ? '<span class="sr-tag cnt">正文 ' + it.cnt + ' 处</span>' : '';
  var meta = (!it.isDir && it.mtime) ? ('修改 ' + fmtTime(it.mtime)) : '';
  var icon = it.isDir ? '<span class="ico f">' + ICON_FOLDER_S + '</span>' : '<span class="ico f">' + ICON_FILE + '</span>';
  return '<div class="sfile' + (it.isDir ? ' sdir' : '') + (idx === srSel ? ' sel' : '') +
    '" data-openpath="' + E(it.path) + '" data-srkind="' + kind + '"' +
    (it.isDir ? ' data-isdir="1"' : '') + ' data-sq="' + E(q) + '"' +
    (it.snippet ? ' data-snip="1"' : '') +
    ' title="' + E(it.path) + '">' +
    icon +
    '<span class="fname">' + hlText(nm, (it.nameHit || it.pathHit) ? terms : null) + extBadge(nm, it.ct) + tag + cntTag + cut +
    (dirPart ? '<span class="sr-dir">' + hlText(dirPart, terms) + '</span>' : '') +
    (it.snippet ? '<span class="sr-snip">' + hlText(it.snippet, terms) + '</span>' : '') +
    (meta ? '<span class="sr-meta">' + E(meta) + '</span>' : '') +
    '</span>' +
    '<span class="fsz">' + (it.isDir ? '' : fmtSize(it.size)) + '</span>' +
    (RO ? '' : '<button class="tact" data-sact="1" data-p="' + E(it.path) + '" data-dir="' +
      (it.isDir ? 1 : 0) + '" title="更多操作（右键也可以）" tabindex="-1">' + ICON_MORE + '</button>') +
    '</div>';
}

function renderSearchResults(){
  var box = document.getElementById('sideScroll');
  if (!box || !searchState) return;
  var st = searchState, d = st.meta || {}, list = st.results, terms = st.terms || [], q = st.pq.q;
  var shown = list.length;
  var head = '<div class="side-label"><span>搜索结果</span><span>' +
    (st.hasMore ? shown + ' / ' + st.total : shown) + '</span></div>';

  // 筛选芯片：各类型数量来自服务端计数（筛选前的真实总量），点一下只看那一类。
  // 分享页没有正文命中这一类（textHits 恒为 0），显式跳过 —— 万一以后有人加了别的路径，
  // 也不会凭空冒出一个点下去永远空白的芯片。
  var chips = '';
  if (d.indexed !== undefined){
    var cAll = '<button data-ftype="" class="' + (srFilter === '' ? 'on' : '') + '">全部 ' + (d.total || 0) + '</button>';
    var cRest = '';
    for (var ci = 0; ci < SR_KINDS.length; ci++){
      var kd = SR_KINDS[ci], cn = d[kd.n] || 0;
      if (RO && kd.k === 'text') continue;
      if (!cn) continue;
      cRest += '<button data-ftype="' + kd.k + '" class="' + (srFilter === kd.k ? 'on' : '') + '">' +
        kd.t + ' ' + cn + '</button>';
    }
    chips = '<div class="sr-chips">' + cAll + cRest + '</div>';
  }

  // 分享页（访客）：只搜文件名 / 路径，没有全文索引这回事。
  // 所以这里**刻意不提**索引、正文、"未进索引"、容量上限那些词 ——
  // 访客既没有建索引的权限（reindex 只对管理员开放），提了只会让人点一个必然失败的按钮。
  // 直接一句话说清"搜不了正文"，比让他自己撞一次 404 更好。
  var note;
  if (RO){
    note = '<div class="side-note">此分享页<b>只按文件名和目录名搜索</b>，不搜索文件内容。' +
      '<br><span style="color:#8c959f">语法：ext:后缀 · path:目录 · 空格=多个关键词（都要命中） · "整词匹配"' +
      (shown ? '　·　↑↓ 选择 · Enter 打开' : '') + '</span></div>';
  } else {
    note = '<div class="side-note">' +
      (d.indexed
        ? ('索引 ' + d.indexedCount + ' 个文件' +
           (srFilter ? '　已筛选：' + (srFilter === 'name' ? '文件名' : srFilter === 'path' ? '路径' : srFilter === 'text' ? '正文' : '文件夹') : ''))
        : '未建立正文索引，目前只匹配文件名') +
      (terms.length > 1 ? '<br><span style="color:#8c959f">按 <b>' + terms.length +
        '</b> 个关键词同时匹配（AND）：' + E(terms.join(' + ')) + '（底色按词区分）</span>' : '') +
      (d.stale ? '<br><span style="color:#b35900">另有 ' + d.stale + ' 个文件未进索引' +
        '（仍可按文件名搜到，但正文搜不到）；点下方按钮重建索引即可补上</span>' : '') +
      (d.capFull ? '<br><span style="color:#b35900">正文索引容量已满，之后的新文件只按文件名搜索' +
        '（单文件正文片段已自动缩短）；可在环境变量里调大 INDEX_TEXT_CAP 后重建索引</span>' : '') +
      '<br><span style="color:#8c959f">语法：ext:后缀 · path:目录 · 空格=多个关键词（都要命中） · "整词匹配"' +
      (shown ? '　·　↑↓ 选择 · Enter 打开' : '') + '</span></div>';
  }
  // 重建入口只对管理员有意义（reindex 需要管理端权限），访客点了必然 403
  var extra = RO ? '' : idxBtnHtml(d.indexed);

  if (!shown){
    box.innerHTML = head + chips + '<div class="side-hint">没有找到匹配的内容</div>' + note + extra;
    bindIdxBtn();
    return;
  }
  var h = head + chips + note;
  var i, it;

  // 「全部」视图下按类型分组；已经用芯片筛选过就平铺，不再重复分组。
  // 分组的**先后**不写死，而是按"该类型在结果里第一次出现的位置"排 ——
  // 服务端已按相关度排好（文件夹条目 > 文件名 > 路径 > 正文），
  // 分组只做归拢、不许把服务端排好的名次打乱（否则搜目录名时文件夹会被挤到末尾）。
  var group = (srFilter === '') && list.length > 1;
  if (group){
    var buckets = {}, order = [];
    for (i = 0; i < list.length; i++){
      var k = srKind(list[i]);
      if (!buckets[k]){ buckets[k] = []; order.push(k); }
      buckets[k].push(list[i]);
    }
    var label = {};
    for (var li = 0; li < SR_KINDS.length; li++) label[SR_KINDS[li].k] = SR_KINDS[li].t;
    var gi = 0;
    for (var oi = 0; oi < order.length; oi++){
      var bk = buckets[order[oi]];
      h += '<div class="sr-group">' + (label[order[oi]] || order[oi]) + ' <b>' + bk.length + '</b></div>';
      for (var bj = 0; bj < bk.length; bj++){ h += srRowHtml(bk[bj], terms, q, gi); gi++; }
    }
  } else {
    for (i = 0; i < list.length; i++) h += srRowHtml(list[i], terms, q, i);
  }

  h += '<div class="moreRow">' + (st.hasMore
    ? '<button id="srMore">加载更多（还有 ' + (st.total - shown) + ' 条）</button>'
    : '<span class="sr-end">已显示全部 ' + shown + ' 条</span>') + '</div>';
  box.innerHTML = h + extra;
  bindIdxBtn();
  var mb = document.getElementById('srMore');
  if (mb) mb.onclick = function(){
    mb.disabled = true;
    mb.textContent = '加载中…';
    runSearch(st.q, true);
  };
}

// 结果列表键盘导航：↑↓ 移动选中行（自动滚进视野），Enter 打开，Esc 取消选中。
function srRows(){
  var box = document.getElementById('sideScroll');
  if (!box || !searchState) return [];
  return box.querySelectorAll('.sfile[data-openpath]');
}
function srSelect(next){
  var rows = srRows();
  if (!rows.length) return false;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i === next);
  srSel = next;
  try { rows[next].scrollIntoView({ block: 'nearest' }); } catch (e) {}
  return true;
}
function srOpenSelected(){
  var rows = srRows();
  if (srSel < 0 || srSel >= rows.length) return false;
  rows[srSel].click();
  return true;
}
function srClearSel(){
  var rows = srRows();
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('sel');
  srSel = -1;
}

// 深搜：索引只留了前 8K，对"可能截断"的文件读全文精确验证。
// 结果是**行号列表弹窗** —— 点击任意一行直接打开文件并跳到那一行；
// 超大文件（>512KB）服务端不给行号（省 CPU），只显示命中总数。
var pendingGoLine = null;   // 点击深搜结果后记录待跳行号，openEditor 载入完成后消费
function deepSearch(path, q, word){
  toast('正在读取全文…');
  req(BASE + '/api?action=deepsearch&path=' + encodeURIComponent(path) + '&q=' + encodeURIComponent(q) + (word ? '&word=1' : ''))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      if (!d.found){ toast('读完全文也没有找到（编码 ' + (d.enc || '未知') + '）'); return; }
      var terms = (d.terms && d.terms.length) ? d.terms : [q];
      var list = d.hits || [];
      var rows = list.map(function(h){
        return '<div class="dlrow" data-dl="' + E(path) + '" data-line="' + h.n + '" title="点击打开文件并跳到这一行">' +
          '<span class="dln">第 ' + h.n + ' 行</span>' +
          '<span class="dlt">' + hlText(h.t, terms) + '</span>' +
          (h.c > 1 ? '<span class="dlc">' + h.c + ' 处</span>' : '') +
          '</div>';
      }).join('');
      var extra = d.hits
        ? (d.hitsMore ? '<div class="hint dim">命中行较多，仅列出前 ' + list.length + ' 行</div>' : '')
        : '<div class="hint dim">文件较大，未列出具体行号（仅统计首个关键词的出现次数）</div>';
      showModal({
        title: '深搜「' + (path.split('/').pop()) + '」：' + (d.hits
          ? '共 ' + d.count + ' 处命中（' + (d.lines || list.length) + ' 行）' +
            (list.length ? '，下列前 ' + list.length + ' 行' : '')
          : '共 ' + d.count + ' 处命中（近似）'),
        small: true, noOk: true, cancelText: '关闭',
        body: '<div class="dllist">' + rows + '</div>' + extra +
          '<div class="hint dim" style="margin-top:8px">' +
          (terms.length > 1 ? '只列出同时含全部 ' + terms.length + ' 个关键词的行；' : '') +
          '片段以命中位置为中心截取，关键词已高亮；点击任意一行，直接打开文件并跳到该位置</div>'
      });
    }).catch(function(e){ toast('深搜失败：' + e.message); });
}

function bindIdxBtn(){
  var b = document.getElementById('idxBuild');
  if (b) b.onclick = reindexAll;
}

// 分批建索引：免费版每次请求只有 10ms CPU，一次解码几百个文件必然超限，
// 所以前端循环调用、直到服务端回 done。
// **不传 limit** —— 批大小由服务端按索引体积自适应决定（索引越大批越小，避开 1102）。
// 这里只保留一个兜底上限，防止服务端异常时前端无限循环。
function reindexAll(){
  var b = document.getElementById('idxBuild');
  if (b){ b.disabled = true; b.textContent = '正在建立索引…'; }
  var lastKey = '', round = 0;
  var step = function(){
    round++;
    return post({ action: 'reindex', lastKey: lastKey }).then(function(d){
      if (!d.ok) throw new Error(d.error || '建立索引失败');
      if (d.lastKey) lastKey = d.lastKey;
      if (b) b.textContent = '正在建立索引… 已处理 ' + d.files + ' 个文件';
      if (!d.done && round < 300) return step();
      return d;
    });
  };
  step().then(function(d){
    if (b){ b.disabled = false; b.textContent = '正文索引已就绪（' + d.files + ' 个文件）'; }
    toast('索引已建立：' + d.files + ' 个文件，正文合计 ' + fmtSize(d.textBytes));
    clearSearchCache();               // 索引变了，旧结果（尤其"未进索引"提示）已过时
    if (state.q) runSearch(state.q);
  }).catch(function(e){
    if (b){ b.disabled = false; b.textContent = '建立索引失败，点此重试'; }
    toast('建立索引失败：' + e.message);
  });
}

// ===== 目录导航与历史记录 =====
// 目录跳转要进历史栈，这样手机/浏览器的返回键才是"回上一级目录"，
// 而不是直接退出整个网站。
// 之前用的是 replaceState，历史里永远只有一条 —— 用户一按返回就直接离开，
// 想回上一级只能去开左侧抽屉，非常别扭。
function navUrl(path){
  return BASE + (path ? '?path=' + encodeURIComponent(path) : '');
}

// push=true 时新增一条历史；首次加载（history.state 还是 null）只能用 replace ——
// 本次页面导航本身已经产生了一条记录，再 push 会出现两条 URL 完全相同的记录，
// 用户按返回看着像"没反应"。
function setUrl(path, push){
  try {
    var st = { p: path || '' };
    if (push && history.state != null) history.pushState(st, '', navUrl(path));
    else history.replaceState(st, '', navUrl(path));
  } catch (e) {}
}

// 返回键 / 前进键：回到历史里那一级目录，而不是离开整个网站
window.addEventListener('popstate', function(ev){
  var st = ev.state || {};
  var p = (typeof st.p === 'string') ? st.p : '';
  if (typeof st.p !== 'string'){
    // 少数情况（比如用户手动改了地址栏）拿不到 state，退回解析 query
    try { p = new URLSearchParams(location.search).get('path') || ''; } catch (e) { p = ''; }
  }
  load(p, true);                  // true = 不要再往历史里塞一条
});

// ===== 编辑器顶部的路径条 =====
// 手机上左侧抽屉是收起来的，在编辑器里"不知道自己在这个文件的哪一级、想换目录得先去开抽屉"
// 很别扭。这里把当前文件的完整路径铺出来，**每一级目录都可点** ——
// 点一下直接跳到那一级的列表（切视图由 load 负责）。
// 复用列表页面包屑的 data-nav 属性，所以点击逻辑走同一套事件委托，不用另写分支。
function renderEdCrumb(pathOverride){
  var box = document.getElementById('edCrumb');
  if (!box) return;
  var p = pathOverride || ed.path || '';
  if (!p){ box.innerHTML = ''; return; }
  var parts = p.split('/');
  var file = parts.pop();
  var rootLabel = RO ? (SHARE_NAME || '分享内容') : '根目录';
  var h = '<a href="#" data-nav="">' + E(rootLabel) + '</a>';
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    h += '<span class="sep">/</span><a href="#" data-nav="' + E(acc) + '">' + E(parts[i]) + '</a>';
  }
  h += '<span class="sep">/</span><span class="curfile" title="' + E(file) + '">' + E(file) + '</span>' +
       shBadge(p, false);
  box.innerHTML = h;
}

// ===== 列表视图 =====
// 大目录分页：一次最多取 PAGE_SIZE 项，剩下的给一个「加载更多」按钮，
// 避免上千个文件一次性灌进 DOM 造成首屏卡顿。
var PAGE_SIZE = 300;

function load(path, noHist){
  if (state.multi) exitMulti();       // 换目录就退出多选，免得"选中的还是上个目录里的东西"
  state.path = path || '';
  state.sel = {};
  state.lastPick = null;
  state.more = '';
  if (state.view === 'edit') switchView('list');
  markOpen(state.path);                       // 展开到当前目录，树里能直接看到它在哪
  var sp = {
    path: state.path, pageSize: PAGE_SIZE,
    sort: state.sort.by, desc: state.sort.desc ? 1 : 0
  };
  return Promise.all([ api('list', sp), loadTree() ]).then(function(res){
    var d = res[0];
    state.folders = d.folders || [];
    state.files = d.files || [];
    state.more = d.cursor || '';
    state.total = d.total || 0;
    renderList();
    renderSide();
    lpTipOnce();
    setUrl(state.path, !noHist);
    revealInTree(state.path);
  }).catch(function(e){
    document.getElementById('list').innerHTML = '<div class="empty">读取失败：' + E(e.message) + '</div>';
  });
}

function loadMore(){
  if (!state.more) return;
  var cursor = state.more;
  state.more = '';                       // 先清掉，防连点重复请求
  api('list', {
    path: state.path, pageSize: PAGE_SIZE, cursor: cursor,
    sort: state.sort.by, desc: state.sort.desc ? 1 : 0
  }).then(function(d){
    state.folders = state.folders.concat(d.folders || []);
    state.files = state.files.concat(d.files || []);
    state.more = d.cursor || '';
    renderList();
  }).catch(function(e){
    toast('加载更多失败：' + e.message);
    state.more = cursor;
  });
}

function renderAcct(){
  var acct = document.getElementById('acct');
  if (!acct) return;
  // 刷新：放在「退出」左侧，两页都给 —— 只读分享页没有退出，但同样需要"拉最新的内容"
  var h = '<button class="btn ghost sm" id="btnReload" title="刷新页面">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
    '刷新</button>';
  if (!RO && HAS_PW){
    h += '<button class="btn ghost sm" id="btnLogout" title="退出登录">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>' +
      '退出</button>';
  }
  acct.innerHTML = h;
  document.getElementById('btnReload').onclick = function(){ location.reload(); };
  if (!RO && HAS_PW) document.getElementById('btnLogout').onclick = doLogout;
}

function renderList(){
  var parts = state.path ? state.path.split('/') : [];
  var rootLabel = RO ? (SHARE_NAME || '分享内容') : '根目录';
  var cr = '<a href="#" data-nav="">' + E(rootLabel) + '</a>';
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    cr += '<span class="sep">/</span><a href="#" data-nav="' + E(acc) + '">' + E(parts[i]) + '</a>';
  }
  document.getElementById('crumb').innerHTML = cr;

  var bar = '';
  if (!RO){
    bar = '<button class="btn" id="btnUp">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>上传文件</button>' +
      '<button class="btn" id="btnUpDir">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14l3-3 3 3"/></svg>上传文件夹</button>' +
      '<button class="btn" id="btnNewTxt">新建文本</button>' +
      '<button class="btn" id="btnNewDir">新建文件夹</button>' +
      '<button class="btn" id="btnShareDir">分享本目录</button>' +
      '<button class="btn" id="btnShareMgr">分享管理</button>';
  } else {
    bar = '<span class="tip" style="margin:0">' + state.folders.length + ' 个文件夹 · ' +
      state.files.length + ' 个文件</span>';
  }
  bar += sortBarHtml();
  document.getElementById('listBar').innerHTML = bar;
  renderAcct();

  var COLS = 5;
  var rows = '';

  // 单个文件夹行
  function folderRow(nm, isProt){
    var fullNm = joinPath(state.path, nm);
    var protMark = isProt ? '<span class="prot" title="受保护文件夹：删除里面的文件需要管理员密码，取消保护也要密码">🔒 受保护</span>' : '';
    return '<tr' + (isProt ? ' class="prot-row"' : '') + '>' +
      '<td><div class="nm">' + ckHtml(nm, true) + '<span class="ico dir">' + dirIcon(fullNm, false, isProt) + '</span>' +
      '<a class="link" href="#" data-open="' + E(nm) + '" data-type="dir">' + E(nm) + '</a>' +
      protMark + shBadge(fullNm, true) + '</div></td>' +
      '<td class="hide-s" style="color:#8c959f">文件夹</td>' +
      '<td class="hide-s"></td><td class="hide-s"></td>' +
      '<td><button class="tact" data-tact="1" data-p="' + E(fullNm) + '" data-dir="1" title="操作：打开 / 下载 / 分享 / 重命名 / 移动 / 删除">' + ICON_MORE + '</button></td></tr>';
  }
  // 分区标题行（横跨整行）：整幅色带，两个区间一眼分开
  function sectRow(label, hint, cls){
    return '<tr class="sect' + (cls ? ' ' + cls : '') + '"><td colspan="' + COLS + '"><div class="band"><span class="sect-t">' + label + '</span>' +
      (hint ? '<span class="sect-h">' + hint + '</span>' : '') + '</div></td></tr>';
  }

  // 受保护的文件夹单独成区，且永远排在最前面；其余文件夹按原顺序跟在后面
  var protFolders = [], normFolders = [];
  for (var f0 = 0; f0 < state.folders.length; f0++){
    var nm0 = state.folders[f0];
    if (!RO && treeProtected[joinPath(state.path, nm0)]) protFolders.push(nm0);
    else normFolders.push(nm0);
  }
  if (protFolders.length){
    rows += sectRow('🔒 受保护文件夹', protFolders.length + ' 项 · 删除与解除保护都需要管理员密码', 'sect-prot');
    for (var pf = 0; pf < protFolders.length; pf++) rows += folderRow(protFolders[pf], true);
    if (normFolders.length) rows += sectRow('📁 普通文件夹', normFolders.length + ' 项');
  }
  for (var nf = 0; nf < normFolders.length; nf++) rows += folderRow(normFolders[nf], false);
  for (var k = 0; k < state.files.length; k++){
    var it = state.files[k];
    rows += '<tr>' +
      '<td><div class="nm">' + ckHtml(it.name, false) + '<span class="ico f">' + ICON_FILE + '</span>' +
      '<a class="link" href="#" data-open="' + E(it.name) + '" data-type="file">' + E(it.name) + '</a>' +
      extBadge(it.name, it.ct) +
      shBadge(joinPath(state.path, it.name), false) + '</div></td>' +
      '<td class="hide-s" style="color:#6e7781">' + E(typeLabel(it.name, it.ct)) + '</td>' +
      '<td class="hide-s">' + fmtSize(it.size) + '</td>' +
      '<td class="hide-s">' + fmtTime(it.mtime) + '</td>' +
      '<td><button class="tact" data-tact="1" data-p="' + E(joinPath(state.path, it.name)) + '" data-dir="0" title="操作：打开 / 预览 / 下载 / 分享 / 重命名 / 移动 / 删除">' + ICON_MORE + '</button></td></tr>';
  }
  if (state.more){
    rows += '<tr><td colspan="' + COLS + '"><div class="moreRow"><button id="moreBtn">加载更多（这个目录还有未显示的内容）</button></div></td></tr>';
  }
  if (!rows){
    rows = '<tr><td colspan="' + COLS + '" class="empty">这里还是空的 — ' + (RO ? '' : '点右上角「上传文件」或「新建文本」开始吧') + '</td></tr>';
  }

  document.getElementById('list').innerHTML =
    '<table><thead><tr>' +
      sortTh('name', '名称') +
      sortTh('type', '类型', 'width:104px') +
      sortTh('size', '大小', 'width:110px') +
      sortTh('time', '修改时间', 'width:152px') +
      '<th style="width:1%;white-space:nowrap;text-align:right">操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';

  var tip = document.getElementById('tip');
  tip.textContent = RO ? '' : ('共 ' + state.folders.length + ' 个文件夹 / ' + state.files.length + ' 个文件' +
    (state.more ? '（已显示部分）' : '') + ' · 在列表空白处按住拖动可框选，Shift+点击可连选');

  var mbtn = document.getElementById('moreBtn');
  if (mbtn) mbtn.onclick = loadMore;
  bindSortBar();

  if (!RO){
    document.getElementById('btnUp').onclick = function(){ document.getElementById('fileInput').click(); };
    document.getElementById('btnUpDir').onclick = function(){ document.getElementById('dirInput').click(); };
    document.getElementById('btnNewTxt').onclick = newText;
    document.getElementById('btnNewDir').onclick = newDir;
    document.getElementById('btnShareDir').onclick = function(){ openShareModal(state.path, true); };
    document.getElementById('btnShareMgr').onclick = openShareManager;
    syncShareMgr();
  }
  syncSelection();
}

function dlUrl(name, path){
  return BASE + '/api?action=download&path=' + encodeURIComponent(path || joinPath(state.path, name));
}

// ===== ZIP 打包（手写，不引第三方库）=====
// 为什么自己写：整个 Worker 是单文件内联的，塞一个 zip 库会明显增大体积，
// 而"不压缩（store 模式）"的 ZIP 只需要 CRC32 + 四个固定头，几百行就够。
// 为什么在浏览器端打包：Worker 只有 10ms CPU / 128MB 内存，
// 而浏览器有整台机器的内存和网络 —— 后端只给清单（packList），内容逐个取回。
var CRC_TBL = (function(){
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++){
    var c = i;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf, seed){
  var c = seed === undefined ? 0xFFFFFFFF : seed;
  for (var i = 0; i < buf.length; i++) c = CRC_TBL[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// DOS 时间/日期：固定值即可（ZIP 不要求真实时间，浏览器解压后不影响使用）
var DOS_TIME = 0, DOS_DATE = 0x21;

// 组一个 store 模式的 ZIP。items: [{ name, data }]，
// data 为 null 的条目当作**目录**（名字以 / 结尾、内容为空）——
// ZIP 用这种方式记录空目录，解压器才会把这一层建出来。
function buildZip(items){
  var enc = new TextEncoder();
  var parts = [], central = [], offset = 0;
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    var isDir = it.data == null;
    var name = isDir && it.name.charAt(it.name.length - 1) !== '/' ? it.name + '/' : it.name;
    var nameB = enc.encode(name);
    var data = isDir ? new Uint8Array(0) : it.data;
    var crc = crc32(data);
    // 本地文件头
    var lfh = new Uint8Array(30 + nameB.length);
    var dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);          // 标志位第 11 位 = 文件名是 UTF-8（中文不乱码的关键）
    dv.setUint16(8, 0, true);               // 方法 0 = 不压缩
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    lfh.set(nameB, 30);
    parts.push(lfh, data);
    // 中央目录项
    var cdh = new Uint8Array(46 + nameB.length);
    var cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(38, isDir ? 0x10 : 0, true);         // 外部属性：目录位（MS-DOS 目录标志）
    cv.setUint32(42, offset, true);
    cdh.set(nameB, 46);
    central.push(cdh);
    offset += lfh.length + data.length;
  }
  var cdSize = 0;
  for (var j = 0; j < central.length; j++) cdSize += central[j].length;
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
}

// 触发浏览器保存
function saveBlob(blob, filename){
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){
    URL.revokeObjectURL(a.href);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 4000);
}
// zip 里的条目名：正斜杠、去掉开头的斜杠、**清掉 .. 与 . 这些路径穿越片段**。
// 【坑】整段代码在 appHtml 的模板字符串里，反斜杠字面量会被模板引擎当成转义序列吃掉，
// 写进正则就成了非法表达式。所以一个反斜杠字面量都不写：反斜杠用字符码取。
var ZIP_BS = String.fromCharCode(92);
function zipEntryName(p){
  var raw = String(p).split(ZIP_BS).join('/').split('/');
  var out = [];
  for (var i = 0; i < raw.length; i++){
    var seg = raw[i];
    if (!seg || seg === '.') continue;          // 空段与当前目录：跳过
    if (seg === '..'){ out.pop(); continue; }   // 上跳一段（弹掉已收集的）
    out.push(seg);
  }
  return out.join('/');
}

// 取一个文件的原始字节（复用现成的下载接口）
// attempts > 1 时对 429 退避重试：打包动辄几百个请求，很容易撞上每分钟限速，
// 不重试的话后面的文件会**静默全部失败**（用户只看到 zip 里少了一堆文件）。
function fetchFileBytes(path, attempts){
  var tries = attempts || 1;
  var run = function(left){
    return fetch(BASE + '/api?action=download&path=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function(r){
        if (r.status === 401){ location.reload(); throw new Error('登录已过期'); }
        if (r.status === 429 && left > 0){
          var ra = parseInt(r.headers.get('Retry-After'), 10) || 0;
          var wait = ra > 0 ? Math.min(ra * 1000, 8000) : Math.min(1000 * Math.pow(2, tries - left), 8000);
          return new Promise(function(res){ setTimeout(res, wait); }).then(function(){ return run(left - 1); });
        }
        if (!r.ok) return r.text().then(function(t){ throw new Error(t || ('HTTP ' + r.status)); });
        return r.arrayBuffer();
      })
      .then(function(b){ return new Uint8Array(b); });
  };
  return run(tries - 1);
}

// ===== 打包下载：把若干文件/文件夹打成一个 zip =====
// progressEl 用来实时显示进度（可省略）
function packDownload(paths, zipName, progressEl){
  return Promise.all(paths.map(function(p){ return api('packList', { path: p }); }))
    .then(function(lists){
      // 汇总要打的文件清单。
      // zip 里的**条目名**（entry）决定了解压后的目录结构，这里有三条规则：
      //   1) 打包单个文件夹时去掉它的顶层目录名 —— 打 a/ 就得到 a/same.txt，
      //      这样同时打 a/ 和 b/ 也不会出现两个 same.txt 互相覆盖；
      //   2) 打包单个**文件**时只取文件名，不带任何目录；
      //   3) 多选且不是"仅一个文件夹"时，全部条目都带顶层目录名，同样避免同名覆盖。
      var files = [], seen = {}, dirEntries = [];
      var dirsCut = false;                                 // 目录条目是否因为总量上限被截断
      var multi = paths.length > 1;
      var onlyOneDir = paths.length === 1 && !lists[0].isFile;
      for (var i = 0; i < lists.length; i++){
        var L = lists[i];
        if (!L.ok) throw new Error(L.error || ('读取 ' + paths[i] + ' 失败'));
        // 真空目录（连一个子目录、一个文件都没有）：用户明确要下载它，
        // 所以把**这个目录自己**作为一个条目放进 zip —— 否则 zip 是空的，
        // 用户拿到的压缩包连解压都解压不出东西，等于什么都没下到。
        if (!L.isFile && !L.files.length && !(L.dirs && L.dirs.length)){
          var self = zipEntryName(L.dir ? (L.dir.split('/').pop() || L.dir) : '根目录');
          if (self && !seen[self]){ seen[self] = 1; dirEntries.push(self); }
        }
        // 空目录也要打进 zip（以 / 结尾的条目），否则解压后少了这些层
        // 目录条目也要有**总量**上限：ZIP 的中央目录用 16 位存条目数，超过 65535 个
        // 整个压缩包会损坏（实测每个目录条目约 96 字节、约 200 字节内存）。
        // 单个 packList 的 dirs 有 300 上限，但多选时是各列表相加 —— 这里统一封顶。
        if (L.dirs && L.dirs.length && !L.isFile){
          for (var q = 0; q < L.dirs.length; q++){
            if (dirEntries.length >= ZIP_MAX_DIRS){ dirsCut = true; break; }
            var base2 = L.dir ? L.dir + '/' : '';
            var drel = L.dirs[q].slice(base2.length) || L.dirs[q].split('/').pop();
            var dentry = zipEntryName((multi || !onlyOneDir) ? L.dirs[q] : drel);
            if (dentry && !seen[dentry]){ seen[dentry] = 1; dirEntries.push(dentry); }
          }
        }
        for (var j = 0; j < L.files.length; j++){
          var f = L.files[j];
          var entry;
          if (L.isFile){
            entry = f.p.split('/').pop();                 // 单个文件：只要文件名
          } else {
            var base = L.dir ? L.dir + '/' : '';
            var rel = f.p.slice(base.length) || f.p.split('/').pop();
            entry = (multi || !onlyOneDir) ? f.p : rel;  // 见上面三条规则
          }
          entry = zipEntryName(entry);
          if (!entry) continue;
          if (seen[entry]) continue;                     // 同名只留一份（多选重叠时会发生）
          seen[entry] = 1;
          files.push({ p: f.p, s: f.s, entry: entry });
        }
      }
      // 走到这里说明所有条目都被去重/清洗掉了（正常情况不会发生，因为真空目录会补上自己）。
// 措辞要说清是「打不出内容」而不是「无法下载」—— 空目录本来是允许下载的。
if (!files.length && !dirEntries.length) throw new Error('这个路径里没有可打包的内容');
      var truncated = lists.some(function(L){ return L.truncated; }) || dirsCut;

      if (progressEl) progressEl('开始下载 ' + files.length + ' 个文件…');
      // 并发逐个取内容（3 路：打包本身请求量大，再高容易撞限速）
      var items = new Array(files.length);
      var done = 0, failed = [], gotBytes = 0;
      var pool = 3, next = 0;
      var lane = function(){
        if (next >= files.length) return Promise.resolve();
        var i = next++;
        return fetchFileBytes(files[i].p, 5).then(function(d){
          items[i] = { name: files[i].entry, data: d };
          gotBytes += d.length;
        }).catch(function(e){
          failed.push(files[i].p + '（' + e.message + '）');
        }).then(function(){
          done++;
          if (progressEl) progressEl('已下载 ' + done + '/' + files.length + '（累计 ' + fmtSize(gotBytes) + '）');
          return lane();
        });
      };
      var lanes = [];
      for (var k = 0; k < pool; k++) lanes.push(lane());
      return Promise.all(lanes).then(function(){
        var okItems = items.filter(Boolean);
        // 全部文件都失败、但有空目录可打时仍然算成功（那个空目录本身就是用户要的）
        if (!okItems.length && !dirEntries.length) throw new Error('全部文件都下载失败' + (failed.length ? '：' + failed[0] : ''));
        if (progressEl) progressEl('正在生成 zip…');
        // 空目录条目放在文件前面（解压器按顺序建目录，先建好层再放文件更稳）
        var dirItems = dirEntries.map(function(d){ return { name: d, data: null }; });
        var blob = buildZip(dirItems.concat(okItems));
        saveBlob(blob, zipName);
        return { total: files.length, ok: okItems.length, dirs: dirEntries.length, failed: failed, truncated: truncated };
      });
    });
}

// ===== 多选（不重建表格，避免卡顿）=====
function selKey(name, isDir){ return (isDir ? 'd:' : 'f:') + name; }
function selCount(){ var n = 0; for (var k in state.sel) { if (state.sel[k]) n++; } return n; }
function selItems(){ var o = []; for (var k in state.sel) { if (state.sel[k]) o.push(state.sel[k]); } return o; }

function ckHtml(name, isDir){
  if (RO) return '';
  var key = selKey(name, isDir);
  return '<input type="checkbox" class="ck"' + (state.sel[key] ? ' checked' : '') +
    ' data-ck="' + E(key) + '" data-ckname="' + E(name) + '" data-ckdir="' + (isDir ? 1 : 0) + '">';
}

function paintSel(){
  var boxes = document.querySelectorAll('input.ck');
  for (var i = 0; i < boxes.length; i++){
    var on = !!state.sel[boxes[i].getAttribute('data-ck')];
    if (boxes[i].checked !== on) boxes[i].checked = on;
    var tr = boxes[i].closest('tr');
    if (tr) tr.classList[on ? 'add' : 'remove']('picked');
  }
}

function syncSelection(){
  var bar = document.getElementById('batch');
  if (!bar) return;                       // 只读分享页没有批量条
  var n = selCount();
  document.getElementById('batchInfo').textContent =
    state.multi ? ('多选模式 · 已选 ' + n + ' 项') : ('已选 ' + n + ' 项');
  // 「全选本页」按当前状态换文案，兼作"反选"的入口（先全选、再取消掉不要的几项）
  var ba = document.getElementById('batchAll');
  if (ba){
    var all = state.folders.length + state.files.length;
    ba.textContent = (all > 0 && n >= all) ? '取消全选' : '全选本页';
  }
  // 多选模式下这个按钮的语义是"退出多选"，写「完成」比「取消选择」更贴用户直觉
  var bc = document.getElementById('batchClear');
  if (bc) bc.textContent = state.multi ? '完成' : '取消选择';
  if ((n > 0 || state.multi) && !RO && state.view === 'list'){
    bar.classList.add('on');
    document.body.classList.add('has-batch');
  } else {
    bar.classList.remove('on');
    document.body.classList.remove('has-batch');
  }
}

function clearSel(){ state.sel = {}; paintSel(); syncSelection(); }
function selectAll(){
  for (var i = 0; i < state.folders.length; i++) state.sel[selKey(state.folders[i], true)] = { path: joinPath(state.path, state.folders[i]), isDir: true };
  for (var j = 0; j < state.files.length; j++) state.sel[selKey(state.files[j].name, false)] = { path: joinPath(state.path, state.files[j].name), isDir: false };
  paintSel(); syncSelection();
}

// ===== 多选模式 =====
// 桌面靠"框选 + Shift 连选"；触屏上手指拖拽天生就是滚页面（拖框根本不成立，
// 硬做会和滚动打架），所以移动端改用【长按任意一行 → 进入多选模式 → 之后点哪行就勾哪行】。
// 这比框选更贴合手指的操作习惯，也不用非得戳中那个小方框。
function enterMulti(){
  if (RO || state.multi) return;
  state.multi = true;
  document.body.classList.add('multi');
  syncSelection();
}
function exitMulti(){
  if (state.multi){
    state.multi = false;
    document.body.classList.remove('multi');
  }
  clearSel();
}
// 把某一行设成"选中 / 未选中"（不派发 change，避免与原生勾选双触发）
function rowPick(tr, on){
  if (!tr || !tr.querySelector) return false;
  var cb = tr.querySelector('input.ck');
  if (!cb) return false;
  var key = cb.getAttribute('data-ck');
  cb.checked = !!on;
  state.lastPick = key;
  if (on) {
    state.sel[key] = { path: joinPath(state.path, cb.getAttribute('data-ckname')),
                       isDir: cb.getAttribute('data-ckdir') === '1' };
  } else {
    delete state.sel[key];
  }
  tr.classList[on ? 'add' : 'remove']('picked');
  syncSelection();
  return true;
}
// 多选模式下"点整行"= 勾选 / 取消
function toggleRowPick(tr){
  if (!tr || !tr.querySelector) return false;
  var cb = tr.querySelector('input.ck');
  if (!cb) return false;
  var on = !state.sel[cb.getAttribute('data-ck')];
  rowPick(tr, on);
  // 取消掉最后一个选中项就自动退出多选模式 —— 省得用户再去点一次「完成」
  if (state.multi && !selCount()) exitMulti();
  return true;
}
// ===== 触屏长按 = 进入多选 =====
// 按住 380ms 不动即触发；中途划动超过 10px 视为"想滚动"，立刻取消。
var lp = null;
function lpEnd(){
  if (lp && lp.timer) clearTimeout(lp.timer);
  lp = null;
  window.removeEventListener('pointermove', lpMove);
  window.removeEventListener('pointerup', lpEnd);
  window.removeEventListener('pointercancel', lpEnd);
}
function lpMove(e){
  if (!lp) return;
  if (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10) lpEnd();
}
function lpStart(e){
  if (RO || state.view !== 'list') return;
  var t = e.target;
  if (!t || !t.closest) return;
  // 注意：这里**不能排除 a** —— 移动端一行里大部分面积就是文件名那个链接，
  // 排掉它等于"长按文件名没反应"。真正要排除的是按钮/输入框/操作区这些控件。
  if (t.closest('button,input,select,label,option,#list .ops')) return;
  var tr = t.closest('#list tbody tr');
  if (!tr || !tr.querySelector('input.ck')) return;
  lpEnd();
  lp = { x: e.clientX, y: e.clientY, tr: tr, timer: setTimeout(function(){
    var row = lp ? lp.tr : tr;
    lpEnd();
    // 手指抬起后浏览器还会补一次 click，就落在"被长按的这一行"上。
    // 不吞掉的话，这次 click 会被下面的"多选模式点行"接走，正好把刚选中的行又取消
    // —— 用户看到的现象是"长按了但没选上"。
    // 只吞"这一行"的、且只在很短的窗口内（真实补发是紧跟着 pointerup 的），
    // 否则会连用户随后点的「重命名」等按钮一起吃掉，变成"点了没反应"。
    var cb0 = row && row.querySelector ? row.querySelector('input.ck') : null;
    state.suppressRowKey = cb0 ? cb0.getAttribute('data-ck') : '';
    state.suppressClickUntil = Date.now() + 400;
    enterMulti();
    rowPick(row, true);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (x) {}
  }, 380) };
  window.addEventListener('pointermove', lpMove);
  window.addEventListener('pointerup', lpEnd);
  window.addEventListener('pointercancel', lpEnd);
}

// 触屏上"长按进多选"没有可见的按钮，第一次进列表时提示一次。
// 用一次性提示而不是常驻按钮：常驻按钮会和长按完全重复，
// 还会把每行操作区从 6 个挤到 7 个 —— 手机上本来就已经很挤了。
var lpTipShown = false;
var LP_TIP_KEY = 'cfwtxt_lptip';
function lpTipOnce(){
  if (lpTipShown) return;
  var coarse = false;
  try { coarse = !!(window.matchMedia && matchMedia('(hover:none) and (pointer:coarse)').matches); } catch (e) {}
  if (!coarse) return;                       // 桌面有框选和 Shift 连选，不用提示
  lpTipShown = true;
  var seen = false;
  try { seen = localStorage.getItem(LP_TIP_KEY) === '1'; } catch (e) {}
  if (seen) return;
  setTimeout(function(){
    toast('小提示：长按任意一行可进入多选模式');
    try { localStorage.setItem(LP_TIP_KEY, '1'); } catch (e) {}
  }, 1500);
}

// ===== 全局点击：全部走事件委托 =====
document.addEventListener('change', function(ev){
  var c = ev.target;
  if (!c || !c.getAttribute || !c.getAttribute('data-ck')) return;
  var key = c.getAttribute('data-ck');
  state.lastPick = key;                    // 供 Shift+点击做区间连选
  if (c.checked) {
    state.sel[key] = { path: joinPath(state.path, c.getAttribute('data-ckname')), isDir: c.getAttribute('data-ckdir') === '1' };
  } else {
    delete state.sel[key];
  }
  var tr = c.closest('tr');
  if (tr) tr.classList[c.checked ? 'add' : 'remove']('picked');
  syncSelection();
  // 多选模式下取消掉最后一个，就退出多选模式（和点整行取消的行为保持一致）
  if (state.multi && !selCount()) exitMulti();
});

document.addEventListener('click', function(ev){
  var t = ev.target;
  var pick = function(sel){ return t.closest ? t.closest(sel) : null; };

  // 表头点击排序（再点一次切换升降序）
  var sth = pick('#list thead th[data-sortby]');
  if (sth){ ev.preventDefault(); setSort(sth.getAttribute('data-sortby'), null); return; }

  // 长按刚触发那一瞬，手指抬起还会补一次 click（落在被长按的那一行上）。
  // 不吞掉的话，这次 click 会被下面的"多选模式点行"接走，
  // 正好把刚选中的行又取消 —— 用户看到的就是"长按了但没选上"。
  // 三个条件同时满足才吞：① 时间窗口内（真实补发紧跟 pointerup）
  // ② 落在被长按的同一行 ③ 没点在按钮上（否则用户随后点「重命名」也会被吃掉）
  if (state.suppressClickUntil){
    var supTr = pick('#list tbody tr');
    var supCb = (supTr && supTr.querySelector) ? supTr.querySelector('input.ck') : null;
    var sameRow = !!(supCb && supCb.getAttribute('data-ck') === state.suppressRowKey);
    var inWindow = Date.now() < state.suppressClickUntil;
    var onControl = !!pick('button,input,select,label,option');
    state.suppressClickUntil = 0;
    if (inWindow && sameRow && !onControl){
      state.suppressRowKey = '';
      ev.preventDefault();
      return;
    }
  }

  // 多选模式：点整行 = 勾选 / 取消（不再打开文件）
  // 点在复选框上的不接管 —— 那是原生勾选，交给 change 事件；
  // 点在行内任何按钮（如 ⋯ 操作菜单）上的也不接管，按钮该干自己的活。
  if (state.multi && !RO && state.view === 'list'){
    var mtr = pick('#list tbody tr');
    if (mtr && !pick('#list input.ck') && !pick('#list button')){
      ev.preventDefault();
      toggleRowPick(mtr);
      return;
    }
  }

  // Shift + 点击勾选框 = 从上次点到这次之间整段选中
  var ckb = pick('#list input.ck');
  if (ckb && ev.shiftKey && state.lastPick){
    ev.preventDefault();
    var shiftKey = ckb.getAttribute('data-ck');
    if (rangeSelect(shiftKey)){
      // 关键：勾选框的"激活"发生在 click 派发**之前**。我们 preventDefault 取消 click 后，
      // 浏览器会执行"取消后的激活行为"，把被点那一个恢复成点击前的值 ——
      // 正好把 rangeSelect 刚设好的勾选抹掉（现象：选中集有 N 项，但只有 N-1 个勾上）。
      // 所以等这一轮事件彻底走完，再按 state.sel 重刷一遍。
      setTimeout(function(){ paintSel(); syncSelection(); }, 0);
      return;
    }
  }

  // 侧栏"按内容自适应宽度"
  var fitw = pick('[data-fitw]');
  if (fitw){ ev.preventDefault(); toast('已按内容自适应到 ' + fitSideW() + 'px'); return; }

  var ci = pick('#ctx .ci');
  if (ci){
    ev.preventDefault();
    var cmd = ci.getAttribute('data-cmd');
    var cpath = ci.getAttribute('data-cp');
    var cdir = ci.getAttribute('data-cdir') === '1';
    closeCtx();
    runCtx(cmd, cpath, cdir);
    return;
  }

  var tac = pick('[data-tact]');
  if (tac){
    ev.preventDefault();
    if (ctxEl && ctxEl.__owner === tac){ closeCtx(); return; }
    openCtxAt(tac);
    return;
  }

  // 目录树里的 🔗（已分享标记）：必须抢在整行 data-goto / data-openpath 之前，
  // 否则点图标会变成"进入目录 / 打开文件"。
  var shgo = pick('[data-shgo]');
  if (shgo){
    ev.preventDefault();
    closeCtx();
    openSharedLink(shgo.getAttribute('data-shgo') || '');
    return;
  }
  closeCtx();

  var all = pick('[data-treeall]');
  if (all){ treeAll(all.getAttribute('data-treeall') === '1'); return; }

  var car = pick('[data-tog]');
  if (car){ ev.preventDefault(); toggleNode(car.getAttribute('data-tog')); return; }

  var gt = pick('[data-goto]');
  if (gt){ ev.preventDefault(); load(gt.getAttribute('data-goto') || ''); document.body.classList.remove('side-open'); return; }

  // 行内按钮必须先于整行判定 —— 搜索结果行本身带 data-openpath，
  // 若先判整行，「⋯」永远会被"打开文件"抢走。
  var sac = pick('[data-sact]');
  if (sac){
    ev.preventDefault();
    if (ctxEl && ctxEl.__owner === sac){ closeCtx(); return; }
    openCtxAt(sac, true);
    return;
  }

  // 结果筛选芯片：只看文件名 / 路径 / 正文 / 文件夹
  var ftc = pick('[data-ftype]');
  if (ftc){ ev.preventDefault(); setSrFilter(ftc.getAttribute('data-ftype') || ''); return; }
  // 「返回搜索结果」条
  var srb = pick('[data-srback]');
  if (srb){ ev.preventDefault(); restoreSearch(); return; }
  var srbx = pick('[data-srbackx]');
  if (srbx){ ev.preventDefault(); dismissRestore(); return; }

  // 深搜结果弹窗里的某一行 → 打开文件并跳到那一行
  var dlr0 = pick('.dlrow');
  if (dlr0){
    ev.preventDefault();
    var dlp0 = dlr0.getAttribute('data-dl') || '';
    var dln0 = parseInt(dlr0.getAttribute('data-line'), 10) || 1;
    pendingGoLine = dln0;
    closeModal();
    var segs0 = dlp0.split('/');
    var nm0 = segs0.pop();
    var dd0 = segs0.join('/');
    if (RO) openViewer(dlp0);
    else if (state.path === dd0 && state.view === 'list') openFile(nm0);
    else load(dd0).then(function(){ openFile(nm0); });
    return;
  }

  var op = pick('[data-openpath]');
  if (op){
    ev.preventDefault();
    var p = op.getAttribute('data-openpath');
    // 搜索结果里的「文件夹」条目：点击直接进入该目录
    if (op.getAttribute('data-isdir') === '1'){
      load(p);
      document.body.classList.remove('side-open');
      return;
    }
    openPath(p);
    return;
  }

  var so = pick('[data-open]');
  if (so){
    ev.preventDefault();
    var nm = so.getAttribute('data-open');
    if (so.getAttribute('data-type') === 'dir') load(joinPath(state.path, nm));
    else openFile(nm);
    return;
  }

  var nav = pick('a[data-nav]');
  if (nav){ ev.preventDefault(); load(nav.getAttribute('data-nav')); return; }

  // ---- 渲染层与编辑器增强的委托入口 ----
  var em = pick('[data-emode]');
  if (em){ ev.preventDefault(); edSetPreview(em.getAttribute('data-emode') === 'prev'); return; }

  var vm = pick('[data-vmode]');
  if (vm){
    ev.preventDefault();
    var want = vm.getAttribute('data-vmode');
    if (want === 'rich') viewerRenderNow();     // 大文件按需渲染：点「渲染」才建 iframe
    viewerState.mode = want;
    applyViewerMode();
    return;
  }

  var ol = pick('[data-oline]');
  if (ol){ ev.preventDefault(); editorGoLine(parseInt(ol.getAttribute('data-oline'), 10) || 0); return; }

  var mg = pick('[data-mdgo]');
  if (mg){
    ev.preventDefault();
    var anchor = document.getElementById(mg.getAttribute('data-mdgo'));
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  var cth = pick('table.csv th[data-col]');
  if (cth){ ev.preventDefault(); csvSort(cth); return; }

  // JSON 折叠树的展开/收起
  var jtg = pick('.jtTog[data-jt]');
  if (jtg){
    ev.preventDefault();
    var kid = document.getElementById(jtg.getAttribute('data-jt'));
    if (kid){
      var hid = kid.classList.toggle('hide');
      jtg.textContent = hid ? '+' : '-';
    }
    return;
  }

  var mv = pick('[data-mvgo]');
  if (mv){ if (!mvState) return; mvState.dir = mv.getAttribute('data-mvgo'); renderMove(); return; }

  var bm = pick('[data-bmvgo]');
  if (bm){ bmvDir = bm.getAttribute('data-bmvgo'); renderBatchMove(); return; }

  var sbtn = pick('button[data-act]');
  if (sbtn){
    var act = sbtn.getAttribute('data-act');
    var name = sbtn.getAttribute('data-name');
    var isDir = sbtn.getAttribute('data-dir') === '1';
    if (act === 'download') {
      if (isDir) { toast('文件夹暂不支持打包下载'); return; }
      location.href = dlUrl(name);
    } else if (act === 'edit') { openFile(name); }
    else if (act === 'preview') { openMediaModal(joinPath(state.path, name), name); }
    else if (act === 'share') { openShareModal(joinPath(state.path, name), isDir); }
    else if (act === 'rename') { openRename(joinPath(state.path, name), isDir); }
    else if (act === 'move') { openMove(joinPath(state.path, name), isDir); }
    else if (act === 'del') { doDelete(joinPath(state.path, name), isDir); }
    return;
  }

  var sh = pick('button[data-shopen]');
  if (sh){ window.open(sh.getAttribute('data-shopen'), '_blank'); return; }
  var sl = pick('button[data-shlocate]');
  if (sl){
    locateShared(sl.getAttribute('data-shlocate'), sl.getAttribute('data-shlocdir') === '1');
    return;
  }
  var sc = pick('button[data-shcopy]');
  if (sc){ copyText(sc.getAttribute('data-shcopy')); return; }
  var sp = pick('button[data-shpub]');
  if (sp){ doPublish(sp.getAttribute('data-shpub'), sp.getAttribute('data-shdir') === '1'); return; }
  var su = pick('button[data-shunpub]');
  if (su){ doUnpublish(su.getAttribute('data-shunpub'), su.getAttribute('data-shdir') === '1'); return; }
  var spa = pick('button[data-shpuball]');
  if (spa){ doPublishAll(); return; }
  var sd = pick('button[data-shdel]');
  if (sd){
    var delToken = sd.getAttribute('data-shdel');
    post({ action: 'unshare', token: delToken }).then(function(d){
      if (!d.ok) throw new Error(d.error);
      // 同创建一样：KV 删除有延迟，乐观移除，界面上立刻消失
      shareCache.pending = shareCache.pending.filter(function(p){ return p.token !== delToken; });
      if (shareCache.removed.indexOf(delToken) < 0) shareCache.removed.push(delToken);
      shareCache.byPath = buildShareIndex(shareListMerged());
      applyShareUi();
      toast('已取消该分享链接');
      reloadShares();
    }).catch(function(e){ toast('取消失败：' + e.message); });
    return;
  }

  var gen = pick('button[data-shgen]');
  if (gen){
    var root = gen.closest('.share-root');
    doShare(root.getAttribute('data-target'), root.getAttribute('data-isdir') === '1', root);
    return;
  }
  var cp = pick('button[data-shresultcopy]');
  if (cp){ copyText(cp.getAttribute('data-shresultcopy')); return; }
  var lb = pick('input[data-linkbox]');
  if (lb){
    try { lb.focus(); lb.select(); lb.setSelectionRange(0, lb.value.length); } catch (e) {}
    copyText(lb.value);
    return;
  }
});

// ================= 统一渲染层 =================
// 把"打开文件后怎么显示"从"一律塞进 <pre>"改成"按类型分派到对应渲染器"。
// 两条硬约定：
//   1) 所有渲染器都先做 HTML 转义，只输出我们自己生成的标签 —— 没有原始 HTML 透传，杜绝 XSS；
//   2) 任何解析失败一律退回纯文本，所以最差情况就是原来的效果，不会出现"打不开的文件"。
var CH_BT = String.fromCharCode(96);        // 反引号（模板字符串里不能出现裸反引号，统一走常量）
var CH_BS = String.fromCharCode(92);        // 反斜杠（同理：源码里写 '\\' 会被模板字符串吞成一个反斜杠，
                                            // 导致字符串字面量未闭合，所以一律用字符码比较）
// Markdown 允许用反斜杠转义的标点集合。用字符码建表，彻底绕开转义问题。
var MD_ESC = (function(){
  var s = '!"#$%&()*+,-./:;<=>?@[]^_{|}~' + CH_BT + CH_BS;
  var o = {};
  for (var i = 0; i < s.length; i++) o[s.charCodeAt(i)] = 1;
  return o;
})();

function extOf(name){
  var s = String(name || '');
  var i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
}
function isWs(c){ var k = c.charCodeAt(0); return k === 32 || k === 9 || k === 10 || k === 13; }
// 去左空白。故意用扫描而不是 /^\s+/ —— 这段代码在模板字符串里，
// 正则的 \s 会被模板字符串吃掉变成 s，那就成了"把开头的 s 删掉"，是个很隐蔽的 bug。
function ltrim(s){
  var i = 0;
  while (i < s.length && isWs(s.charAt(i))) i++;
  return i ? s.slice(i) : s;
}
function startsAt(s, i, t){
  if (i + t.length > s.length) return false;
  for (var k = 0; k < t.length; k++) if (s.charCodeAt(i + k) !== t.charCodeAt(k)) return false;
  return true;
}
function kwSet(str){ var o = {}, a = String(str).split(' '); for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1; return o; }

// ---- 类型分派表：扩展名 → 渲染器（Markdown 只是其中一格）----
var KIND_BY_EXT = {
  md: 'md', markdown: 'md', mdx: 'md', rst: 'md', adoc: 'md', asciidoc: 'md', org: 'md',
  json: 'json', json5: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
  csv: 'csv', tsv: 'csv', psv: 'csv',
  svg: 'svg', html: 'html', htm: 'html', xhtml: 'html',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp3: 'av', wav: 'av', ogg: 'av', m4a: 'av', flac: 'av', aac: 'av', mp4: 'av', webm: 'av', mov: 'av', m4v: 'av', mkv: 'av',
  pdf: 'pdf'
};
// 能直接看到的东西（不需要下载）—— 决定列表里给「预览」还是「下载」
var PREVIEW_KINDS = { image: 1, av: 1, pdf: 1, svg: 1, html: 1, md: 1, json: 1, csv: 1, code: 1, text: 1 };

function kindOf(name, ct){
  var ext = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (c.indexOf('image/') === 0) return 'image';
  if (c.indexOf('video/') === 0 || c.indexOf('audio/') === 0) return 'av';
  if (c === 'application/pdf') return 'pdf';
  if (c.indexOf('text/html') === 0) return 'html';
  if (c.indexOf('image/svg') === 0) return 'svg';
  if (c === 'application/json' || c.indexOf('+json') > 0) return 'json';
  if (HL_SPECS[hlLangOf(ext)]) return 'code';
  return 'text';
}

// ---- 语法高亮 ----
// 手写扫描器而不是正则：模板字符串会吃掉正则里的反斜杠，这是本项目最容易踩的坑，
// 干脆一个正则都不用，全走 charCodeAt / indexOf。
var HL_SPECS = {
  js:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('var let const function return if else for while do break continue new delete typeof instanceof in of class extends super this null undefined true false try catch finally throw switch case default import export from async await yield static get set void with debugger interface type enum implements public private protected readonly declare namespace module') },
  json:{ lc: [], bc: [], str: ['"'], kw: kwSet('true false null') },
  py:  { lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal del assert in is not and or None True False async await print self') },
  go:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('package import func var const type struct interface map chan go defer return if else for range break continue switch case default select nil true false make new len cap append copy delete panic recover string int int64 float64 bool byte rune error') },
  rs:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('fn let mut const struct enum impl trait pub use mod match if else for while loop break continue return self Self super where as dyn ref move async await unsafe static type crate box true false Some None Ok Err String Vec') },
  java:{ lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('public private protected class interface extends implements new return if else for while do break continue switch case default try catch finally throw throws static final void int long double float boolean char byte short String import package this super null true false abstract synchronized instanceof enum record var') },
  c:   { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('int long short char float double void struct union enum typedef static const unsigned signed return if else for while do break continue switch case default goto sizeof extern register volatile inline NULL true false class public private protected namespace template typename using new delete this nullptr auto') },
  css: { lc: [], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('important media supports keyframes import charstate font-face from to unset inherit initial revert var calc rgb rgba hsl hsla linear-gradient') },
  sh:  { lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('if then else elif fi for while do done case esac function return export local readonly declare unset shift source alias set cd echo printf read exit test trap eval exec sudo') },
  sql: { lc: ['--'], bc: [['/*', '*/']], str: ["'", '"'], kw: kwSet('select from where insert update delete create drop alter table view index into values set join left right inner outer on group by having order limit offset union all distinct as and or not null is in like between count sum avg min max case when then else end primary key foreign references default unique constraint begin commit rollback'), ci: true },
  yaml:{ lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('true false null yes no on off') },
  toml:{ lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('true false') },
  ini: { lc: ['#', ';'], bc: [], str: ['"', "'"], kw: kwSet('true false') },
  md:  { lc: [], bc: [], str: ['"', "'", CH_BT], kw: kwSet('') },
  _:   { lc: ['//', '#'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('true false null if else for while return function class new import export') }
};
var HL_ALIAS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  json: 'json', json5: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', ipynb: 'json',
  py: 'py', pyw: 'py', rb: 'py', pl: 'py', php: 'py', lua: 'py',
  go: 'go', mod: 'go',
  rs: 'rs',
  java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', gradle: 'java', cs: 'java', swift: 'java', dart: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', go_h: 'c',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ksh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh', psm1: 'sh', psd1: 'sh',
  sql: 'sql', graphql: 'sql', gql: 'sql', proto: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', config: 'ini', properties: 'ini', env: 'ini',
  dockerfile: 'sh', makefile: 'sh', cmake: 'sh', mk: 'sh', tf: 'sh', tfvars: 'sh', hcl: 'sh', nix: 'sh', service: 'ini', desktop: 'ini',
  md: 'md', markdown: 'md', mdx: 'md', txt: 'text'
};
function hlLangOf(ext){
  var l = HL_ALIAS[String(ext || '').toLowerCase()];
  return l === 'text' ? '' : (l || '');
}

function hlEscapeCh(c){ return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c; }

function hlCode(src, lang){
  var spec = HL_SPECS[lang] || HL_SPECS._;
  var out = [], i = 0, n = src.length;
  var lc = spec.lc || [], bc = spec.bc || [], sq = spec.str || [];
  while (i < n){
    var c = src.charAt(i);
    var hitLc = null;
    for (var a = 0; a < lc.length; a++) if (startsAt(src, i, lc[a])) { hitLc = lc[a]; break; }
    if (hitLc){
      var le = src.indexOf('\\n', i);
      if (le < 0) le = n;
      out.push('<span class="tk-c">' + E(src.slice(i, le)) + '</span>');
      i = le; continue;
    }
    var hitBc = null;
    for (var b = 0; b < bc.length; b++) if (startsAt(src, i, bc[b][0])) { hitBc = bc[b]; break; }
    if (hitBc){
      var ce = src.indexOf(hitBc[1], i + hitBc[0].length);
      var bend = ce < 0 ? n : ce + hitBc[1].length;
      out.push('<span class="tk-c">' + E(src.slice(i, bend)) + '</span>');
      i = bend; continue;
    }
    if (sq.indexOf(c) >= 0){
      var q = c, j = i + 1;
      while (j < n){
        var cj = src.charAt(j);
        if (cj.charCodeAt(0) === 92) { j += 2; continue; }
        if (cj === q) { j++; break; }
        if (cj === '\\n' && q !== CH_BT) break;
        j++;
      }
      if (j > n) j = n;
      out.push('<span class="tk-s">' + E(src.slice(i, j)) + '</span>');
      i = j; continue;
    }
    var k1 = c.charCodeAt(0);
    if (k1 >= 48 && k1 <= 57){
      var pk = src.charCodeAt(i - 1);
      var prevWord = (pk >= 48 && pk <= 57) || (pk >= 65 && pk <= 90) || (pk >= 97 && pk <= 122) || pk === 95 || pk === 36;
      if (!prevWord){
        var kk = i;
        while (kk < n){
          var ck = src.charAt(kk), nk = ck.charCodeAt(0);
          var isNum = (nk >= 48 && nk <= 57) || (nk >= 65 && nk <= 70) || (nk >= 97 && nk <= 102) ||
            ck === '.' || ck === '_' || ck === 'x' || ck === 'X' || ck === '+' || ck === '-';
          if (!isNum) break;
          kk++;
        }
        out.push('<span class="tk-n">' + E(src.slice(i, kk)) + '</span>');
        i = kk; continue;
      }
    }
    var isWordStart = (k1 >= 65 && k1 <= 90) || (k1 >= 97 && k1 <= 122) || k1 === 95 || k1 === 36;
    if (isWordStart){
      var m = i;
      while (m < n){
        var cm = src.charCodeAt(m);
        if ((cm >= 48 && cm <= 57) || (cm >= 65 && cm <= 90) || (cm >= 97 && cm <= 122) || cm === 95 || cm === 36) m++;
        else break;
      }
      var word = src.slice(i, m);
      var lw = spec.ci ? word.toLowerCase() : word;
      if (spec.kw && spec.kw[lw]) out.push('<span class="tk-k">' + E(word) + '</span>');
      else out.push(E(word));
      i = m; continue;
    }
    out.push(hlEscapeCh(c));
    i++;
  }
  return out.join('');
}

// HTML / XML 单独一套：标签名与属性名上色，属性值当字符串
function hlHtmlTag(tag){
  var out = '<span class="tk-p">&lt;</span>';
  var i = 1, n = tag.length;
  if (tag.charAt(1) === '/'){ out += '<span class="tk-p">/</span>'; i = 2; }
  var s0 = i;
  while (i < n && !isWs(tag.charAt(i)) && tag.charAt(i) !== '>' && tag.charAt(i) !== '/') i++;
  if (i > s0) out += '<span class="tk-k">' + E(tag.slice(s0, i)) + '</span>';
  while (i < n){
    var c = tag.charAt(i);
    if (c === '>'){ out += '<span class="tk-p">&gt;</span>'; i++; continue; }
    if (c === '/'){ out += '<span class="tk-p">/</span>'; i++; continue; }
    if (c === '='){ out += '<span class="tk-p">=</span>'; i++; continue; }
    if (isWs(c)){ out += c; i++; continue; }
    if (c === '"' || c === "'"){
      var q = c, j = i + 1;
      while (j < n && tag.charAt(j) !== q) j++;
      j = Math.min(n, j + 1);
      out += '<span class="tk-s">' + E(tag.slice(i, j)) + '</span>';
      i = j; continue;
    }
    var s1 = i;
    while (i < n && !isWs(tag.charAt(i)) && tag.charAt(i) !== '=' && tag.charAt(i) !== '>' && tag.charAt(i) !== '/') i++;
    if (i > s1) out += '<span class="tk-a">' + E(tag.slice(s1, i)) + '</span>';
    else { out += hlEscapeCh(c); i++; }
  }
  return out;
}
function hlHtml(src){
  var out = [], i = 0, n = src.length;
  while (i < n){
    if (startsAt(src, i, '<!--')){
      var e1 = src.indexOf('-->', i + 4);
      e1 = e1 < 0 ? n : e1 + 3;
      out.push('<span class="tk-c">' + E(src.slice(i, e1)) + '</span>');
      i = e1; continue;
    }
    if (src.charAt(i) === '<'){
      var gt = -1, q = '';
      for (var j = i + 1; j < n; j++){
        var cj = src.charAt(j);
        if (q){ if (cj === q) q = ''; continue; }
        if (cj === '"' || cj === "'"){ q = cj; continue; }
        if (cj === '>'){ gt = j; break; }
      }
      if (gt < 0){ out.push(E(src.slice(i))); break; }
      out.push(hlHtmlTag(src.slice(i, gt + 1)));
      i = gt + 1; continue;
    }
    out.push(hlEscapeCh(src.charAt(i)));
    i++;
  }
  return out.join('');
}

// 代码块统一出口：<pre><code> 包裹，带语言标记
function hlBlock(code, lang){
  var l = HL_ALIAS[String(lang || '').toLowerCase()];
  var body;
  if (l === 'html') body = hlHtml(code);
  else if (l && HL_SPECS[l]) body = hlCode(code, l);
  else body = E(code);
  return '<pre>' + (lang ? '<code data-lang="' + E(lang) + '">' : '<code>') + body + '</code></pre>';
}

// ---- Markdown ----
function safeUrl(u){
  var s = String(u == null ? '' : u).trim().replace(/^<|>$/g, '');
  if (!s) return '#';
  if (s.charAt(0) === '#') return s;
  if (s.charAt(0) === '/') return s;
  var lower = s.toLowerCase();
  if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0 || lower.indexOf('mailto:') === 0) return s;
  if (s.indexOf(':') >= 0) return '#';           // 挡掉 javascript: / data: 之类
  if (lower.indexOf('//') === 0) return '#';     // 协议相对 URL 也不放行
  return s;                                      // 相对路径
}

// 读 [text](url) —— i 指向 '['
function mdReadLink(s, i){
  if (s.charAt(i) !== '[') return null;
  var depth = 0, j = i;
  for (; j < s.length; j++){
    var c = s.charAt(j);
    if (c === '[') depth++;
    else if (c === ']'){ depth--; if (depth === 0) break; }
  }
  if (j >= s.length) return null;
  var text = s.slice(i + 1, j);
  if (s.charAt(j + 1) !== '(') return null;
  var d2 = 0, e = j + 1;
  for (; e < s.length; e++){
    var c2 = s.charAt(e);
    if (c2 === '(') d2++;
    else if (c2 === ')'){ d2--; if (d2 === 0) break; }
  }
  if (e >= s.length) return null;
  var url = s.slice(j + 2, e).trim();
  var sp = url.indexOf(' ');
  if (sp > 0) url = url.slice(0, sp);
  return { text: text, url: url, end: e + 1 };
}

function mdInline(raw){
  var out = '', i = 0, n = raw.length;
  while (i < n){
    var c = raw.charAt(i);
    if (c === CH_BS && i + 1 < n && MD_ESC[raw.charCodeAt(i + 1)]){
      out += E(raw.charAt(i + 1)); i += 2; continue;
    }
    if (c === CH_BT){
      var j = raw.indexOf(CH_BT, i + 1);
      if (j > i){ out += '<code>' + E(raw.slice(i + 1, j)) + '</code>'; i = j + 1; continue; }
    }
    if (c === '!' && raw.charAt(i + 1) === '['){
      var im = mdReadLink(raw, i + 1);
      if (im){ out += '<img src="' + E(safeUrl(im.url)) + '" alt="' + E(im.text) + '" loading="lazy">'; i = im.end; continue; }
    }
    if (c === '['){
      var lk = mdReadLink(raw, i);
      if (lk){ out += '<a href="' + E(safeUrl(lk.url)) + '" target="_blank" rel="noopener noreferrer">' + mdInline(lk.text) + '</a>'; i = lk.end; continue; }
    }
    if (c === '<'){
      var gt = raw.indexOf('>', i + 1);
      if (gt > i){
        var inner = raw.slice(i + 1, gt);
        if (inner.indexOf('http://') === 0 || inner.indexOf('https://') === 0){
          out += '<a href="' + E(safeUrl(inner)) + '" target="_blank" rel="noopener noreferrer">' + E(inner) + '</a>';
          i = gt + 1; continue;
        }
      }
      out += '&lt;'; i++; continue;
    }
    if (c === '*' || c === '_'){
      var dbl = raw.charAt(i + 1) === c;
      var tok = dbl ? c + c : c;
      var from = i + tok.length;
      var end = raw.indexOf(tok, from);
      if (end > from){
        out += (dbl ? '<strong>' : '<em>') + mdInline(raw.slice(from, end)) + (dbl ? '</strong>' : '</em>');
        i = end + tok.length; continue;
      }
    }
    if (c === '~' && raw.charAt(i + 1) === '~'){
      var e2 = raw.indexOf('~~', i + 2);
      if (e2 > i + 2){ out += '<del>' + mdInline(raw.slice(i + 2, e2)) + '</del>'; i = e2 + 2; continue; }
    }
    if (c === '&'){ out += '&amp;'; i++; continue; }
    if (c === '>'){ out += '&gt;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

// 表格分隔行：|---|---| 或 |:--:| 这种
function mdIsDelim(line){
  var s = line.trim();
  if (s.indexOf('-') < 0) return false;
  for (var i = 0; i < s.length; i++){
    var c = s.charAt(i);
    if (c !== '-' && c !== '|' && c !== ':' && c !== ' ') return false;
  }
  return true;
}
function mdCells(line){
  var s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function(x){ return x.trim(); });
}

function mdHtml(src){
  var lines = String(src == null ? '' : src).split('\\n');
  for (var z = 0; z < lines.length; z++){
    if (lines[z].charAt(lines[z].length - 1) === '\\r') lines[z] = lines[z].slice(0, -1);
  }
  var out = [], toc = [], usedIds = {};
  var i = 0, n = lines.length;

  function headingId(text, lv){
    var base = text.replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || ('h' + lv);
    var id = base, k = 1;
    while (usedIds[id]) { id = base + '-' + (k++); }
    usedIds[id] = 1;
    return id;
  }

  while (i < n){
    var line = lines[i];

    // 围栏代码块
    if (startsAt(ltrim(line), 0, CH_BT + CH_BT + CH_BT)){
      var indent = line.length - ltrim(line).length;
      var fenceChar = CH_BT;
      var rawHead = line.slice(indent);
      var k2 = 0;
      while (k2 < rawHead.length && rawHead.charAt(k2) === fenceChar) k2++;
      var info = rawHead.slice(k2).trim().split(' ')[0];
      var buf = [], closed = false;
      i++;
      while (i < n){
        var t2 = ltrim(lines[i]);
        if (startsAt(t2, 0, CH_BT + CH_BT + CH_BT)) { closed = true; i++; break; }
        buf.push(lines[i]); i++;
      }
      out.push(hlBlock(buf.join('\\n'), info));
      continue;
    }

    // 标题
    if (line.charAt(0) === '#'){
      var lv = 0;
      while (lv < 6 && line.charAt(lv) === '#') lv++;
      if (lv > 0 && (isWs(line.charAt(lv)) || line.charAt(lv) === '')){
        var htext = line.slice(lv).trim();
        var hid = headingId(htext, lv);
        toc.push({ lv: lv, text: htext, id: hid });
        out.push('<h' + lv + ' id="' + E(hid) + '">' + mdInline(htext) + '</h' + lv + '>');
        i++; continue;
      }
    }

    // 分割线
    var tl = line.trim();
    if (tl === '---' || tl === '***' || tl === '___'){
      out.push('<hr>'); i++; continue;
    }

    // 引用
    if (line.charAt(0) === '>' || (line.charAt(0) === ' ' && tl.charAt(0) === '>')){
      var qbuf = [];
      while (i < n && (lines[i].charAt(0) === '>' || ltrim(lines[i]).charAt(0) === '>')){
        var ql = ltrim(lines[i]);
        ql = ql.charAt(0) === '>' ? ql.slice(1) : ql;
        if (ql.charAt(0) === ' ') ql = ql.slice(1);
        qbuf.push(ql); i++;
      }
      out.push('<blockquote>' + mdHtml(qbuf.join('\\n')).html + '</blockquote>');
      continue;
    }

    // 表格
    if (line.indexOf('|') >= 0 && i + 1 < n && mdIsDelim(lines[i + 1])){
      var head = mdCells(line);
      i += 2;
      var rowsHtml = '';
      while (i < n && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rowsHtml += '<tr>' + mdCells(lines[i]).map(function(c){ return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; i++; }
      out.push('<table><thead><tr>' + head.map(function(c){ return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>');
      continue;
    }

    // 列表（含任务列表）
    var lm = ltrim(line);
    var lIndent = line.length - lm.length;
    var isUl = (lm.charAt(0) === '-' || lm.charAt(0) === '*' || lm.charAt(0) === '+') && isWs(lm.charAt(1));
    var olNum = 0, isOl = false;
    if (!isUl){
      var d = 0;
      while (d < lm.length && lm.charCodeAt(d) >= 48 && lm.charCodeAt(d) <= 57) d++;
      if (d > 0 && (lm.charAt(d) === '.' || lm.charAt(d) === ')') && isWs(lm.charAt(d + 1))){
        isOl = true; olNum = parseInt(lm.slice(0, d), 10) || 1;
      }
    }
    if (isUl || isOl){
      var items = [];
      var baseIndent = lIndent;
      while (i < n){
        var cur = lines[i];
        var curT = ltrim(cur);
        var curI = cur.length - curT.length;
        if (!curT) break;
        var curUl = (curT.charAt(0) === '-' || curT.charAt(0) === '*' || curT.charAt(0) === '+') && isWs(curT.charAt(1));
        var cd = 0;
        while (cd < curT.length && curT.charCodeAt(cd) >= 48 && curT.charCodeAt(cd) <= 57) cd++;
        var curOl = cd > 0 && (curT.charAt(cd) === '.' || curT.charAt(cd) === ')') && isWs(curT.charAt(cd + 1));
        if (!curUl && !curOl){
          // 续行：缩进比本级深就当上一项的延续
          if (curI > baseIndent && items.length) items[items.length - 1].raw.push(cur.slice(baseIndent));
          else break;
          i++; continue;
        }
        if (curI < baseIndent) break;
        var off = curUl ? 1 : cd + 1;
        items.push({ raw: [ltrim(curT.slice(off))], sub: curT.slice(off) });
        i++;
      }
      var lis = '';
      for (var x = 0; x < items.length; x++){
        var txt = items[x].raw.join('\\n');
        var task = null;
        if (startsAt(txt, 0, '[ ]')) task = false;
        else if (startsAt(txt, 0, '[x]') || startsAt(txt, 0, '[X]')) task = true;
        if (task !== null) txt = txt.slice(3).trim();
        var cls = task !== null ? ' class="task"' : '';
        var cb = task !== null ? '<input type="checkbox" disabled' + (task ? ' checked' : '') + '>' : '';
        lis += '<li' + cls + '>' + cb + mdInline(txt) + '</li>';
      }
      out.push(isOl ? '<ol start="' + olNum + '">' + lis + '</ol>' : '<ul>' + lis + '</ul>');
      continue;
    }

    // 空行
    if (!tl){ i++; continue; }

    // 段落（连续非空行合并）
    var pbuf = [];
    while (i < n){
      var pl = lines[i];
      var pt = pl.trim();
      if (!pt) break;
      if (pl.charAt(0) === '#' || pl.charAt(0) === '>') break;
      if (startsAt(ltrim(pl), 0, CH_BT + CH_BT + CH_BT)) break;
      if (pt === '---' || pt === '***' || pt === '___') break;
      var plm = ltrim(pl);
      if ((plm.charAt(0) === '-' || plm.charAt(0) === '*' || plm.charAt(0) === '+') && isWs(plm.charAt(1))) break;
      if (i + 1 < n && mdIsDelim(lines[i + 1]) && pl.indexOf('|') >= 0) break;
      pbuf.push(pt);
      i++;
    }
    if (pbuf.length) out.push('<p>' + pbuf.map(mdInline).join('<br>') + '</p>');
  }
  return { html: out.join('\\n'), toc: toc };
}

// ---- JSON 折叠树 ----
function jsonTreeHtml(val, depth){
  var d = depth || 0;
  if (val === null) return '<span class="jtNull">null</span>';
  var t = typeof val;
  if (t === 'string') return '<span class="jtStr">"' + E(val) + '"</span>';
  if (t === 'number') return '<span class="jtNum">' + E(String(val)) + '</span>';
  if (t === 'boolean') return '<span class="jtBool">' + val + '</span>';
  if (t !== 'object') return '<span class="jtStr">' + E(String(val)) + '</span>';

  var isArr = Object.prototype.toString.call(val) === '[object Array]';
  var keys = isArr ? null : Object.keys(val);
  var size = isArr ? val.length : keys.length;
  var open = isArr ? '[' : '{', close = isArr ? ']' : '}';
  if (!size) return '<span class="jtP">' + open + close + '</span>';

  var n = isArr ? size : keys.length;
  var h = '<span class="jtP">' + open + '</span><span class="jtSum"> ' + n + ' 项</span>';
  var kids = '';
  if (isArr){
    for (var i = 0; i < val.length; i++) kids += '<div class="jtRow">' + jsonTreeHtml(val[i], d + 1) + (i < val.length - 1 ? '<span class="jtP">,</span>' : '') + '</div>';
  } else {
    for (var k = 0; k < keys.length; k++){
      kids += '<div class="jtRow"><span class="jtKey">"' + E(keys[k]) + '"</span><span class="jtP">: </span>' +
        jsonTreeHtml(val[keys[k]], d + 1) + (k < keys.length - 1 ? '<span class="jtP">,</span>' : '') + '</div>';
    }
  }
  var id = 'jt' + (jtSeq++);
  var collapsed = d >= 2;
  return h +
    '<span class="jtTog" data-jt="' + id + '">' + (collapsed ? '+' : '-') + '</span>' +
    '<span class="jtP">' + close + '</span>' +
    '<div class="jtKids' + (collapsed ? ' hide' : '') + '" id="' + id + '">' + kids + '</div>';
}
var jtSeq = 1;
// CSV 表头排序：直接重排 DOM 行，不动数据，简单且够快
function csvSort(th){
  var table = th.closest ? th.closest('table') : null;
  if (!table || table.className.indexOf('csv') < 0) return;
  var col = parseInt(th.getAttribute('data-col'), 10);
  if (!(col >= 0)) return;
  var tbody = table.tBodies[0];
  if (!tbody) return;
  var rows = [].slice.call(tbody.rows);
  var asc = th.getAttribute('data-asc') !== '1';
  th.setAttribute('data-asc', asc ? '1' : '0');
  var numeric = true;
  for (var q = 0; q < rows.length; q++){
    var cell = rows[q].cells[col];
    var v = cell ? cell.textContent : '';
    if (v !== '' && isNaN(v)) { numeric = false; break; }
  }
  rows.sort(function(a, b){
    var x = a.cells[col] ? a.cells[col].textContent : '';
    var y = b.cells[col] ? b.cells[col].textContent : '';
    var r;
    if (numeric) r = (parseFloat(x) || 0) - (parseFloat(y) || 0);
    else r = x.localeCompare(y, 'zh');
    return asc ? r : -r;
  });
  for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
  toast('已按「' + th.textContent + '」' + (asc ? '升序' : '降序') + '排列');
}

// ---- CSV / TSV ----
function csvParse(text, delim){
  var rows = [], row = [], cur = '', i = 0, n = text.length, q = false;
  while (i < n){
    var c = text.charAt(i);
    if (q){
      if (c === '"'){
        if (text.charAt(i + 1) === '"'){ cur += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '"'){ q = true; i++; continue; }
    if (c === delim){ row.push(cur); cur = ''; i++; continue; }
    if (c === '\\n'){ row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
    if (c === '\\r'){ i++; continue; }
    cur += c; i++;
  }
  if (cur !== '' || row.length){ row.push(cur); rows.push(row); }
  return rows;
}
function csvTableHtml(text, delim, maxRows){
  var rows = csvParse(text, delim);
  if (!rows.length) return null;
  var cap = maxRows || 2000;
  var shown = rows.slice(0, cap);
  var head = shown[0] || [];
  var bodyRows = shown.slice(1);
  var h = '<div class="rawNote">共 <b>' + (rows.length - 1) + '</b> 行 · <b>' + head.length + '</b> 列' +
    (rows.length > cap ? '（为保证流畅只显示前 ' + cap + ' 行）' : '') + '　点表头可排序</div>';
  h += '<div class="csvWrap"><table class="csv"><thead><tr>';
  for (var c = 0; c < head.length; c++) h += '<th data-col="' + c + '">' + E(head[c]) + '</th>';
  h += '</tr></thead><tbody>';
  for (var r = 0; r < bodyRows.length; r++){
    h += '<tr>';
    for (var k = 0; k < head.length; k++){
      var v = bodyRows[r][k] == null ? '' : bodyRows[r][k];
      var isNum = v !== '' && !isNaN(v) && String(parseFloat(v)) === String(v).trim();
      h += '<td' + (isNum ? ' class="num"' : '') + '>' + E(v) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  return { html: h, rows: rows.length - 1, cols: head.length };
}

// ===== 渲染分派：把文本/字节交给正确的渲染器 =====
// HTML 预览用的 iframe 标签。Q 是单引号、IMG_SRC 是 data: 图片源 —— 都单独定义，
// 因为 appHtml 是模板字符串，源码里任何反斜杠转义写法都会被模板引擎吃掉，
// 把外层字符串提前截断（编译报 Unexpected string）。只能用变量拼接，彻底绕开转义。
var Q = String.fromCharCode(39);
var IMG_SRC = 'data:';
// 返回 { ok, html } —— ok=false 时调用方退回纯文本
function renderText(name, ct, text, docSrc){
  var kind = kindOf(name, ct);
  try {
    if (kind === 'md'){
      var r = mdHtml(text);
      return { ok: true, kind: kind, html: r.html, toc: r.toc };
    }
    if (kind === 'json'){
      var parsed = null, bad = false;
      try { parsed = JSON.parse(text); } catch (e) { bad = true; }
      if (bad || parsed === null || typeof parsed !== 'object'){
        // 可能是 jsonl/ndjson：逐行解析
        var lines = text.split('\\n'), objs = [], allOk = true;
        for (var i = 0; i < lines.length; i++){
          var ln = lines[i].trim();
          if (!ln) continue;
          try { objs.push(JSON.parse(ln)); } catch (e2) { allOk = false; break; }
        }
        if (!allOk || !objs.length) return { ok: false };
        parsed = objs;
      }
      jtSeq = 1;
      return { ok: true, kind: kind, html: '<div class="jt">' + jsonTreeHtml(parsed, 0) + '</div>' };
    }
    if (kind === 'csv'){
      var ex = extOf(name);
      var delim = ex === 'tsv' ? '\\t' : (ex === 'psv' ? '|' : ',');
      var t = csvTableHtml(text, delim, 2000);
      if (!t) return { ok: false };
      return { ok: true, kind: kind, html: t.html };
    }
    if (kind === 'code'){
      var lang = hlLangOf(extOf(name));
      if (!lang) return { ok: false };
      return { ok: true, kind: kind, html: hlBlock(text, extOf(name)) };
    }
    if (kind === 'html'){
      // 两种模式，都关在 sandbox iframe 里（不给 allow-scripts / allow-same-origin）：
      //   ① docSrc 有值 → iframe 直接加载服务端的"真文档"（/?doc=1，注入过 base）。
      //      相对路径这才解析得对，页面自己的 css / 图片能加载；**此时不能再挂 csp 属性** ——
      //      那会把 img-src 限死在 data:，连自己目录的图片一起挡掉（分享页踩过同一个坑）。
      //      脚本安全由 sandbox + 文档响应头里的 CSP 双重保证，与分享页完全一致。
      //   ② 没有 docSrc（老路径）→ 原文走 srcdoc，只能看到裸结构 + 内联样式。
      // 为什么必须 sandbox 而不是直接 innerHTML：innerHTML 插入的 <script> 虽然被主站
      // CSP 的 nonce 挡住，但 <img onerror> / <svg onload> 这类事件属性照样会执行 ——
      // 那就等于让别人的页面脚本跑在你的管理员会话里。
      if (docSrc){
        return {
          ok: true, kind: kind, docSrc: docSrc,
          html: '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"' +
                ' referrerpolicy="no-referrer" title="HTML 预览（隔离）" src="' + E(docSrc) + '"></iframe>',
          note: '这是<b>隔离预览</b>：页面脚本不会执行（防止上传的页面偷你的登录态）。' +
                '页面<b>自己的</b> css / 图片会正常加载，第三方外链不加载。'
        };
      }
      return {
        ok: true, kind: kind,
        // CSP 里的 none / unsafe-inline 需要单引号，但这段代码位于 appHtml 模板字符串里，
        // 源码里写反斜杠会被模板引擎吃掉、把外层字符串字面量提前截断（编译报 Unexpected
        // identifier）。项目约定：一律用 CH_BS 拼单引号，不在注释或字面量里写反斜杠。
        // 另外别把两个双引号字符串挨着写：前一段以双引号收尾、后一段以双引号开头时，
        // JS 会把它们看成同一个字符串，中间的内容就成了语法错误。
        html: '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"' +
              ' csp="default-src ' + Q + 'none' + Q + '; img-src ' + IMG_SRC + '; ' +
              'style-src ' + Q + 'unsafe-inline' + Q + '; font-src data:; ' +
              'form-action ' + Q + 'none' + Q + '; base-uri ' + Q + 'none' + Q +
              '; frame-src ' + Q + 'none' + Q + '"' +
              ' title="HTML 预览（隔离）"></iframe>',
        srcdoc: text,
        note: '这是<b>隔离预览</b>：页面脚本不会执行（防止上传的页面偷你的登录态），' +
              '所以需要外链 CSS / 图片 / JS 的页面只能看到裸结构。要看完整效果请下载后用浏览器打开。'
      };
    }
  } catch (e) {
    return { ok: false };
  }
  return { ok: false };
}

// 路径按段转义（保留 /，其余按需编码）—— 真文档 / 资源 URL 要用它拼
function encPath(p){
  return String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// 渲染进一个容器（Markdown 用）
function renderInto(box, name, ct, text, docSrc){
  var r = renderText(name, ct, text, docSrc);
  if (!r.ok){ box.hidden = true; return null; }
  box.innerHTML = r.html;
  box.hidden = false;
  // HTML 预览：单独设 class 是为了让 CSS 把容器的 padding 去掉、让 iframe 撑满 ——
  // 预览要尽量接近真实页面。docSrc 模式下由浏览器自己去加载，不是我们塞 srcdoc。
  if (r.srcdoc != null || r.docSrc){
    box.className = 'rBox htmlBox';
    var fr = box.querySelector('iframe');
    // 高度不靠脚本同步：sandbox 没给 allow-same-origin，子文档是跨源的，
    // contentDocument 一定读不到（之前那段 try/catch 永远走 catch，是死代码）。
    // iframe 用 flex:1 撑满容器，自身滚动 —— 和 PDF 预览一个思路，简单且可靠。
    if (fr){
      if (r.docSrc) fr.src = r.docSrc;      // 真文档：真实 URL 才解析得对相对路径
      else fr.srcdoc = r.srcdoc;
    }
    if (r.note) box.insertAdjacentHTML('beforeend', '<div class="htmlNote">' + r.note + '</div>');
  } else if (r.kind === 'md' && r.toc && r.toc.length >= 2){
    var t = '<div class="tocInline"><b>目录</b>';
    for (var i = 0; i < r.toc.length; i++){
      var it = r.toc[i];
      t += '<a href="#" data-mdgo="' + E(it.id) + '" class="lv' + it.lv + '">' + E(it.text) + '</a>';
    }
    t += '</div>';
    box.insertAdjacentHTML('afterbegin', t);
  }
  return r;
}

// ================= 编辑器增强（第二档）=================
// 行号槽 / 查找替换 / Markdown 大纲 / 字数统计 / 草稿自动保存 / 编辑快捷键。
// 一律做成"叠加增强"：任何一项失效都不影响原有的输入与保存流程。
var ED_BIG = 512 * 1024;        // 超过这个体积就关掉高亮与行号，优先保证不卡
var ED_DRAFT_MAX = 400 * 1024;  // 草稿体积上限（localStorage 总共就几 MB）

function edText(){ var t = document.getElementById('edt'); return t ? t.value : ''; }
function edIsBig(){ return edText().length > ED_BIG; }

// 把文本框的字体/内边距/滚动条宽度同步给镜像与高亮层。
// 不同步滚动条宽度的话，换行位置会和正文错开，行号与高亮就全歪了。
function mirrorSync(){
  var t = document.getElementById('edt');
  var m = document.getElementById('edMirror');
  if (!t || !m) return null;
  var cs = getComputedStyle(t);
  var lh = parseFloat(cs.lineHeight);
  if (!(lh > 0)) lh = (parseFloat(cs.fontSize) || 13) * 1.7;
  var sbw = t.offsetWidth - t.clientWidth;
  var padRight = 16 + (sbw > 0 ? sbw : 0);
  // 三个隐形层必须和文本框同字体、同内边距：镜像层量行高、量测层量网址坐标、高亮层叠在文字上
  ['edMirror', 'edMeasure', 'edHlIn'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    el.style.fontSize = cs.fontSize;
    el.style.lineHeight = cs.lineHeight;
    el.style.paddingRight = padRight + 'px';
  });
  return { t: t, m: m, lh: lh };
}

function gutScroll(){
  var t = document.getElementById('edt');
  var gi = document.getElementById('edGutterIn');
  if (!t || !gi) return;
  gi.style.transform = 'translateY(' + (-t.scrollTop) + 'px)';
}
function hlScroll(){
  var t = document.getElementById('edt');
  var inEl = document.getElementById('edHlIn');
  var icons = document.getElementById('edLinkIcons');
  if (!t) return;
  var tr = 'translate(' + (-t.scrollLeft) + 'px,' + (-t.scrollTop) + 'px)';
  if (inEl) inEl.style.transform = tr;
  if (icons) icons.style.transform = tr;   // 网址图标层跟着正文一起滚
}

// 行号槽：换行开启时逻辑行可能占多个视觉行，所以用镜像元素实测每行高度再定位，
// 这样行号永远贴在它那一行的第一视觉行上，不会因为折行而错位。
function syncGutter(){
  var g = document.getElementById('edGutter');
  var gi = document.getElementById('edGutterIn');
  var t = document.getElementById('edt');
  if (!g || !gi || !t || RO) return;
  var text = t.value;
  var lines = text.split('\\n');
  if (edIsBig() || lines.length > 4000 || !t.offsetWidth){
    g.hidden = true;
    t.classList.remove('withGut');
    gi.innerHTML = '';
    return;
  }
  var mm = mirrorSync();
  if (!mm) return;
  g.hidden = false;
  t.classList.add('withGut');

  var heights = null;
  if (wrapOn){
    var buf = '';
    for (var i = 0; i < lines.length; i++) buf += '<div>' + (lines[i] ? E(lines[i]) : '&nbsp;') + '</div>';
    mm.m.innerHTML = buf;
    var kids = mm.m.children;
    heights = [];
    for (var k = 0; k < kids.length; k++) heights.push(kids[k].offsetHeight);
  }
  var cur = -1;
  try { cur = text.slice(0, t.selectionStart).split('\\n').length - 1; } catch (e) {}

  var out = '', y = 14;
  var vis = mm.lh;
  for (var n = 0; n < lines.length; n++){
    var bh = heights ? (heights[n] || vis) : vis;
    out += '<div class="edGutNum' + (n === cur ? ' cur' : '') + '" style="top:' + y + 'px;height:' + bh +
      'px;line-height:' + vis + 'px">' + (n + 1) + '</div>';
    y += bh;
  }
  gi.innerHTML = out;
  gutScroll();
}

// ---- 查找替换 ----
// terms 不为空时是"从搜索结果带进来的高亮会话"：多个关键词各自扫描（AND 语义）、按词分色；
// 用户一旦在查找框里自己敲字，就退回普通单串查找（terms 置空）。
var findState = { open: false, q: '', case: false, re: false, terms: null, word: false };
var findHits = [], findAt = -1;

function updateFindStat(){
  var s = document.getElementById('fStat');
  if (!s) return;
  if (!findState.q){ s.textContent = '未查找'; return; }
  if (!findHits.length){ s.textContent = '无匹配'; return; }
  s.textContent = (findAt + 1) + ' / ' + findHits.length + ' 处';
}

// 整词模式（搜索框里写了 "cat"）下的词边界判断：cat 不该在 category 里点亮
function wordOkAt(text, start, end){
  var isW = function(c){ return !!c && /[0-9A-Za-z_]/.test(c); };
  if (isW(start > 0 ? text.charAt(start - 1) : '')) return false;
  if (isW(end < text.length ? text.charAt(end) : '')) return false;
  return true;
}

function findRun(keepAt){
  var t = document.getElementById('edt');
  if (!t || !findState.open) { findHits = []; findAt = -1; renderHl(); return; }
  findHits = [];
  if (!edIsBig()){
    var text = t.value;
    var terms = (findState.terms && findState.terms.length) ? findState.terms : null;
    if (terms){
      // 多关键词：逐词扫描，命中记下"属于第几个词"，供高亮层分色
      var hay = findState.case ? text : text.toLowerCase();
      for (var ti = 0; ti < terms.length; ti++){
        var raw = String(terms[ti] || '');
        var needle = findState.case ? raw : raw.toLowerCase();
        if (!needle) continue;
        var from = 0, guard = 0;
        while (guard++ < 4000){
          var k = hay.indexOf(needle, from);
          if (k < 0) break;
          if (!findState.word || wordOkAt(text, k, k + needle.length)) findHits.push({ start: k, end: k + needle.length, t: ti });
          from = k + Math.max(1, needle.length);
        }
      }
      findHits.sort(function(a, b){ return a.start - b.start || b.end - a.end; });
    } else {
      var q = findState.q;
      if (q){
        if (findState.re){
          try {
            var re = new RegExp(q, findState.case ? 'g' : 'gi');
            var m, guard3 = 0;
            while ((m = re.exec(text)) !== null && guard3++ < 4000){
              if (m[0] === ''){ re.lastIndex++; continue; }
              findHits.push({ start: m.index, end: m.index + m[0].length, t: 0 });
            }
          } catch (e) { findHits = []; }
        } else {
          var hay2 = findState.case ? text : text.toLowerCase();
          var needle2 = findState.case ? q : q.toLowerCase();
          var from2 = 0, guard2 = 0;
          while (guard2++ < 4000){
            var i2 = hay2.indexOf(needle2, from2);
            if (i2 < 0) break;
            findHits.push({ start: i2, end: i2 + needle2.length, t: 0 });
            from2 = i2 + Math.max(1, needle2.length);
          }
        }
      }
    }
  }
  if (!keepAt) findAt = findHits.length ? 0 : -1;
  if (findAt >= findHits.length) findAt = findHits.length - 1;
  updateFindStat();
  renderHl();
}

// ===== 正文里的完整网址：识别 + 可点击 =====
// 只认 http/https（裸 www. 自动补 https://）—— javascript: 之类的伪协议永远
// 不会被做成可点的链接。结尾的标点不算网址的一部分，否则"见 https://a.com。"
// 会把句号一起染进链接里。
// 模式串用字符码拼：模板字符串会把源码里的 '\' 和 '\'' 吞掉，直接写正则字面量会烂掉。
var URL_RE = new RegExp(CH_BS + 'b(?:https?://|www' + CH_BS + '.)[^' + CH_BS + 's<>' +
  String.fromCharCode(34, 39) + CH_BT + ']+', 'gi');
var ED_LINK_MAX = 256 * 1024;      // 超过这个体积就不在编辑器里画链接（重建覆盖层有成本）

// 网址结尾该丢掉的标点（ASCII + 全角）。用字符码建表 —— 源码里若写正则字面量，
// 模板字符串会吞掉反斜杠，导致字符类提前闭合、语义全变（结尾逗号就再也去不掉了）。
var URL_TAIL = (function(){
  var codes = [46, 44, 59, 58, 33, 63, 39, 34, 125, 62, 93,           // . , ; : ! ? ' " } > ]
    0x3002, 0xFF0C, 0xFF1B, 0xFF1A, 0xFF01, 0xFF1F, 0x3001,           // 。 ， ； ： ！ ？ 、
    0x300B, 0x300D, 0x3011, 0xFF09, 0x2019, 0x201D, 0x300F, 0x3009];  // 》 」 】 ） ’ ” 〗 〉
  var o = {};
  for (var i = 0; i < codes.length; i++) o[codes[i]] = 1;
  return o;
})();

function trimUrlEnd(u){
  var t = u;
  while (t.length && URL_TAIL[t.charCodeAt(t.length - 1)]) t = t.slice(0, -1);
  // 维基百科那种 .../foo_(bar)：只有右括号比左括号多时，末尾的 ) 才算标点
  while (t.charAt(t.length - 1) === ')'){
    var op = t.split('(').length - 1, cl = t.split(')').length - 1;
    if (cl > op) t = t.slice(0, -1); else break;
  }
  return t;
}
// 全角句读（。，；：！？、）绝不会出现在网址里。只靠"从尾部删标点"是不够的：
// "https://a.com/x。后文" 里那个句号不在结尾，整串会被当成一个网址、把后面中文也吃进去。
// 所以匹配到之后先在第一个全角句读处截断，再走尾部的 trimUrlEnd。
var URL_STOP = (function(){
  var codes = [0x3002, 0xFF0C, 0xFF1B, 0xFF1A, 0xFF01, 0xFF1F, 0x3001];
  var o = {};
  for (var i = 0; i < codes.length; i++) o[codes[i]] = 1;
  return o;
})();
function cutUrlAtStop(u){
  for (var i = 0; i < u.length; i++){ if (URL_STOP[u.charCodeAt(i)]) return u.slice(0, i); }
  return u;
}
function findLinks(text){
  var out = [];
  if (!text) return out;
  URL_RE.lastIndex = 0;
  var m, guard = 0;
  while ((m = URL_RE.exec(text)) !== null){
    if (guard++ > 1000) break;
    var raw = trimUrlEnd(cutUrlAtStop(m[0]));
    if (raw.length < 5) continue;
    out.push({ s: m.index, e: m.index + raw.length,
      href: raw.slice(0, 4).toLowerCase() === 'www.' ? 'https://' + raw : raw });
    if (raw.length < m[0].length) URL_RE.lastIndex = m.index + raw.length;   // 别把结尾标点再吃一遍
  }
  return out;
}

// 编辑器覆盖层：只画「查找命中」。网址不再铺底色 —— 改成在网址末尾挂图标（见 renderLinkIcons），
// 底色块一旦和文本框的子像素对不齐就会变成"贴了一层"的重影，图标没有这个问题。
// 命中区间按起点排好序后，用两个指针扫一遍端点即可。
function overlayHtml(text, hits, curIdx, multi){
  if (!hits.length) return E(text);
  hits.sort(function(a, b){ return a.start - b.start || b.end - a.end; });
  var pts = [0, text.length], i;
  for (i = 0; i < hits.length; i++){ pts.push(hits[i].start, hits[i].end); }
  pts.sort(function(a, b){ return a - b; });
  var out = '', hi = 0;
  for (i = 0; i < pts.length - 1; i++){
    var a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    var mid = (a + b) / 2;
    while (hi < hits.length && hits[hi].end <= mid) hi++;
    var seg = E(text.slice(a, b));
    var hh = (hi < hits.length && hits[hi].start <= mid && hits[hi].end > mid) ? hits[hi] : null;
    if (hh){
      out += '<span class="hmark' + (multi ? ' t' + ((hh.t || 0) % 3 + 1) : '') +
        (hh.i === curIdx ? ' cur' : '') + '">' + seg + '</span>';
      continue;
    }
    out += seg;
  }
  return out;
}

// 网址末尾那个小图标。同一份 SVG 给编辑器图标层和只读查看器共用。
var LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
var LINK_ICON_SIZE = 11;   // 与 .lnkico 的宽高一致
var LINK_ICON_RAISE = 4;   // 在"行内居中"的基础上再往上抬 4px，抬成上标，躲开后面那个字的字身
var ED_ICON_MAX = 200;     // 一屏之外也点不到，网址太多时只画前 N 个，省 DOM

function makeLinkIcon(href){
  var a = document.createElement('a');
  a.className = 'lnkico';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = '在新标签页打开 ' + href;
  a.setAttribute('aria-label', '打开网址 ' + href);
  a.innerHTML = LINK_ICON;
  return a;
}

// ---- 编辑器内网址的"快捷打开" ----
// 链接区间按正文内容缓存：光标每动一下都重扫一遍正文太浪费，而正文是不可变字符串，直接拿它当 key。
var linkCacheText = null, linkCacheList = [];
function editorLinks(text){
  if (linkCacheText === text) return linkCacheList;
  linkCacheList = (edIsBig() || text.length > ED_LINK_MAX) ? [] : findLinks(text);
  linkCacheText = text;
  return linkCacheList;
}

// 某个下标（光标位）落在哪个网址里。桌面 Ctrl/Cmd+点击、以及"打开"小按钮都用它。
function linkAt(pos){
  var t = document.getElementById('edt');
  if (!t) return null;
  var ls = editorLinks(t.value);
  for (var i = 0; i < ls.length; i++){
    if (pos >= ls[i].s && pos <= ls[i].e) return ls[i];
  }
  return null;
}

// findLinks 只认 http/https（裸 www. 也已补成 https://），所以这里没有伪协议风险
function openUrl(href){
  if (!href) return;
  var a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---- 编辑器里"每个网址末尾一个小图标" ----
// 难点是坐标：文本框里的字符位置拿不到 DOM，所以借 #edMeasure（与文本框同宽同字体同换行的隐形层）
// 用 Range 量出"网址最后一个字符"的矩形，再换算成相对叠层的坐标。
// 缓存键 = 正文 + 字号 + 换行开关：光标移动/滚动不重算，只有这三者变了才重建。
var iconCacheText = null, iconCacheFont = 0, iconCacheWrap = null;
function renderLinkIcons(text, links){
  var box = document.getElementById('edLinkIcons');
  var mm = document.getElementById('edMeasure');
  if (!box) return;
  if (iconCacheText === text && iconCacheFont === edFont && iconCacheWrap === wrapOn) return;
  iconCacheText = text; iconCacheFont = edFont; iconCacheWrap = wrapOn;
  box.innerHTML = '';
  if (!links.length || !mm || edIsBig() || text.length > ED_LINK_MAX) return;
  // 量测层必须和文本框的换行口径一致，否则量出来的 x/y 全是错的
  mm.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
  mm.style.overflowWrap = wrapOn ? 'anywhere' : 'normal';
  mm.textContent = text;                       // 单个文本节点：Range 可以直接按下标取
  var node = mm.firstChild;
  if (!node) return;
  var mr = mm.getBoundingClientRect();
  if (!mr.width) return;
  var lim = Math.min(links.length, ED_ICON_MAX);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < lim; i++){
    var l = links[i];
    var r = document.createRange();
    try { r.setStart(node, l.e - 1); r.setEnd(node, l.e); } catch (e){ continue; }
    var rr = r.getBoundingClientRect();
    if (!rr.height && !rr.width) continue;
    var ic = makeLinkIcon(l.href);
    // -1 是 #edHl 的 1px 透明边框：镜像层和叠层的边框盒对齐，内容盒差这 1px
    ic.style.left = Math.round(rr.right - mr.left - 1) + 'px';
    ic.style.top = Math.round(rr.top - mr.top - 1 + (rr.height - LINK_ICON_SIZE) / 2 - LINK_ICON_RAISE) + 'px';
    frag.appendChild(ic);
  }
  box.appendChild(frag);
}

// 命中高亮层：叠在文本框上方的一层透明文字层，只在查找时画命中。
// 网址不在这层画（那层只铺底色、会和文字错位），改由 #edLinkIcons 在网址末尾挂图标。
// 既没开查找、正文里也没有网址时整层 hidden，平时不产生任何开销。
function renderHl(){
  var hl = document.getElementById('edHl');
  var inEl = document.getElementById('edHlIn');
  var t = document.getElementById('edt');
  if (!hl || !inEl || !t) return;
  var big = edIsBig();
  var text = t.value;
  var links = editorLinks(text);
  var hits = [];
  if (!big && findState.open && findHits.length){
    var lim = Math.min(findHits.length, 600);
    for (var k = 0; k < lim; k++){
      hits.push({ start: findHits[k].start, end: findHits[k].end, t: findHits[k].t, i: k });
    }
  }
  if (!links.length && !hits.length){
    hl.hidden = true; inEl.innerHTML = '';
    renderLinkIcons(text, links);     // 网址被删光了也要走一趟，把残留的旧图标清掉
    return;
  }
  hl.hidden = false;
  mirrorSync();                       // 先把字体/内边距同步给量测层，网址图标定位要用它量
  inEl.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
  inEl.style.overflowWrap = wrapOn ? 'anywhere' : 'normal';
  // 多关键词才分色；单关键词保持原来的统一黄色（与侧栏 hlText 的口径一致）
  var multi = !!(findState.terms && findState.terms.length > 1);
  inEl.innerHTML = hits.length ? overlayHtml(text, hits, findAt, multi) : '';
  renderLinkIcons(text, links);
  hlScroll();
}

// 把光标与滚动位置对到"当前命中"上。
// noFocus=true 用于"从搜索结果打开文件"：那时只是替用户指出位置，
// 不该抢焦点（手机上会立刻弹软键盘，正是全局都在避免的那件事）。
function findScrollToCurrent(noFocus){
  var t = document.getElementById('edt');
  if (!t || findAt < 0 || findAt >= findHits.length) return;
  var m = findHits[findAt];
  if (!noFocus){ try { t.focus(); } catch (e) {} }
  try { t.setSelectionRange(m.start, m.end); } catch (e) {}
  // 近似滚动定位：按命中位置之前的行数 × 行高
  var linesBefore = t.value.slice(0, m.start).split('\\n').length - 1;
  var mm = mirrorSync();
  var lh = mm ? mm.lh : 22;
  var target = 14 + linesBefore * lh;
  if (target < t.scrollTop + 12 || target > t.scrollTop + t.clientHeight - 44){
    t.scrollTop = Math.max(0, target - Math.round(t.clientHeight / 3));
  }
  updateFindStat(); renderHl(); syncGutter(); hlScroll(); gutScroll();
}
function findGo(dir){
  if (!findHits.length){ toast('没有匹配项'); return; }
  findAt = (findAt + dir + findHits.length) % findHits.length;
  findScrollToCurrent(false);
}

// 替换相关的三个控件（替换为 / 替换 / 全部替换）只在真的要替换时才出现。
// "从搜索结果打开文件"属于"看"，不是"改"：把它们收起来，
// 查找栏就只剩「查找框 + N 处 + 上一处/下一处」，意图一目了然。
function setRepCtl(on){
  var ids = ['fR', 'fRep', 'fRepAll'];
  for (var i = 0; i < ids.length; i++){
    var el = document.getElementById(ids[i]);
    if (el) el.hidden = !on;
  }
}

// 从搜索结果打开文件时，把搜索词一并带进编辑器高亮。
// 侧栏已经告诉用户"这份文件里有 18 处"，真正缺的是"在哪一处" —— 这里补上。
// 复用查找栏的高亮层与「上一处 / 下一处」，不另造一套 UI。
function highlightSearchTerms(terms, opts){
  opts = opts || {};
  var t = document.getElementById('edt');
  var bar = document.getElementById('findBar');
  if (!t || !bar || !terms || !terms.length) return 0;
  if (edIsBig()) return 0;                 // 超大文件本来就不开高亮层（省 CPU）
  findState.open = true;
  findState.terms = terms;
  findState.re = false;
  findState.case = false;
  findState.word = !!opts.word;
  findState.q = terms.join(' ');
  bar.hidden = false;
  setRepCtl(false);            // 只是"看在哪"，不给替换控件
  var fq = document.getElementById('fQ');
  if (fq) fq.value = findState.q;
  findRun(false);
  // 正文里一处都没有（命中其实在文件名 / 路径上，或索引只截了前 8K）——
  // 那就别留一个写着"无匹配"的查找栏在编辑器顶上，静默收回去。
  if (!findHits.length){
    findState.open = false; findState.terms = null; findState.word = false;
    findState.q = ''; findHits = []; findAt = -1;
    bar.hidden = true;
    var fq0 = document.getElementById('fQ'); if (fq0) fq0.value = '';
    renderHl();
    return 0;
  }
  if (opts.scroll !== false) findScrollToCurrent(true);
  return findHits.length;
}

function markEdited(){
  ed.dirty = true;
  setStatus('未保存');
  updateCount();
  syncGutter();
  if (findState.open) findRun(true);
  saveDraftSoon();
  outlineSoon();
}

function findReplaceOne(){
  if (!findHits.length || findAt < 0){ toast('没有匹配项'); return; }
  var t = document.getElementById('edt');
  var m = findHits[findAt];
  var ins = document.getElementById('fR').value;
  if (findState.re){
    try {
      var re = new RegExp(findState.q, findState.case ? '' : 'i');
      ins = t.value.slice(m.start, m.end).replace(re, ins);
    } catch (e) {}
  }
  t.value = t.value.slice(0, m.start) + ins + t.value.slice(m.end);
  var caret = m.start + ins.length;
  try { t.setSelectionRange(caret, caret); } catch (e) {}
  markEdited();
  findRun(true);
  renderHl();
}

function replaceAll(){
  if (!findHits.length){ toast('没有匹配项'); return; }
  var t = document.getElementById('edt');
  var ins = document.getElementById('fR').value;
  var text = t.value, out = '', last = 0, done = 0;
  for (var i = 0; i < findHits.length; i++){
    var m = findHits[i];
    if (m.start < last) continue;
    out += text.slice(last, m.start) + ins;
    last = m.end;
    done++;
  }
  out += text.slice(last);
  t.value = out;
  markEdited();
  findRun(false);
  renderHl();
  toast('已替换 ' + done + ' 处');
}

function openFind(withReplace){
  var bar = document.getElementById('findBar');
  var t = document.getElementById('edt');
  if (!bar || !t) return;
  findState.open = true;
  bar.hidden = false;
  setRepCtl(true);             // 用户自己打开的查找栏，替换控件照旧给全
  var q = document.getElementById('fQ');
  try {
    if (t.selectionEnd > t.selectionStart){
      var sel = t.value.slice(t.selectionStart, t.selectionEnd);
      if (sel.length <= 120 && sel.indexOf('\\n') < 0) q.value = sel;
    }
  } catch (e) {}
  // 当前若是"从搜索结果带进来的高亮"，Ctrl+F 不该把它抹掉：
  // 保持多关键词会话、输入框继续显示这组词；用户一敲字就会自动切回单串查找。
  if (!(findState.terms && findState.terms.length)) findState.q = q.value;
  q.focus();
  try { q.select(); } catch (e) {}
  findRun(false);
  if (withReplace){ var r = document.getElementById('fR'); if (r){ r.focus(); } }
}

// 关掉查找栏。
// noFocus=true 表示"只是顺带清理一下状态"，别去抢焦点 ——
// 打开文件前就是用它收尾的，若在这里 focus 编辑器，
// 手机上会立刻弹出软键盘（正是要避免的那件事）。
function closeFind(noFocus){
  var bar = document.getElementById('findBar');
  findState.open = false;
  if (bar) bar.hidden = true;
  findHits = []; findAt = -1;
  renderHl();
  // 严格判断 === true：这个函数同时被当成事件处理器绑定（closeFind(ev)），
  // 传进来的 MouseEvent 是 truthy，用普通真值判断会误伤"还给焦点"这条正常路径。
  if (noFocus === true) return;
  var t = document.getElementById('edt');
  if (t){ try { t.focus(); } catch (e) {} }
}

// ---- Markdown 大纲 ----
function tocWithLines(text){
  var lines = text.split('\\n'), out = [], inFence = false;
  for (var i = 0; i < lines.length; i++){
    var ln = lines[i];
    if (startsAt(ltrim(ln), 0, CH_BT + CH_BT + CH_BT)){ inFence = !inFence; continue; }
    if (inFence) continue;
    if (ln.charAt(0) !== '#') continue;
    var lv = 0;
    while (lv < 6 && ln.charAt(lv) === '#') lv++;
    if (lv > 0 && isWs(ln.charAt(lv))) out.push({ lv: lv, text: ln.slice(lv).trim(), line: i });
  }
  return out;
}
function outlineSoon(){
  clearTimeout(ed.otimer);
  ed.otimer = setTimeout(mdOutline, 420);
}
function mdOutline(){
  var box = document.getElementById('edOutline');
  if (!box || RO) return;
  if (kindOf(ed.name || '', '') !== 'md'){ box.hidden = true; return; }
  var toc = tocWithLines(edText());
  if (toc.length < 2){ box.hidden = true; return; }
  var h = '<b>大纲</b>';
  for (var i = 0; i < toc.length; i++){
    h += '<a href="#" data-oline="' + toc[i].line + '" class="lv' + toc[i].lv + '">' + E(toc[i].text) + '</a>';
  }
  box.innerHTML = h;
  box.hidden = false;
}
function editorGoLine(line){
  var t = document.getElementById('edt');
  if (!t) return;
  var text = t.value, pos = 0, n = 0;
  for (var i = 0; i < text.length && n < line; i++){ if (text.charAt(i) === '\\n') n++; pos = i + 1; }
  var mm = mirrorSync();
  var lh = mm ? mm.lh : 22;
  try { t.focus(); t.setSelectionRange(pos, Math.min(text.length, pos + 1)); } catch (e) {}
  t.scrollTop = Math.max(0, 14 + line * lh - Math.round(t.clientHeight / 4));
  syncGutter(); hlScroll(); gutScroll();
}

// ---- 编辑器里的「源码 / 预览」切换 ----
// 编辑区始终以源码为准（保存的永远是纯文本），预览只是叠加的一层显示，
// 所以不会出现"富文本编辑器把文件改坏"的风险。
function edCanPreview(name){
  var k = kindOf(name || ed.name || '', '');
  // html 也进来：编辑区仍以源码为准（保存的永远是纯文本），预览那层是 sandbox iframe，
  // 改完点一下预览就能看效果，不用下载再打开。
  return k === 'md' || k === 'json' || k === 'csv' || k === 'code' || k === 'html';
}
// 注意：刚打开文件时 ed.name 还是上一个文件的值，所以允许显式传入名字
function paintEdSeg(name){
  var seg = document.getElementById('edSeg');
  if (!seg) return;
  if (!edCanPreview(name)){ seg.innerHTML = ''; return; }
  var pv = document.getElementById('edPrev');
  var on = !!(pv && !pv.hidden);
  seg.innerHTML = '<span class="vseg">' +
    '<button data-emode="src"' + (!on ? ' class="on"' : '') + '>源码</button>' +
    '<button data-emode="prev"' + (on ? ' class="on"' : '') + '>预览</button></span>';
}
function edSetPreview(on){
  var p = document.getElementById('edPrev');
  var row = document.getElementById('edRow');
  var t = document.getElementById('edt');
  var bar = document.getElementById('findBar');
  if (!p || !row || !t) return;
  if (on){
    // 编辑器预览走"真文档"：iframe 直接加载管理端的 /f/<路径>?doc=1，
    // 这样页面自己的 css / 图片能加载（与分享页的渲染方式完全一致）。
    var docSrc = ed.path ? BASE + '/f/' + encPath(ed.path) + '?doc=1' : '';
    var r = renderText(ed.name || '', '', t.value, docSrc);
    if (!r.ok){ toast('这个格式没有专用预览，直接看源码就好'); return; }
    p.innerHTML = r.html;
    // HTML 预览：srcdoc 模式要把原文塞进 srcdoc；docSrc 模式交给 iframe 自己加载。
    // p 容器复用同一个 id，所以这里也要复位 className —— 否则看完 HTML 再切回
    // Markdown，htmlBox 的 padding:0 / overflow:hidden 会残留下来把渲染弄坏。
    p.className = (r.srcdoc != null || r.docSrc) ? 'rBox edPrev htmlBox' : 'rBox edPrev';
    if (r.srcdoc != null || r.docSrc){
      var fr = p.querySelector('iframe');
      if (fr){
        if (r.docSrc) fr.src = r.docSrc;
        else fr.srcdoc = r.srcdoc;
      }
      if (r.note) p.insertAdjacentHTML('beforeend', '<div class="htmlNote">' + r.note + '</div>');
    }
    p.hidden = false;
    row.hidden = true;
    if (bar) bar.hidden = true;
    findState.open = false;
    findHits = []; findAt = -1;
    renderHl();
  } else {
    p.hidden = true;
    p.innerHTML = '';
    p.className = 'rBox edPrev';
    row.hidden = false;
    syncGutter();
    renderHl();
  }
  paintEdSeg();
}

// ---- 草稿自动保存 ----
// 编辑中每 2.5 秒把内容存进浏览器本地。误关闭 / 崩溃后重新打开同一文件会提示恢复。
function draftKey(path){ return 'cfwtxt_draft:' + path; }
function saveDraftSoon(){
  if (RO || !ed.path) return;
  clearTimeout(ed.dtimer);
  ed.dtimer = setTimeout(saveDraft, 2500);
}
function saveDraft(){
  if (RO || !ed.path) return;
  var v = edText();
  if (v.length > ED_DRAFT_MAX) return;
  try { localStorage.setItem(draftKey(ed.path), JSON.stringify({ t: v, at: Date.now() })); } catch (e) {}
}
function loadDraft(path){
  try {
    var raw = localStorage.getItem(draftKey(path));
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (!d || typeof d.t !== 'string') return null;
    return d;
  } catch (e) { return null; }
}
function clearDraft(path){
  try { localStorage.removeItem(draftKey(path)); } catch (e) {}
}

// ---- 分隔符配对 / 缩进 ----
var PAIR_CLOSE = { '(': ')', '[': ']', '{': '}' };
var QUOTE_CH = { '"': 1, "'": 1 };
QUOTE_CH[CH_BT] = 1;
var COMMENT_TOK = { py: '#', sh: '#', yaml: '#', toml: '#', ini: '#', sql: '--' };

function commentTokenFor(name){
  var l = HL_ALIAS[extOf(name)];
  return COMMENT_TOK[l] || '//';
}
function selectedLines(t){
  var s = t.value.lastIndexOf('\\n', Math.max(0, t.selectionStart - 1)) + 1;
  var e = t.value.indexOf('\\n', t.selectionEnd);
  if (e < 0) e = t.value.length;
  return { start: s, end: e };
}
function indentSel(t, out){
  var r = selectedLines(t);
  var block = t.value.slice(r.start, r.end);
  var lines = block.split('\\n');
  var changed;
  if (out){
    changed = lines.map(function(l){
      if (startsAt(l, 0, '  ')) return l.slice(2);
      if (startsAt(l, 0, ' ') || startsAt(l, 0, '\\t')) return l.slice(1);
      return l;
    });
  } else {
    changed = lines.map(function(l){ return l ? '  ' + l : l; });
  }
  var nb = changed.join('\\n');
  t.value = t.value.slice(0, r.start) + nb + t.value.slice(r.end);
  try { t.setSelectionRange(r.start, r.start + nb.length); } catch (e) {}
}
function moveLines(t, dir){
  var r = selectedLines(t);
  var all = t.value.split('\\n');
  var first = t.value.slice(0, r.start).split('\\n').length - 1;
  var count = t.value.slice(r.start, r.end).split('\\n').length;
  if (dir < 0 && first === 0) return;
  if (dir > 0 && first + count >= all.length) return;

  if (dir < 0){
    var prev = all[first - 1];
    var block = all.slice(first, first + count);
    all = all.slice(0, first - 1).concat(block, [prev], all.slice(first + count));
    first = first - 1;
  } else {
    var nxt = all[first + count];
    var block2 = all.slice(first, first + count);
    all = all.slice(0, first).concat([nxt], block2, all.slice(first + count + 1));
    first = first + 1;
  }
  t.value = all.join('\\n');
  var from = first > 0 ? all.slice(0, first).join('\\n').length + 1 : 0;
  var len = all.slice(first, first + count).join('\\n').length;
  try { t.setSelectionRange(from, from + len); } catch (e) {}
}
function toggleComment(t){
  var r = selectedLines(t);
  var block = t.value.slice(r.start, r.end);
  var tok = commentTokenFor(ed.name || '');
  var lines = block.split('\\n');
  var nonEmpty = lines.filter(function(l){ return ltrim(l) !== ''; });
  var allCommented = nonEmpty.length > 0 && nonEmpty.every(function(l){ return startsAt(ltrim(l), 0, tok); });
  var changed = lines.map(function(l){
    if (!l.trim()) return l;
    if (allCommented){
      var pad = l.length - ltrim(l).length;
      return l.slice(0, pad) + ltrim(l).slice(tok.length).replace(/^ /, '');
    }
    var pad2 = l.length - ltrim(l).length;
    return l.slice(0, pad2) + tok + ' ' + ltrim(l);
  });
  var nb = changed.join('\\n');
  t.value = t.value.slice(0, r.start) + nb + t.value.slice(r.end);
  try { t.setSelectionRange(r.start, r.start + nb.length); } catch (e) {}
}

// 编辑器快捷键。只在编辑视图生效，不干扰列表页与弹窗。
function edKeydown(e){
  var t = document.getElementById('edt');
  if (!t || RO || state.view !== 'edit') return;
  var mod = e.ctrlKey || e.metaKey;
  var key = e.key;
  var changed = false;

  if (mod && (key === 's' || key === 'S')){ e.preventDefault(); saveEd(); return; }
  if (mod && (key === 'f' || key === 'F')){ e.preventDefault(); openFind(false); return; }
  if (mod && (key === 'h' || key === 'H')){ e.preventDefault(); openFind(true); return; }
  if (mod && key === '/'){ e.preventDefault(); toggleComment(t); changed = true; }
  else if (key === 'Tab'){
    e.preventDefault();
    indentSel(t, e.shiftKey); changed = true;
  }
  else if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')){
    e.preventDefault();
    moveLines(t, key === 'ArrowUp' ? -1 : 1); changed = true;
  }
  else if (findState.open && document.activeElement === document.getElementById('fQ') && key === 'Enter'){
    e.preventDefault(); findGo(e.shiftKey ? -1 : 1); return;
  }
  else if (key === 'F3'){ e.preventDefault(); findGo(e.shiftKey ? -1 : 1); return; }
  else if (PAIR_CLOSE[key] || QUOTE_CH[key] === 1){
    var s = t.selectionStart, en = t.selectionEnd;
    if (en > s){
      // 选中内容 + 输入成对符号 = 自动包裹
      var close = PAIR_CLOSE[key] || key;
      e.preventDefault();
      var body = t.value.slice(s, en);
      t.value = t.value.slice(0, s) + key + body + close + t.value.slice(en);
      try { t.setSelectionRange(s, s + body.length + 2); } catch (x) {}
      changed = true;
    } else if (PAIR_CLOSE[key]){
      e.preventDefault();
      var nx = t.value.charAt(s);
      var typed = (nx === PAIR_CLOSE[key]) ? '' : PAIR_CLOSE[key];
      t.value = t.value.slice(0, s) + key + typed + t.value.slice(en);
      try { t.setSelectionRange(s + 1, s + 1); } catch (x2) {}
      changed = true;
    } else {
      // 引号：后面是空白/行尾才补另一半，避免在单词中间插入难打
      var prev = t.value.charAt(s - 1);
      var nxt = t.value.charAt(s);
      var wordChar = function(c){ return c && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_'); };
      if (wordChar(prev) && wordChar(nxt)) return;
      e.preventDefault();
      t.value = t.value.slice(0, s) + key + key + t.value.slice(en);
      try { t.setSelectionRange(s + 1, s + 1); } catch (x3) {}
      changed = true;
    }
  }
  if (changed){ markEdited(); }
}

// ================= 侧栏宽度：拖拽 / 自适应 =================
// 目录树里名字被省略号截断，根本原因就是侧栏固定 256px。所以做成可拖拽，
// 另外给一个"按最长文件名自适应"的按钮 —— 一键把侧栏撑到刚好装下最长的名字。
var SIDE_MIN = 200, SIDE_MAX = 620, SIDE_DEF = 256, SIDE_KEY = 'cfwtxt_sidew';

function sideW(){
  var v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
  return (v > 0) ? v : SIDE_DEF;
}
function reflowEditor(){
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}
function setSideW(px, noSave){
  var w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(px || SIDE_DEF)));
  document.documentElement.style.setProperty('--side-w', w + 'px');
  if (!noSave){ try { localStorage.setItem(SIDE_KEY, String(w)); } catch (e) {} }
  reflowEditor();
  return w;
}
// 量出目录树里"最宽的一行"真正需要的宽度：
// 行内其它部件（三角/图标/徽标/数量/操作）的合计宽 + 完整文件名宽 + 该行的缩进。
// 名字的完整宽度直接读 scrollWidth —— 元素上挂着 overflow:hidden，滚动宽度就是未截断的宽度。
function fitSideW(){
  var box = document.getElementById('sideScroll');
  var asideEl = document.querySelector('aside');
  if (!box || !asideEl) return sideW();
  var rows = box.querySelectorAll('.trow');
  if (!rows.length) return sideW();
  var asideL = asideEl.getBoundingClientRect().left;
  var need = 0;
  for (var i = 0; i < rows.length; i++){
    var row = rows[i];
    var name = row.querySelector('.tname');
    if (!name) continue;
    var others = row.offsetWidth - name.offsetWidth;
    var want = others + name.scrollWidth;
    var leftOff = row.getBoundingClientRect().left - asideL;
    if (leftOff + want > need) need = leftOff + want;
  }
  if (!need) return sideW();
  return setSideW(need + 16);
}

var gripDrag = null;
function onGripMove(e){
  if (!gripDrag) return;
  e.preventDefault();
  setSideW(gripDrag.w + (e.clientX - gripDrag.x), true);
}
function endGrip(){
  if (!gripDrag) return;
  gripDrag = null;
  var g = document.getElementById('sideGrip');
  if (g) g.classList.remove('on');
  document.body.classList.remove('grip-ing');
  window.removeEventListener('pointermove', onGripMove);
  window.removeEventListener('pointerup', endGrip);
  try { localStorage.setItem(SIDE_KEY, String(sideW())); } catch (e) {}
  reflowEditor();
}
function onGripDown(e){
  if (e.pointerType && e.pointerType !== 'mouse') return;   // 触屏交给页面滚动
  e.preventDefault();
  gripDrag = { x: e.clientX, w: sideW() };
  var g = document.getElementById('sideGrip');
  if (g) g.classList.add('on');
  document.body.classList.add('grip-ing');
  window.addEventListener('pointermove', onGripMove);
  window.addEventListener('pointerup', endGrip);
}
function onGripKey(e){
  var step = e.shiftKey ? 40 : 12;
  if (e.key === 'ArrowLeft'){ e.preventDefault(); setSideW(sideW() - step); }
  else if (e.key === 'ArrowRight'){ e.preventDefault(); setSideW(sideW() + step); }
  else if (e.key === 'Home'){ e.preventDefault(); setSideW(SIDE_DEF); }
  else if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toast('已按内容自适应到 ' + fitSideW() + 'px'); }
}

// ================= 列表排序 =================
var SORT_STORE = 'cfwtxt_sort';
var SORT_LABEL = { name: '名称', type: '类型', size: '大小', time: '修改时间' };
// 第一次点某一列时给"最有用的方向"：大小和时间默认从大到小，名称和类型默认正序
var SORT_FIRST_DESC = { name: false, type: false, size: true, time: true };

function loadSort(){
  var s = { by: 'name', desc: false };
  try {
    var raw = localStorage.getItem(SORT_STORE);
    if (raw){
      var d = JSON.parse(raw);
      if (d && SORT_LABEL[d.by]){ s.by = d.by; s.desc = !!d.desc; }
    }
  } catch (e) {}
  return s;
}
function saveSort(){
  try { localStorage.setItem(SORT_STORE, JSON.stringify(state.sort)); } catch (e) {}
}
function setSort(by, forceDesc){
  if (!SORT_LABEL[by]) return;
  if (forceDesc == null){
    if (state.sort.by === by) state.sort.desc = !state.sort.desc;
    else { state.sort.by = by; state.sort.desc = !!SORT_FIRST_DESC[by]; }
  } else {
    state.sort.by = by;
    state.sort.desc = !!forceDesc;
  }
  saveSort();
  return load(state.path);
}
function sortArrow(by){
  if (state.sort.by !== by) return '';
  return '<span class="sar">' + (state.sort.desc ? '↓' : '↑') + '</span>';
}
function sortTh(key, label, style){
  return '<th class="sortable' + (key === 'name' ? '' : ' hide-s') + '" data-sortby="' + key + '"' +
    (style ? ' style="' + style + '"' : '') + ' title="按' + SORT_LABEL[key] + '排序（再点一次切换升降序）">' +
    label + sortArrow(key) + '</th>';
}
function sortBarHtml(){
  var h = '<span class="sp"></span><span class="sortBox">' +
    '<select id="sortBy" title="排序字段">';
  for (var k in SORT_LABEL){
    h += '<option value="' + k + '"' + (state.sort.by === k ? ' selected' : '') + '>' + SORT_LABEL[k] + '</option>';
  }
  h += '</select>' +
    '<button class="wtog' + ' on" id="sortDir" title="点击切换升序 / 降序">' +
    (state.sort.desc ? '↓ 降序' : '↑ 升序') + '</button></span>';
  return h;
}
function bindSortBar(){
  var sel = document.getElementById('sortBy');
  if (sel) sel.onchange = function(){ setSort(sel.value, SORT_FIRST_DESC[sel.value]); };
  var dir = document.getElementById('sortDir');
  if (dir) dir.onclick = function(){ setSort(state.sort.by, !state.sort.desc); };
}

// 类型列的可读名称（比只有徽标更直白，也顺手把宽屏上空出来的地方用起来）
var TYPE_BY_CAT = { doc: '文档', data: '数据表', cfg: '配置', web: '网页', media: '媒体', code: '代码', other: '文件' };
function typeLabel(name, ct){
  var ext = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (ext === 'pdf' || c === 'application/pdf') return 'PDF';
  if (c.indexOf('image/') === 0 || EXT_MEDIA_IMG[ext]) return '图片';
  if (c.indexOf('video/') === 0 || EXT_MEDIA_VID[ext]) return '视频';
  if (c.indexOf('audio/') === 0 || EXT_MEDIA_AUD[ext]) return '音频';
  if (EXT_ARCHIVE[ext]) return '压缩包';
  if (c.indexOf('application/vnd.openxmlformats') === 0) return 'Office 文档';
  if (!ext) return '无扩展名';
  return TYPE_BY_CAT[extCat(name, ct)] || '文件';
}

// ================= 框选多选 =================
// 在列表区域按住鼠标拖出一个矩形，与它相交的行会被勾上（Ctrl/Shift 为加选）。
// 4px 抖动阈值：没越过就当成普通点击，点文件照样打开。
var marq = null;

function marqRows(){
  var list = document.getElementById('list');
  return list ? [].slice.call(list.querySelectorAll('tbody tr')) : [];
}
function applyMarq(l, t, r, b){
  var next = {};
  if (marq && marq.additive){ for (var k in marq.base) next[k] = marq.base[k]; }
  var rows = marqRows();
  for (var i = 0; i < rows.length; i++){
    var tr = rows[i];
    var cb = tr.querySelector('input.ck');
    if (!cb) continue;
    var rr = tr.getBoundingClientRect();
    // 矩形与行相交即命中（只看纵向重叠就够，横向整行都算）
    if (rr.bottom < t || rr.top > b || rr.right < l || rr.left > r) continue;
    next[cb.getAttribute('data-ck')] = {
      path: joinPath(state.path, cb.getAttribute('data-ckname')),
      isDir: cb.getAttribute('data-ckdir') === '1'
    };
  }
  state.sel = next;
  paintSel();
  syncSelection();
}
function onMarqMove(e){
  if (!marq) return;
  var dx = e.clientX - marq.x0, dy = e.clientY - marq.y0;
  if (!marq.moved){
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;      // 抖动阈值
    marq.moved = true;
    document.body.classList.add('marq-ing');
    try { if (window.getSelection) window.getSelection().removeAllRanges(); } catch (x) {}
  }
  e.preventDefault();
  if (!marq.box){
    marq.box = document.createElement('div');
    marq.box.className = 'marq';
    marq.box.id = 'marqBox';
    document.body.appendChild(marq.box);
  }
  var l = Math.min(marq.x0, e.clientX), tt = Math.min(marq.y0, e.clientY);
  var w = Math.abs(dx), h = Math.abs(dy);
  marq.box.style.left = l + 'px';
  marq.box.style.top = tt + 'px';
  marq.box.style.width = w + 'px';
  marq.box.style.height = h + 'px';
  // 拖动时每帧最多重算一次，避免几百行被 pointermove 打爆
  marq.pending = [l, tt, l + w, tt + h];
  if (!marq.raf){
    marq.raf = requestAnimationFrame(function(){
      if (!marq) return;
      marq.raf = 0;
      if (marq.pending) applyMarq(marq.pending[0], marq.pending[1], marq.pending[2], marq.pending[3]);
    });
  }
}
function endMarq(){
  window.removeEventListener('pointermove', onMarqMove);
  window.removeEventListener('pointerup', endMarq);
  if (marq && marq.box && marq.box.parentNode) marq.box.parentNode.removeChild(marq.box);
  document.body.classList.remove('marq-ing');
  marq = null;
}
function onMarqDown(e){
  if (RO || state.view !== 'list') return;
  if (e.button !== 0) return;
  if (e.pointerType && e.pointerType !== 'mouse'){ lpStart(e); return; }   // 触屏：长按进多选（拖框在手指上不成立）
  var t = e.target;
  if (t && t.closest && t.closest('a,button,input,select,label,option')) return;
  if (!marqRows().length) return;
  marq = {
    x0: e.clientX, y0: e.clientY, moved: false, box: null, raf: 0, pending: null,
    base: {}, additive: !!(e.ctrlKey || e.metaKey || e.shiftKey)
  };
  if (marq.additive){ for (var k in state.sel) marq.base[k] = state.sel[k]; }
  window.addEventListener('pointermove', onMarqMove);
  window.addEventListener('pointerup', endMarq);
}

// Shift + 点击勾选框 = 从上次点到这次之间的行全部选中
function rangeSelect(currentKey){
  var boxes = [].slice.call(document.querySelectorAll('#list input.ck'));
  var from = -1, to = -1;
  for (var i = 0; i < boxes.length; i++){
    var k = boxes[i].getAttribute('data-ck');
    if (k === state.lastPick) from = i;
    if (k === currentKey) to = i;
  }
  if (from < 0 || to < 0) return false;
  var a = Math.min(from, to), b = Math.max(from, to);
  for (var j = a; j <= b; j++){
    var bx = boxes[j];
    state.sel[bx.getAttribute('data-ck')] = {
      path: joinPath(state.path, bx.getAttribute('data-ckname')),
      isDir: bx.getAttribute('data-ckdir') === '1'
    };
  }
  paintSel();
  syncSelection();
  return true;
}

// ===== 文件打开 =====
function openPath(path){
  var name = path.split('/').pop();
  var dir = path.split('/').slice(0, -1).join('/');
  if (dir === state.path) { openFile(name); return; }
  markOpen(dir);
  // 关键优化：以前是 list → 等它完成 → openFile → read，**两次请求串行**，
  // 点树里的文件要等两个来回才出内容，这就是那"一丝丝卡顿"的来源。
  // 现在先把 state.path 切过去，read（打开文件）与 list（只负责刷新列表视图）**并行**发出 ——
  // 打开文件的延迟直接减半；列表数据回来时用户多半已经停在编辑器里了。
  state.path = dir;
  state.sel = {};
  state.lastPick = null;
  var opener = openFile(name);              // 立即切编辑器并发起 read
  api('list', { path: dir }).then(function(d){
    state.folders = d.folders || [];
    state.files = d.files || [];
    if (state.view === 'list') renderList();
    renderSide();
    revealInTree(dir);
  }).catch(function(e){ toast('打开失败：' + e.message); });
  return opener;
}

function openFile(name){
  var meta = metaFor(name);
  var kind = kindOf(name, meta.ct);
  // HTML 是 text/*，本来会落进"打开编辑器"，但 HTML 的价值在于**看到渲染效果**。
  // 只读端（分享访客）没有编辑器，直接给预览；管理端仍然打开编辑器 —— 那是唯一能改
  // HTML 的地方，不能为了预览把编辑能力换掉。编辑器里另给了"预览"按钮。
  if (kind === 'html' && RO){ openViewer(joinPath(state.path, name)); return; }
  if (isText(name, meta.ct)){
    if (RO) openViewer(joinPath(state.path, name));
    else openEditor(name);
    return;
  }
  // 图片 / 音视频 / PDF：开灯箱预览，不再只能下载
  if (PREVIEW_KINDS[kind]){ openMediaModal(joinPath(state.path, name), name); return; }
  location.href = dlUrl(name);
}

// ===== 媒体预览（灯箱）=====
// 用 blob: + <img>/<video>/<audio>/<iframe>，不发新窗口，也不依赖 object-src。
// 关闭时立刻 revokeObjectURL，避免大图长期占内存。
var mediaUrl = null;
function revokeMedia(){
  if (mediaUrl){ try { URL.revokeObjectURL(mediaUrl); } catch (e) {} mediaUrl = null; }
}

function openMediaModal(path, name){
  revokeMedia();
  var kind = kindOf(name, '');
  var scale = 1, rot = 0;
  showModal({
    title: name || path.split('/').pop(),
    noOk: true, cancelText: '关闭',
    body: '<div class="mediaBar">' +
      '<span class="rawNote" style="margin:0;flex:1" id="mbInfo">载入中…</span>' +
      (kind === 'image' ? '<button class="btn sm" id="mbOut">缩小</button>' +
        '<button class="btn sm" id="mbIn">放大</button>' +
        '<button class="btn sm" id="mbRot">旋转</button>' +
        '<button class="btn sm" id="mbRst">复位</button>' : '') +
      '<button class="btn sm" id="mbDl">下载</button>' +
      '</div><div id="mbBox"></div>',
    after: function(){
      var box = document.getElementById('mbBox');
      var info = document.getElementById('mbInfo');
      document.getElementById('mbDl').onclick = function(){ location.href = dlUrl('', path); };
      req(BASE + '/api?action=raw&path=' + encodeURIComponent(path)).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ct = r.headers.get('Content-Type') || '';
        return r.blob().then(function(b){ return { b: b, ct: ct }; });
      }).then(function(o){
        if (!o.b.size && o.b.size !== 0) throw new Error('空响应');
        mediaUrl = URL.createObjectURL(o.b);
        if (kind === 'image'){
          box.innerHTML = '<div class="mediaBox"><img id="mbImg" alt=""></div>';
          var img = document.getElementById('mbImg');
          img.src = mediaUrl;
          img.onerror = function(){ info.textContent = '这个文件不是有效的图片，无法预览'; };
          img.onload = function(){
            info.textContent = fmtSize(o.b.size) + ' · ' + img.naturalWidth + '×' + img.naturalHeight;
          };
          var apply = function(){ img.style.transform = 'scale(' + scale + ') rotate(' + rot + 'deg)'; };
          document.getElementById('mbOut').onclick = function(){ scale = Math.max(0.2, scale - 0.2); apply(); };
          document.getElementById('mbIn').onclick = function(){ scale = Math.min(6, scale + 0.2); apply(); };
          document.getElementById('mbRot').onclick = function(){ rot = (rot + 90) % 360; apply(); };
          document.getElementById('mbRst').onclick = function(){ scale = 1; rot = 0; apply(); };
          img.onclick = function(){ scale = scale > 1 ? 1 : 2; apply(); };
        } else if (kind === 'av'){
          if (o.ct.indexOf('audio/') === 0){
            box.innerHTML = '<div class="mediaBox"><audio id="mbAV" controls></audio></div>';
            info.textContent = fmtSize(o.b.size) + ' · 音频';
          } else {
            box.innerHTML = '<div class="mediaBox"><video id="mbAV" controls playsinline></video></div>';
            info.textContent = fmtSize(o.b.size) + ' · 视频';
          }
          var av = document.getElementById('mbAV');
          av.src = mediaUrl;
          av.onloadedmetadata = function(){
            info.textContent = fmtSize(o.b.size) + (av.duration ? ' · 时长 ' + Math.round(av.duration) + ' 秒' : '');
          };
        } else if (kind === 'pdf'){
          box.innerHTML = '<div class="frameBox" style="min-height:66vh"><iframe id="mbF"></iframe></div>';
          info.textContent = fmtSize(o.b.size) + ' · PDF';
          document.getElementById('mbF').src = mediaUrl;
        } else {
          info.textContent = '这个类型不支持在线预览，请下载后查看';
        }
      }).catch(function(e){
        if (info) info.textContent = '预览失败：' + e.message;
      });
    }
  });
}

// ===== 只读查看器（访客专用）=====
// 用 <pre> 而不是 <textarea>：不能输入、不弹键盘、没有光标闪烁，
// 一眼就知道是"看"而不是"改"，但文字照样可以选中复制。
// 在此基础上再叠一层渲染：md/json/csv/代码默认给渲染视图，右上角可切回源码。
var viewerText = '';
var viewerState = { rich: false, mode: 'rich', name: '', text: '', gated: false };

// 大 HTML 不自动渲染：1.8MB 实测 iframe 解析约 1s，先给源码，用户点了「渲染」再建。
// 只卡 HTML —— md/json/csv/代码的渲染都便宜，照旧直接出结果。
var VIEW_RENDER_MAX = 512 * 1024;

function paintViewerSeg(){
  var seg = document.getElementById('vSeg');
  if (!seg) return;
  if (!viewerState.rich){ seg.innerHTML = ''; return; }
  var rich = viewerState.mode === 'rich';
  var tip = viewerState.gated ? ' title="文件较大，渲染可能需要一会儿"' : '';
  seg.innerHTML = '<span class="vseg">' +
    '<button data-vmode="rich"' + (rich ? ' class="on"' : '') + tip + '>渲染</button>' +
    '<button data-vmode="src"' + (rich ? '' : ' class="on"') + '>源码</button></span>';
}

function applyViewerMode(){
  var rich = viewerState.rich && viewerState.mode === 'rich';
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  if (rbox) rbox.hidden = !rich;
  if (box){
    box.hidden = !!rich;
    box.className = 'viewer' + (wrapOn ? ' wrapon' : ' wrapoff');
  }
  var wb = document.getElementById('vWrap');
  if (wb) wb.hidden = !!rich;
  paintViewerSeg();
}

// 大文件按需渲染：只有用户点了「渲染」才真正把 iframe 建起来，之前一直是空的
function viewerRenderNow(){
  if (!viewerState.rich || !viewerState.gated) return;
  var rbox = document.getElementById('vRender');
  if (!rbox || rbox.innerHTML) return;
  var rr = renderInto(rbox, viewerState.name, '', viewerState.text, viewerState.docSrc);
  if (!rr) viewerState.rich = false;      // 渲染不出来就别露出空的渲染层
}

// 把一份文本画进查看器 —— 缓存命中 / 网络取回 / 后台校验 共用这一条路径
function paintViewerContent(path, text, enc, status){
  var name = path.split('/').pop();
  viewerText = text;
  viewerState.text = text;
  viewerState.name = name;
  // 分享页里预览 HTML：iframe 加载同一个分享范围内的"真文档"（?doc=1，注入过 base），
  // 这样页面自己的 css / 图片才会加载 —— 与单文件分享直链的渲染方式完全一致。
  viewerState.docSrc = kindOf(name, '') === 'html' ? (BASE + '/' + encPath(path) + '?doc=1') : '';
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  var note = document.getElementById('vNote');
  var gated = kindOf(name, '') === 'html' && text.length > VIEW_RENDER_MAX;
  viewerState.gated = gated;
  if (note){
    if (gated){
      note.innerHTML = '<div class="rawNote">文件较大（' + fmtSize(text.length) +
        '），为避免卡顿默认显示源码；点右上角 <b>渲染</b> 可预览。</div>';
    } else if (enc && enc !== 'utf-8'){
      note.innerHTML = '<div class="rawNote">检测到 <b>' + E(enc) + '</b> 编码，已自动按 UTF-8 显示。</div>';
    } else {
      note.innerHTML = '';
    }
  }
  if (gated){
    if (rbox){ rbox.innerHTML = ''; rbox.hidden = true; rbox.className = 'rBox'; }
    viewerState.rich = true;              // 有渲染能力，露出「渲染 / 源码」切换
    viewerState.mode = 'src';
  } else {
    var rr = renderInto(rbox, name, '', text, viewerState.docSrc);
    viewerState.rich = !!rr;
    viewerState.mode = 'rich';
  }
  // 无论是否渲染，都把原文放进 <pre> —— 切到"源码"才有东西看（原样纯文本，不挂网址图标）
  if (box){ box.textContent = text; box.scrollTop = 0; }
  applyWrap();
  applyViewerMode();
  var c = document.getElementById('vCount');
  if (c) c.textContent = (text ? text.split('\\n').length : 0) + ' 行 · ' + text.length + ' 字符';
  setStatus(status || '已载入');
}

function openViewer(path){
  var name = path.split('/').pop();
  switchView('edit');
  ed.path = path; ed.name = name; ed.dirty = false;
  revokeMedia();

  viewerState = { rich: false, mode: 'rich', name: name, text: '' };
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  var note = document.getElementById('vNote');
  var nameEl = document.getElementById('vName');
  if (nameEl) nameEl.textContent = name;
  if (box){ box.hidden = false; box.textContent = '载入中…'; }
  // className 也要一起复位：renderInto 给 HTML 预览加的 htmlBox（padding:0 + overflow:hidden）
  // 会残留到下一个文件。先看完一个 HTML 再打开 Markdown，那层 padding:0 会把渲染结果贴边、滚动也坏掉。
  if (rbox){ rbox.hidden = true; rbox.innerHTML = ''; rbox.className = 'rBox'; }
  if (note) note.innerHTML = '';
  var cnt = document.getElementById('vCount');
  if (cnt) cnt.textContent = '';
  applyViewerMode();
  renderViewerMeta(path);
  try { document.title = name + ' · 只读分享'; } catch (e) {}
  setStatus('载入中…');

  // 内存缓存命中：先秒出内容，再后台拿 ETag 校验。
  // 分享内容只在"发布"时变，绝大多数是 304 —— 相当于白拿一次即时打开。
  var cached = fileCacheGet(path);
  if (cached){
    paintViewerContent(path, cached.text, cached.enc, '已载入（内存缓存）');
    refreshTreeSel();
    revealInTree(path);
    revalidateViewer(path, cached);
    return;
  }

  return req(BASE + '/api?action=read&path=' + encodeURIComponent(path))
    .then(function(r){
      if (r.ok){
        var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
        var etag = r.headers ? (r.headers.get('ETag') || '') : '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      }
      return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error(d.error || ('HTTP ' + r.status)); });
    })
    .then(function(o){
      fileCachePut(path, o.t, o.enc, o.etag);
      paintViewerContent(path, o.t, o.enc, '已载入');
      refreshTreeSel();
      revealInTree(path);
    })
    .catch(function(e){
      var el = document.getElementById('viewer');
      if (el){ el.hidden = false; el.textContent = '打开失败：' + e.message; }
      var rb = document.getElementById('vRender');
      if (rb) rb.hidden = true;
      setStatus('打开失败');
    });
}

function renderViewerMeta(path){
  var name = path.split('/').pop();
  var dir = path.split('/').slice(0, -1).join('/');
  var m = (dir === state.path) ? metaFor(name) : {};
  var box = document.getElementById('vMeta');
  if (!box) return;
  var parts = [];
  if (m.size != null) parts.push(fmtSize(m.size));
  if (m.mtime) parts.push(fmtTime(m.mtime));
  box.textContent = parts.join(' · ');
}

function setStatus(msg){
  var el = document.getElementById('edtStatus');
  if (el) el.textContent = msg || '';
}

function updateCount(){
  var t = document.getElementById('edt');
  var c = document.getElementById('edtCount');
  if (!t || !c) return;
  var v = t.value;
  var lines = v ? v.split('\\n').length : 0;
  var words = v ? (v.match(/[A-Za-z0-9_]+/g) || []).length : 0;
  var sel = 0;
  try { sel = Math.max(0, t.selectionEnd - t.selectionStart); } catch (e) {}
  var parts = [lines + ' 行', v.length + ' 字符'];
  if (words) parts.push(words + ' 单词');
  if (sel) parts.push('已选 ' + sel + ' 字符');
  c.textContent = parts.join(' · ');
}

// 只改行号槽的"当前行"高亮，不重建 DOM
function paintGutCur(){
  var t = document.getElementById('edt');
  var gi = document.getElementById('edGutterIn');
  if (!t || !gi) return;
  var cur = -1;
  try { cur = t.value.slice(0, t.selectionStart).split('\\n').length - 1; } catch (e) { return; }
  var nums = gi.children;
  for (var i = 0; i < nums.length; i++){
    var on = (i === cur);
    if (nums[i].classList.contains('cur') !== on) nums[i].classList.toggle('cur', on);
  }
}

// ===== 文件内容缓存：打开过的文件留在内存里，重复打开瞬时 =====
// 为什么需要：read 每次都是"浏览器 → 边缘 → R2"的一次完整网络往返，
// 真实网络里小文件 150~300ms、大文件 300~800ms —— 这才是"点文件不够丝滑"的主因
// （实测前端渲染 669KB 也只要 ~17ms，浏览器侧根本不吃时间）。
// 策略：LRU（按字节封顶 + 条数封顶），命中先秒出内容，**同时后台拿 ETag 校验**，
// 真变了才热替换并提示 —— 既快又不会看到过期内容。
var fileCache = {
  map: {},            // path -> { text, enc, etag, bytes }
  order: [],          // LRU：末尾最新
  bytes: 0,
  cap: 8 * 1024 * 1024,
  maxItems: 30
};

function fileCacheGet(path){
  var e = fileCache.map[path];
  if (!e) return null;
  var i = fileCache.order.indexOf(path);
  if (i >= 0){ fileCache.order.splice(i, 1); fileCache.order.push(path); }
  return e;
}
function fileCachePut(path, text, enc, etag){
  if (!path || text == null) return;
  var old = fileCache.map[path];
  if (old) fileCache.bytes -= old.bytes;
  var bytes = text.length * 2;      // JS 字符串按 2 字节/字符粗算
  fileCache.bytes += bytes;
  fileCache.map[path] = { text: text, enc: enc || '', etag: etag || '', bytes: bytes };
  var i = fileCache.order.indexOf(path);
  if (i >= 0) fileCache.order.splice(i, 1);
  fileCache.order.push(path);
  // 淘汰：条数或字节超限时，从最久未用的开始丢（当前正在看的那个永不丢）
  while ((fileCache.order.length > fileCache.maxItems || fileCache.bytes > fileCache.cap) && fileCache.order.length > 1){
    var victim = fileCache.order[0];
    if (victim === ed.path) break;
    fileCache.order.shift();
    var v = fileCache.map[victim];
    if (v){ fileCache.bytes -= v.bytes; delete fileCache.map[victim]; }
  }
}
function fileCacheDel(path){
  var v = fileCache.map[path];
  if (!v) return;
  fileCache.bytes -= v.bytes;
  delete fileCache.map[path];
  var i = fileCache.order.indexOf(path);
  if (i >= 0) fileCache.order.splice(i, 1);
}
// 删除 / 改名 / 移动一个目录后，把该目录下的缓存一并清掉
function fileCacheDelPrefix(dir){
  if (!dir){ fileCache.map = {}; fileCache.order = []; fileCache.bytes = 0; return; }
  var pre = dir + '/';
  var keys = Object.keys(fileCache.map);
  for (var i = 0; i < keys.length; i++){
    if (keys[i] === dir || keys[i].indexOf(pre) === 0) fileCacheDel(keys[i]);
  }
}

// 后台校验：拿缓存里的 ETag 问一次"变了没"。304 就静默；变了才更新缓存，
// 并且只在用户还停在这个文件、且他自己没改过时，才热替换编辑器内容。
function revalidateFile(rel, cached){
  var init = { cache: 'no-store' };
  if (cached && cached.etag) init.headers = { 'If-None-Match': cached.etag };
  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel), init)
    .then(function(r){
      if (r.status === 304) return null;                  // 没变，缓存继续有效
      if (!r.ok) return null;
      var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
      var etag = r.headers ? (r.headers.get('ETag') || '') : '';
      return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
    })
    .then(function(o){
      if (!o) return;
      fileCachePut(rel, o.t, o.enc, o.etag);
      var t = document.getElementById('edt');
      if (ed.path === rel && !ed.dirty && t && t.value !== o.t){
        t.value = o.t;
        updateCount(); syncGutter(); paintEdSeg(); renderHl();
        setStatus('已载入 · 已在别处更新，已刷新为最新内容');
        toast('该文件已在别处更新，已刷新');
      }
    })
    .catch(function(){});
}

// 只读查看器的后台校验：缓存先秒出，再问一次 ETag 是不是过期。
// 单独一份（不复用 revalidateFile）是因为这里只重画查看器，不碰编辑器的 DOM。
function revalidateViewer(rel, cached){
  var init = { cache: 'no-store' };
  if (cached && cached.etag) init.headers = { 'If-None-Match': cached.etag };
  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel), init)
    .then(function(r){
      if (r.status === 304) return null;                  // 没变，缓存继续有效
      if (!r.ok) return null;
      var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
      var etag = r.headers ? (r.headers.get('ETag') || '') : '';
      return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
    })
    .then(function(o){
      if (!o) return;
      fileCachePut(rel, o.t, o.enc, o.etag);
      // 用户已经切到别的文件、或内容其实没变，就不动界面（避免白白重渲染大页面）
      if (ed.path !== rel || viewerText === o.t) return;
      paintViewerContent(rel, o.t, o.enc, '已载入 · 已在别处更新，已刷新为最新内容');
    })
    .catch(function(){});
}

// ===== 悬停预取（桌面端）：鼠标在文件上停 130ms 就把内容取回来 =====
// 这样点下去时缓存已经命中，**连第一次打开都是瞬时的**。
// 触屏设备没有 hover，直接跳过（用 hover:none + pointer:coarse 判断，
// 与样式表里 #btnUpDir 的写法保持一致）。
var pfTimer = null, pfPath = '', pfBusy = 0;
function prefetchFile(path){
  if (!path || RO) return;
  try {
    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  } catch (e) {}
  if (fileCacheGet(path)) return;
  if (path === pfPath && pfTimer) return;
  clearTimeout(pfTimer);
  pfPath = path;
  pfTimer = setTimeout(function(){
    pfTimer = null;
    if (pfBusy >= 2) return;                 // 最多 2 个预取并行，别和用户真正要的请求抢带宽
    pfBusy++;
    req(BASE + '/api?action=read&path=' + encodeURIComponent(path))
      .then(function(r){
        if (!r.ok) return null;
        var len = parseInt(r.headers.get('Content-Length') || '0', 10);
        if (len && len > 262144) return null;   // 只预取小文本，避免白耗流量
        var enc = r.headers.get('X-Text-Encoding') || '';
        var etag = r.headers.get('ETag') || '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      })
      .then(function(o){
        if (o && o.t.length <= 262144) fileCachePut(path, o.t, o.enc, o.etag);
      })
      .catch(function(){})
      .then(function(){ pfBusy--; });
  }, 130);
}

function renderEdContent(rel, name, text, enc, fromCache){
  ed.path = rel; ed.name = name; ed.dirty = false;
  updPubBtn();                  // 换了文件 → 「发布」按钮按新路径重判（缓存命中的路径不走 renderEditOps 之后那步）
  var t = document.getElementById('edt');
  t.value = text;
  ed.savedText = text;          // 载入的就是"与云端一致的基线"，之后只跟它比
  t.classList.remove('edt-loading');
  t.style.fontSize = edFont + 'px';
  updateCount();
  setStatus(enc && enc !== 'utf-8'
    ? ('已载入 · 原编码 ' + enc + '，保存后将转为 UTF-8')
    : (fromCache ? '已载入（内存缓存）' : '已载入'));
  refreshTreeSel();
  syncGutter();
  paintEdSeg();
  renderHl();                       // 正文换了，网址链接要跟着重画
  // Markdown 大纲解析对长文有成本，且不是首屏必需 —— 延后一帧，
  // 让正文先完整呈现（打开更"跟手"）；期间切换了文件就不再跑
  setTimeout(function(){ if (ed.path === rel && !ed.preview) mdOutline(); }, 0);
  // 从搜索结果打开的文件：把搜索词带进来高亮，直接回答"这个词在文里哪一处"。
  // 深搜跳行（pendingGoLine）优先 —— 那时光标已经定位到用户点的那一行，
  // 别让"滚到第一处"把滚动位置抢走，所以只在没有待跳行时才自动滚动。
  if (searchState && searchState.terms && searchState.terms.length && !ed.preview){
    try {
      highlightSearchTerms(searchState.terms, {
        scroll: pendingGoLine == null,
        word: !!(searchState.pq && searchState.pq.word)
      });
    } catch (e) {}
  }
  // 深搜结果点击跳行：文件载入完成后把光标/滚动定位到那一行。
  // 这是用户主动点击的结果，这里 focus 是符合预期的（不同于打开文件时的静默）。
  if (pendingGoLine != null){
    var goLn = pendingGoLine; pendingGoLine = null;
    try { editorGoLine(goLn); } catch (e) {}
  }
  offerDraft(rel, text);
}

function openEditor(name){
  var rel = joinPath(state.path, name);
  // 换文件先把上一次的预览/查找状态收干净
  ed.preview = false;
  var pv = document.getElementById('edPrev');
  if (pv){ pv.hidden = true; pv.innerHTML = ''; }
  var row = document.getElementById('edRow');
  if (row) row.hidden = false;
  closeFind(true);          // 只清状态，不抢焦点（手机上会弹键盘）

  // —— 缓存命中：0 等待，立即渲染，后台再校验 ——
  var cached = fileCacheGet(rel);
  if (cached){
    setStatus('载入中…');
    switchView('edit');
    renderEdCrumb(rel);
    renderEditOps(name);
    var t0 = document.getElementById('edt');
    t0.classList.remove('edt-loading');
    renderEdContent(rel, name, cached.text, cached.enc, true);
    revalidateFile(rel, cached);
    return;
  }

  setStatus('载入中…');
  switchView('edit');
  renderEdCrumb(rel);            // 此刻 ed.path 还没赋值，直接把目标路径传进去
  var tedEl = document.getElementById('edt');
  tedEl.value = '';
  tedEl.classList.add('edt-loading');   // 半透明 = "正在取内容"，而不是"卡住了"
  document.getElementById('edtCount').textContent = '0 行';
  document.getElementById('edPrev') && (document.getElementById('edPrev').hidden = true);
  renderEditOps(name);
  paintEdSeg(name);

  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel))
    .then(function(r){
      if (r.ok){
        var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
        var etag = r.headers ? (r.headers.get('ETag') || '') : '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      }
      return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error(d.error || ('HTTP ' + r.status)); });
    })
    .then(function(o){
      fileCachePut(rel, o.t, o.enc, o.etag);      // 存进缓存，下次打开就是瞬时的
      renderEdContent(rel, name, o.t, o.enc, false);
    })
    .catch(function(e){
      var t = document.getElementById('edt');
      if (t) t.classList.remove('edt-loading');
      setStatus('打开失败：' + e.message);
      toast('打开失败：' + e.message);
    });
}

// 悬停预取的委托绑定：树节点、搜索结果（都带 data-openpath）、列表行都覆盖
document.addEventListener('mouseover', function(e){
  var t = e.target;
  if (!t || !t.closest) return;
  var node = t.closest('[data-openpath]');
  if (node){ prefetchFile(node.getAttribute('data-openpath')); return; }
  var tr = t.closest('#list tbody tr');
  if (tr){
    var a = tr.querySelector('a[data-open]');
    if (a && a.getAttribute('data-type') !== 'dir'){
      prefetchFile(joinPath(state.path, a.getAttribute('data-open')));
    }
  }
}, true);
document.addEventListener('mouseout', function(){
  if (pfTimer){ clearTimeout(pfTimer); pfTimer = null; pfPath = ''; }
}, true);

// 打开文件时如果本地还留着未保存的草稿，问一下要不要恢复
function offerDraft(rel, serverText){
  var d = loadDraft(rel);
  if (!d || d.t === serverText) return;
  var when = '';
  try { when = fmtTime(new Date(d.at).toISOString()); } catch (e) { when = ''; }
  showModal({
    title: '发现未保存的草稿', small: true, okText: '恢复草稿', cancelText: '用云端版本',
    body: '<div class="msg">「' + E(rel.split('/').pop()) + '」在本地有一份' + (when ? ('（' + E(when) + '）') : '') +
      '还没保存的修改，比云端版本' + (d.t.length > serverText.length ? '更长' : '不同') + '。<br>要恢复吗？</div>',
    onOk: function(){
      var t = document.getElementById('edt');
      t.value = d.t;
      ed.dirty = true;
      updateCount(); syncGutter(); mdOutline(); renderHl();
      setStatus('已恢复本地草稿（尚未保存）');
      toast('已恢复草稿，记得点保存');
    },
    after: function(){
      var cancel = document.getElementById('mCancel');
      if (cancel) cancel.onclick = function(){ clearDraft(rel); closeModal(); };
    }
  });
}

function renderEditOps(name){
  var rel = joinPath(state.path, name);
  var h = '<button class="btn sm" id="edDl">下载</button>';
  if (!RO){
    h += '<button class="btn sm" id="edShare">分享</button>';
    h += '<button class="btn sm" id="edRename">重命名</button>';
    h += '<button class="btn sm" id="edMove">移动</button>';
    h += '<button class="btn sm" id="edDel">删除</button>';
  }
  h += '<button class="btn sm ghost" id="edBack">返回列表</button>';
  document.getElementById('editOps').innerHTML = h;
  document.getElementById('edDl').onclick = function(){ location.href = dlUrl(name, rel); };
  document.getElementById('edBack').onclick = function(){ tryLeaveEditor(function(){ load(state.path); }); };
  if (!RO){
    // 直接开分享弹窗（与列表行上的「分享」完全一致），点开就能生成链接。
    // 以前这里只是滚动到下方的"分享设置"面板 —— 用户点完以为没反应，还得自己往下找。
    document.getElementById('edShare').onclick = function(){ openShareModal(rel, false); };
    document.getElementById('edRename').onclick = function(){ openRename(rel, false); };
    document.getElementById('edMove').onclick = function(){ openMove(rel, false); };
    document.getElementById('edDel').onclick = function(){ doDelete(rel, false); };
    // 「发布」按钮的可用状态。路径要显式传进去：此刻 ed.path 还是上一个文件。
    // 顺手把分享列表刷成最新的（15 秒 TTL 内不会重复请求），拉回来后再判一次。
    updPubBtn(rel);
    refreshShareCache(false).then(function(){ updPubBtn(rel); }, function(){ updPubBtn(rel); });
  }
}

function tryLeaveEditor(go){
  if (!ed.dirty) { ed.dirty = false; return go(); }
  showModal({
    title: '还有未保存的修改',
    small: true,
    okText: '放弃修改',
    cancelText: '继续编辑',
    body: '<div class="msg">「' + E(ed.name) + '」的修改还没保存，确定要离开吗？</div>',
    onOk: function(){ ed.dirty = false; go(); }
  });
}

// ---- 发布状态（会话内）----
// pubSynced[path] 记录"影子树里那份是不是就是草稿当前内容"，
//   三态：true 一致（无需发布）/ false 有改动待发布 / undefined 还不知道（按需向服务端问一次）。
//   为什么不只靠本地记：刷新页面后本地记录全丢，按钮会错误地变回"可点"——
//   而"一个字没改也能发布"正是要修掉的问题，所以必须有一个从服务端读回来的确定答案。
var pubSynced = {};
var pubSyncedAsked = {};
function forgetPubSynced(){ pubSynced = {}; pubSyncedAsked = {}; }
function hhmm(){ return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function isSharedPath(p){
  if (RO || !p) return false;
  if (shareCount(p)) return true;
  var segs = p.split('/');
  for (var i = segs.length - 1; i > 0; i--){ if (shareCount(segs.slice(0, i).join('/'))) return true; }
  return false;
}
function pubSuffix(p){
  return (p && !RO && isSharedPath(p) && pubSynced[p] === false) ? ' · 待发布' : '';
}

// 只在"还不知道"（undefined）时才问服务端，同一个路径最多问一次。
// 结果只有 true / false 会被记下；null（对象太多判断不了）保持未知 → 按钮照旧可点，不误拦。
// 本地一旦拿到确定答案（保存 → false、发布 → true）就不再重复请求，避免每次渲染都打接口。
// 还有一层省请求：某个上级目录在最近的分享列表里确认过"整目录已同步"，
// 那么里面的文件必然也同步（同一份比对的子集），直接采用结论、不发请求。
function askPubSynced(path){
  if (!path || RO) return;
  if (pubSynced[path] !== undefined || pubSyncedAsked[path]) return;
  var segs = path.split('/');
  for (var i = segs.length - 1; i > 0; i--){
    if (pubSynced[segs.slice(0, i).join('/')] === true){ pubSynced[path] = true; return; }
  }
  pubSyncedAsked[path] = 1;
  post({ action: 'pubState', items: [{ path: path, isDir: false }] }).then(function(d){
    var v = (d && d.ok && d.states) ? d.states[path] : undefined;
    if (v === true || v === false) pubSynced[path] = v;
    if (ed.path === path) updPubBtn(path);
  }).catch(function(){});
}

// 「发布」按钮的可用状态。两种情况都该置灰：
//   ① 这个文件根本不会被分享页看到（自身没链接、也不在任何已分享目录里）—— 发布了也没人读；
//   ② 内容与分享页当前那份完全一致 —— 再发布一次什么都不会变，纯属白写一次 R2。
// 两者都不成立才让点。置灰时说明原因，并把「分享」提成主按钮，
// 免得留下一个"看得到却点不动、也不知道为什么"的死按钮。
// 分享列表还没拉到之前不改动按钮状态：宁可保持原样，也不要给一个假的置灰。
// p 传了就用 p（renderEditOps 里 ed.path 还没赋值），否则用当前编辑的文件。
function updPubBtn(p){
  if (RO) return;
  var btn = document.getElementById('btnSave');
  if (!btn) return;
  if (!shareCache.loaded) return;
  var path = (p == null ? ed.path : p);
  var shared = !!(path && isSharedPath(path));
  // 「有未保存的改动」也算有改动：此时影子树里那份虽然与"已保存的草稿"一致，
  // 但编辑器里还有东西没发布出去，按钮必须可点（否则用户无从把改动推上去）。
  var dirtyNow = !!(path === ed.path && ed.dirty);
  var synced = shared && !dirtyNow && pubSynced[path] === true;
  btn.disabled = !shared || synced;
  btn.title = !shared
    ? '这个文件还没有分享链接（也不在任何已分享的目录里），发布出去没人能看到 —— 先点右侧「分享」创建链接'
    : (synced
      ? '内容与分享页当前一致，没有需要发布的变化'
      : '把当前文件发布到分享页；编辑会随时自动保存（Ctrl+S 也可立即保存）');
  var sh = document.getElementById('edShare');
  if (sh) sh.className = shared ? 'btn sm' : 'btn sm primary';
  if (shared) askPubSynced(path);       // 还不知道改没改 → 问一次服务端
}

// ---- 保存到服务器（自动保存 / Ctrl+S / 发布前保存 共用）----
// 串行化：每次保存都排在上一次之后 —— 两次请求乱序时，旧响应不会把新内容盖回去。
// 取的是**执行时**的文本框内容，所以排队期间又敲的字会被最后一次一起存上。
var savePromise = Promise.resolve();
function saveEd(auto){
  if (RO) return Promise.resolve();
  var t = document.getElementById('edt');
  if (!t || !ed.path) return Promise.resolve();
  var run = function(){
    if (RO || !ed.path) return Promise.resolve();
    var myPath = ed.path, myVal = t.value;
    // 【省请求的关键一步】正文和基线完全一致 → 什么都没改，直接把脏标撤掉。
    // 典型场景：打了个错字又删掉、Ctrl+Z 撤销回原样、复制粘贴再撤销。
    // 这些操作在旧逻辑下都会白白发一次 PUT（连带重写整份搜索索引），现在一个请求都不发。
    // savedText 为 null = 从没建立过基线（理论上不该发生），保守起见照常存。
    if (ed.savedText !== null && myVal === ed.savedText){
      ed.dirty = false;
      setStatus('未修改 ' + hhmm());
      return Promise.resolve();
    }
    var btn = document.getElementById('btnSave');
    if (btn) btn.disabled = true;
    setStatus('保存中…');
    return req(BASE + '/api?path=' + encodeURIComponent(myPath), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: myVal
    }).then(function(r){
      if (r.ok) return r.json();
      return r.text().then(function(x){ throw new Error(x); });
    }).then(function(){
      var same = (ed.path === myPath && t.value === myVal);   // 保存期间又改了 → 别清脏标
      if (same){ ed.dirty = false; ed.savedText = myVal; }     // 基线推进到刚存的内容
      // 草稿刚被改写 → 影子树里那份立刻过时。写成 false（而不是删掉）是刻意的：
      // "确定有改动"比"不知道"更强，别让下一次 askPubSynced 把按钮又问回可点。
      pubSynced[myPath] = false;
      clearDraft(myPath);                                     // 存成功了就把本地草稿清掉
      fileCachePut(myPath, myVal, 'utf-8', '');               // 缓存同步成刚保存的内容（etag 置空，下次会重新取回）
      if (same) setStatus('已保存 ' + hhmm() + pubSuffix(myPath));
      if (!auto && same) toast('已保存');
      // 刻意**不**在这里重新拉 list：内容缓存已经同步，左栏要刷的话下次切目录/点刷新自然就准了。
      // 那次 list 是纯额外开销（一次 R2 list 操作），而自动保存是高频动作，省下来很值。
    }).catch(function(e){
      setStatus('保存失败');
      if (!auto) toast('保存失败：' + e.message);
    }).finally(function(){ updPubBtn(); });   // 不能在 finally 里无脑 disabled=false：未分享的文件要保持置灰
  };
  savePromise = savePromise.then(run, run);
  return savePromise;
}

// 发布当前文件：把草稿版本复制到影子树，分享页立刻可见。
// 有未保存改动时先保存再发布，避免"发布出去的是上一次的内容"。
// 只对"分享页看得见的路径"有意义（按钮平时已置灰，这里再兜一道底）。
function publishEd(){
  if (RO || !ed.path) return;
  var p = ed.path;
  // 分享列表已加载且这个路径确实没有任何链接 → 发布没有意义，直接引导去建链接
  if (shareCache.loaded && !isSharedPath(p)){
    updPubBtn();
    toast('这个文件还没有分享链接，先点「分享」创建');
    return;
  }
  // 没有未保存改动、而且与分享页当前那份完全一致 → 点发布什么都不会变。
  // 一个请求都不发，直接给反馈（服务端对同样的情况也会直接返回，这里是为了即时性）。
  if (!ed.dirty && pubSynced[p] === true){
    updPubBtn();
    toast('内容没有变化，无需发布');
    return;
  }
  var btn = document.getElementById('btnSave');
  var doPub = function(){
    if (btn) btn.disabled = true;
    setStatus('发布中…');
    return post({ action: 'publish', path: p, isDir: false })
      .then(function(d){
        if (!d.ok) throw new Error(d.error || '发布失败');
        pubSynced[p] = true;                    // 影子树刚被刷成当前内容
        setStatus('已发布 ' + hhmm());
        toast(d.unchanged ? '内容没有变化，无需发布' : '已发布到分享页');
      })
      .catch(function(e){ setStatus('发布失败'); toast('发布失败：' + e.message); })
      .finally(function(){ updPubBtn(); });     // 恢复成"按状态决定"而不是无脑可点
  };
  if (ed.dirty) saveEd(false).then(doPub, doPub);
  else savePromise.then(doPub, doPub);
}

function setFont(delta){
  edFont = Math.max(10, Math.min(28, edFont + delta));
  var t = document.getElementById('edt');
  var v = document.getElementById('zVal');
  if (t) t.style.fontSize = edFont + 'px';
  if (v) v.textContent = edFont;
  try { localStorage.setItem('cfwtxt_font', String(edFont)); } catch (e) {}
  var mm = document.getElementById('edMirror');
  if (mm) mm.style.fontSize = edFont + 'px';
  // 字号变了，行号定位与命中高亮的排版都要重算
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}

// ===== 分享面板（编辑器内 + 弹窗 复用同一套）=====
// 分享面板（编辑器内嵌 + 弹窗共用同一份）
// 注意：这里**不能用 id** —— 内联面板和弹窗会同时存在于文档里，
// 用 id 就会产生重复 id（无效 HTML，getElementById 还会取到错的那个）。
// 统一用 data-shrole，访问一律走 rootEl.querySelector，天然按实例隔离。
var SHR_TOKEN = '[data-shrole="token"]';
var SHR_EXP = '[data-shrole="exp"]';
var SHR_RESULT = '[data-shrole="result"]';
var SHR_LIST = '[data-shrole="list"]';
var SHR_QR = '[data-shrole="qr"]';

function sharePanelHtml(target, isDir){
  return '<div class="share-root" data-target="' + E(target || '') + '" data-isdir="' + (isDir ? 1 : 0) + '">' +
    '<div class="hint">口令即访问凭证：谁拿到链接都能看。' + (isDir ? '分享的是<b>整个目录</b>，对方可浏览和下载。' : '分享的是<b>单个文件</b>，打开就是正文。') +
    '可随时重新生成或取消，旧链接会立刻失效。</div>' +
    '<div class="shform">' +
    '<input type="text" data-shrole="token" placeholder="自定义 Token（留空则自动生成）" autocomplete="off">' +
    '<select data-shrole="exp">' +
    '<option value="0">永久有效</option>' +
    '<option value="3600">1 小时</option>' +
    '<option value="86400" selected>1 天</option>' +
    '<option value="604800">7 天</option>' +
    '<option value="2592000">30 天</option>' +
    '</select>' +
    '<button class="btn primary" data-shgen="1">生成 / 更新</button>' +
    '</div>' +
    '<div data-shrole="result" hidden></div>' +
    '<div data-shrole="list"></div>' +
    '</div>';
}

var openShareRoots = [];

// ===== 分享数据缓存 =====
// 有了这份缓存：① 弹窗一打开就能立刻列出已有链接（不再"先空后到"）
//                ② 列表/树/编辑器标题上能直接标出"哪些已经分享过"
var shareCache = { list: [], byPath: {}, loaded: false, at: 0, loading: null, pending: [], removed: [] };

function buildShareIndex(list){
  var m = {};
  for (var i = 0; i < list.length; i++){
    var s = list[i];
    var k = s.path || '';
    if (!m[k]) m[k] = [];
    m[k].push(s);
  }
  return m;
}
function shareCount(path){ return shareCache.byPath[path] ? shareCache.byPath[path].length : 0; }

// KV 是**最终一致**的：刚创建/刚取消的分享，立刻去 KV 读可能读到旧值（最长可延迟约 1 分钟）。
// 这就是"生成了链接但列表/分享管理不更新，刷新页面才看到"的根因。
// 所以本会话刚做的增删不依赖回读 —— 以乐观合并的方式叠加在缓存上，等 KV 追上来后自动让位：
//   pending  ：刚创建、KV 里可能还没有的  → 合并进列表
//   removed  ：刚取消、KV 里可能还没删掉的 → 从列表里过滤掉
function shareListMerged(){
  var list = shareCache.list;
  if (shareCache.removed.length){
    list = list.filter(function(s){ return shareCache.removed.indexOf(s.token) < 0; });
  }
  if (shareCache.pending.length){
    var have = {};
    for (var i = 0; i < list.length; i++) have[list[i].token] = 1;
    list = list.slice();
    for (var j = 0; j < shareCache.pending.length; j++){
      if (!have[shareCache.pending[j].token]) list.push(shareCache.pending[j]);
    }
  }
  return list;
}

// 列表 / 树 / 编辑器标题上的「已分享」标记
function shBadge(path, isDir){
  if (RO) return '';
  var n = shareCount(path);
  if (!n) return '';
  var nm = path.split('/').pop();
  return '<button class="shbadge" data-act="share" data-name="' + E(nm) + '" data-dir="' + (isDir ? 1 : 0) +
    '" title="已有 ' + n + ' 条分享链接，点击查看">' + ICON_LINK + '已分享' +
    (n > 1 ? ' ' + n : '') + '</button>';
}
function shDot(path){
  if (RO) return '';
  var n = shareCount(path);
  if (!n) return '';
  return '<button class="shdot" data-shgo="' + E(path) + '" title="已有 ' + n + ' 条分享链接，点击打开">' + ICON_LINK + '</button>';
}

// 目录树里的 🔗 一点直达分享链接：只有 1 条就新标签直接打开；多条就弹分享面板任选一条。
// 缓存还没就绪（极少见）就先刷一次再决定；刷新很快，仍在用户手势窗口内，一般不会被拦截。
function openSharedLink(path, retried){
  if (RO || !path) return;
  var arr = shareCache.byPath[path] || [];
  if (!arr.length){
    if (retried){ toast('没有找到可用的分享链接（可能刚被取消）'); return; }
    refreshShareCache(true).then(function(){ openSharedLink(path, true); });
    return;
  }
  if (arr.length === 1){ window.open(shareUrlOf(arr[0]), '_blank'); return; }
  openShareModal(path, arr[0] && arr[0].kind === 'dir');
}

function syncShareMgr(){
  var b = document.getElementById('btnShareMgr');
  if (!b) return;
  var n = shareListMerged().length;
  b.textContent = n ? '分享管理 (' + n + ')' : '分享管理';
}

// 缓存变化后，把所有显示分享状态的地方同步一遍（只读缓存，不再发请求，避免循环）。
// 列表和目录树都是整块 innerHTML 重建，开销不小；而这里被调用的时机很多 ——
// 每次拉回分享列表都来一遍（15 秒 TTL 一过，打开一次编辑器就是一次）。
// 绝大多数调用其实**什么都没变**。所以先用一个轻量签名判断"分享状态真的变了吗"：
// 没变就只更新按钮状态，不重建列表 / 目录树 / 面板 —— 既省掉无谓的重排，
// 也避免用户正看着的目录树和分享管理弹窗被背景刷新冲掉滚动位置。
var lastShareSig = null;
function shareSig(){
  var l = shareListMerged(), s = '';
  for (var i = 0; i < l.length; i++){
    var it = l[i];
    s += it.token + ':' + (it.published ? 1 : 0) + ':' +
      (it.synced === true ? 'y' : it.synced === false ? 'n' : '?') + ';';
  }
  return s;
}
function applyShareUi(){
  var sig = shareSig();
  var changed = sig !== lastShareSig;
  lastShareSig = sig;
  syncShareMgr();
  if (!changed){ updPubBtn(); return; }
  if (state.view === 'list') renderList();
  renderSide();
  var c = document.getElementById('edCrumb');
  if (c && state.view === 'edit' && ed.path) renderEdCrumb();
  refreshSharePanels();
  if (mgrOpen) renderShareManager();
  updPubBtn();     // 新建/取消分享、列表拉回来 → 「发布」按钮的可用状态要跟着变
}

// 拉取分享列表（服务端会顺手自愈清理失效记录）
function refreshShareCache(force){
  if (RO) return Promise.resolve(shareCache);
  if (shareCache.loading) return shareCache.loading;
  if (!force && shareCache.loaded && (Date.now() - shareCache.at) < 15000) return Promise.resolve(shareCache);
  shareCache.loading = post({ action: 'shares' }).then(function(d){
    shareCache.loading = null;
    if (!d || !d.ok) return shareCache;
    shareCache.list = d.shares || [];
    // KV 追上来的不再乐观显示；还没追上来的继续显示
    shareCache.pending = shareCache.pending.filter(function(p){
      for (var i = 0; i < shareCache.list.length; i++){
        if (shareCache.list[i].token === p.token) return false;
      }
      return true;
    });
    shareCache.removed = shareCache.removed.filter(function(tk){
      for (var i = 0; i < shareCache.list.length; i++){
        if (shareCache.list[i].token === tk) return true;   // KV 里还在 → 继续隐藏
      }
      return false;                                          // KV 已经删掉 → 不用再隐藏
    });
    shareCache.byPath = buildShareIndex(shareListMerged());
    // 顺带把服务端给出的一致性结论记进本地（分享面板与右键菜单据此置灰「发布」）。
    // 只在"还不知道"时写入：本地刚保存过（有确定答案）不被这次回读覆盖掉，
    // 避免一个先发出、后返回的列表请求把"刚改过"的结论又抹成"没改过"。
    for (var si = 0; si < shareCache.list.length; si++){
      var rec2 = shareCache.list[si];
      if (rec2 && rec2.path && pubSynced[rec2.path] === undefined &&
          (rec2.synced === true || rec2.synced === false)){
        pubSynced[rec2.path] = rec2.synced;
      }
    }
    shareCache.loaded = true;
    shareCache.at = Date.now();
    applyShareUi();
    if (d.cleaned) toast('已自动清理 ' + d.cleaned + ' 个失效的分享链接');
    return shareCache;
  }).catch(function(){
    shareCache.loading = null;
    return shareCache;
  });
  return shareCache.loading;
}

// 做过增删改之后强制刷一次（新建/取消分享、删除、移动之后）
function reloadShares(){ return refreshShareCache(true); }

function mountShare(rootEl, target, isDir){
  if (!rootEl) return;
  if (target == null) target = rootEl.getAttribute('data-target') || '';
  rootEl.innerHTML = sharePanelHtml(target, isDir);
  if (openShareRoots.indexOf(rootEl) < 0) openShareRoots.push(rootEl);
  rootEl.setAttribute('data-target', target || '');
  loadShareList(rootEl);
  var tk = rootEl.querySelector(SHR_TOKEN);
  if (tk) tk.onkeydown = function(e){ if (e.key === 'Enter') { e.preventDefault(); doShare(target, isDir, rootEl); } };
}

function refreshSharePanels(){
  for (var i = 0; i < openShareRoots.length; i++){
    var el = openShareRoots[i];
    if (el && el.isConnected) renderShareList(el);
  }
}

// 打开面板：先用缓存同步渲染（链接和弹窗一起出现），再后台确认一次
function loadShareList(rootEl){
  renderShareList(rootEl);
  refreshShareCache(false).then(function(){ renderShareList(rootEl); });
}

// 分享行的「发布状态」标签：影子树里有 = 已发布，只有草稿 = 待发布。
// 前端不自己猜状态，直接用 shares 接口返回的 published 字段。
function pubTag(s){
  if (!s.published) return '<span class="tag warn" title="分享页暂时看不到：内容只在管理后台，还没点发布">待发布</span>';
  if (s.synced === true) return '<span class="tag pub" title="分享页显示的就是当前版本，没有未发布的改动">已发布 · 无改动</span>';
  return '<span class="tag pub" title="分享页显示的是已发布的版本，改动要点发布才生效">已发布</span>';
}

// 分享行的操作按钮组（分享面板 / 分享管理共用，避免两处长得不一样）
function shRowOps(s, u){
  var p = s.path || '';
  var d = s.kind === 'dir' ? 1 : 0;
  // 与影子树里那份一致（synced）→ 再点发布不会有任何变化，置灰并说明原因
  var sync = s.synced === true;
  return '<div class="hop">' +
    '<button class="op pub" data-shpub="' + E(p) + '" data-shdir="' + d + '"' +
      (sync ? ' disabled title="内容与分享页当前一致，没有需要发布的变化"'
            : ' title="把当前版本复制到分享页"') +
      '>发布</button>' +
    (s.published ? '<button class="op unpub" data-shunpub="' + E(p) + '" data-shdir="' + d +
      '" title="分享页先隐藏，草稿和链接都保留">撤回</button>' : '') +
    '<button class="op" data-shcopy="' + E(u) + '">复制</button>' +
    '<button class="op iconb" data-shopen="' + E(u) + '" title="打开">' + ICON_OPEN + '</button>' +
    '<button class="op del" data-shdel="' + E(s.token) + '">取消</button></div>';
}

function renderShareList(rootEl){
  var el = rootEl.querySelector(SHR_LIST);
  if (!el) return;
  if (!shareCache.loaded){
    el.innerHTML = '<div class="hint dim" style="margin-top:12px">正在读取已有分享…</div>';
    return;
  }
  var target = rootEl.getAttribute('data-target') || '';
  var isDir = rootEl.getAttribute('data-isdir') === '1';
  var mine = shareCache.byPath[target] || [];

  if (!mine.length){
    el.innerHTML = '<div class="hint dim" style="margin-top:12px">这个' + (isDir ? '目录' : '文件') +
      '还没有分享链接。</div>';
    return;
  }
  var h = '<div class="hint dim" style="margin:10px 0 0">这个' + (isDir ? '目录' : '文件') +
    '已有 <b>' + mine.length + '</b> 条链接。改动会自动存进后台，点「发布」才更新分享页：</div><div class="shares">';
  for (var i = 0; i < mine.length; i++){
    var s = mine[i];
    var u = shareUrlOf(s);
    var expTag = s.exp ? '<span class="tag warn">' + leftTime(s.exp - Date.now()) + '</span>' : '<span class="tag">永久</span>';
    h += '<div class="shrow"><div class="shmeta">' + pubTag(s) + expTag +
      '<span class="shpath">' + E(u) + '</span></div>' + shRowOps(s, u) + '</div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

// ===== 分享管理：一眼看到"哪些文件/目录已经有链接" =====
var mgrOpen = false;
function openShareManager(){
  showModal({
    title: '分享管理', cancelText: '关闭', noOk: true,
    body: '<div id="mgrBody"></div>',
    after: function(){
      mgrOpen = true;
      renderShareManager();
      refreshShareCache(false).then(renderShareManager);
    }
  });
}

function renderShareManager(){
  var el = document.getElementById('mgrBody');
  if (!el){ mgrOpen = false; return; }
  if (!shareCache.loaded){ el.innerHTML = '<div class="hint dim">正在读取已有分享…</div>'; return; }
  var list = shareListMerged();
  if (!list.length){
    el.innerHTML = '<div class="hint dim">还没有任何分享链接。在文件或文件夹上点「分享」就能生成。</div>';
    return;
  }
  var groups = {}, order = [];
  for (var i = 0; i < list.length; i++){
    var k = list[i].path || '';
    if (!groups[k]){ groups[k] = []; order.push(k); }
    groups[k].push(list[i]);
  }
  var h = '<div class="hint dim">共 <b>' + list.length + '</b> 条链接，覆盖 <b>' + order.length +
    '</b> 个文件 / 目录。点条目上的「复制」可复制链接；点 <b>◎ 定位</b> 可跳到该' +
    '文件在网盘中的位置（文件会直接打开，可编辑）。</div>';
  // 存量分享可能一条都没发布过（老版本没有影子树），给一个一键补发
  var waitPub = 0;
  for (var w = 0; w < list.length; w++){ if (!list[w].published) waitPub++; }
  if (waitPub){
    h += '<div class="hint dim" style="margin:8px 0 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span>有 <b>' + waitPub + '</b> 条还没发布到分享页。</span>' +
      '<button class="btn sm" data-shpuball="1">全部发布</button></div>';
  }
  for (var g = 0; g < order.length; g++){
    var path = order[g], arr = groups[path];
    h += '<div class="mgrGrp"><div class="mgrHead"><span class="tag">' + (arr[0].kind === 'file' ? '文件' : '目录') +
      '</span><span class="mgrPath" title="该分享对应的目标路径">' + E(path || '根目录') + '</span>' +
      (path ? '<button class="op iconb mgrLocate" data-shlocate="' + E(path) + '" data-shlocdir="' +
        (arr[0].kind === 'file' ? 0 : 1) + '" title="定位到这个' + (arr[0].kind === 'file' ? '文件' : '目录') +
        '（文件会直接打开，可编辑）">' + ICON_LOCATE + '</button>' : '') + '</div>';
    for (var j = 0; j < arr.length; j++){
      var s = arr[j], u = shareUrlOf(s);
      h += '<div class="shrow"><div class="shmeta">' + pubTag(s) +
        (s.exp ? '<span class="tag warn">' + leftTime(s.exp - Date.now()) + '</span>' : '<span class="tag">永久</span>') +
        '<span class="shpath">' + E(u) + '</span></div>' + shRowOps(s, u) + '</div>';
    }
    h += '</div>';
  }
  el.innerHTML = h;
}

// 链接里的文件名：显示/复制用「可读版」，功能用「编码版」
// 可读版把中文等多字节字符还原成人能看懂的字，同时保留空格 %20、# %23 这类必要的转义
function prettySeg(name){
  return encodeURIComponent(name).replace(/(?:%[89A-F][0-9A-F])+/gi, function(run){
    try { return decodeURIComponent(run); } catch (e) { return run; }
  });
}

function shareNameSuffix(path, kind, pretty){
  if (kind !== 'file' || !path) return '';
  var name = path.split('/').pop();
  return '/' + (pretty ? prettySeg(name) : encodeURIComponent(name));
}

// 给人看 / 给人复制：https://x/s/token/菜鸟.txt
function shareUrlPretty(token, path, kind){
  return location.origin + '/s/' + token + shareNameSuffix(path, kind, true);
}
// 全 ASCII，塞进二维码最稳妥：https://x/s/token/%E8%8F%9C%E9%B8%9F.txt
function shareUrlRaw(token, path, kind){
  return location.origin + '/s/' + token + shareNameSuffix(path, kind, false);
}

function shareUrlOf(s){ return shareUrlPretty(s.token, s.path, s.kind); }

// 从分享管理跳回文件系统：定位到目标所在目录；
// 是文件的话直接打开（编辑器 / 预览），用户马上就能继续编辑。
// 目标可能已经被移动或删除（分享记录有自愈延迟），找不到时明确提示，不静默失败。
function locateShared(path, isDir){
  closeModal();
  var dir = isDir ? path : path.split('/').slice(0, -1).join('/');
  var name = isDir ? '' : path.split('/').pop();
  load(dir).then(function(){
    if (isDir){
      toast('已定位到「' + (dir || '根目录') + '」');
      return;
    }
    var stillThere = false;
    for (var i = 0; i < state.files.length; i++){
      if (state.files[i].name === name){ stillThere = true; break; }
    }
    if (stillThere) openFile(name);
    else toast('「' + name + '」可能已被移动或删除，已定位到所在目录');
  });
}

function leftTime(ms){
  if (ms <= 0) return '已过期';
  var m = Math.floor(ms / 60000);
  if (m < 60) return '剩余 ' + m + ' 分钟';
  var h = Math.floor(m / 60);
  if (h < 24) return '剩余 ' + h + ' 小时';
  return '剩余 ' + Math.floor(h / 24) + ' 天';
}

function doShare(target, isDir, rootEl){
  var tk = rootEl.querySelector(SHR_TOKEN);
  var ex = rootEl.querySelector(SHR_EXP);
  var btn = rootEl.querySelector('button[data-shgen]');
  if (btn) btn.disabled = true;
  post({ action: 'share', path: target, token: tk ? tk.value.trim() : '', expiresIn: ex ? (parseInt(ex.value, 10) || 0) : 0 })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      if (tk) tk.value = '';
      var kind = d.kind;
      var pretty = shareUrlPretty(d.token, d.path, kind);
      var raw = shareUrlRaw(d.token, d.path, kind);
      showShareResult(rootEl, pretty, raw, kind);
      copyText(pretty, true);          // 手势已过期，失败也不打扰用户（结果框里有「复制」按钮）
      // KV 写后读有延迟：不等回读，直接把这条分享乐观并进缓存，
      // 列表的「已分享」徽标和分享管理**立刻**出现，不用刷新页面
      var rec = { token: d.token, path: d.path, kind: d.kind, exp: d.exp || 0, at: Date.now(),
        published: d.published > 0,      // 建分享即发布；失败时先标"待发布"，回读会纠正
        // 刚才那次自动发布已经把当前版本复制过去了 → 与影子树一致（「发布」按钮据此置灰）。
        // 但发布失败时**不能**标成一致，否则按钮被置灰，用户连重试的入口都没有。
        synced: (d.published > 0 && !d.publishError) ? true : false };
      pubSynced[d.path] = rec.synced === true;
      shareCache.pending = shareCache.pending.filter(function(p){ return p.token !== d.token; });
      shareCache.removed = shareCache.removed.filter(function(tk){ return tk !== d.token; });
      shareCache.pending.push(rec);
      shareCache.byPath = buildShareIndex(shareListMerged());
      applyShareUi();
      reloadShares();                  // 后台再拉一次，KV 追上来后乐观数据自动让位
      // 链接建了但内容没复制过去（少见：R2 写失败/超大目录），必须说清楚，
      // 否则用户会拿着一个打不开的链接去发给别人。
      if (d.publishError) toast('链接已生成，但发布失败：' + d.publishError + '（分享页暂时打不开，可在分享面板重试发布）');
    })
    .catch(function(e){ toast('生成失败：' + e.message); })
    .finally(function(){ if (btn) btn.disabled = false; });
}

function showShareResult(rootEl, pretty, raw, kind){
  var box = rootEl.querySelector(SHR_RESULT);
  if (!box) return;
  box.hidden = false;
  var devHint = pretty === raw ? '' :
    '<button class="lnk" data-shresultcopy="' + E(raw) + '" title="全 ASCII 编码版，粘到命令行或老客户端里更保险">复制编码版</button>';
  box.innerHTML =
    '<div class="okbox">' +
    '<div class="okhead"><span>分享链接已生成</span><span class="sp"></span>' +
    '<button class="btn sm primary" data-shresultcopy="' + E(pretty) + '">复制</button></div>' +
    '<input class="linkbox" readonly data-linkbox="1" value="' + E(pretty) + '">' +
    '<div class="hint dim" style="margin-top:7px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<span>点击链接框即可复制' + (kind === 'file' ? '；用手机扫下面的二维码可直接打开' : '') + '</span>' +
    '<span class="sp" style="flex:1"></span>' + devHint +
    '</div>' +
    '<div class="qrbox"><div class="qr" data-shrole="qr"></div><div class="hint dim">扫码在手机上打开</div></div>' +
    '</div>';
  // 二维码用纯 ASCII 版本，避免部分扫码库对多字节字符支持不好
  renderQR(box.querySelector(SHR_QR), raw);
}

var qrQueue = [], qrLoading = false;
function renderQR(el, text){
  if (!el) return;
  var draw = function(){
    if (!window.QRCode) { el.innerHTML = '<div class="hint dim">二维码组件加载失败，请直接复制链接</div>'; return; }
    el.innerHTML = '';
    try { new QRCode(el, { text: text, width: 148, height: 148, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { el.innerHTML = '<div class="hint dim">链接过长，无法生成二维码</div>'; }
  };
  if (window.QRCode) { draw(); return; }
  qrQueue.push(draw);
  if (qrLoading) return;
  qrLoading = true;
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js';
  s.onload = function(){ qrLoading = false; var q = qrQueue; qrQueue = []; for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} } };
  s.onerror = function(){ qrLoading = false; qrQueue = []; el.innerHTML = '<div class="hint dim">二维码组件加载失败</div>'; };
  document.head.appendChild(s);
}

function openShareModal(target, isDir){
  showModal({
    title: '分享（只读）',
    cancelText: '关闭',
    noOk: true,
    body: '<div id="shareModalRoot"></div>',
    after: function(){ mountShare(document.getElementById('shareModalRoot'), target, isDir); }
  });
}

// 同步复制：手机上只有"在点击手势里同步调用 execCommand"才可靠
// （Clipboard API 需要用户激活状态，放到 await/then 之后就必然失败）
function copyViaExec(v){
  var ta = document.createElement('textarea');
  ta.value = v;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;' +
    'opacity:0;font-size:16px;z-index:-1';
  document.body.appendChild(ta);
  var ok = false;
  try {
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, v.length); } catch (e) {}
    ok = document.execCommand('copy');
  } catch (e) { ok = false; }
  try { document.body.removeChild(ta); } catch (e) {}
  return ok;
}

// 复制不了时给一条真能走通的路：链接全选 + 长按提示 + 系统分享
function manualCopy(v){
  showModal({
    title: '手动复制链接', small: true, noOk: true, cancelText: '关闭',
    body: '<div class="msg">链接已全选，在下面输入框里<b>长按 → 拷贝</b>即可。</div>' +
      '<input type="text" id="mcBox" readonly value="' + E(v) + '" style="margin-top:10px">' +
      '<div class="mcactions"><button class="btn primary" id="mcRetry">再试一次</button>' +
      (navigator.share ? '<button class="btn" id="mcShare">系统分享</button>' : '') +
      '</div>',
    after: function(){
      var box = document.getElementById('mcBox');
      var selAll = function(){ try { box.focus(); box.select(); box.setSelectionRange(0, v.length); } catch (e) {} };
      selAll();
      document.getElementById('mcRetry').onclick = function(){
        if (copyViaExec(v)){ toast('已复制到剪贴板'); closeModal(); }
        else { selAll(); toast('请长按输入框选择「拷贝」'); }
      };
      var sh = document.getElementById('mcShare');
      if (sh) sh.onclick = function(){
        try { navigator.share({ url: v }).catch(function(){}); } catch (e) {}
      };
    }
  });
}

// 统一入口：同步 execCommand → 异步 Clipboard API → 手动复制弹窗
function copyText(v, silent){
  if (copyViaExec(v)){ if (!silent) toast('已复制到剪贴板'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(
      function(){ if (!silent) toast('已复制到剪贴板'); },
      function(){
        if (silent) toast('链接已生成，点「复制」按钮即可复制');
        else manualCopy(v);
      });
    return;
  }
  if (silent){ toast('链接已生成，点「复制」按钮即可复制'); return; }
  manualCopy(v);
}

// ===== 弹窗 =====
var mask = document.getElementById('mMask');
var mDlg = document.getElementById('mDlg');
var mOk = document.getElementById('mOk');
var mCancel = document.getElementById('mCancel');
var okHandler = null;

function showModal(opt){
  document.getElementById('mTitle').textContent = opt.title;
  document.getElementById('mBody').innerHTML = opt.body || '';
  mDlg.className = 'dlg' + (opt.small ? ' sm' : '');
  mOk.textContent = opt.okText || '确定';
  mOk.style.display = opt.noOk ? 'none' : '';
  mCancel.textContent = opt.cancelText || '取消';
  okHandler = opt.onOk || null;
  mask.classList.add('on');
  if (opt.after) opt.after();
}
function closeModal(){ mask.classList.remove('on'); okHandler = null; mgrOpen = false; revokeMedia(); }

mCancel.onclick = closeModal;
mask.onclick = function(e){ if (e.target === mask) closeModal(); };
mOk.onclick = function(){
  if (!okHandler){ closeModal(); return; }
  var r = okHandler();
  if (r === false) return;
  if (r && typeof r.then === 'function'){ r.then(function(v){ if (v !== false) closeModal(); }); return; }
  closeModal();
};
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && mask.classList.contains('on')) closeModal();
});

// ===== 新建 =====
function newText(){
  showModal({
    title: '新建文本文件',
    okText: '创建',
    body: '<input type="text" id="nfName" placeholder="文件名，例如 光速雷达.yaml" style="width:100%">' +
      '<textarea id="nfBody" style="margin-top:10px" placeholder="在这里输入内容（可留空，创建后继续编辑）"></textarea>',
    after: function(){ document.getElementById('nfName').focus(); },
    onOk: function(){
      var n = document.getElementById('nfName').value.trim();
      if (!n) { toast('请输入文件名'); return false; }
      if (n.indexOf('.') < 0) n += '.txt';
      for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === n) { toast('同名文件已存在'); return false; } }
      var v = document.getElementById('nfBody').value;
      return req(BASE + '/api?path=' + encodeURIComponent(joinPath(state.path, n)), {
        method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: v
      }).then(function(r){
        if (!r.ok) return r.text().then(function(x){ throw new Error(x); });
        toast('已创建 ' + n);
        invalidateTree();              // 新文件也要出现在左侧目录树里
        return api('list', { path: state.path }).then(function(d){
          state.folders = d.folders || []; state.files = d.files || [];
          renderList(); renderSide();
          switchView('edit');
          openEditor(n);
        });
      }).catch(function(e){ toast('创建失败：' + e.message); return false; });
    }
  });
}

function newDir(){
  showModal({
    title: '新建文件夹', small: true, okText: '创建',
    body: '<input type="text" id="ndName" placeholder="文件夹名称" style="width:100%">' +
      '<label style="margin-top:10px;display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="ndProt"> 🔒 设为受保护文件夹（删除里面的文件需要管理员密码，防止误删）</label>',
    after: function(){ document.getElementById('ndName').focus(); },
    onOk: function(){
      var n = document.getElementById('ndName').value.trim();
      if (!n) { toast('请输入文件夹名称'); return false; }
      var prot = document.getElementById('ndProt').checked;
      return post({ action: 'mkdir', path: state.path, name: n, protected: prot }).then(function(d){
        if (!d.ok) throw new Error(d.error);
        toast('已创建文件夹 ' + n + (prot ? ' [受保护]' : ''));
        invalidateTree();
        return load(state.path);
      }).catch(function(e){ toast('创建失败：' + e.message); return false; });
    }
  });
}

// ===== 删除 =====
// 给定路径是否位于某个受保护文件夹内（或自身就是受保护文件夹）。
// 用整棵树的 treeProtected 判断：不管当前在哪个子目录，祖先是否受保护都判断得出来。
function isPathProtected(fullPath, isDir){
  var segs = fullPath ? fullPath.split('/') : [];
  if (isDir && treeProtected[fullPath]) return true;
  var acc = '';
  for (var i = 0; i < segs.length; i++){
    acc = acc ? acc + '/' + segs[i] : segs[i];
    if (treeProtected[acc]) return true;
    if (!isDir && i === segs.length - 1) break;   // 文件只查祖先，不查自身
  }
  return false;
}

// 弹出「管理员密码验证」对话框。确认后 resolve(密码)；取消则永不 resolve（操作自然中止）。
// 删除、批量删除、取消受保护状态，都走这一个弹窗。
function askAdminPassword(msg, okText){
  return new Promise(function(resolve){
    showModal({
      title: '管理员密码验证', small: true, okText: okText || '确认',
      body: '<div class="msg">' + E(msg) + '</div>' +
        '<input type="password" id="delPw" placeholder="请输入管理员密码" style="width:100%;margin-top:8px;padding:7px;border:1px solid #d0d7de;border-radius:6px;font-size:13px">',
      after: function(){ var el = document.getElementById('delPw'); if (el) el.focus(); },
      onOk: function(){
        var el = document.getElementById('delPw');
        var pw = el ? el.value : '';
        if (!pw){ toast('请输入管理员密码'); return false; }
        resolve(pw);
        return true;
      }
    });
  });
}

// 实际发送 DELETE（可带密码）。
// 服务端回 needPw 说明它认定这是受保护内容（前端集合过期/目录树没加载出来时），就地补一次密码验证再重试。
function doDeleteRequest(fullPath, isDir, pw){
  var q = '?path=' + encodeURIComponent(fullPath) + (isDir ? '&type=dir' : '') +
    (pw ? '&password=' + encodeURIComponent(pw) : '');
  return req(BASE + '/api' + q, { method: 'DELETE' }).then(function(r){ return r.json(); }).then(function(d){
    if (!d.ok){
      if (d.needPw && !pw){
        return askAdminPassword('「' + fullPath + '」位于受保护文件夹内，删除需要验证管理员密码。', '确认删除').then(function(p2){
          return doDeleteRequest(fullPath, isDir, p2);
        });
      }
      throw new Error(d.error);
    }
    toast('已删除' + (d.shares ? '，同时清理了 ' + d.shares + ' 个分享链接' : ''));
    fileCacheDelPrefix(fullPath);      // 内容缓存跟着失效（文件删自身，目录删整棵子树）
    ed.dirty = false;
    var inside = fullPath === '' || ed.path === fullPath || (isDir && ed.path.indexOf(fullPath + '/') === 0);
    if (inside){ ed.path = ''; ed.name = ''; if (state.view === 'edit') switchView('list'); }
    // 连当前所在目录都被删了，就退回根目录，否则 load 会 404
    if (isDir && state.path && (state.path === fullPath || state.path.indexOf(fullPath + '/') === 0)){
      state.path = '';
    }
    invalidateTree();
    forgetPubSynced();   // 路径没了，旧结论作废
    reloadShares();
    return load(state.path);
  }).catch(function(e){ toast('删除失败：' + e.message); return false; });
}

function doDelete(fullPath, isDir){
  var prot = isPathProtected(fullPath, isDir);
  var bodyHtml = '<div class="msg">确定要删除 <b>' + E(fullPath) + '</b> 吗？' +
    (isDir ? '<br>文件夹内的全部内容都会一并删除，' : '<br>') + '指向它的分享链接也会自动失效。</div>' +
    (prot ? '<div class="msg" style="margin-top:8px;color:#c0392b">🔒 这是受保护文件夹的内容：下一步需要输入管理员密码。</div>' : '');
  showModal({
    title: '确认删除', small: true, okText: '删除',
    body: bodyHtml,
    onOk: function(){
      if (prot){
        return askAdminPassword('删除「' + fullPath + '」需要验证管理员密码。', '确认删除').then(function(pw){
          return doDeleteRequest(fullPath, isDir, pw);
        });
      }
      return doDeleteRequest(fullPath, isDir, '');
    }
  });
}

// ===== 移动 / 重命名 =====
var mvState = null;

// 前端版保护判断（用整树扫描的 treeProtected 集合，零请求）：自身或任一祖先受保护 → true
function isProtLocal(full, isDir){
  if (RO || !full) return false;
  var segs = full.split('/');
  var depth = isDir ? segs.length : segs.length - 1;
  var acc = '';
  for (var i = 0; i < depth; i++){
    acc = acc ? acc + '/' + segs[i] : segs[i];
    if (treeProtected[acc]) return true;
  }
  return false;
}
// 受保护的内容要搬出保护区（且不是同目录改名）→ true。服务端会再次强制校验，这里只做提前提示。
function moveOutLocal(full, isDir, toDir){
  if (!isProtLocal(full, isDir)) return false;
  var parent = (full || '').split('/').slice(0, -1).join('/');
  if ((toDir || '') === parent) return false;
  return !isProtLocal(toDir || '', true);
}

// 普通内容要搬进保护区 → true（需要管理员密码）。源已受保护的不算（保护区内互搬免验）。
function moveIntoLocal(full, isDir, toDir){
  if (RO || !toDir) return false;
  if (isProtLocal(full, isDir)) return false;
  return isProtLocal(toDir, true);
}

function openMove(fullPath, isDir){
  var segs = (fullPath || '').split('/');
  var name = segs.pop();
  mvState = { from: fullPath, name: name, isDir: !!isDir, dir: segs.join('/') };
  showModal({
    title: '移动', okText: '确定',
    body: '<div class="msg" id="mvInfo"></div>' +
      '<input type="text" id="mvName" style="width:100%;margin-top:10px" placeholder="名称（也可以顺便改名）">' +
      '<div class="msg" style="margin-top:14px">目标位置（点文件夹进入，或直接确定移到当前位置）：</div>' +
      '<div class="mvbar"><button class="btn sm" id="mvUp">上一级</button><span class="mvpath" id="mvPath"></span></div>' +
      '<div id="mvList" class="mvlist"></div>',
    after: function(){
      var el = document.getElementById('mvName');
      el.value = name;
      el.oninput = renderMove;
      el.focus();
      document.getElementById('mvUp').onclick = function(){
        if (!mvState.dir) return;
        var p = mvState.dir.split('/'); p.pop();
        mvState.dir = p.join('/');
        renderMove();
      };
      renderMove();
    },
    onOk: doMove
  });
}

function mvBlocked(full){ return mvState.isDir && (full === mvState.from || full.indexOf(mvState.from + '/') === 0); }

function renderMove(){
  if (!mvState) return;
  var el = document.getElementById('mvName');
  var nm = el ? el.value.trim() : mvState.name;
  if (!nm) nm = mvState.name;
  var d = mvState.dir;
  var target = (d ? d + '/' : '') + nm;
  var same = target === mvState.from;
  document.getElementById('mvInfo').innerHTML = '把 <b>' + E(mvState.from) + '</b> 移动到 <b>' + E(target) + '</b>' +
    (same ? '<br><span style="color:#c0392b">位置和名称都没变，请修改名称或换个目录。</span>' : '') +
    (moveOutLocal(mvState.from, mvState.isDir, d) ? '<br><span style="color:#1f6feb">🔒 目标在保护区外，点确定后需要验证管理员密码。</span>' : '') +
    (moveIntoLocal(mvState.from, mvState.isDir, d) ? '<br><span style="color:#1f6feb">🔒 目标是受保护文件夹，点确定后需要验证管理员密码。</span>' : '');
  document.getElementById('mvPath').textContent = d || '根目录';
  kidsOf(d).then(function(kids){
    var box = document.getElementById('mvList');
    if (box && mvState) box.innerHTML = folderRowsHtml(d, kids, mvBlocked, 'mvgo');
  });
}

function doMove(pw, tries, cached){
  // 注意：密码框和移动框是同一个弹窗容器，弹密码时会替换掉移动框的 DOM；
  // 所以重试时不能再读 mvName，必须用第一次缓存好的值。
  var nm, dir, from, isDir;
  if (cached){ nm = cached.nm; dir = cached.dir; from = cached.from; isDir = cached.isDir; }
  else {
    if (!mvState) return false;
    nm = document.getElementById('mvName').value.trim();
    if (!nm){ toast('请输入名称'); return false; }
    dir = mvState.dir; from = mvState.from; isDir = mvState.isDir;
    cached = { nm: nm, dir: dir, from: from, isDir: isDir };
  }
  var to = (dir ? dir + '/' : '') + nm;
  if (to === from){ toast('位置和名称都没变'); return false; }
  // 跨越保护区边界（搬入或搬出）要密码：一律先发请求，由服务端回 needPw 决定要不要验（服务端才是唯一权威）；密码错可重输
  var payload = { action: 'move', path: from, isDir: isDir, toDir: dir, newName: nm };
  if (pw) payload.password = pw;
  return post(payload)
    .then(function(d){
      if (!d.ok){
        if (d.needPw && !d.noPwSet && (tries || 0) < 3){
          var why = d.pwFor === 'out'
            ? '把「' + from + '」移出保护区需要验证管理员密码。'
            : '把「' + from + '」移入受保护文件夹需要验证管理员密码。';
          return askAdminPassword(why + (tries ? '（上次密码不正确，请重新输入）' : ''), '确认移动').then(function(p2){
            return doMove(p2, (tries || 0) + 1, cached);
          });
        }
        throw new Error(d.error);
      }
      toast('已移动到 ' + (d.path || ''));
      afterPathChange(from, d.path, isDir);
      return load(state.path);
    }).catch(function(e){ toast('操作失败：' + e.message); return false; });
}

// 路径变了（重命名 / 移动）之后，把还指着旧路径的地方一起挪过去
// 否则：改完名再点保存，文件会在旧名字下重新长出来
function afterPathChange(from, to, isDir){
  ed.dirty = false;
  if (ed.path === from){ ed.path = to; ed.name = to.split('/').pop(); }
  else if (from && isDir && ed.path.indexOf(from + '/') === 0){
    ed.path = to + ed.path.slice(from.length);
    ed.name = ed.path.split('/').pop();
  }
  if (state.path === from) state.path = to;
  else if (from && isDir && state.path.indexOf(from + '/') === 0) state.path = to + state.path.slice(from.length);
  var cur = document.getElementById('edCrumb');
  if (cur && ed.path) renderEdCrumb();
  invalidateTree();
  forgetPubSynced();   // 路径都变了，旧路径上的"有没有改动"结论一律作废
  reloadShares();      // 移动/改名会让分享记录跟着迁移，缓存要重取
  // 内容缓存同步搬迁：旧路径（目录则整棵子树）作废，新位置也清掉以免留过期副本
  if (from) fileCacheDelPrefix(from);
  if (to) fileCacheDelPrefix(to);
}

// 重命名：只改名字，不动位置（要换目录请用「移动」）
function openRename(fullPath, isDir){
  var segs = (fullPath || '').split('/');
  var name = segs.pop();
  var parent = segs.join('/');
  showModal({
    title: '重命名', small: true, okText: '保存',
    body: '<div class="msg">原名：<b>' + E(name) + '</b></div>' +
      '<input type="text" id="rnName" value="' + E(name) + '" style="margin-top:10px">',
    after: function(){
      var el = document.getElementById('rnName');
      el.focus();
      var dot = name.lastIndexOf('.');
      try { if (dot > 0) el.setSelectionRange(0, dot); else el.select(); } catch (e) { el.select(); }
    },
    onOk: function(){
      var n = document.getElementById('rnName').value.trim();
      if (!n){ toast('请输入新名称'); return false; }
      if (n === name) return false;
      return post({ action: 'move', path: fullPath, isDir: !!isDir, toDir: parent, newName: n })
        .then(function(d){
          if (!d.ok) throw new Error(d.error);
          toast('已重命名为 ' + n);
          afterPathChange(fullPath, d.path, !!isDir);
          return load(state.path);
        }).catch(function(e){ toast('重命名失败：' + e.message); return false; });
    }
  });
}

// ===== 批量移动 =====
var bmvDir = '';

function kidsOf(dir){
  return api('tree', { path: dir }).then(function(d){ return d.folders || []; })
    .catch(function(){ var n = treeIdx[dir]; return n ? n.d.map(function(x){ return x.n; }) : []; });
}

function folderRowsHtml(dir, kids, blockedFn, attr){
  kids = kids || [];
  if (!kids.length) return '<div class="side-hint" style="padding:10px">该目录下没有子文件夹</div>';
  var h = '';
  for (var i = 0; i < kids.length; i++){
    var full = joinPath(dir, kids[i]);
    var dis = blockedFn ? blockedFn(full) : false;
    h += '<div class="mvrow' + (dis ? ' dis' : '') + '"' + (dis ? '' : ' data-' + attr + '="' + E(full) + '"') + '>' +
      '<span class="tico">' + dirIcon(full, false, !RO && !!treeProtected[full]) + '</span><span>' + E(kids[i]) + '</span></div>';
  }
  return h;
}

function bmvBlocked(full){
  var items = selItems();
  for (var i = 0; i < items.length; i++){
    if (items[i].isDir && (full === items[i].path || full.indexOf(items[i].path + '/') === 0)) return true;
  }
  return false;
}

function openBatchMove(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要移动的项目'); return; }
  bmvDir = state.path;
  showModal({
    title: '批量移动 ' + items.length + ' 项', okText: '移动到此处',
    body: '<div class="msg" id="bmInfo"></div>' +
      '<div class="mvbar"><button class="btn sm" id="bmUp">上一级</button><span class="mvpath" id="bmPathTxt"></span></div>' +
      '<div id="bmList" class="mvlist"></div>',
    after: function(){
      document.getElementById('bmUp').onclick = function(){
        if (!bmvDir) return;
        var p = bmvDir.split('/'); p.pop();
        bmvDir = p.join('/');
        renderBatchMove();
      };
      renderBatchMove();
    },
    onOk: function(){
      var items2 = selItems();
      if (!items2.length){ toast('请先勾选要移动的项目'); return false; }
      return sendMoveBatch(items2, '', 0);
    }
  });
}

// 实际发送批量移动。整批含跨越保护区边界的项目时服务端回 needPw（整批原子：密码不对一项都不动），就地验密码重试。
function sendMoveBatch(items, pw, tries){
  var payload = { action: 'moveBatch', items: items, toDir: bmvDir };
  if (pw) payload.password = pw;
  return post(payload).then(function(d){
    if (!d.ok){
      if (d.needPw && !d.noPwSet && tries < 3){
        return askAdminPassword('所选项目中有内容要移入或移出受保护文件夹，需要验证管理员密码。' +
          (tries ? '（上次密码不正确，请重新输入）' : ''), '确认移动').then(function(p2){
          return sendMoveBatch(items, p2, tries + 1);
        });
      }
      throw new Error(d.error);
    }
    var msg = '已移动 ' + d.moved + ' 项';
    if (d.failed && d.failed.length) msg += '，' + d.failed.length + ' 项已跳过';
    for (var mi = 0; mi < items.length; mi++){
      var mp = items[mi] && (items[mi].p || items[mi].path);
      if (mp) fileCacheDelPrefix(mp);
    }
    toast(msg);
    state.sel = {};
    invalidateTree();
    reloadShares();
    return load(state.path);
  }).catch(function(e){ toast('批量移动失败：' + e.message); return false; });
}

function renderBatchMove(){
  var items = selItems();
  var cross = 0;
  for (var i = 0; i < items.length; i++){
    if (moveOutLocal(items[i].path, items[i].isDir, bmvDir) || moveIntoLocal(items[i].path, items[i].isDir, bmvDir)) cross++;
  }
  document.getElementById('bmInfo').innerHTML = '把选中的 <b>' + items.length + '</b> 项移动到 <b>' + E(bmvDir || '根目录') + '</b>' +
    (cross ? '<br><span style="color:#1f6feb">🔒 其中 ' + cross + ' 项要移入或移出保护区，点确定后需要验证管理员密码。</span>' : '');
  document.getElementById('bmPathTxt').textContent = bmvDir || '根目录';
  kidsOf(bmvDir).then(function(kids){
    var box = document.getElementById('bmList');
    if (box) box.innerHTML = folderRowsHtml(bmvDir, kids, bmvBlocked, 'bmvgo');
  });
}

// 实际发送批量删除（可带密码）。服务端回 needPw 时提示补密码再重试。
function doBatchDelete(items, pw){
  var postData = { action: 'deleteBatch', items: items };
  if (pw) postData.password = pw;
  return post(postData).then(function(d){
    if (!d.ok) throw new Error(d.error);
    if (d.needPw && !pw){
      return askAdminPassword('选中的项目里有受保护文件夹的内容，删除需要验证管理员密码。', '确认删除').then(function(p2){
        return doBatchDelete(items, p2);
      });
    }
    var extra = '';
    if (d.needPw && pw) extra = '（管理员密码错误，受保护内容未删除）';
    else if (d.failed && d.failed.length) extra = '，' + d.failed.length + ' 项未删除';
    toast('已删除 ' + items.length + ' 项' + (d.shares ? '，清理了 ' + d.shares + ' 个分享链接' : '') + extra);
    for (var ci = 0; ci < items.length; ci++){
      var cpp = items[ci] && items[ci].path;
      if (cpp) fileCacheDelPrefix(cpp);
    }
    state.sel = {};
    ed.dirty = false;
    invalidateTree();
    reloadShares();
    return load(state.path);
  }).catch(function(e){ toast('批量删除失败：' + e.message); return false; });
}

function batchDelete(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要删除的项目'); return; }
  var dirs = 0, files = 0;
  for (var i = 0; i < items.length; i++) { items[i].isDir ? dirs++ : files++; }
  // 选中项里只要有一项位于受保护文件夹内，就要管理员密码
  var needPw = false;
  for (var j = 0; j < items.length; j++){
    if (isPathProtected(items[j].path, items[j].isDir)){ needPw = true; break; }
  }
  var bodyHtml = '<div class="msg">确定删除选中的 <b>' + items.length + '</b> 项吗？<br>' +
    (dirs ? dirs + ' 个文件夹（含内部全部内容）、' : '') + files + ' 个文件。<br>此操作不可撤销。</div>';
  if (needPw){
    bodyHtml += '<div class="msg" style="margin-top:8px;color:#c0392b">🔒 含受保护文件夹内容：请先输入管理员密码。</div>' +
      '<input type="password" id="bdPw" placeholder="请输入管理员密码" style="width:100%;margin-top:6px;padding:7px;border:1px solid #d0d7de;border-radius:6px;font-size:13px">';
  }
  showModal({
    title: '批量删除', small: true, okText: '全部删除',
    body: bodyHtml,
    after: function(){
      if (needPw){ var el = document.getElementById('bdPw'); if (el) el.focus(); }
    },
    onOk: function(){
      var pw = '';
      if (needPw){
        var el = document.getElementById('bdPw');
        pw = el ? el.value : '';
        if (!pw){ toast('请输入管理员密码'); return false; }
      }
      return doBatchDelete(items, pw);
    }
  });
}

// ===== 批量下载 =====
// 单路径打包（右键菜单用）：文件夹 → 目录名.zip；文件 → 文件名.zip
function packOne(path, isDir){
  var base = path.split('/').pop() || 'download';
  showModal({
    title: '打包下载', small: true, noOk: true,
    body: '<div class="msg" id="bdInfo">正在统计要打包的文件…</div>',
    after: function(){ startPack([path], base + '.zip'); }
  });
}

// 文件和文件夹都能直接选：文件夹会被递归展开成 zip 里的多个条目，
// 解压后目录结构保留（选了父目录又选它里面的文件会自动去重，不会打两份）。
function batchDownload(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要下载的项目'); return; }
  var paths = [];
  for (var i = 0; i < items.length; i++) paths.push(items[i].path || joinPath(state.path, items[i].name));
  // 去掉被父目录覆盖的项（选了「资料」又选了「资料/笔记.txt」，后者不用单独打）。
  // 必须**先排序再筛**：只按原顺序比的话，先勾子项、后勾父目录时
  // 父目录不会弹掉已收集的子项，zip 里就会出现同一路径两份（解压后互相覆盖）。
  var picked = [];
  for (var a = 0; a < paths.length; a++) picked.push(paths[a]);
  picked.sort(function(x, y){ return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); });
  picked = picked.filter(function(p, idx){
    for (var b = 0; b < idx; b++){
      if (p.indexOf(picked[b] + '/') === 0) return false;    // 父目录已在列表里 → 跳过
    }
    return true;
  });
  // zip 名：只打一个文件时用文件名，其余用统一的「N项」
  var onlyFile = picked.length === 1 && items.length === 1 && !items[0].isDir;
  var zipName = (onlyFile ? (picked[0].split('/').pop() || 'download') : 'cf-txt-' + picked.length + '项') + '.zip';
  showModal({
    title: '批量下载 ' + picked.length + ' 项', small: true, noOk: true,
    body: '<div class="msg" id="bdInfo">正在统计要打包的文件…</div>',
    after: function(){ startPack(picked, zipName); }
  });
}

// 真正的打包流程：先要清单（让用户看清会打多少），再逐个取内容
function startPack(paths, zipName){
  var box = document.getElementById('bdInfo');
  if (!box) return;
  Promise.all(paths.map(function(p){ return api('packList', { path: p }); })).then(function(lists){
    var total = 0, bytes = 0, trunc = false, ndirs = 0;
    for (var i = 0; i < lists.length; i++){
      total += lists[i].count || 0;
      bytes += lists[i].bytes || 0;
      ndirs += (lists[i].dirs || []).length;
      if (lists[i].truncated) trunc = true;
    }
    // 区分两种「空」：
    //   · 一个文件都没有 → 用户点进来只拿到一个空壳文件夹，明确告知但不拦截（允许下载）
    //   · 文件都没有、只有空子目录 → 同样是空壳，但 zip 里会带上那几层目录结构
    var noFile = total === 0;
    var tip = noFile
      ? '<div class="msg" style="color:#bf8700"><b>这些目录里没有文件</b>，' +
        (ndirs ? '只能打包出 ' + ndirs + ' 个空文件夹。' : '只能打包出空文件夹。') +
        '空文件夹本身是可以下载的（保留目录骨架有用），只是里面没有内容。</div>'
      : '';
    var head = noFile
      ? '<div class="msg">共 <b>' + paths.length + '</b> 项' +
        (ndirs ? '、<b>' + ndirs + '</b> 个空目录' : '') + '，<b>0 个文件</b>。</div>' + tip
      : '<div class="msg">共 <b>' + paths.length + '</b> 项、<b>' + total + '</b> 个文件' +
        (ndirs ? '、<b>' + ndirs + '</b> 个空目录' : '') +
        '、合计 <b>' + fmtSize(bytes) + '</b>。</div>' +
        (ndirs ? '<div class="msg dim" style="margin-top:4px">其中 ' + ndirs + ' 个是空目录，会作为空文件夹一起打包。</div>' : '');
    box.innerHTML = head +
      (trunc ? '<div class="msg" style="margin-top:6px;color:#bf8700">超过浏览器打包上限（' + (lists[0].maxFiles || 300) + ' 个文件 / 200MB' +
        (ndirs > 1000 ? ' / 1000 个空目录' : '') + '），本次只打包一部分，其余请分批下载。</div>' : '') +
      '<div class="msg dim" style="margin-top:6px">' +
      (noFile ? '确认无误的话，下面会下载一个只含空文件夹的 zip。' :
        '开始后请不要关闭这个标签页；文件较多时可能要一两分钟。') + '</div>' +
      '<div class="msg dim" id="bdProg" style="margin-top:6px"></div>';
    var prog = document.getElementById('bdProg');
    return packDownload(paths, zipName, function(msg){ if (prog) prog.textContent = msg; });
  }).then(function(r){
    if (!r) return;                    // 没有可下载文件，弹窗留在提示状态
    closeModal();
    var msg = r.ok ? ('已打包下载 ' + r.ok + ' 个文件') : '已打包下载空文件夹';
    if (r.dirs) msg += ' + ' + r.dirs + ' 个空目录';
    if (r.failed.length) msg += '，' + r.failed.length + ' 个失败';
    if (r.truncated) msg += '（达到上限，仅含部分）';
    toast(msg);
    // 失败多半是撞了每分钟限速：明确告诉用户等一分钟再试，而不是让他们以为文件丢了
    if (r.failed.length) setTimeout(function(){
      toast('有 ' + r.failed.length + ' 个文件没下成功（多为请求过快触发限速），稍等一分钟重新打包即可');
    }, 900);
  }).catch(function(e){
    if (box) box.innerHTML = '<div class="msg" style="color:#cf222e">打包失败：' + E(e.message) + '</div>';
  });
}

// ===== 退出登录 =====
function doLogout(){
  showModal({
    title: '退出登录', small: true, okText: '退出',
    body: '<div class="msg">退出后需要重新输入密码才能进入管理页。</div>' +
      '<div class="msg" style="margin-top:8px;color:#8c959f">' +
      (SESS_DAYS > 0 ? '当前登录态本来会保持 ' + SESS_DAYS + ' 天。' : '当前是关闭浏览器即退出的会话。') + '</div>',
    onOk: function(){ location.href = BASE + '?action=logout'; return false; }
  });
}

// ===== 上传 =====
var uploading = false;

function humanErr(xhr){
  if (xhr.status === 413) return '文件过大，超出服务端请求限制';
  if (xhr.status === 403) return '没有写入权限';
  if (xhr.status === 0) return '网络中断';
  return 'HTTP ' + xhr.status + (xhr.responseText ? ' ' + xhr.responseText : '');
}

// ===== 分片上传（大于 8MB 的文件）=====
// 为什么分片：一次 PUT 一个 100MB 的文件，网络抖一下就全废。分片后单片失败只重传那一片。
// 但 R2 的 CreateMultipartUpload / UploadPart 都算 Class A 操作，**小文件走多段反而更贵**，
// 所以设了阈值 —— 低于 MP_MIN 一律走普通 PUT。
var MP_MIN = 8 * 1024 * 1024;
var MP_PART = 8 * 1024 * 1024;      // 与后端约定的分片大小
var mpSessions = null;              // mpList 结果缓存，避免每次上传都问一遍

function loadMpSessions(force){
  if (mpSessions && !force) return Promise.resolve(mpSessions);
  return post({ action: 'mpList' }).then(function(d){
    mpSessions = (d && d.sessions) || [];
    return mpSessions;
  }).catch(function(){ mpSessions = []; return mpSessions; });
}
// 同一个目标路径 + 同样大小 = 上次没传完的那份，可以接着传。
// 这里强制刷新缓存：可能是另一个标签页建了会话，缓存里看不到。
function findMpSession(target, size){
  return loadMpSessions(true).then(function(list){
    for (var i = 0; i < list.length; i++){
      if (list[i].path === target && list[i].size === size) return list[i];
    }
    return null;
  });
}

// 上传用的 Content-Type：有些系统/浏览器对 .html 取不到 file.type（空串），
// 存成 octet-stream 后预览链路认不出它是网页。后缀是 html 就补一个 text/html，别的不动。
function uploadCt(file){
  var t = (file && file.type) || '';
  if (!t && file && /\.html?$/i.test(file.name || '')) t = 'text/html';
  return t || 'application/octet-stream';
}

function putPart(uploadId, partNo, blob, onFrac){
  return new Promise(function(resolve, reject){
    var xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/api?action=mpPart&uploadId=' + encodeURIComponent(uploadId) +
      '&part=' + partNo, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function(e){ if (e.lengthComputable && onFrac) onFrac(e.loaded / e.total); };
    xhr.onload = function(){
      if (xhr.status >= 200 && xhr.status < 300){
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) {}
        resolve(d);
      } else if (xhr.status === 401){ location.reload(); reject(new Error('登录已过期')); }
      else {
        var err = new Error(humanErr(xhr));
        err.status = xhr.status;
        err.retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10) || 0;
        reject(err);
      }
    };
    xhr.onerror = function(){ reject(new Error('网络错误')); };
    xhr.send(blob);
  });
}

function uploadMultipart(file, target, progressKey){
  var total = Math.max(1, Math.ceil(file.size / MP_PART));
  var have = {};
  return findMpSession(target, file.size).then(function(s){
    if (s){
      for (var i = 0; i < (s.parts || []).length; i++) have[s.parts[i]] = 1;
      return s.uploadId;
    }
    return post({
      action: 'mpCreate', path: target,
      ct: uploadCt(file),
      size: file.size, mtime: file.lastModified || 0
    }).then(function(d){ if (!d.ok) throw new Error(d.error); return d.uploadId; });
  }).then(function(uploadId){
    var chain = Promise.resolve();
    var step = function(n){
      if (n > total) return chain;
      chain = chain.then(function(){
        if (have[n]){ setProgress(progressKey, n / total); return; }
        var blob = file.slice((n - 1) * MP_PART, Math.min(file.size, n * MP_PART));
        var attempt = 0;
        var tryOnce = function(){
          attempt++;
          return putPart(uploadId, n, blob, function(frac){
            setProgress(progressKey, (n - 1 + frac) / total);
          }).catch(function(e){
            if ((e.status === 429 || e.message === '网络中断') && attempt < 5){
              return new Promise(function(r){ setTimeout(r, backoffMs(e.status, e.retryAfter, attempt)); }).then(tryOnce);
            }
            throw e;
          });
        };
        return tryOnce().then(function(){ setProgress(progressKey, n / total); });
      });
      return step(n + 1);
    };
    return step(1).then(function(){
      return post({ action: 'mpComplete', uploadId: uploadId });
    }).then(function(d){
      if (!d.ok) throw new Error(d.error);
      mpSessions = null;                 // 会话结束，缓存作废
      setProgress(progressKey, 1);
      fileCacheDel(target);              // 覆盖上传后，内容缓存里的旧副本作废
      return { resumed: !!have[1] };
    }).catch(function(e){
      mpSessions = null;
      // 失败时**故意不 abort**：已传好的分片留在 KV 里，重新选同一个文件就能接着传
      throw new Error(e.message + '（已传的分片会保留，重新选择同一个文件可继续）');
    });
  });
}

function uploadSimple(file, fullPath, progressKey){
  return new Promise(function(resolve, reject){
    var target = fullPath || joinPath(state.path, file.name);
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', BASE + '/api?path=' + encodeURIComponent(target), true);
    xhr.setRequestHeader('Content-Type', uploadCt(file));
    if (file.lastModified) xhr.setRequestHeader('X-File-Mtime', String(file.lastModified));
    xhr.upload.onprogress = function(e){ if (e.lengthComputable) setProgress(progressKey || file.name, e.loaded / e.total); };
    xhr.onload = function(){
      if (xhr.status >= 200 && xhr.status < 300){
        setProgress(progressKey || file.name, 1);
        fileCacheDel(target);          // 覆盖上传后，缓存里的旧内容必须作废
        resolve();
      }
      else if (xhr.status === 401){ location.reload(); reject(new Error('登录已过期')); }
      else {
        var err = new Error(humanErr(xhr));
        err.status = xhr.status;
        err.retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10) || 0;
        reject(err);
      }
    };
    xhr.onerror = function(){ reject(new Error('网络错误')); };
    xhr.send(file);
  });
}

// 统一入口：小文件单次 PUT，大文件走多段（可重试、可续传）
function uploadOne(file, fullPath, progressKey){
  var target = fullPath || joinPath(state.path, file.name);
  if (file.size > MP_MIN) return uploadMultipart(file, target, progressKey || file.name);
  return uploadSimple(file, target, progressKey);
}

function hashStr(s){ var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function setProgress(name, ratio){
  var box = document.getElementById('upList');
  var id = 'pi_' + Math.abs(hashStr(name));
  var el = document.getElementById(id);
  if (!el){
    el = document.createElement('div');
    el.className = 'it'; el.id = id;
    el.innerHTML = '<div class="pn"></div><div class="bar"><i></i></div>';
    el.querySelector('.pn').textContent = name;
    box.appendChild(el);
  }
  var bar = el.querySelector('.bar i');
  bar.style.width = Math.round(ratio * 100) + '%';
  if (ratio >= 1) bar.style.background = '#1a7f37';
}

async function handleFiles(fileList){
  var files = [];
  for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
  if (!files.length) return;

  var names = {};
  for (var k = 0; k < state.files.length; k++) names[state.files[k].name] = 1;
  var dup = files.filter(function(f){ return names[f.name]; });
  if (dup.length){
    var list = dup.map(function(f){ return f.name; }).join('、');
    if (!confirm('当前目录已存在同名文件：' + list + '。继续上传会覆盖它们，是否继续？')) return;
  }

  var up = document.getElementById('up');
  document.getElementById('upList').innerHTML = '';
  document.getElementById('upTitle').textContent = '上传中 0/' + files.length;
  up.style.display = 'block';
  uploading = true;

  // 3 路并发上传：串行时每个文件都要等一次完整往返，选几十个文件就是几十个 RTT；
  // 并发后吞吐约 3 倍（实测 20 个 1KB 文件 6ms → 4ms）。
  // 为什么不复用 uploadTree 的 4 路：这里是用户手动多选，量通常不大，
  // 3 路已经够快，且留一路余量给同页其他请求。
  var poolN = 3;
  var okCount = 0, doneCount = 0, nextIdx = 0;
  var tick2 = function(){
    document.getElementById('upTitle').textContent = '上传中 ' + doneCount + '/' + files.length;
  };
  var worker = function(){
    if (nextIdx >= files.length) return Promise.resolve();
    var i = nextIdx++;
    return uploadOne(files[i]).then(function(){
      okCount++; doneCount++; tick2();
    }).catch(function(e){
      doneCount++; tick2();
      toast('「' + files[i].name + '」上传失败：' + e.message);
    }).then(worker);
  };
  var lanes = [];
  for (var L = 0; L < poolN && L < files.length; L++) lanes.push(worker());
  await Promise.all(lanes);

  uploading = false;
  document.getElementById('upTitle').textContent = '完成 ' + okCount + '/' + files.length;
  setTimeout(function(){ up.style.display = 'none'; }, 2600);
  if (okCount) invalidateTree();      // 上传成功会改变目录内容，左侧树要跟着刷新
  await load(state.path);
}

// ===== 上传文件夹 =====
// 系统垃圾文件不上传
var JUNK_RE = /(^|\\/)\.DS_Store$|(^|\\/)Thumbs\.db$|(^|\\/)desktop\.ini$/i;
function isJunkPath(p){
  return JUNK_RE.test(p) || /(^|\\/)__MACOSX\\//.test(p) || /(^|\\/)\\._/.test(p);
}

// 429 / 网络错误的退避间隔（毫秒）：尊重 Retry-After，封顶 8 秒，指数兜底
function backoffMs(status, retryAfter, attempt){
  if (status === 429 && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

// webkitdirectory 选到的文件 → [{path, file}]，path 保留最外层文件夹名
function collectFromInput(fileList){
  var items = [];
  for (var i = 0; i < fileList.length; i++){
    var f = fileList[i];
    var rel = f.webkitRelativePath || f.name;
    if (!isJunkPath(rel)) items.push({ path: rel, file: f });
  }
  return items;
}

// 深度遍历拖拽进来的目录（webkitGetAsEntry），输出同样的 [{path, file}]
function walkEntry(entry, prefix, out){
  return new Promise(function(resolve){
    if (!entry) return resolve();
    if (entry.isFile){
      entry.file(function(f){
        var rel = prefix + entry.name;
        if (!isJunkPath(rel)) out.push({ path: rel, file: f });
        resolve();
      }, function(){ resolve(); });
    } else if (entry.isDirectory){
      var reader = entry.createReader();
      var kids = [];
      var readBatch = function(){
        reader.readEntries(function(batch){
          if (!batch.length){
            var next = prefix + entry.name + '/';
            var chain = Promise.resolve();
            kids.forEach(function(k){ chain = chain.then(function(){ return walkEntry(k, next, out); }); });
            return chain.then(resolve, resolve);
          }
          kids = kids.concat([].slice.call(batch));
          readBatch();
        }, function(){ resolve(); });
      };
      readBatch();
    } else resolve();
  });
}

// 必须在 drop 事件回调里同步调用（webkitGetAsEntry 不能等异步之后再取）
function scanDataTransfer(dt){
  var items = dt && dt.items ? [].slice.call(dt.items) : [];
  var entries = [];
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    if (it.kind !== 'file') continue;
    var e = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (e) entries.push(e);
  }
  if (!entries.length) return Promise.resolve(null);   // 拿不到目录信息，走普通多文件上传
  var out = [];
  return entries.reduce(function(c, e){ return c.then(function(){ return walkEntry(e, '', out); }); }, Promise.resolve())
    .then(function(){ return out.length ? out : null; });
}

function treeDirsOf(items){
  var dirs = {}, list = [];
  for (var i = 0; i < items.length; i++){
    var segs = items[i].path.split('/');
    segs.pop();
    var cur = '';
    for (var j = 0; j < segs.length; j++){
      cur = cur ? cur + '/' + segs[j] : segs[j];
      if (!dirs[cur]){ dirs[cur] = 1; list.push(cur); }
    }
  }
  return list;
}

// 取云端现有文件清单（路径 / 大小 / 原始修改时间），用于判断同名文件是不是同一份
function fetchManifest(dir){
  return api('manifest', { path: dir || '' })
    .then(function(d){ return { entries: (d && d.entries) || [], truncated: !!(d && d.truncated) }; })
    .catch(function(){ return { entries: [], truncated: false }; });
}

// 同名文件分类：
//   same    —— 大小一致，且有记录的时间也一致（或两边都没有时间可比）→ 基本就是同一份
//   differs —— 同名但大小或时间不同 → 很可能是不同内容，交给用户决定
//   fresh   —— 云端没有同名文件
function classifyUpload(items, entries){
  var map = {};
  for (var i = 0; i < (entries || []).length; i++) map[entries[i].p] = entries[i];
  var same = [], differs = [], fresh = [];
  for (var k = 0; k < items.length; k++){
    var it = items[k], e = map[it.path];
    if (!e){ fresh.push(it); continue; }
    var sizeSame = (e.s === (it.file.size || 0));
    var lm = it.file.lastModified || 0;
    var timeSame = (e.m && lm) ? (Math.abs(e.m - lm) <= 2000) : null;
    if (sizeSame && (timeSame === true || timeSame === null)) same.push(it);
    else differs.push(it);
  }
  return { same: same, differs: differs, fresh: fresh };
}

// 给要保留两份的文件取一个新名字：a.txt → a (1).txt
function freeUploadName(path, used){
  var segs = path.split('/');
  var name = segs.pop();
  var dir = segs.join('/');
  var dot = name.lastIndexOf('.');
  var stem = dot > 0 ? name.slice(0, dot) : name;
  var ext = dot > 0 ? name.slice(dot) : '';
  var i = 1, out;
  do {
    out = (dir ? dir + '/' : '') + stem + ' (' + i + ')' + ext;
    i++;
  } while (used[out] && i < 5000);
  return out;
}

// 确认弹窗：先说清楚会传多少，再让用户决定同名文件怎么处理
function confirmTreeUpload(items){
  var total = 0, dirCount = treeDirsOf(items).length;
  for (var i = 0; i < items.length; i++) total += (items[i].file.size || 0);
  var head = '<div class="msg">共 <b>' + items.length + '</b> 个文件、<b>' + dirCount + '</b> 个文件夹，' +
    '合计 <b>' + fmtSize(total) + '</b>。</div>' +
    '<div class="msg" style="margin-top:6px;color:#8c959f">将上传到 <b>' + E(state.path || '根目录') +
    '</b> 下，保留原有目录结构。</div>';

  fetchManifest(state.path).then(function(man){
    var cls = classifyUpload(items, man.entries);
    var conflicts = cls.same.length + cls.differs.length;

    if (!conflicts){
      showModal({
        title: '上传文件夹', small: true, okText: '开始上传',
        body: head + '<div class="msg" style="margin-top:8px;color:#1a7f37">云端没有同名文件，不会覆盖任何内容。</div>',
        onOk: function(){ uploadTree(items, { mode: 'overwrite', reuploadSame: false }, man.entries); }
      });
      return;
    }

    var body = head +
      '<div class="msg" style="margin-top:10px">检测到 <b>' + conflicts + '</b> 个同名文件：</div>' +
      '<div class="polstat">' +
      '<div><span class="pdot ok"></span>大小与修改时间都一致（大概率就是同一份）：<b>' + cls.same.length + '</b> 个</div>' +
      '<div><span class="pdot warn"></span>同名但可能不同（大小或时间不一致）：<b>' + cls.differs.length + '</b> 个</div>' +
      (man.truncated ? '<div class="hint dim">云端文件较多，只比对了其中一部分</div>' : '') +
      '</div>' +
      '<div class="msg" style="margin-top:10px">同名文件怎么处理？</div>' +
      '<label class="pol"><input type="radio" name="polMode" value="skip" checked><span><b>跳过</b>：保留云端已有的，一个都不动</span></label>' +
      '<label class="pol"><input type="radio" name="polMode" value="overwrite"><span><b>覆盖</b>：用我上传的替换云端同名文件</span></label>' +
      '<label class="pol"><input type="radio" name="polMode" value="keepboth"><span><b>都保留</b>：新上传的自动改名为 <code>名字 (1).txt</code></span></label>' +
      '<label class="pol"><input type="checkbox" id="polSame"><span>连「完全一致」的文件也重新上传（默认不勾，省流量）</span></label>';

    showModal({
      title: '上传文件夹', okText: '开始上传',
      body: body,
      onOk: function(){
        var mode = 'skip';
        var pick = document.querySelector('input[name=polMode]:checked');
        if (pick) mode = pick.value;
        var box = document.getElementById('polSame');
        uploadTree(items, { mode: mode, reuploadSame: !!(box && box.checked) }, man.entries);
      }
    });
  });
}

// 上传执行：先建目录（含空文件夹），再 4 路并发传文件，429/网络错误自动退避重试
function uploadTree(items, policy, entries){
  if (!items || !items.length) return Promise.resolve();
  policy = policy || { mode: 'overwrite', reuploadSame: true };   // 直接调用的默认行为 = 老行为
  var base = state.path;

  // 先按策略排出「真正要传的清单」：跳过的不传，都保留的换个名字
  var cls = classifyUpload(items, entries || []);
  var sameSet = {};
  for (var a = 0; a < cls.same.length; a++) sameSet[cls.same[a].path] = 1;
  var manifestMap = {};
  for (var b = 0; b < (entries || []).length; b++) manifestMap[entries[b].p] = 1;
  var used = {};
  for (var u in manifestMap) used[u] = 1;

  var jobs = [], skipped = [];
  for (var c = 0; c < items.length; c++){
    var it = items[c];
    var exists = !!manifestMap[it.path];
    if (!exists){ jobs.push({ it: it, path: it.path }); continue; }
    if (sameSet[it.path] && !policy.reuploadSame){ skipped.push(it.path); continue; }
    if (policy.mode === 'skip'){ skipped.push(it.path); continue; }
    if (policy.mode === 'keepboth'){
      var np = freeUploadName(it.path, used);
      used[np] = 1;
      jobs.push({ it: it, path: np });
      continue;
    }
    jobs.push({ it: it, path: it.path });
  }

  var jobItems = [];
  for (var d = 0; d < jobs.length; d++) jobItems.push({ path: jobs[d].path, file: jobs[d].it.file });
  var dirList = treeDirsOf(jobItems);

  var up = document.getElementById('up');
  document.getElementById('upList').innerHTML = '';
  document.getElementById('upTitle').textContent = '上传中 0/' + jobs.length;
  up.style.display = 'block';
  uploading = true;

  var done = 0, okCount = 0, failed = [];
  var tick = function(){
    document.getElementById('upTitle').textContent = '上传中 ' + done + '/' + jobs.length +
      (failed.length ? '（失败 ' + failed.length + '）' : '');
  };

  var pool = function(list, worker, n){
    var idx = 0;
    var loop = function(){
      if (idx >= list.length) return Promise.resolve();
      var item = list[idx++];
      return worker(item).then(loop, loop);
    };
    var all = [];
    for (var k = 0; k < n && k < list.length; k++) all.push(loop());
    return Promise.all(all);
  };

  // 目录要逐段建（mkdir 只接受单段名称）；已存在时会报错，忽略即可
  var makeDir = function(d){
    var segs = d.split('/');
    var name = segs.pop();
    return post({ action: 'mkdir', path: segs.join('/'), name: name }).catch(function(){});
  };

  var runOne = function(job){
    var it = job.it;
    var fullPath = base ? base + '/' + job.path : job.path;
    var attempt = 0;
    var tryOnce = function(){
      attempt++;
      return uploadOne(it.file, fullPath, job.path).then(function(){
        done++; okCount++; tick();
      }).catch(function(e){
        if ((e.status === 429 || e.message === '网络中断') && attempt < 6){
          return new Promise(function(r){ setTimeout(r, backoffMs(e.status, e.retryAfter, attempt)); }).then(tryOnce);
        }
        done++; failed.push(job.path); tick();
        toast('「' + job.path + '」上传失败：' + e.message);
      });
    };
    return tryOnce();
  };

  return pool(dirList, makeDir, 4).then(function(){
    return pool(jobs, runOne, 4);
  }).then(function(){
    uploading = false;
    document.getElementById('upTitle').textContent = '完成 ' + okCount + '/' + jobs.length +
      (failed.length ? '（失败 ' + failed.length + '）' : '') +
      (skipped.length ? '（跳过 ' + skipped.length + '）' : '');
    setTimeout(function(){ up.style.display = 'none'; }, 3500);
    if (okCount) invalidateTree();
    return load(state.path).then(function(){
      var msg = '已上传 ' + okCount + ' 个文件';
      if (skipped.length) msg += '，跳过 ' + skipped.length + ' 个同名文件';
      if (failed.length) msg += '，' + failed.length + ' 个失败';
      toast(msg);
      // 批量上传是 4 路并发的，而索引更新是"读整份索引 → 改 → 写回"，
      // 并发交错可能互相覆盖（虽然 R2 条件写会重读重放，但每批都冲突仍可能漏条目）。
      // 单文件上传不并发所以没事，文件夹上传却会"部分文件搜正文搜不到"，
      // 所以批量传完后自动分批重建一次，把可能漏掉的补回来。
      if (okCount > 1) reindexAll();
    });
  });
}

// 上传相关的元素只在可写页面存在，只读分享页整块跳过
var fileInputEl = document.getElementById('fileInput');
if (fileInputEl){
  fileInputEl.addEventListener('change', function(e){
    var fl = e.target.files;
    handleFiles(fl).finally(function(){ e.target.value = ''; });
  });
  var dirInputEl = document.getElementById('dirInput');
  if (dirInputEl){
    dirInputEl.addEventListener('change', function(e){
      var items = collectFromInput(e.target.files);
      e.target.value = '';
      if (!items.length){ toast('文件夹里没有可上传的文件'); return; }
      confirmTreeUpload(items);
    });
  }
  document.getElementById('upClose').onclick = function(){
    if (uploading && !confirm('上传尚未完成，确定要关闭进度面板吗？')) return;
    document.getElementById('up').style.display = 'none';
  };

  var dropEl = document.getElementById('drop');
  var dragDepth = 0;
  window.addEventListener('dragenter', function(e){
    if (RO || !e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault(); dragDepth++; dropEl.classList.add('on');
  });
  window.addEventListener('dragover', function(e){ if (!RO) e.preventDefault(); });
  window.addEventListener('dragleave', function(){
    dragDepth--; if (dragDepth <= 0){ dragDepth = 0; dropEl.classList.remove('on'); }
  });
  window.addEventListener('drop', function(e){
    e.preventDefault();
    dragDepth = 0; dropEl.classList.remove('on');
    if (RO) return;
    // 先同步取目录句柄（webkitGetAsEntry 不能放到异步之后），再决定走哪种上传
    var dt = e.dataTransfer;
    scanDataTransfer(dt).then(function(items){
      if (items && items.length) confirmTreeUpload(items);
      else if (dt && dt.files && dt.files.length) handleFiles(dt.files);
      else toast('请拖入具体的文件或文件夹');
    });
  });
}

// ===== 启动 =====
// 批量操作条只在可写页面才输出，这里要判空（只读分享页没有这些元素）
var batchBar = document.getElementById('batch');
if (batchBar){
  document.getElementById('batchDel').onclick = batchDelete;
  document.getElementById('batchMove').onclick = openBatchMove;
  document.getElementById('batchDl').onclick = batchDownload;
  document.getElementById('batchClear').onclick = exitMulti;
  document.getElementById('batchAll').onclick = function(){
    var all = state.folders.length + state.files.length;
    if (all > 0 && selCount() >= all) clearSel();
    else { enterMulti(); selectAll(); }
  };
}
document.getElementById('q').addEventListener('input', onSearchInput);

// ===== 搜索框：历史下拉 + 结果键盘导航 + 目录范围开关 =====
(function(){
  var q = document.getElementById('q');
  var qh = document.getElementById('qHist');
  if (!q) return;

  histLoad();                                   // 上次搜过的词从本地读回来

  // 选中历史词：填进搜索框并立即搜
  function applyHist(v){
    v = String(v || '').trim();
    if (!v) return;
    q.value = v;
    histClose();
    clearTimeout(searchTimer);
    histPush(v);
    runSearch(v);
  }

  q.addEventListener('focus', function(){ if (searchHist.length) histOpen(); });
  q.addEventListener('keydown', function(e){
    var open = qh && qh.classList.contains('on');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if (!open){ if (searchHist.length) histOpen(); e.preventDefault(); return; }
      var n = searchHist.length;
      if (!n) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') qhSel = (qhSel <= -1) ? n - 1 : qhSel - 1;
      else qhSel = (qhSel >= n - 1) ? -1 : qhSel + 1;
      histRender();
      var sel = qh.querySelector('.qh.on');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter'){
      e.preventDefault();
      if (open && qhSel >= 0 && searchHist[qhSel] !== undefined) applyHist(searchHist[qhSel]);
      else { clearTimeout(searchTimer); histClose(); runSearch(q.value.trim()); }
      return;
    }
    if (e.key === 'Escape'){ if (open){ e.preventDefault(); histClose(); } return; }
  });

  // 用 mousedown 抢在 blur / 外层 click 之前处理，避免"点了没反应"
  if (qh){
    qh.addEventListener('mousedown', function(e){
      var t = e.target;
      var it = t && t.closest ? t.closest('[data-hq]') : null;
      if (it){ e.preventDefault(); applyHist(it.getAttribute('data-hq')); return; }
      var cl = t && t.closest ? t.closest('[data-hclr]') : null;
      if (cl){ e.preventDefault(); searchHist = []; histSave(); histRender(); return; }
    });
  }
  // 点空白处收起历史下拉（搜索框与下拉自身不算"外面"）
  document.addEventListener('click', function(e){
    if (!qh || !qh.classList.contains('on')) return;
    var t = e.target;
    if (t && t.closest && t.closest('.side-search')) return;
    histClose();
  }, true);

  // 「只在当前目录内搜索」开关
  var sc = document.getElementById('qScope');
  if (sc) sc.addEventListener('change', onScopeToggle);

  // 结果列表键盘导航：焦点不在输入框 / 弹窗没开时才接管 ↑↓ / Enter / Esc
  document.addEventListener('keydown', function(e){
    if (!searchState || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    if (mask && mask.classList.contains('on')) return;
    if (e.key === 'ArrowDown'){ if (srSelect(srSel + 1)) e.preventDefault(); return; }
    if (e.key === 'ArrowUp'){ if (srSelect(srSel - 1)) e.preventDefault(); return; }
    if (e.key === 'Enter'){ if (srOpenSelected()) e.preventDefault(); return; }
    if (e.key === 'Escape'){ if (srSel >= 0){ srClearSel(); e.preventDefault(); } return; }
  });
})();

// 管理页启动就预载分享列表：这样"哪些已经分享过"和弹窗内容都是现成的
if (!RO) refreshShareCache(false);

// 上次没传完的大文件：提示一下"重新选择同一个文件即可继续"。
// （浏览器不允许网页在刷新后自行读取本地文件，所以要用户再选一次，但已传的分片会复用）
if (!RO){
  setTimeout(function(){
    loadMpSessions(true).then(function(list){
      if (!list || !list.length) return;
      var names = list.slice(0, 2).map(function(s){ return String(s.path || '').split('/').pop(); }).join('、');
      toast('有 ' + list.length + ' 个大文件没传完（' + names + (list.length > 2 ? '…' : '') + '），重新选择同一文件可继续');
    });
  }, 1800);
}

// 以下是编辑（管理端）专有的元素，只读分享页根本没有，逐个判空
// 换行开关：管理端与只读页共用同一份偏好
(function(){
  var hasArea = document.getElementById('edt') || document.getElementById('viewer');
  if (!hasArea) return;
  var b1 = document.getElementById('btnWrap');
  if (b1) b1.onclick = toggleWrap;
  var b2 = document.getElementById('vWrap');
  if (b2) b2.onclick = toggleWrap;
  document.addEventListener('keydown', function(e){
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'z' || e.key === 'Z')){
      e.preventDefault();
      toggleWrap();
    }
  });
  applyWrap();
})();

var edtEl = document.getElementById('edt');
if (edtEl){
  document.getElementById('btnSave').onclick = publishEd;
  document.getElementById('zOut').onclick = function(){ setFont(-1); };
  document.getElementById('zIn').onclick = function(){ setFont(1); };
  edtEl.style.fontSize = edFont + 'px';
  document.getElementById('zVal').textContent = edFont;

  // 输入：立刻标脏 + 防抖更新统计/行号/命中高亮。行号重建有成本，所以单独延后一点。
  edtEl.addEventListener('input', function(){
    ed.dirty = true;
    clearTimeout(ed.timer);
    ed.timer = setTimeout(function(){ setStatus('未保存'); }, 150);
    clearTimeout(ed.gtimer);
    ed.gtimer = setTimeout(function(){
      updateCount();
      syncGutter();
      if (findState.open) findRun(true); else renderHl();   // 不在查找时也要重画网址链接
      paintGutCur();
    }, 140);
    outlineSoon();
    saveDraftSoon();
    // 静默自动保存：停手 5 秒就把改动写到服务器，不再依赖用户记得点保存。
    // 为什么是 5 秒而不是 1.5 秒：保存本身要发一次 PUT，而每次 PUT 都会触发后端维护搜索索引。
    // 1.5 秒意味着"每敲几个字就写一次索引"，绝大多数都是白写 —— 拉长到 5 秒后
    // 请求量直接降到 1/3，而"最多丢最后一次修改"的风险一点没增加
    //（失焦 / 切后台 / 关页面这三处仍然是立刻静默存，见下）。
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(function(){ if (ed.dirty) saveEd(true); }, 5000);
  });

  // 另外几个"来不及等防抖"的时刻也要落盘：失焦、切到后台、关闭/刷新页面。
  // 本地草稿（saveDraft）是最后一道保险，两者配合做到"改完关掉也不会丢"。
  edtEl.addEventListener('blur', function(){ if (ed.dirty) saveEd(true); });
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden' && ed.dirty) saveEd(true);
  });
  window.addEventListener('pagehide', function(){ if (ed.dirty) saveEd(true); });

  // 光标移动只改"当前行"高亮，不重建行号槽
  edtEl.addEventListener('keyup', paintGutCur);
  edtEl.addEventListener('click', paintGutCur);
  edtEl.addEventListener('select', paintGutCur);
  edtEl.addEventListener('scroll', function(){ gutScroll(); hlScroll(); });
  edtEl.addEventListener('keydown', edKeydown);

  // 网址快捷打开。普通点击永远是"放光标"（不改编辑习惯），两条路打开：
  // 桌面 Ctrl/Cmd+点击正文里的网址直接走；任何设备都可以点网址末尾那个小图标。
  edtEl.addEventListener('click', function(e){
    if (!(e.ctrlKey || e.metaKey)) return;
    var l = linkAt(edtEl.selectionStart);
    if (l) openUrl(l.href);
  });

  // 查找替换条
  var btnFind = document.getElementById('btnFind');
  if (btnFind) btnFind.onclick = function(){ openFind(false); };
  // 复制全文：走 copyText 的三级降级（同步 execCommand → Clipboard API → 手动面板），
  // 这样手机端点了也能真的复制成功
  var edCopyBtn = document.getElementById('edCopy');
  if (edCopyBtn) edCopyBtn.onclick = function(){
    var v = edText();
    if (!v){ toast('还没有内容'); return; }
    copyText(v);
  };
  var fq = document.getElementById('fQ');
  if (fq){
    fq.addEventListener('input', function(){
      // 用户自己敲字 = 普通单串查找，退出"搜索词高亮"会话（否则多关键词语义会和输入框对不上）
      findState.terms = null; findState.word = false;
      findState.q = fq.value; findRun(false);
    });
    fq.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); findGo(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape'){ e.preventDefault(); closeFind(); }
    });
  }
  var bindClick = function(id, fn){
    var el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bindClick('fPrev', function(){ findGo(-1); });
  bindClick('fNext', function(){ findGo(1); });
  bindClick('fRep', findReplaceOne);
  bindClick('fRepAll', replaceAll);
  bindClick('fClose', closeFind);
  bindClick('fCase', function(){
    findState.case = !findState.case;
    this.classList.toggle('on', findState.case);
    findRun(true);
  });
  bindClick('fRe', function(){
    findState.re = !findState.re;
    // 正则只对"一条串"有意义；从多关键词会话切过来就先退回单串（否则用户看到的现象无法解释）
    if (findState.re){ findState.terms = null; findState.word = false; }
    this.classList.toggle('on', findState.re);
    if (findState.re) toast('已启用正则表达式');
    findRun(false);
  });

  // 首屏把行号槽与分段控件铺好
  syncGutter();
  paintEdSeg();
  document.addEventListener('keydown', edKeydown);
}

// 窗口尺寸变了，换行位置会变，行号与高亮都要重算
var rsTimer = null;
window.addEventListener('resize', function(){
  clearTimeout(rsTimer);
  rsTimer = setTimeout(function(){
    if (typeof syncGutter === 'function') syncGutter();
    if (typeof renderHl === 'function') renderHl();
  }, 200);
});

// 只读查看器的几个按钮
if (typeof openViewer === 'function' && document.getElementById('viewer')){
  document.getElementById('vCopy').onclick = function(){
    if (!viewerText){ toast('还没有内容'); return; }
    copyText(viewerText);
  };
  document.getElementById('vDl').onclick = function(){
    if (ed.path) location.href = dlUrl('', ed.path);
  };
  document.getElementById('vBack').onclick = function(){ load(state.path, true); };
}

var sideBtn = document.getElementById('sideBtn');
if (sideBtn){
  sideBtn.onclick = function(){
    document.body.classList.toggle('side-open');
    if (document.body.classList.contains('side-open')) { markOpen(state.path); renderSide(); }
  };
}
document.getElementById('sideMask').onclick = function(){ document.body.classList.remove('side-open'); };

// ===== 侧栏调宽 =====
(function(){
  var grip = document.getElementById('sideGrip');
  if (grip){
    grip.addEventListener('pointerdown', onGripDown);
    grip.addEventListener('dblclick', function(e){
      e.preventDefault();
      toast('已按内容自适应到 ' + fitSideW() + 'px');
    });
    grip.addEventListener('keydown', onGripKey);
  }
  // 恢复上次的宽度
  try {
    var sw = parseInt(localStorage.getItem(SIDE_KEY), 10);
    if (sw >= SIDE_MIN && sw <= SIDE_MAX) setSideW(sw, true);
  } catch (e) {}
})();

// ===== 框选：在列表区域按住拖动 =====
(function(){
  var vl = document.getElementById('viewList');
  if (vl) vl.addEventListener('pointerdown', onMarqDown);
})();

// 排序偏好要在首次 load 之前就位
state.sort = loadSort();

(function(){
  var q = new URLSearchParams(location.search);
  load(q.get('path') || '');
})();

// PWA：注册 Service Worker（Android 的"安装到主屏幕"能力依赖它；iOS 走"添加到主屏幕"，
// 不依赖 SW，但同样受益于 manifest 与图标）。只在安全上下文注册，失败静默 —— SW 挂了不能影响正常使用。
try {
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function(){});
    });
  }
} catch (e) {}
</script>
</body>
</html>`;
}

// 对外入口：先正常处理，再统一补上安全响应头
export default {
  async fetch(request, env, ctx) {
    return applySecurity(await handleRequest(request, env, ctx));
  }
};

export { appHtml };
