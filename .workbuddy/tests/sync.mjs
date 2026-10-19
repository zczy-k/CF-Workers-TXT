// 把仓库根目录的 worker.js 同步成测试用的 t.mjs。
// worker.js 只 export default；页面断言需要 appHtml，所以在副本末尾补一个具名导出。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'worker.js'), 'utf8');
writeFileSync(join(here, 't.mjs'), src + '\nexport { appHtml };\n');
console.log('[sync] t.mjs 已更新（' + src.length + ' 字符）');