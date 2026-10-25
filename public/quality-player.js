/* Quality stays local to this viewer; room synchronization uses the original URL. */
class QualityPlayer {
  constructor(video, select, status, request, secureUrl) {
    Object.assign(this,{video,select,status,request,secureUrl,source:'',hls:null,info:null,changing:false,generation:0});
    this.mode = 'auto';
    this.retryButton = document.getElementById('quality-retry');
    this.retryButton?.addEventListener('click',()=>{
      if(!this.source || this.preparing)return;
      this.retryButton.hidden=true;
      this.status.textContent='Retrying quality · Original';
      void this.prepare(this.generation,true);
    });
    select.addEventListener('change',()=>{this.mode=select.value;this.apply();});
  }
  setSource(source) {
    this.generation++;
    if(this.retryButton)this.retryButton.hidden=true;
    clearTimeout(this.poll);
    this.hls?.destroy(); this.hls=null; this.info=null; this.nativeHls=false; this.changing=false;
    this.source=source;
    this.select.innerHTML='<option value="auto">Auto</option><option value="original">Original</option>';
    this.select.value=this.mode='auto';
    this.status.textContent=source ? 'Preparing quality · Original' : 'Select a video';
    this.video.src=source ? this.secureUrl(source) : '';
    if(source) void this.prepare(this.generation);
  }
  async prepare(generation, retry = false) {
    this.preparing=true;
    try {
      const response=await this.request('/api/quality',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:this.source,retry})});
      if(!response.ok) throw Error('Quality HTTP '+response.status);
      const info=await response.json();
      if(generation!==this.generation) return;
      if(info.status==='ready') {
        this.info=info;
        for(const level of [...info.levels].reverse()) {
          const option=document.createElement('option'); option.value=String(level.height); option.textContent=level.height+'p';this.select.appendChild(option);
        }
        this.apply();
      } else if(info.status==='failed') {
        this.status.textContent=info.error || 'Video conversion failed. Check FFmpeg on the server.';
        if(this.retryButton)this.retryButton.hidden=false;
      }
      else {
        this.status.textContent=(info.status==='busy'?'Encoder busy':'Preparing quality')+' · Original';
        this.poll=setTimeout(()=>this.prepare(generation),10000);
      }
    } catch(error) {
      if(generation!==this.generation) return;
      console.warn('Adaptive quality unavailable:',error.message);
      this.status.textContent=error.message+' · Restart/update the server, then retry.';
      if(this.retryButton)this.retryButton.hidden=false;
    } finally { if(generation===this.generation)this.preparing=false; }
  }
  switchMedia(attach) {
    const generation=this.generation;
    const switchToken=this.switchToken=(this.switchToken || 0)+1;
    const time=this.video.currentTime || 0;
    const paused=this.video.paused;
    this.changing=true;
    const restore=()=>{
      if(generation!==this.generation || switchToken!==this.switchToken) return;
      this.video.currentTime=time;
      if(!paused) this.video.play().catch(()=>{});
      setTimeout(()=>{if(generation===this.generation && switchToken===this.switchToken)this.changing=false;},500);
    };
    this.video.addEventListener('loadedmetadata',restore,{once:true});
    attach();
  }
  apply() {
    if(!this.source)return;
    if(this.mode==='original') {
      this.status.textContent='Original';
      if(this.hls || this.nativeHls) this.switchMedia(()=>{
        this.hls?.destroy();this.hls=null;this.nativeHls=false;this.video.src=this.secureUrl(this.source);
      });
      return;
    }
    if(!this.info)return;
    const master=`/api/hls/${this.info.id}/master.m3u8`;
    if(window.Hls?.isSupported()) {
      if(!this.hls) {
        this.switchMedia(()=>{
          const instance=this.hls=new Hls({capLevelToPlayerSize:true,startLevel:-1,maxBufferLength:30,backBufferLength:30,
            xhrSetup:(xhr,url)=>xhr.open('GET',this.secureUrl(url),true)});
          instance.on(Hls.Events.MANIFEST_PARSED,()=>this.setLevel());
          instance.on(Hls.Events.LEVEL_SWITCHED,(_event,data)=>{
            const height=instance.levels[data.level]?.height || this.info?.levels[data.level]?.height;
            this.status.textContent=this.mode==='auto' ? `Auto${height?' · '+height+'p':''}` : this.mode+'p';
          });
          instance.on(Hls.Events.ERROR,(_event,data)=>{
            if(!data.fatal || this.hls!==instance)return;
            console.warn('HLS fallback:',data.details);
            this.mode=this.select.value='original';this.apply();
            this.status.textContent='Playback fallback · Original';
          });
          instance.loadSource(this.secureUrl(master));instance.attachMedia(this.video);
        });
      } else this.setLevel();
    } else if(this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari's native HLS controls Auto; a variant playlist locks a manual quality.
      const file=this.mode==='auto' ? 'master.m3u8' : this.mode+'p.m3u8';
      const target=`/api/hls/${this.info.id}/${file}`;
      this.switchMedia(()=>{this.nativeHls=true;this.video.src=this.secureUrl(target);});
      this.status.textContent=this.mode==='auto'?'Auto · native':this.mode+'p';
    } else this.status.textContent='Adaptive playback unsupported · Original';
  }
  setLevel() {
    if(!this.hls)return;
    this.status.textContent=this.mode==='auto'?'Auto':this.mode+'p · selected';
    this.hls.capLevelToPlayerSize=this.mode==='auto';
    this.hls.nextLevel=this.mode==='auto' ? -1 : this.hls.levels.findIndex((level,index)=>String(level.height || this.info.levels[index]?.height)===this.mode);
  }
}
