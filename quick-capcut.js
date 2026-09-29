const fs = require('node:fs');
const path = require('node:path');
const { analyzeLevels, exportCapCutProject } = require('./server.js');

const QUICK_DEFAULTS = Object.freeze({
  marginBefore: 0,
  marginAfter: 0,
  smoothCut: 0.35,
  smoothClip: 0.10,
});

async function runQuickCapCut(input) {
  const sourcePath = path.resolve(String(input || '').replace(/^"|"$/g, ''));
  if (!input || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error('اكتب مسار فيديو صحيح. مثال: cutcap "D:\\video.mp4"');
  }

  process.stdout.write('1/3 تحليل مستوى الصوت...\n');
  const audio = await analyzeLevels(sourcePath);
  const threshold = Number(audio?.suggestion?.recommended);
  if (!(threshold > 0)) throw new Error('مقدرتش أحدد إعداد الصوت الموصى به للفيديو.');
  process.stdout.write(`2/3 الإعداد الموصى به: ${threshold}% — جاري تجهيز القصات...\n`);

  const result = await exportCapCutProject({
    sourcePath,
    threshold,
    ...QUICK_DEFAULTS,
    keepRanges: [],
  });

  process.stdout.write(`3/3 تم: ${result.projectName}\n`);
  process.stdout.write(`القصات: ${result.clips} | الحساسية: ${threshold}% | قبل/بعد: 0/0 ثانية\n`);
  process.stdout.write(`افتح CapCut وهتلاقي المشروع في قائمة المشاريع.\n`);
  return { ...result, threshold };
}

async function main() {
  try {
    await runQuickCapCut(process.argv[2]);
  } catch (error) {
    process.stderr.write(`خطأ: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { QUICK_DEFAULTS, runQuickCapCut };
