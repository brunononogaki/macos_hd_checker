'use strict';
// Agendamento via launchd (LaunchAgent do usuário). Roda mesmo com o app fechado;
// se o Mac estiver dormindo no horário, o launchd executa quando ele acordar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { appDir } = require('./paths');

const label = (job) => `com.hdchecker.job.${job.id}`;
const agentsDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = (job) => path.join(agentsDir(), label(job) + '.plist');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildPlist(job, { execPath, cliPath }) {
  const s = job.schedule || { type: 'weekly', weekday: 0, hour: 2, minute: 0 };
  let cal = `<key>Hour</key><integer>${Number(s.hour) || 0}</integer><key>Minute</key><integer>${Number(s.minute) || 0}</integer>`;
  if (s.type === 'weekly') cal = `<key>Weekday</key><integer>${Number(s.weekday) || 0}</integer>` + cal;
  const logDir = path.join(appDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin' };
  if (process.env.HD_CHECKER_HOME) env.HD_CHECKER_HOME = process.env.HD_CHECKER_HOME;
  const envXml = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  // caffeinate -i: impede o Mac de dormir por inatividade enquanto a verificação roda
  const args = ['/usr/bin/caffeinate', '-i', execPath, cliPath, 'run', '--job', job.id, '--scheduled'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label(job))}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${envXml}</dict>
<key>StartCalendarInterval</key><dict>${cal}</dict>
<key>StandardOutPath</key><string>${xml(path.join(logDir, job.id + '.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logDir, job.id + '.err.log'))}</string>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
</dict></plist>
`;
}

const uid = () => process.getuid();
const launchctl = (...a) => execFileSync('launchctl', a, { stdio: 'pipe' });

function install(job, { execPath, cliPath }) {
  if (process.platform !== 'darwin') throw new Error('Agendamento via launchd só funciona no macOS.');
  fs.mkdirSync(agentsDir(), { recursive: true });
  const p = plistPath(job);
  try { launchctl('bootout', `gui/${uid()}`, p); } catch (e) { /* não estava carregado */ }
  fs.writeFileSync(p, buildPlist(job, { execPath, cliPath }));
  launchctl('bootstrap', `gui/${uid()}`, p);
  return p;
}

function uninstall(job) {
  if (process.platform !== 'darwin') return;
  const p = plistPath(job);
  try { launchctl('bootout', `gui/${uid()}`, p); } catch (e) { /* ok */ }
  try { fs.unlinkSync(p); } catch (e) { /* ok */ }
}

function isInstalled(job) {
  return fs.existsSync(plistPath(job));
}

module.exports = { install, uninstall, isInstalled, buildPlist, plistPath, label };
