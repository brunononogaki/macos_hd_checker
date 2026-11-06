'use strict';
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { volumesRoot } = require('./paths');
const { walk, buildIgnore } = require('./walk');
const { hashFile } = require('./hashing');
const { validate, extOf } = require('./checks');
const dbmod = require('./db');
const configmod = require('./config');

const TEST_DELAY_MS = Number(process.env.HD_CHECKER_TEST_DELAY_MS || 0);   // gancho só para testes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDbError = (e) => !!e && (e.code === 'ERR_SQLITE_ERROR' || /SQLITE/i.test(String(e.code || '')));

async function runJob({ job, cfg, db, emit = () => {}, signal }) {
  const root = path.join(volumesRoot(), job.volume);
  const stats = {
    total: 0, hashed: 0, new: 0, changed: 0, missing: 0, moved: 0, issues: 0, bytes: 0,
    pendingNew: 0, modifiedDuring: 0, vanished: 0, walkErrors: 0, dbErrors: 0,
  };
  const newIssues = [];   // eventos criados nesta execução (para o e-mail)

  // 0) Uma execução por disco: se já existe uma viva, não lê o mesmo disco duas vezes.
  const acq = dbmod.acquireRun(db, job);
  if (acq.busy) {
    const note = `Já existe uma verificação do disco "${job.volume}" em andamento (processo ${acq.busy.pid || '?'}, ` +
      `iniciada em ${new Date(acq.busy.started_at).toLocaleString('pt-BR')}). Esta execução foi pulada para não ler o mesmo disco duas vezes.`;
    const runId = dbmod.insertFinishedRun(db, job, 'skipped', note);
    emit({ type: 'done', runId, status: 'skipped', note, stats });
    return { runId, status: 'skipped', note, stats, newIssues, volume: job.volume, job };
  }
  const runId = acq.runId;
  const startedAt = Date.now();

  // Progresso ao vivo no banco (a tela de Relatórios mostra números reais enquanto roda)
  const live = db.prepare(`UPDATE runs SET heartbeat=?, files_total=?, files_hashed=?, files_new=?, files_changed=?,
    files_moved=?, issues=?, bytes_read=?, pending_new=? WHERE id=? AND status='running'`);
  const beat = () => {
    try { live.run(Date.now(), stats.total, stats.hashed, stats.new, stats.changed, stats.moved, stats.issues, stats.bytes, stats.pendingNew, runId); } catch (e) { /* tenta de novo no próximo ciclo */ }
  };
  const hb = setInterval(beat, 3000);
  if (hb.unref) hb.unref();

  const finish = (status, note) => {
    clearInterval(hb);
    db.prepare(`UPDATE runs SET finished_at=?, status=?, files_total=?, files_hashed=?, files_new=?, files_changed=?,
      files_missing=?, files_moved=?, issues=?, bytes_read=?, pending_new=?, note=?, heartbeat=? WHERE id=?`)
      .run(Date.now(), status, stats.total, stats.hashed, stats.new, stats.changed, stats.missing, stats.moved,
        stats.issues, stats.bytes, stats.pendingNew, note || null, Date.now(), runId);
    emit({ type: 'done', runId, status, note, stats });
    return { runId, status, note, stats, newIssues, volume: job.volume, job };
  };

  const body = async () => {
    // 1) O disco está montado?
    try {
      const st = await fsp.stat(root);
      if (!st.isDirectory()) throw new Error('não é pasta');
    } catch (e) {
      return finish('skipped', `Disco "${job.volume}" não está conectado.`);
    }

    // 1b) Alarmes falsos de versões antigas: "erro de leitura (ENOENT)" = o arquivo não foi encontrado na hora da leitura
    // (disco ejetado/desconectado no meio da verificação, ou arquivo movido). Não é corrupção: fecha e deixa reler.
    try {
      const cl = db.prepare("UPDATE events SET resolved=1, resolved_at=?, resolution=? WHERE volume=? AND kind='ilegivel' AND resolved=0 AND detail LIKE '%ENOENT%'")
        .run(Date.now(), 'alarme falso: arquivo não encontrado na hora da leitura (disco desconectado?); será relido', job.volume);
      if (cl.changes) {
        db.prepare(`UPDATE files SET status='ok', suspect_hash=NULL WHERE volume=? AND status='suspect' AND suspect_hash IS NULL AND hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.volume=files.volume AND e.path=files.path AND e.resolved=0)`).run(job.volume);
        stats.clearedFalseAlarms = cl.changes;
      }
    } catch (e) { /* não bloqueia a verificação */ }

    // 1c) Arquivos com erro que o usuário já apagou/moveu (status 'missing'): o erro não faz mais sentido, fecha o alerta
    // (e o aviso de "arquivo sumiu" que acompanhou). Cobre execuções de versões anteriores.
    try {
      const gone = db.prepare(`SELECT DISTINCT e.path FROM events e JOIN files f ON f.volume=e.volume AND f.path=e.path
        WHERE e.volume=? AND e.resolved=0 AND e.kind IN ('bitrot','estrutura','ilegivel') AND f.status='missing'`).all(job.volume);
      if (gone.length) {
        const r1 = db.prepare("UPDATE events SET resolved=1, resolved_at=?, resolution=? WHERE volume=? AND path=? AND resolved=0 AND kind IN ('bitrot','estrutura','ilegivel','missing')");
        const now1 = Date.now();
        db.exec('BEGIN');
        try { for (const g of gone) r1.run(now1, 'arquivo removido do disco (apagado ou movido)', job.volume, g.path); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* ok */ } throw e; }
        stats.clearedRemoved = gone.length;
      }
    } catch (e) { /* não bloqueia a verificação */ }

    // 2) Lista os arquivos (só metadados)
    emit({ type: 'phase', runId, phase: 'listando', message: 'Listando arquivos do disco…' });
    let w;
    try {
      w = await walk(root, { ignore: buildIgnore(job.ignore), signal });
    } catch (e) {
      if (e.code === 'ABORT') return finish('stopped', 'Interrompido pelo usuário durante a listagem.');
      return finish('error', `Falha ao listar o disco: ${e.code || e.message}`);
    }
    stats.walkErrors = w.errors.length;
    stats.total = w.files.length;
    beat();

    let dbRows = db.prepare('SELECT id, path, size, mtime_ms, hash, status, suspect_hash, last_hashed FROM files WHERE volume = ?').all(job.volume);
    // Caminhos que hoje são ignorados (ex.: .bzvol do Backblaze, ou padrões do job): saem do inventário e seus alertas antigos
    // ("arquivo sumiu" de arquivos temporários) são fechados, para não poluir os relatórios.
    {
      const ign = buildIgnore(job.ignore);
      const pathIgnored = (p) => { let rel = ''; for (const n of p.split('/')) { if (ign(n, rel)) return true; rel = rel ? rel + '/' + n : n; } return false; };
      const gone = dbRows.filter((r) => pathIgnored(r.path));
      const evPaths = db.prepare('SELECT DISTINCT path FROM events WHERE volume = ? AND resolved = 0').all(job.volume).map((r) => r.path).filter(pathIgnored);
      if (gone.length || evPaths.length) {
        const del = db.prepare('DELETE FROM files WHERE id = ?');
        const res = db.prepare("UPDATE events SET resolved=1, resolved_at=?, resolution=? WHERE volume=? AND path=? AND resolved=0");
        const t = Date.now();
        db.exec('BEGIN');
        try {
          for (const r of gone) del.run(r.id);
          for (const p of evPaths) res.run(t, 'caminho ignorado pelo app (arquivos temporários de outro programa)', job.volume, p);
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* ok */ } throw e; }
        dbRows = dbRows.filter((r) => !pathIgnored(r.path));
        stats.clearedIgnored = evPaths.length;
        stats.ignoredRows = gone.length;
      }
    }
    if (w.files.length === 0 && dbRows.length > 0) {
      return finish('skipped', `O disco "${job.volume}" aparece vazio (não montado corretamente?). Nada foi alterado.`);
    }

    // 3) Classifica
    const rowByPath = new Map(dbRows.map((r) => [r.path, r]));
    const seen = new Set();
    const newF = [], changed = [];
    let same = [];
    for (const f of w.files) {
      seen.add(f.path);
      const r = rowByPath.get(f.path);
      if (!r) newF.push(f);
      else if (r.size !== f.size || r.mtime_ms !== f.mtimeMs) changed.push({ ...f, row: r });
      else if (r.status === 'missing' || r.hash == null) changed.push({ ...f, row: r, reappeared: true });
      else same.push({ ...f, row: r });
    }
    newF.sort((a, b) => (a.path < b.path ? -1 : 1));
    changed.sort((a, b) => (a.path < b.path ? -1 : 1));
    stats.pendingNew = newF.length;

    // Rodízio: os verificados há mais tempo primeiro, até a fatia (% dos bytes) do job.
    // Retomada (job.resumeSince): quem já foi verificado desde o início das execuções interrompidas fica de fora.
    const sameAll = same;
    if (job.resumeSince) {
      same = same.filter((f) => !(f.row.last_hashed && f.row.last_hashed >= job.resumeSince));
      stats.resumeSkipped = sameAll.length - same.length;
    }
    same.sort((a, b) => (a.row.last_hashed || 0) - (b.row.last_hashed || 0));
    const sameBytes = same.reduce((s, f) => s + f.size, 0);
    const slicePct = Math.max(0, Math.min(100, job.slicePercent ?? 12.5));
    const budgetBytes = sameBytes * slicePct / 100;
    const slice = [];
    let acc = 0;
    for (const f of same) {
      if (slicePct < 100 && acc >= budgetBytes) break;   // 100% => verifica tudo (inclui arquivos de 0 bytes)
      slice.push(f); acc += f.size;
    }

    // Arquivos com problema de estrutura em aberto são revalidados a cada execução (barato): se foram restaurados
    // ou o problema era falso alarme, o evento se resolve sozinho.
    const openStruct = new Set(db.prepare("SELECT DISTINCT path FROM events WHERE volume=? AND kind IN ('estrutura','ilegivel') AND resolved=0").all(job.volume).map((r) => r.path));
    if (openStruct.size) {
      const inSlice = new Set(slice.map((f) => f.path));
      for (const f of sameAll) if (openStruct.has(f.path) && !inSlice.has(f.path)) slice.push(f);
    }

    const tasks = [
      ...changed.map((f) => ({ ...f, kind: 'changed' })),
      ...newF.map((f) => ({ ...f, kind: 'new' })),
      ...slice.map((f) => ({ ...f, kind: 'verify' })),
    ];
    const bytesTotal = tasks.reduce((s, t) => s + t.size, 0);
    emit({ type: 'plan', runId, total: w.files.length, novos: newF.length, alterados: changed.length, verificar: slice.length, bytesTotal });

    // 4) Processa. Cada gravação é uma transação curta: outros processos (outro disco em paralelo) nunca ficam esperando.
    const stmt = {
      insert: db.prepare(`INSERT INTO files (volume,path,size,mtime_ms,hash,first_seen,last_hashed,status) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(volume,path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, hash=excluded.hash,
        last_hashed=excluded.last_hashed, status=excluded.status`),
      update: db.prepare('UPDATE files SET size=?, mtime_ms=?, hash=?, last_hashed=?, status=?, suspect_hash=NULL WHERE id=?'),
      touch: db.prepare('UPDATE files SET last_hashed=?, status=?, suspect_hash=? WHERE id=?'),
      suspect: db.prepare('UPDATE files SET status=\'suspect\', suspect_hash=? WHERE id=?'),
      findMissing: db.prepare('SELECT id, path FROM files WHERE volume=? AND status=\'missing\' AND hash=? AND size=? LIMIT 1'),
      delFile: db.prepare('DELETE FROM files WHERE id=?'),
      evFind: db.prepare('SELECT id FROM events WHERE volume=? AND path=? AND kind=? AND resolved=0'),
      evIns: db.prepare('INSERT INTO events (run_id,volume,path,kind,severity,detail,at) VALUES (?,?,?,?,?,?,?)'),
      evOpenErr: db.prepare("SELECT id FROM events WHERE volume=? AND path=? AND resolved=0 AND kind IN ('bitrot','estrutura','ilegivel') LIMIT 1"),
      evResolve: db.prepare('UPDATE events SET resolved=1, resolved_at=?, resolution=? WHERE volume=? AND path=? AND resolved=0 AND kind IN (\'bitrot\',\'estrutura\',\'ilegivel\',\'missing\')'),
      evResolveKind: db.prepare('UPDATE events SET resolved=1, resolved_at=?, resolution=? WHERE volume=? AND path=? AND resolved=0 AND kind=?'),
      markMissing: db.prepare('UPDATE files SET status=\'missing\' WHERE id=?'),
    };

    const addEvent = (relPath, kind, severity, detail) => {
      if (stmt.evFind.get(job.volume, relPath, kind)) return false;
      stmt.evIns.run(runId, job.volume, relPath, kind, severity, detail, Date.now());
      stats.issues++;
      newIssues.push({ path: relPath, kind, severity, detail });
      return true;
    };

    const newHashKeys = new Map(); // "hash|size" -> path (arquivos novos desta execução, p/ detectar movidos)
    let bytesDone = 0, filesDone = 0, lastEmit = 0, stoppedByBudget = false, current = '';
    let processedNew = 0, processedChanged = 0;
    const deadline = job.maxMinutes > 0 ? startedAt + job.maxMinutes * 60000 : 0;
    const doValidate = job.validate !== false;
    let volumeLost = false;
    const rootAlive = async () => { try { const st = await fsp.stat(root); if (!st.isDirectory()) return false; await fsp.readdir(root); return true; } catch (e) { return false; } };

    async function processTask(t) {
      const abs = path.join(root, t.path);
      current = t.path;
      try {
        if (TEST_DELAY_MS) await sleep(TEST_DELAY_MS);
        let val = null;
        if (doValidate && (t.kind !== 'verify' || t.row.status === 'suspect' || openStruct.has(t.path))) val = await validate(abs, t.size, extOf(t.path));
        const hex = await hashFile(abs, { onBytes: (n) => { stats.bytes += n; bytesDone += n; } });
        const st = await fsp.stat(abs);
        if (st.size !== t.size || Math.round(st.mtimeMs) !== t.mtimeMs) { stats.modifiedDuring++; return; }
        const now = Date.now();
        stats.hashed++;

        if (t.kind === 'new') {
          processedNew++;
          const status = val && val.level === 'error' ? 'suspect' : 'ok';
          stmt.insert.run(job.volume, t.path, t.size, t.mtimeMs, hex, now, now, status);
          stats.new++;
          newHashKeys.set(hex + '|' + t.size, t.path);
          const old = stmt.findMissing.get(job.volume, hex, t.size);   // era um arquivo "sumido" que foi movido?
          if (old) {
            stmt.delFile.run(old.id);
            stmt.evResolveKind.run(now, 'movido para ' + t.path, job.volume, old.path, 'missing');
            stats.moved++;
          }
          if (val) addEvent(t.path, 'estrutura', val.level, `${val.code}: ${val.detail}`);
        } else if (t.kind === 'changed' && !(t.reappeared && t.row.hash)) {
          processedChanged++;
          const status = val && val.level === 'error' ? 'suspect' : 'ok';
          stmt.update.run(t.size, t.mtimeMs, hex, now, status, t.row.id);
          stats.changed++;
          stmt.evResolve.run(now, 'arquivo reescrito/restaurado', job.volume, t.path);
          if (val) addEvent(t.path, 'estrutura', val.level, `${val.code}: ${val.detail}`);
        } else {
          // 'verify' (ou arquivo que reapareceu): compara com o hash guardado
          if (t.kind === 'changed') processedChanged++;
          const row = t.row;
          if (hex === row.hash) {
            const wasBitrot = row.status === 'suspect' && row.suspect_hash;
            const structFlag = row.status === 'suspect' && !row.suspect_hash;          // marcado só por validação de estrutura
            const structOk = !(val && val.level === 'error');
            stmt.touch.run(now, wasBitrot || row.status === 'missing' || (structFlag && structOk) ? 'ok' : row.status, null, row.id);
            if (wasBitrot || row.status === 'missing') stmt.evResolve.run(now, 'conteúdo voltou a bater com o original', job.volume, t.path);
            stmt.evResolveKind.run(now, 'releitura sem erro', job.volume, t.path, 'ilegivel');
            if (doValidate && !val) stmt.evResolveKind.run(now, 'estrutura voltou a validar', job.volume, t.path, 'estrutura');
            else if (val) addEvent(t.path, 'estrutura', val.level, `${val.code}: ${val.detail}`);
          } else if (row.status === 'suspect' && row.suspect_hash === hex) {
            stmt.touch.run(now, 'suspect', hex, row.id);   // já sinalizado antes; segue aberto
          } else {
            stmt.suspect.run(hex, row.id);
            addEvent(t.path, 'bitrot', 'error',
              `conteúdo mudou sem alteração de data/tamanho. Hash original ${row.hash.slice(0, 12)}…, agora ${hex.slice(0, 12)}… ` +
              `(última verificação boa: ${new Date(row.last_hashed || 0).toLocaleDateString('pt-BR')})`);
          }
        }
      } catch (e) {
        if (isDbError(e)) { stats.dbErrors++; return; }      // falha do banco ≠ arquivo ruim; será refeito na próxima execução
        const code = e.code || e.name || 'ERRO';
        // Falha por "não encontrado"/E-S: antes de culpar o arquivo, confere se o DISCO ainda está lá.
        if (['ENOENT', 'ENOTDIR', 'ENXIO', 'ENODEV', 'ENOTCONN', 'EIO', 'EBUSY'].includes(code) && !volumeLost && !(await rootAlive())) volumeLost = true;
        if (volumeLost) return;                                // disco sumiu: não é erro de arquivo; a execução para abaixo
        if (code === 'ENOENT' || code === 'ENOTDIR') { stats.vanished++; return; }   // movido/apagado durante a leitura: será visto na próxima execução
        try {
          if (t.kind === 'new') {
            stmt.insert.run(job.volume, t.path, t.size, t.mtimeMs, null, Date.now(), null, 'suspect');
            processedNew++;
          } else if (t.row) stmt.suspect.run(t.row.suspect_hash || null, t.row.id);
          addEvent(t.path, 'ilegivel', 'error', `erro de leitura (${code}): ${String(e.message).slice(0, 120)}`);
        } catch (e2) { stats.dbErrors++; }
      } finally {
        filesDone++;
        stats.pendingNew = Math.max(0, newF.length - processedNew);
        const n = Date.now();
        if (n - lastEmit > 300) {
          lastEmit = n;
          const el = (n - startedAt) / 1000;
          const rate = el > 0 ? stats.bytes / el : 0;
          emit({ type: 'progress', runId, filesDone, filesTotal: tasks.length, bytesDone, bytesTotal, current,
            rate, etaSec: rate > 0 ? Math.max(0, (bytesTotal - bytesDone) / rate) : null, issues: stats.issues });
        }
      }
    }

    let idx = 0;
    const conc = 2;   // arquivos lidos em paralelo: fixo (em HD externo mecânico, 1–2 é o ideal)
    async function worker() {
      for (;;) {
        if (signal && signal.aborted) return;
        if (volumeLost) return;
        if (deadline && Date.now() > deadline) { stoppedByBudget = true; return; }
        const i = idx++;
        if (i >= tasks.length) return;
        await processTask(tasks[i]);
      }
    }
    emit({ type: 'phase', runId, phase: 'verificando', message: 'Calculando hashes e validando arquivos…' });
    beat();
    await Promise.all(Array.from({ length: conc }, worker));
    const aborted = !!(signal && signal.aborted);

    // 5) Arquivos que sumiram (só se a execução não foi interrompida)
    if (!aborted && !volumeLost) {
      for (const r of dbRows) {
        if (seen.has(r.path) || r.status === 'missing') continue;
        const movedTo = r.hash ? newHashKeys.get(r.hash + '|' + r.size) : null;
        if (movedTo) { stmt.delFile.run(r.id); stats.moved++; continue; }
        stmt.markMissing.run(r.id);
        stats.missing++;
        if (stmt.evOpenErr.get(job.volume, r.path)) {
          // tinha erro aberto e sumiu: o usuário tratou o arquivo (apagou/trocou); fecha o erro e não gera aviso
          stmt.evResolve.run(Date.now(), 'arquivo removido do disco (apagado ou movido)', job.volume, r.path);
          stats.clearedRemoved = (stats.clearedRemoved || 0) + 1;
        } else addEvent(r.path, 'missing', 'warn', 'arquivo não está mais no disco (apagado ou movido?)');
      }
    }

    stats.pendingNew = newF.length - processedNew;
    const pendingAny = stats.pendingNew + (changed.length - processedChanged);
    let status = 'ok', note = null;
    if (volumeLost) { status = 'stopped'; note = 'O disco foi desconectado ou ejetado durante a verificação. Nenhum arquivo foi marcado como erro; o que faltou será lido na próxima execução.'; }
    else if (aborted) { status = 'stopped'; note = 'Interrompido pelo usuário.'; }
    else if (stoppedByBudget || pendingAny > 0) {
      status = 'partial';
      note = `Limite de tempo atingido: ${pendingAny} arquivo(s) novos/alterados ficaram para a próxima execução.`;
    } else if (stats.issues > 0) status = 'issues';
    if (stats.walkErrors) note = (note ? note + ' ' : '') + `${stats.walkErrors} pasta(s)/arquivo(s) não puderam ser listados.`;
    if (stats.vanished) note = (note ? note + ' ' : '') + `${stats.vanished} arquivo(s) foram movidos/apagados durante a leitura (serão revistos).`;
    if (stats.clearedFalseAlarms) note = (note ? note + ' ' : '') + `${stats.clearedFalseAlarms} alarme(s) falso(s) antigo(s) de leitura foram fechados.`;
    if (stats.resumeSkipped) note = (note ? note + ' ' : '') + `Continuação: ${stats.resumeSkipped.toLocaleString('pt-BR')} arquivo(s) já verificados nas execuções interrompidas foram pulados.`;
    if (stats.clearedIgnored) note = (note ? note + ' ' : '') + `${stats.clearedIgnored} alerta(s) de arquivos em pastas ignoradas (ex.: .bzvol do Backblaze) foram fechados.`;
    if (stats.clearedRemoved) note = (note ? note + ' ' : '') + `${stats.clearedRemoved} alerta(s) de arquivo(s) removido(s) do disco foram fechados.`;
    if (stats.modifiedDuring) note = (note ? note + ' ' : '') + `${stats.modifiedDuring} arquivo(s) mudaram durante a leitura (serão revistos).`;
    if (stats.dbErrors) note = (note ? note + ' ' : '') + `${stats.dbErrors} gravação(ões) no banco falharam e serão refeitas na próxima execução.`;
    if (status === 'partial' && stats.issues > 0) note += ` ${stats.issues} problema(s) novo(s).`;
    return finish(status, note);
  };

  try {
    return await body();
  } catch (e) {
    // Qualquer falha inesperada fecha a execução (nunca fica "Em andamento" para sempre).
    return finish('error', 'Erro inesperado: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
  }
}

// Orquestra: abre banco, roda, copia o inventário para a pasta de backup, manda e-mail.
async function executeJob({ job, cfg, emit = () => {}, signal, sendEmail = true }) {
  const db = dbmod.open(configmod.dbPath(cfg));
  let result;
  try {
    result = await runJob({ job, cfg, db, emit, signal });
    result.coverage = dbmod.volumeStats(db, job.volume);
    if (cfg.backupDir && result.status !== 'skipped') {
      try {
        fs.mkdirSync(cfg.backupDir, { recursive: true });
        const dest = path.join(cfg.backupDir, 'hd_checker_inventory.db');
        try { fs.unlinkSync(dest); } catch (e) { /* não existia */ }
        db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
        result.backupFile = dest;
      } catch (e) { result.backupError = e.message; }
    }
  } finally {
    db.close();
  }
  if (sendEmail && job.emailOn !== 'never') {
    const hasProblems = result.newIssues.some((i) => i.severity === 'error') ||
      result.newIssues.some((i) => i.kind === 'missing');
    const should = job.emailOn === 'always' || hasProblems || result.status === 'error';
    if (should && result.status !== 'skipped') {
      try {
        const { sendRunEmail } = require('./mailer');
        await sendRunEmail(cfg, result);
        result.emailSent = true;
      } catch (e) { result.emailError = e.message; }
    }
  }
  return result;
}

module.exports = { runJob, executeJob };
