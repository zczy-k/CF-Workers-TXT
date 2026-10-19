// HTML 单文档分享：壳页面 + 真文档模式（?doc=1）+ 分享内静态资源 + SVG 加固
// 驱动真实 worker（t.mjs），mock R2 / KV。
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const ORIGIN = 'https://demo.workers.dev';
const ADMIN = '/adm-123';
let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
const call = async (path, init) => {
  const u = /^https?:\/\//.test(path) ? path : ORIGIN + path;
  const res = await worker.fetch(new Request(u, init), env, exec);
  await Promise.all(exec.waits.splice(0));
  return res;
};
const enc = s => new TextEncoder().encode(s);
const share = async (path, kind) => {
  const token = 'tok-' + Math.random().toString(36).slice(2, 8);
  await KV.put('share:' + token, JSON.stringify({ path, kind, at: Date.now() }));
  return token;
};
const putPub = (path, body, ct) => R2.put('__pub__/' + path, enc(body), { httpMetadata: { contentType: ct } });

// 带恶意脚本、并引用自己目录里资源的 HTML
const HTML_HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>探针</title>'
  + '<link rel="stylesheet" href="style.css"></head><body><h1>你好</h1>'
  + '<img src="img/logo.png" alt="logo">'
  + '<script>alert(1)</script><img src=x onerror=alert(2)></body></html>';
const HTML_NOHEAD = '<!doctype html><html><body><p>没有 head 的页面</p></body></html>';
await putPub('demo/页面.html', HTML_HEAD, 'text/html; charset=utf-8');
await putPub('demo/无head.html', HTML_NOHEAD, 'text/html;charset=utf-8');
await putPub('demo/style.css', 'body{color:red}', 'text/css');
await putPub('demo/img/logo.png', 'PNGDATA', 'image/png');
await putPub('demo/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(9)</script></svg>', 'image/svg+xml');
await putPub('demo/js/app.js', 'alert(3)', 'application/javascript');
await putPub('demo/secret.txt', 'SECRET-DO-NOT-LEAK', 'text/plain');
await putPub('topsecret/other.css', 'TOP-SECRET-CSS', 'text/css');
await putPub('demo/pic.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(3)</script></svg>', 'image/svg+xml');
await putPub('demo/a.txt', '纯文本内容', 'text/plain');
await putPub('demo/old.htm', HTML_HEAD, 'text/html');
const tokHtml = await share('demo/页面.html', 'file');
const tokNoHead = await share('demo/无head.html', 'file');
const tokSvg = await share('demo/pic.svg', 'file');
const tokTxt = await share('demo/a.txt', 'file');
const tokHtm = await share('demo/old.htm', 'file');

head('HTML 单文档分享：普通导航拿壳页面');
{
  const r = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html'));
  ok(r.status === 200, '壳页面 200', r.status);
  ok((r.headers.get('Content-Type') || '').indexOf('text/html') === 0, '壳页面是 text/html', r.headers.get('Content-Type'));
  const shell = await r.text();
  ok(shell.indexOf('<script>alert(1)</script>') < 0, '壳页面不含用户的 script 标签');
  ok(shell.indexOf('onerror=alert(2)') < 0, '壳页面不含用户的事件属性');
  ok(shell.indexOf('alert') < 0, '壳页面全文没有任何用户脚本痕迹');
  ok(shell.indexOf('id="frame"') >= 0, '壳页面有预览 iframe');
  const sbAttr = (shell.match(/sandbox="([^"]*)"/) || [])[1] || '';
  ok(sbAttr === 'allow-popups allow-popups-to-escape-sandbox',
    'iframe 的 sandbox 只有 allow-popups 系列（没有 allow-scripts / allow-same-origin）', sbAttr);
  ok(shell.indexOf("urlWith('doc', '1')") >= 0, '壳页面让 iframe 加载 ?doc=1 真文档');
  ok(shell.indexOf('?dl=1') >= 0, '壳页面有下载入口（?dl=1）');
  ok(shell.indexOf('页面.html') >= 0, '壳页面显示文件名');
  ok((r.headers.get('X-Robots-Tag') || '').indexOf('noindex') >= 0, '壳页面不被搜索引擎收录');
  ok((r.headers.get('X-Content-Type-Options') || '') === 'nosniff', '壳页面带 nosniff');
  const m = shell.match(/<script>([\s\S]*?)<\/script>/);
  ok(!!m, '壳页面能提取出内联脚本');
  let syn = null;
  try { new Function(m ? m[1] : ''); } catch (e) { syn = e.message; }
  ok(!syn, '壳页面内联脚本可以正常编译', syn);
}

head('真文档模式 ?doc=1：只多一个 <base>，脚本仍然没有任何出路');
{
  const r = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?doc=1');
  ok(r.status === 200, '?doc=1 200', r.status);
  ok((r.headers.get('Content-Type') || '').indexOf('text/html') === 0, '?doc=1 是 text/html', r.headers.get('Content-Type'));
  const csp = r.headers.get('Content-Security-Policy') || '';
  ok(csp.indexOf("script-src 'none'") >= 0, 'CSP: script-src none（脚本死路）', csp);
  ok(csp.indexOf("frame-ancestors 'self'") >= 0, 'CSP: frame-ancestors self（只许自己的壳页面嵌）');
  ok(csp.indexOf("style-src 'self' 'unsafe-inline'") >= 0, 'CSP: 放行自己的样式表');
  ok(csp.indexOf("img-src 'self' data:") >= 0, 'CSP: 放行本分享内的图片');
  ok(csp.indexOf("object-src 'none'") >= 0 && csp.indexOf("frame-src 'none'") >= 0, 'CSP: 封掉插件与子框架');
  ok((r.headers.get('X-Frame-Options') || '') === '',
    'X-Frame-Options 让位给 frame-ancestors（否则自己的壳页面也嵌不了）');
  const html = await r.text();
  ok(html === HTML_HEAD.replace('<head>', '<head><base href="/s/' + tokHtml + '/" target="_blank">'),
    '原文只多了一个 base，其余一字不动', html.slice(0, 140));
  ok(html.indexOf('alert(1)') >= 0, '用户的脚本**仍然原样在文档里**（只是永远不执行）');
}

head('base 注入的兜底：没有 head 就插在 doctype 之后');
{
  const r = await call('/s/' + tokNoHead + '/' + encodeURIComponent('无head.html') + '?doc=1');
  const html = await r.text();
  ok(html.indexOf('<!doctype html><base href="/s/' + tokNoHead + '/" target="_blank"><html>') === 0,
    'doctype 之后插入（不破坏 standards 模式）', html.slice(0, 90));
}

head('分享内静态资源：只放行被动类型');
{
  const r1 = await call('/s/' + tokHtml + '/style.css');
  ok(r1.status === 200 && (r1.headers.get('Content-Type') || '').indexOf('text/css') === 0,
    '同目录 css 能取到，且类型是 text/css', r1.headers.get('Content-Type'));
  ok((await r1.text()) === 'body{color:red}', 'css 内容正确');

  const r2 = await call('/s/' + tokHtml + '/img/logo.png');
  ok(r2.status === 200 && (r2.headers.get('Content-Type') || '') === 'image/png', '子目录图片能取到（类型按白名单给）');
  ok((await r2.text()) === 'PNGDATA', '图片内容正确');

  const r3 = await call('/s/' + tokHtml + '/icon.svg');
  ok(r3.status === 200 && (r3.headers.get('Content-Type') || '').indexOf('image/svg') === 0, 'svg 资源能取到');
  ok((r3.headers.get('Content-Security-Policy') || '').indexOf("default-src 'none'") >= 0,
    'svg 资源单独带最严 CSP（直接打开也跑不了脚本）');
  await r3.text();

  const r4 = await call('/s/' + tokHtml + '/js/app.js');
  ok(r4.status === 404, '脚本类资源不给（404，不是白名单类型）', r4.status);
  await r4.text();

  const r5 = await call('/s/' + tokHtml + '/secret.txt');
  const t5 = await r5.text();
  ok(t5.indexOf('SECRET-DO-NOT-LEAK') < 0 && t5.indexOf('<!doctype') >= 0,
    '同目录的 txt 不会被资源通道吐出去：多余后缀会兜底返回分享的文件本身，不是同目录私货', [r5.status, t5.length, t5.slice(0, 60)]);

  // 目录穿越：%2e%2e 解码后是 ..，必须被归一化折叠在分享目录内
  const r6 = await call('/s/' + tokHtml + '/%2e%2e/topsecret/other.css');
  const t6 = await r6.text();
  ok(r6.status === 404 && t6.indexOf('TOP-SECRET-CSS') < 0, '穿越到分享目录之外取不到（404）', r6.status);

  // 非 HTML 的单文件分享不开资源通道
  const r7 = await call('/s/' + tokTxt + '/style.css');
  const t7 = await r7.text();
  ok(t7.indexOf('body{color:red}') < 0, 'txt 分享没有资源通道（不会顺手暴露同目录资源）', t7.slice(0, 40));
}

head('HTML 单文档分享：?raw=1 拿纯文本原文');
{
  const r = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?raw=1');
  ok(r.status === 200, '?raw=1 200', r.status);
  ok((r.headers.get('Content-Type') || '').indexOf('text/plain') === 0, '?raw=1 是纯文本', r.headers.get('Content-Type'));
  ok((await r.text()) === HTML_HEAD, '?raw=1 返回原始 HTML 源码（一字不差，没有 base）');
}

head('HTML 单文档分享：?dl=1 仍是下载');
{
  const r = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?dl=1');
  ok(/attachment/.test(r.headers.get('Content-Disposition') || ''), '?dl=1 带 attachment', r.headers.get('Content-Disposition'));
  await r.text();
  const r2 = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?raw=1&dl=1');
  ok(/attachment/.test(r2.headers.get('Content-Disposition') || ''), '?raw=1&dl=1 下载优先');
  await r2.text();
  const r3 = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?doc=1&dl=1');
  ok(/attachment/.test(r3.headers.get('Content-Disposition') || ''), '?doc=1&dl=1 下载优先');
  await r3.text();
}

head('不带文件名后缀的链接同样走壳页面');
{
  const r = await call('/s/' + tokHtm);
  ok(r.status === 200 && (r.headers.get('Content-Type') || '').indexOf('text/html') === 0,
    '/s/<token>（无后缀）也返回壳页面', r.headers.get('Content-Type'));
  await r.text();
  const r2 = await call('/s/' + tokHtm + '?doc=1');
  ok((r2.headers.get('Content-Security-Policy') || '').indexOf('frame-ancestors') >= 0,
    '/s/<token>?doc=1 也能拿到真文档（base 用不带文件名的前缀）');
  const h2 = await r2.text();
  ok(h2.indexOf('<base href="/s/' + tokHtm + '/" target="_blank">') >= 0, 'base 前缀正确', h2.slice(0, 90));
}

head('SVG 直链加固：按纯文本输出');
{
  const r = await call('/s/' + tokSvg + '/' + encodeURIComponent('pic.svg'));
  ok((r.headers.get('Content-Type') || '').indexOf('text/plain') === 0,
    'SVG 直链强制纯文本（独立 SVG 文档里脚本能执行，不能内联返回）', r.headers.get('Content-Type'));
  const t = await r.text();
  ok(t.indexOf('<script>alert(3)</script>') >= 0, 'SVG 以源码形式返回');
  const r2 = await call('/s/' + tokSvg + '/' + encodeURIComponent('pic.svg') + '?dl=1');
  ok((r2.headers.get('Content-Type') || '').indexOf('image/svg') === 0, 'SVG 强制下载时保留原类型');
  await r2.text();
}

head('其他类型不受影响');
{
  let r = await call('/s/' + tokTxt + '/' + encodeURIComponent('a.txt'));
  ok((r.headers.get('Content-Type') || '').indexOf('text/plain') === 0, 'txt 分享仍是纯文本');
  ok((await r.text()) === '纯文本内容', 'txt 内容不变');
  r = await call('/s/tok-nonexist/x.txt');
  ok(r.status === 404, '失效口令 404', r.status);
  await r.text();
}

head('超大 HTML 退回纯文本源码');
{
  const big = '<p>' + 'x'.repeat(4 * 1024 * 1024 + 10) + '</p>';
  await putPub('demo/big.html', big, 'text/html');
  const tokBig = await share('demo/big.html', 'file');
  const r = await call('/s/' + tokBig + '/' + encodeURIComponent('big.html'));
  ok((r.headers.get('Content-Type') || '').indexOf('text/plain') === 0,
    '超过 HTML_SHELL_MAX 不建壳页面，退回纯文本源码', r.headers.get('Content-Type'));
  const t = await r.text();
  ok(t.length === big.length, '超大 HTML 原文完整返回', t.length);
  const r2 = await call('/s/' + tokBig + '/' + encodeURIComponent('big.html') + '?doc=1');
  ok((r2.headers.get('Content-Type') || '').indexOf('text/plain') === 0, '超大 HTML 的 ?doc=1 也退回纯文本');
  await r2.text();
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : `\n✅ 功能测试全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
