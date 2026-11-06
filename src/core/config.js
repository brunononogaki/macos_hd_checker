'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appDir } = require('./paths');

const DEFAULT_IGNORE_NAMES = [
  'System Volume Information', '$RECYCLE.BIN', '.Spotlight-V100', '.Trashes',
  '.fseventsd', '.DS_Store', 'Thumbs.db', '.TemporaryItems', '.DocumentRevisions-V100',
  '.bzvol',   // Backblaze grava e apaga arquivos de "ping" aqui o tempo todo
];

const cfgPath = () => path.join(appDir(), 'config.json');

function defaults() {
  return {
    version: 1,
    dbPath: null,        // null => <appDir>/inventory.db
    backupDir: null,     // cópia do inventário após cada execução (pasta coberta pela Backblaze)
    smtp: { host: '', port: 587, secure: false, user: '', from: '', to: '' },
    jobs: [],
  };
}

function load() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    const d = defaults();
    return { ...d, ...c, smtp: { ...d.smtp, ...(c.smtp || {}) }, jobs: c.jobs || [] };
  } catch (e) {
    return defaults();
  }
}

function save(cfg) {
  const tmp = cfgPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, cfgPath());
}

const dbPath = (cfg) => cfg.dbPath || path.join(appDir(), 'inventory.db');

function newJob(volume) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    name: 'Verificação ' + volume,
    volume,
    enabled: false,                                   // true => agendado no launchd
    schedule: { type: 'weekly', weekday: 0, hour: 2, minute: 0 }, // 0 = domingo
    slicePercent: 12.5,                               // % do disco (em bytes) re-verificado por execução
    maxMinutes: 480,                                  // limite de duração (0 = sem limite)
    ignore: [],                                       // padrões extras a ignorar
    validate: true,                                   // validar estrutura de JPEG/RAW/MP4...
    emailOn: 'issues',                                // issues | always | never
  };
}

module.exports = { load, save, defaults, dbPath, newJob, DEFAULT_IGNORE_NAMES };
