const fs=require('fs');
const p='index.html';
let h=fs.readFileSync(p,'utf8');
h=h.replace('<label for="watermarkPosition">???? ??????</label>\n        <select id="watermarkPosition">','<label>????? ??????</label>\n        <div class="watermark-controls"><label>????? <input id="watermarkScale" type="range" min="5" max="40" value="12"></label><label>???????? <input id="watermarkOpacity" type="range" min="20" max="100" value="100"></label></div>\n        <select id="watermarkPosition">');
h=h.replace('<img id="watermarkPreviewImage" alt="?????? ???? ??????"','<div id="watermarkCanvas" style="position:relative;max-width:720px;margin:auto"><img id="watermarkPreviewImage" alt="?????? ???? ??????"');
h=h.replace('</div>\n    <div class="subtitle">????????','</div><img id="watermarkDragLogo" class="hidden" style="position:absolute;cursor:move;max-width:120px">\n    </div>\n    <div class="subtitle">????????');
fs.writeFileSync(p,h,'utf8');

let a=fs.readFileSync('app.js','utf8');
a=a.replace("this.lastOutput='';this.watermarkPath='';","this.lastOutput='';this.watermarkPath='';this.watermark={x:10,y:10,scale:12,opacity:100};");
a=a.replace("$('watermarkPosition').addEventListener('change',()=>this.updateWatermarkPosition());","$('watermarkPosition').addEventListener('change',()=>this.updateWatermarkPosition());['watermarkScale','watermarkOpacity'].forEach(id=>$(id)?.addEventListener('input',()=>this.updateWatermarkTransform()));");
a=a.replace("$('watermarkPreviewImage').src=d.previewUrl;$('watermarkPreview').classList.remove('hidden')","$('watermarkPreviewImage').src=d.previewUrl;$('watermarkPreview').classList.remove('hidden');this.enableWatermarkDrag()")
a=a.replace("async updateWatermarkPosition(){if(!this.watermarkPath)return;try{await this.api.post('set-watermark',{path:this.watermarkPath,position:$(\'watermarkPosition\').value});$('watermarkPreview').classList.add('hidden')}catch(err){alert(err.message)}}","async updateWatermarkPosition(){if(!this.watermarkPath)return;try{await this.updateWatermarkTransform()}catch(err){alert(err.message)}}\n  async updateWatermarkTransform(){if(!this.watermarkPath)return;await this.api.post('set-watermark',{path:this.watermarkPath,transform:this.watermark});}\n  enableWatermarkDrag(){const el=$(\'watermarkDragLogo\');if(!el)return;let down=false,ox=0,oy=0;el.onpointerdown=e=>{down=true;ox=e.clientX-this.watermark.x;oy=e.clientY-this.watermark.y};window.onpointermove=e=>{if(!down)return;this.watermark.x=Math.max(0,e.clientX-ox);this.watermark.y=Math.max(0,e.clientY-oy);el.style.left=this.watermark.x+\'px\';el.style.top=this.watermark.y+\'px\';};window.onpointerup=()=>{down=false;this.updateWatermarkTransform()}}")
fs.writeFileSync('app.js',a,'utf8');

let s=fs.readFileSync('server.js','utf8');
s=s.replace("watermarkSettings = { path: file, position: body.position || 'bottom-right' };","watermarkSettings = { path: file, position: body.position || 'bottom-right', transform: body.transform || {x:10,y:10,scale:12,opacity:100} };");
s=s.replace("const pos = ({'top-left':'10:10','top-right':'main_w-overlay_w-10:10','bottom-left':'10:main_h-overlay_h-10','bottom-right':'main_w-overlay_w-10:main_h-overlay_h-10'})[settings.position] || 'main_w-overlay_w-10:main_h-overlay_h-10';","const t=settings.transform||{x:10,y:10,scale:12,opacity:100}; const pos=`${t.x}:${t.y}`;")
s=s.replace("const args=['-y','-i',input,...logoArgs,'-filter_complex',`overlay=${pos}:shortest=1`,'-c:a','copy',output];","const args=['-y','-i',input,...logoArgs,'-filter_complex',`scale=iw*${(t.scale||12)/100}:-1,format=rgba,colorchannelmixer=aa=${(t.opacity||100)/100}[wm];[0:v][wm]overlay=${pos}:shortest=1`,'-c:a','copy',output];")
fs.writeFileSync('server.js',s,'utf8');
