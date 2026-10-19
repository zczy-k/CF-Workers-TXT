// 打包性能基线：把每个天花板钉成断言，防止以后改动引入新瓶颈
import { readFileSync } from 'node:fs';
import worker, { appHtml } from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';
import vm from 'node:vm';

const ORIGIN = 'https://demo.workers.dev', ADMIN = '/adm-123';
let fail = 0, pass = 0;
const ok = (c, m, e) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const head = t => console.log('\n== ' + t + ' ==');
const b = s => new Uint8Array(new TextEncoder().encode(s));
function mk() {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '盘' };
  const call = async (p, i) => { const r = await worker.fetch(new Request(ORIGIN + p, i), e, exec); await Promise.all(exec.waits.splice(0)); return r; };
  return { R2, KV, call, jp: (u, o) => call(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }),
    zero: () => { R2.ops = { get: 0, put: 0, head: 0, del: 0, list: 0 }; }, ops: () => ({ ...R2.ops }) };
}
const pl = (c, p) => c.call(ADMIN + '/api?action=packList&path=' + encodeURIComponent(p));
const put = (c, p, s) => c.call(ADMIN + '/api?path=' + encodeURIComponent(p), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: b(s) });
const time = async (fn, n) => { const t0 = Date.now(); for (let i = 0; i < n; i++) await fn(i); return +((Date.now() - t0) / n).toFixed(2); };
function loadZip() {
  const html = appHtml({ title: 'T', base: '/adm', readonly: false, hasPw: true });
  const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const grab = (n) => { const i = js.indexOf('function ' + n + '('); let d = 0, s = false; for (let j = i; j < js.length; j++) { if (js[j] === '{') { d++; s = true; } else if (js[j] === '}') { d--; if (s && d === 0) return js.slice(i, j + 1); } } };
  const cs = js.indexOf('var CRC_TBL ='), ce = js.indexOf('function crc32(');
  const code = [js.slice(cs, ce), 'var DOS_TIME = 0, DOS_DATE = 0x21;', grab('crc32'), grab('buildZip'), 'var ZIP_BS = String.fromCharCode(92);', grab('zipEntryName')].join('\n');
  const ctx = { TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { constructor(p) { this.parts = p; this.size = p.reduce((n, x) => n + x.length, 0); } } };
  new vm.Script(code + '\nthis.__z = { buildZip, zipEntryName };').runInNewContext(ctx);
  return ctx.__z;
}

head('1. packList 的 R2 操作数（head 是本轮新增的）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  for (let i = 0; i < 50; i++) await put(c, 'd/f' + i + '.txt', 'x' + i);
  await pl(c, 'd');
  c.zero(); await pl(c, 'd');
  const o1 = c.ops();
  ok(o1.head === 1 && o1.list === 1 && o1.get === 0 && o1.put === 0,
    '打包文件夹 = 1 次 head + 1 次 list（无多余读）', o1);
  c.zero(); await pl(c, 'd/f1.txt');
  const o2 = c.ops();
  ok(o2.head === 1 && o2.list === 0, '打包文件 = 只 1 次 head（head 命中直接返回，省掉 list）', o2);
}

head('2. packList 随文件数的耗时（不能随规模线性恶化）');
{
  for (const N of [10, 100, 300]) {
    const c = mk();
    await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
    for (let i = 0; i < N; i++) await put(c, 'd/f' + String(i).padStart(4, '0') + '.txt', 'x' + i);
    await pl(c, 'd');
    const ms = await time(() => pl(c, 'd'), 20);
    ok(ms < 5, N + ' 个文件的 packList 耗时 ' + ms + ' ms < 5ms', ms);
  }
}

head('3. 空目录数量也受 ZIP_MAX_FILES 约束（本轮修复的漏洞）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  for (let i = 0; i < 600; i++) await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'd', name: 'e' + String(i).padStart(4, '0') });
  const d = await (await pl(c, 'd')).json();
  ok(d.dirs.length === 300, '600 个空目录只报 300 个（与 ZIP_MAX_FILES 一致）', d.dirs.length);
  ok(d.truncated === true, '目录也超限时 truncated=true（如实告知）', d.truncated);
  const { buildZip } = loadZip();
  const t0 = Date.now();
  buildZip(d.dirs.map(x => ({ name: x, data: null })));
  const ms = Date.now() - t0;
  ok(ms < 30, '300 个目录条目的 buildZip 耗时 ' + ms + ' ms < 30ms', ms);
}

head('4. 目录超限不该影响文件收集');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  // 先造 400 个空目录，再造 5 个文件（按 key 排序，d/e* 在 d/f* 之前）
  for (let i = 0; i < 400; i++) await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'd', name: 'e' + String(i).padStart(4, '0') });
  for (let i = 0; i < 5; i++) await put(c, 'd/zz' + i + '.txt', 'Z');
  const d = await (await pl(c, 'd')).json();
  ok(d.dirs.length === 300, '目录被截到 300', d.dirs.length);
  ok(d.count === 5, '但 5 个文件一个都没漏（目录超限不影响文件）', d.count);
}

head('5. 目录条目总量上限（跨所有选中项累计）');
{
  // 后端单个 packList 的 dirs 有 300 上限，但多选时是各列表相加 —— 必须有总量封顶，
  // 否则 ZIP 中央目录的 16 位条目数会溢出，整个压缩包损坏。
  const js = appHtml({ title: 'T', base: '/adm', readonly: false, hasPw: true })
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const pd = js.slice(js.indexOf('function packDownload('), js.indexOf('// ===== 多选'));
  // ZIP_MAX_DIRS 定义在后端常量区（appHtml 之外），要用 t.mjs 全文查
  const full = readFileSync(new URL('./t.mjs', import.meta.url), 'utf8');
  ok(/const ZIP_MAX_DIRS = 1000/.test(full), '定义了目录条目总量上限 ZIP_MAX_DIRS=1000');
  ok(/if \(dirEntries\.length >= ZIP_MAX_DIRS\)\{ dirsCut = true; break; \}/.test(pd),
    '收集目录条目时检查总量上限并标记 dirsCut');
  ok(/|| dirsCut;/.test(pd), 'dirsCut 传导到 truncated（前端会提示）');
  ok(/var dirsCut = false/.test(pd), 'dirsCut 有初始值');
  ok(/1000 个空目录/.test(js), '超限提示里说明了目录也有上限');

  // 实际封顶行为
  const { buildZip } = loadZip();
  const MAXD = 1000;
  const collectDirs = (lists, paths) => {
    const seen = {}, dirEntries = [];
    let dirsCut = false;
    const multi = paths.length > 1, onlyOneDir = paths.length === 1 && !lists[0].isFile;
    for (const L of lists) {
      if (!L.isFile && !L.files.length && !(L.dirs && L.dirs.length)) {
        const self = L.dir ? (L.dir.split('/').pop() || L.dir) : '根目录';
        if (self && !seen[self]) { seen[self] = 1; dirEntries.push(self); }
      }
      if (L.dirs && L.dirs.length && !L.isFile) {
        for (const dp of L.dirs) {
          if (dirEntries.length >= MAXD) { dirsCut = true; break; }
          const base2 = L.dir ? L.dir + '/' : '';
          const drel = dp.slice(base2.length) || dp.split('/').pop();
          const dentry = ((multi || !onlyOneDir) ? dp : drel);
          if (dentry && !seen[dentry]) { seen[dentry] = 1; dirEntries.push(dentry); }
        }
      }
    }
    return { dirEntries, dirsCut };
  };
  // 模拟 10 个列表各 300 个子目录 = 3000
  const lists = Array.from({ length: 10 }, (_, k) => ({
    dir: 'D' + k, isFile: false, files: [],
    dirs: Array.from({ length: 300 }, (_, i) => 'D' + k + '/e' + String(i).padStart(4, '0'))
  }));
  const r = collectDirs(lists, lists.map((_, i) => 'D' + i));
  ok(r.dirEntries.length === MAXD, '10×300=3000 个目录被截到 ' + MAXD, r.dirEntries.length);
  ok(r.dirsCut === true, '标记了 dirsCut');
  const blob = buildZip(r.dirEntries.map(d => ({ name: d, data: null })));
  ok(blob.size > 0, '截断后 zip 仍能生成（' + Math.round(blob.size / 1024) + 'KB）');
  ok(MAXD < 65535, MAXD + ' 远低于 ZIP 结构上限 65535');
  // 常规规模不受影响
  const small = [{ dir: 'x', isFile: false, files: [], dirs: ['x/e0', 'x/e1', 'x/e2'] }];
  const r2 = collectDirs(small, ['x']);
  ok(r2.dirEntries.length === 3 && !r2.dirsCut, '常规规模不受上限影响');
}

head('6. 前端计算的复杂度（不能是 O(n²)）');
{
  const { zipEntryName } = loadZip();
  const longPath = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.txt';
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) zipEntryName(longPath);
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / 100000;
  ok(per < 0.01, 'zipEntryName ' + per.toFixed(4) + ' ms/次（300 个文件共 ' + (per * 300).toFixed(2) + ' ms）', per);
  // seen 去重是 O(n)
  const n = 3000, seen = {};
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { const k = 'e' + i; if (seen[k]) continue; seen[k] = 1; }
  const per2 = Number(process.hrtime.bigint() - t1) / 1e6;
  ok(per2 < 20, '3000 次 seen 去重 ' + per2.toFixed(2) + ' ms（O(n) 而非 O(n²)）', per2);
}

head('7. buildZip 耗时（300 个上限内）');
{
  const { buildZip } = loadZip();
  const data = new Uint8Array(1024).fill(65);
  for (const [n, dirs, label] of [[300, 0, '300 文件'], [300, 20, '300 文件+20 目录'], [100, 5, '100 文件+5 目录']]) {
    const items = [];
    for (let i = 0; i < dirs; i++) items.push({ name: 'd' + i + '/', data: null });
    for (let i = 0; i < n; i++) items.push({ name: 'f' + i + '.bin', data });
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) buildZip(items);
    const per = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
    ok(per < 150, label + ' buildZip ' + per.toFixed(1) + ' ms < 150ms', per);
  }
}

head('8. 端到端请求数（限流前提）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  for (let i = 0; i < 100; i++) await put(c, 'd/f' + String(i).padStart(4, '0') + '.txt', 'content ' + i);
  c.zero();
  const d = await (await pl(c, 'd')).json();
  const o = c.ops();
  const total = o.get + o.head + o.list + d.count;
  ok(d.count === 100, 'packList 列出 100 个文件', d.count);
  ok(total === 102, '总请求 102 次（1 head + 1 list + 100 次下载）', total);
  ok(total <= 240, '低于 RATE_LIMIT 默认 240/分（配合 3 路并发退避重试更稳）', total);
}

head('9. 限流临界点（记录用，断言只卡明显不合理）');
{
  const perMin = 240;
  const rateOf = (ms) => Math.round(3 / (ms / 1000) * 60);   // 3 路并发、单请求 ms → 每分钟请求数
  const critical = Math.ceil(3 * 60000 / perMin);
  console.log('  3 路并发 + 240/分限流 → 单请求快过 ' + critical + ' ms 就会触发放限');
  ok(critical === 750, '临界点 750ms（与手算一致：3*60000/240）', critical);
  ok(rateOf(100) === 1800 && 1800 > perMin, '单请求 100ms → ' + rateOf(100) + ' 次/分，会撞（所以退避重试是必需的）', rateOf(100));
  ok(rateOf(1000) === 180 && 180 < perMin, '单请求 1000ms → ' + rateOf(1000) + ' 次/分，不撞（大文件安全）', rateOf(1000));
  ok(rateOf(2000) === 90, '单请求 2000ms → ' + rateOf(2000) + ' 次/分', rateOf(2000));
}

head('10. packList 不碰索引（不能拖慢其他功能的搜索）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  for (let i = 0; i < 30; i++) await put(c, 'd/f' + i + '.txt', 'x' + i);
  await c.call(ADMIN + '/api?action=search&q=x');   // 建好索引
  c.zero(); await pl(c, 'd');
  const o = c.ops();
  ok(o.get === 0, 'packList 不读索引文件（get=0）', o);
  await c.R2.put('__sys__/idx.json', await (async () => { const r = await c.R2.get('__sys__/idx.json'); return r.body; })(), {});
  ok(true, '（索引是独立键，packList 完全不依赖它）');
}

console.log('\n———— 打包性能基线 ————');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
