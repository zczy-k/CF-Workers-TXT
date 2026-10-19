// 上传 / 新建 / 分片上传 专项测试
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
let fail = 0, pass = 0;
function ok(c, m, e) {
  if (c) { pass++; console.log('  ok  ' + m); }
  else { fail++; console.log('  FAIL ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }
function mk() {
  // 真实 R2 的条件写是**原子**的；MockR2.put 里"查 etag → await → 写"之间会让出执行权，
  // 并发时多个写会同时通过校验、互相覆盖，测不出真实行为。这里串行化 put 还原原子性。
  class AtomicR2 extends MockR2 {
    constructor() { super(); this._chain = Promise.resolve(); }
    put(key, val, opt) {
      const n = this._chain.then(() => super.put(key, val, opt));
      this._chain = n.then(() => {}, () => {});
      return n;
    }
  }
  const R2 = new AtomicR2(), KV = new MockKV(), exec = makeExec();
  const e = Object.assign({ R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' });
  const call = async (p, init) => {
    const res = await worker.fetch(new Request(ORIGIN + p, init), e, exec);
    await Promise.all(exec.waits.splice(0));
    return res;
  };
  return { R2, KV, call, jp: (u, o) => call(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }),
    idx: async () => { const o = await R2.get('__sys__/idx.json'); return o ? JSON.parse(await o.text()) : null; } };
}
const put = (c, p, s) => c.call(ADMIN + '/api?path=' + encodeURIComponent(p),
  { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode(s) });
const enc = s => new TextEncoder().encode(s);

head('文件上传（PUT）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '资料' });
  ok((await (await put(c, '资料/a.txt', 'hello APPLEPIE world')).json()).ok, '上传文本文件');
  let idx = await c.idx();
  ok(!!idx.files['资料/a.txt'], '上传后同步进索引（改完立刻能搜到）', Object.keys(idx.files));

  await put(c, '资料/a.txt', 'changed to BANANA');
  idx = await c.idx();
  ok(String(idx.files['资料/a.txt'][4]).indexOf('BANANA') >= 0, '覆盖上传后索引内容已更新');

  const rec = await c.R2.get('d/资料/a.txt');
  ok(!!(rec.customMetadata && rec.customMetadata.mtime), '记录 mtime（供上传同名比对）');

  const r = await put(c, '资料', 'x');
  ok(r.status === 409, 'PUT 到文件夹占位上被拒 409', r.status);

  for (const bad of ['../evil.txt', '资料/../../evil.txt', '/abs.txt', '资料/./../../x']) {
    await put(c, bad, 'x');
    ok(![...c.R2.map.keys()].some(k => k.includes('..')), '路径穿越被规范化：' + bad);
  }

  ok((await (await put(c, '资料/empty.txt', '')).json()).ok, '上传 0 字节文件');
  ok((await c.R2.get('d/资料/empty.txt')).size === 0, '0 字节落库正确');
}

head('新建文件夹');
{
  const c = mk();
  ok((await (await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '甲' })).json()).ok, '根目录新建');
  const dup = await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '甲' });
  ok(dup.status === 409, '重复建同名文件夹被拒 409', dup.status);
  for (const bad of ['a/b', '..', '.', '', '   ', 'a\\b', '...']) {
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: bad });
    ok(![...c.R2.map.keys()].some(k => k.includes('..') || k.includes('\\')), '非法目录名被拦：' + JSON.stringify(bad));
  }
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'L1' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'L1', name: 'L2' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'L1/L2', name: 'L3' });
  ok(!!(await c.R2.get('d/L1/L2/L3/')), '逐级建嵌套目录');
  ok((await (await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'L1/L2', name: 'L4' })).json()).ok, '建已存在父目录下的子目录');
  // 超长名截断 + 撞名保护
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'y'.repeat(200) });
  const r = await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'y'.repeat(190) + 'Z' });
  ok((await r.json()).error === '同名文件夹已存在', '超长名截断后撞名会被拦');
  // 父目录不存在：功能不缺（list 用 delimiter 推导前缀）
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'ghost', name: 'child' });
  const l = await (await c.call(ADMIN + '/api?action=list&path=ghost')).json();
  ok(l.folders.indexOf('child') >= 0, '父目录不存在时建的目录仍可正常列出', l);
}

head('大文件分片上传');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'big' });
  let d = (await (await c.jp(ADMIN + '/api', { action: 'mpCreate', path: 'big/huge.bin', ct: 'application/octet-stream', size: 25 * 1024 * 1024, mtime: 1700000000000 })).json());
  ok(d.ok && d.uploadId, 'mpCreate 返回 uploadId', d);
  ok(d.partSize === 8 * 1024 * 1024, '分片大小 8MB', d.partSize);
  const uid = d.uploadId;
  ok(!!(await c.KV.get('mp:' + uid)), '会话写进 KV');

  for (const p of [1, 2, 3, 4]) {
    const r = await c.call(ADMIN + '/api?action=mpPart&uploadId=' + uid + '&part=' + p,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(1024).fill(p) });
    ok(r.status === 200, '上传分片 ' + p, r.status);
  }
  ok((await c.call(ADMIN + '/api?action=mpPart&uploadId=' + uid + '&part=2',
    { method: 'POST', body: new Uint8Array(1024).fill(9) })).status === 200, '重复上传同一片被接受（可重试）');
  ok(Object.keys(JSON.parse(await c.KV.get('mp:' + uid)).parts).length === 4, '会话记住 4 个分片');

  d = (await (await c.jp(ADMIN + '/api', { action: 'mpList' })).json());
  ok(d.sessions.length === 1 && d.sessions[0].totalParts === 4, 'mpList 能看到未完成会话', d.sessions);

  d = (await (await c.jp(ADMIN + '/api', { action: 'mpComplete', uploadId: uid })).json());
  ok(d.ok, 'mpComplete 成功', d);
  ok((await c.R2.get('d/big/huge.bin')).size === 4096, '合并后大小正确');
  ok(!(await c.KV.get('mp:' + uid)), 'complete 后清掉 KV 会话');
  const idx = await c.idx();
  ok(idx.files['big/huge.bin'] && idx.files['big/huge.bin'][0] === 2, '大文件登记进索引且标记「仅文件名」');

  ok((await c.jp(ADMIN + '/api', { action: 'mpComplete', uploadId: 'nope' })).status === 404, '不存在 uploadId → 404');
  ok((await c.call(ADMIN + '/api?action=mpPart&uploadId=nope&part=1', { method: 'POST', body: new Uint8Array(4) })).status === 404, '不存在会话传分片 → 404');
  ok((await c.jp(ADMIN + '/api', { action: 'mpPart', uploadId: uid, part: 1 })).status === 400, '缺 part 参数 → 400');
  ok((await c.jp(ADMIN + '/api', { action: 'mpCreate', path: 'big', size: 100 })).status === 409, 'mpCreate 到文件夹占位 → 409');

  await c.jp(ADMIN + '/api', { action: 'mpCreate', path: '../evil.bin', size: 100 });
  ok(![...c.R2.map.keys()].some(k => k.includes('..')), 'mpCreate 路径穿越被规范化');

  const u2 = (await (await c.jp(ADMIN + '/api', { action: 'mpCreate', path: 'big/x.bin', size: 100 })).json()).uploadId;
  ok((await (await c.jp(ADMIN + '/api', { action: 'mpAbort', uploadId: u2 })).json()).ok, 'mpAbort 成功');
  ok(!(await c.KV.get('mp:' + u2)) && !c.R2.uploads.has(u2), 'abort 后 KV 与 R2 侧都清掉');
}

head('未绑定 KV 的降级');
{
  const R2 = new MockR2(), exec = makeExec();
  const e = { R2, ADMIN_UUID: 'adm-123' };
  const call = async (p, i) => {
    const r = await worker.fetch(new Request(ORIGIN + p, i), e, exec);
    await Promise.all(exec.waits.splice(0));
    return r;
  };
  ok((await call(ADMIN + '/api?action=mpCreate&path=a.bin&size=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"path":"a.bin","size":1}' })).status === 400, '无 KV 时 mpCreate 明确报错不静默');
  ok((await (await put({ call }, 'x.txt', 'hello no kv')).json()).ok, '无 KV 时普通上传仍可用');
  const d = await (await call(ADMIN + '/api?action=search&q=hello')).json();
  ok(d.results.length === 1, '无 KV 时索引退化为每次全扫，仍能搜到', d.results);
  ok((await call(ADMIN + '/api?action=reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status < 500, '无 KV 时 reindex 不崩');
}

head('空文件夹与文件夹上传');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'proj' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'proj', name: 'empty' });
  ok(!!(await c.R2.get('d/proj/empty/')), '空文件夹占位符建了');
  const l = await (await c.call(ADMIN + '/api?action=list&path=proj')).json();
  ok(l.folders.indexOf('empty') >= 0, '空文件夹在 list 里可见', l.folders);

  // 模拟 uploadTree：先建目录，再 4 路并发传文件
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'proj', name: 'sub' });
  const files = Array.from({ length: 12 }, (_, i) => 'proj/sub/f' + i + '.txt');
  for (let i = 0; i < files.length; i += 4) {
    await Promise.all(files.slice(i, i + 4).map(f => put(c, f, 'body ' + f + ' ZEBRAFISH')));
  }
  const d = await (await c.call(ADMIN + '/api?action=search&q=ZEBRAFISH')).json();
  ok(d.results.length === 12, '4 路并发上传 12 个文件后正文全部可搜', d.results.length);
}

console.log('\n———— 上传/新建 ————');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);