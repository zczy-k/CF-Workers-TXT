// 上限瓶颈实测：把每个天花板和"撞到之后会怎样"都钉成断言
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev', ADMIN = '/adm-123';
let fail = 0, pass = 0;
const ok = (c, m, e) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const head = t => console.log('\n== ' + t + ' ==');
function mk(env) {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = Object.assign({ R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '盘' }, env || {});
  const call = async (p, i) => { const r = await worker.fetch(new Request(ORIGIN + p, i), e, exec); await Promise.all(exec.waits.splice(0)); return r; };
  return { R2, KV, call, jp: (u, o) => call(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }),
    idx: async () => { const o = await R2.get('__sys__/idx.json'); return o ? JSON.parse(await o.text()) : null; } };
}
const enc = s => new TextEncoder().encode(s);
const put = (c, p, s) => c.call(ADMIN + '/api?path=' + encodeURIComponent(p), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc(s) });
const reindexAll = async c => {
  let lastKey = '', round = 0, d;
  do { d = await (await c.jp(ADMIN + '/api', { action: 'reindex', limit: 40, lastKey })).json(); if (d.lastKey) lastKey = d.lastKey; round++; } while (!d.done && round < 400);
  return d;
};

head('1. 索引正文文件数上限 3000（超出降级为只按文件名搜）');
{
  const c = mk();
  for (let i = 0; i < 3100; i++) await c.R2.put('d/f' + i + '.txt', enc('body ' + i), { customMetadata: { mtime: String(1700000000000 + i) } });
  await reindexAll(c);
  const idx = await c.idx();
  const all = Object.keys(idx.files);
  const withText = all.filter(k => idx.files[k][4]).length;
  ok(all.length === 3100, '索引条目数不设上限（3100 个文件 → 3100 条条目）', all.length);
  ok(withText === 3000, '只有前 3000 个索引了正文，其余自动降级', withText);
  ok(all.slice(3000).every(k => idx.files[k][0] === 2), '超出的条目标记 r=2（只按文件名搜）');
  ok((await (await c.call(ADMIN + '/api?action=search&q=f3099.txt')).json()).results.length >= 1, '超限文件仍能搜到文件名');
  await put(c, 'brandnew.txt', 'ZZTOPCONTENT');
  ok(!(await c.idx()).files['brandnew.txt'], '满 3000 后新文件不进索引');
  ok((await (await c.call(ADMIN + '/api?action=search&q=brandnew.txt')).json()).results.length >= 1, '但搜文件名照样能找到（补扫兜底）');
  ok((await (await c.call(ADMIN + '/api?action=search&q=ZZTOPCONTENT')).json()).results.length === 0, '搜正文搜不到（这是 3000 上限的代价）');
  ok((await (await c.call(ADMIN + '/api?action=idxstat')).json()).none > 0, 'idxstat 如实报告未索引正文数量');
}

head('2. 索引正文总量上限 1MB（渐进降级，不是一刀切）');
{
  const c = mk();
  // 大小不一，把配额逼到边界才会看到"渐变"
  for (let i = 0; i < 200; i++) {
    const sz = 4000 + (i % 40) * 200;
    await c.R2.put('d/v' + String(i).padStart(4, '0') + '.txt', enc('A'.repeat(sz)), { customMetadata: { mtime: String(1700000000000 + i) } });
  }
  await reindexAll(c);
  const idx = await c.idx();
  ok(idx.tb <= 1024 * 1024, '正文总量不超过 1MB（实际 ' + (idx.tb / 1024).toFixed(0) + 'KB）', idx.tb);
  const lens = Object.values(idx.files).filter(e => e[4]).map(e => e[4].length);
  const uniq = [...new Set(lens)].sort((a, b) => a - b);
  ok(uniq.length > 1, '片段长度是渐变的（' + uniq.length + ' 种：' + uniq[0] + '~' + uniq[uniq.length - 1] + ' 字节），不是全留或全不留');
  ok((await (await c.call(ADMIN + '/api?action=search&q=AAAA')).json()).capFull === true, 'capFull=true，前端提示容量已满并引导调大 INDEX_TEXT_CAP');
}

head('3. 单文件超过 512KB 不索引正文（文件本身照存）');
{
  const c = mk();
  await c.call(ADMIN + '/api?path=small.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array(512 * 1024 - 1) });
  await c.call(ADMIN + '/api?path=big.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array(512 * 1024 + 1) });
  const idx = await c.idx();
  ok(idx.files['small.txt'][0] !== 2, '刚低于 512KB 会索引正文', idx.files['small.txt'][0]);
  ok(idx.files['big.txt'][0] === 2, '超 512KB 不索引正文（r=2）', idx.files['big.txt'][0]);
  ok((await c.R2.get('d/big.txt')).size === 512 * 1024 + 1, '文件本身完整保存，索引限制不影响存储');
  ok((await (await c.call(ADMIN + '/api?action=search&q=big.txt')).json()).results.length >= 1, '大文件仍能按文件名搜到');
}

head('4. 目录列表：treeFull 单层 500，list 走分页不限总量，manifest 上限 20000');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'big' });
  for (let i = 0; i < 600; i++) await c.R2.put('d/big/x' + i + '.txt', enc('x'));
  ok((await (await c.call(ADMIN + '/api?action=treeFull&rootName=根')).json()).truncated === true, 'treeFull 单目录超 500 报 truncated');
  let cursor = '', total = 0, rounds = 0;
  do {
    const q = 'action=list&path=big&pageSize=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const d = await (await c.call(ADMIN + '/api?' + q)).json();
    total += d.files.length; cursor = d.cursor; rounds++;
  } while (cursor && rounds < 20);
  ok(total === 600, 'list 分页能翻完 600 个（不受 500 限制）', total);
  const man = await (await c.call(ADMIN + '/api?action=manifest&path=big')).json();
  ok(man.entries.length === 600 && man.truncated === false, 'manifest 拿全 600 条（上限 20000）', man.entries.length);
}

head('5. 批量操作 200 个/次（超出静默丢弃，count 如实回报）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'm' });
  for (let i = 0; i < 210; i++) await c.R2.put('d/m/f' + i + '.txt', enc('x'));
  const d = await (await c.jp(ADMIN + '/api', { action: 'deleteBatch',
    items: Array.from({ length: 250 }, (_, i) => ({ path: 'm/f' + i + '.txt', isDir: false })) })).json();
  ok(d.count === 200, '传 250 个只处理 200 个，count 如实回报 200', d.count);
  const left = [...c.R2.map.keys()].filter(k => k.startsWith('d/m/') && !k.endsWith('/'));
  ok(left.length === 10, '删了 200 个，剩 10 个文件（210-200）', left.length);
}

head('6. 搜索 limit：上限 200、下限 1、缺省 60');
{
  const c = mk();
  for (let i = 0; i < 60; i++) await put(c, 's' + i + '.txt', 'NEEDLE content ' + i);
  ok((await (await c.call(ADMIN + '/api?action=search&q=NEEDLE&limit=9999')).json()).limit === 200, 'limit 上限 200');
  ok((await (await c.call(ADMIN + '/api?action=search&q=NEEDLE&limit=-1')).json()).limit === 1, 'limit 下限 1');
  ok((await (await c.call(ADMIN + '/api?action=search&q=NEEDLE')).json()).limit === 60, '不传 limit 时缺省 60');
  const r = await (await c.call(ADMIN + '/api?action=search&q=NEEDLE&limit=10')).json();
  ok(r.results.length === 10 && r.total === 60 && r.hasMore === true, '分页正常：取 10 条，total=60，hasMore=true', { n: r.results.length, total: r.total, hasMore: r.hasMore });
}

head('7. 搜索补扫 5000 个对象上限');
{
  const c = mk();
  for (let i = 0; i < 5200; i++) await c.R2.put('d/o' + String(i).padStart(5, '0') + '.txt', enc('z'), { customMetadata: { mtime: '1700000000000' } });
  ok((await (await c.call(ADMIN + '/api?action=search&q=o04999.txt')).json()).results.length >= 1, '前 5000 个能搜到');
  ok((await (await c.call(ADMIN + '/api?action=search&q=o05100.txt')).json()).results.length === 0, '第 5001 个之后搜不到（受 IDX_SCAN_MAX 限制）');
}

head('8. 同步建索引：走 PUT 上传的文件，第一次搜就搜得到');
{
  const c = mk();
  for (let i = 0; i < 5; i++) await put(c, 'p' + i + '.txt', 'HELLO' + i);
  const d = await (await c.call(ADMIN + '/api?action=search&q=HELLO')).json();
  ok(d.results.length === 5 && d.indexed === true, '走接口上传 → 首搜正文即命中 ' + d.results.length + ' 条（同步建索引的收益）');
}
{
  // 绕过接口直接塞进 R2 的文件：补扫只按文件名，正文搜不到，需点一次重建
  const c = mk();
  await c.R2.put('d/x.txt', enc('HELLO'), { customMetadata: { mtime: '1700000000000' } });
  const d = await (await c.call(ADMIN + '/api?action=search&q=HELLO')).json();
  ok(d.results.length === 0 && d.indexed === false, '直写 R2 的文件首搜正文 0 条（indexed=false 已在提示）');
  ok((await (await c.call(ADMIN + '/api?action=search&q=x.txt')).json()).results.length >= 1, '但搜文件名能找到（补扫兜底）');
  await reindexAll(c);
  ok((await (await c.call(ADMIN + '/api?action=search&q=HELLO')).json()).results.length >= 1, '点一次「重建索引」后正文即可搜');
}

head('9. 限速：管理端 240/分、分享下载 60/分（按 IP，设 0 关闭）');
{
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '盘' };
  const call = async (p, ip) => { const r = await worker.fetch(new Request(ORIGIN + p, { headers: { 'CF-Connecting-IP': ip } }), e, exec); await Promise.all(exec.waits.splice(0)); return r; };
  await KV.put('share:tA', JSON.stringify({ p: 'a.txt', kind: 'file', at: Date.now() }));
  await R2.put('d/a.txt', enc('AAA'));
  let dl = -1;
  for (let i = 0; i < 80; i++) { const r = await call('/s/tA/a.txt', '9.9.9.9'); if (r.status === 429) { dl = i; break; } }
  ok(dl === 60, '分享下载第 61 次限速（DOWNLOAD_LIMIT=60）', dl + 1);
  let m = -1, m429 = null;
  for (let i = 0; i < 300; i++) { const r = await call(ADMIN + '/api?action=list&path=', '7.7.7.7'); if (r.status === 429) { m = i; m429 = r; break; } }
  ok(m === 240, '管理端读第 241 次限速（RATE_LIMIT=240）', m + 1);
  ok(!!m429.headers.get('Retry-After'), '429 带 Retry-After 供前端退避', m429.headers.get('Retry-After'));
}
{
  const c = mk({ RATE_LIMIT: '0', DOWNLOAD_LIMIT: '0' });
  let n = 0;
  for (let i = 0; i < 300; i++) { const r = await c.call(ADMIN + '/api?action=list&path='); if (r.status === 429) n++; }
  ok(n === 0, '设 0 后限速关闭（300 次读不触发）', n);
}

head('10. 索引满载时的体积（免费版 10ms CPU 是真红线）');
{
  const c = mk();
  const c8k = 'A'.repeat(8 * 1024);
  for (let i = 0; i < 3000; i++) await c.R2.put('d/f' + i + '.txt', enc(c8k), { customMetadata: { mtime: String(1700000000000 + i) } });
  await reindexAll(c);
  const idx = await c.idx();
  ok(idx.tb <= 1024 * 1024, '索引正文压在 1MB 内（' + (idx.tb / 1024).toFixed(0) + 'KB）', idx.tb);
  ok(JSON.stringify(idx).length / 1024 < 1600, '索引总体积约 ' + (JSON.stringify(idx).length / 1024).toFixed(0) + 'KB，JSON.parse 可承受');
}

console.log('\n———— 上限瓶颈实测 ————');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);