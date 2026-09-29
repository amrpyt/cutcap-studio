const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

test('review selection changes preserve analysis and only invalidate preview', () => {
  const method = app.match(/toggleCut\(i\)\{([^\n]+)\}/)?.[1] || '';
  assert.ok(method.includes('releaseProxy'));
  assert.equal(method.includes('markDirty'), false);
  assert.match(app, /keepRanges:buildKeepRanges\(this\.cuts\)/);
});

test('long jobs lock settings and expose cancellation/progress', () => {
  assert.match(app, /querySelectorAll\('button,input,select'\)/);
  assert.match(app, /cancelActiveJob\(\)/);
  assert.match(html, /id="jobProgress"/);
  assert.match(html, /id="cancelJobBtn"/);
});

test('timeline and form controls have keyboard/accessibility semantics', () => {
  for (const id of ['previewSpeed', 'timelineZoom', 'threshold', 'manualVideoPath']) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
  }
  assert.match(html, /id="detailCanvas"[^>]+tabindex="0"[^>]+role="slider"/);
  assert.match(html, /id="overviewCanvas"[^>]+tabindex="0"[^>]+role="slider"/);
  assert.match(app, /keySeek\(e\)/);
});

test('UI logic is served from app.js instead of a large inline app script', () => {
  assert.match(html, /<script src="\/shared\.js"><\/script>\s*<script src="\/app\.js"><\/script>/);
  assert.equal(/class App/.test(html), false);
});

test('page close does a best-effort preview release', () => {
  assert.match(app, /pagehide/);
  assert.match(app, /keepalive:true/);
});

test('proxy position is captured before changing the timeline', () => {
  const toggle = app.slice(app.indexOf('\n  toggleCut(i)'), app.indexOf('\n  removeAuditionHandler()'));
  assert.ok(toggle.indexOf('const sourceTime=') < toggle.indexOf('c.enabled='));
  const analyze = app.slice(app.indexOf('async analyzeCuts()'), app.indexOf('renderSummary()'));
  assert.ok(analyze.indexOf('const sourceTime=') < analyze.indexOf('this.timeline=new CutTimeline'));
});

test('rapid cut auditions and preview-from-here use the latest request and position', () => {
  const audition = app.slice(app.indexOf('async auditionCut'), app.indexOf('async ensureProxy'));
  assert.match(audition, /auditionRevision\.bump\(\)/);
  assert.match(audition, /auditionRevision\.isCurrent\(revision\)/);
  const preview = app.slice(app.indexOf('async startSmoothPreview'), app.indexOf('async switchToSource'));
  assert.ok(preview.indexOf('await this.ensureProxy()') < preview.indexOf('const currentEdited='));
});

test('last output is cleared when video or destination changes', () => {
  const reset = app.slice(app.indexOf('resetAll()'), app.indexOf('applyVideo(data)'));
  const pickOutput = app.slice(app.indexOf('async pickOutput()'), app.indexOf('async simpleAction'));
  assert.match(reset, /this\.lastOutput=''/);
  assert.match(pickOutput, /this\.lastOutput=''/);
});

test('editor uses a five-stage workflow instead of one long page', () => {
  assert.equal((html.match(/data-step-target="[1-5]"/g) || []).length, 5);
  assert.equal((html.match(/class="card workflowStep/g) || []).length, 5);
  assert.match(html, /id="previousStepBtn"/);
  assert.match(html, /id="nextStepBtn"/);
  assert.match(app, /maxUnlockedStep\(\)/);
  assert.match(app, /this\.currentStep=3;this\.syncStep\(\)/);
});

test('export stage offers an editable CapCut project instead of only rendered clips', () => {
  assert.match(html, /id="capcutBtn"/);
  assert.match(html, /مشروع CapCut/);
  assert.match(app, /capcutBtn/);
  assert.match(app, /runOutput\('capcut'\)/);
});
