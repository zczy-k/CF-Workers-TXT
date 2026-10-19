import { spawn } from 'node:child_process';
const NODE = process.execPath;
const srv = spawn(NODE, ['serve.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

let up = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch('http://127.0.0.1:8899/adm-123');
    if (r.status) { up = true; break; }
  } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
}
if (!up) { console.error('桥接服务未就绪'); srv.kill(); process.exit(1); }
console.log('[run] 桥接服务已就绪');

const target = process.argv[2] || 'browser.mjs';
const t = spawn(NODE, [target], { stdio: 'inherit' });
t.on('exit', c => { try { srv.kill(); } catch (e) {} process.exit(c || 0); });
