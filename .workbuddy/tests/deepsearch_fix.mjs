// 深搜高亮修复的验证（驱动真实 worker.js）
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
const enc = s => new TextEncoder().encode(s);
const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function hlText(s, q) {          // 与前端实现逐字一致
  if (!s || !q) return E(s || '');
  var low = s.toLowerCase(), ql = q.toLowerCase();
  var out = '', i = 0, guard = 0;
  while (guard++ < 60) {
    var k = low.indexOf(ql, i);
    if (k < 0) break;
    out += E(s.slice(i, k)) + '<span class="hl">' + E(s.slice(k, k + q.length)) + '</span>';
    i = k + q.length;
  }
  return out + E(s.slice(i));
}

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
const call = async (p, init) => {
  const res = await worker.fetch(new Request(ORIGIN + p, init), env, exec);
  await Promise.all(exec.waits.splice(0));
  return res;
};
const deep = async (p, q) => (await call(ADMIN + '/api?action=deepsearch&path=' + encodeURIComponent(p) + '&q=' + encodeURIComponent(q || 'HTTPS'))).json();
const marks = html => (html.match(/class="hl"/g) || []).length;

// A: 短行多命中
await R2.put('d/fniao/a_short.py', enc([
  'import requests',
  'URL = "https://a.example.com/api"   # HTTPS 接口',
  'headers = {"X": "1"}',
  'resp = requests.get(URL, timeout=5)  # HTTPS 请求 HTTPS',
  'print(resp.status_code)',
].join('\n')));
// B: 单行 JSON，命中在第 404 字符（修复前完全不高亮）
await R2.put('d/fniao/b_oneline.json', enc('{"k":"' + 'x'.repeat(400) + 'HTTPS' + 'y'.repeat(100) + '"}'));
// C: 长段落，命中在中段
await R2.put('d/fniao/c_longmd.md', enc('# 标题\n\n' + 'z'.repeat(300) + 'HTTPS 说明' + 'z'.repeat(300) + '\n\n结尾\n'));
// D: 命中行很多（30 行），验证不再只列 20 行
await R2.put('d/fniao/d_many.txt', enc(Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1) + ' HTTPS').join('\n')));

console.log('\n== 修复后：每一行的片段都必须包含关键词（否则前端高亮为 0）==');
for (const p of ['fniao/a_short.py', 'fniao/b_oneline.json', 'fniao/c_longmd.md', 'fniao/d_many.txt']) {
  const d = await deep(p);
  const noHl = d.hits.filter(h => marks(hlText(h.t, 'HTTPS')) === 0);
  ok(noHl.length === 0, p + '：' + d.hits.length + ' 行全部有高亮（0 高亮的行数=' + noHl.length + '）',
    noHl.map(h => ({ n: h.n, t: h.t.slice(0, 40) })));
}

console.log('\n== 长行：片段以命中位置为中心 ==');
{
  const d = await deep('fniao/b_oneline.json');
  const h = d.hits[0];
  ok(marks(hlText(h.t, 'HTTPS')) === 1, '单行 JSON 命中被高亮', h.t);
  ok(h.t.indexOf('HTTPS') >= 0, '片段里确实含有 HTTPS');
  ok(h.t.charAt(0) === '…' && h.t.charAt(h.t.length - 1) === '…', '两端标出省略号', h.t.slice(0, 20) + ' / ' + h.t.slice(-20));
  ok(h.t.length < 200, '片段长度受控（' + h.t.length + ' 字符），不是整行 500 字符', h.t.length);
}
{
  const d = await deep('fniao/c_longmd.md');
  const h = d.hits[0];
  ok(h.n === 3 && marks(hlText(h.t, 'HTTPS')) === 1, '长段落第 3 行的命中被高亮', h);
}

console.log('\n== 每行命中次数 ==');
{
  const d = await deep('fniao/a_short.py');
  const byLine = {};
  d.hits.forEach(h => byLine[h.n] = h.c);
  ok(byLine[2] === 2, '第 2 行 2 处（URL 里的 https + 注释里的 HTTPS）', byLine);
  ok(byLine[4] === 2, '第 4 行 2 处', byLine);
  ok(d.count === 4, '全文共 4 处', d.count);
  const line4 = d.hits.find(h => h.n === 4);
  ok(line4.c === 2 && marks(hlText(line4.t, 'HTTPS')) === 2,
    '第 4 行的片段里同一行的多处命中都高亮了', { c: line4.c, hl: marks(hlText(line4.t, 'HTTPS')), t: line4.t });
}

console.log('\n== 行数上限从 20 放宽到 200 ==');
{
  const d = await deep('fniao/d_many.txt');
  ok(d.hits.length === 30, '30 个命中行全部列出（修复前只列 20）', d.hits.length);
  ok(d.hitsMore === false, '未触发截断标记', d.hitsMore);
  ok(d.count === 30, '总数 30', d.count);
}

console.log('\n== 超大文件仍然只给总数 ==');
{
  const big = 'a'.repeat(600 * 1024) + '\nHTTPS\n';
  await R2.put('d/fniao/e_big.log', enc(big));
  const d = await deep('fniao/e_big.log');
  ok(d.hits === null, '>512KB 不给行号列表（省 CPU）', d.hits);
  ok(d.count === 1, '但仍然给出命中总数', d.count);
}

console.log('\n== 大小写不敏感 + 行号正确 ==');
{
  const d = await deep('fniao/a_short.py', 'https');
  ok(d.count === 4, '小写 https 也能搜到同样的 4 处', d.count);
  ok(d.hits.every(h => marks(hlText(h.t, 'https')) > 0), '小写查询下每一行也都高亮');
}

console.log('\n' + (fail ? 'FAILED ' : 'ALL PASS ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);