'use strict';
// Compara uma pasta de origem com a de destino (ex.: cartão/HD antigo × HD novo) para confirmar que a cópia é idêntica.
// Só lê; não altera nada em nenhum dos lados.
const path = require('path');
const { walk, buildIgnore } = require('./walk');
const { hashFile } = require('./hashing');

async function compareTrees({ src, dst, quick = false, ignore = [], onProgress = () => {}, signal }) {
  const ig = buildIgnore(ignore);
  onProgress({ type: 'phase', message: 'Listando origem e destino…' });
  const [ws, wd] = await Promise.all([walk(src, { ignore: ig, signal }), walk(dst, { ignore: ig, signal })]);
  const dmap = new Map(wd.files.map((f) => [f.path, f]));
  const srcSet = new Set();
  const res = { srcFiles: ws.files.length, dstFiles: wd.files.length, same: 0, different: [], missing: [], extra: [], errors: [], bytesCompared: 0, quick, aborted: false };
  const todo = [];
  for (const f of ws.files) {
    srcSet.add(f.path);
    const d = dmap.get(f.path);
    if (!d) res.missing.push({ path: f.path, size: f.size });
    else if (d.size !== f.size) res.different.push({ path: f.path, reason: 'tamanho diferente', srcSize: f.size, dstSize: d.size });
    else todo.push(f);
  }
  for (const d of wd.files) if (!srcSet.has(d.path)) res.extra.push({ path: d.path, size: d.size });
  if (quick) { res.same = todo.length; return res; }

  const bytesTotal = todo.reduce((s, f) => s + f.size, 0);
  let done = 0, bytesDone = 0, lastEmit = 0;
  const t0 = Date.now();
  onProgress({ type: 'phase', message: `Comparando o conteúdo de ${todo.length} arquivos (hash dos dois lados)…` });
  for (const f of todo) {
    if (signal && signal.aborted) { res.aborted = true; break; }
    try {
      const [a, b] = await Promise.all([hashFile(path.join(src, f.path)), hashFile(path.join(dst, f.path))]);
      if (a === b) res.same++;
      else res.different.push({ path: f.path, reason: 'conteúdo diferente', srcSize: f.size, dstSize: f.size });
    } catch (e) {
      res.errors.push({ path: f.path, error: e.code || e.message });
    }
    done++; bytesDone += f.size;
    const n = Date.now();
    if (n - lastEmit > 400) {
      lastEmit = n;
      const rate = bytesDone / Math.max(1, (n - t0) / 1000);
      onProgress({ type: 'progress', done, total: todo.length, bytesDone, bytesTotal, current: f.path, rate, etaSec: rate > 0 ? (bytesTotal - bytesDone) / rate : null });
    }
  }
  res.bytesCompared = bytesDone;
  return res;
}

module.exports = { compareTrees };
