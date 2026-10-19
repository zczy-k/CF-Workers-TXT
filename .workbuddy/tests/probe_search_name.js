// 复刻 worker.js 的搜索匹配逻辑，验证"文件名命中"是否真的能命中
function wordOkAt(low, i, len){
  const a = i > 0 ? low[i - 1] : '';
  const b = i + len < low.length ? low[i + len] : '';
  return !/[a-z0-9_]/i.test(a) && !/[a-z0-9_]/i.test(b);
}
function ciFind(text, q, qUpper, from, word){
  if (!text) return -1;
  const st = from || 0;
  if (text.length <= 262144){
    const low = text.toLowerCase();
    const ql = (q || '').toLowerCase();
    if (!ql) return -1;
    let i = low.indexOf(ql, st);
    while (word && i >= 0){
      if (wordOkAt(low, i, ql.length)) return i;
      i = low.indexOf(ql, i + 1);
    }
    return i;
  }
  let i = text.indexOf(q, st);
  if (i < 0 && qUpper !== q) i = text.indexOf(qUpper, st);
  return i;
}
function parseSearchQuery(raw){
  let ext = '', dir = '', word = false, q = String(raw || '');
  q = q.replace(/(^|\s)ext:(\S+)/i, (m, sp, v) => { ext = v.replace(/^\./, ''); return sp; });
  q = q.replace(/(^|\s)path:(\S+)/i, (m, sp, v) => { dir = v; return sp; });
  q = q.trim();
  if (q.length >= 2 && q.charAt(0) === '"' && q.charAt(q.length - 1) === '"'){
    word = true; q = q.slice(1, -1);
  }
  return { q, ext, dir, word };
}

const NAMES = ['节点链接_去重.txt','节点链接.txt','check_dup.py','fengniao_nodes_l7.json',
  'fengniao_sign.py','fetch_fluxyun.py','fluxyun_nodes.txt','fluxyun_subscription.txt',
  'fsdfsd.txt','inspect_fluxyun.py','process_fluxyun.py','process_nodes.py'];
const ALL = NAMES.map(n => 'fniao/' + n);

function runSearch(idxPaths, rawQ){
  const parsed = parseSearchQuery(rawQ);
  const qRaw = parsed.q, word = parsed.word;
  const qUp = qRaw.toUpperCase(), hasQ = !!qRaw;
  const files = {};
  for (const p of idxPaths) files[p] = [2, 100, 'text/plain', Date.now(), null];
  const total = Object.keys(files).length;
  const results = [];
  let nameHits = 0, pathHits = 0, textHits = 0;
  for (const p in files){
    const relPath = p;
    const base = relPath.split('/').pop();
    const nameHit = hasQ ? ciFind(base, qRaw, qUp, 0, word) >= 0 : true;
    const pathHit = !nameHit && hasQ && ciFind(relPath, qRaw, qUp, 0, word) >= 0;
    if (!nameHit && !pathHit) continue;
    if (nameHit) nameHits++; else pathHits++;
    results.push({ path: relPath, nameHit, pathHit });
  }
  return { indexedCount: total, nameHits, pathHits, textHits, results };
}

console.log('=== A. 索引里有全部 12 个文件，搜「去重」 ===');
console.log(JSON.stringify(runSearch(ALL, '去重'), null, 1));

console.log('\n=== B. 索引里只有 5 个文件（缺 节点链接_去重.txt），搜「去重」 ===');
const PART = ALL.filter(p => !/去重/.test(p)).slice(0, 5);
console.log('索引内容:', PART);
console.log(JSON.stringify(runSearch(PART, '去重'), null, 1));

console.log('\n=== C. 索引里有该文件，但开启整词匹配（word=true），搜「"去重"」 ===');
console.log(JSON.stringify(runSearch(ALL, '"去重"'), null, 1));