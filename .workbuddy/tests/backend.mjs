import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';
import { inflateSync } from 'node:zlib';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

function mk(env) {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = Object.assign({ R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' }, env || {});
  const call = async (path, init) => {
    const u = /^https?:\/\//.test(path) ? path : ORIGIN + path;
    const res = await worker.fetch(new Request(u, init), e, exec);
    // waitUntil 的后台任务（索引条件写等）在响应后继续跑；
    // 测试里立即等它们结束，保证断言时状态已落定
    await Promise.all(exec.waits.splice(0));
    return res;
  };
  return { R2, KV, e, call, readIdx: async () => { const o = await R2.get('__sys__/idx.json'); return o ? JSON.parse(await o.text()) : null; } };
}
const jpost = (call, url, obj) => call(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
});

const U8 = (...a) => new Uint8Array(a);
const enc = s => new TextEncoder().encode(s);

// ============ 1. 基础回归 ============
head('基础回归');
{
  const { call, R2 } = mk();
  const home = await call(ADMIN);
  ok(home.status === 200, '管理页 200');
  const nf = await call('/nope');
  ok(nf.status === 404, '未知路径 404');

  let r = await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: '笔记' });
  ok((await r.json()).ok, '新建文件夹');
  r = await call(ADMIN + '/api?action=list', {});
  let d = await r.json();
  ok(d.folders.indexOf('笔记') >= 0, 'list 能看到文件夹');

  r = await call(ADMIN + '/api?path=' + encodeURIComponent('笔记/菜鸟.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('你好，菜鸟笔记。第一行。')
  });
  ok((await r.json()).ok, '写入文本文件');

  r = await call(ADMIN + '/api?action=read&path=' + encodeURIComponent('笔记/菜鸟.txt'));
  const txt = await r.text();
  ok(txt === '你好，菜鸟笔记。第一行。', '读回内容一致');
  ok(r.headers.get('X-Text-Encoding') === 'utf-8', 'read 标注 utf-8 编码', r.headers.get('X-Text-Encoding'));

  r = await call(ADMIN + '/api?action=download&path=' + encodeURIComponent('笔记/菜鸟.txt'));
  ok(/attachment/.test(r.headers.get('Content-Disposition') || ''), 'download 带 Content-Disposition');
  await r.arrayBuffer();

  // 路径穿越
  r = await call(ADMIN + '/api?path=' + encodeURIComponent('../../etc/passwd'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('x')
  });
  ok((await r.json()).ok, '穿越路径写入被接受（会被折叠）');
  const keys = [...R2.map.keys()];
  // __sys__/idx.json 是全文搜索索引（故意放在 ROOT 外，不会被目录列表扫到）
  ok(keys.every(k => k.startsWith('d/') || k === '__sys__/idx.json'),
    '用户 key 都在 d/ 前缀下（系统索引键除外）', keys);
  ok(!keys.some(k => k.indexOf('..') >= 0), '没有 .. 残留');
}

// ============ 2. 编码识别 ============
head('编码识别');
{
  const { call } = mk();
  // GBK 编码的「中文测试」
  await call(ADMIN + '/api?path=' + encodeURIComponent('gbk.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: U8(0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4)
  });
  let r = await call(ADMIN + '/api?action=read&path=gbk.txt');
  let t = await r.text();
  ok(t === '中文测试', 'GBK 字节被正确识别成中文', t);
  ok(r.headers.get('X-Text-Encoding') === 'gb18030', '标注为 gb18030', r.headers.get('X-Text-Encoding'));

  // UTF-8 BOM
  await call(ADMIN + '/api?path=bom.txt', {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: U8(0xEF, 0xBB, 0xBF, 0x68, 0x69)
  });
  r = await call(ADMIN + '/api?action=read&path=bom.txt');
  t = await r.text();
  ok(t === 'hi', 'UTF-8 BOM 被去掉', t);
  ok(r.headers.get('X-Text-Encoding') === 'utf-8', 'BOM 文件仍标 utf-8');

  // UTF-16LE BOM
  await call(ADMIN + '/api?path=u16.txt', {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: U8(0xFF, 0xFE, 0x41, 0x00, 0x42, 0x00)
  });
  r = await call(ADMIN + '/api?action=read&path=u16.txt');
  t = await r.text();
  ok(t === 'AB', 'UTF-16LE BOM 正确解码', t);
  ok(r.headers.get('X-Text-Encoding') === 'utf-16le', '标注 utf-16le');
}

// ============ 3. 条件请求 / 原始字节 ============
head('条件请求与原始字节');
{
  const { call } = mk();
  await call(ADMIN + '/api?path=a.png', {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: U8(0x89, 0x50, 0x4E, 0x47)
  });
  let r = await call(ADMIN + '/api?action=raw&path=a.png');
  ok(r.headers.get('Content-Type') === 'image/png', 'raw 保留真实 Content-Type', r.headers.get('Content-Type'));
  ok(!r.headers.get('Content-Disposition'), 'raw 不设 Content-Disposition');
  await r.arrayBuffer();

  r = await call(ADMIN + '/api?action=read&path=a.png');
  const et = r.headers.get('ETag');
  await r.arrayBuffer();
  ok(!!et, 'read 返回 ETag', et);

  r = await call(ADMIN + '/api?action=read&path=a.png', { headers: { 'If-None-Match': et } });
  ok(r.status === 304, 'If-None-Match 命中返回 304', r.status);
  const b = await r.arrayBuffer();
  ok(b.byteLength === 0, '304 没有响应体');

  r = await call(ADMIN + '/api?action=read&path=a.png', { headers: { 'If-None-Match': '"stale"' } });
  ok(r.status === 200, 'ETag 不匹配返回 200');
  await r.arrayBuffer();
}

// ============ 4. 索引与全文搜索 ============
head('全文搜索（R2 内容索引 + 条件写）');
{
  const { call, KV, R2 } = mk();
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: '文档' });
  await call(ADMIN + '/api?path=' + encodeURIComponent('文档/光速雷达.yaml'), {
    method: 'PUT', headers: { 'Content-Type': 'text/yaml' }, body: enc('name: 光速雷达\nhost: example.com\ntag: 订阅节点\n')
  });
  await call(ADMIN + '/api?path=' + encodeURIComponent('文档/说明.md'), {
    method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: enc('# 说明\n\n这是一个用于测试的文档，提到关键短语 ALPHA-TOKEN。\n')
  });
  await call(ADMIN + '/api?path=' + encodeURIComponent('文档/照片.png'), {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: U8(1, 2, 3, 4, 5)
  });

  // 【同步建索引】上传 / 保存**当场**就把这个文件写进索引 —— 所以不用先搜一次。
  // 用户改完文件立刻搜索一定能搜到新内容（这是刻意保留的语义，别改回懒更新）。
  const idxRaw = await R2.get('__sys__/idx.json');
  ok(!!idxRaw, '上传后索引已写入 R2（__sys__/idx.json）');
  const idx = JSON.parse(await idxRaw.text());
  ok(idx.files['文档/说明.md'] !== undefined, '索引含说明.md');
  ok(idx.files['文档/照片.png'] !== undefined, '索引含照片.png');
  ok(idx.files['文档/照片.png'][0] === 2, '二进制文件标记为"未索引正文"(r=2)');
  ok((await KV.get('idx:v1')) === null, '旧 KV 索引已自动迁移删除');

  const search = async q => JSON.parse(await (await call(ADMIN + '/api?action=search&q=' + encodeURIComponent(q))).text());

  // 第一次搜就应该是完整的（不需要"再搜一次"）
  let d = await search('ALPHA-TOKEN');
  ok(d.results.length === 1 && d.results[0].path === '文档/说明.md', '按正文搜到 Markdown', d.results.map(x => x.path));
  ok(d.results[0].nameHit === false, '这条是正文命中');
  ok(/ALPHA-TOKEN/.test(d.results[0].snippet || ''), '片段里带命中关键词', d.results[0].snippet);

  d = await search('光速');
  ok(d.results.some(x => x.path === '文档/光速雷达.yaml'), '中文正文命中');

  d = await search('菜鸟');
  ok(d.results.length === 0, '搜不到就返回空');

  d = await search('alpha-token');
  ok(d.results.length === 1, '搜索大小写不敏感');

  d = await search('说明.md');
  ok(d.results.some(x => x.nameHit === true), '文件名命中会打 nameHit');

  d = await search('文档');
  ok(d.indexed === true, '返回 indexed=true');
  ok(d.indexedCount >= 3, '返回已索引文件数', d.indexedCount);
  ok(typeof d.capFull === 'boolean' && d.capFull === false,
    '返回 capFull（正文索引容量是否用满）', d.capFull);

  // 混合大小写正文：旧实现只试全小写/全大写会漏配，现在统一 lower
  ok((await search('Alpha-Token')).results.length === 1, '混合大小写正文也能命中');

  // 语法：ext: / path: / 整词
  d = await search('ext:md 关键短语');
  ok(d.results.length === 1 && d.results[0].path === '文档/说明.md', 'ext:md 限定后缀',
    d.results.map(x => x.path));
  d = await search('ext:png 光速');
  ok(d.results.length === 0, 'ext:png 排除了 yaml/md，命中为空', d.results.map(x => x.path));
  d = await search('path:文档 光速');
  ok(d.results.some(x => x.path === '文档/光速雷达.yaml'), 'path:文档 限定目录');
  d = await search('path:别的 光速');
  ok(d.results.length === 0, 'path: 限定到不存在的目录时为空');
  d = await search('ext:md');
  ok(d.results.length === 1 && d.results[0].path === '文档/说明.md',
    '只有 ext: 没有关键词 = 列出该类型全部文件', d.results.map(x => x.path));
  // 整词：索引里放一个含 category 的文件，搜 "cat" 不应命中
  await call(ADMIN + '/api?path=' + encodeURIComponent('文档/words.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('the category list here')
  });
  d = await search('"cat"');
  ok(!d.results.some(x => x.path === '文档/words.txt'), '"cat" 整词匹配不命中 category',
    d.results.map(x => x.path));
  d = await search('"the"');
  ok(d.results.some(x => x.path === '文档/words.txt'), '"the" 整词匹配正常命中');

  // 深搜返回命中行号
  const ds = JSON.parse(await (await call(ADMIN + '/api?action=deepsearch&path=' +
    encodeURIComponent('文档/说明.md') + '&q=' + encodeURIComponent('ALPHA-TOKEN'))).text());
  ok(ds.ok && ds.found && Array.isArray(ds.hits) && ds.hits.length >= 1 && ds.hits[0].n >= 1,
    '深搜返回命中行号列表', ds.hits);

  // 目录名命中（方案A）：文件夹本体进结果且排最前，目录下文件标「路径」而非「文件名」
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '文档', name: '子' });
  await call(ADMIN + '/api?path=' + encodeURIComponent('文档/子/inner.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('inner content here')
  });
  d = await search('子');
  const dirEntry = d.results.find(x => x.isDir);
  ok(!!dirEntry && dirEntry.path === '文档/子', '目录名命中：文件夹本体进结果', d.results.map(x => x.path));
  const inner = d.results.find(x => x.path === '文档/子/inner.txt');
  ok(!!inner && inner.pathHit === true && inner.nameHit === false,
    '目录下文件标注为「路径」命中而非「文件名」', inner);
  ok(d.results[0].isDir === true, '文件夹条目排在结果最前', d.results[0].path);
  ok(typeof d.dirHits === 'number' && d.dirHits >= 1 && typeof d.pathHits === 'number',
    '返回 dirHits/pathHits 统计', { dirHits: d.dirHits, pathHits: d.pathHits });
  // 路径命中文件排在正文命中前：搜 'category'（words.txt 正文命中）不应插到路径命中前
  d = await search('文档');
  ok(d.results[0].isDir === true || d.results[0].nameHit === true,
    '文件夹与文件名命中排在路径/正文命中前', d.results.slice(0, 3).map(x => x.path));

  // 搜索期间只读 1 次 R2（索引），不读任何文件
  const r2GetBefore = R2.ops.get;
  d = await search('ALPHA-TOKEN');
  ok(R2.ops.get - r2GetBefore === 1, '一次搜索只读 1 次 R2（索引），文件读为 0',
    R2.ops.get - r2GetBefore);

  let st = JSON.parse(await (await call(ADMIN + '/api?action=idxstat')).text());
  ok(st.count >= 3 && st.hasKv === true, 'idxstat 统计正确', st);
  ok(st.none >= 1, 'idxstat 统计出未索引正文的数量', st.none);

  // 深搜
  let dr = JSON.parse(await (await call(ADMIN + '/api?action=deepsearch&path=' +
    encodeURIComponent('文档/说明.md') + '&q=ALPHA')).text());
  ok(dr.ok && dr.found && dr.count === 1, '深搜命中并计数', dr);
  dr = JSON.parse(await (await call(ADMIN + '/api?action=deepsearch&path=' +
    encodeURIComponent('文档/说明.md') + '&q=不存在的东西')).text());
  ok(dr.ok && dr.found === false, '深搜未命中返回 found=false');
}

// ============ 5.5 索引并发写入（首建窗口回归）============
head('索引并发写入');
{
  // 真实 R2 的条件写是**原子**的，而 MockR2.put 里"查 etag → await → 写"之间会让出执行权，
  // 并发时多个写会同时通过校验、互相覆盖。所以这里用串行链把 put 变成原子的，
  // 复现真实 R2 的行为 —— 否则这个测试测不出丢条目。
  class AtomicR2 extends MockR2 {
    constructor() { super(); this._chain = Promise.resolve(); }
    put(key, val, opt) {
      const n = this._chain.then(() => super.put(key, val, opt));
      this._chain = n.then(() => {}, () => {});
      return n;
    }
    // 读也要排在写链之后：否则测试里直接 R2.get('__sys__/idx.json') 会插到
    // 未落定的写中间，读到过期的索引（实测明明扫了 30 个却只读到 4 条）。
    get(key) { const n = this._chain.then(() => super.get(key)); this._chain = n.then(() => {}, () => {}); return n; }
  }
  const mkc = () => {
    const R2 = new AtomicR2(), KV = new MockKV(), exec = makeExec();
    const e = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
    const call = async (p, init) => {
      const res = await worker.fetch(new Request(ORIGIN + p, init), e, exec);
      await Promise.all(exec.waits.splice(0));
      return res;
    };
    const jp = (u, o) => call(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
    const put = (p, s) => call(ADMIN + '/api?path=' + encodeURIComponent(p),
      { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc(s) });
    return { R2, call, jp, put, idx: async () => { const o = await R2.get('__sys__/idx.json'); return o ? JSON.parse(await o.text()) : null; } };
  };

  // 【核心回归】索引文件还不存在时（首次上传/索引被删），多路并发写。
  // 修复前：cur.etag 为 null → 不带条件 → 各自无条件覆盖写 → 只剩最后一路，其余静默丢失。
  // 修复后：用 etagDoesNotMatch:'*'（仅当不存在时创建），只有一路能成，其余重读重放。
  {
    const c = mkc();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '并发' });
    await Promise.all([0, 1, 2, 3].map(i => c.put('并发/f' + i + '.txt', 'body ' + i + ' ZEBRAFISH')));
    const idx = await c.idx();
    const got = Object.keys(idx.files).filter(k => /^并发\/f\d+\.txt$/.test(k)).length;
    ok(got === 4, '索引首建时 4 路并发不丢条目（首建窗口已修）', got);
    const d = JSON.parse(await (await c.call(ADMIN + '/api?action=search&q=ZEBRAFISH')).text());
    ok(d.results.length === 4, '首建并发上传后 4 个文件正文都能搜到', d.results.length);
  }
  // 索引已存在时的并发：条件写重放本来就正确，这条守住别改坏
  {
    const c = mkc();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '已建' });
    await c.put('已建/seed.txt', 'seed');
    await Promise.all([0, 1, 2, 3].map(i => c.put('已建/g' + i + '.txt', 'body ' + i)));
    const idx = await c.idx();
    ok(Object.keys(idx.files).filter(k => /^已建\/g\d+\.txt$/.test(k)).length === 4,
      '索引已存在时 4 路并发不丢条目', Object.keys(idx.files));
  }
  // 顺序上传是前端 handleFiles 的真实路径，永远不该丢
  {
    const c = mkc();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '顺序' });
    for (let i = 0; i < 5; i++) await c.put('顺序/s' + i + '.txt', 'x' + i);
    const idx = await c.idx();
    ok(Object.keys(idx.files).length === 5, '顺序上传 5 个条目齐全', Object.keys(idx.files));
  }
  // reindex 分批：一个都不能漏（断点推进曾经有"隔一个丢一个"的 bug）
  {
    const c = mkc();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '批' });
    // 直写 R2：不走保存接口，才能让 reindex 从零补建（走接口的话索引已被同步建好，测不到分批）
    for (let i = 0; i < 40; i++) await c.R2.put('d/批/f' + String(i).padStart(3, '0') + '.txt', enc('body ' + i), { customMetadata: { mtime: String(1700000000000 + i) } });
    // 分批重建，每轮都带 lastKey 续扫
    let lk = '', rounds = 0, d;
    do {
      d = await (await c.jp(ADMIN + '/api', { action: 'reindex', lastKey: lk })).json();
      if (d.lastKey) lk = d.lastKey;
      rounds++;
      ok(rounds < 100, 'reindex 没有死循环', rounds);
      if (rounds > 99) break;
    } while (!d.done);
    const idx = await c.idx();
    ok(Object.keys(idx.files).length === 40,
      'reindex 分批后 40 个条目一个不少（断点必须逐个推进，不能隔一个丢一个）',
      Object.keys(idx.files).length);
    const s = await (await c.call(ADMIN + '/api?action=search&q=body')).json();
    ok(s.results.length === 40, '重建后 40 个文件正文都能搜到', s.results.length);
  }
  // reindex：显式 limit 优先于自适应；不传时走自适应
  {
    const c = mkc();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'L' });
    for (let i = 0; i < 30; i++) await c.put('L/f' + i + '.txt', 'x' + i);
    let lk = '', r = 0, d;
    do { d = await (await c.jp(ADMIN + '/api', { action: 'reindex', limit: 5, lastKey: lk })).json(); if (d.lastKey) lk = d.lastKey; r++; } while (!d.done && r < 100);
    ok(r === 6, '显式 limit=5 优先于自适应（30/5=6 轮）', r);
    const c2 = mkc();
    await c2.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'A' });
    // 直接写 R2，绕开保存时的同步建索引 —— 这样 reindex 才是从零补建，能验证分批不丢条目
    for (let i = 0; i < 30; i++) await c2.R2.put('d/A/f' + i + '.txt', enc('x' + i), { customMetadata: { mtime: String(1700000000000 + i) } });
    const d2 = await (await c2.jp(ADMIN + '/api', { action: 'reindex' })).json();
    ok(d2.scanned > 5, '不传 limit 时走自适应（这一轮就处理了 ' + d2.scanned + ' 个，不是写死的 1）', d2.scanned);
    // 注意：reindex 的条件写走的是 exec.waitUntil，jp() 已经等过一轮，
    // 但 AtomicR2 串行链可能还有后续写入没落定 —— 多等一轮再读索引。
    await c2.call(ADMIN + '/api?action=idxstat');
    const idxSelf = await c2.idx();
    const gotSelf = Object.keys(idxSelf.files || {}).length;
    ok(gotSelf === 30, '自适应批大小下 30 个条目齐全（scanned=' + d2.scanned + ' files=' + d2.files + ' keys=' + Object.keys(idxSelf.files || {}).slice(0, 6).join(',') + '）', gotSelf);
  }
  // reindex：空桶不能出错
  {
    const c = mkc();
    const d = await (await c.jp(ADMIN + '/api', { action: 'reindex' })).json();
    ok(d.ok && d.done === true && d.scanned === 0, '空桶 reindex 正常返回 done', d);
  }
}

// ============ 5. 索引随改名 / 删除 / 移动同步 + 保存即建索引 ============
head('索引同步与即时性');
{
  const { call, KV, readIdx } = mk();
  const s = async q => JSON.parse(await (await call(ADMIN + '/api?action=search&q=' + encodeURIComponent(q))).text());

  await call(ADMIN + '/api?path=旧名.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('唯一标记 ZEBRA') });
  let idx = await readIdx();
  ok(idx.files['旧名.txt'] !== undefined, '保存后索引里立刻有了旧名.txt（同步建索引）');
  let d = await s('ZEBRA');
  ok(d.results.length === 1, '**第一次搜索**就能搜到正文（不用再搜一次）', d.results.map(x => x.path));

  await jpost(call, ADMIN + '/api', { action: 'rename', path: '旧名.txt', newName: '新名.txt', isDir: false });
  idx = await readIdx();
  ok(idx.files['新名.txt'] !== undefined && idx.files['旧名.txt'] === undefined, '改名后索引路径跟着搬');
  d = await s('ZEBRA');
  ok(d.results.length === 1 && d.results[0].path === '新名.txt', '改名后按正文仍能搜到，且指向新路径', d.results.map(x => x.path));

  // 目录改名：整棵子树的索引都要搬
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: 'A' });
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: 'A', name: 'B' });
  await call(ADMIN + '/api?path=' + encodeURIComponent('A/B/深.txt'), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('深层标记 GIRAFFE') });
  await jpost(call, ADMIN + '/api', { action: 'move', path: 'A', toDir: '', newName: 'C', isDir: true });
  idx = await readIdx();
  ok(idx.files['C/B/深.txt'] !== undefined && idx.files['A/B/深.txt'] === undefined, '目录改名后子树索引整体迁移');
  d = await s('GIRAFFE');
  ok(d.results.length === 1 && d.results[0].path === 'C/B/深.txt', '子树内文件改名后可搜到', d.results.map(x => x.path));

  // 删除：索引条目要清掉，否则搜到的是空气
  await call(ADMIN + '/api?path=' + encodeURIComponent('新名.txt'), { method: 'DELETE' });
  idx = await readIdx();
  ok(idx.files['新名.txt'] === undefined, '删除后索引条目被清掉');
  d = await s('ZEBRA');
  ok(d.results.length === 0, '删除后搜不到（索引没留残影）', d.results.map(x => x.path));

  let r = await call(ADMIN + '/api?path=C&type=dir', { method: 'DELETE' });
  await r.json();
  idx = await readIdx();
  ok(idx.files['C/B/深.txt'] === undefined, '删目录后子树索引整体清掉');

  // ===== 即时性：改完文件后，第一次搜索就能搜到新内容（旧内容不该再命中）=====
  // 显式给 X-File-Mtime：测试要保证两次写入的 mtime 不同，否则同一毫秒会判成"没改过"
  const putAt = (p, s, mt) => call(ADMIN + '/api?path=' + encodeURIComponent(p), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', 'X-File-Mtime': String(mt) },
    body: enc(s)
  });
  await putAt('a.txt', 'AAA 苹果', 1000);
  d = await s('苹果');
  ok(d.results.some(x => x.path === 'a.txt'), '新文件第一次搜就能按正文命中', d.results.map(x => x.path));

  await putAt('a.txt', 'ZZZ 猕猴桃', 3000);
  d = await s('猕猴桃');
  ok(d.results.some(x => x.path === 'a.txt'), '**改完第一次搜**就能搜到新正文（同步建索引的核心理由）', d.results.map(x => x.path));
  d = await s('苹果');
  ok(!d.results.some(x => x.path === 'a.txt'), '旧正文立刻不再命中（没有"过期内容"窗口）', d.results.map(x => x.path));
  // 索引条目确实被更新了（不是靠搜索时临时补的）
  const now = await readIdx();
  ok(now.files['a.txt'][4] && now.files['a.txt'][4].indexOf('猕猴桃') >= 0, '索引条目已在保存时更新', now.files['a.txt'][4]);
}

// ============ 6. 索引重建（分批） ============
head('索引重建');
{
  const { call, KV, R2, readIdx } = mk();
  for (let i = 1; i <= 5; i++) {
    await call(ADMIN + '/api?path=' + encodeURIComponent('f' + i + '.txt'), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('内容编号 ' + i + ' marker' + i)
    });
  }
  R2.map.delete('__sys__/idx.json');            // 模拟"索引丢失/尚未建立"
  let d = JSON.parse(await (await call(ADMIN + '/api?action=search&q=marker3')).text());
  ok(d.indexed === false, '没有索引时返回 indexed=false');
  ok(d.results.length === 0 || d.results.every(x => x.nameHit), '无索引时退回按文件名匹配');

  let round = 0, lastKey = '', done = false, totalFiles = 0;
  while (!done && round < 20) {
    round++;
    d = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'reindex', limit: 2, lastKey })).text());
    ok(d.ok, 'reindex 第 ' + round + ' 批成功');
    lastKey = d.lastKey || lastKey;
    done = d.done;
    totalFiles = d.files;
  }
  ok(round >= 3, '分批生效（5 个文件 / 每批 2 个，至少 3 批）', round);
  ok(done, '最终 done=true');
  ok(totalFiles >= 5, '索引含全部文件', totalFiles);

  d = JSON.parse(await (await call(ADMIN + '/api?action=search&q=marker4')).text());
  ok(d.results.length === 1 && d.results[0].path === 'f4.txt', '重建后按正文能搜到老文件');
  ok(d.indexed === true, '重建后 indexed=true');
}

// ============ 7. 列表分页 ============
head('大目录分页');
{
  const { call } = mk();
  for (let i = 0; i < 7; i++) {
    await call(ADMIN + '/api?path=' + encodeURIComponent('p' + i + '.txt'), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('x' + i)
    });
  }
  let d = JSON.parse(await (await call(ADMIN + '/api?action=list&pageSize=3')).text());
  ok(d.files.length === 3, '第一页 3 个文件', d.files.length);
  ok(!!d.cursor, '返回续页游标');
  const seen = d.files.map(f => f.name);
  let guard = 0;
  while (d.cursor && guard++ < 10) {
    d = JSON.parse(await (await call(ADMIN + '/api?action=list&pageSize=3&cursor=' + encodeURIComponent(d.cursor))).text());
    seen.push(...d.files.map(f => f.name));
  }
  ok(seen.length === 7, '翻页后拿到全部 7 个文件', seen.length);
  ok(new Set(seen).size === 7, '没有重复项');

  d = JSON.parse(await (await call(ADMIN + '/api?action=list')).text());
  ok(d.files.length === 7 && !d.cursor, '不带 pageSize 时仍一次返回全部（向后兼容）');
}

// ============ 8. 分片上传 ============
head('分片上传（大文件）');
{
  const { call, KV, R2 } = mk();
  let d = JSON.parse(await (await jpost(call, ADMIN + '/api', {
    action: 'mpCreate', path: 'big.bin', ct: 'application/octet-stream', size: 12, mtime: 1700000000000
  })).text());
  ok(d.ok && !!d.uploadId, '创建分片会话', d);
  const uid = d.uploadId;
  ok(!!(await KV.get('mp:' + uid)), '会话记录写进 KV');
  ok(d.partSize >= 5 * 1024 * 1024, '返回的分片大小是 MB 级（避免小文件误走多段）', d.partSize);

  let p = JSON.parse(await (await call(ADMIN + '/api?action=mpPart&uploadId=' + uid + '&part=1', {
    method: 'POST', body: U8(1, 2, 3, 4, 5, 6)
  })).text());
  ok(p.ok && p.partNumber === 1 && !!p.etag, '上传分片 1', p);
  const e1 = p.etag;
  p = JSON.parse(await (await call(ADMIN + '/api?action=mpPart&uploadId=' + uid + '&part=2', {
    method: 'POST', body: U8(7, 8, 9, 10, 11, 12)
  })).text());
  ok(p.ok, '上传分片 2');
  const e2 = p.etag;

  // 故意乱序提交，服务端应自己排序
  d = JSON.parse(await (await jpost(call, ADMIN + '/api', {
    action: 'mpComplete', uploadId: uid, parts: [{ partNumber: 2, etag: e2 }, { partNumber: 1, etag: e1 }]
  })).text());
  ok(d.ok, '完成分片上传', d);
  ok(!(await KV.get('mp:' + uid)), '会话结束后从 KV 清掉');

  const rec = R2.map.get('d/big.bin');
  ok(!!rec && rec.body.length === 12, '合并后的对象大小正确', rec && rec.body.length);
  ok(rec.body[0] === 1 && rec.body[11] === 12, '分片顺序正确（乱序提交也拼对）');

  // 无会话
  const bad = await call(ADMIN + '/api?action=mpPart&uploadId=nope&part=1', { method: 'POST', body: U8(1) });
  ok(bad.status === 404, '无效会话返回 404', bad.status);

  // ---- 续传：分片 etag 记进会话，complete 时不必前端自己攒 ----
  const c1 = JSON.parse(await (await jpost(call, ADMIN + '/api', {
    action: 'mpCreate', path: 'resume.bin', ct: 'application/octet-stream', size: 12
  })).text());
  const rid = c1.uploadId;
  await call(ADMIN + '/api?action=mpPart&uploadId=' + rid + '&part=1', { method: 'POST', body: U8(1, 2, 3, 4, 5, 6) });
  let lst2 = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'mpList' })).text());
  let sess = lst2.sessions.filter(s => s.uploaiId === rid || s.uploadId === rid)[0];
  ok(!!sess, '未完成会话出现在 mpList 里');
  ok(sess.parts.length === 1 && sess.parts[0] === 1, '会话记录了已传分片号（供前端跳过）', sess.parts);
  ok(sess.size === 12 && sess.path === 'resume.bin', '会话带回路径与大小，前端据此匹配续传');
  // 只补第 2 片，然后 complete 时不传 parts —— 服务端自己从会话里取
  await call(ADMIN + '/api?action=mpPart&uploadId=' + rid + '&part=2', { method: 'POST', body: U8(7, 8, 9, 10, 11, 12) });
  const comp = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'mpComplete', uploadId: rid })).text());
  ok(comp.ok && comp.parts === 2, '不传 parts 也能完成（服务端用会话里记录的分片）', comp);
  const rrec = R2.map.get('d/resume.bin');
  ok(!!rrec && rrec.body.length === 12 && rrec.body[0] === 1 && rrec.body[11] === 12, '续传合并结果正确');

  // abort
  const c2 = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'mpCreate', path: 'tmp.bin', size: 5 })).text());
  await jpost(call, ADMIN + '/api', { action: 'mpAbort', uploadId: c2.uploadId });
  ok(!(await KV.get('mp:' + c2.uploadId)), 'mpAbort 清理会话');
  ok(!R2.map.has('d/tmp.bin'), 'abort 后没有留下半成品对象');

  const lst = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'mpList' })).text());
  ok(lst.ok && lst.sessions.length === 0, 'mpList 没有残留会话', lst.sessions.length);
}

// ============ 9. 只读分享：作用域 + 权限 ============
head('只读分享：作用域与权限');
{
  const { call, KV, readIdx } = mk();
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: '公开' });
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: '私密' });
  await call(ADMIN + '/api?path=' + encodeURIComponent('公开/可见.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('公开内容 PUBLIC-MARK')
  });
  await call(ADMIN + '/api?path=' + encodeURIComponent('私密/机密.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('机密内容 SECRET-MARK')
  });
  const sh = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'share', path: '公开', expiresIn: 0 })).text());
  ok(sh.ok && !!sh.token, '创建目录分享');
  const base = '/s/' + sh.token;

  let r = await call(base);
  ok(r.status === 200, '访客能打开分享页');
  await r.text();

  const s = async q => JSON.parse(await (await call(base + '/api?action=search&q=' + encodeURIComponent(q))).text());
  // 方案 B：分享页只做文件名 / 路径搜索，正文不参与匹配（不加载全文索引，
  // 也就不必为影子树单独维护索引、更不会把没发布的草稿正文泄进结果）。
  let d = await s('可见');
  ok(d.results.length === 1 && d.results[0].path === '可见.txt', '访客能按文件名搜到分享范围内的文件', d.results.map(x => x.path));
  d = await s('PUBLIC-MARK');
  ok(d.results.length === 0, '访客搜正文关键词搜不到（分享页不做全文搜索）', d.results.map(x => x.path));
  d = await s('SECRET-MARK');
  ok(d.results.length === 0, '访客搜不到分享范围外的正文（越界被挡住）');
  d = await s('机密');
  ok(d.results.length === 0, '访客搜不到范围外的文件名');

  // 草稿改动不立刻出现在分享页：改完草稿，分享页仍是发布时的旧内容
  await call(ADMIN + '/api?path=' + encodeURIComponent('公开/可见.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('草稿改过了 DRAFT-MARK')
  });
  const readShare = () => call(base + '/api?action=read&path=' + encodeURIComponent('可见.txt'));
  let view = await readShare();
  ok((await view.text()) === '公开内容 PUBLIC-MARK', '改草稿不影响分享页（仍是发布版本）');

  // 显式发布后，分享页才更新为新内容
  const pub = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish', path: '公开', isDir: true })).text());
  ok(pub.ok && pub.published >= 1, '发布目录成功', pub);
  view = await readShare();
  ok((await view.text()) === '草稿改过了 DRAFT-MARK', '发布后分享页更新为最新内容');

  // 撤回发布：影子树副本删掉，分享页读不到（草稿仍在）
  const unp = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'unpublish', path: '公开', isDir: true })).text());
  ok(unp.ok && unp.removed >= 1, '撤回发布成功', unp);
  view = await readShare();
  ok(view.status === 404, '撤回后分享页读不到内容', view.status);
  await view.text();
  const dl2d = JSON.parse(await (await call(ADMIN + '/api?action=list&path=' + encodeURIComponent('公开'))).text());
  ok((dl2d.files || []).some(f => f.name === '可见.txt'), '撤回只动影子树，草稿文件仍在');
  // 恢复发布，供后续断言使用
  await jpost(call, ADMIN + '/api', { action: 'publish', path: '公开', isDir: true });

  const w = await call(base + '/api?path=x.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('hack') });
  ok(w.status === 403, '访客不能写入', w.status);
  const dl = await call(base + '/api?path=' + encodeURIComponent('可见.txt'), { method: 'DELETE' });
  ok(dl.status === 403, '访客不能删除', dl.status);
  const rx = await call(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reindex' }) });
  ok(rx.status === 403, '访客不能建索引', rx.status);

  // 单文件分享直连：建分享即自动发布，链接立刻可用
  const sf = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'share', path: '公开/可见.txt' })).text());
  ok(sf.kind === 'file', '单文件分享 kind=file');
  ok(sf.published === 1, '单文件分享自动发布');
  r = await call('/s/' + sf.token + '/' + encodeURIComponent('可见.txt'));
  ok(r.status === 200, '单文件分享能直接取到');
  ok((await r.text()) === '草稿改过了 DRAFT-MARK', '单文件分享内容正确（发布版本）');

  // shares 列表带发布状态
  const sl = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'shares' })).text());
  ok(sl.ok && sl.shares.every(x => x.published === true), 'shares 列表标记已发布', sl.shares.map(x => [x.path, x.published]));
}

// ============ 9.5 发布机制（草稿 / 已发布分离）============
head('发布机制：编辑与分享分离');
{
  const { call } = mk();
  const put = (p, s) => call(ADMIN + '/api?path=' + encodeURIComponent(p), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc(s)
  });
  // 分享目录要求目录本身真实存在（靠 mkdir 占位），不能只往里塞文件
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: '文稿' });
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '文稿', name: '子' });
  await put('文稿/a.txt', 'V1');
  await put('文稿/子/b.txt', 'B1');

  // 建分享即发布：链接拿到就能打开，不用先点一次"发布"
  // 4 个对象 = 文稿/ 目录占位 + a.txt + 子/ 目录占位 + 子/b.txt
  const sh = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'share', path: '文稿' })).text());
  ok(sh.ok && sh.published === 4, '建目录分享时自动发布全部内容', sh);
  ok(!sh.publishError, '自动发布没有报错', sh.publishError);
  const page1 = await call('/s/' + sh.token + '/');
  ok(page1.status === 200 && (await page1.text()).indexOf('a.txt') >= 0, '分享页立刻能列出内容');

  // 改草稿 → 分享页不变；点发布 → 分享页才更新
  await put('文稿/a.txt', 'V2-草稿');
  const rd = () => call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('a.txt'));
  ok((await (await rd()).text()) === 'V1', '改草稿后分享页仍是旧发布版本');
  const up = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish', path: '文稿', isDir: true })).text());
  ok(up.ok && up.published === 4, '再次发布刷新整个目录', up);
  ok((await (await rd()).text()) === 'V2-草稿', '发布后分享页更新');

  // 撤回：分享页 404，但草稿与链接都留着，且列表要标"待发布"而不是清掉
  const un = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'unpublish', path: '文稿', isDir: true })).text());
  ok(un.ok && un.removed === 4, '撤回删掉影子树副本', un);
  const after = await call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('a.txt'));
  ok(after.status === 404, '撤回后分享页读不到', after.status);
  await after.text();
  const dl = JSON.parse(await (await call(ADMIN + '/api?action=list&path=' + encodeURIComponent('文稿'))).text());
  ok((dl.files || []).some(f => f.name === 'a.txt'), '撤回后草稿文件仍在', dl);
  let sl = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'shares' })).text());
  let rec = sl.shares.find(x => x.token === sh.token);
  ok(!!rec, '撤回不会把分享记录一起清掉（链接还有效，只是没内容）');
  ok(rec && rec.published === false, '撤回后 shares 标记为未发布', rec && rec.published);

  // 重新发布可恢复
  await jpost(call, ADMIN + '/api', { action: 'publish', path: '文稿', isDir: true });
  ok((await (await rd()).text()) === 'V2-草稿', '重新发布后分享页恢复');

  // ---- 无改动时再点发布 = 零写入的 no-op ----
  // 这是「发布」按钮在"没有改动"时置灰的服务端兜底：不管客户端怎么调，
  // 影子树里已经是这份内容时都不会再复制一遍（目录分享尤其贵——整棵子树重写）。
  const noop = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish', path: '文稿', isDir: true })).text());
  ok(noop.ok && noop.unchanged === true && noop.published === 0, '无改动时发布 = no-op（published 0 + unchanged）', noop);

  // 改一个字之后，同样的调用就必须真的发布 —— 判据是内容指纹（size+etag），不是时间戳
  const rdB = () => call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('子/b.txt'));
  await put('文稿/子/b.txt', 'B2');
  const real = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish', path: '文稿', isDir: true })).text());
  ok(real.ok && !real.unchanged && real.published >= 1, '改动后发布照常执行', real);
  ok((await (await rdB()).text()) === 'B2', '改动后发布，分享页拿到新内容');

  // pubState：给前端"置灰发布按钮"用的状态查询（true 已同步 / false 有改动）
  const st = (p, d) => jpost(call, ADMIN + '/api', { action: 'pubState', items: [{ path: p, isDir: !!d }] }).then(r => r.json());
  const s1 = await st('文稿', true);
  ok(s1.ok && s1.states['文稿'] === true, 'pubState：目录刚发布 → 已同步', s1);
  await put('文稿/子/b.txt', 'B3');
  const s2 = await st('文稿/子/b.txt', false);
  ok(s2.ok && s2.states['文稿/子/b.txt'] === false, 'pubState：改过草稿 → 未同步', s2);
  const s3 = await st('文稿', true);
  ok(s3.ok && s3.states['文稿'] === false, 'pubState：目录里有文件改了 → 整个目录算未同步', s3);
  await jpost(call, ADMIN + '/api', { action: 'publish', path: '文稿/子/b.txt', isDir: false });
  const s4 = await st('文稿/子/b.txt', false);
  ok(s4.ok && s4.states['文稿/子/b.txt'] === true, 'pubState：单文件发布后 → 已同步', s4);
  ok((await (await rdB()).text()) === 'B3', '单文件发布后分享页也更新');

  // publishAll：给"有记录但影子树里没内容"的存量分享补发。
  // 顺序很关键：先建分享（会自动发布），再撤回 —— 这就还原出"老版本只有记录没内容"的存量状态。
  await jpost(call, ADMIN + '/api', { action: 'share', path: '文稿/子' });
  await jpost(call, ADMIN + '/api', { action: 'unpublish', path: '文稿/子', isDir: true });
  sl = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'shares' })).text());
  ok(sl.shares.some(x => x.published === false), '存在一条待发布的分享（存量场景）', sl.shares.map(x => [x.path, x.published]));
  const all = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publishAll' })).text());
  ok(all.ok && all.published >= 1, 'publishAll 补发了待发布的分享', all);
  ok(all.skipped >= 1, 'publishAll 跳过已发布的（不会覆盖新版本）', all);
  ok(Array.isArray(all.failed) && all.failed.length === 0, 'publishAll 没有失败项', all.failed);
  sl = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'shares' })).text());
  ok(sl.shares.every(x => x.published === true), '补发后全部标记为已发布', sl.shares.map(x => [x.path, x.published]));

  // 移动 / 改名后，已发布副本跟着走，分享页不至于 404
  const mv = JSON.parse(await (await jpost(call, ADMIN + '/api', {
    action: 'move', path: '文稿/a.txt', toDir: '文稿', newName: '改.txt'
  })).text());
  ok(mv.ok, '移动文件成功', mv);
  const moved = await call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('改.txt'));
  ok(moved.status === 200 && (await moved.text()) === 'V2-草稿', '移动后已发布副本跟着搬（分享页仍可读）', moved.status);
  const gone = await call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('a.txt'));
  ok(gone.status === 404, '旧名字在分享页已不可读', gone.status);
  await gone.text();

  // 删除时两边一起清，不留孤儿副本
  await call(ADMIN + '/api?action=deleteBatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ path: '文稿/改.txt', isDir: false }] })
  });
  const del = await call('/s/' + sh.token + '/api?action=read&path=' + encodeURIComponent('改.txt'));
  ok(del.status === 404, '删除后影子树副本也清掉了', del.status);
  await del.text();

  // 参数校验
  let bad = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish' })).text());
  ok(bad.ok === false, 'publish 缺 path 报错', bad);
  bad = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'publish', path: '不存在.txt' })).text());
  ok(bad.ok === false, '发布不存在的路径报错', bad);
}

// ============ 10. 登录鉴权 ============
head('登录鉴权');
{
  const { call } = mk({ PASSWORD: 'pw123456', ADMIN_UUID: 'adm-123' });
  let r = await call(ADMIN + '/api?action=list');
  ok(r.status === 401, '未登录访问 API → 401', r.status);
  await r.text();
  r = await call(ADMIN);
  ok(r.status === 401, '未登录访问管理页 → 登录页');
  const h = await r.text();
  ok(h.indexOf('管理登录') >= 0, '返回的是登录页');
  ok(h.indexOf('name="password"') >= 0, '登录页有密码框');
}

// ============ 11. 分享页渲染检查 ============
head('分享页 HTML');
{
  const { call } = mk();
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: 'D' });
  const sh = JSON.parse(await (await jpost(call, ADMIN + '/api', { action: 'share', path: 'D' })).text());
  const r = await call('/s/' + sh.token);
  const h = await r.text();
  ok(h.indexOf('id="vRender"') >= 0, '分享页有渲染容器');
  ok(h.indexOf('id="edt"') < 0, '分享页没有编辑器');
  ok(h.indexOf('id="findBar"') < 0, '分享页没有查找栏');
  ok(/nonce-/.test(h), 'CSP nonce 已注入');
  ok(h.indexOf("img-src 'self' data: blob:") >= 0, 'CSP 放行 blob: 图片');
  ok(h.indexOf("frame-src 'self' blob:") >= 0, 'CSP 放行 blob: 框架');
  ok(h.indexOf("object-src 'none'") >= 0, "object-src 仍为 none");
}

// ============ 12. INDEX_TEXT_CAP 可配置 ============
head('索引配额可配置');
{
  const { call, KV, R2, readIdx } = mk({ INDEX_TEXT_CAP: '120' });
  await call(ADMIN + '/api?path=大正文.txt', {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('甲'.repeat(300) + 'UNIQUE-TAIL')
  });
  // 同步建索引：保存当场就写了，所以不用先搜一次
  const idx = await readIdx();
  const e = idx.files['大正文.txt'];
  ok(e !== undefined, '文件进了索引');
  ok(e[0] === 2, '配额很小时该文件只留文件名索引（r=2）', e[0]);
  ok(e[4] === null, '正文没有被存进索引', e[4]);
  const st = JSON.parse(await (await call(ADMIN + '/api?action=idxstat')).text());
  ok(st.textCap === 120, 'idxstat 回传生效的配额', st.textCap);
  const d = JSON.parse(await (await call(ADMIN + '/api?action=search&q=UNIQUE-TAIL')).text());
  ok(d.results.length === 0, '超配额的文件搜不到正文（符合预期）');
  const d2 = JSON.parse(await (await call(ADMIN + '/api?action=search&q=大正文')).text());
  ok(d2.results.length === 1 && d2.results[0].nameHit, '但仍能按文件名搜到');
}

// ============ 13. 列表排序 ============
head('列表排序（名称 / 类型 / 大小 / 时间）');
{
  const { call } = mk();
  const put = (name, ct, body) => call(ADMIN + '/api?path=' + encodeURIComponent(name), {
    method: 'PUT', headers: { 'Content-Type': ct }, body: enc(body)
  });
  await put('b.md', 'text/markdown', enc('bb'));
  await put('a.py', 'text/x-python', enc('aaaa'));
  await put('c.txt', 'text/plain', enc('c'));
  await put('d.py', 'text/x-python', enc('dddddddd'));
  await jpost(call, ADMIN + '/api', { action: 'mkdir', path: '', name: 'zzdir' });

  const L = async (q) => JSON.parse(await (await call(ADMIN + '/api?action=list' + q)).text());
  const names = d => d.files.map(f => f.name).join(',');

  let d = await L('&sort=name&desc=0');
  ok(names(d) === 'a.py,b.md,c.txt,d.py', '按名称升序', names(d));
  d = await L('&sort=name&desc=1');
  ok(names(d) === 'd.py,c.txt,b.md,a.py', '按名称降序', names(d));

  d = await L('&sort=size&desc=1');
  ok(names(d) === 'd.py,a.py,b.md,c.txt', '按大小降序', names(d));
  d = await L('&sort=size&desc=0');
  ok(names(d) === 'c.txt,b.md,a.py,d.py', '按大小升序', names(d));

  d = await L('&sort=type&desc=0');
  ok(names(d) === 'b.md,a.py,d.py,c.txt', '按类型升序（md → py → txt）', names(d));

  d = await L('&sort=time&desc=1');
  ok(d.files.length === 4, '按修改时间降序能正常返回', d.files.length);

  d = await L('&sort=name&desc=0');
  ok(d.folders.join(',') === 'zzdir', '文件夹始终排在最前', d.folders);
  ok(d.total === 5, 'total 把文件夹算进去', d.total);
  ok(d.sort === 'name' && d.desc === false, '回传生效的排序参数', { sort: d.sort, desc: d.desc });

  // 非法 sort 值应回落到 name
  d = await L('&sort=%3Cscript%3E&desc=0');
  ok(names(d) === 'a.py,b.md,c.txt,d.py', '非法排序字段回落到名称', names(d));

  // 排序 + 分页：跨页拼接后全局顺序必须仍然正确
  const all = [];
  let cur = '', guard = 0;
  do {
    const page = await L('&sort=size&desc=1&pageSize=2' + (cur ? '&cursor=' + cur : ''));
    all.push(...page.files.map(f => f.name));
    cur = page.cursor || '';
  } while (cur && guard++ < 10);
  ok(all.join(',') === 'd.py,a.py,b.md,c.txt', '排序与分页组合时全局顺序正确', all);
  ok(guard < 10, '分页轮数正常（不会死循环）', guard);
}

// ============ PWA：manifest / sw.js / 动态图标 ============
head('PWA 静态件');
{
  const { call } = mk();

  // manifest：未登录也要能拿到（浏览器加主屏时可能还没登录）
  const mfRes = await call('/manifest.webmanifest');
  ok(mfRes.status === 200, 'manifest 200（不需要登录）');
  ok(/application\/manifest\+json/.test(mfRes.headers.get('Content-Type') || ''), 'manifest 的 Content-Type 正确');
  const mf = await mfRes.json();
  ok(mf.name === '测试盘', 'manifest.name 来自 FILENAME', mf.name);
  ok(mf.short_name === '测试盘', 'manifest.short_name 截断到 12 字以内', mf.short_name);
  ok(mf.display === 'standalone', 'display standalone（无浏览器地址栏）');
  ok(mf.start_url === '/adm-123', 'start_url 指向管理路径（站点根没有页面，填 / 会 404）', mf.start_url);
  ok(mf.scope === '/', 'scope 覆盖全站');
  ok(Array.isArray(mf.icons) && mf.icons.length >= 3, '声明了 192 / 512 / maskable 三枚图标', mf.icons);
  ok(mf.icons.every(i => i.src.indexOf('/icon/') === 0), '图标走动态路由');

  // sw.js
  const swRes = await call('/sw.js');
  ok(swRes.status === 200, 'sw.js 200');
  ok(swRes.headers.get('Service-Worker-Allowed') === '/', 'Service-Worker-Allowed 头放开整个域');
  ok(/no-cache/.test(swRes.headers.get('Cache-Control') || ''), 'sw.js 用 no-cache（每次校验更新）');
  const swSrc = await swRes.text();
  ok(swSrc.indexOf('skipWaiting') >= 0 && swSrc.indexOf('clients.claim') >= 0, 'SW 会立即接管页面');
  ok(swSrc.indexOf("addEventListener('fetch'") >= 0, 'SW 拦截 fetch');
  ok(swSrc.indexOf("req.method !== 'GET'") >= 0, '写请求一律不走 SW（直连网络）');
  ok(swSrc.indexOf('当前离线') >= 0, '断网兜底页存在');
  // 绝不能缓存页面/API —— 页面带随机 nonce 与登录态
  ok(swSrc.indexOf('isStatic') >= 0 && swSrc.indexOf("req.mode === 'navigate'") >= 0,
    'SW 只缓存图标/manifest，导航请求网络优先');

  // 图标：验 PNG 结构，而不是只看 200
  for (const sz of [180, 192, 512]) {
    const r = await call('/icon/' + sz + '.png');
    ok(r.status === 200, 'icon/' + sz + '.png 200');
    ok(/image\/png/.test(r.headers.get('Content-Type') || ''), 'Content-Type 是 image/png');
    ok(/immutable/.test(r.headers.get('Cache-Control') || ''), '图标带一年长缓存');
    const buf = new Uint8Array(await r.arrayBuffer());
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    ok(sig.every((b, i) => buf[i] === b), 'PNG 签名正确');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    ok(dv.getUint32(8) === 13, 'IHDR 长度 13');
    const w = dv.getUint32(16), h = dv.getUint32(20);
    ok(w === sz && h === sz, 'IHDR 尺寸 ' + sz + 'x' + sz, w + 'x' + h);
    ok(buf[24] === 8 && buf[25] === 3, '8bit 索引色（colorType 3，生成 CPU 最低）');
    // 解析 chunk 链找 IDAT —— 索引色多了 PLTE/tRNS，偏移不能硬编码
    let coff = 8, hasPlte = false, idatOff = -1, idatLen = 0;
    while (coff + 12 <= buf.length){
      const len = dv.getUint32(coff);
      const ty = String.fromCharCode(buf[coff + 4], buf[coff + 5], buf[coff + 6], buf[coff + 7]);
      if (ty === 'PLTE') hasPlte = true;
      if (ty === 'IDAT'){ idatOff = coff + 8; idatLen = len; break; }
      coff += 12 + len;
    }
    ok(hasPlte, '带 PLTE 调色板块');
    // IDAT 必须能被 zlib 解压回去（验证 CompressionStream 产物是合法 zlib 流）
    let inflated = null;
    if (idatOff > 0){
      try { inflated = inflateSync(Buffer.from(buf.buffer, buf.byteOffset + idatOff, idatLen)); } catch (e) { inflated = null; }
    }
    ok(!!inflated && inflated.length === sz * (sz + 1),
      'IDAT 是合法 zlib 流且解压后大小正确', inflated ? inflated.length : 'inflate 失败');
  }

  // 尺寸约束：过小/过大不给生成
  ok((await call('/icon/8.png')).status === 404, '过小尺寸 404');
  ok((await call('/icon/2000.png')).status === 404, '过大尺寸 404');
  ok((await call('/icon/abc.png')).status !== 200, '非数字尺寸不放行');

  // 同一 isolate 的第二次请求应命中内存缓存（体积一致即可视为命中）
  const a = await (await call('/icon/512.png')).arrayBuffer();
  const b = await (await call('/icon/512.png')).arrayBuffer();
  ok(a.byteLength === b.byteLength && a.byteLength > 0, '重复请求结果稳定');

  // 两个页面都带 PWA meta
  const homeHtml = await (await call(ADMIN)).text();
  ok(homeHtml.indexOf('/manifest.webmanifest') >= 0, '管理页声明了 manifest');
  ok(homeHtml.indexOf('apple-mobile-web-app-capable') >= 0, '管理页带 iOS 主屏 meta');
  ok(homeHtml.indexOf('apple-touch-icon') >= 0, '管理页带 apple-touch-icon');
  ok(homeHtml.indexOf("register('/sw.js'") >= 0, '管理页注册 SW');
  ok(homeHtml.indexOf('theme-color') >= 0, '管理页带 theme-color');
  // 登录页也带 PWA meta（设置 PASSWORD 后未登录访问 → 登录页）
  const lp = mk({ PASSWORD: 'pwa-test-pass' });
  const loginRes = await lp.call(ADMIN);
  const loginHtml = await loginRes.text();
  ok(loginRes.status === 401 && loginHtml.indexOf('<!doctype html>') >= 0, '设置密码后未登录返回登录页');
  ok(loginHtml.indexOf('/manifest.webmanifest') >= 0, '登录页也声明了 manifest');
  ok(loginHtml.indexOf('apple-touch-icon') >= 0, '登录页也带 apple-touch-icon');
}

console.log('\n' + (fail ? `❌ ${fail} 项失败，${pass} 项通过` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
