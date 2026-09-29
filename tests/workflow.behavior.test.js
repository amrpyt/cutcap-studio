const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shared = require('../shared');

// Exercise the real controller without launching media jobs or a browser.
function setup() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        dataset: {}, textContent: '', disabled: false, attributes: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x),
          contains: x => classes.has(x), toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
        setAttribute(k, v) { this.attributes[k] = v; },
        removeAttribute(k) { delete this.attributes[k]; }, focus() {}, pause() { this.paused = true; }
      });
    }
    return nodes.get(id);
  }
  const steps = [1, 2, 3, 4, 5].map(n => Object.assign(node('step' + n), { dataset: { stepTarget: String(n) } }));
  const context = { window: { AEGShared: shared, scrollTo() {} },
    document: { getElementById: node, querySelector: () => node('page'),
      querySelectorAll: selector => selector === '[data-step-target]' ? steps : selector === 'button,input,select' ? [...nodes.values()] : [] },
    requestAnimationFrame: fn => fn(), console };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  vm.runInContext(source.replace('new App();', 'window.TestApp=App;window.TestTimeline=CutTimeline;'), context);
  const app = Object.create(context.window.TestApp.prototype);
  Object.assign(app, { currentStep: 1, videoPath: '', cuts: [], busy: false, analysisReady: false,
    analysisDirty: false, settingsRevision: new shared.RevisionGuard(), timeline: new context.window.TestTimeline([], 10),
    timelineView: { draw() {} }, player: node('player'), proxyMonitor: { stop() {} },
    cancelAudition() {}, releaseProxy() {}, showWatermarkEditor() {} });
  return { app, node, steps };
}

test('successful zero-cut analysis unlocks review and export', () => {
  const { app, node } = setup();
  assert.equal(app.maxUnlockedStep(), 1);
  app.videoPath = 'sample.mp4';
  assert.equal(app.maxUnlockedStep(), 2);
  assert.equal(app.markClean(app.settingsRevision.snapshot()), true);
  assert.equal(app.maxUnlockedStep(), 5);
  app.goToStep(5);
  assert.equal(app.currentStep, 5);
  assert.equal(node('renderBtn').disabled, false);
  assert.equal(node('exportCuts').textContent, 0);
  app.renderCuts();
  assert.match(node('cutsBody').innerHTML, /colspan="6"/);
});

test('changing settings invalidates zero-cut results and locks later stages', () => {
  const { app, node, steps } = setup();
  app.videoPath = 'sample.mp4';
  app.markClean(app.settingsRevision.snapshot());
  app.currentStep = 2;
  app.markDirty();
  assert.equal(app.maxUnlockedStep(), 2);
  assert.equal(node('renderBtn').disabled, true);
  assert.equal(steps[2].disabled, true);
  app.goToStep(5);
  assert.equal(app.currentStep, 2);
});

test('navigation sync cannot unlock controls while processing', () => {
  const { app, node, steps } = setup();
  app.videoPath = 'sample.mp4';app.analysisReady = true;
  app.setBusy(true, 'Processing', true);
  app.syncStep();
  app.goToStep(3);
  assert.equal(app.currentStep, 1);
  assert.ok(steps.every(step => step.disabled));
  assert.equal(node('nextStepBtn').disabled, true);
  assert.equal(node('renderBtn').disabled, true);
  assert.equal(node('cancelJobBtn').disabled, false);
  app.setBusy(false);
  assert.equal(node('renderBtn').disabled, false);
});

test('stage changes pause both players and expose the shared viewer only where needed', () => {
  const { app, node } = setup();
  app.videoPath = 'sample.mp4';app.analysisReady = true;
  app.goToStep(3);
  assert.equal(node('viewerSlot').classList.contains('hidden'), false);
  assert.equal(app.player.paused, true);
  assert.equal(node('watermarkVideo').paused, true);
  app.goToStep(4);
  assert.equal(node('viewerSlot').classList.contains('hidden'), true);
});

test('stale analysis cannot mark the workflow ready', () => {
  const { app } = setup();
  const revision = app.settingsRevision.snapshot();
  app.settingsRevision.bump();
  assert.equal(app.markClean(revision), false);
  assert.equal(app.analysisReady, false);
});
