'use strict';
// Quem está segurando o disco: análise do lsof, regras de segurança e encerramento educado (SIGTERM, sem forçar).
const dc = require('../src/core/diskcheck');
let failed = 0; const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };
const UID = 501;
const sample = ['p724', 'cQuickLook', 'u501', 'f12', 'p35423', 'ccom.apple.Virtualization.VirtualMachine', 'u501', 'f16', 'f26', 'f27',
  'p900', 'cbztransmit', 'u501', 'f3', 'p1', 'claunchd', 'u0', 'f5', 'p77', 'cmds', 'u0', 'f9', 'p4242', 'cHD Checker', 'u501', 'f4'].join('\n');
(async () => {
  console.log('Análise do lsof');
  const ps = dc.parseLsof(sample);
  ok('lê todos os processos', ps.length === 6);
  ok('conta arquivos abertos por processo', ps.find((p) => p.pid === 35423).files === 3);
  ok('entrada vazia não quebra', dc.parseLsof('').length === 0 && dc.parseLsof(null).length === 0);
  console.log('Nomes amigáveis');
  ok('VM do Claude', dc.describeProcess('com.apple.Virtualization.VirtualMachine') === 'Máquina virtual do app do Claude');
  ok('Backblaze', /Backblaze/.test(dc.describeProcess('bztransmit')));
  ok('Spotlight', /Spotlight/.test(dc.describeProcess('mds_stores')));
  ok('desconhecido mantém o nome', dc.describeProcess('foo') === 'foo');
  console.log('Quem pode ser encerrado');
  const k = (pid, uid) => dc.isKillable({ pid, uid }, 4242, UID);
  ok('processo do próprio usuário: sim', k(724, 501) === true);
  ok('processo de root (mds): não', k(77, 0) === false);
  ok('launchd (PID 1): nunca', dc.isKillable({ pid: 1, uid: UID }, 4242, UID) === false);
  ok('o próprio app: nunca', k(4242, 501) === false);
  ok('sem uid conhecido: não', dc.isKillable({ pid: 9, uid: null }, 4242, null) === false);
  console.log('Encerramento educado');
  const holders = ps.map((p) => ({ ...p, label: dc.describeProcess(p.command), killable: dc.isKillable(p, 4242, UID) }));
  let alive = new Set(holders.map((p) => p.pid)); const signals = [];
  const fake = {
    getHolders: async () => holders.filter((p) => alive.has(p.pid)),
    kill: (pid, sig) => { signals.push([pid, sig]); if (pid === 35423) alive.delete(pid); },   // a VM obedece; o QuickLook não
    wait: async () => {}, tries: 3,
  };
  const r = await dc.killHolders('/Volumes/Fotos', [724, 35423, 77, 1, 4242, 99999], fake);
  ok('só envia SIGTERM (nunca SIGKILL)', signals.length > 0 && signals.every(([, s]) => s === 'SIGTERM'));
  ok('encerra apenas quem é do usuário e está usando o disco', JSON.stringify(signals.map(([p]) => p).sort((a, b) => a - b)) === JSON.stringify([724, 35423]));
  ok('recusa root, launchd, o próprio app e PID que não segura o disco', [77, 1, 4242, 99999].every((p) => r.skipped.includes(p)));
  ok('informa quem não terminou (QuickLook ficou)', r.remaining.length === 1 && r.remaining[0].pid === 724);
  console.log(failed ? '\nFALHAS: ' + failed : '\nholders OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
