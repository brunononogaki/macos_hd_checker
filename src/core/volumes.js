'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { volumesRoot } = require('./paths');

function df(p) {
  return new Promise((resolve) => {
    execFile('df', ['-kP', p], { timeout: 8000 }, (err, out) => {
      if (err) return resolve(null);
      const line = out.trim().split('\n').pop().trim().split(/\s+/);
      const total = Number(line[1]) * 1024, used = Number(line[2]) * 1024;
      resolve(Number.isFinite(total) ? { fs: line[0], total, used } : null);
    });
  });
}

// Lista os volumes montados em /Volumes (exceto o disco do sistema).
async function listVolumes() {
  const root = volumesRoot();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const out = [];
  for (const name of names.sort()) {
    const p = path.join(root, name);
    let lst;
    try { lst = fs.lstatSync(p); } catch (e) { continue; }
    if (lst.isSymbolicLink() || !lst.isDirectory()) continue;     // "Macintosh HD" é symlink para /
    out.push({ name, path: p, ...(await df(p) || { fs: null, total: null, used: null }) });
  }
  return out;
}

module.exports = { listVolumes };
