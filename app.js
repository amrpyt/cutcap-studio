(() => {
'use strict';
const $ = id => document.getElementById(id);
const clamp = (n,min,max) => Math.min(max,Math.max(min,Number.isFinite(Number(n))?Number(n):min));
const { buildKeepRanges, RevisionGuard } = window.AEGShared;

class ApiClient {
  async request(path, options={}) {
    const { timeoutMs=15000, ...fetchOptions } = options;
    const controller=typeof AbortController==='function'?new AbortController():null;
    let timeout=0;
    if(controller&&timeoutMs>0)timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response = await fetch(path,{cache:'no-store',...fetchOptions,...(controller?{signal:controller.signal}:{})});
      const type=response.headers.get('content-type')||'';
      const data=type.includes('application/json')?await response.json():{error:await response.text()};
      if(!response.ok) throw new Error(data.error||'حدث خطأ غير معروف.');
      return data;
    } catch(err) {
      if(err.name==='AbortError') { const e=new Error('انتهت مهلة الاتصال بالباك إند المحلي.');e.code='LOCAL_TIMEOUT';throw e; }
      if(err instanceof TypeError || /fetch|network|socket/i.test(String(err.message))) { const e=new Error('انقطع الاتصال بالباك إند المحلي. الإنترنت غير مطلوب لهذا البرنامج؛ قد يكون السيرفر أعاد التشغيل أو ما زال يعمل على العملية.');e.code='LOCAL_CONNECTION';throw e; }
      throw err;
    } finally { if(timeout)clearTimeout(timeout); }
  }
  get(path,options={}){return this.request(path,options)}
  post(name,body={}){return this.request('/api/'+name,{timeoutMs:body.jobId?0:15000,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
}

class CutTimeline {
  constructor(cuts=[],duration=0){this.setCuts(cuts,duration)}
  setCuts(cuts,duration){
    const sorted=[...cuts].sort((a,b)=>a.start-b.start);this.sourceDuration=Math.max(0,Number(duration)||0);this.activeCuts=sorted.filter(c=>c.enabled!==false);this.totalRemoved=this.activeCuts.reduce((s,c)=>s+c.duration,0);this.buildSegments();
  }
  buildSegments(){
    this.segments=[];this.joins=[];let src=0,edited=0;
    for(const cut of this.activeCuts){
      if(cut.start>src){const dur=cut.start-src;this.segments.push({sourceStart:src,sourceEnd:cut.start,editedStart:edited,editedEnd:edited+dur});edited+=dur;}
      this.joins.push({at:edited,cut});src=Math.max(src,cut.end);
    }
    if(src<this.sourceDuration){const dur=this.sourceDuration-src;this.segments.push({sourceStart:src,sourceEnd:this.sourceDuration,editedStart:edited,editedEnd:edited+dur});}
  }
  editedDuration(){return Math.max(0,this.sourceDuration-this.totalRemoved)}
  sourceToEdited(t){
    const x=clamp(t,0,this.sourceDuration||0);let removed=0;
    for(const c of this.activeCuts){if(x>=c.end) removed+=c.duration;else if(x>c.start){removed+=x-c.start;break}else break}
    return Math.max(0,x-removed);
  }
  editedToSource(t){
    const x=clamp(t,0,this.editedDuration());
    for(const s of this.segments){if(x>=s.editedStart && x<s.editedEnd) return s.sourceStart+(x-s.editedStart)}
    return this.sourceDuration;
  }
}

class ProxyNoticeMonitor {
  constructor(video,onTick,onNotice,onClear){this.video=video;this.onTick=onTick;this.onNotice=onNotice;this.onClear=onClear;this.timeline=null;this.running=false;this.handle=0;this.lastCut=0;this.upcoming=-1;this.useFrames=typeof video.requestVideoFrameCallback==='function'}
  setTimeline(t){this.timeline=t;this.reset()}
  reset(){this.lastCut=0;this.upcoming=-1;this.onClear?.()}
  start(){if(this.running)return;this.running=true;this.schedule()}
  stop(){this.running=false;if(this.handle){if(this.useFrames&&typeof this.video.cancelVideoFrameCallback==='function')this.video.cancelVideoFrameCallback(this.handle);else cancelAnimationFrame(this.handle);this.handle=0}this.onClear?.()}
  schedule(){if(!this.running)return;if(this.useFrames){this.handle=this.video.requestVideoFrameCallback((_,m)=>{this.tick(Number(m.mediaTime));this.schedule()})}else{this.handle=requestAnimationFrame(()=>{this.tick(Number(this.video.currentTime));this.schedule()})}}
  tick(t){if(!this.timeline)return;this.onTick?.(t);const joins=this.timeline.joins;while(this.lastCut<joins.length&&t>joins[this.lastCut].at+0.22)this.lastCut++;const j=joins[this.lastCut];if(!j){if(this.upcoming!==-1){this.upcoming=-1;this.onClear?.()}return}const diff=j.at-t;if(diff<=0.07&&diff>=-0.22){if(this.upcoming!==j.cut.index){this.upcoming=j.cut.index;this.onNotice?.(j.cut,'cut',`CUT ${j.cut.index} • تم حذف ${j.cut.duration.toFixed(2)}ث من المصدر`)}}else if(diff>0.07&&diff<=0.8){if(this.upcoming!==j.cut.index){this.upcoming=j.cut.index;this.onNotice?.(j.cut,'soon',`بعد ${diff.toFixed(1)}ث • سيتم تخطي ${j.cut.duration.toFixed(2)}ث`)}}else if(diff>0.8&&this.upcoming!==-1){this.upcoming=-1;this.onClear?.()}}
}

class WaveTimeline {
  constructor(detail,overview,seekCb){this.detail=detail;this.overview=overview;this.seekCb=seekCb;this.wave=[];this.duration=0;this.cuts=[];this.threshold=4;this.sourceTime=0;this.windowSec=60;this.bind()}
  bind(){this.detail.addEventListener('click',e=>this.clickDetail(e));this.overview.addEventListener('click',e=>this.clickOverview(e));this.detail.addEventListener('keydown',e=>this.keySeek(e));this.overview.addEventListener('keydown',e=>this.keySeek(e));window.addEventListener('resize',()=>this.draw())}
  setData({wave,duration,cuts,threshold,sourceTime,windowSec}){if(wave)this.wave=wave;if(Number.isFinite(duration))this.duration=duration;if(cuts)this.cuts=cuts;if(Number.isFinite(threshold))this.threshold=threshold;if(Number.isFinite(sourceTime))this.sourceTime=sourceTime;if(Number.isFinite(windowSec))this.windowSec=windowSec;this.draw()}
  resize(canvas,cssHeight){const dpr=Math.max(1,window.devicePixelRatio||1);const rect=canvas.getBoundingClientRect();const w=Math.max(300,Math.round(rect.width*dpr)),h=Math.round(cssHeight*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}return {ctx:canvas.getContext('2d'),w,h,dpr}}
  sourceWindow(){if(!this.duration)return [0,1];if(!this.windowSec||this.windowSec>=this.duration)return [0,this.duration];const half=this.windowSec/2;let a=this.sourceTime-half,b=this.sourceTime+half;if(a<0){b-=a;a=0}if(b>this.duration){a-=b-this.duration;b=this.duration}return [Math.max(0,a),Math.max(0,b)]}
  levelAt(t){if(!this.wave.length||!this.duration)return 0;const i=Math.min(this.wave.length-1,Math.max(0,Math.floor(t/this.duration*this.wave.length)));return Number(this.wave[i])||0}
  drawWave(ctx,w,h,a,b){ctx.clearRect(0,0,w,h);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#98a2b3';ctx.lineWidth=1;const mid=h/2;ctx.beginPath();for(let x=0;x<w;x++){const t=a+(x/w)*(b-a);const amp=Math.sqrt(Math.max(0,this.levelAt(t)));const y=Math.max(1,amp*(h*.43));ctx.moveTo(x,mid-y);ctx.lineTo(x,mid+y)}ctx.stroke()}
  drawCuts(ctx,w,h,a,b,overview=false){for(const c of this.cuts){if(c.end<a||c.start>b)continue;const x1=clamp((c.start-a)/(b-a)*w,0,w),x2=clamp((c.end-a)/(b-a)*w,0,w);if(overview){ctx.fillStyle=c.enabled===false?'#d4d4d8':'#f04438';ctx.fillRect(x1,h-7,Math.max(1,x2-x1),7)}else{ctx.fillStyle=c.enabled===false?'rgba(152,162,179,.16)':'rgba(240,68,56,.18)';ctx.fillRect(x1,0,Math.max(1,x2-x1),h);if(c.enabled!==false){ctx.fillStyle='rgba(180,35,24,.75)';ctx.fillRect(x1,0,Math.max(1,x2-x1),3)}}}}
  drawThreshold(ctx,w,h){const amp=clamp(this.threshold/100,0,1);const y=Math.sqrt(amp)*(h*.43);ctx.save();ctx.strokeStyle='#2e90fa';ctx.setLineDash([5,4]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2-y);ctx.lineTo(w,h/2-y);ctx.moveTo(0,h/2+y);ctx.lineTo(w,h/2+y);ctx.stroke();ctx.restore()}
  drawPlayhead(ctx,w,h,a,b){if(this.sourceTime<a||this.sourceTime>b)return;const x=(this.sourceTime-a)/(b-a)*w;ctx.strokeStyle='#18181b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}
  draw(){if(!this.duration||!this.detail.getClientRects().length)return;const d=this.resize(this.detail,150);const [a,b]=this.sourceWindow();this.drawWave(d.ctx,d.w,d.h,a,b);this.drawCuts(d.ctx,d.w,d.h,a,b,false);this.drawThreshold(d.ctx,d.w,d.h);this.drawPlayhead(d.ctx,d.w,d.h,a,b);const o=this.resize(this.overview,46);this.drawWave(o.ctx,o.w,o.h,0,this.duration);this.drawCuts(o.ctx,o.w,o.h,0,this.duration,true);this.drawPlayhead(o.ctx,o.w,o.h,0,this.duration);for(const c of [this.detail,this.overview]){c.setAttribute('aria-valuemax',String(Math.round(this.duration*1000)/1000));c.setAttribute('aria-valuenow',String(Math.round(this.sourceTime*1000)/1000));c.setAttribute('aria-valuetext',`${fmtClock(this.sourceTime)} من ${fmtClock(this.duration)}`)}$('detailStart').textContent=fmtClock(a);$('detailCenter').textContent=fmtClock((a+b)/2);$('detailEnd').textContent=fmtClock(b);$('timelineWindowText').textContent=this.windowSec?`نافذة ${fmtDuration(this.windowSec)} حول المؤشر`:'الفيديو كامل'}
  clickDetail(e){const r=this.detail.getBoundingClientRect();const [a,b]=this.sourceWindow();this.seekCb?.(a+clamp((e.clientX-r.left)/r.width,0,1)*(b-a))}
  clickOverview(e){const r=this.overview.getBoundingClientRect();this.seekCb?.(clamp((e.clientX-r.left)/r.width,0,1)*this.duration)}
  keySeek(e){if(!this.duration)return;let next=this.sourceTime,handled=true;const step=e.shiftKey?5:1;if(e.key==='ArrowLeft'||e.key==='ArrowDown')next-=step;else if(e.key==='ArrowRight'||e.key==='ArrowUp')next+=step;else if(e.key==='Home')next=0;else if(e.key==='End')next=this.duration;else handled=false;if(handled){e.preventDefault();this.seekCb?.(clamp(next,0,this.duration))}}
}

function fmtClock(seconds){const s=Math.max(0,Number(seconds)||0),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`}
function fmtDuration(seconds){const s=Math.max(0,Number(seconds)||0);if(s<60)return `${s.toFixed(s<10?1:0)}ث`;return fmtClock(s)}

function fmtBytes(bytes){
  const n=Number(bytes);
  if(!Number.isFinite(n)||n<=0)return '—';
  const units=['B','KB','MB','GB'];
  let value=n,i=0;
  while(value>=1024&&i<units.length-1){value/=1024;i++}
  return `${value.toFixed(i===0?0:value>=100?0:value>=10?1:2)} ${units[i]}`;
}
function fmtJobTime(seconds){
  const s=Math.max(0,Math.round(Number(seconds)||0));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;
}
function cleanDownloadLog(text){
  return String(text||'').replace(/https?:\/\/\S+/g,'[media URL]').slice(-16000);
}

class YoutubeDownloaderPanel{
  constructor(api){
    this.api=api;this.jobId='';this.pollTimer=0;this.busy=false;this.outputDir='';this.lastOutput='';this.lastStatus=null;
    this.bind();this.syncMode();
  }
  bind(){
    $('ytKind').addEventListener('change',()=>this.syncMode());
    $('ytPasteBtn').addEventListener('click',()=>this.pasteUrl());
    $('ytInspectBtn').addEventListener('click',()=>this.inspect());
    $('ytStartBtn').addEventListener('click',()=>this.start());
    $('ytCancelBtn').addEventListener('click',()=>this.cancel());
    $('ytPickFolderBtn').addEventListener('click',()=>this.pickFolder());
    $('ytOpenFolderBtn').addEventListener('click',()=>this.openFolder());
    $('ytUpdateBtn').addEventListener('click',()=>this.updateEngine());
    $('ytUrl').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.inspect()}});
    $('ytUrl').addEventListener('input',()=>{$('ytMeta').classList.add('hidden');this.clearMessage()});
  }
  init(cfg={}){
    this.outputDir=cfg.downloadsDir||'';
    $('ytOutputPath').textContent=this.outputDir||'Downloads';
    $('ytOutputPath').title=this.outputDir||'';
    $('ytEngineVersion').textContent=cfg.ytDlpVersion||'—';
    $('ytEnginePath').textContent=cfg.ytDlpPath||'—';
    $('ytEnginePath').title=cfg.ytDlpPath||'';
    $('ytFfmpegPath').textContent=cfg.ffmpegPath||'—';
    $('ytFfmpegPath').title=cfg.ffmpegPath||'';
    const st=$('ytEngineStatus');
    if(cfg.ytDlpFound){st.textContent='جاهز • '+(cfg.ytDlpVersion||'yt-dlp');st.className='status ok'}
    else{st.textContent='محرك YouTube غير جاهز';st.className='status bad';this.showMessage(cfg.ytDlpError||'yt-dlp غير موجود.','warn')}
  }
  syncMode(){
    const kind=$('ytKind').value;
    const isClip=kind==='clip',isAudio=kind==='audio';
    $('ytClipRange').classList.toggle('hidden',!isClip);
    $('ytQualityField').classList.toggle('hidden',isAudio);
    $('ytExact').disabled=this.busy||!isClip;
    $('ytStartBtn').textContent=kind==='clip'?'ابدأ تنزيل المقطع':kind==='audio'?'ابدأ تنزيل الصوت':'ابدأ تنزيل الفيديو';
  }
  showMessage(text,type='err'){const el=$('ytMessage');el.textContent=text;el.className='message '+type}
  clearMessage(){$('ytMessage').className='message hidden'}
  async pasteUrl(){
    try{
      const text=await navigator.clipboard.readText();
      if(text){$('ytUrl').value=text.trim();$('ytMeta').classList.add('hidden');this.clearMessage()}
    }catch{this.showMessage('المتصفح لم يسمح بقراءة الحافظة. الصق الرابط يدويًا.','warn')}
  }
  async inspect(){
    const url=$('ytUrl').value.trim();
    if(!url)return this.showMessage('ضع رابط YouTube أولًا.');
    const btn=$('ytInspectBtn');btn.disabled=true;this.clearMessage();
    try{
      btn.textContent='جاري القراءة…';
      const d=await this.api.post('youtube-info',{url});
      $('ytMetaTitle').textContent=d.title||'YouTube video';
      $('ytMetaChannel').textContent=d.channel||'';
      $('ytMetaDuration').textContent=d.duration?`المدة: ${fmtJobTime(d.duration)}`:'';
      const img=$('ytThumb');
      if(d.thumbnail){img.src=d.thumbnail;img.alt=d.title||'صورة الفيديو'}else{img.removeAttribute('src');img.alt=''}
      $('ytMeta').classList.remove('hidden');
    }catch(err){this.showMessage(err.message)}
    finally{btn.disabled=this.busy;btn.textContent='جلب المعلومات'}
  }
  async pickFolder(){
    try{
      const d=await this.api.post('pick-folder',{initial:this.outputDir});
      if(d.cancelled)return;
      this.outputDir=d.path||this.outputDir;
      $('ytOutputPath').textContent=this.outputDir;$('ytOutputPath').title=this.outputDir;
    }catch(err){this.showMessage(err.message)}
  }
  setBusy(on){
    this.busy=on;
    document.querySelectorAll('[data-yt-control]').forEach(el=>el.disabled=on);editorTab.disabled=on;
    $('ytCancelBtn').classList.toggle('hidden',!on);
    if(!on)this.syncMode();
  }
  resetProgress(){
    this.lastStatus=null;
    $('ytProgress').value=0;$('ytPercent').textContent='0%';$('ytProgressTitle').textContent='جاري التحضير';
    $('ytPhase').textContent='تحضير';$('ytProgressSub').textContent='جاري الاتصال بـ YouTube…';
    for(const id of ['ytProcessed','ytMediaSize','ytNetwork','ytSpeed','ytEta','ytElapsed'])$(id).textContent='—';
    $('ytLastLine').textContent='Starting…';$('ytSuccess').classList.add('hidden');$('ytLog').textContent='جاري بدء التنزيل…';
  }
  phaseName(value){return ({preparing:'جلب المعلومات',downloading:'تنزيل',merging:'دمج',done:'اكتمل'})[value]||'تنفيذ'}
  renderStatus(status={}){
    this.lastStatus=status;
    const d=status.details||{},progress=Number(status.progress);
    if(Number.isFinite(progress)){$('ytProgress').value=Math.max(0,Math.min(100,progress));$('ytPercent').textContent=Math.round(progress)+'%'}
    else $('ytProgress').removeAttribute('value');
    const phase=this.phaseName(d.phase);
    $('ytPhase').textContent=phase;
    $('ytProgressTitle').textContent=status.running?(status.label||phase):(d.phase==='done'?'اكتمل التنزيل':'جاري إنهاء المهمة');
    $('ytProgressSub').textContent=d.clipDurationSec>0?'يتم تنزيل النطاق المطلوب فقط.':'يتم تنزيل المصدر المحدد.';
    $('ytProcessed').textContent=d.processedSeconds!=null?(fmtJobTime(d.processedSeconds)+(d.clipDurationSec?` / ${fmtJobTime(d.clipDurationSec)}`:'')):'—';
    $('ytMediaSize').textContent=fmtBytes(d.outputBytes);
    const reported=Number(d.reportedDownloadBytes)||0,device=Number(d.networkRxBytes)||0;
    $('ytNetwork').textContent=reported?fmtBytes(reported):(device?'≈ '+fmtBytes(device):'—');
    const speedParts=[];
    if(Number(d.processSpeed)>0)speedParts.push(Number(d.processSpeed).toFixed(2)+'×');
    if(Number(d.downloadBytesPerSecond)>0)speedParts.push(fmtBytes(d.downloadBytesPerSecond)+'/s');
    $('ytSpeed').textContent=speedParts.join(' · ')||'—';
    $('ytEta').textContent=Number.isFinite(Number(d.etaSeconds))?fmtJobTime(d.etaSeconds):'—';
    $('ytElapsed').textContent=status.elapsedMs?fmtJobTime(status.elapsedMs/1000):'—';
    if(d.lastLine)$('ytLastLine').textContent=d.lastLine;
  }
  startPolling(jobId){
    this.stopPolling();
    const poll=async()=>{if(this.jobId!==jobId)return;try{const d=await this.api.get('/api/job-status?jobId='+encodeURIComponent(jobId),{timeoutMs:5000});if(this.jobId===jobId)this.renderStatus(d)}catch{}};
    poll();this.pollTimer=setInterval(poll,500);
  }
  stopPolling(){if(this.pollTimer){clearInterval(this.pollTimer);this.pollTimer=0}}
  async start(){
    if(this.busy)return;
    const url=$('ytUrl').value.trim(),kind=$('ytKind').value;
    if(!url)return this.showMessage('ضع رابط YouTube أولًا.');
    if(kind==='clip'&&(!$('ytStart').value.trim()||!$('ytEnd').value.trim()))return this.showMessage('حدد وقت البداية والنهاية.');
    const jobId=(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.jobId=jobId;this.lastOutput='';this.clearMessage();this.resetProgress();this.setBusy(true);this.startPolling(jobId);
    const body={jobId,url,kind,quality:$('ytQuality').value,exact:kind==='clip'&&$('ytExact').checked,outputDir:this.outputDir};
    if(kind==='clip'){body.start=$('ytStart').value.trim();body.end=$('ytEnd').value.trim()}
    try{
      const result=await this.api.post('youtube-download',body);
      const finalStatus=await this.api.get('/api/job-status?jobId='+encodeURIComponent(jobId),{timeoutMs:5000}).catch(()=>null);
      if(finalStatus)this.renderStatus(finalStatus);
      $('ytProgress').value=100;$('ytPercent').textContent='100%';$('ytPhase').textContent='اكتمل';$('ytProgressTitle').textContent='تم التنزيل بنجاح';
      this.lastOutput=result.outputPath||'';if(result.outputDir)this.outputDir=result.outputDir;
      if(this.outputDir){$('ytOutputPath').textContent=this.outputDir;$('ytOutputPath').title=this.outputDir}
      $('ytMediaSize').textContent=fmtBytes(result.finalSize)||$('ytMediaSize').textContent;
      if(result.reportedDownloadBytes)$('ytNetwork').textContent=fmtBytes(result.reportedDownloadBytes);else if(result.networkRxBytes)$('ytNetwork').textContent='≈ '+fmtBytes(result.networkRxBytes);
      $('ytSuccess').textContent=this.lastOutput?`تم الحفظ: ${this.lastOutput}`:'تم التنزيل بنجاح.';
      $('ytSuccess').classList.remove('hidden');
      $('ytLog').textContent=cleanDownloadLog(result.output||'تم بنجاح.');
    }catch(err){
      $('ytLog').textContent='ERROR:\n'+cleanDownloadLog(err.message);
      if(!/تم إلغاء/.test(err.message))this.showMessage(err.message);
      $('ytProgressTitle').textContent=/تم إلغاء/.test(err.message)?'تم إلغاء التنزيل':'فشل التنزيل';
      $('ytPhase').textContent=/تم إلغاء/.test(err.message)?'ملغي':'خطأ';
    }finally{this.stopPolling();if(this.jobId===jobId)this.jobId='';this.setBusy(false)}
  }
  async cancel(){if(!this.jobId)return;$('ytCancelBtn').disabled=true;$('ytProgressTitle').textContent='جاري الإلغاء…';try{await this.api.post('cancel',{jobId:this.jobId})}catch(err){this.showMessage(err.message)}}
  async openFolder(){try{await this.api.post('open-folder',{target:this.lastOutput||this.outputDir})}catch(err){this.showMessage(err.message)}}
  async updateEngine(){
    const btn=$('ytUpdateBtn');if(this.busy)return;btn.disabled=true;this.clearMessage();
    try{btn.textContent='جاري التحديث…';const d=await this.api.post('youtube-update');$('ytEngineVersion').textContent=d.version||'—';const st=$('ytEngineStatus');st.textContent='جاهز • '+(d.version||'yt-dlp');st.className='status ok';$('ytLog').textContent=cleanDownloadLog(d.output||'تم تحديث yt-dlp.')}
    catch(err){this.showMessage(err.message)}
    finally{btn.disabled=false;btn.textContent='تحديث المحرك'}
  }
}

class App {
  constructor(){
    this.api=new ApiClient();this.player=$('player');this.cuts=[];this.timeline=new CutTimeline();this.wave=[];this.audioSuggestion=null;
    this.videoPath='';this.mediaToken='';this.previewToken='';this.analysisDirty=false;this.playerMode='source';this.lastOutput='';this.watermarkPath='';this.watermarkToken='';this.watermark={x:.02,y:.03,scale:12,opacity:100};this.watermarkDrag=null;this.watermarkSaveTimer=0;this.currentStep=1;
    this.settingsRevision=new RevisionGuard();this.auditionRevision=new RevisionGuard();this.activeJobId='';this.jobPollTimer=0;this.noticeTimer=0;this.auditionHandler=null;
    this.timelineView=new WaveTimeline($('detailCanvas'),$('overviewCanvas'),t=>this.seekSource(t));
    this.proxyMonitor=new ProxyNoticeMonitor(this.player,t=>this.updateFromPlayer(t),(cut,type,text)=>this.showNotice(text,type==='cut'?'cut':''),()=>this.clearNotice());
    this.analysisReady=false;this.busy=false;this.youtubePanel=new YoutubeDownloaderPanel(this.api);this.workspaceMode='editor';
    this.bind();if(new URLSearchParams(location.search).get('view')==='youtube')this.switchWorkspace('youtube');this.setBusy(true,'جاري فحص البرنامج…');this.init();
  }
  bind(){
    $('editorTab').addEventListener('click',()=>this.switchWorkspace('editor'));$('youtubeTab').addEventListener('click',()=>this.switchWorkspace('youtube'));
    document.querySelectorAll('[data-step-target]').forEach(b=>b.addEventListener('click',()=>this.goToStep(Number(b.dataset.stepTarget))));$('previousStepBtn').addEventListener('click',()=>this.goToStep(this.currentStep-1));$('nextStepBtn').addEventListener('click',()=>this.goToStep(this.currentStep+1));$('cutsCard').prepend($('reviewPanel'));$('viewerSlot').append($('videoWrap'));
    $('pickVideoBtn').addEventListener('click',()=>this.pickVideo());$('pickWatermarkBtn').addEventListener('click',()=>this.pickWatermark());$('previewWatermarkBtn').addEventListener('click',()=>this.previewWatermark());$('confirmWatermarkBtn').addEventListener('click',()=>this.confirmWatermark());$('watermarkScale').addEventListener('input',e=>this.changeWatermarkScale(e.target.value));$('watermarkOpacity').addEventListener('input',e=>this.changeWatermarkOpacity(e.target.value));$('pickExeBtn').addEventListener('click',()=>this.pickExe());$('manualPathBtn').addEventListener('click',()=>this.useManualPath());
    $('cancelJobBtn').addEventListener('click',()=>this.cancelActiveJob());
    $('autoThresholdBtn').addEventListener('click',()=>this.analyzeAudio(true));
    document.querySelectorAll('[data-suggestion]').forEach(b=>b.addEventListener('click',()=>this.applySuggestion(b.dataset.suggestion)));
    $('threshold').addEventListener('input',e=>{$('thresholdValue').textContent=Number(e.target.value).toFixed(1).replace('.0','')+'%';this.timelineView.setData({threshold:Number(e.target.value)});this.markDirty()});
    document.querySelectorAll('[data-setting]').forEach(el=>{if(el.id!=='threshold')el.addEventListener('input',()=>this.markDirty())});
    document.querySelectorAll('.presetBtn').forEach(b=>b.addEventListener('click',()=>this.setPreset(Number(b.dataset.preset))));
    $('analyzeBtn').addEventListener('click',()=>this.analyzeCuts());
    $('smoothPreviewBtn').addEventListener('click',()=>this.startSmoothPreview(true));$('previewHereBtn').addEventListener('click',()=>this.startSmoothPreview(false));$('sourceBtn').addEventListener('click',()=>this.switchToSource());$('previewSpeed').addEventListener('change',e=>this.player.playbackRate=clamp(e.target.value,.25,4));
    $('timelineZoom').addEventListener('change',e=>this.timelineView.setData({windowSec:Number(e.target.value)}));
    $('cutsBody').addEventListener('click',e=>this.handleCutTableClick(e));
    $('renderBtn').addEventListener('click',()=>this.runOutput('render'));$('capcutBtn').addEventListener('click',()=>this.runOutput('capcut'));$('pickOutputBtn').addEventListener('click',()=>this.pickOutput());$('openFolderBtn').addEventListener('click',()=>this.openFolder());
    this.player.addEventListener('play',()=>{if(this.playerMode==='proxy')this.proxyMonitor.start()});
    this.player.addEventListener('pause',()=>{this.proxyMonitor.stop();this.removeAuditionHandler()});
    this.player.addEventListener('ended',()=>{this.proxyMonitor.stop();this.removeAuditionHandler()});
    this.player.addEventListener('pointerdown',()=>this.cancelAudition());this.player.addEventListener('keydown',()=>this.cancelAudition());
    this.player.addEventListener('timeupdate',()=>this.updateFromPlayer(this.player.currentTime));this.player.addEventListener('seeking',()=>{this.proxyMonitor.reset();this.updateFromPlayer(this.player.currentTime)});
    $('watermarkDragLogo').addEventListener('pointerdown',e=>this.startWatermarkDrag(e));window.addEventListener('pointermove',e=>this.moveWatermarkDrag(e));window.addEventListener('pointerup',e=>this.endWatermarkDrag(e));
    window.addEventListener('pointercancel',e=>this.endWatermarkDrag(e));$('watermarkDragLogo').addEventListener('keydown',e=>this.moveWatermarkByKey(e));
    window.addEventListener('unhandledrejection',e=>console.error(e.reason));
    window.addEventListener('pagehide',()=>this.releasePreviewOnClose());
  }
  async init(){this.syncStep();try{await this.api.get('/api/health');const cfg=await this.api.get('/api/config');this.youtubePanel.init(cfg);this.clearServerError();$('exePath').textContent=cfg.autoEditorPath||'لم يتم العثور على Auto-Editor.';if(cfg.autoEditorFound){$('systemStatus').textContent='جاهز'+(cfg.autoEditorVersion?' • '+cfg.autoEditorVersion:'');$('systemStatus').className='status ok';$('exeHint').textContent='Auto-Editor متصل وجاهز.'}else{$('systemStatus').textContent='Auto-Editor غير محدد';$('systemStatus').className='status bad';$('systemDetails').open=true}await this.restoreWatermark();if(new URLSearchParams(location.search).get('view')==='youtube')this.switchWorkspace('youtube')}catch(err){this.showServerError(err.message);$('systemStatus').textContent='غير متصل';$('systemStatus').className='status bad'}finally{this.setBusy(false)}}
  switchWorkspace(mode){
    const next=mode==='youtube'?'youtube':'editor';this.workspaceMode=next;
    $('editorWorkspace').classList.toggle('hidden',next!=='editor');$('youtubeWorkspace').classList.toggle('hidden',next!=='youtube');
    $('editorTab').classList.toggle('active',next==='editor');$('youtubeTab').classList.toggle('active',next==='youtube');
    $('editorTab').setAttribute('aria-selected',next==='editor'?'true':'false');$('youtubeTab').setAttribute('aria-selected',next==='youtube'?'true':'false');
    if(next==='youtube')this.pauseWorkspace();
  }
  maxUnlockedStep(){return !this.videoPath?1:!this.analysisReady||this.analysisDirty?2:5}
  pauseWorkspace(){this.cancelAudition();this.player.pause();$('watermarkVideo').pause();this.proxyMonitor.stop()}
  goToStep(step){
    if(this.busy)return;
    const target=clamp(Number(step)||1,1,5);
    if(target>this.maxUnlockedStep()){this.showMessage(this.videoPath?'حلّل الفيديو أولًا للمتابعة.':'اختر فيديو أولًا.');return}
    this.pauseWorkspace();this.currentStep=target;this.clearMessage();this.syncStep();$('stageTitle').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});
  }
  syncStep(){
    const copy=[null,['اختيار الفيديو','ابدأ بالملف الأصلي. ستُحفظ النتيجة في ملف جديد.'],['إعداد القص','اضبط حساسية الصمت، ثم حلّل الفيديو للانتقال إلى المراجعة.'],['مراجعة النتيجة','شاهد الفيديو واستمع للوصلات. يمكنك الاحتفاظ بأي جزء محذوف.'],['إضافة اللوجو','اسحب اللوجو لضبط مكانه. إذا لم تختر لوجو، يمكنك المتابعة بدونه.'],['جاهز للتصدير','راجع النتيجة ومكان الحفظ قبل إنشاء الفيديو النهائي.']][this.currentStep],max=this.maxUnlockedStep();
    document.querySelectorAll('.workflowStep').forEach(el=>el.classList.toggle('active',Number(el.dataset.step)===this.currentStep));
    document.querySelectorAll('[data-step-target]').forEach(el=>{const n=Number(el.dataset.stepTarget);el.classList.toggle('active',n===this.currentStep);el.classList.toggle('done',n<this.currentStep);el.disabled=this.busy||n>max;if(n===this.currentStep)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current')});
    $('stageEyebrow').textContent=`المرحلة ${this.currentStep} من 5`;$('stageTitle').textContent=copy[0];$('stageDescription').textContent=copy[1];
    $('viewerSlot').classList.toggle('hidden',!this.videoPath||![1,3].includes(this.currentStep));
    $('projectStrip').classList.toggle('hidden',!this.videoPath);$('projectName').textContent=$('videoName').textContent;
    document.querySelector('.page').classList.toggle('hasVideo',!!this.videoPath);
    $('projectState').textContent=this.analysisDirty?'• يحتاج إعادة تحليل':this.analysisReady?'• التحليل جاهز':'• المصدر الأصلي';
    $('previousStepBtn').classList.toggle('hidden',this.currentStep===1);$('previousStepBtn').disabled=this.busy;
    $('nextStepBtn').classList.toggle('hidden',this.currentStep===5||this.currentStep===2);$('nextStepBtn').disabled=this.busy||this.currentStep>=max;
    $('nextStepBtn').textContent=({1:'إعداد القص ←',3:'متابعة إلى اللوجو ←',4:'مراجعة التصدير ←'})[this.currentStep]||'التالي';
    $('footerHint').textContent=this.currentStep===2?'حلّل الفيديو للمتابعة':this.currentStep===5?'التصدير يعمل محليًا على جهازك':'يمكنك الرجوع لأي مرحلة متاحة';
    for(const id of ['renderBtn','capcutBtn','smoothPreviewBtn','previewHereBtn'])$(id).disabled=this.busy||!this.analysisReady||this.analysisDirty;
    $('previewWatermarkBtn').disabled=this.busy||!this.watermarkToken;
    if(this.currentStep===3)requestAnimationFrame(()=>this.timelineView.draw());
    if(this.currentStep===4)this.showWatermarkEditor();
    if(this.currentStep===5){$('exportSource').textContent=fmtDuration(this.timeline.sourceDuration);$('exportDuration').textContent=fmtDuration(this.timeline.editedDuration());$('exportCuts').textContent=this.cuts.filter(c=>c.enabled!==false).length;$('exportLogo').textContent=this.watermarkPath?'اللوجو: '+$('watermarkName').textContent:'بدون لوجو'}
  }
  showMessage(text,type='err'){const el=$('actionMessage');el.textContent=text;el.className='message '+type}
  clearMessage(){$('actionMessage').classList.add('hidden')}
  showServerError(m){$('serverError').textContent=m;$('serverError').classList.remove('hidden')}clearServerError(){$('serverError').classList.add('hidden')}
  setBusy(on,text='جاري التنفيذ…',cancellable=false){this.busy=on;if(on){this.pauseWorkspace();this.clearMessage()}const panel=$('busyPanel'),progress=$('jobProgress'),cancel=$('cancelJobBtn');document.querySelector('.page').setAttribute('aria-busy',on?'true':'false');panel.classList.toggle('hidden',!on);$('busyText').textContent=on?text:'';document.querySelectorAll('button,input,select').forEach(el=>el.disabled=on);cancel.disabled=!cancellable;cancel.classList.toggle('hidden',!cancellable);if(on)progress.removeAttribute('value');else{progress.removeAttribute('value');cancel.classList.add('hidden');this.syncStep();this.youtubePanel?.syncMode()}}
  settings(mode,jobId=''){return{mode,jobId,sourcePath:this.videoPath,output:$('outputPath').dataset.path||'',threshold:Number($('threshold').value),marginBefore:Number($('marginBefore').value),marginAfter:Number($('marginAfter').value),smoothCut:Number($('smoothCut').value),smoothClip:Number($('smoothClip').value),keepRanges:buildKeepRanges(this.cuts)}}
  markDirty(){this.settingsRevision.bump();if(!this.analysisReady)return;this.analysisDirty=true;this.releaseProxy(this.playerMode==='proxy'?this.currentSourceTime():null);$('dirtyNotice').classList.remove('hidden');$('exportSuccess').classList.add('hidden');this.syncStep()}
  markClean(revision){if(!this.settingsRevision.isCurrent(revision))return false;this.analysisReady=true;this.analysisDirty=false;$('dirtyNotice').classList.add('hidden');return true}
  setPreset(v){$('threshold').value=v;$('thresholdValue').textContent=v+'%';$('marginBefore').value='0.20';$('marginAfter').value='0.40';$('smoothCut').value='0.35';$('smoothClip').value='0.10';this.timelineView.setData({threshold:v});this.markDirty()}
  resetAll(){this.pauseWorkspace();this.releaseProxy();this.cuts=[];this.timeline=new CutTimeline();this.wave=[];this.audioSuggestion=null;this.analysisReady=false;this.analysisDirty=false;this.currentStep=1;this.lastOutput='';this.settingsRevision.bump();this.playerMode='source';$('reviewPanel').classList.add('hidden');$('cutsCard').classList.add('hidden');$('autoResult').classList.add('hidden');$('confidenceText').textContent='';$('dirtyNotice').classList.add('hidden');$('riskWarning').classList.add('hidden');$('exportSuccess').classList.add('hidden');this.clearMessage();this.clearNotice()}
  applyVideo(data){if(!data?.path||!data.mediaToken)return;this.resetAll();this.videoPath=data.path;this.mediaToken=data.mediaToken;$('videoName').textContent=data.name||data.path;$('videoName').title=data.path;$('manualVideoPath').value=data.path;$('outputPath').textContent=data.outputPath||'—';$('outputPath').dataset.path=data.outputPath||'';this.setPlayerSource('source',0).catch(()=>{});$('videoWrap').classList.remove('hidden');this.syncWatermarkVideo();if(this.watermarkToken)this.showWatermarkEditor();this.syncStep();$('log').textContent='تم اختيار الفيديو. انتقل إلى إعداد القص.'}
  async pickWatermark(){
    await this.simpleAction('اختيار اللوجو…',async()=>{const d=await this.api.post('pick-watermark',{initial:this.watermarkPath});if(d.cancelled)return;const changed=d.path!==this.watermarkPath;this.watermarkPath=d.path;this.watermarkToken=d.mediaToken||'';if(changed)this.watermark={x:.02,y:.03,scale:12,opacity:100};$('watermarkName').textContent=d.name;await this.updateWatermarkTransform();this.showWatermarkEditor()})
  }
  async restoreWatermark(){try{const d=await this.api.post('get-watermark');if(!d.watermark?.path)return;this.watermarkPath=d.watermark.path;this.watermarkToken=d.mediaToken||'';this.watermark={x:Number(d.watermark.transform?.x??.02),y:Number(d.watermark.transform?.y??.03),scale:Number(d.watermark.transform?.scale??12),opacity:Number(d.watermark.transform?.opacity??100)};$('watermarkName').textContent=d.name||this.watermarkPath.split(/[\\/]/).pop();this.syncWatermarkControls();this.syncWatermarkVideo()}catch{}}
  syncWatermarkVideo(){if(this.currentStep!==4)return;const v=$('watermarkVideo');if(!this.mediaToken){v.removeAttribute('src');v.load();return}const src='/api/media?token='+encodeURIComponent(this.mediaToken);if(v.dataset.token!==this.mediaToken){v.dataset.token=this.mediaToken;v.src=src;v.load()}}
  syncWatermarkControls(){$('watermarkScale').value=this.watermark.scale;$('watermarkOpacity').value=this.watermark.opacity;$('watermarkScaleValue').textContent=this.watermark.scale+'%';$('watermarkOpacityValue').textContent=Math.round(this.watermark.opacity)+'%';this.applyWatermarkVisual()}
  applyWatermarkVisual(){const logo=$('watermarkDragLogo');if(!logo)return;logo.style.left=(this.watermark.x*100)+'%';logo.style.top=(this.watermark.y*100)+'%';logo.style.width=this.watermark.scale+'%';logo.style.opacity=String(this.watermark.opacity/100)}
  showWatermarkEditor(){if(!this.videoPath||!this.watermarkToken)return;this.syncWatermarkVideo();const logo=$('watermarkDragLogo');logo.src='/api/media?token='+encodeURIComponent(this.watermarkToken);logo.classList.remove('hidden');$('watermarkEditor').classList.remove('hidden');this.syncWatermarkControls()}
  changeWatermarkScale(value){this.watermark.scale=clamp(value,2,40);$('watermarkScaleValue').textContent=this.watermark.scale+'%';this.applyWatermarkVisual();requestAnimationFrame(()=>{this.clampWatermarkPosition();this.applyWatermarkVisual()});this.scheduleWatermarkSave()}
  changeWatermarkOpacity(value){this.watermark.opacity=clamp(value,10,100);$('watermarkOpacityValue').textContent=Math.round(this.watermark.opacity)+'%';this.applyWatermarkVisual();this.scheduleWatermarkSave()}
  moveWatermarkByKey(e){if(this.busy||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const step=e.shiftKey?.02:.005;this.watermark.x+=e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0;this.watermark.y+=e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0;this.clampWatermarkPosition();this.applyWatermarkVisual();this.scheduleWatermarkSave()}
  clampWatermarkPosition(){const stage=$('watermarkCanvas'),logo=$('watermarkDragLogo');if(!stage||!logo||stage.clientWidth<=0||stage.clientHeight<=0)return;const maxX=Math.max(0,1-logo.offsetWidth/stage.clientWidth),maxY=Math.max(0,1-logo.offsetHeight/stage.clientHeight);this.watermark.x=clamp(this.watermark.x,0,maxX);this.watermark.y=clamp(this.watermark.y,0,maxY)}
  startWatermarkDrag(e){if(!this.busy&&!$('watermarkEditor').classList.contains('hidden')){const logo=$('watermarkDragLogo'),r=logo.getBoundingClientRect();this.watermarkDrag={pointerId:e.pointerId,offsetX:e.clientX-r.left,offsetY:e.clientY-r.top};logo.classList.add('dragging');try{logo.setPointerCapture(e.pointerId)}catch{};e.preventDefault()}}
  moveWatermarkDrag(e){if(!this.watermarkDrag||e.pointerId!==this.watermarkDrag.pointerId)return;const stage=$('watermarkCanvas'),logo=$('watermarkDragLogo'),r=stage.getBoundingClientRect();if(!r.width||!r.height)return;const left=clamp(e.clientX-r.left-this.watermarkDrag.offsetX,0,Math.max(0,r.width-logo.offsetWidth));const top=clamp(e.clientY-r.top-this.watermarkDrag.offsetY,0,Math.max(0,r.height-logo.offsetHeight));this.watermark.x=left/r.width;this.watermark.y=top/r.height;this.applyWatermarkVisual();$('watermarkStatus').textContent='المكان اتغير — هيتم حفظه تلقائيًا.'}
  endWatermarkDrag(e){if(!this.watermarkDrag||e.pointerId!==this.watermarkDrag.pointerId)return;$('watermarkDragLogo').classList.remove('dragging');this.watermarkDrag=null;this.scheduleWatermarkSave(0)}
  scheduleWatermarkSave(delay=180){$('exportSuccess').classList.add('hidden');clearTimeout(this.watermarkSaveTimer);this.watermarkSaveTimer=setTimeout(()=>this.updateWatermarkTransform().catch(err=>this.showMessage(err.message)),delay)}
  async updateWatermarkTransform(){if(!this.watermarkPath)return;this.clampWatermarkPosition();await this.api.post('set-watermark',{path:this.watermarkPath,transform:this.watermark});$('watermarkStatus').textContent='تم حفظ مكان وحجم وشفافية اللوجو.'}
  async confirmWatermark(){if(!this.watermarkPath)return this.showMessage('اختار اللوجو الأول.');try{await this.updateWatermarkTransform();$('watermarkStatus').textContent='تم اعتماد إعدادات اللوجو ✅'}catch(err){this.showMessage(err.message)}}
  async previewWatermark(){
    if(!this.videoPath)return this.showMessage('اختار فيديو الأول.');if(!this.watermarkPath||!this.watermarkToken)return this.showMessage('اختار اللوجو الأول.');this.showWatermarkEditor();$('watermarkEditor').scrollIntoView({behavior:'smooth',block:'nearest'})
  }
  async pickVideo(){await this.simpleAction('افتح نافذة اختيار الفيديو…',async()=>{const d=await this.api.post('pick-video',{initial:this.videoPath});if(!d.cancelled)this.applyVideo(d)})}
  async pickExe(){await this.simpleAction('اختيار Auto-Editor…',async()=>{const d=await this.api.post('pick-exe');if(d.cancelled)return;$('exePath').textContent=d.path;$('systemStatus').textContent='جاهز'+(d.version?' • '+d.version:'');$('systemStatus').className='status ok'})}
  async useManualPath(){const p=$('manualVideoPath').value.trim();if(!p)return this.showMessage('اكتب مسار الفيديو أولًا.');await this.simpleAction('فتح الفيديو…',async()=>this.applyVideo(await this.api.post('set-video-path',{path:p})))}
  async pickOutput(){if(!this.videoPath)return this.showMessage('اختار فيديو الأول.');await this.simpleAction('اختار مكان الحفظ…',async()=>{const d=await this.api.post('pick-output',{sourcePath:this.videoPath,initial:$('outputPath').dataset.path||''});if(!d.cancelled){this.lastOutput='';$('exportSuccess').classList.add('hidden');$('outputPath').textContent=d.path;$('outputPath').dataset.path=d.path}})}
  async simpleAction(label,fn){try{this.setBusy(true,label);await fn();this.clearServerError()}catch(err){$('log').textContent='ERROR:\n'+err.message;if(err.code==='LOCAL_CONNECTION'||err.code==='LOCAL_TIMEOUT')this.showServerError(err.message);else this.showMessage(err.message)}finally{this.setBusy(false)}}
  async waitForJobResult(jobId,label){
    const deadline=Date.now()+2*60*60*1000;let unknown=0;
    while(Date.now()<deadline){
      try{
        const d=await this.api.get('/api/job-result?jobId='+encodeURIComponent(jobId),{timeoutMs:5000});
        if(d.state==='done')return d.result;
        if(d.state==='error')throw new Error(d.error||'فشلت العملية على الباك إند.');
        if(d.state==='unknown'&&++unknown>=5)throw new Error('الباك إند أعاد التشغيل قبل إكمال العملية، لذلك لا توجد نتيجة يمكن استعادتها. راجع server-error.log لمعرفة السبب.');
        $('busyText').textContent=`${label} • الاتصال عاد، نتحقق من النتيجة…`;
      }catch(err){
        if(err.code!=='LOCAL_CONNECTION'&&err.code!=='LOCAL_TIMEOUT')throw err;
        $('busyText').textContent=`${label} • إعادة الاتصال…`;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('العملية تجاوزت وقت الانتظار. افحص server-error.log قبل إعادة المحاولة.');
  }
  async runJob(label,fn){const jobId=(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;this.activeJobId=jobId;this.setBusy(true,label,true);this.startJobPolling(jobId,label);try{return await fn(jobId)}catch(err){if(err.code==='LOCAL_CONNECTION'||err.code==='LOCAL_TIMEOUT')return await this.waitForJobResult(jobId,label);throw err}finally{this.stopJobPolling();if(this.activeJobId===jobId)this.activeJobId='';this.setBusy(false)}}
  startJobPolling(jobId,fallbackLabel){this.stopJobPolling();let failures=0;const poll=async()=>{if(this.activeJobId!==jobId)return;try{const d=await this.api.get('/api/job-status?jobId='+encodeURIComponent(jobId),{timeoutMs:5000});failures=0;if(this.activeJobId!==jobId)return;const progress=$('jobProgress');if(d.progress!=null&&Number.isFinite(Number(d.progress))){progress.value=Number(d.progress);$('busyText').textContent=`${d.label||fallbackLabel} • ${Math.round(Number(d.progress))}%`}else{progress.removeAttribute('value');$('busyText').textContent=d.label||fallbackLabel}}catch(err){if(++failures>=2)$('busyText').textContent=`${fallbackLabel} • إعادة الاتصال…`}};poll();this.jobPollTimer=setInterval(poll,350)}
  stopJobPolling(){if(this.jobPollTimer){clearInterval(this.jobPollTimer);this.jobPollTimer=0}}
  async cancelActiveJob(){if(!this.activeJobId)return;$('cancelJobBtn').disabled=true;$('busyText').textContent='جاري إلغاء العملية…';try{await this.api.post('cancel',{jobId:this.activeJobId})}catch(err){$('log').textContent='ERROR:\n'+err.message}}
  releaseProxy(sourceTime=null){const token=this.previewToken;if(sourceTime!=null)this.setPlayerSource('source',sourceTime).catch(()=>{});this.previewToken='';if(token)this.api.post('release-preview',{token}).catch(()=>{})}
  releasePreviewOnClose(){const token=this.previewToken;if(!token)return;this.previewToken='';fetch('/api/release-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),keepalive:true}).catch(()=>{})}
  async analyzeAudio(showResult){
    if(!this.videoPath)return this.showMessage('اختار فيديو الأول.');
    try{const d=await this.runJob('جاري تحليل توزيع الصوت…',jobId=>{ $('log').textContent='جاري تشغيل auto-editor levels…';return this.api.post('auto-threshold',{sourcePath:this.videoPath,jobId})});this.wave=d.waveform||[];this.audioSuggestion=d.suggestion||null;const duration=Number(d.duration)||this.timeline.sourceDuration||this.player.duration||0;this.timelineView.setData({wave:this.wave,duration,cuts:this.cuts,threshold:Number($('threshold').value),sourceTime:this.currentSourceTime(),windowSec:Number($('timelineZoom').value)});this.renderSuggestion();$('log').textContent=`تم تحليل ${d.levelCount||0} نقطة صوت.`;if(showResult)$('autoResult').scrollIntoView({behavior:'smooth',block:'nearest'});return true}catch(err){$('log').textContent='ERROR:\n'+err.message;if(!/تم إلغاء/.test(err.message))this.showMessage(err.message);return false}
  }
  renderSuggestion(){if(!this.audioSuggestion)return;const s=this.audioSuggestion;$('safeValue').textContent=s.safe+'%';$('recommendedValue').textContent=s.recommended+'%';$('aggressiveValue').textContent=s.aggressive+'%';$('autoResult').classList.remove('hidden');const conf=s.confidence==='high'?'عالية':s.confidence==='medium'?'متوسطة':'منخفضة';$('confidenceText').textContent=`ثقة الاقتراح: ${conf} • Noise floor تقريبي ${s.floorDb} dB • الكلام النشط تقريبي ${s.activeDb} dB`;}
  applySuggestion(kind){if(!this.audioSuggestion)return;const v=Number(this.audioSuggestion[kind]);$('threshold').value=v;$('thresholdValue').textContent=v+'%';this.timelineView.setData({threshold:v});this.markDirty()}
  async analyzeCuts(){
    if(!this.videoPath)return this.showMessage('اختار فيديو الأول.');
    try{
      if(!this.wave.length&&!await this.analyzeAudio(false))return;
      const revision=this.settingsRevision.snapshot();const d=await this.runJob('جاري تحديد أماكن القص…',jobId=>{ $('log').textContent='جاري تحليل الـCuts…';return this.api.post('run',this.settings('cuts',jobId))});if(!this.settingsRevision.isCurrent(revision)){ $('log').textContent='تم تجاهل نتيجة تحليل قديمة لأن الإعدادات اتغيرت.';return }const sourceTime=this.playerMode==='proxy'?this.currentSourceTime():null;this.cuts=(d.cuts||[]).map(c=>({...c,enabled:true}));this.timeline=new CutTimeline(this.cuts,Number(d.sourceDuration)||this.player.duration||0);this.proxyMonitor.setTimeline(this.timeline);this.releaseProxy(sourceTime);this.markClean(revision);this.renderCuts();this.renderSummary();this.timelineView.setData({wave:this.wave,duration:this.timeline.sourceDuration,cuts:this.cuts,threshold:Number($('threshold').value),sourceTime:sourceTime??this.currentSourceTime(),windowSec:Number($('timelineZoom').value)});$('reviewPanel').classList.remove('hidden');$('cutsCard').classList.remove('hidden');this.currentStep=3;this.syncStep();window.scrollTo({top:0,behavior:'smooth'});$('log').textContent=`تم تحديد ${this.cuts.length} Cut. المعاينة السلسة ستبني Proxy منخفض الجودة عند أول تشغيل.`;
    }catch(err){$('log').textContent='ERROR:\n'+err.message;if(!/تم إلغاء/.test(err.message))this.showMessage(err.message)}
  }
  renderSummary(){if(!this.analysisReady)return;const active=this.cuts.filter(c=>c.enabled!==false),total=active.reduce((s,c)=>s+c.duration,0),dur=this.timeline.sourceDuration||0,ratio=dur?total/dur:0;$('summary').innerHTML=`<span class="badge">Cuts: ${active.length}</span><span class="badge">المحذوف: ${fmtDuration(total)}</span><span class="badge">النهائي: ${fmtDuration(Math.max(0,dur-total))}</span><span class="badge">${(ratio*100).toFixed(1)}% حذف</span>`;$('cutSelectionSummary').innerHTML=`<span class="badge">حذف ${active.length}</span><span class="badge">احتفاظ ${this.cuts.length-active.length}</span>`;const risk=$('riskWarning');if(ratio>=.25){risk.textContent=`⚠ الإعداد الحالي سيحذف ${(ratio*100).toFixed(1)}% من الفيديو. دي نسبة مرتفعة؛ شغّل المعاينة السلسة أو استخدم Threshold أقل قبل التصدير.`;risk.classList.remove('hidden')}else risk.classList.add('hidden')}
  renderCuts(){$('cutsBody').innerHTML=this.cuts.map((c,i)=>`<tr data-index="${i}" class="${c.enabled===false?'kept':''}"><td>${c.index}</td><td class="ltr">${c.startText}</td><td class="ltr">${c.endText}</td><td>${c.durationText}</td><td><button class="small" data-action="edited" type="button">بعد القص</button> <button class="small" data-action="original" type="button">الأصلي</button></td><td><button class="small ${c.enabled===false?'':'dangerSoft'}" data-action="toggle" type="button">${c.enabled===false?'احذف':'احتفظ'}</button></td></tr>`).join('')||'<tr><td colspan="6" class="emptyCuts">لا توجد أجزاء صامتة للحذف. يمكنك تصدير الفيديو كما هو.</td></tr>'}
  handleCutTableClick(e){const b=e.target.closest('button[data-action]');if(!b)return;const r=b.closest('tr[data-index]');if(!r)return;const i=Number(r.dataset.index);if(b.dataset.action==='toggle')this.toggleCut(i);else if(b.dataset.action==='edited')this.auditionCut(i,true);else if(b.dataset.action==='original')this.auditionCut(i,false)}
  toggleCut(i){const c=this.cuts[i];if(!c)return;$('exportSuccess').classList.add('hidden');const sourceTime=this.playerMode==='proxy'?this.currentSourceTime():null;c.enabled=c.enabled===false;this.timeline.setCuts(this.cuts,this.timeline.sourceDuration);this.proxyMonitor.setTimeline(this.timeline);this.releaseProxy(sourceTime);this.renderCuts();this.renderSummary();this.timelineView.setData({cuts:this.cuts,sourceTime:sourceTime??this.currentSourceTime()})}
  removeAuditionHandler(){if(this.auditionHandler){this.player.removeEventListener('timeupdate',this.auditionHandler);this.auditionHandler=null}this.clearNotice()}
  cancelAudition(){this.auditionRevision.bump();this.removeAuditionHandler()}
  async auditionCut(i,edited){const c=this.cuts[i];if(!c)return;const revision=this.auditionRevision.bump();this.removeAuditionHandler();await this.setPlayerSource('source',Math.max(0,c.start-1.5));if(!this.auditionRevision.isCurrent(revision))return;this.removeAuditionHandler();const stop=Math.min(this.timeline.sourceDuration,c.end+1.5);let jumped=false;const tick=()=>{const t=this.player.currentTime;if(edited&&!jumped&&t>=c.start-.03){jumped=true;this.showNotice(`تم تخطي ${c.duration.toFixed(2)}ث`,'cut',600);this.player.currentTime=c.end+.001}else if(!edited&&t>=c.start&&t<c.end)this.showNotice(`هذا الجزء سيتم حذفه • ${c.duration.toFixed(2)}ث`,'original');if(t>=stop){this.removeAuditionHandler();this.player.pause()}};this.auditionHandler=tick;this.player.addEventListener('timeupdate',tick);try{await this.player.play()}catch{this.removeAuditionHandler()}}
  async ensureProxy(){if(this.analysisDirty){this.showMessage('الإعدادات اتغيرت. أعد تحليل أماكن القص أولًا.');return false}if(this.previewToken)return true;const revision=this.settingsRevision.snapshot();try{const d=await this.runJob('جاري بناء Preview سلسة منخفضة الجودة…',jobId=>{ $('log').textContent='جاري Render سريع للـProxy. ده يحصل أول مرة فقط بعد كل تعديل…';return this.api.post('run',this.settings('proxy',jobId))});if(!this.settingsRevision.isCurrent(revision)){if(d.previewToken)this.api.post('release-preview',{token:d.previewToken}).catch(()=>{});return false}this.releaseProxy();this.previewToken=d.ready?d.previewToken||'':'';$('log').textContent=`Preview جاهزة في ${(Number(d.elapsedMs||0)/1000).toFixed(1)} ثانية.`;return !!this.previewToken}catch(err){$('log').textContent='ERROR:\n'+err.message;if(!/تم إلغاء/.test(err.message))this.showMessage(err.message);return false}}
  async startSmoothPreview(fromStart){if(!this.analysisReady)return this.showMessage('حلّل أماكن القص الأول.');if(!await this.ensureProxy())return;const currentEdited=fromStart?0:(this.playerMode==='proxy'?this.player.currentTime:this.timeline.sourceToEdited(this.player.currentTime));await this.setPlayerSource('proxy',currentEdited);this.player.playbackRate=clamp($('previewSpeed').value,.25,4);try{await this.player.play()}catch{};this.proxyMonitor.start()}
  async switchToSource(play=false,sourceTime=null){this.cancelAudition();const t=sourceTime==null?(this.playerMode==='proxy'?this.timeline.editedToSource(this.player.currentTime):this.player.currentTime):sourceTime;await this.setPlayerSource('source',t);if(play){try{await this.player.play()}catch{}}}
  async setPlayerSource(mode,time=0){this.proxyMonitor.stop();this.player.pause();const token=mode==='proxy'?this.previewToken:this.mediaToken;if(!token)return;this.playerMode=mode;$('modePill').textContent=mode==='proxy'?'PREVIEW سلس بعد القص':'المصدر الأصلي';this.player.src=(mode==='proxy'?'/api/preview-media?token=':'/api/media?token=')+encodeURIComponent(token);this.player.load();await new Promise(resolve=>{if(this.player.readyState>=1)return resolve();let settled=false;const done=()=>{if(settled)return;settled=true;this.player.removeEventListener('loadedmetadata',done);resolve()};this.player.addEventListener('loadedmetadata',done,{once:true});setTimeout(done,1800)});const dur=Number.isFinite(this.player.duration)?this.player.duration:Number.MAX_SAFE_INTEGER;this.player.currentTime=clamp(time,0,Math.max(0,dur-.001));this.player.playbackRate=clamp($('previewSpeed').value,.25,4);this.updateFromPlayer(this.player.currentTime)}
  currentSourceTime(){return this.playerMode==='proxy'?this.timeline.editedToSource(this.player.currentTime):Number(this.player.currentTime)||0}
  updateFromPlayer(t){const source=this.playerMode==='proxy'?this.timeline.editedToSource(t):t;const edited=this.playerMode==='proxy'?t:this.timeline.sourceToEdited(t);const srcDur=this.timeline.sourceDuration||((this.playerMode==='source'&&this.player.duration)||0);const edDur=this.timeline.editedDuration()||srcDur;$('sourceClock').textContent=`${fmtClock(source)} / ${fmtClock(srcDur)}`;$('editedClock').textContent=`${fmtClock(edited)} / ${fmtClock(edDur)}`;this.timelineView.setData({sourceTime:source})}
  async seekSource(t){this.cancelAudition();const src=clamp(t,0,this.timeline.sourceDuration||0);if(this.playerMode==='proxy'){const edited=this.timeline.sourceToEdited(src);this.player.currentTime=edited}else this.player.currentTime=src;this.updateFromPlayer(this.player.currentTime)}
  showNotice(text,type='',autoHide=0){clearTimeout(this.noticeTimer);const n=$('notice');n.textContent=text;n.className='notice show'+(type?' '+type:'');if(autoHide)this.noticeTimer=setTimeout(()=>this.clearNotice(),autoHide)}clearNotice(){clearTimeout(this.noticeTimer);$('notice').className='notice'}
  async runOutput(mode){if(!this.analysisReady)return this.showMessage('حلّل أماكن القص الأول.');if(this.analysisDirty)return this.showMessage('الإعدادات اتغيرت. أعد التحليل قبل التصدير.');try{clearTimeout(this.watermarkSaveTimer);$('exportSuccess').classList.add('hidden');const label=mode==='render'?'جاري إنشاء الفيديو النهائي…':'جاري إنشاء مشروع CapCut…';const d=await this.runJob(label,async jobId=>{if(mode==='render')await this.updateWatermarkTransform();return this.api.post('run',this.settings(mode,jobId))});$('log').textContent=d.output||'تم بنجاح.';if(mode==='render'){this.lastOutput=d.outputPath||$('outputPath').dataset.path;$('exportSuccess').textContent='تم إنشاء الفيديو بنجاح. يمكنك فتح مجلد الحفظ.'}else{this.lastOutput=d.draftPath||'';$('exportSuccess').textContent=`تم إنشاء مشروع CapCut: ${d.projectName||''} • ${d.clips||0} مقطع قابل للتعديل.`}if(d.lintOk===false)$('log').textContent=(d.lintOutput||'')+'\nتم إنشاء المشروع، لكن فحص التايم لاين رجّع تحذيرات.';$('exportSuccess').classList.remove('hidden')}catch(err){$('log').textContent='ERROR:\n'+err.message;if(!/تم إلغاء/.test(err.message))this.showMessage(err.message)}}
  async openFolder(){try{await this.api.post('open-folder',{target:this.lastOutput||$('outputPath').dataset.path||''})}catch(err){this.showMessage(err.message)}}
}

new App();
})();
