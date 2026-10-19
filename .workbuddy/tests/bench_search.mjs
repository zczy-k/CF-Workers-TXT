// 量化搜索的成本：R2 操作次数 + 墙钟耗时。
// 重点验证本轮优化：① 冷搜的补扫开销 ② 换词再搜时 60s 补扫缓存省掉的 list
// ③ ftype 类型筛选是否额外产生 R2 请求。
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
const enc = s => new TextEncoder().encode(s);

async function build(n) {
  const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
  const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
  const call = async (path, init) => {
    const res = await worker.fetch(new Request(ORIGIN + path, init), env, exec);
    await Promise.all(exec.waits.splice(0));
    return res;
  };
  // 1 个文件走上传接口（让索引非空，触发"补扫"分支），其余全部直接写 R2
  await call(ADMIN + '/api?path=' + encodeURIComponent('dir0/种子.txt'), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: enc('种子正文')
  });
  for (let i = 0; i < n; i++) {
    await R2.put('d/dir' + (i % 20) + '/文件_' + i + '_去重.txt', enc('正文内容 ' + i));
  }
  return { R2, call };
}

function opsDelta(R2, before) {
  const d = {};
  for (const k of Object.keys(R2.ops)) d[k] = R2.ops[k] - before[k];
  return d;
}

async function run(R2, call, label, url) {
  const before = { ...R2.ops };
  const t0 = Date.now();
  const d = await (await call(ADMIN + '/api?action=search&' + url)).json();
  const ms = Date.now() - t0;
  console.log('  ' + label.padEnd(26) + ' | ' + String(ms).padStart(5) + 'ms | R2 ' +
    JSON.stringify(opsDelta(R2, before)).padEnd(28) + ' | 命中 ' + d.total +
    '（文件名 ' + d.nameHits + ' / 路径 ' + d.pathHits + ' / 正文 ' + d.textHits + ' / 目录 ' + d.dirHits + '）');
  return d;
}

for (const n of [100, 1000, 3000]) {
  console.log('\n== 库内文件数 ' + n + ' ==');
  const { R2, call } = await build(n);
  const q1 = 'q=' + encodeURIComponent('去重');
  await run(R2, call, '① 冷搜（首次，需补扫）', q1);
  await run(R2, call, '② 同词再搜（服务端缓存）', q1);
  // 换一个词：服务端 scanCache 仍在 60s 内 → 不该再跑 R2 list
  await run(R2, call, '③ 换词再搜（复用补扫）', 'q=' + encodeURIComponent('内容'));
  // 类型筛选：只应过滤结果，不额外产生 R2 请求
  await run(R2, call, '④ 只看文件名命中', q1 + '&ftype=name');
}