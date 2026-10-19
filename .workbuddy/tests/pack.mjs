// 打包下载专项测试：后端 packList + 前端 ZIP 生成 + 审查发现的缺陷回归
import worker, { appHtml } from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';
import vm from 'node:vm';

const ORIGIN = 'https://demo.workers.dev', ADMIN = '/adm-123';
let fail = 0, pass = 0;
const ok = (c, m, e) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const head = t => console.log('\n== ' + t + ' ==');
const enc = s => new TextEncoder().encode(s);
const b = s => new Uint8Array(enc(s));
function mk() {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const e = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
  const call = async (p, i) => { const r = await worker.fetch(new Request(ORIGIN + p, i), e, exec); await Promise.all(exec.waits.splice(0)); return r; };
  return { R2, KV, call, jp: (u, o) => call(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }) };
}
const put = (c, p, s) => c.call(ADMIN + '/api?path=' + encodeURIComponent(p), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc(s) });
const pl = (c, p) => c.call(ADMIN + '/api?action=packList&path=' + encodeURIComponent(p));

// 抽出前端 ZIP 相关函数，在 Node 里真跑
function loadZip() {
  const html = appHtml({ title: 'T', base: '/adm', readonly: false, hasPw: true });
  const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const grab = (n) => { const i = js.indexOf('function ' + n + '('); if (i < 0) throw new Error('找不到 ' + n); let d = 0, s = false; for (let j = i; j < js.length; j++) { if (js[j] === '{') { d++; s = true; } else if (js[j] === '}') { d--; if (s && d === 0) return js.slice(i, j + 1); } } throw new Error(n + ' 没闭合'); };
  const cs = js.indexOf('var CRC_TBL ='), ce = js.indexOf('function crc32(');
  const code = [js.slice(cs, ce), 'var DOS_TIME = 0, DOS_DATE = 0x21;', grab('crc32'), grab('buildZip'), 'var ZIP_BS = String.fromCharCode(92);', grab('zipEntryName')].join('\n');
  const ctx = { TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob: class { constructor(p) { this.parts = p; this.size = p.reduce((n, x) => n + x.length, 0); } } };
  new vm.Script(code + '\nthis.__z = { buildZip, crc32, zipEntryName };').runInNewContext(ctx);
  return ctx.__z;
}
// 复现前端 packDownload 的「条目名」算法
// paths 是本次打包选中的路径（决定 multi / onlyOneDir 两个分支）
function entriesOf(lists, paths) {
  const zipEntryName = loadZip().zipEntryName;
  const multi = paths.length > 1;
  const onlyOneDir = paths.length === 1 && !lists[0].isFile;
  const files = [], seen = {}, dirEntries = [];
  for (let i = 0; i < lists.length; i++) {
    const L = lists[i];
    // 真空目录：把目录自己补进去，否则 zip 是空的
    if (!L.isFile && !L.files.length && !(L.dirs && L.dirs.length)) {
      const self = zipEntryName(L.dir ? (L.dir.split('/').pop() || L.dir) : '根目录');
      if (self && !seen[self]) { seen[self] = 1; dirEntries.push(self); }
    }
    if (L.dirs && L.dirs.length && !L.isFile) {
      for (const dp of L.dirs) {
        const base2 = L.dir ? L.dir + '/' : '';
        const drel = dp.slice(base2.length) || dp.split('/').pop();
        const dentry = zipEntryName((multi || !onlyOneDir) ? dp : drel);
        if (dentry && !seen[dentry]) { seen[dentry] = 1; dirEntries.push(dentry); }
      }
    }
    for (const f of L.files) {
      let entry;
      if (L.isFile) entry = f.p.split('/').pop();
      else {
        const base = L.dir ? L.dir + '/' : '';
        const rel = f.p.slice(base.length) || f.p.split('/').pop();
        entry = (multi || !onlyOneDir) ? f.p : rel;
      }
      entry = zipEntryName(entry);
      if (!entry) continue;
      if (seen[entry]) continue;
      seen[entry] = 1;
      files.push({ p: f.p, entry });
    }
  }
  return { files, dirEntries };
}

head('1. 后端 packList：递归列出文件夹');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'proj' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'proj', name: 'sub' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'proj/sub', name: 'deep' });
  await put(c, 'proj/a.txt', 'A');
  await put(c, 'proj/sub/b.txt', 'B');
  await put(c, 'proj/sub/deep/c.txt', 'C');
  await put(c, 'outside.txt', 'OUT');

  const d = await (await pl(c, 'proj')).json();
  ok(d.ok === true, 'packList 返回 ok', d);
  ok(d.count === 3, '递归列出 3 个文件（含两级子目录）', d.count);
  const paths = d.files.map(f => f.p).sort();
  ok(paths.includes('proj/a.txt') && paths.includes('proj/sub/b.txt') && paths.includes('proj/sub/deep/c.txt'), '三级路径都在', paths);
  ok(!paths.some(p => p.endsWith('/')), '目录占位符不算文件', paths);
  ok(!paths.includes('outside.txt'), '不会把目录外的文件算进来（范围正确）', paths);
  ok(d.isFile === false, '文件夹标记 isFile=false', d.isFile);

  const r = await (await pl(c, '')).json();
  ok(r.count === 4, '根目录能列出全部 4 个文件', r.count);
}

head('2. 对**文件**路径调 packList（右键「下载为 zip」走这条）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  await put(c, 'd/solo.txt', 'S');
  const d = await (await pl(c, 'd/solo.txt')).json();
  ok(d.ok === true, '对文件路径调 packList 不报错', d.error);
  ok(d.isFile === true, '正确识别为文件（isFile=true）', d);
  ok(d.count === 1, '能列出这 1 个文件（修前返回 0 → 右键下载为 zip 会报"没有可下载的文件"）', d.count);
  ok(d.files[0].p === 'd/solo.txt', '文件路径正确', d.files[0]);
  // 文件夹不能被误判成文件
  const d2 = await (await pl(c, 'd')).json();
  ok(d2.isFile === false, '文件夹不会被误判成文件', d2.isFile);
  // 目录占位符（有 / 结尾的）也要当文件夹
  const d3 = await (await pl(c, 'd/')).json();
  ok(d3.isFile === false && d3.count === 1, '传 "d/"（带斜杠）仍按文件夹处理', { isFile: d3.isFile, count: d3.count });
}

head('3. zip 内条目名：同名文件不互相覆盖');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'a' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'b' });
  await put(c, 'a/same.txt', 'FROM_A');
  await put(c, 'b/same.txt', 'FROM_B');
  const la = await (await pl(c, 'a')).json();
  const lb = await (await pl(c, 'b')).json();
  const e = entriesOf([la, lb], ["a","b"]);
  const names = e.files.map(f => f.entry).sort();
  ok(names.length === 2 && names[0] !== names[1],
    '同时打 a/ 和 b/ → 条目名不同，不会解压覆盖', names);
  ok(names[0] === 'a/same.txt' && names[1] === 'b/same.txt',
    '多选时保留顶层目录名', names);

  // 只打 a/ → 去掉顶层，结构更干净
  const e1 = entriesOf([la], ["a"]);
  ok(e1.files[0].entry === 'same.txt', '只打一个文件夹时去掉顶层目录名', e1.files[0].entry);

  // 同一份重复出现（父子都被选中）→ 只留一份
  const dup = await (await pl(c, 'a')).json();
  const e2 = entriesOf([dup, dup], ["a","a"]);
  ok(e2.files.length === 1, '同一路径重复时只保留一份', e2.files.length);
}

head('4. zip 内条目名：单文件 / 路径穿越');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  await put(c, 'd/solo.txt', 'S');
  const d = await (await pl(c, 'd/solo.txt')).json();
  const e = entriesOf([d], [d.dir]);
  ok(e.files[0].entry === 'solo.txt', '单文件只取文件名，不带目录', e.files[0].entry);

  const { zipEntryName } = loadZip();
  ok(zipEntryName('../evil.txt') === 'evil.txt', '清掉 ..（防解压到 zip 外面）', zipEntryName('../evil.txt'));
  ok(zipEntryName('a/../../b.txt') === 'b.txt', '多层 .. 正确回退', zipEntryName('a/../../b.txt'));
  ok(zipEntryName('/x/y.txt') === 'x/y.txt', '去掉开头的斜杠', zipEntryName('/x/y.txt'));
  ok(zipEntryName('a' + String.fromCharCode(92) + 'b.txt') === 'a/b.txt', '反斜杠转正斜杠', zipEntryName('a\\b.txt'));
  ok(zipEntryName('./x.txt') === 'x.txt', '清掉当前目录段', zipEntryName('./x.txt'));
  ok(zipEntryName('') === '', '空串安全', zipEntryName(''));
}

head('5. 空文件夹要出现在 zip 里');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'pack' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'pack', name: 'empty1' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'pack', name: 'empty2' });
  await put(c, 'pack/real.txt', 'R');
  const d = await (await pl(c, 'pack')).json();
  ok(d.count === 1, '只有 1 个文件', d.count);
  ok(d.dirs && d.dirs.length === 2, '2 个空目录被报出来', d.dirs);
  ok(d.hasDirs === true, 'hasDirs 标记为 true', d.hasDirs);
  // 条目名
  const e = entriesOf([d], [d.dir]);
  ok(e.dirEntries.length === 2, '空目录进入 zip 条目', e.dirEntries);
  ok(e.dirEntries.indexOf('empty1') >= 0 && e.dirEntries.indexOf('empty2') >= 0,
    '空目录名正确（只打一个文件夹时去掉顶层）', e.dirEntries);
  // 全是空目录的情况
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'allEmpty' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: 'allEmpty', name: 'x' });
  const d2 = await (await pl(c, 'allEmpty')).json();
  ok(d2.count === 0 && d2.dirs.length === 1, '全是空目录时也报目录（不会"没有可下载的文件"）', d2);
}

head('5b. 真空目录允许下载（只提示，不拦截）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '空目录' });
  const d = await (await pl(c, '空目录')).json();
  ok(d.count === 0 && d.dirs.length === 0, '真空目录：0 文件 0 子目录', d);
  const e = entriesOf([d], ['空目录']);
  ok(e.files.length === 0, '没有文件条目', e.files.length);
  ok(e.dirEntries.length === 1 && e.dirEntries[0] === '空目录',
    '把目录自己补进 zip（否则 zip 是空的，等于什么都没下到）', e.dirEntries);
  const { buildZip } = loadZip();
  const blob = buildZip(e.dirEntries.map(x => ({ name: x, data: null })));
  ok(blob.size > 0, '生成的 zip 有内容（' + blob.size + ' 字节）', blob.size);
}
{
  // 含空子目录的目录：zip 里要带上那一层
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '父' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '父', name: '子' });
  const d = await (await pl(c, '父')).json();
  const e = entriesOf([d], ['父']);
  ok(e.dirEntries.length === 1 && e.dirEntries[0] === '子',
    '只有空子目录时也生成 zip 条目（保留那一层）', e.dirEntries);
}
{
  // 批量混合：2 真空 + 1 有内容，两个空目录都要在
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'E1' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'E2' });
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: '有内容' });
  await put(c, '有内容/a.txt', 'A');
  const paths = ['E1', 'E2', '有内容'];
  const lists = [];
  for (const p of paths) lists.push(await (await pl(c, p)).json());
  const e = entriesOf(lists, paths);
  ok(e.dirEntries.indexOf('E1') >= 0 && e.dirEntries.indexOf('E2') >= 0,
    '批量里两个空目录都进了 zip', e.dirEntries);
  ok(e.files.length === 1 && e.files[0].entry === '有内容/a.txt',
    '多选时文件条目带顶层目录名', e.files.map(f => f.entry));
}

head('5c. 空目录的提示文案');
{
  const html = appHtml({ title: 'T', base: '/adm', readonly: false, hasPw: true });
  const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  ok(/这些目录里没有文件/.test(js), '有「这些目录里没有文件」的提示');
  ok(/只能打包出/.test(js), '说了「只能打包出（空文件夹）」');
  ok(/空文件夹本身是可以下载的/.test(js), '明确告知空文件夹本身可以下载');
  ok(/保留目录骨架有用/.test(js), '解释了为什么空目录也允许下载');
  // 注意：这里要查的是「空目录不再被报错拦住」，
  // 而不是整个脚本里不含某串措辞（分享页别处可能也有类似文案）。
  const sp = js.slice(js.indexOf('function startPack('), js.indexOf('// ===== 退出登录 ====='));
  ok(!/没有可下载的文件/.test(sp), 'startPack 里不再有「没有可下载的文件」（与"允许下载"矛盾）');
  const pd = js.slice(js.indexOf('function packDownload('), js.indexOf('// ===== 多选'));
  ok(/这个路径里没有可打包的内容/.test(pd), 'packDownload 的兜底措辞改成「没有可打包的内容」');
  ok(!/if \(!total && !ndirs\)\{[^}]*return null/.test(sp),
    'startPack 不再因为 0 文件就提前 return（空目录会继续打包）');
  ok(/已打包下载空文件夹/.test(js), '完成提示对空目录有专门措辞');
}

head('6. ZIP 结构：目录条目能被解压器识别');
{
  const { buildZip, crc32 } = loadZip();
  ok(crc32(b('123456789')) === 0xCBF43926, 'CRC32 符合标准测试向量', crc32(b('123456789')).toString(16));
  const blob = buildZip([
    { name: 'emptyDir/', data: null },        // 目录
    { name: 'a.txt', data: b('hello a') },
    { name: '中文名.txt', data: b('hello c') }
  ]);
  let total = 0; for (const p of blob.parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0; for (const p of blob.parts) { out.set(p, off); off += p.length; }
  const dv = new DataView(out.buffer);
  ok(dv.getUint32(0, true) === 0x04034b50, '开头是 Local File Header');
  // 第一个条目是目录：名字以 / 结尾、size=0、外部属性有目录位
  ok(dv.getUint16(26, true) === 9, '目录条目名长度 9（emptyDir/）', dv.getUint16(26, true));
  ok(dv.getUint32(18, true) === 0, '目录条目 size=0', dv.getUint32(18, true));
  // 第二个条目（文件）
  const second = 30 + 9;
  ok(dv.getUint32(second, true) === 0x04034b50, '第二个条目也是合法头');
  ok(dv.getUint16(second + 26, true) === 5, 'a.txt 名字长度 5');
  ok((dv.getUint16(6, true) & 0x0800) === 0x0800, 'UTF-8 文件名标志已设');
  ok(dv.getUint16(out.length - 22 + 10, true) === 3, '中央目录声明 3 个条目', dv.getUint16(out.length - 22 + 10, true));
}

head('7. 边界与安全');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'd' });
  await put(c, 'd/' + 'x'.repeat(200) + '.txt', 'x');
  ok((await (await pl(c, 'd')).json()).ok, '超长文件名不报错');
  const t1 = await (await pl(c, '../../etc')).json();
  ok(t1.ok && (!t1.files || t1.files.every(f => !f.p.includes('..'))), '路径穿越被规范化', t1);
  // 分享页范围限制
  await c.KV.put('share:tk1', JSON.stringify({ p: 'd', kind: 'dir', at: Date.now() }));
  const s = await (await c.call('/s/tk1/api?action=packList&path=d')).json();
  ok(s.ok === true, '分享页能列自己的目录', s);
  const s2 = await (await c.call('/s/tk1/api?action=packList&path=' + encodeURIComponent('d/../..'))).json();
  ok(!s2.ok || !s2.files || s2.files.every(f => !f.p.includes('..')), '分享页不能越权列出范围外', s2);
}

head('8. 上限截断（如实回报）');
{
  const c = mk();
  await c.jp(ADMIN + '/api', { action: 'mkdir', path: '', name: 'many' });
  for (let i = 0; i < 320; i++) await c.R2.put('d/many/f' + String(i).padStart(4, '0') + '.txt', b('x'), { customMetadata: { mtime: String(1700000000000 + i) } });
  const d = await (await pl(c, 'many')).json();
  ok(d.count === 300, '文件数撞到 300 上限就停', d.count);
  ok(d.truncated === true, 'truncated=true（如实告知还有剩余）', d.truncated);
  ok(d.maxFiles === 300, '回报上限值供前端提示', d.maxFiles);
}

head('9. 429 退避重试（打包几百个请求必然撞限速）');
{
  const html = appHtml({ title: 'T', base: '/adm', readonly: false, hasPw: true });
  const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  ok(/function fetchFileBytes\(path, attempts\)/.test(js), 'fetchFileBytes 接受重试次数参数');
  const i = js.indexOf('function fetchFileBytes(');
  const body = js.slice(i, i + 1400);
  ok(/r\.status === 429 && left > 0/.test(body), '对 429 做退避重试');
  ok(/Retry-After/.test(body), '尊重 Retry-After 响应头');
  ok(/Math\.pow\(2,/.test(body), '无 Retry-After 时用指数退避');
  ok(/r\.status === 401/.test(body), '401 时刷新登录态');
  ok(/var pool = 3/.test(js), '并发降到 3 路（打包本身请求量大）');
}

head('10. 大文件打包不崩');
{
  const { buildZip } = loadZip();
  const big = new Uint8Array(Array.from({ length: 256 * 1024 }, () => 120));
  const items = Array.from({ length: 20 }, (_, i) => ({ name: 'f' + i + '.bin', data: big }));
  const t0 = Date.now();
  const blob = buildZip(items);
  const ms = Date.now() - t0;
  ok(ms < 5000, '20×256KB（5MB）打包耗时 ' + ms + 'ms < 5s', ms);
  ok(blob.size > 5 * 1024 * 1024, '产物体积 ≥ 原始 5MB', (blob.size / 1024 / 1024).toFixed(2) + 'MB');
}

console.log('\n———— 打包下载 ————');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
