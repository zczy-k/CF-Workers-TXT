// 把动态生成的 PWA 图标落盘，供人查看实际效果
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const OUT = HERE + '/shots';
const e = Object.assign({ R2: new MockR2(), KV: new MockKV(), ADMIN_UUID: 'adm-123', FILENAME: '文本云盘' }, {});
const exec = makeExec();
for (const sz of [512, 192]) {
  const t0 = Date.now();
  const r = await worker.fetch(new Request('https://demo.workers.dev/icon/' + sz + '.png'), e, exec);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(OUT + '/pwa-icon-' + sz + '.png', buf);
  console.log('icon/' + sz + '.png → ' + buf.length + ' bytes（生成耗时 ' + (Date.now() - t0) + 'ms）→ ' + r.headers.get('Content-Type'));
}
const mf = await (await worker.fetch(new Request('https://demo.workers.dev/manifest.webmanifest'), e, exec)).text();
console.log('\nmanifest 内容：\n' + mf);
