#!/usr/bin/env node
'use strict';
// Uso:
//   node src/cli.js run --job <id> [--full [--resume] | --only-new] [--json] [--no-email] [--scheduled]
//   node src/cli.js run-all [--json]
//   node src/cli.js status
//   node src/cli.js volumes
//   node src/cli.js test-email
const config = require('./core/config');
const dbmod = require('./core/db');
const { executeJob } = require('./core/scanner');
const { listVolumes } = require('./core/volumes');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const json = flag('json');

const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.round(n / 1e3) + ' KB');

function makeEmit() {
  let lastPrint = 0;
  return (ev) => {
    if (json) { process.stdout.write(JSON.stringify(ev) + '\n'); return; }
    if (ev.type === 'phase') console.log(`[${new Date().toLocaleTimeString()}] ${ev.message}`);
    else if (ev.type === 'plan') console.log(`  ${ev.total} arquivos no disco: ${ev.novos} novos, ${ev.alterados} alterados, ${ev.verificar} a re-verificar (${fmtBytes(ev.bytesTotal)})`);
    else if (ev.type === 'progress' && Date.now() - lastPrint > 5000) {
      lastPrint = Date.now();
      const pct = ev.bytesTotal ? Math.round((ev.bytesDone / ev.bytesTotal) * 100) : 100;
      console.log(`  ${pct}%  ${ev.filesDone}/${ev.filesTotal} arquivos  ${fmtBytes(ev.rate)}/s  problemas: ${ev.issues}`);
    } else if (ev.type === 'done') console.log(`[${new Date().toLocaleTimeString()}] Concluído: ${ev.status}${ev.note ? ' — ' + ev.note : ''}`);
  };
}

async function main() {
  const cfg = config.load();
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);

  if (cmd === 'volumes') {
    const v = await listVolumes();
    console.log(JSON.stringify(v, null, 2));
    return 0;
  }
  if (cmd === 'status') {
    const db = dbmod.open(config.dbPath(cfg));
    const out = cfg.jobs.map((j) => ({ job: j.name, volume: j.volume, ...dbmod.volumeStats(db, j.volume) }));
    console.log(JSON.stringify(out, null, 2));
    db.close();
    return 0;
  }
  if (cmd === 'test-email') {
    await require('./core/mailer').sendTestEmail(cfg);
    console.log('E-mail de teste enviado.');
    return 0;
  }
  if (cmd === 'run' || cmd === 'run-all') {
    const jobs = cmd === 'run-all' ? cfg.jobs : cfg.jobs.filter((j) => j.id === opt('job') || j.name === opt('job'));
    if (!jobs.length) { console.error('Job não encontrado.'); return 2; }
    let code = 0;
    for (const job of jobs) {
      // Manual: --full lê 100% do disco e sem limite de horário (ignora fatia e limite do job, que valem só para o agendado);
      //         --only-new lê só o que é novo/alterado. Sem flags = execução agendada (usa fatia e limite do job).
      const runJobDef = flag('only-new') ? { ...job, slicePercent: 0, name: job.name + ' (só novidades)' }
        : flag('full') ? { ...job, slicePercent: 100, maxMinutes: 0, name: job.name + ' (completa)' } : job;
      if (flag('full') && flag('resume')) {
        // continua a verificação completa interrompida: pula o que já foi lido desde que ela começou
        const rdb = dbmod.open(config.dbPath(cfg)); const rp = dbmod.resumePoint(rdb, job.volume); rdb.close();
        if (rp) { runJobDef.resumeSince = rp.since; runJobDef.name = job.name + ' (completa, continuação)'; }
      }
      const res = await executeJob({ job: runJobDef, cfg, emit: makeEmit(), signal: ctrl.signal, sendEmail: !flag('no-email') });
      if (json) process.stdout.write(JSON.stringify({ type: 'result', status: res.status, emailSent: !!res.emailSent, emailError: res.emailError || null, backupError: res.backupError || null }) + '\n');
      else if (res.emailError) console.error('Falha ao enviar e-mail: ' + res.emailError);
      if (res.status === 'error') code = 1;
      if (ctrl.signal.aborted) break;
    }
    return code;
  }
  console.error('Comandos: run --job <id> [--full [--resume] | --only-new] | run-all | status | volumes | test-email');
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
