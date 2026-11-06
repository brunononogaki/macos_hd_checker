'use strict';
// Checagens de saúde do disco no macOS: sistema de arquivos (diskutil) e ejetar.
// Nada aqui altera dados do disco: verifyVolume só lê (desmonta e remonta o volume), eject apenas desmonta.
const { spawn } = require('child_process');

function run(cmd, args, { timeout = 60000, input, onLine } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ok */ } }, timeout);
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: err || e.message }));
    const feed = (buf, isErr) => {
      const s = buf.toString();
      if (isErr) err += s; else out += s;
      if (onLine) s.split('\n').forEach((l) => { if (l.trim()) onLine(l.trim()); });
    };
    child.stdout.on('data', (d) => feed(d, false));
    child.stderr.on('data', (d) => feed(d, true));
    child.stdin.on('error', () => {});
    child.on('close', (code) => finish({ code: code == null ? -1 : code, stdout: out, stderr: err }));
    child.stdin.end(input == null ? undefined : input);
  });
}

// ---------- informações do volume ----------
async function diskutilInfo(target) {
  const r = await run('diskutil', ['info', '-plist', target], { timeout: 20000 });
  if (r.code !== 0 || !r.stdout) return null;
  const j = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: r.stdout, timeout: 10000 });
  if (j.code !== 0) return null;
  try { return JSON.parse(j.stdout); } catch (e) { return null; }
}

function summarizeInfo(vol, whole) {
  const w = whole || {};
  return {
    fsType: vol.FilesystemName || vol.FilesystemType || null,
    device: vol.DeviceIdentifier || null,
    wholeDisk: vol.ParentWholeDisk || w.DeviceIdentifier || null,
    bus: w.BusProtocol || vol.BusProtocol || null,
    solidState: w.SolidState != null ? !!w.SolidState : (vol.SolidState != null ? !!vol.SolidState : null),
    model: w.MediaName || vol.MediaName || null,
    ejectable: vol.Ejectable != null ? !!vol.Ejectable : null,
    writable: vol.WritableVolume != null ? !!vol.WritableVolume : null,
  };
}

async function getVolumeInfo(volumePath) {
  const vol = await diskutilInfo(volumePath);
  if (!vol) return null;
  const whole = vol.ParentWholeDisk ? await diskutilInfo(vol.ParentWholeDisk) : null;
  return summarizeInfo(vol, whole);
}

// ---------- sistema de arquivos ----------
function classifyVerify(code, text) {
  const t = text || '';
  if (/could not be unmounted|couldn'?t unmount|unable to unmount|failed to unmount|dissented|resource busy/i.test(t)) {
    return { status: 'busy', summary: 'Não foi possível desmontar o disco: algum programa (Backblaze, Spotlight, o próprio app, Finder) está usando. Feche o que estiver aberto no disco e tente de novo.' };
  }
  if (code === 0 && /appears to be OK|exit code is 0|was successfully verified/i.test(t)) {
    return { status: 'ok', summary: 'Sistema de arquivos íntegro (nenhuma inconsistência encontrada).' };
  }
  if (code !== 0 || /needs to be repaired|appears to be corrupt|found corrupt|error:|exit code is [1-9]/i.test(t)) {
    return { status: 'problems', summary: 'O macOS encontrou inconsistências no sistema de arquivos. NÃO grave arquivos neste disco até resolver; confirme o backup antes de qualquer reparo.' };
  }
  return { status: 'unknown', summary: 'Resultado inconclusivo. Veja a saída completa.' };
}

async function verifyVolume(volumePath, { onLine } = {}) {
  if (process.platform !== 'darwin') return { status: 'unavailable', summary: 'A checagem de sistema de arquivos usa o diskutil, disponível só no macOS.', output: '', code: -1 };
  // timeout generoso: um exFAT de 8 TB pode levar um bom tempo
  const r = await run('diskutil', ['verifyVolume', volumePath], { timeout: 3 * 3600 * 1000, onLine });
  const text = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
  return { ...classifyVerify(r.code, text), output: text, code: r.code };
}

async function ejectVolume(volumePath) {
  if (process.platform !== 'darwin') return { ok: false, message: 'Ejetar usa o diskutil (macOS).' };
  const r = await run('diskutil', ['eject', volumePath], { timeout: 90000 });
  const message = (r.stdout + ' ' + r.stderr).trim();
  return { ok: r.code === 0, message, busy: /dissented|busy|failed to unmount|couldn'?t unmount/i.test(message) };
}

// ---------- quem está usando o disco ----------
const KNOWN = [
  [/Virtualization\.VirtualMachine/i, 'Máquina virtual do app do Claude'],
  [/bztransmit|bzserv|bzfilelist|backblaze/i, 'Backblaze (backup)'],
  [/^QuickLook|quicklook/i, 'Pré-visualização (Quick Look)'],
  [/^mds|mdworker|mds_stores/i, 'Spotlight (indexação)'],
  [/^Finder$/i, 'Finder'],
  [/photolibraryd|photoanalysisd|mediaanalysisd|Photos/i, 'Fotos / análise de imagens'],
  [/ThumbnailsAgent|thumbnail/i, 'Gerador de miniaturas'],
  [/^Electron$|HD Checker/i, 'HD Checker'],
];
const describeProcess = (cmd) => { const k = KNOWN.find(([re]) => re.test(cmd || '')); return k ? k[1] : (cmd || 'desconhecido'); };

// Saída de `lsof -F pcuf`: linhas "p<pid>", "c<comando>", "u<uid>", "f<fd>" (uma por arquivo aberto).
function parseLsof(text) {
  const procs = new Map();
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const k = line[0], v = line.slice(1);
    if (k === 'p') { cur = { pid: Number(v), command: '', uid: null, files: 0 }; procs.set(cur.pid, cur); }
    else if (!cur) continue;
    else if (k === 'c') cur.command = v;
    else if (k === 'u') cur.uid = Number(v);
    else if (k === 'f') cur.files++;
  }
  return [...procs.values()].filter((p) => Number.isFinite(p.pid));
}

// Só processos do próprio usuário, que não sejam o launchd (1) nem este app, podem ser encerrados pelo app.
const isKillable = (p, selfPid = process.pid, uid = (process.getuid ? process.getuid() : null)) =>
  p.pid > 1 && p.pid !== selfPid && uid != null && p.uid === uid;

async function holders(volumePath) {
  if (process.platform !== 'darwin') return [];
  const r = await run('/usr/sbin/lsof', ['+c', '0', '-nP', '-F', 'pcuf', '--', volumePath], { timeout: 60000 });
  return parseLsof(r.stdout).map((p) => ({ ...p, label: describeProcess(p.command), killable: isKillable(p) }));
}

// Pede educadamente (SIGTERM) que os processos escolhidos terminem. Nunca força (SIGKILL). Revalida cada PID contra o lsof:
// só encerra quem de fato ainda está usando este volume.
async function killHolders(volumePath, pids, { getHolders = holders, kill = process.kill.bind(process), wait = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 12 } = {}) {
  const want = new Set((pids || []).map(Number));
  const now = await getHolders(volumePath);
  const targets = now.filter((p) => want.has(p.pid) && p.killable);
  const termed = [], failed = [];
  for (const p of targets) {
    try { kill(p.pid, 'SIGTERM'); termed.push(p.pid); } catch (e) { failed.push({ pid: p.pid, error: e.code || e.message }); }
  }
  let remaining = [];
  for (let i = 0; i < tries; i++) {
    await wait(500);
    const h = await getHolders(volumePath);
    remaining = h.filter((p) => termed.includes(p.pid));
    if (!remaining.length) break;
  }
  return { termed, failed, remaining, skipped: [...want].filter((x) => !targets.some((p) => p.pid === x)) };
}

module.exports = { holders, killHolders, parseLsof, describeProcess, isKillable, getVolumeInfo, summarizeInfo, verifyVolume, classifyVerify, ejectVolume, run };
