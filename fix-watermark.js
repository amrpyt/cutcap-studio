const fs=require('fs');
let h=fs.readFileSync('index.html','utf8');
const marker='  <section class="card">\n    <div class="title">4. إخراج النتيجة</div>';
const add=`  <section class="card">\n    <div class="title">Watermark</div>\n    <div class="row"><button id="pickWatermarkBtn" type="button">اختيار اللوجو</button><div id="watermarkName" class="file grow">لم يتم اختيار لوجو.</div></div>\n    <div class="row" style="margin-top:8px"><select id="watermarkPosition"><option value="bottom-right">أسفل يمين</option><option value="bottom-left">أسفل شمال</option><option value="top-right">أعلى يمين</option><option value="top-left">أعلى شمال</option></select><button id="previewWatermarkBtn" type="button">Preview</button></div>\n    <img id="watermarkPreview" class="hidden" style="max-width:100%;margin-top:10px;border-radius:10px" />\n  </section>\n\n`;
if(!h.includes('id="pickWatermarkBtn"')) h=h.replace(marker,add+marker);
fs.writeFileSync('index.html',h,'utf8');

let s=fs.readFileSync('server.js','utf8');
s=s.replace("const candidates = ['ffmpeg.exe'];","const candidates = ['ffmpeg.exe', path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')];");
s=s.replace("['-y','-i',input,'-i',settings.path,", "['-y','-i',input,'-ignore_loop','0','-i',settings.path,");
s=s.replace("if(d.preview){$('watermarkPreview').textContent='Preview ????: '+d.preview;$('watermarkPreview').classList.remove('hidden')}","if(d.preview){$('watermarkPreview').src='file:///'+d.preview.replaceAll('\\\\','/');$('watermarkPreview').classList.remove('hidden')}");
fs.writeFileSync('server.js',s,'utf8');
