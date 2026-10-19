// 针对三处修复 + 索引容量自动降级的验证（驱动真实 worker.js）
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok   ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

function mk(env) {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = Object.assign({ R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' }, env || {});
  const call = async (path, init) => {
    const u = /^https?:\/\//.test(path) ? path : ORIGIN + path;
    const res = await worker.fetch(new Request(u, init), e, exec);
    await Promise.all(exec.waits.splice(0));
    return res;
  };
  const put = (p, ct, body) => call(ADMIN + '/api?path=' + encodeURIComponent(p), {
    method: 'PUT', headers: { 'Content-Type': ct }, body
  });
  const jpost = (url, obj) => call(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  });
  const search = async q => (await call(ADMIN + '/api?action=search&q=' + encodeURIComponent(q))).json();
  return { R2, KV, e, call, put, jpost, search,
    readIdx: async () => { const o = await R2.get('__sys__/idx.json'); return o ? JSON.parse(await o.text()) : null; } };
}
const enc = s => new TextEncoder().encode(s);

// ============ 修复 2：索引缺条目时，文件名依然必须搜得到 ============
head('修复 2 · 索引不完整时补扫 R2 文件名');
{
  const { R2, put, search } = mk();

  // 通过上传接口进来的 5 个文件 → 会进索引
  const inside = ['aaa.txt', 'bbb.txt', 'ccc.txt', 'ddd.txt', 'eee.txt'];
  for (const n of inside) await put('fniao/' + n, 'text/plain', enc('内容 ' + n));

  // "外部来源"的 7 个文件：直接写进 R2，不经过 worker → 索引里没有
  const outside = ['节点链接_去重.txt', 'fluxyun_nodes.txt', 'fsdfsd.txt',
    'process_nodes.py', 'check_dup.py', 'fengniao_sign.py', 'inspect_fluxyun.py'];
  for (const n of outside) await R2.put('d/fniao/' + n, enc('正文不含关键词\n'));

  const idxRaw = await (await R2.get('__sys__/idx.json')).text();
  ok(JSON.parse(idxRaw).files && Object.keys(JSON.parse(idxRaw).files).length === 5,
    '前置状态正确：索引里只有 5 个文件', Object.keys(JSON.parse(idxRaw).files).length);

  const d = await search('去重');
  ok(d.indexedCount === 5, 'indexedCount 仍如实反映索引条数 = 5', d.indexedCount);
  ok(d.stale === 7, 'stale 报告 7 个未入索引的文件', d.stale);
  const hit = d.results.find(r => r.path.indexOf('节点链接_去重') >= 0);
  ok(!!hit, '「节点链接_去重.txt」出现在搜索结果里');
  ok(hit && hit.nameHit === true, '它被判定为【文件名命中】（前端会打「文件名」标签）', hit && hit.nameHit);
  ok(d.nameHits === 1, 'nameHits = 1', d.nameHits);
  ok(d.results.length === 1, '只返回 1 条（其余文件正文不含「去重」）', d.results.length);

  // 内容命中依然走索引：5 个已入索引的文件正文里都有「内容」
  const d2 = await search('内容');
  ok(d2.textHits === 5 && d2.nameHits === 0, '正文命中由索引提供（textHits=5）', { t: d2.textHits, n: d2.nameHits });
  ok(d2.results.length === 5, '未入索引的 7 个文件没有正文、不参与正文匹配', d2.results.length);

  // 补进来的文件是 r=2（无正文），不该被误当成正文命中
  const d3 = await search('关键词');
  ok(d3.results.length === 0, '未入索引的文件不参与正文匹配（避免"假命中"）', d3.results.length);
}

// ============ 修复 3：reindex 撞上并发写不再整批作废 ============
head('修复 3 · reindex 条件写冲突自动重读重放');
{
  const { R2, put, jpost, readIdx } = mk();
  const names = ['x1.txt', 'x2.txt', 'x3.txt', 'x4.txt'];
  for (const n of names) await put('fniao/' + n, 'text/plain', enc('hello ' + n));
  // 再塞 2 个外部文件，让 reindex 有事可做
  await R2.put('d/fniao/外部_去重.txt', enc('外部文件正文'));

  // 打补丁：第一次条件写直接判 preconditionFailed（模拟"重建期间有人在上传"）
  const origPut = R2.put.bind(R2);
  let conflict = 0;
  R2.put = async (k, v, o) => {
    if (k === '__sys__/idx.json' && o && o.onlyIf && conflict === 0) {
      conflict++;
      return { key: k, preconditionFailed: true, etag: undefined };
    }
    return origPut(k, v, o);
  };

  const r = await jpost(ADMIN + '/api', { action: 'reindex', limit: 40, lastKey: '' });
  const d = await r.json();
  ok(r.status === 200 && d.ok === true, '不再返回 409，整批重建成功', { status: r.status, d });
  ok(conflict === 1, '确实发生过一次条件写冲突（说明重放路径被触发）', conflict);

  const idx = await readIdx();
  const keys = Object.keys(idx.files);
  ok(keys.length === 5, '索引里现在有全部 5 个文件', keys);
  ok(keys.indexOf('fniao/外部_去重.txt') >= 0, '外部文件被补进索引');
  ok(idx.files['fniao/外部_去重.txt'][4] === '外部文件正文',
    '外部文件的正文也进了索引（下次搜索走索引即可）', idx.files['fniao/外部_去重.txt'][4]);
}

// ============ 容量自动降级：渐进缩短片段，而不是全有/全无 ============
head('容量降级 · 配额快满时自动缩短单文件正文片段');
{
  const { put, call, search } = mk({ INDEX_TEXT_CAP: '10000' });
  // 4 个文件，每个 4000 字符正文（总需求 16000 > 配额 10000）
  for (let i = 1; i <= 4; i++) await put('big/f' + i + '.txt', 'text/plain', enc('A'.repeat(4000)));

  const d = await (await call(ADMIN + '/api?action=idxstat')).json();
  ok(d.textCap === 10000, 'textCap 采用环境变量 10000', d.textCap);
  ok(d.full === 2, '前 2 个文件正文完整入索引', d);
  ok(d.part === 1, '第 3 个文件正文被【截断】入索引（渐进降级，而不是直接放弃）', d);
  ok(d.none === 1, '配额耗尽后第 4 个文件才退化成只按文件名', d);

  const s = await search('AAAA');
  ok(s.results.length === 3, '3 个有正文的文件都能被搜到（被截断的那个也在）',
    s.results.map(r => r.path));
  ok(s.results.some(r => r.path === 'big/f3.txt'), '被截断的 f3.txt 依然能按正文搜到',
    s.results.map(r => r.path));

  // 配额耗尽的那个文件不会凭空消失 —— 仍可按文件名搜到
  const s2 = await search('f4');
  ok(s2.results.length === 1 && s2.results[0].nameHit === true,
    'f4.txt 仍可按文件名搜到（搜索永远不会静默漏文件）', s2.results.map(r => r.path));
}

// ============ 硬上限：环境变量调再大也夹回 1.5MB ============
head('容量硬上限 · INDEX_TEXT_CAP 被夹在 1.5MB 内');
{
  const { call } = mk({ INDEX_TEXT_CAP: '99999999' });
  const d = await (await call(ADMIN + '/api?action=idxstat')).json();
  ok(d.textCap === 1536 * 1024, 'textCap 被夹到 1572864', d.textCap);
}

// ============ 回归：索引为空时仍走原来的扫描路径 ============
head('回归 · 完全没有索引时仍然能搜到文件名');
{
  const { R2, search } = mk();
  await R2.put('d/fniao/节点链接_去重.txt', enc('正文'));
  await R2.put('d/fniao/other.txt', enc('正文'));
  const d = await search('去重');
  ok(d.indexed === false, 'indexed=false（未建索引）', d.indexed);
  ok(d.results.length === 1 && d.results[0].path === 'fniao/节点链接_去重.txt',
    '无索引时按文件名扫描仍然命中', d.results.map(r => r.path));
}

// ============ 本轮优化：ftype 类型筛选（服务端过滤 + 计数如实） ============
head('优化 · ftype 类型筛选');
{
  const { put, call } = mk();
  await put('fniao/去重工具.txt', 'text/plain', enc('正文里没有那个词'));
  await put('fniao/其他.txt', 'text/plain', enc('正文里有 去重 这个词'));
  const q = 'q=' + encodeURIComponent('去重');
  const all = await (await call(ADMIN + '/api?action=search&' + q)).json();
  ok(all.total === 2, '不筛选时命中 2 条', all.total);
  ok(all.nameHits === 1 && all.textHits === 1, '计数如实（文件名 1 / 正文 1）', { n: all.nameHits, t: all.textHits });

  const onlyName = await (await call(ADMIN + '/api?action=search&' + q + '&ftype=name')).json();
  ok(onlyName.total === 1 && onlyName.results[0].nameHit === true,
    'ftype=name 只回文件名命中', onlyName.results.map(r => r.path));
  ok(onlyName.nameHits === 1 && onlyName.textHits === 1,
    '筛选不改变各类型计数（筛选芯片要显示总量）', { n: onlyName.nameHits, t: onlyName.textHits });

  const onlyText = await (await call(ADMIN + '/api?action=search&' + q + '&ftype=text')).json();
  ok(onlyText.total === 1 && !onlyText.results[0].nameHit,
    'ftype=text 只回正文命中', onlyText.results.map(r => r.path));

  // 分组用的 kind 判定依据（前端 srKind 与之一致）：文件夹条目永不出现在 ftype=name 里
  const onlyDir = await (await call(ADMIN + '/api?action=search&' + q + '&ftype=dir')).json();
  ok(onlyDir.total === 0, 'ftype=dir 只回文件夹，本例没有文件夹命中', onlyDir.total);
}

// ============ 本轮优化：补扫缓存（2.5）省 R2 + 写操作后立即失效 ============
head('优化 · 补扫缓存：重复搜索省 R2，写操作后立即失效');
{
  const { R2, put, call } = mk();
  for (let i = 0; i < 5; i++) await R2.put('d/fniao/f' + i + '_去重.txt', enc('x'));
  const q = 'q=' + encodeURIComponent('去重');

  const before = R2.ops.list;
  const s1 = await (await call(ADMIN + '/api?action=search&' + q)).json();
  const list1 = R2.ops.list - before;
  ok(list1 > 0, '首次搜索确实扫了 R2（list ' + list1 + ' 次）', list1);
  ok(s1.scanCached === false, '首次搜索如实报告 scanCached=false', s1.scanCached);

  const s2 = await (await call(ADMIN + '/api?action=search&' + q)).json();
  ok(s2.scanCached === true, '第二次搜索命中补扫缓存（scanCached=true）', s2.scanCached);
  ok(R2.ops.list === before + list1, '第二次搜索不再产生新的 R2 list',
    { a: list1, b: R2.ops.list - before });

  // 换一个词也复用同一份清单（60s 内）
  const s3 = await (await call(ADMIN + '/api?action=search&q=' + encodeURIComponent('内容'))).json();
  ok(s3.scanCached === true, '换个关键词仍然复用缓存清单', s3.scanCached);

  // 经 Worker 上传 → 缓存必须立即失效，新文件马上能搜到
  await put('fniao/新来_去重.txt', 'text/plain', enc('y'));
  const s4 = await (await call(ADMIN + '/api?action=search&' + q)).json();
  ok(s4.scanCached === false, '写操作后补扫缓存立即失效（scanCached=false）', s4.scanCached);
  ok(s4.results.some(r => r.path.indexOf('新来_去重') >= 0),
    '新上传的文件马上能搜到（不会等满 60 秒）', s4.results.map(r => r.path));
}

// ============ 本轮优化：补扫缓存按 bucket 分桶（不跨盘串味） ============
head('优化 · 补扫缓存按 bucket 隔离');
{
  const a = mk();
  await a.R2.put('d/fniao/A盘_去重.txt', enc('x'));
  const da = await a.search('去重');
  ok(da.results.length === 1 && da.results[0].path.indexOf('A盘_去重') >= 0,
    'A 盘搜到自己的文件', da.results.map(r => r.path));

  // 立刻换一个全新的 R2 绑定搜同一个词：绝不能命中 A 盘缓存的清单
  const b = mk();
  await b.R2.put('d/fniao/B盘_去重.txt', enc('y'));
  const db = await b.search('去重');
  ok(db.results.length === 1 && db.results[0].path.indexOf('B盘_去重') >= 0,
    'B 盘只看到自己的文件（缓存不跨 bucket 复用）', db.results.map(r => r.path));
}

console.log('\n' + (fail ? 'FAILED ' : 'ALL PASS ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);