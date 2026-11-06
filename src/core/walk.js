'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { DEFAULT_IGNORE_NAMES } = require('./config');

function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function buildIgnore(extra = []) {
  const names = new Set(DEFAULT_IGNORE_NAMES.map((s) => s.toLowerCase()));
  const byName = [];
  const byPath = [];
  for (const p of extra.map((s) => s.trim()).filter(Boolean)) {
    (p.includes('/') ? byPath : byName).push(globToRegex(p.replace(/^\/+/, '')));
  }
  return (name, relPath) => {
    if (name.startsWith('._')) return true;                    // AppleDouble
    if (names.has(name.toLowerCase())) return true;
    if (byName.some((r) => r.test(name))) return true;
    if (byPath.length) {
      const full = relPath ? relPath + '/' + name : name;
      if (byPath.some((r) => r.test(full))) return true;
    }
    return false;
  };
}

// Lista todos os arquivos do volume (caminho relativo, tamanho, mtime). Não lê conteúdo.
async function walk(root, { ignore, signal } = {}) {
  const isIgnored = ignore || buildIgnore();
  const files = [];
  const errors = [];
  const stack = [''];
  while (stack.length) {
    if (signal && signal.aborted) { const e = new Error('abortado'); e.code = 'ABORT'; throw e; }
    const rel = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      if (rel === '') throw e;
      errors.push({ path: rel, error: e.code || String(e) });
      continue;
    }
    const names = [];
    for (const d of ents) {
      if (isIgnored(d.name, rel)) continue;
      if (d.isDirectory()) stack.push(rel ? rel + '/' + d.name : d.name);
      else if (d.isFile()) names.push(d.name);
    }
    for (let i = 0; i < names.length; i += 64) {
      const chunk = names.slice(i, i + 64);
      const res = await Promise.all(chunk.map((n) =>
        fsp.stat(path.join(root, rel, n)).then(
          (st) => ({ n, st }),
          (e) => { errors.push({ path: rel ? rel + '/' + n : n, error: e.code || String(e) }); return null; })));
      for (const r of res) {
        if (r) files.push({ path: rel ? rel + '/' + r.n : r.n, size: r.st.size, mtimeMs: Math.round(r.st.mtimeMs) });
      }
    }
  }
  return { files, errors };
}

module.exports = { walk, buildIgnore };
