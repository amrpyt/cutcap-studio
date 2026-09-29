const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCapCutOtio, buildCapCutImportArgs, buildEditArgs, findCapCutSeedProject } = require('../server.js');

test('CapCut OTIO preserves source in-points and full media duration', () => {
  assert.equal(typeof buildCapCutOtio, 'function');
  const otio = buildCapCutOtio({
    sourcePath: 'C:\\videos\\talk.mp4',
    fps: 30,
    sourceDuration: 3.9,
    chunks: [
      [0, 30, 1],
      [30, 60, 0],
      [60, 120, 1],
    ],
    name: 'talk',
  });

  assert.equal(otio.OTIO_SCHEMA, 'Timeline.1');
  assert.equal(otio.name, 'talk - Auto Cut');
  const clips = otio.tracks.children[0].children;
  assert.equal(clips.length, 2);
  assert.equal(clips[0].source_range.start_time.value, 0);
  assert.equal(clips[0].source_range.duration.value, 30);
  assert.equal(clips[1].source_range.start_time.value, 60);
  assert.equal(clips[1].source_range.duration.value, 60);
  assert.equal(clips[0].media_reference.available_range.duration.value, 120);
  assert.equal(clips[1].media_reference.available_range.duration.value, 120);
});

test('CapCut export reuses manual keep ranges during fresh Auto-Editor analysis', () => {
  const args = buildEditArgs({
    mode: 'capcut',
    threshold: 4,
    marginBefore: 0.2,
    marginAfter: 0.4,
    smoothCut: 0.35,
    smoothClip: 0.1,
    keepRanges: [{ start: 1.25, end: 2.5 }],
  }, 'C:\\videos\\talk.mp4');

  assert.ok(args.includes('--keep'));
  assert.ok(args.includes('1.250000sec,2.500000sec'));
});

test('CapCut seed selection ignores higher-version JianYing projects', () => {
  assert.equal(typeof findCapCutSeedProject, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-capcut-seed-'));
  const writeDraft = (folder, source, version) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'draft_content.json'), JSON.stringify({
      platform: { app_source: source, app_version: version },
      canvas_config: { width: 1920, height: 1080, ratio: '16:9' },
      fps: 30,
      tracks: [],
      materials: {},
    }));
    return dir;
  };
  const capcut = writeDraft('capcut', 'cc', '9.3.0');
  writeDraft('jianying', 'lv', '10.5.0');
  try {
    assert.equal(findCapCutSeedProject(root).projectDir, capcut);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CapCut seed selection prefers app-authored drafts over generated drafts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-capcut-authored-'));
  const writeDraft = (folder, version, extra = {}) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'draft_info.json'), JSON.stringify({
      platform: { app_source: 'cc', app_version: version },
      canvas_config: { width: 1920, height: 1080, ratio: '16:9' },
      fps: 30,
      tracks: [],
      materials: {},
      ...extra,
    }));
    return dir;
  };
  writeDraft('generated-newer', '9.9.0');
  const authored = writeDraft('authored-older', '9.3.0', { version: 360000 });
  try {
    assert.equal(findCapCutSeedProject(root).projectDir, authored);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CapCut timeline import uses the selected sanitized template explicitly', () => {
  assert.equal(typeof buildCapCutImportArgs, 'function');
  assert.deepEqual(
    buildCapCutImportArgs('C:\\temp\\cut.otio', 'C:\\drafts\\Auto Cut', 'C:\\temp\\template'),
    ['import-timeline', 'C:\\temp\\cut.otio', '--out', 'C:\\drafts\\Auto Cut', '--template', 'C:\\temp\\template'],
  );
});
