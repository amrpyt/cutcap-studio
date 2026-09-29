'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');
const { isCutSpeed } = require('./shared');

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.AE_GUI_PORT) || 37906));
const APP_ID = 'auto-editor-gui';
const APP_VERSION = '6';
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.html');
const SHARED = path.join(ROOT, 'shared.js');
const APP_JS = path.join(ROOT, 'app.js');
const PID_FILE = path.join(ROOT, '.server.pid');
const INSTANCE_FILE = path.join(ROOT, '.server.json');
const WATERMARK_SETTINGS_FILE = path.join(ROOT, '.watermark.json');

let autoEditorPath = findAutoEditor();
let autoEditorVersion = '';
let activePickerProcess = null;
const mediaFiles = new Map();
const previewFiles = new Map();
const jobs = new Map();
const jobResults = new Map();
const activeOutputPaths = new Set();
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const JOB_RESULT_TTL_MS = 2 * 60 * 60 * 1000;
const SERVER_ERROR_LOG = path.join(ROOT, 'server-error.log');

function recordServerError(kind, error) {
  const detail = error && error.stack ? error.stack : String(error || 'Unknown server error');
  try { fs.appendFileSync(SERVER_ERROR_LOG, `[${new Date().toISOString()}] ${kind}: ${detail}\n`); } catch {}
}

function findAutoEditor() {
  const names = ['auto-editor-windows-x86_64.exe', 'auto-editor.exe'];
  const dirs = [ROOT, path.join(os.homedir(), 'Downloads')];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = String(text ?? '');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON request')); }
    });
    req.on('error', reject);
  });
}

function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('File picker is available on Windows only.'));
    if (activePickerProcess && activePickerProcess.exitCode == null) {
      return reject(new Error('نافذة اختيار الملفات مفتوحة بالفعل. دور عليها قدام المتصفح أو اقفلها وحاول تاني.'));
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (activePickerProcess === child) activePickerProcess = null;
        if (err) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || err.message);
          return reject(new Error(detail.trim() || 'PowerShell picker failed.'));
        }
        resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''));
      });
    activePickerProcess = child;
  });
}

async function nativePick(kind, initialValue = '') {
  const resultFile = path.join(os.tmpdir(), `ae-gui-picker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const resultQ = psQuote(resultFile);
  let script = `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Windows.Forms\n$result=''\n$owner=New-Object System.Windows.Forms.Form\n$owner.Text='Auto-Editor GUI'\n$owner.TopMost=$true\n$owner.ShowInTaskbar=$false\n$owner.StartPosition='Manual'\n$owner.Location=New-Object System.Drawing.Point -ArgumentList -32000,-32000\n$owner.Size=New-Object System.Drawing.Size -ArgumentList 1,1\n$owner.Opacity=0\n$owner.Show()\n[System.Windows.Forms.Application]::DoEvents()\n`;
  if (kind === 'video') {
    const dir = initialValue && fs.existsSync(initialValue) ? (fs.statSync(initialValue).isDirectory() ? initialValue : path.dirname(initialValue)) : path.join(os.homedir(), 'Downloads');
    script += `$d=New-Object System.Windows.Forms.OpenFileDialog\n$d.Title='Choose video'\n$d.Filter='Video files|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.mts;*.m2ts|All files|*.*'\n$d.Multiselect=$false\n$d.CheckFileExists=$true\n$d.RestoreDirectory=$true\n$d.InitialDirectory=${psQuote(dir)}\nif($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$result=$d.FileName}\n`;
  } else if (kind === 'exe') {
    const dir = initialValue && fs.existsSync(initialValue) ? (fs.statSync(initialValue).isDirectory() ? initialValue : path.dirname(initialValue)) : path.join(os.homedir(), 'Downloads');
    script += `$d=New-Object System.Windows.Forms.OpenFileDialog\n$d.Title='Choose Auto-Editor executable'\n$d.Filter='Auto-Editor executable|*.exe|All files|*.*'\n$d.Multiselect=$false\n$d.CheckFileExists=$true\n$d.RestoreDirectory=$true\n$d.InitialDirectory=${psQuote(dir)}\nif($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$result=$d.FileName}\n`;
  } else if (kind === 'image') {
    const dir = initialValue && fs.existsSync(initialValue) ? path.dirname(initialValue) : path.join(os.homedir(), 'Downloads');
    script += `$d=New-Object System.Windows.Forms.OpenFileDialog\n$d.Title='Choose watermark logo'\n$d.Filter='Images and GIF|*.png;*.jpg;*.jpeg;*.webp;*.gif|All files|*.*'\n$d.Multiselect=$false\n$d.CheckFileExists=$true\n$d.RestoreDirectory=$true\n$d.InitialDirectory=${psQuote(dir)}\nif($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$result=$d.FileName}\n`;
  } else if (kind === 'folder') {
    const dir = initialValue && fs.existsSync(initialValue) && fs.statSync(initialValue).isDirectory()
      ? initialValue : path.join(os.homedir(), 'Downloads');
    script += `$d=New-Object System.Windows.Forms.FolderBrowserDialog\n$d.Description='Choose download folder'\n$d.SelectedPath=${psQuote(dir)}\n$d.ShowNewFolderButton=$true\nif($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$result=$d.SelectedPath}\n`;
  } else if (kind === 'output') {
    const suggested = initialValue || path.join(os.homedir(), 'Downloads', 'CUT.mp4');
    script += `$d=New-Object System.Windows.Forms.SaveFileDialog\n$d.Title='Save edited video'\n$d.Filter='MP4 video|*.mp4|MOV video|*.mov|All files|*.*'\n$d.InitialDirectory=${psQuote(path.dirname(suggested))}\n$d.FileName=${psQuote(path.basename(suggested))}\n$d.OverwritePrompt=$true\n$d.RestoreDirectory=$true\nif($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$result=$d.FileName}\n`;
  } else throw new Error('Unknown picker type.');
  script += `$d.Dispose()\n$owner.Close()\n$owner.Dispose()\n[System.IO.File]::WriteAllText(${resultQ},$result,(New-Object System.Text.UTF8Encoding($false)))\n`;
  try {
    await runPowerShell(script);
    if (!fs.existsSync(resultFile)) return '';
    return fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
  } finally { try { fs.unlinkSync(resultFile); } catch {} }
}

function normalizeJobId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(id) ? id : '';
}

function registerJob(jobId, child, label = '') {
  const id = normalizeJobId(jobId);
  if (!id) return null;
  const pending = jobs.get(id);
  const record = { id, child, label, startedAt: pending?.startedAt || Date.now(), running: true, cancelled: !!pending?.cancelled, progress: null, details: {} };
  jobs.set(id, record);
  return record;
}

function updateJobProgress(record, value) {
  if (!record || !Number.isFinite(Number(value))) return;
  record.progress = Math.max(0, Math.min(99, Number(value)));
}

function updateProgressFromText(record, text) {
  if (!record) return;
  const matches = [...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  if (matches.length) updateJobProgress(record, Number(matches[matches.length - 1][1]));
}

function finishJob(record, ok = false) {
  if (!record) return;
  if (record.networkTimer) {
    clearInterval(record.networkTimer);
    record.networkTimer = null;
  }
  record.running = false;
  record.finishedAt = Date.now();
  if (ok && !record.cancelled) record.progress = 100;
  const timer = setTimeout(() => { if (jobs.get(record.id) === record) jobs.delete(record.id); }, 15000);
  timer.unref?.();
}

function storeJobResult(jobId, result, error = '') {
  const id = normalizeJobId(jobId);
  if (!id) return;
  jobResults.set(id, { finishedAt: Date.now(), ok: !error, result: error ? null : result, error: error || '' });
}

function cleanupJobResults(now = Date.now()) {
  for (const [id, record] of jobResults) {
    if (now - record.finishedAt > JOB_RESULT_TTL_MS) jobResults.delete(id);
  }
}

function terminateProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function cancelJob(jobId) {
  const id = normalizeJobId(jobId);
  if (!id) return false;
  const record = jobs.get(id);
  if (!record) {
    jobs.set(id, { id, child: null, label: '', startedAt: Date.now(), running: false, cancelled: true, progress: null });
    return true;
  }
  if (record.cancelled) return true;
  record.cancelled = true;
  if (record.running) terminateProcessTree(record.child);
  return true;
}

function runProcess(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: options.cwd || ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = registerJob(options.jobId, child, options.label);
    let settled = false;
    const stdoutChunks = [], stderrChunks = [];
    let stdoutSize = 0, stderrSize = 0;
    const max = options.maxOutput || 12 * 1024 * 1024;
    const collect = (chunks, kind, chunk) => {
      const b = Buffer.from(chunk);
      chunks.push(b);
      if (kind === 'stdout') stdoutSize += b.length; else stderrSize += b.length;
      while ((kind === 'stdout' ? stdoutSize : stderrSize) > max && chunks.length > 1) {
        const removed = chunks.shift().length;
        if (kind === 'stdout') stdoutSize -= removed; else stderrSize -= removed;
      }
      updateProgressFromText(record, b.toString('utf8'));
    };
    child.stdout.on('data', chunk => collect(stdoutChunks, 'stdout', chunk));
    child.stderr.on('data', chunk => collect(stderrChunks, 'stderr', chunk));
    child.once('error', err => {
      if (settled) return;
      settled = true;
      finishJob(record, false);
      reject(err);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      const exitCode = Number(code ?? 1);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      const cancelled = !!record?.cancelled;
      finishJob(record, exitCode === 0);
      resolve({ code: exitCode, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n').trim(), cancelled });
    });
    if (record?.cancelled) terminateProcessTree(child);
  });
}

async function validateAutoEditor(candidate = autoEditorPath) {
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return { ok: false, version: '', error: 'Auto-Editor executable not found.' };
  try {
    const result = await runProcess(candidate, ['--version'], { cwd: path.dirname(candidate) });
    if (result.code !== 0) return { ok: false, version: '', error: result.output || 'Auto-Editor did not start.' };
    return { ok: true, version: ((result.stdout || result.output).split(/\r?\n/).find(Boolean) || 'Auto-Editor').trim(), error: '' };
  } catch (err) { return { ok: false, version: '', error: err.message || String(err) }; }
}

async function runAutoEditor(args, cwd, jobId = '', label = '') {
  const validation = await validateAutoEditor();
  if (!validation.ok) throw new Error(validation.error);
  autoEditorVersion = validation.version;
  const result = await runProcess(autoEditorPath, args, { cwd, jobId, label });
  if (result.cancelled) throw new Error('تم إلغاء العملية.');
  return result;
}

function safeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function buildEditArgs(body, sourcePath) {
  const threshold = safeNumber(body.threshold, 4, 0.01, 100);
  const marginBefore = safeNumber(body.marginBefore, 0.20, 0, 30);
  const marginAfter = safeNumber(body.marginAfter, 0.40, 0, 30);
  const smoothCut = safeNumber(body.smoothCut, 0.35, 0, 30);
  const smoothClip = safeNumber(body.smoothClip, 0.10, 0, 30);
  const args = [
    sourcePath,
    '--edit', `audio:threshold=${threshold}%`,
    '--margin', `${marginBefore}s,${marginAfter}s`,
    '--smooth', `${smoothCut}s,${smoothClip}s`,
  ];
  if (['render', 'clips', 'proxy', 'capcut'].includes(body.mode)) {
    const rawRanges = Array.isArray(body.keepRanges) ? body.keepRanges.slice(0, 3000) : [];
    const keepArgs = [];
    for (const item of rawRanges) {
      const start = Number(item && item.start);
      const end = Number(item && item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      keepArgs.push(`${start.toFixed(6)}sec,${end.toFixed(6)}sec`);
    }
    if (keepArgs.length) args.push('--keep', ...keepArgs);
  }
  return args;
}

function buildCapCutOtio({ sourcePath, fps, sourceDuration, chunks, name }) {
  const rate = Number(fps);
  const lastChunkFrame = Array.isArray(chunks) ? chunks.reduce((max, chunk) => {
    const end = Number(chunk?.[1]);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0) : 0;
  const fullFrames = Math.max(1, Math.round(Number(sourceDuration) * rate), lastChunkFrame);
  if (!(rate > 0) || !(fullFrames > 0) || !Array.isArray(chunks)) throw new Error('Invalid Auto-Editor timeline for CapCut.');
  const rt = value => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
  const range = (start, duration) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(duration) });
  const clips = [];
  const mediaName = path.basename(sourcePath);
  for (const chunk of chunks) {
    if (!Array.isArray(chunk) || chunk.length < 3 || isCutSpeed(chunk[2])) continue;
    const startFrame = Number(chunk[0]), endFrame = Number(chunk[1]), speed = Number(chunk[2]) || 1;
    if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame || !(speed > 0)) continue;
    const effects = Math.abs(speed - 1) > 1e-9 ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', name: 'Speed', time_scalar: speed, metadata: {} }] : [];
    clips.push({
      OTIO_SCHEMA: 'Clip.1',
      name: mediaName,
      source_range: range(startFrame, endFrame - startFrame),
      effects,
      markers: [],
      metadata: {},
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        name: mediaName,
        target_url: sourcePath,
        available_range: range(0, fullFrames),
        metadata: {},
      },
    });
  }
  if (!clips.length) throw new Error('كل الفيديو اتحذف بالإعدادات الحالية. مفيش مقاطع نعمل منها مشروع CapCut.');
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: `${String(name || 'Video').trim() || 'Video'} - Auto Cut`,
    global_start_time: rt(0),
    metadata: { auto_editor: { source: sourcePath } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      children: [{
        OTIO_SCHEMA: 'Track.1',
        name: 'Auto Cut',
        kind: 'Video',
        source_range: null,
        effects: [],
        markers: [],
        metadata: {},
        children: clips,
      }],
    },
  };
}

function findCapCutCliJs() {
  const candidates = [
    process.env.CAPCUT_CLI_JS,
    path.join(ROOT, 'node_modules', 'capcut-cli', 'dist', 'index.js'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'capcut-cli', 'dist', 'index.js'),
  ].filter(Boolean);
  return candidates.find(file => {
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch { return false; }
  }) || '';
}

function findCapCutDraftsDir() {
  const candidates = [
    process.env.CAPCUT_DRAFTS_DIR,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'),
  ].filter(Boolean);
  return candidates.find(dir => {
    try { return fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch { return false; }
  }) || '';
}

function safeProjectName(value) {
  const clean = String(value || 'Video').replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  return (clean || 'Video').slice(0, 80);
}

function uniqueDraftPath(root, baseName) {
  const base = safeProjectName(baseName);
  let candidate = path.join(root, base);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(root, `${base} (${n})`);
  return candidate;
}

function compareVersions(a, b) {
  const left = String(a || '').split('.').map(n => Number(n) || 0);
  const right = String(b || '').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function findCapCutSeedProject(draftsDir) {
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(draftsDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(draftsDir, entry.name);
    for (const fileName of ['draft_info.json', 'draft_content.json']) {
      const file = path.join(projectDir, fileName);
      try {
        if (!fs.existsSync(file)) continue;
        const draft = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const source = String(draft?.platform?.app_source || '');
        const appVersion = String(draft?.platform?.app_version || '');
        if (source !== 'cc' || !appVersion) continue;
        const mtimeMs = fs.statSync(file).mtimeMs;
        const appAuthored = (typeof draft.version === 'number' && draft.version > 0) ||
          (typeof draft.new_version === 'string' && draft.new_version !== '') ||
          (draft.last_modified_platform !== undefined && draft.last_modified_platform !== null);
        const candidate = { projectDir, file, draft, appVersion, mtimeMs, appAuthored };
        if (!best ||
            (candidate.appAuthored && !best.appAuthored) ||
            (candidate.appAuthored === best.appAuthored && compareVersions(candidate.appVersion, best.appVersion) > 0) ||
            (candidate.appAuthored === best.appAuthored && compareVersions(candidate.appVersion, best.appVersion) === 0 && candidate.mtimeMs > best.mtimeMs)) best = candidate;
        break;
      } catch {}
    }
  }
  return best;
}

function reducedRatio(width, height, fallback = 'original') {
  let a = Math.round(Number(width)), b = Math.round(Number(height));
  if (!(a > 0) || !(b > 0)) return fallback;
  let x = a, y = b;
  while (y) { const t = x % y; x = y; y = t; }
  return `${a / x}:${b / x}`;
}

async function createCapCutTemplate(draftsDir, media = {}) {
  const seed = findCapCutSeedProject(draftsDir);
  if (!seed) throw new Error('مش لاقي مشروع CapCut حقيقي صالح نستخدمه كقالب. افتح CapCut واعمل مشروع فاضي مرة واحدة.');
  const cli = findCapCutCliJs();
  if (!cli) throw new Error('CapCut CLI مش متثبت. ثبّت capcut-cli@0.26.0 ثم جرّب تاني.');
  const factoryPath = path.join(path.dirname(cli), 'factory.js');
  const { seedDraftSkeleton } = await import(pathToFileURL(factoryPath).href);
  const donorCanvas = seed.draft?.canvas_config || { width: 1920, height: 1080, ratio: '16:9' };
  const width = Number(media.width) > 0 ? Number(media.width) : donorCanvas.width;
  const height = Number(media.height) > 0 ? Number(media.height) : donorCanvas.height;
  const canvas = { width, height, ratio: reducedRatio(width, height, donorCanvas.ratio || 'original') };
  const fps = Number(media.fps) > 0 ? Number(media.fps) : (Number(seed.draft?.fps) > 0 ? Number(seed.draft.fps) : 30);
  const { draft } = seedDraftSkeleton(seed.draft, {
    name: 'Auto Cut Template',
    id: crypto.randomUUID(),
    canvas,
    fps,
    nowMs: Date.now(),
    materialKeys: Object.keys(seed.draft?.materials || {}),
  });
  const dir = path.join(os.tmpdir(), `ae-capcut-template-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(draft);
  fs.writeFileSync(path.join(dir, 'draft_content.json'), content, 'utf8');
  fs.writeFileSync(path.join(dir, 'draft_info.json'), content, 'utf8');
  const donorTmp = path.join(seed.projectDir, 'template-2.tmp');
  try {
    JSON.parse(fs.readFileSync(donorTmp, 'utf8').replace(/^\uFEFF/, ''));
    fs.writeFileSync(path.join(dir, 'template-2.tmp'), content, 'utf8');
  } catch {}
  return { dir, seed };
}

function buildCapCutImportArgs(otioPath, draftPath, templateDir) {
  return ['import-timeline', otioPath, '--out', draftPath, '--template', templateDir];
}

async function runCapCutCli(args, jobId = '', label = 'CapCut') {
  const cli = findCapCutCliJs();
  if (!cli) throw new Error('CapCut CLI مش متثبت. ثبّت capcut-cli@0.26.0 ثم جرّب تاني.');
  const result = await runProcess(process.execPath, [cli, ...args], { cwd: ROOT, jobId, label });
  if (result.cancelled) throw new Error('تم إلغاء العملية.');
  return result;
}

async function capCutEditorProcesses() {
  const cli = findCapCutCliJs();
  if (!cli) return [];
  const storePath = path.join(path.dirname(cli), 'store.js');
  try {
    const { editorProcesses } = await import(pathToFileURL(storePath).href);
    return editorProcesses();
  } catch { return []; }
}

async function ensureCapCutClosed() {
  const running = await capCutEditorProcesses();
  if (running.length) {
    const err = new Error(`اقفل CapCut الأول ثم شغّل الأمر تاني. البرنامج المفتوح: ${running.join(' / ')}`);
    err.statusCode = 409;
    throw err;
  }
}

async function exportCapCutProject({
  sourcePath,
  threshold,
  marginBefore = 0,
  marginAfter = 0,
  smoothCut = 0.35,
  smoothClip = 0.10,
  keepRanges = [],
  jobId = '',
} = {}) {
  const source = requireFile(sourcePath);
  const draftsDir = findCapCutDraftsDir();
  if (!draftsDir) throw new Error('مش لاقي مجلد مشاريع CapCut. افتح CapCut مرة واحدة واعمل مشروع، وبعدها اقفله وجرّب تاني.');
  if (!findCapCutCliJs()) throw new Error('CapCut CLI مش متثبت. ثبّت capcut-cli@0.26.0 ثم جرّب تاني.');
  await ensureCapCutClosed();

  const cwd = path.dirname(source);
  const args = buildEditArgs({ mode: 'capcut', threshold, marginBefore, marginAfter, smoothCut, smoothClip, keepRanges }, source);
  const timelineTemp = path.join(os.tmpdir(), `ae-capcut-${process.pid}-${crypto.randomUUID()}.v1`);
  const otioTemp = path.join(os.tmpdir(), `ae-capcut-${process.pid}-${crypto.randomUUID()}.otio`);
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-capcut-stage-'));
  let templateTemp = '';
  let publishTemp = '';
  let publishedDraft = '';
  let registrationStarted = false;
  let completed = false;
  try {
    args.push('--export', 'v1', '-o', timelineTemp);
    const analysis = await runAutoEditor(args, cwd, jobId, 'تحليل القص لمشروع CapCut');
    if (analysis.code !== 0 || !fs.existsSync(timelineTemp)) throw new Error(analysis.output || 'Timeline creation failed.');
    const timeline = JSON.parse(fs.readFileSync(timelineTemp, 'utf8').replace(/^\uFEFF/, ''));
    const fps = parseTimebase(timeline.timebase);
    const info = await getMediaInfo(source);
    const resolution = Array.isArray(info.raw?.video?.[0]?.resolution) ? info.raw.video[0].resolution.map(Number) : [];
    const baseName = safeProjectName(path.basename(source, path.extname(source)));
    const projectName = `${baseName} - Auto Cut`;
    const otio = buildCapCutOtio({ sourcePath: source, fps, sourceDuration: info.duration, chunks: timeline.chunks || [], name: baseName });
    fs.writeFileSync(otioTemp, JSON.stringify(otio, null, 2), 'utf8');

    const template = await createCapCutTemplate(draftsDir, { width: resolution[0], height: resolution[1], fps });
    templateTemp = template.dir;
    const stagedDraft = path.join(stagingRoot, projectName);
    const imported = await runCapCutCli(buildCapCutImportArgs(otioTemp, stagedDraft, templateTemp), jobId, 'إنشاء تايم لاين CapCut');
    if (imported.code !== 0 || !fs.existsSync(stagedDraft)) throw new Error(imported.output || 'CapCut project creation failed.');

    const lint = await runCapCutCli(['lint', stagedDraft, '--frame-grid'], jobId, 'فحص تايم لاين CapCut');
    if (lint.code >= 2) throw new Error(lint.output || 'فحص مشروع CapCut وجد خطأ يمنع النشر.');

    // Nothing touches CapCut's real draft store until the project is complete and linted.
    await ensureCapCutClosed();
    const draftPath = uniqueDraftPath(draftsDir, projectName);
    publishTemp = path.join(draftsDir, `.ae-stage-${crypto.randomUUID()}`);
    fs.cpSync(stagedDraft, publishTemp, { recursive: true, errorOnExist: true });
    fs.renameSync(publishTemp, draftPath);
    publishTemp = '';
    publishedDraft = draftPath;

    const relinked = await runCapCutCli(['relink', draftPath, '--from', stagedDraft, '--to', draftPath], jobId, 'تثبيت مسارات وسائط CapCut');
    if (relinked.code !== 0) throw new Error(relinked.output || 'تعذر تثبيت مسارات وسائط مشروع CapCut.');
    const publishedLint = await runCapCutCli(['lint', draftPath, '--frame-grid'], jobId, 'فحص النسخة النهائية من تايم لاين CapCut');
    if (publishedLint.code >= 2) throw new Error(publishedLint.output || 'النسخة النهائية من مشروع CapCut فيها خطأ يمنع التسجيل.');

    // Registration is the only shared-store mutation. The CLI itself repeats the editor-open guard.
    const plan = await runCapCutCli(['register', draftPath, '--materials', '--drafts', draftsDir], jobId, 'فحص تسجيل مشروع CapCut');
    if (plan.code !== 0) throw new Error(plan.output || 'تعذر فحص تسجيل مشروع CapCut.');
    await ensureCapCutClosed();
    registrationStarted = true;
    const registered = await runCapCutCli(['register', draftPath, '--materials', '--drafts', draftsDir, '--apply'], jobId, 'تسجيل مشروع CapCut');
    if (registered.code !== 0) {
      throw new Error(`المشروع اتعمل لكن تسجيله في قائمة CapCut محتاج إصلاح يدوي.\n${registered.output || ''}`.trim());
    }

    const linked = await runCapCutCli(['lint', draftPath, '--fix', '--frame-grid'], jobId, 'تثبيت ربط الوسائط داخل CapCut');
    if (linked.code >= 2) throw new Error(linked.output || 'تعذر إصلاح ربط وسائط مشروع CapCut.');
    const finalLint = await runCapCutCli(['lint', draftPath, '--frame-grid'], jobId, 'الفحص النهائي لمشروع CapCut');
    if (finalLint.code >= 2) throw new Error(finalLint.output || 'الفحص النهائي لمشروع CapCut وجد خطأ.');

    completed = true;
    return {
      code: 0,
      output: registered.output || imported.output,
      draftPath,
      projectName: path.basename(draftPath),
      clips: otio.tracks.children[0].children.length,
      seedVersion: template.seed.appVersion,
      threshold: Number(threshold),
      lintOk: finalLint.code === 0,
      lintOutput: finalLint.output,
    };
  } finally {
    try { if (fs.existsSync(timelineTemp)) fs.unlinkSync(timelineTemp); } catch {}
    try { if (fs.existsSync(otioTemp)) fs.unlinkSync(otioTemp); } catch {}
    try { if (templateTemp && fs.existsSync(templateTemp)) fs.rmSync(templateTemp, { recursive: true, force: true }); } catch {}
    try { if (publishTemp && fs.existsSync(publishTemp)) fs.rmSync(publishTemp, { recursive: true, force: true }); } catch {}
    try { if (publishedDraft && !completed && !registrationStarted && fs.existsSync(publishedDraft)) fs.rmSync(publishedDraft, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
  }
}

function requireFile(value, message = 'اختار فيديو الأول.') {
  const candidate = String(value || '').trim().replace(/^"|"$/g, '');
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(message);
  return path.resolve(candidate);
}

function registerMedia(file) {
  const token = crypto.randomUUID();
  mediaFiles.set(token, file);
  return token;
}

function registerPreview(file, now = Date.now()) {
  const token = crypto.randomUUID();
  previewFiles.set(token, { file, lastAccess: now });
  return token;
}

function getPreviewFile(token, now = Date.now()) {
  const record = previewFiles.get(String(token || ''));
  if (!record) return '';
  record.lastAccess = now;
  return record.file;
}

function releasePreview(token) {
  const id = String(token || '');
  const record = previewFiles.get(id);
  if (!record) return false;
  previewFiles.delete(id);
  try { if (fs.existsSync(record.file)) fs.unlinkSync(record.file); } catch {}
  return true;
}

function cleanupExpiredPreviews(now = Date.now()) {
  for (const [token, record] of previewFiles) {
    if (now - record.lastAccess > PREVIEW_TTL_MS) releasePreview(token);
  }
}

const previewCleanupTimer = setInterval(cleanupExpiredPreviews, 60 * 1000);
previewCleanupTimer.unref?.();
const jobResultCleanupTimer = setInterval(cleanupJobResults, 60 * 1000);
jobResultCleanupTimer.unref?.();

function defaultOutput(input) {
  if (!input) return '';
  const ext = path.extname(input);
  const base = input.slice(0, input.length - ext.length);
  return `${base}_CUT.mp4`;
}

function outputKey(file) {
  const resolved = path.resolve(String(file || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function acquireOutputLock(file) {
  const key = outputKey(file);
  if (activeOutputPaths.has(key)) {
    const err = new Error('هذا الملف يتم إنشاؤه بالفعل من نافذة أخرى. اختار اسمًا مختلفًا أو انتظر انتهاء التصدير.');
    err.statusCode = 409;
    throw err;
  }
  activeOutputPaths.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeOutputPaths.delete(key);
  };
}


const DEFAULT_WATERMARK_TRANSFORM = Object.freeze({ x: .02, y: .03, scale: 12, opacity: 100 });
function clampWatermarkNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function normalizeWatermarkTransform(value = {}) {
  return {
    x: clampWatermarkNumber(value.x, 0, 1, DEFAULT_WATERMARK_TRANSFORM.x),
    y: clampWatermarkNumber(value.y, 0, 1, DEFAULT_WATERMARK_TRANSFORM.y),
    scale: clampWatermarkNumber(value.scale, 2, 40, DEFAULT_WATERMARK_TRANSFORM.scale),
    opacity: clampWatermarkNumber(value.opacity, 10, 100, DEFAULT_WATERMARK_TRANSFORM.opacity),
  };
}
function loadWatermarkSettings() {
  try {
    if (!fs.existsSync(WATERMARK_SETTINGS_FILE)) return null;
    const saved = JSON.parse(fs.readFileSync(WATERMARK_SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const file = String(saved?.path || '').trim();
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { path: path.resolve(file), transform: normalizeWatermarkTransform(saved.transform) };
  } catch { return null; }
}
function saveWatermarkSettings(settings) {
  fs.writeFileSync(WATERMARK_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}
let watermarkSettings = loadWatermarkSettings();
function findFfmpeg() {
  const direct = [process.env.FFMPEG_PATH, path.join(ROOT, 'ffmpeg.exe'), path.join(process.env.LOCALAPPDATA || '', 'CutCap', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')].filter(Boolean);
  for (const c of direct) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {} }
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(winget, { withFileTypes: true })) {
      if (!pkg.isDirectory() || !/ffmpeg/i.test(pkg.name)) continue;
      const pkgDir = path.join(winget, pkg.name);
      for (const child of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const exe = path.join(pkgDir, child.name, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}
  return 'ffmpeg';
}
const ffmpegPath = findFfmpeg();

function findYtDlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(ROOT, 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'CutCap', 'yt-dlp.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return 'yt-dlp';
}
const ytDlpPath = findYtDlp();

async function validateYtDlp() {
  try {
    const result = await runProcess(ytDlpPath, ['--version'], { cwd: ROOT, maxOutput: 128 * 1024 });
    if (result.code !== 0) return { ok: false, version: '', error: result.output || 'yt-dlp did not start.' };
    return { ok: true, version: ((result.stdout || result.output).split(/\r?\n/).find(Boolean) || '').trim(), error: '' };
  } catch (error) {
    return { ok: false, version: '', error: error?.message || String(error) };
  }
}

function normalizeYoutubeUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('ضع رابط YouTube أولًا.');
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error('رابط YouTube غير صالح.'); }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const allowed = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com']);
  if (!allowed.has(host)) throw new Error('هذه الأداة مخصصة لروابط YouTube فقط.');
  return parsed.toString();
}

function parseTimeValue(value, label = 'الوقت') {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} مطلوب.`);
  const parts = text.split(':');
  if (parts.length > 3 || parts.some(part => part === '' || !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`${label} يجب أن يكون مثل 26:15 أو 01:02:03.`);
  }
  const values = parts.map(Number);
  if (parts.length >= 2 && values.at(-1) >= 60) throw new Error(`${label}: الثواني يجب أن تكون أقل من 60.`);
  if (parts.length === 3 && values[1] >= 60) throw new Error(`${label}: الدقائق يجب أن تكون أقل من 60.`);
  const seconds = parts.length === 1 ? values[0]
    : parts.length === 2 ? values[0] * 60 + values[1]
      : values[0] * 3600 + values[1] * 60 + values[2];
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${label} غير صالح.`);
  return seconds;
}

function youtubeFormatSelector(quality) {
  const q = String(quality || '720').toLowerCase();
  const allowed = new Set(['240', '360', '480', '720', '1080', '1440', '2160', 'best']);
  if (!allowed.has(q)) throw new Error('الجودة غير مدعومة.');
  if (q === 'best') return 'bv*+ba/b';
  return `bv*[height<=${q}]+ba/b[height<=${q}]/b`;
}

function unitBytes(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const powers = { B: 0, kB: 1, KB: 1, KiB: 1, MB: 2, MiB: 2, GB: 3, GiB: 3 };
  const power = powers[unit] ?? 0;
  const base = /iB$/.test(unit) ? 1024 : 1000;
  return n * (base ** power);
}

function clockSeconds(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function readNetworkTotals() {
  return new Promise(resolve => {
    execFile('netstat.exe', ['-e'], { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = String(stdout || '').match(/Bytes\s+([\d,]+)\s+([\d,]+)/i);
      if (!match) return resolve(null);
      resolve({
        rx: Number(match[1].replace(/,/g, '')),
        tx: Number(match[2].replace(/,/g, '')),
      });
    });
  });
}

async function attachNetworkMeter(record) {
  if (!record || process.platform !== 'win32') return;
  const baseline = await readNetworkTotals();
  if (!baseline || !record.running) return;
  record.networkBaseline = baseline;
  record.details.networkRxBytes = 0;
  record.details.networkScope = 'device';
  const tick = async () => {
    const now = await readNetworkTotals();
    if (!now || !record.running || !record.networkBaseline) return;
    record.details.networkRxBytes = Math.max(0, now.rx - record.networkBaseline.rx);
    record.details.networkTxBytes = Math.max(0, now.tx - record.networkBaseline.tx);
  };
  record.networkTimer = setInterval(tick, 1000);
  record.networkTimer.unref?.();
}

async function refreshNetworkMeter(record) {
  if (!record?.networkBaseline) return;
  const now = await readNetworkTotals();
  if (!now) return;
  record.details.networkRxBytes = Math.max(0, now.rx - record.networkBaseline.rx);
  record.details.networkTxBytes = Math.max(0, now.tx - record.networkBaseline.tx);
}

function updateYoutubeProgress(record, rawText) {
  if (!record) return;
  const text = String(rawText || '').replace(/\r/g, '\n');
  if (!text) return;
  if (/Downloading webpage|player API JSON|m3u8 information|Extracting URL/i.test(text)) record.details.phase = 'preparing';
  if (/Downloading \d+ time ranges?|Destination:|Output #0/i.test(text)) record.details.phase = 'downloading';
  if (/\[Merger\]|Merging formats|Fixing MPEG-TS/i.test(text)) record.details.phase = 'merging';

  const timeMatches = [...text.matchAll(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
  if (timeMatches.length) {
    const processed = clockSeconds(timeMatches.at(-1)[1]);
    if (processed != null) {
      record.details.processedSeconds = processed;
      const total = Number(record.details.clipDurationSec);
      if (total > 0) updateJobProgress(record, Math.min(99, processed / total * 100));
    }
  }

  const sizeMatches = [...text.matchAll(/size=\s*([\d.]+)\s*(kB|KB|KiB|MB|MiB|GB|GiB)/g)];
  if (sizeMatches.length) {
    const [, value, unit] = sizeMatches.at(-1);
    const bytes = unitBytes(value, unit);
    if (bytes != null) record.details.outputBytes = bytes;
  }

  const speedMatches = [...text.matchAll(/speed=\s*([\d.]+)x/g)];
  if (speedMatches.length) {
    const speed = Number(speedMatches.at(-1)[1]);
    if (Number.isFinite(speed)) {
      record.details.processSpeed = speed;
      const total = Number(record.details.clipDurationSec);
      const processed = Number(record.details.processedSeconds || 0);
      if (total > processed && speed > 0) record.details.etaSeconds = (total - processed) / speed;
    }
  }

  const pctMatches = [...text.matchAll(/\[download\]\s+([\d.]+)%/g)];
  if (pctMatches.length && !(Number(record.details.clipDurationSec) > 0)) {
    updateJobProgress(record, Number(pctMatches.at(-1)[1]));
  }

  const totalMatches = [...text.matchAll(/\bof\s+(?:~\s*)?([\d.]+)\s*(kB|KB|KiB|MB|MiB|GB|GiB)/g)];
  if (totalMatches.length) {
    const [, value, unit] = totalMatches.at(-1);
    const bytes = unitBytes(value, unit);
    if (bytes != null) record.details.reportedDownloadBytes = bytes;
  }

  const dlSpeedMatches = [...text.matchAll(/\bat\s+([\d.]+)\s*(kB|KB|KiB|MB|MiB|GB|GiB)\/s/g)];
  if (dlSpeedMatches.length) {
    const [, value, unit] = dlSpeedMatches.at(-1);
    const bytes = unitBytes(value, unit);
    if (bytes != null) record.details.downloadBytesPerSecond = bytes;
  }

  const fileMatches = [...text.matchAll(/__CUTCAP_FILE__(.+?)(?:\n|$)/g)];
  if (fileMatches.length) record.details.outputPath = fileMatches.at(-1)[1].trim();

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length) {
    const last = lines.at(-1).replace(/https?:\/\/\S+/g, '[media URL]');
    record.details.lastLine = last.slice(0, 500);
  }
}

function runYoutubeCommand(args, { jobId = '', label = 'تنزيل من YouTube', clipDurationSec = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, { cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = registerJob(jobId, child, label);
    if (record) {
      record.details = { type: 'youtube', phase: 'preparing', clipDurationSec: Number(clipDurationSec) || 0 };
      attachNetworkMeter(record).catch(() => {});
    }
    const stdoutChunks = [], stderrChunks = [];
    let stdoutSize = 0, stderrSize = 0;
    const max = 12 * 1024 * 1024;
    const collect = (chunks, kind, chunk) => {
      const b = Buffer.from(chunk);
      chunks.push(b);
      if (kind === 'stdout') stdoutSize += b.length; else stderrSize += b.length;
      while ((kind === 'stdout' ? stdoutSize : stderrSize) > max && chunks.length > 1) {
        const removed = chunks.shift().length;
        if (kind === 'stdout') stdoutSize -= removed; else stderrSize -= removed;
      }
      const text = b.toString('utf8');
      updateProgressFromText(record, text);
      updateYoutubeProgress(record, text);
    };
    child.stdout.on('data', chunk => collect(stdoutChunks, 'stdout', chunk));
    child.stderr.on('data', chunk => collect(stderrChunks, 'stderr', chunk));
    child.once('error', err => {
      finishJob(record, false);
      reject(err);
    });
    child.once('close', async code => {
      const exitCode = Number(code ?? 1);
      await refreshNetworkMeter(record).catch(() => {});
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      const cancelled = !!record?.cancelled;
      if (record && exitCode === 0 && !cancelled) {
        record.details.phase = 'done';
        record.progress = 100;
      }
      finishJob(record, exitCode === 0);
      resolve({ code: exitCode, stdout, stderr, output, cancelled, details: record?.details || {} });
    });
    if (record?.cancelled) terminateProcessTree(child);
  });
}

function youtubeOutputTemplate(outputDir, kind) {
  const suffix = kind === 'clip' ? ' [clip]' : kind === 'audio' ? ' [audio]' : '';
  return path.join(outputDir, `%(title).100s${suffix}.%(ext)s`);
}

function findYoutubeOutputFile(outputDir, kind, markerPath = '') {
  try {
    if (markerPath && fs.existsSync(markerPath) && fs.statSync(markerPath).isFile()) return markerPath;
  } catch {}
  const suffix = kind === 'clip' ? ' [clip]' : kind === 'audio' ? ' [audio]' : '';
  try {
    const candidates = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && (!suffix || entry.name.includes(suffix)))
      .map(entry => {
        const file = path.join(outputDir, entry.name);
        try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.file || '';
  } catch {
    return '';
  }
}

async function getYoutubeInfo(rawUrl) {
  const url = normalizeYoutubeUrl(rawUrl);
  const validation = await validateYtDlp();
  if (!validation.ok) throw new Error('محرك YouTube غير موجود. ثبّت أو حدّث yt-dlp أولًا.');
  const args = ['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', url];
  const result = await runProcess(ytDlpPath, args, { cwd: ROOT, maxOutput: 8 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(result.output || 'تعذر قراءة معلومات الفيديو.');
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new Error('تعذر قراءة بيانات الفيديو من YouTube.'); }
  return {
    id: String(info.id || ''),
    title: String(info.title || 'YouTube video'),
    channel: String(info.channel || info.uploader || ''),
    duration: Number(info.duration) || 0,
    thumbnail: String(info.thumbnail || ''),
    webpageUrl: String(info.webpage_url || url),
  };
}

async function downloadYoutube(body) {
  const startedAt = Date.now();
  const url = normalizeYoutubeUrl(body.url);
  const validation = await validateYtDlp();
  if (!validation.ok) throw new Error('محرك YouTube غير جاهز. استخدم زر تحديث المحرك ثم حاول مرة أخرى.');

  const kind = ['clip', 'video', 'audio'].includes(body.kind) ? body.kind : 'clip';
  const outputDir = path.resolve(String(body.outputDir || path.join(os.homedir(), 'Downloads')));
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) throw new Error('مجلد الحفظ غير موجود.');

  let startSec = 0, endSec = 0, clipDurationSec = 0;
  if (kind === 'clip') {
    startSec = parseTimeValue(body.start, 'وقت البداية');
    endSec = parseTimeValue(body.end, 'وقت النهاية');
    if (endSec <= startSec) throw new Error('وقت النهاية يجب أن يكون بعد وقت البداية.');
    clipDurationSec = endSec - startSec;
  }

  const args = [
    url,
    '--no-playlist',
    '--js-runtimes', 'node',
    '--ffmpeg-location', ffmpegPath,
    '--newline',
    '--progress',
    '--no-colors',
    '--print', 'after_move:__CUTCAP_FILE__%(filepath)s',
  ];

  if (kind === 'clip') args.push('--download-sections', `*${startSec}-${endSec}`);

  if (kind === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', youtubeFormatSelector(body.quality), '--merge-output-format', 'mp4');
  }

  if (kind === 'clip' && body.exact === true) args.push('--force-keyframes-at-cuts');
  args.push('-o', youtubeOutputTemplate(outputDir, kind));

  const jobId = normalizeJobId(body.jobId);
  let result = await runYoutubeCommand(args, {
    jobId,
    label: kind === 'clip' ? 'تنزيل المقطع' : kind === 'audio' ? 'تنزيل الصوت' : 'تنزيل الفيديو',
    clipDurationSec,
  });

  if (!result.cancelled && result.code !== 0 && /\b403\b|forbidden|forcing sabr|missing a url/i.test(result.output)) {
    const retryArgs = args.concat(['--extractor-args', 'youtube:player_client=android']);
    result = await runYoutubeCommand(retryArgs, {
      jobId,
      label: 'إعادة المحاولة بطريقة بديلة',
      clipDurationSec,
    });
  }

  if (result.cancelled) throw new Error('تم إلغاء التنزيل.');
  if (result.code !== 0) throw new Error(result.output || `yt-dlp exited with code ${result.code}.`);

  const markerMatches = [...result.output.matchAll(/__CUTCAP_FILE__(.+?)(?:\r?\n|$)/g)];
  const markerPath = markerMatches.length ? markerMatches.at(-1)[1].trim() : String(result.details?.outputPath || '');
  const outputPath = findYoutubeOutputFile(outputDir, kind, markerPath);
  const finalSize = outputPath && fs.existsSync(outputPath) ? fs.statSync(outputPath).size : Number(result.details?.outputBytes || 0);

  return {
    ok: true,
    kind,
    outputPath,
    outputDir,
    finalSize,
    networkRxBytes: Number(result.details?.networkRxBytes || 0),
    reportedDownloadBytes: Number(result.details?.reportedDownloadBytes || 0),
    elapsedMs: Date.now() - startedAt,
    output: result.output,
  };
}

function addWatermarkToTimeline(timeline, settings, logoInfo) {
  if (!settings?.path || !Array.isArray(timeline?.v?.[0])) throw new Error('Invalid video timeline for watermark.');
  const [canvasWidth, canvasHeight] = Array.isArray(timeline.resolution) ? timeline.resolution.map(Number) : [];
  const [logoWidth] = Array.isArray(logoInfo?.raw?.video?.[0]?.resolution) ? logoInfo.raw.video[0].resolution.map(Number) : [];
  if (!(canvasWidth > 0) || !(canvasHeight > 0) || !(logoWidth > 0)) throw new Error('Could not calculate watermark size.');
  const t = normalizeWatermarkTransform(settings.transform);
  const x = canvasWidth * t.x;
  const y = canvasHeight * t.y;
  const scale = canvasWidth * (t.scale / 100) / logoWidth;
  const effects = [`pos:${x.toFixed(3)}:${y.toFixed(3)}:${scale.toFixed(6)}`];
  if (t.opacity < 100) effects.push(`opacity:${(t.opacity / 100).toFixed(6)}`);
  timeline.v.push(timeline.v[0].map(clip => ({
    src: settings.path,
    start: Number(clip.start) || 0,
    dur: Number(clip.dur) || 0,
    offset: 0,
    stream: 0,
    effects,
  })).filter(clip => clip.dur > 0));
  return timeline;
}
function renderTempPath(output) {
  const ext = path.extname(output);
  const base = path.basename(output, ext);
  return path.join(path.dirname(output), `.${base}.ae-render-${crypto.randomUUID()}${ext}`);
}

function commitRenderedOutput(temp, output) {
  const backup = `${output}.ae-backup-${crypto.randomUUID()}`;
  const hadExisting = fs.existsSync(output);
  if (hadExisting) fs.renameSync(output, backup);
  try {
    fs.renameSync(temp, output);
  } catch (err) {
    if (hadExisting && fs.existsSync(backup) && !fs.existsSync(output)) {
      try { fs.renameSync(backup, output); } catch {}
    }
    throw err;
  }
  if (hadExisting) { try { fs.unlinkSync(backup); } catch {} }
}

function parseTimebase(tb) {
  const parts = String(tb || '30/1').split('/').map(Number);
  return (parts[0] || 30) / (parts[1] || 1);
}

function timeString(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function mimeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

function serveFileRange(req, res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendText(res, 404, 'Media not available.');
  const stat = fs.statSync(file);
  const size = stat.size;
  const range = req.headers.range;
  const contentType = mimeFor(file);
  if (!range) {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end();
  }
  end = Math.min(end, size - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function getMediaInfo(sourcePath) {
  const result = await runAutoEditor(['info', sourcePath, '--json'], path.dirname(sourcePath));
  if (result.code !== 0) throw new Error(result.output || 'Could not read media info.');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('Auto-Editor info returned invalid JSON.'); }
  const item = Object.values(data || {})[0] || {};
  const duration = Number(item?.container?.duration || item?.video?.[0]?.duration || item?.audio?.[0]?.duration || 0);
  const fps = parseTimebase(item?.recommendedTimebase || item?.video?.[0]?.fps || '30/1');
  return { duration, fps, raw: item };
}

function histPercentile(hist, minDb, maxDb, total, p) {
  if (!total) return minDb;
  const target = total * Math.min(1, Math.max(0, p));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return minDb + (i + 0.5) / hist.length * (maxDb - minDb);
  }
  return maxDb;
}

function otsuDb(hist, minDb, maxDb) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return -28;
  let sum = 0;
  for (let i = 0; i < hist.length; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < hist.length - 1; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = i; }
  }
  return minDb + (best + 0.5) / hist.length * (maxDb - minDb);
}

function dbToPercent(db) {
  return Math.pow(10, db / 20) * 100;
}

function round1(n) { return Math.round(n * 10) / 10; }

function suggestThreshold(hist, total) {
  const minDb = -80, maxDb = 0;
  if (!total) return { safe: 3, recommended: 4, aggressive: 7, confidence: 'low', floorDb: -50, activeDb: -18, boundaryDb: -28 };
  const p40 = histPercentile(hist, minDb, maxDb, total, 0.40);
  const p75 = histPercentile(hist, minDb, maxDb, total, 0.75);
  const p90 = histPercentile(hist, minDb, maxDb, total, 0.90);
  // Ignore the extreme digital-silence tail when estimating the practical noise floor.
  // That tail can otherwise drag a histogram threshold far below Auto-Editor's useful range.
  const floorDb = Math.max(-60, p40);
  const activeDb = Math.max(p75, p90 - 8);
  const separation = activeDb - floorDb;
  const otsu = otsuDb(hist, minDb, maxDb);
  const bridge = floorDb + Math.max(5, separation * 0.55);
  let recDb = 0.25 * otsu + 0.75 * bridge - 0.5;
  let confidence = 'high';
  if (separation < 10) confidence = 'low';
  else if (separation < 16) confidence = 'medium';
  // Low-separation recordings (music, constant room noise, etc.) are intentionally
  // anchored toward Auto-Editor's conservative 4% default instead of guessing wildly.
  if (confidence === 'low') recDb = 0.75 * (-27.96) + 0.25 * recDb;
  else if (confidence === 'medium') recDb = 0.30 * (-27.96) + 0.70 * recDb;
  recDb = Math.max(-30, Math.min(-18, recDb));
  const safeDb = Math.max(-34, recDb - 3.5);
  const aggressiveDb = Math.min(-13.5, recDb + 4.5);
  return {
    safe: round1(Math.max(0.8, Math.min(12, dbToPercent(safeDb)))),
    recommended: round1(Math.max(1.2, Math.min(13, dbToPercent(recDb)))),
    aggressive: round1(Math.max(2, Math.min(20, dbToPercent(aggressiveDb)))),
    confidence,
    floorDb: round1(floorDb),
    activeDb: round1(activeDb),
    boundaryDb: round1(recDb),
  };
}

async function analyzeLevels(sourcePath, jobId = '') {
  const validation = await validateAutoEditor();
  if (!validation.ok) throw new Error(validation.error);
  const info = await getMediaInfo(sourcePath);
  const estimated = Math.max(1, Math.round((info.duration || 1) * (info.fps || 30)));
  const maxWave = 12000;
  const wavePoints = Math.max(1, Math.min(maxWave, estimated));
  const buckets = new Float64Array(wavePoints);
  const hist = new Uint32Array(200);
  const minDb = -80, maxDb = 0;
  let count = 0, numeric = 0;
  const stderr = [];

  await new Promise((resolve, reject) => {
    const child = spawn(autoEditorPath, ['levels', sourcePath], { cwd: path.dirname(sourcePath), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = registerJob(jobId, child, 'تحليل الصوت');
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      const v = Number(String(line).trim());
      if (!Number.isFinite(v)) return;
      const level = Math.max(0, Math.min(1, v));
      numeric++;
      const ratio = Math.min(0.999999, count / estimated);
      const bi = Math.min(wavePoints - 1, Math.floor(ratio * wavePoints));
      if (level > buckets[bi]) buckets[bi] = level;
      const db = Math.max(minDb, Math.min(maxDb, 20 * Math.log10(Math.max(level, 0.0001))));
      const hi = Math.min(hist.length - 1, Math.max(0, Math.floor((db - minDb) / (maxDb - minDb) * hist.length)));
      hist[hi]++;
      count++;
      updateJobProgress(record, count / estimated * 100);
    });
    child.stderr.on('data', c => { if (stderr.join('').length < 20000) stderr.push(Buffer.from(c).toString('utf8')); });
    child.once('error', err => { finishJob(record, false); reject(err); });
    child.once('close', code => {
      rl.close();
      const exitCode = Number(code ?? 1);
      const cancelled = !!record?.cancelled;
      finishJob(record, exitCode === 0);
      if (cancelled) return reject(new Error('تم إلغاء العملية.'));
      if (exitCode !== 0) return reject(new Error(stderr.join('').trim() || `levels exited with code ${code}`));
      resolve();
    });
  });

  if (!numeric) throw new Error('لم يتم العثور على مستويات صوت في الفيديو.');
  const usedBuckets = Math.min(wavePoints, Math.max(1, Math.ceil(count / estimated * wavePoints)));
  const waveform = Array.from(buckets.slice(0, usedBuckets), v => Math.round(v * 100000) / 100000);
  return { duration: info.duration, fps: info.fps, waveform, suggestion: suggestThreshold(Array.from(hist), numeric), levelCount: numeric };
}

async function handleApi(req, res, url) {
  let requestJobId = '';
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, app: APP_ID, version: APP_VERSION, pid: process.pid, instanceId: INSTANCE_ID });
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const validation = await validateAutoEditor();
      if (validation.ok) autoEditorVersion = validation.version;
      const yt = await validateYtDlp();
      return sendJson(res, 200, {
        autoEditorFound: validation.ok, autoEditorPath: autoEditorPath || '', autoEditorVersion: validation.version || '', autoEditorError: validation.ok ? '' : validation.error,
        ytDlpFound: yt.ok, ytDlpPath: ytDlpPath || '', ytDlpVersion: yt.version || '', ytDlpError: yt.ok ? '' : yt.error,
        ffmpegPath,
        downloadsDir: path.join(os.homedir(), 'Downloads'),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/media') return serveFileRange(req, res, mediaFiles.get(String(url.searchParams.get('token') || '')) || '');
    if (req.method === 'GET' && url.pathname === '/api/preview-media') return serveFileRange(req, res, getPreviewFile(url.searchParams.get('token')));
    if (req.method === 'GET' && url.pathname === '/api/job-status') {
      const record = jobs.get(normalizeJobId(url.searchParams.get('jobId')));
      return sendJson(res, 200, record ? {
        running: record.running,
        cancelled: record.cancelled,
        progress: record.progress,
        label: record.label,
        elapsedMs: Date.now() - record.startedAt,
        details: record.details || {},
      } : { running: false, progress: null, details: {} });
    }
    if (req.method === 'GET' && url.pathname === '/api/job-result') {
      const id = normalizeJobId(url.searchParams.get('jobId'));
      const record = id ? jobResults.get(id) : null;
      if (record) return sendJson(res, 200, { state: record.ok ? 'done' : 'error', ok: record.ok, result: record.result, error: record.error });
      const running = id && jobs.get(id)?.running;
      return sendJson(res, 200, { state: running ? 'running' : 'unknown' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
    const body = await readJson(req);
    requestJobId = normalizeJobId(body.jobId);

    if (url.pathname === '/api/pick-exe') {
      const selected = await nativePick('exe', autoEditorPath || path.join(os.homedir(), 'Downloads'));
      if (!selected) return sendJson(res, 200, { cancelled: true });
      const validation = await validateAutoEditor(selected);
      if (!validation.ok) throw new Error(`الملف المختار لا يعمل كـ Auto-Editor.\n${validation.error}`);
      autoEditorPath = selected; autoEditorVersion = validation.version;
      return sendJson(res, 200, { path: autoEditorPath, version: autoEditorVersion });
    }

    if (url.pathname === '/api/pick-video') {
      const selected = await nativePick('video', String(body.initial || '') || path.join(os.homedir(), 'Downloads'));
      if (!selected) return sendJson(res, 200, { cancelled: true });
      const file = requireFile(selected, 'The selected video does not exist.');
      return sendJson(res, 200, { path: file, name: path.basename(file), outputPath: defaultOutput(file), mediaToken: registerMedia(file) });
    }

    if (url.pathname === '/api/set-video-path') {
      const file = requireFile(body.path, 'المسار غير صحيح أو الملف غير موجود.');
      return sendJson(res, 200, { path: file, name: path.basename(file), outputPath: defaultOutput(file), mediaToken: registerMedia(file) });
    }

    if (url.pathname === '/api/pick-watermark') {
      const selected = await nativePick('image', body.initial || '');
      if (!selected) return sendJson(res, 200, { cancelled: true });
      const file = requireFile(selected, 'The selected watermark does not exist.');
      return sendJson(res, 200, { path: file, name: path.basename(file), mediaToken: registerMedia(file) });
    }

    if (url.pathname === '/api/set-watermark') {
      const file = requireFile(body.path, 'اختار ملف لوجو صحيح.');
      const previous = watermarkSettings && outputKey(watermarkSettings.path) === outputKey(file) ? watermarkSettings.transform : DEFAULT_WATERMARK_TRANSFORM;
      watermarkSettings = { path: file, transform: normalizeWatermarkTransform(body.transform || previous) };
      saveWatermarkSettings(watermarkSettings);
      return sendJson(res, 200, { ok: true, watermark: watermarkSettings });
    }

    if (url.pathname === '/api/get-watermark') {
      if (!watermarkSettings || !fs.existsSync(watermarkSettings.path)) return sendJson(res, 200, { watermark: null, mediaToken: '', name: '' });
      return sendJson(res, 200, { watermark: watermarkSettings, mediaToken: registerMedia(watermarkSettings.path), name: path.basename(watermarkSettings.path) });
    }

    if (url.pathname === '/api/watermark-preview') {
      const sourcePath = requireFile(body.sourcePath);
      if (!watermarkSettings || !watermarkSettings.path) throw new Error('اختار اللوجو الأول.');
      const out = path.join(os.tmpdir(), `ae-watermark-preview-${crypto.randomUUID()}.jpg`);
      const t = normalizeWatermarkTransform(watermarkSettings.transform);
      const scale = (t.scale / 100).toFixed(6), opacity = (t.opacity / 100).toFixed(6), x = t.x.toFixed(6), y = t.y.toFixed(6);
      const filter = `[1:v][0:v]scale2ref=w=main_w*${scale}:h=-1[wm][base];[wm]format=rgba,colorchannelmixer=aa=${opacity}[wm2];[base][wm2]overlay=x=main_w*${x}:y=main_h*${y}[outv]`;
      let stderr='';
      const child = spawn(ffmpegPath, ['-y','-ss','0','-i',sourcePath,'-i',watermarkSettings.path,'-filter_complex',filter,'-map','[outv]','-frames:v','1',out], {windowsHide:true,stdio:['ignore','ignore','pipe']});
      child.stderr.on('data',chunk=>{if(stderr.length<20000)stderr+=Buffer.from(chunk).toString('utf8')});
      await new Promise((resolve,reject)=>{child.once('close',c=>c===0&&fs.existsSync(out)?resolve():reject(new Error(stderr.trim() || 'Preview failed')));child.once('error',reject)});
      const token = registerPreview(out);
      return sendJson(res,200,{previewUrl:`/api/preview-media?token=${encodeURIComponent(token)}`});
    }
    if (url.pathname === '/api/pick-output') {
      const sourcePath = requireFile(body.sourcePath);
      const selected = await nativePick('output', String(body.initial || '') || defaultOutput(sourcePath));
      if (!selected) return sendJson(res, 200, { cancelled: true });
      return sendJson(res, 200, { path: selected });
    }

    if (url.pathname === '/api/pick-folder') {
      const selected = await nativePick('folder', String(body.initial || '') || path.join(os.homedir(), 'Downloads'));
      if (!selected) return sendJson(res, 200, { cancelled: true });
      return sendJson(res, 200, { path: selected });
    }

    if (url.pathname === '/api/youtube-info') {
      return sendJson(res, 200, await getYoutubeInfo(body.url));
    }

    if (url.pathname === '/api/youtube-update') {
      const result = await runProcess(ytDlpPath, ['-U'], { cwd: ROOT, maxOutput: 2 * 1024 * 1024 });
      if (result.code !== 0) throw new Error(result.output || 'تعذر تحديث yt-dlp.');
      const validation = await validateYtDlp();
      return sendJson(res, 200, { ok: validation.ok, version: validation.version, output: result.output });
    }

    if (url.pathname === '/api/youtube-download') {
      const payload = await downloadYoutube(body);
      storeJobResult(requestJobId, payload);
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/open-folder') {
      const target = String(body.target || '');
      if (!target) throw new Error('لا يوجد ملف لفتح مكانه.');
      const existing = fs.existsSync(target) ? target : path.dirname(target);
      const folder = fs.existsSync(existing) && fs.statSync(existing).isDirectory() ? existing : path.dirname(existing);
      if (process.platform !== 'win32') throw new Error('Open folder is available on Windows only.');
      const child = spawn('explorer.exe', [folder], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/release-preview') return sendJson(res, 200, { released: releasePreview(body.token) });
    if (url.pathname === '/api/cancel') return sendJson(res, 200, { cancelled: cancelJob(body.jobId) });

    if (url.pathname === '/api/auto-threshold') {
      const sourcePath = requireFile(body.sourcePath);
      const data = await analyzeLevels(sourcePath, body.jobId);
      storeJobResult(requestJobId, data);
      return sendJson(res, 200, data);
    }

    if (url.pathname === '/api/run') {
      const sourcePath = requireFile(body.sourcePath);
      const cwd = path.dirname(sourcePath);
      const args = buildEditArgs(body, sourcePath);
      const mode = body.mode;
      const jobId = normalizeJobId(body.jobId);

      if (mode === 'preview') {
        args.push('--preview');
        const result = await runAutoEditor(args, cwd, jobId, 'معاينة القص');
        if (result.code !== 0) return sendJson(res, 500, { error: result.output || 'Preview failed.' });
        return sendJson(res, 200, result);
      }

      if (mode === 'cuts') {
        const temp = path.join(os.tmpdir(), `ae-cuts-${crypto.randomUUID()}.v1`);
        args.push('--export', 'v1', '-o', temp);
        let result, timeline;
        try {
          result = await runAutoEditor(args, cwd, jobId, 'تحليل أماكن القص');
          if (result.code !== 0) return sendJson(res, 500, { error: result.output || 'Analysis failed.' });
          timeline = JSON.parse(fs.readFileSync(temp, 'utf8').replace(/^\uFEFF/, ''));
        }
        finally { try { fs.unlinkSync(temp); } catch {} }
        const fps = parseTimebase(timeline.timebase);
        const cuts = (timeline.chunks || []).filter(chunk => isCutSpeed(chunk && chunk[2])).map((chunk, index) => {
          const start = Number(chunk[0]) / fps, end = Number(chunk[1]) / fps;
          return { index: index + 1, start, end, duration: end - start, startText: timeString(start), endText: timeString(end), durationText: `${(end - start).toFixed(2)} s` };
        });
        const totalCut = cuts.reduce((sum, cut) => sum + cut.duration, 0);
        const sourceDuration = (timeline.chunks || []).reduce((max, chunk) => {
          const end = Number(chunk && chunk[1]); return Number.isFinite(end) ? Math.max(max, end / fps) : max;
        }, 0);
        const payload = { code: 0, output: result.output, fps, cuts, totalCut, totalCutText: timeString(totalCut), sourceDuration, editedDuration: Math.max(0, sourceDuration - totalCut) };
        storeJobResult(requestJobId, payload);
        return sendJson(res, 200, payload);
      }

      if (mode === 'proxy') {
        const temp = path.join(os.tmpdir(), `ae-preview-${process.pid}-${crypto.randomUUID()}.mp4`);
        args.push('--scale', '0.5', '-crf', '32', '-preset', 'ultrafast', '-b:a', '96k', '-o', temp);
        const started = Date.now();
        try {
          const result = await runAutoEditor(args, cwd, jobId, 'بناء المعاينة السلسة');
          if (result.code !== 0 || !fs.existsSync(temp)) {
            try { fs.unlinkSync(temp); } catch {}
            return sendJson(res, 500, { error: result.output || 'Smooth preview render failed.' });
          }
          const previewToken = registerPreview(temp);
          const payload = { code: 0, ready: true, previewToken, elapsedMs: Date.now() - started, output: result.output };
          storeJobResult(requestJobId, payload);
          return sendJson(res, 200, payload);
        } catch (err) {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
          throw err;
        }
      }

      if (mode === 'render') {
        const requested = path.resolve(String(body.output || defaultOutput(sourcePath)));
        if (!requested) throw new Error('حدد مكان حفظ الفيديو النهائي.');
        if (outputKey(requested) === outputKey(sourcePath)) throw new Error('مكان الحفظ لا يمكن أن يكون نفس ملف الفيديو الأصلي.');
        const releaseOutput = acquireOutputLock(requested);
        const temp = renderTempPath(requested);
        const timelineTemp = path.join(os.tmpdir(), `ae-watermark-${process.pid}-${crypto.randomUUID()}.v3`);
        try {
          if (watermarkSettings) {
            args.push('--export', 'v3', '-o', timelineTemp);
            const analysis = await runAutoEditor(args, cwd, jobId, 'تحليل القص واللوجو');
            if (analysis.code !== 0 || !fs.existsSync(timelineTemp)) return sendJson(res, 500, { error: analysis.output || 'Timeline creation failed.' });
            const timeline = JSON.parse(fs.readFileSync(timelineTemp, 'utf8').replace(/^\uFEFF/, ''));
            const logoInfo = await getMediaInfo(watermarkSettings.path);
            addWatermarkToTimeline(timeline, watermarkSettings, logoInfo);
            fs.writeFileSync(timelineTemp, JSON.stringify(timeline), 'utf8');
            const result = await runAutoEditor([timelineTemp, '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-o', temp], cwd, jobId, 'إنشاء الفيديو النهائي واللوجو');
            if (result.code !== 0 || !fs.existsSync(temp)) return sendJson(res, 500, { error: result.output || 'Render failed.' });
            commitRenderedOutput(temp, requested);
            const payload = { ...result, outputPath: requested };
            storeJobResult(requestJobId, payload);
            return sendJson(res, 200, payload);
          } else {
            args.push('-o', temp);
            const result = await runAutoEditor(args, cwd, jobId, 'إنشاء الفيديو النهائي');
            if (result.code !== 0 || !fs.existsSync(temp)) return sendJson(res, 500, { error: result.output || 'Render failed.' });
            commitRenderedOutput(temp, requested);
            const payload = { ...result, outputPath: requested };
            storeJobResult(requestJobId, payload);
            return sendJson(res, 200, payload);
          }
        } finally {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
          try { if (fs.existsSync(timelineTemp)) fs.unlinkSync(timelineTemp); } catch {}
          releaseOutput();
        }
      }

      if (mode === 'capcut') {
        const payload = await exportCapCutProject({
          sourcePath,
          threshold: body.threshold,
          marginBefore: body.marginBefore,
          marginAfter: body.marginAfter,
          smoothCut: body.smoothCut,
          smoothClip: body.smoothClip,
          keepRanges: body.keepRanges,
          jobId,
        });
        storeJobResult(requestJobId, payload);
        return sendJson(res, 200, payload);
      }

      if (mode === 'clips') {
        args.push('--export', 'clip-sequence');
        const result = await runAutoEditor(args, cwd, jobId, 'إخراج Clips');
        if (result.code !== 0) return sendJson(res, 500, { error: result.output || 'Clip export failed.' });
        const payload = { ...result, outputFolder: cwd };
        storeJobResult(requestJobId, payload);
        return sendJson(res, 200, payload);
      }
      throw new Error('Unknown run mode.');
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API route not found.' });
  } catch (err) {
    storeJobResult(requestJobId, null, err.message || String(err));
    const status = Number(err && err.statusCode);
    return sendJson(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: err.message || String(err) });
  }
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!fs.existsSync(INDEX)) return sendText(res, 500, 'index.html not found');
      return sendText(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/shared.js') {
      if (!fs.existsSync(SHARED)) return sendText(res, 500, 'shared.js not found');
      return sendText(res, 200, fs.readFileSync(SHARED, 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      if (!fs.existsSync(APP_JS)) return sendText(res, 500, 'app.js not found');
      return sendText(res, 200, fs.readFileSync(APP_JS, 'utf8'), 'application/javascript; charset=utf-8');
    }
    return sendText(res, 404, 'Not found');
  });
  // Export/render requests can legitimately run for hours. Node's default
  // request timeout is five minutes; that would close a healthy local job.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 5 * 1000;
  server.on('clientError', (error, socket) => {
    recordServerError('client connection', error);
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

function writeInstanceFiles() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  try { fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ app: APP_ID, version: APP_VERSION, pid: process.pid, port: PORT, instanceId: INSTANCE_ID, startedAt: new Date().toISOString() }, null, 2)); } catch {}
}
function cleanupState() {
  clearInterval(previewCleanupTimer);
  clearInterval(jobResultCleanupTimer);
  if (activePickerProcess && activePickerProcess.exitCode == null) terminateProcessTree(activePickerProcess);
  for (const record of jobs.values()) if (record.running) terminateProcessTree(record.child);
  for (const token of [...previewFiles.keys()]) releasePreview(token);
  for (const f of [PID_FILE, INSTANCE_FILE]) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
}
function startServer() {
  const server = createServer();
  process.once('uncaughtException', error => {
    recordServerError('uncaught exception', error);
    cleanupState();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50).unref?.();
  });
  process.on('unhandledRejection', error => recordServerError('unhandled rejection', error));
  process.once('exit', cleanupState);
  process.once('SIGINT', () => { cleanupState(); process.exit(0); });
  process.once('SIGTERM', () => { cleanupState(); process.exit(0); });
  server.listen(PORT, HOST, () => {
    writeInstanceFiles();
    console.log(`Auto-Editor GUI V${APP_VERSION} listening on http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) startServer();
module.exports = {
  createServer,
  runProcess,
  buildEditArgs,
  buildCapCutOtio,
  buildCapCutImportArgs,
  findCapCutSeedProject,
  analyzeLevels,
  exportCapCutProject,
  addWatermarkToTimeline,
  cancelJob,
  acquireOutputLock,
  commitRenderedOutput,
  registerPreview,
  getPreviewFile,
  cleanupExpiredPreviews,
  PREVIEW_TTL_MS,
};
