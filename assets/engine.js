/* ════════════════════════════════════════════════════════════════════════
   MIXFLOW 引擎层 —— 分析 / 变速 / 逐拍同步 / 排程 / 导出
   中间那 63 个函数与 1.7 逐字节一致(节拍对齐内核已锁定,见 HANDOFF)。
   UI 由 index.html 里的设计稿负责,这里只暴露 window.MF 给它调用。
   ════════════════════════════════════════════════════════════════════════ */
(function(){
"use strict";

/* 引擎会读 6 个设置项(原本是页面上的隐藏 input)。这里改成「取不到就现造一个」,
   于是引擎那 63 个函数一行都不用改,而设计稿的 HTML 里也不需要塞任何多余节点。 */
const SETTINGS={ tempoAlign:["checkbox",true], normalize:["checkbox",true], bassSwap:["checkbox",true],
                 beatHQ:["checkbox",false], mixMode:["select","outro_intro"], ovlSel:["select","8"] };
let settingsBox=null;
function ensureSetting(id){
  const spec=SETTINGS[id]; if(!spec) return null;
  if(!settingsBox){ settingsBox=document.createElement("div"); settingsBox.hidden=true;
    settingsBox.id="mf-settings"; (document.body||document.documentElement).appendChild(settingsBox); }
  let el=document.getElementById(id); if(el) return el;
  if(spec[0]==="checkbox"){ el=document.createElement("input"); el.type="checkbox"; el.checked=spec[1]; }
  else { el=document.createElement("input"); el.type="hidden"; el.value=spec[1]; }
  el.id=id; settingsBox.appendChild(el); return el;
}
const $ = id => document.getElementById(id) || ensureSetting(id);

/* 引擎里有两个函数是当年写在「UI 层」的,但引擎自己会调用它们 ——
   3.0 拆包时我只搬了引擎那一段,漏掉这两个,导致 buildSchedule 最后一行
   ReferenceError,表现成「Something went wrong while blending」。
   currentMeta:buildSchedule 用它给排程结果盖一个参数快照。
   renderList :analyzeTrack 结束时的老回调,新架构里 UI 由 React 自己重绘,置空即可。 */
function currentMeta(){
  return { ovl:$("ovlSel").value, bassSwap:$("bassSwap").checked, align:$("tempoAlign").checked,
           norm:$("normalize").checked, mode:$("mixMode").value,
           ids:tracks.map(t=>t.id), bpms:tracks.map(t=>t.bpm) };
}
function renderList(){ /* React 负责渲染,这里不需要做任何事 */ }

let ctx=null;
let tracks=[];
let schedule=null;
let uid=0;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

/* Essentia 延迟加载:落地页不该为了一个还没用到的 2MB wasm 等待。
   analyzeTrack(锁定函数)会 await essentiaReady,所以 promise 必须先存在,
   真正的加载由 startEssentia() 在分析开始前触发。 */
let essentia=null, essentiaResolve, essentiaReject, essentiaStarted=false;
const essentiaReady=new Promise((res,rej)=>{ essentiaResolve=res; essentiaReject=rej; });
essentiaReady.catch(()=>{});
function startEssentia(){
  if(essentiaStarted) return essentiaReady;
  essentiaStarted=true;
  setTimeout(()=>essentiaReject&&essentiaReject(new Error("Essentia 加载超时")), 30000);
  (async()=>{
    try{
      await loadScript("assets/essentia-wasm.web.js");
      await loadScript("assets/essentia.js-core.js");
      /* wasm 与 js 同放在 assets/,locateFile 默认相对文档解析,必须显式指过去 */
      essentia=new Essentia(await EssentiaWASM({locateFile:f=>"assets/"+f}));
      essentiaResolve(essentia);
      console.log("[engine] Essentia.js 就绪(本地托管)");
    }catch(e){
      console.warn("[engine] Essentia 不可用,回退内置 beat/key 检测:", e && e.message);
      essentiaReject(e);
    }
  })();
  return essentiaReady;
}


/* ══════ 引擎层:1.7 原样搬运,未改一行 ══════ */
const EQ3={
  lowFreq:150,  lowQ:0.707, lowCut:-26,      // 低频:pyCrossfade 验证过的深度
  midFreq:1000, midQ:0.6,   midCut:-12,      // 中频:人声主要能量区
  midCutVocal:-18,                            // 两首都有人声时加深
  highFreq:8000, highCut:-10,
  lowRampBeats:1,      // 低频:快,要有硬交换的果断感
  midRampBars:1.5,     // 中频:慢,人声突然出现/消失都难听
  highRampBars:3,      // 高频:最平缓
  midLagBars:2,        // 入歌中频滞后于低频交换
  midLeadBars:2,       // 出歌中频提前于低频退场
  highLagBars:2        // 出歌高频最后收
};

const CAMELOT_MAJ=["8B","3B","10B","5B","12B","7B","2B","9B","4B","11B","6B","1B"];

const CAMELOT_MIN=["5A","12A","7A","2A","9A","4A","11A","6A","1A","8A","3A","10A"];

const NOTE_TO_CAMELOT={
  major:{C:"8B","C#":"3B",Db:"3B",D:"10B","D#":"5B",Eb:"5B",E:"12B",F:"7B","F#":"2B",Gb:"2B",G:"9B","G#":"4B",Ab:"4B",A:"11B","A#":"6B",Bb:"6B",B:"1B"},
  minor:{A:"8A","A#":"3A",Bb:"3A",B:"10A",C:"5A","C#":"12A",Db:"12A",D:"7A","D#":"2A",Eb:"2A",E:"9A",F:"4A","F#":"11A",Gb:"11A",G:"6A","G#":"1A",Ab:"1A"}
};

const SEC_COLORS={INTRO:"#4dd0e1",VERSE:"#5c7cfa",BUILD:"#ffb020",DROP:"#ff2d95",BREAK:"#9775fa",OUTRO:"#26a69a"};

const MAX_BPM_SHIFT=10;      // 单曲最大变速幅度(BPM)

const MAX_PAIR_DIFF=20;      // 相邻两曲最大 BPM 差,超过则不做 beatmatch

const KEY_BONUS_BPM=2;       // 排序时 key 兼容折算成"相当于近 2 BPM"的优势

const VOC_LO=200, VOC_HI=4000;

const MAX_OVL_BARS=32;

const ENV_HOP=256;

const ATTACK_SEC=0.045;        // 每拍起音保护长度

const OLA_XF=128;              // 拉伸段接缝交叉过渡长度

const BEAT_XF=24;              // 拍首交叉必须远短于起音(kick 峰值在前 ~100 采样内),

const OLA_MARGIN_SEC=4096/44100; // ≈93ms:WSOLA 首末帧必然带窗淡变,渲染时留边、事后裁掉

const LOOP_BARS=8, LOOP_MAX_REPEATS=3;

const FADE_IN  = curve(65, x=>Math.sin(x*Math.PI/2));   // equal-power

const FADE_OUT = curve(65, x=>Math.cos(x*Math.PI/2));

function ensureCtx(){ if(!ctx) ctx = new (window.AudioContext||window.webkitAudioContext)(); return ctx; }

function computePeaks(buf, n){
  const ch = buf.getChannelData(0), step = Math.floor(ch.length/n)||1, peaks = new Float32Array(n);
  for(let i=0;i<n;i++){
    let m=0, s=i*step, e=Math.min(s+step, ch.length);
    for(let j=s;j<e;j+=16){ const v=Math.abs(ch[j]); if(v>m)m=v; }
    peaks[i]=m;
  }
  return peaks;
}

function computeLoudnessGain(buf){
  const ch=buf.getChannelData(0), ch2=buf.numberOfChannels>1? buf.getChannelData(1):null;
  const block=Math.floor(buf.sampleRate*0.4);
  const rmss=[]; let peak=0;
  for(let s=0;s+block<=ch.length;s+=block){
    let e=0,cnt=0;
    for(let i=s;i<s+block;i+=4){
      let v=ch[i]; if(ch2) v=(v+ch2[i])/2;
      e+=v*v; cnt++;
      const a=Math.abs(v); if(a>peak) peak=a;
    }
    rmss.push(Math.sqrt(e/cnt));
  }
  if(!rmss.length) return 1;
  rmss.sort((a,b)=>b-a);
  const loud=rmss.slice(0, Math.max(1, Math.floor(rmss.length*0.5)));
  const rms=loud.reduce((a,b)=>a+b,0)/loud.length;
  /* 目标 -17dBFS(原 -14dBFS)。过渡中段两轨全音量同奏,电平直接翻倍:
     实测两轨相加峰值 1.93 → 硬削波(爆音)。降 3dB 留同奏余量,配合主输出限幅器。 */
  let gain=0.14/Math.max(rms,1e-6);
  /* 峰值钳制 0.7→0.5:§6A 要求限幅器【之前】峰值 ≤1.0,而中段两轨全音量同奏必然翻倍,
     故单轨上限必须 ≤0.5。配合下面 bandCorrection 改为只切不提,最坏叠加恰为 1.0。 */
  gain=Math.min(gain, 0.5/Math.max(peak,1e-6));
  return Math.min(Math.max(gain,0.2),4);         // 限幅约 ±12dB
}

function gainOf(t){ return $("normalize").checked? (t.gain||1) : 1; }

function computeBands(buf){
  const sr=buf.sampleRate, ch=buf.getChannelData(0);
  const FR=4096, HOP=16384;
  const start=Math.floor(Math.max(0,(buf.duration/2-30))*sr);
  const end=Math.min(ch.length-FR, start+60*sr);
  if(end<=start) return null;
  const re=new Float32Array(FR), im=new Float32Array(FR);
  const win=new Float32Array(FR); for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const e=[1e-12,1e-12,1e-12];
  for(let p=start;p<end;p+=HOP){
    for(let i=0;i<FR;i++){ re[i]=ch[p+i]*win[i]; im[i]=0; }
    fft(re,im);
    for(let b=1;b<FR/2;b++){
      const f=b*sr/FR, pw=re[b]*re[b]+im[b]*im[b];
      if(f<250) e[0]+=pw; else if(f<4000) e[1]+=pw; else if(f<16000) e[2]+=pw;
    }
  }
  return e;
}

function bandTargetShares(){ // 当前歌单各频段能量占比的中位数,作为对齐目标
  const list=tracks.filter(t=>t.bands);
  if(list.length<2) return null;
  const med=a=>{ const s=[...a].sort((x,y)=>x-y); return s[(s.length-1)>>1]; };
  return [0,1,2].map(b=>med(list.map(t=>t.bands[b]/(t.bands[0]+t.bands[1]+t.bands[2]))));
}

function bandCorrection(t){ // 返回 [低,中,高] 修正量(dB)
  if(!$("normalize").checked || !t.bands) return [0,0,0];
  const ref=bandTargetShares(); if(!ref) return [0,0,0];
  const s=t.bands[0]+t.bands[1]+t.bands[2];
  /* 1.7 起改为【只切不提】(上限 0dB):任何提升都会抬高限幅器前的峰值,
     而 §6A 要求该处 ≤1.0。削减不增加电平,是安全方向,音色平衡效果几乎不受影响。 */
  return [0,1,2].map(b=>Math.min(0, Math.max(-8, 10*Math.log10(ref[b]/(t.bands[b]/s)))));
}

function makeSwapEQ(ac){
  const lo=ac.createBiquadFilter(); lo.type="lowshelf";  lo.frequency.value=EQ3.lowFreq;  lo.Q.value=EQ3.lowQ;
  const md=ac.createBiquadFilter(); md.type="peaking";   md.frequency.value=EQ3.midFreq;  md.Q.value=EQ3.midQ;
  const hi=ac.createBiquadFilter(); hi.type="highshelf"; hi.frequency.value=EQ3.highFreq; hi.Q.value=0.707;
  lo.connect(md); md.connect(hi);
  return {input:lo, output:hi, low:lo.gain, mid:md.gain, high:hi.gain};
}

function scheduleBand(param, cutDb, inAt, outAt, ramp, g0, t0abs){
  const toCtx=gt=>t0abs+Math.max(0, gt-g0);
  if(outAt!=null && inAt!=null && outAt<inAt+ramp) outAt=null;   // overlap 太短,放弃退场切除
  let cur=(inAt!=null && g0<inAt)? cutDb : 0;
  if(outAt!=null && g0>=outAt+ramp) cur=cutDb;
  param.setValueAtTime(cur, t0abs);
  if(inAt!=null && g0<inAt){
    param.setValueAtTime(cutDb, toCtx(inAt));
    param.linearRampToValueAtTime(0, toCtx(inAt+ramp));
  }
  if(outAt!=null && g0<outAt){
    param.setValueAtTime(0, toCtx(outAt));
    param.linearRampToValueAtTime(cutDb, toCtx(outAt+ramp));
  }
}

function setEqSwapTimes(cur, nxt, swap, ovlStart, ovlEnd, barT){
  const dur=Math.max(0.1, ovlEnd-ovlStart);
  const lag =Math.min(EQ3.midLagBars *barT, dur*0.35);
  const lead=Math.min(EQ3.midLeadBars*barT, dur*0.35);
  const hlag=Math.min(EQ3.highLagBars*barT, dur*0.35);
  nxt.eqInLow  = swap;
  nxt.eqInMid  = Math.min(swap+lag, ovlEnd);
  cur.eqOutMid = Math.max(swap-lead, ovlStart);
  cur.eqOutLow = swap;
  cur.eqOutHigh= Math.min(swap+hlag, ovlEnd);
}

function applySwapEnv(eq, it, g0, t0abs, T){
  if(!$("bassSwap").checked){
    eq.low.setValueAtTime(0,t0abs); eq.mid.setValueAtTime(0,t0abs); eq.high.setValueAtTime(0,t0abs);
    return;
  }
  const beat=T? 60/T : 0.5, bar=4*beat;
  const midCut=(it.midCutDb!=null? it.midCutDb : EQ3.midCut);
  scheduleBand(eq.low,  EQ3.lowCut,  it.eqInLow,  it.eqOutLow,  Math.max(0.08, EQ3.lowRampBeats*beat), g0, t0abs);
  scheduleBand(eq.mid,  midCut,      it.eqInMid,  it.eqOutMid,  Math.max(0.15, EQ3.midRampBars*bar),  g0, t0abs);
  scheduleBand(eq.high, EQ3.highCut, null,        it.eqOutHigh, Math.max(0.2,  EQ3.highRampBars*bar), g0, t0abs);
}

function makeLimiter(ac){
  const c=ac.createDynamicsCompressor();
  c.threshold.value=-1.5; c.knee.value=0; c.ratio.value=20;
  c.attack.value=0.002;  c.release.value=0.12;
  const g=ac.createGain(); g.gain.value=0.92;   // 补偿限幅器输出、再留 0.7dB 余量
  c.connect(g);
  return {input:c, output:g};
}

function makeBandEQ(ac, corr){ // lowshelf + peaking + highshelf 三段链
  const lo=ac.createBiquadFilter(); lo.type="lowshelf";  lo.frequency.value=250;  lo.gain.value=corr[0];
  const mi=ac.createBiquadFilter(); mi.type="peaking";   mi.frequency.value=1000; mi.Q.value=0.6; mi.gain.value=corr[1];
  const hi=ac.createBiquadFilter(); hi.type="highshelf"; hi.frequency.value=4000; hi.gain.value=corr[2];
  lo.connect(mi); mi.connect(hi);
  return {input:lo, output:hi};
}

async function synthTrack(bpm, root, secs){
  const sr=44100, oc=new OfflineAudioContext(2, sr*secs, sr), beat=60/bpm;
  const mg=oc.createGain(); mg.gain.value=.8; mg.connect(oc.destination);
  for(let t=0; t<secs-0.3; t+=beat){
    // kick
    const o=oc.createOscillator(), g=oc.createGain();
    o.frequency.setValueAtTime(150,t); o.frequency.exponentialRampToValueAtTime(45,t+.12);
    g.gain.setValueAtTime(.9,t); g.gain.exponentialRampToValueAtTime(.001,t+.22);
    o.connect(g).connect(mg); o.start(t); o.stop(t+.25);
    // hat (offbeat)
    const n=oc.createBufferSource(), nb=oc.createBuffer(1,sr*.05,sr), d=nb.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*(1-i/d.length);
    n.buffer=nb; const hg=oc.createGain(); hg.gain.value=.12;
    const hp=oc.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=7000;
    n.connect(hp).connect(hg).connect(mg); n.start(t+beat/2);
  }
  // bassline 每半拍
  const seq=[1,1,1.5,1,2,1,1.5,1.19];
  for(let t=0,k=0; t<secs-0.5; t+=beat/2,k++){
    const o=oc.createOscillator(), g=oc.createGain();
    o.type="sawtooth"; o.frequency.value=root*seq[k%seq.length];
    const f=oc.createBiquadFilter(); f.type="lowpass"; f.frequency.value=700;
    g.gain.setValueAtTime(0.001,t); g.gain.exponentialRampToValueAtTime(.25,t+.02);
    g.gain.exponentialRampToValueAtTime(.001,t+beat*.45);
    o.connect(f).connect(g).connect(mg); o.start(t); o.stop(t+beat*.5);
  }
  return oc.startRendering();
}

function fft(re,im){ // 迭代 radix-2,原地
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit;
    if(i<j){ [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; } }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let cr=1,ci=0;
      for(let k=0;k<len/2;k++){
        const a=i+k,b=i+k+len/2;
        const vr=re[b]*cr-im[b]*ci, vi=re[b]*ci+im[b]*cr;
        re[b]=re[a]-vr; im[b]=im[a]-vi; re[a]+=vr; im[a]+=vi;
        const ncr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=ncr;
      } } }
}

function onsetCurveV2(ch, sr){
  const FR=1024, HOP=512, nF=Math.floor((ch.length-FR)/HOP);
  if(nF<8) return null;
  const win=new Float32Array(FR);
  for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const re=new Float32Array(FR), im=new Float32Array(FR), nB=FR/2;
  const w=new Float32Array(nB);
  for(let b=0;b<nB;b++){ const f=b*sr/FR;
    w[b]= f<40?0.2 : f<200?1.6 : f<800?1.0 : f<4000?0.7 : 0.4; }  // kick 频段加权
  const prev=new Float32Array(nB), flux=new Float32Array(nF);
  for(let k=0;k<nF;k++){
    const p=k*HOP;
    for(let i=0;i<FR;i++){ re[i]=ch[p+i]*win[i]; im[i]=0; }
    fft(re,im);
    let s=0;
    for(let b=1;b<nB;b++){
      const mag=Math.sqrt(re[b]*re[b]+im[b]*im[b]);
      const lg=Math.log1p(mag*100), d=lg-prev[b];
      if(d>0) s+=d*w[b];
      prev[b]=lg;
    }
    flux[k]=s;
  }
  const N=16, out=new Float32Array(nF);          // 自适应均值阈值 + 半波整流
  for(let k=0;k<nF;k++){
    let s=0,c=0;
    for(let j=Math.max(0,k-N/2); j<Math.min(nF,k+N/2); j++){ s+=flux[j]; c++; }
    out[k]=Math.max(0, flux[k]-s/c);
  }
  return out;
}

function trackBeatsBuiltin(buffer){
  const sr=buffer.sampleRate, ch=buffer.getChannelData(0), HOP=512, fs=sr/HOP;
  const nov=onsetCurveV2(ch, sr);
  if(!nov) return null;
  const n=nov.length, dur=ch.length/sr;
  let mean=0; for(let i=0;i<n;i++) mean+=nov[i]; mean/=n;
  const x=new Float32Array(n); for(let i=0;i<n;i++) x[i]=nov[i]-mean;
  const minBpm=70, maxBpm=190;
  const maxLag=Math.ceil(fs*60/minBpm)*4+4;
  const ac=new Float64Array(maxLag+2);
  for(let lag=1;lag<=maxLag;lag++){
    let s=0; for(let i=0;i<n-lag;i++) s+=x[i]*x[i+lag];
    ac[lag]=s/(n-lag);
  }
  const acAt=idx=>{ const i0=Math.floor(idx), fr=idx-i0;
    if(i0<1||i0+1>maxLag) return 0; return ac[i0]*(1-fr)+ac[i0+1]*fr; };
  const MULT=[1,2,4,8];
  const score=bpm=>{ const fpb=60*fs/bpm; let s=0,c=0;
    for(const m of MULT){ if(m*fpb>maxLag) break; s+=acAt(m*fpb); c++; }
    return c<2? -1e18 : s/c; };
  let bBpm=125, bSc=-1e18;
  for(let bpm=minBpm; bpm<=maxBpm; bpm+=0.02){
    const sc=score(bpm)*Math.exp(-Math.pow(Math.log(bpm/125)/0.42,2)/2);
    if(sc>bSc){ bSc=sc; bBpm=bpm; }
  }
  for(let k=0;k<2;k++){                          // 八度 / 三连音消歧
    const fpb=60*fs/bBpm;
    if(bBpm*2<=maxBpm && acAt(fpb/2)>0.62*acAt(fpb)){ bBpm*=2; continue; }
    if(bBpm*1.5<=maxBpm && acAt(fpb/1.5)>0.70*acAt(fpb)){ bBpm*=1.5; continue; }
    break;
  }
  { let b2=bBpm,s2=-1e18;                        // ±3% 精扫
    for(let bpm=bBpm*0.97; bpm<=bBpm*1.03; bpm+=0.005){ const s=score(bpm); if(s>s2){s2=s;b2=bpm;} }
    bBpm=b2; }
  const spb=60/bBpm;
  let ph=0, ps=-1e18;                            // 相位 1ms 扫描
  for(let p=0;p<spb;p+=0.001){
    let s=0,c=0;
    for(let t=p;t<dur;t+=spb){ const i=Math.round(t*fs); if(i<n){ s+=nov[i]; c++; } }
    if(c&&s/c>ps){ ps=s/c; ph=p; }
  }
  /* 逐拍吸附到局部 onset 峰(抛物线插值),周期缓慢跟随速度起伏 */
  const beats=[]; let t=ph, period=spb;
  const winR=0.14;
  while(t<dur-0.05 && beats.length<20000){
    const lo=Math.max(0,(t-winR*period)*fs), hi=Math.min(n-1,(t+winR*period)*fs);
    let best=-1,bi=-1;
    for(let i=Math.ceil(lo);i<=Math.floor(hi);i++) if(nov[i]>best){best=nov[i];bi=i;}
    let tt=t;
    if(bi>=0&&best>0){
      let p=bi;
      if(bi>0&&bi<n-1){ const y1=nov[bi-1],y2=nov[bi],y3=nov[bi+1],d=y1-2*y2+y3;
        if(Math.abs(d)>1e-12){ const dd=0.5*(y1-y3)/d; if(Math.abs(dd)<1) p=bi+dd; } }
      tt=p/fs;
    }
    beats.push(tt);
    if(beats.length>1){
      const meas=beats[beats.length-1]-beats[beats.length-2];
      if(meas>spb*0.8&&meas<spb*1.2) period=period*0.88+meas*0.12;
    }
    t=tt+period;
  }
  return {bpm:bBpm, beats};
}

function detectBPM(buffer){
  const sr=buffer.sampleRate, ch=buffer.getChannelData(0), hop=512;
  const start=Math.floor(Math.max(0,(buffer.duration/2-30))*sr);
  const end=Math.min(ch.length, start+60*sr);
  const env=[]; let prev=0;
  for(let i=start;i+hop<end;i+=hop){
    let e=0; for(let j=0;j<hop;j+=4) e+=ch[i+j]*ch[i+j];
    e=Math.sqrt(e); env.push(Math.max(0,e-prev)); prev=e; // 半波整流的能量差 = onset 强度
  }
  const fs=sr/hop, n=env.length;
  if(n<fs*5) return null;
  const mean=env.reduce((a,b)=>a+b,0)/n, e2=env.map(x=>x-mean);
  const minLag=Math.floor(fs*60/190), maxLag=Math.ceil(fs*60/60);
  const sc=new Float64Array(maxLag+2);
  let best=-1e18, bestLag=0;
  for(let lag=minLag;lag<=maxLag;lag++){
    let s=0; for(let i=0;i<n-lag;i++) s+=e2[i]*e2[i+lag];
    s/=(n-lag);
    const bpm=60*fs/lag;
    s*=1+0.12*Math.exp(-Math.pow((bpm-125)/35,2)); // 轻微偏好常见舞曲速度
    sc[lag]=s;
    if(s>best){best=s;bestLag=lag;}
  }
  if(!bestLag) return null;
  // 抛物线插值获得亚格点精度(整数 lag 量化在 126BPM 处误差可达 ±0.05%,高 BPM 更差)
  let lagF=bestLag;
  if(bestLag>minLag && bestLag<maxLag){
    const y1=sc[bestLag-1], y2=sc[bestLag], y3=sc[bestLag+1];
    const den=y1-2*y2+y3;
    if(Math.abs(den)>1e-18){ const d=0.5*(y1-y3)/den; if(Math.abs(d)<1) lagF=bestLag+d; }
  }
  let bpm=60*fs/lagF;
  while(bpm<70) bpm*=2; while(bpm>180) bpm/=2;
  const exact=bpm;
  let disp=Math.round(bpm*10)/10;
  if(Math.abs(disp-Math.round(disp))<0.3) disp=Math.round(disp);
  return {disp, exact};
}

function localExactBPM(t, from, to){
  const base=t.bpmExact||t.bpm; if(!base) return null;
  const sr=t.buffer.sampleRate, ch=t.buffer.getChannelData(0), hop=512;
  const i0=Math.max(0,Math.floor(from*sr)), i1=Math.min(ch.length,Math.floor(to*sr));
  if(i1-i0<sr*10) return base;
  const env=[]; let prev=0;
  for(let i=i0;i+hop<i1;i+=hop){
    let e=0; for(let j=0;j<hop;j+=4) e+=ch[i+j]*ch[i+j];
    e=Math.sqrt(e); env.push(Math.max(0,e-prev)); prev=e;
  }
  const fs=sr/hop, n=env.length;
  const mean=env.reduce((a,b)=>a+b,0)/n, e2=env.map(x=>x-mean);
  const lag0=fs*60/base;
  const lo=Math.max(2,Math.floor(lag0*0.94)), hi=Math.min(n-2,Math.ceil(lag0*1.06));
  if(hi<=lo) return base;
  const sc=new Float64Array(hi+2);
  let best=-1e18, bl=0;
  for(let lag=lo;lag<=hi;lag++){
    let s=0; for(let i=0;i<n-lag;i++) s+=e2[i]*e2[i+lag];
    sc[lag]=s/(n-lag);
    if(sc[lag]>best){best=sc[lag];bl=lag;}
  }
  if(!bl) return base;
  let lagF=bl;
  if(bl>lo && bl<hi){
    const den=sc[bl-1]-2*sc[bl]+sc[bl+1];
    if(Math.abs(den)>1e-18){ const d=0.5*(sc[bl-1]-sc[bl+1])/den; if(Math.abs(d)<1) lagF=bl+d; }
  }
  return 60*fs/lagF;
}

function loadScript(u){
  return new Promise((res,rej)=>{
    const s=document.createElement("script"); s.src=u;
    s.onload=res; s.onerror=()=>rej(new Error("加载失败: "+u));
    document.head.appendChild(s);
  });
}

async function applyEssentiaBeats(t, method){
  const be=await detectBeatsEssentia(t.buffer, method|| ($("beatHQ")&&$("beatHQ").checked? "multifeature":"degara"));
  if(!be) return false;
  t.beats=be.ticks; t.beatSrc="essentia"; t.beatConf=be.conf;
  t.downbeatPhase=pickDownbeatPhase(t); t.bpmExact=be.bpm;
  const ri=Math.round(be.bpm); if(Math.abs(be.bpm-ri)<0.15) t.bpmExact=ri;
  t.bpm=Math.abs(t.bpmExact-Math.round(t.bpmExact))<0.001? Math.round(t.bpmExact) : Math.round(t.bpmExact*10)/10;
  t._proc={};
  await analyzeStructure(t);
  console.log(`[beat] ${t.name} Essentia ${t.bpm}BPM · ${t.beats.length}拍 · 置信${(be.conf||0).toFixed(1)} · 相位${t.downbeatPhase}`);
  return true;
}

async function detectKeyEssentia(buffer){
  // 中段 ≤180s 重采样 16kHz 单声道 → KeyExtractor(edma 电子乐轮廓)
  const T=Math.min(buffer.duration,180);
  const start=Math.max(0,(buffer.duration-T)/2);
  const outSr=16000;
  const oc=new OfflineAudioContext(1,Math.max(1,Math.floor(T*outSr)),outSr);
  const s=oc.createBufferSource(); s.buffer=buffer;
  s.connect(oc.destination); s.start(0,start,T);
  const mono=(await oc.startRendering()).getChannelData(0);
  const vec=essentia.arrayToVector(mono);
  try{
    const r=essentia.KeyExtractor(vec,true,4096,4096,12,3500,60,25,0.2,"edma",outSr,0.0001,440,"cosine","hann");
    return NOTE_TO_CAMELOT[r.scale] ? (NOTE_TO_CAMELOT[r.scale][r.key]||null) : null;
  }finally{ vec.delete(); }
}

async function detectKey(buffer){
  if(essentia){
    try{ const k=await detectKeyEssentia(buffer); if(k) return k; }
    catch(e){ console.warn("Essentia 检测失败,回退内置",e); }
  }
  return detectKeyBuiltin(buffer);
}

async function detectBeatsEssentia(buffer, method){
  if(!essentia) return null;
  const outSr=44100; // RhythmExtractor2013 要求 44.1kHz
  const T=Math.min(buffer.duration, 420);
  const oc=new OfflineAudioContext(1, Math.max(1,Math.floor(T*outSr)), outSr);
  const s=oc.createBufferSource(); s.buffer=buffer;
  s.connect(oc.destination); s.start(0,0,T);
  const mono=(await oc.startRendering()).getChannelData(0);
  await new Promise(r=>setTimeout(r,0)); // 让 UI 先刷新进度
  const vec=essentia.arrayToVector(mono);
  try{
    const r=essentia.RhythmExtractor2013(vec, 208, method||"degara", 40);
    const ticks=essentia.vectorToArray(r.ticks);
    if(!ticks || ticks.length<8) return null;
    return {bpm:r.bpm, ticks:Array.from(ticks), conf:r.confidence};
  }finally{ vec.delete(); }
}

function beatTimeAt(t, idx){
  const g=t.beats; if(!g||!g.length) return null;
  if(idx>=0 && idx<g.length) return g[idx];
  if(idx<0){ const p=g[1]-g[0]; return g[0]+idx*p; }
  const n=g.length, p=g[n-1]-g[n-2];
  return g[n-1]+(idx-(n-1))*p;
}

function nearestBeatIdx(t, time){
  const g=t.beats; if(!g||!g.length) return null;
  let lo=0, hi=g.length-1;
  while(lo<hi){ const m=(lo+hi)>>1; if(g[m]<time) lo=m+1; else hi=m; }
  if(lo>0 && Math.abs(g[lo-1]-time)<=Math.abs(g[lo]-time)) lo--;
  return lo;
}

function gridDownbeat(t, approx){
  const g=t.beats; if(!g||!g.length) return null;
  const i=nearestBeatIdx(t, approx);
  const ph=t.downbeatPhase||0;
  let best=null, bd=Infinity;
  for(let k=-4;k<=4;k++){
    const j=i+k;
    if(j<0||j>=g.length) continue;
    if(((j-ph)%4+4)%4!==0) continue;
    const d=Math.abs(g[j]-approx);
    if(d<bd){ bd=d; best=g[j]; }
  }
  return best;
}

function pickDownbeatPhase(t){
  const g=t.beats; if(!g||g.length<16) return 0;
  const sr=t.buffer.sampleRate, ch=t.buffer.getChannelData(0);
  const win=Math.floor(sr*0.06);
  const score=[0,0,0,0];
  for(let i=0;i<g.length;i++){
    const s0=Math.floor(g[i]*sr);
    if(s0<0||s0+win>=ch.length) continue;
    let e=0; for(let j=0;j<win;j+=4){ const v=ch[s0+j]; e+=v*v; }
    score[i%4]+=Math.sqrt(e);
  }
  let bi=0; for(let i=1;i<4;i++) if(score[i]>score[bi]) bi=i;
  return bi;
}

async function detectKeyBuiltin(buffer){
  /* v3:KeyFinder(libkeyfinder,Mixxx 同款思路)式 constant-Q 半音带 chromagram
     - 下采样到 4410Hz 单声道 → FFT 16384,频率分辨率 0.27Hz(前版 5.4Hz),
       C1(32.7Hz)的半音间隔≈1.9Hz 也能整带分开,低音区彻底不涂抹
     - C1–B6 六个八度、每半音一个余弦核频带聚合 → 12 音级 chroma
     - 帧间中位数(而非求和):鼓点/瞬态帧不再污染整体
     - Krumhansl + Temperley 双轮廓集成打分 */
  try{
    const T=Math.min(buffer.duration,120);
    const start=Math.max(0,(buffer.duration-T)/2);
    const outSr=4410, len=Math.max(1,Math.floor(T*outSr));
    const oc=new OfflineAudioContext(1,len,outSr);
    const s=oc.createBufferSource(); s.buffer=buffer;
    s.connect(oc.destination); s.start(0,start,T);
    const ds=(await oc.startRendering()).getChannelData(0);
    const FR=16384, HOP=outSr; // 帧长 3.7s,步进 1s
    if(ds.length<FR) return null;
    const win=new Float32Array(FR);
    for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
    // 半音频带核:C1 起最多 72 带,带宽 ±0.6 半音,余弦权重
    const f0=32.7031956626, bands=[];
    for(let k=0;k<72;k++){
      const fc=f0*Math.pow(2,k/12);
      const lo=fc*Math.pow(2,-0.6/12), hi=fc*Math.pow(2,0.6/12);
      if(hi>=outSr/2) break;
      const b0=Math.max(1,Math.ceil(lo*FR/outSr)), b1=Math.min(FR/2-1,Math.floor(hi*FR/outSr));
      if(b1<b0) continue;
      const w=[];
      for(let b=b0;b<=b1;b++){
        const f=b*outSr/FR;
        w.push(0.5+0.5*Math.cos(Math.PI*Math.min(1,Math.abs(12*Math.log2(f/fc))/0.6)));
      }
      bands.push({pc:k%12,b0,b1,w});
    }
    const re=new Float32Array(FR), im=new Float32Array(FR);
    const frames=[]; let cnt=0;
    for(let p=0;p+FR<=ds.length;p+=HOP){
      let en=0; for(let i=0;i<FR;i+=8) en+=ds[p+i]*ds[p+i];
      if(en<1e-7) continue; // 跳过静音帧
      for(let i=0;i<FR;i++){ re[i]=ds[p+i]*win[i]; im[i]=0; }
      fft(re,im);
      const cf=new Float32Array(12);
      for(const bd of bands){
        let sum=0,j=0;
        for(let b=bd.b0;b<=bd.b1;b++,j++) sum+=Math.sqrt(re[b]*re[b]+im[b]*im[b])*bd.w[j];
        cf[bd.pc]+=sum;
      }
      frames.push(cf);
      if(++cnt%12===0) await new Promise(r=>setTimeout(r));
    }
    if(!frames.length) return null;
    const chroma=new Float32Array(12);
    for(let pc=0;pc<12;pc++){
      const vals=frames.map(f=>f[pc]).sort((a,b)=>a-b);
      chroma[pc]=vals[(vals.length-1)>>1];
    }
    const KS_MAJ=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
    const KS_MIN=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
    const TP_MAJ=[0.748,0.060,0.488,0.082,0.670,0.460,0.096,0.715,0.104,0.366,0.057,0.400];
    const TP_MIN=[0.712,0.084,0.474,0.618,0.049,0.460,0.105,0.747,0.404,0.067,0.133,0.330];
    const corr=(prof,rot)=>{
      let sx=0,sy=0,sxy=0,sxx=0,syy=0;
      for(let i=0;i<12;i++){ const x=chroma[(i+rot)%12], y=prof[i];
        sx+=x;sy+=y;sxy+=x*y;sxx+=x*x;syy+=y*y; }
      const den=Math.sqrt((12*sxx-sx*sx)*(12*syy-sy*sy))||1;
      return (12*sxy-sx*sy)/den;
    };
    let best=-9, bestKey=null;
    for(let r=0;r<12;r++){
      const cM=corr(KS_MAJ,r)+corr(TP_MAJ,r);
      if(cM>best){best=cM;bestKey=CAMELOT_MAJ[r];}
      const cm=corr(KS_MIN,r)+corr(TP_MIN,r);
      if(cm>best){best=cm;bestKey=CAMELOT_MIN[r];}
    }
    return bestKey;
  }catch(e){ console.warn("detectKey v3 失败",e); return null; }
}

async function analyzeStructure(t){
  t.sections=null;
  if(!t.bpm) return;
  const sr=t.buffer.sampleRate, ch=t.buffer.getChannelData(0), hop=512;
  const barDur=4*60/t.bpm;
  if(t.beats){ // Essentia 网格:直接取第一个 downbeat
    t.beatOffset=t.beats[0];
    t.barOffset=t.beats[t.downbeatPhase||0] ?? t.beats[0];
  }else{
    /* 回退:全曲 onset 包络 → 与 BPM 脉冲串互相关求节拍相位 */
    const env=[]; let prev=0;
    for(let i=0;i+hop<ch.length;i+=hop){
      let e=0; for(let j=0;j<hop;j+=4) e+=ch[i+j]*ch[i+j];
      e=Math.sqrt(e); env.push(Math.max(0,e-prev)); prev=e;
    }
    const P=(60/t.bpm)*sr/hop;
    let bestS=-1,bestPh=0;
    for(let ph=0; ph<P; ph+=0.25){
      let s=0,c=0;
      for(let x=ph;x<env.length;x+=P){ s+=env[x|0]||0; c++; }
      if(c && s/c>bestS){ bestS=s/c; bestPh=ph; }
    }
    let bestB=0,bestBs=-1;
    for(let b=0;b<4;b++){
      let s=0,c=0;
      for(let x=bestPh+b*P;x<env.length;x+=4*P){ s+=env[x|0]||0; c++; }
      if(c && s/c>bestBs){ bestBs=s/c; bestB=b; }
    }
    t.beatOffset=bestPh*hop/sr;
    t.barOffset=((bestPh+bestB*P)*hop/sr)%barDur;
  }
  /* 2) 分频段能量包络(FFT) */
  const FR=4096, FH=4096;
  const re=new Float32Array(FR), im=new Float32Array(FR);
  const win=new Float32Array(FR); for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const nF=Math.max(1,Math.floor((ch.length-FR)/FH));
  const fLow=new Float32Array(nF), fMid=new Float32Array(nF), fHi=new Float32Array(nF);
  for(let k=0;k<nF;k++){
    const p=k*FH;
    for(let i=0;i<FR;i++){ re[i]=ch[p+i]*win[i]; im[i]=0; }
    fft(re,im);
    let lo=0,md=0,hi=0;
    for(let b=1;b<FR/2;b++){
      const f=b*sr/FR, pw=re[b]*re[b]+im[b]*im[b];
      if(f<250) lo+=pw; else if(f<4000) md+=pw; else if(f<16000) hi+=pw;
    }
    fLow[k]=lo; fMid[k]=md; fHi[k]=hi;
    if(k%40===0) await new Promise(r=>setTimeout(r));
  }
  /* 3) 按 bar 聚合(对齐 downbeat) */
  const frameT=FH/sr, bars=[];
  for(let bs=t.barOffset; bs<t.dur-0.5; bs+=barDur){
    const k0=Math.max(0,Math.floor(bs/frameT)), k1=Math.min(nF,Math.ceil((bs+barDur)/frameT));
    if(k1<=k0) continue;
    let lo=0,md=0,hi=0;
    for(let k=k0;k<k1;k++){ lo+=fLow[k]; md+=fMid[k]; hi+=fHi[k]; }
    const n=k1-k0;
    bars.push({s:bs, e:Math.min(bs+barDur,t.dur), low:lo/n, hi:hi/n, E:(lo+md+hi)/n});
  }
  if(bars.length<4){ t.sections=[{s:0,e:t.dur,label:"VERSE"}]; return; }
  /* 4) 8-bar phrase 特征 + 启发式分类 */
  const phrases=[];
  for(let i=0;i<bars.length;i+=8){
    const g=bars.slice(i,i+8);
    const E=g.reduce((a,b)=>a+b.E,0)/g.length;
    const low=g.reduce((a,b)=>a+b.low,0)/g.length;
    const h1=g.slice(0,g.length>>1), h2=g.slice(g.length>>1);
    const m1=h1.reduce((a,b)=>a+b.E,0)/Math.max(h1.length,1);
    const m2=h2.reduce((a,b)=>a+b.E,0)/Math.max(h2.length,1);
    phrases.push({s:g[0].s, e:g[g.length-1].e, E, lowShare:low/(E||1e-12), slope:(m2-m1)/(E||1e-12)});
  }
  const Es=[...phrases].map(p=>p.E).sort((a,b)=>a-b);
  const pct=q=>Es[Math.min(Es.length-1,Math.floor(q*Es.length))];
  const lows=[...phrases].map(p=>p.lowShare).sort((a,b)=>a-b);
  const medLow=lows[(lows.length-1)>>1];
  phrases.forEach((p,i)=>{
    const first=i===0, last=i===phrases.length-1;
    if(first && p.E<pct(0.6)) p.label="INTRO";
    else if(last && p.E<pct(0.6)) p.label="OUTRO";
    else if(p.E>=pct(0.65) && p.lowShare>=medLow*0.85) p.label="DROP";
    else if(p.slope>0.3) p.label="BUILD";
    else if(p.E<pct(0.35) && p.lowShare<medLow*0.6) p.label="BREAK";
    else p.label="VERSE";
  });
  for(let i=0;i<phrases.length-1;i++) // DROP 前能量上行的 VERSE 改判 BUILD
    if(phrases[i].label==="VERSE" && phrases[i+1].label==="DROP" && phrases[i].slope>0.12) phrases[i].label="BUILD";
  const secs=[];
  for(const p of phrases){
    const lastS=secs[secs.length-1];
    if(lastS && lastS.label===p.label) lastS.e=p.e;
    else secs.push({s:p.s, e:p.e, label:p.label});
  }
  secs[0].s=0; secs[secs.length-1].e=t.dur;
  t.sections=secs;
}

async function analyzeTrack(t){
  if(t._anStarted) return; t._anStarted=true;
  /* 节拍检测默认走 Essentia(用户要求)。为避免主线程冻结:
     - 等待 Essentia 就绪(最多 20s)
     - 用 degara 模式(比 multifeature 快数倍),分析前后让出主线程刷新 UI
     - 失败/未加载时才自动回退内置算法 */
  try{
    await essentiaReady;
    await applyEssentiaBeats(t);
  }catch(e){ console.warn("Essentia 节拍不可用,回退内置:", e&&e.message); }
  try{
    if(t.beats) throw {skip:1}; // 已有 Essentia 网格,跳过内置检测
    /* 内置节拍跟踪 v2:同样产出逐拍网格,使逐拍同步内核在无 Essentia 时也能生效 */
    const tb=trackBeatsBuiltin(t.buffer);
    if(tb && tb.beats.length>32){
      t.beats=tb.beats; t.beatSrc="builtin"; t.beatConf=null;
      t.downbeatPhase=pickDownbeatPhase(t);
      t.bpmExact=tb.bpm;
      const ri=Math.round(tb.bpm); if(Math.abs(tb.bpm-ri)<0.15) t.bpmExact=ri;
      t.bpm=Math.abs(t.bpmExact-Math.round(t.bpmExact))<0.001? Math.round(t.bpmExact) : Math.round(t.bpmExact*10)/10;
      console.log(`[beat] ${t.name} 内置v2 ${t.bpm}BPM · ${t.beats.length}拍 · 相位${t.downbeatPhase}`);
    }else{
      const r=detectBPM(t.buffer);
      if(r){
        t.bpmExact=r.exact;
        const ri=Math.round(r.exact), rh=Math.round(r.exact*2)/2;
        if(Math.abs(r.exact-ri)<0.12) t.bpmExact=ri;
        else if(Math.abs(r.exact-rh)<0.06) t.bpmExact=rh;
        t.bpm=Math.abs(t.bpmExact-Math.round(t.bpmExact))<0.001? Math.round(t.bpmExact) : Math.round(t.bpmExact*10)/10;
      }
    }
  }catch(e){ if(!e||!e.skip) console.warn("BPM 检测失败",e); }
  try{ t.key=await detectKey(t.buffer); }catch(e){ console.warn("Key 检测失败",e); }
  try{ await analyzeStructure(t); }catch(e){ console.warn("结构分析失败",e); }
  try{ await analyzeVocals(t); }catch(e){ console.warn("人声检测失败",e); }
  t.analyzing=false; renderList();
}

function canBeatmatch(a,b){ return a&&b&&Math.abs(a-b)<=MAX_PAIR_DIFF; }

function pairTarget(a,b){
  if(!canBeatmatch(a,b)) return null;
  let T=(a+b)/2;
  T=Math.min(T, Math.min(a,b)+MAX_BPM_SHIFT);
  T=Math.max(T, Math.max(a,b)-MAX_BPM_SHIFT);
  return Math.round(T);
}

async function analyzeVocals(t){
  t.vocalMask=null;
  const buf=t.buffer, sr=buf.sampleRate, n=buf.length;
  const L=buf.getChannelData(0), R=buf.numberOfChannels>1? buf.getChannelData(1):null;
  const FR=2048, HOP=4096;
  const re=new Float32Array(FR), im=new Float32Array(FR), re2=new Float32Array(FR), im2=new Float32Array(FR);
  const win=new Float32Array(FR); for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const bLo=Math.max(1,Math.floor(VOC_LO*FR/sr)), bHi=Math.min(FR/2-1,Math.ceil(VOC_HI*FR/sr));
  /* 窗口边界:优先按 4 小节对齐真实拍网格,拿不到网格就按固定 8 秒 */
  const bounds=[];
  if(t.beats && t.beats.length>16){
    const ph=t.downbeatPhase||0;
    for(let i=ph;i<t.beats.length;i+=16) bounds.push(t.beats[i]);
    if(bounds[bounds.length-1]<t.dur-1) bounds.push(t.dur);
  }else{ for(let x=0;x<t.dur;x+=8) bounds.push(x); bounds.push(t.dur); }
  const mask=[]; let sideTotal=0, midTotal=0, k=0;
  for(let w=0;w<bounds.length-1;w++){
    const s0=Math.floor(bounds[w]*sr), s1=Math.min(n-FR, Math.floor(bounds[w+1]*sr));
    if(s1<=s0){ mask.push({s:bounds[w], e:bounds[w+1], hasVocal:false, conf:0}); continue; }
    let vMid=0, vSide=0, allMid=0, frames=0, prev=null, flux=0, flux2=0;
    for(let p=s0;p+FR<=s1;p+=HOP){
      for(let i=0;i<FR;i++){
        const l=L[p+i], r=R? R[p+i] : l;
        re[i]=(l+r)*0.5*win[i]; im[i]=0;
        re2[i]=(l-r)*0.5*win[i]; im2[i]=0;
      }
      fft(re,im); fft(re2,im2);
      let vm=0, vs=0, am=0;
      for(let b=1;b<FR/2;b++){
        const mm=Math.hypot(re[b],im[b]); am+=mm;
        if(b>=bLo&&b<=bHi){ vm+=mm; vs+=Math.hypot(re2[b],im2[b]); }
      }
      vMid+=vm; vSide+=vs; allMid+=am; frames++;
      if(prev!=null){ const d=Math.abs(vm-prev)/(prev+1e-9); flux+=d; flux2+=d*d; }
      prev=vm;
    }
    if(!frames){ mask.push({s:bounds[w], e:bounds[w+1], hasVocal:false, conf:0}); continue; }
    midTotal+=vMid; sideTotal+=vSide;
    const share=vMid/(allMid+1e-9);                       // 人声频段占比
    const center=vMid/(vMid+vSide+1e-9);                  // 居中程度
    const fm=flux/Math.max(1,frames-1);
    const fv=Math.sqrt(Math.max(0,flux2/Math.max(1,frames-1)-fm*fm)); // 频谱起伏
    mask.push({s:bounds[w], e:bounds[w+1], share, center, fv, hasVocal:false, conf:0});
    if((++k)%6===0) await new Promise(r2=>setTimeout(r2));
  }
  /* 单声道素材没有侧声道信息,此时关掉 center 项、只用占比与起伏 */
  const isMono = !R || sideTotal < midTotal*0.02;
  const nz=x=>Math.max(0,Math.min(1,x));
  for(const m of mask){
    if(m.share==null) continue;
    const sScore=nz((m.share-0.26)/0.30);
    const cScore=nz((m.center-0.55)/0.30);
    const fScore=nz((m.fv-0.12)/0.35);
    const score=isMono? (0.62*sScore+0.38*fScore) : (0.45*sScore+0.32*cScore+0.23*fScore);
    m.conf=+score.toFixed(3); m.hasVocal=score>0.5;
    delete m.share; delete m.center; delete m.fv;
  }
  /* 形态学平滑:孤立的单窗判定不可信(借鉴 Auto-DJ 的 is_vocal_clash_pred 做法) */
  for(let i=1;i<mask.length-1;i++)
    if(mask[i].hasVocal!==mask[i-1].hasVocal && mask[i].hasVocal!==mask[i+1].hasVocal) mask[i].hasVocal=mask[i-1].hasVocal;
  t.vocalMask=mask; t.vocalMono=isMono;
  const vr=mask.filter(m=>m.hasVocal).length/Math.max(1,mask.length);
  console.log(`[vocal] ${t.name} ${mask.length} 窗 · 有人声占比 ${(vr*100).toFixed(0)}%${isMono?" (单声道,精度较低)":""}`);
}

function vocalInRange(t, from, to){
  if(!t.vocalMask) return null;
  let v=0, tot=0;
  for(const w of t.vocalMask){
    const a=Math.max(w.s,from), b=Math.min(w.e,to);
    if(b<=a) continue;
    tot+=b-a; if(w.hasVocal) v+=b-a;
  }
  return tot>0? v/tot : null;
}

function beatSteadiness(t){
  const g=t.beats; if(!g||g.length<16) return 1;
  const iv=[]; for(let i=1;i<g.length;i++) iv.push(g[i]-g[i-1]);
  const m=iv.reduce((a,b)=>a+b,0)/iv.length;
  if(!(m>0)) return 1;
  let v=0; for(const x of iv) v+=(x-m)*(x-m);
  return Math.sqrt(v/iv.length)/m;             // 越小越稳,>0.08 视为不适合对齐
}

function isBeatSteady(t){ return beatSteadiness(t)<=0.08; }

function camelotCompatible(k1,k2){
  if(!k1||!k2) return false;
  const n1=parseInt(k1), l1=k1.slice(-1), n2=parseInt(k2), l2=k2.slice(-1);
  if(n1===n2) return true;                              // 同数字(同 key 或相对大小调)
  const d=Math.abs(n1-n2);
  return l1===l2 && (d===1||d===11);                    // 同字母 ±1(含 12↔1 环绕)
}

async function stretchRamp(buffer, tIn0, tIn1, r0, r1){
  const sr=buffer.sampleRate;
  const s0=Math.max(0,Math.floor(tIn0*sr)), s1=Math.min(buffer.length,Math.floor(tIn1*sr));
  const nCh=buffer.numberOfChannels, N=s1-s0;
  if(N<=0){ // 区间为空/倒置:返回空段,避免 new Float32Array(负数) 抛异常
    const ch=[]; for(let c=0;c<nCh;c++) ch.push(new Float32Array(0));
    return {length:0, ch};
  }
  if(Math.abs(r0-1)<0.0001 && Math.abs(r1-1)<0.0001){ // 仅在严格恒等时才走无损切片(0.3% 阈值曾导致 1/4 拍漂移)
    const ch=[]; for(let c=0;c<nCh;c++) ch.push(buffer.getChannelData(c).slice(s0,s1));
    return {length:N, ch};
  }
  const chIn=[]; for(let c=0;c<nCh;c++) chIn.push(buffer.getChannelData(c).subarray(s0,s1));
  const mono=new Float32Array(N);
  for(let i=0;i<N;i++){ let s=0; for(let c=0;c<nCh;c++) s+=chIn[c][i]; mono[i]=s/nCh; }
  const FR=4096, HOP=2048, SEEK=600, CORR=400;
  const win=new Float32Array(FR); for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const outCap=Math.ceil(N/Math.min(r0,r1))+FR*2;
  const chOut=[]; for(let c=0;c<nCh;c++) chOut.push(new Float32Array(outCap));
  let inPos=0, outPos=0, prevPos=0, endOut=0, fc=0;
  for(;;){
    const r=r0+(r1-r0)*Math.min(inPos/Math.max(N-FR,1),1);
    let base=Math.round(inPos);
    if(outPos>0){ // 波形对齐:在 nominal 附近找与上一帧自然延续最相关的位置
      const target=prevPos+HOP;
      if(target+CORR<N){
        let best=-1e18,bo=base;
        const lo=Math.max(0,base-SEEK), hi=Math.min(N-FR,base+SEEK);
        for(let cand=lo;cand<=hi;cand+=4){
          let s=0; for(let k=0;k<CORR;k+=2) s+=mono[cand+k]*mono[target+k];
          if(s>best){best=s;bo=cand;}
        }
        base=bo;
      }
    }
    if(base+FR>N) break;
    for(let c=0;c<nCh;c++){
      const d=chOut[c], src=chIn[c];
      for(let i=0;i<FR;i++) d[outPos+i]+=src[base+i]*win[i]; // Hann 50% OLA 增益恒定
    }
    endOut=outPos+FR; prevPos=base; outPos+=HOP; inPos+=HOP*r;
    if(++fc%120===0) await new Promise(res=>setTimeout(res)); // 让出主线程
  }
  return { length:endOut, ch:chOut.map(a=>a.subarray(0,endOut)) };
}

function spliceConcat(parts){ // 段间 2048 采样线性交叉消咔哒;返回每段在输出中的起点(供节拍参考点换算)
  const SP=2048;
  let cap=parts.reduce((a,p)=>a+p.length,0);
  const out=new Float32Array(cap); let o=0;
  const starts=[];
  parts.forEach((p,idx)=>{
    if(idx===0){ out.set(p,0); starts.push(0); o=p.length; return; }
    const xf=Math.min(SP,p.length,o);
    starts.push(o-xf);
    for(let i=0;i<xf;i++){ const w=i/xf; out[o-xf+i]=out[o-xf+i]*(1-w)+p[i]*w; }
    out.set(p.subarray(xf), o); o+=p.length-xf;
  });
  return {arr:out.subarray(0,o), starts};
}

function preciseLocalBPM(t, from, to, seed){
  if(!seed) return seed;
  let bpm=seed;
  for(const K of [8, 32]){
    const bar=240/bpm;
    const lo=Math.max(from, 0), hi=Math.min(to, t.dur);
    if(hi-lo < 6*bar) break;
    const a=refineDownbeat(t, lo+bar, bpm);
    const k=Math.min(K, Math.floor((hi-a-bar)/bar));
    if(k<4) break;
    const b=refineDownbeat(t, a+k*bar, bpm);
    const est=240*k/(b-a);
    if(isFinite(est) && Math.abs(est/bpm-1)<0.04) bpm=est;
  }
  const rInt=Math.round(bpm), rHalf=Math.round(bpm*2)/2;
  if(Math.abs(bpm-rInt)<0.12) bpm=rInt;
  else if(Math.abs(bpm-rHalf)<0.06) bpm=rHalf;
  return bpm;
}

function refineDownbeat(t, approx, bpmL){
  if(t.beats){ const g=gridDownbeat(t, approx); if(g!=null) return g; } // 有真实网格就用它
  return refineDownbeatBuf(t.buffer, approx, bpmL||t.bpmExact||t.bpm);
}

function gridLocalBPM(t, from, to){
  if(!t.beats) return null;
  const g=t.beats;
  let i0=nearestBeatIdx(t, from), i1=nearestBeatIdx(t, to);
  if(i1-i0<8) return null;
  // 用首尾拍的跨距求平均拍长(逐拍网格上无认错拍风险)
  return 60*(i1-i0)/(g[i1]-g[i0]);
}

function refineDownbeatBuf(buffer, approx, bpmUse){
  if(!bpmUse) return approx;
  const sr=buffer.sampleRate, ch=buffer.getChannelData(0), hop=256;
  const dur=buffer.length/sr;
  const beat=60/bpmUse, bar=4*beat;
  const from=Math.max(0, approx-bar), to=Math.min(dur, approx+bar*5);
  const i0=Math.floor(from*sr/hop), i1=Math.floor(to*sr/hop);
  const env=[]; let prev=0;
  for(let i=i0;i<i1;i++){
    const s=i*hop; let e=0;
    for(let j=0;j<hop;j+=4){ const v=ch[s+j]||0; e+=v*v; }
    e=Math.sqrt(e); env.push(Math.max(0,e-prev)); prev=e;
  }
  const fs=sr/hop;
  let best=-1, bestT=approx;
  for(let off=-bar/2; off<bar/2; off+=hop/sr){
    const cand=approx+off; if(cand<from) continue;
    let s=0;
    for(let k=0;k<16;k++){
      const idx=Math.round((cand+k*beat-from)*fs);
      if(idx>=0&&idx<env.length) s+=env[idx]*(k%4===0?2:1);
    }
    if(s>best){best=s;bestT=cand;}
  }
  return bestT;
}

async function renderBeatSynced(buffer, beats, k0, k1, B, seq){
  const sr=buffer.sampleRate, nCh=buffer.numberOfChannels;
  const L=Math.round(B*sr), n=seq? seq.length : Math.max(0,k1-k0), dur=buffer.length/sr;
  const out=[]; for(let c=0;c<nCh;c++) out.push(new Float32Array(n*L+OLA_XF));
  const aLen=Math.min(Math.round(ATTACK_SEC*sr), Math.floor(L*0.5));
  for(let i=0;i<n;i++){
    const s=seq? seq[i][0] : beats[k0+i], e=seq? seq[i][1] : beats[k0+i+1];
    if(!(e>s)) continue;
    if(!((e-s)/B>0.5&&(e-s)/B<2)) continue;      // 异常拍(检测跳拍)跳过,保持网格不动
    /* ① 瞬态保留:起音段原样复制,只拉伸尾部(WSOLA 的 Hann 窗会吃掉每拍开头 46ms,
          正是 kick 爆发点;实测起音陡度损失 95%、峰值损失 80%)。
       ② 留边渲染:WSOLA 每次调用的输出首尾各有约 46ms 窗淡变,逐拍调用会在每拍造成
          "起音后 25ms 电平塌陷 + 拍尾 13ms 静音"的周期性 chop。故向源两侧各多取一个
          OLA 边距渲染,再按精确偏移裁出所需部分,把带淡变的边缘丢弃。
       ③ 拍间不再淡到零,改为与相邻拍交叉过渡,消除低频相位断裂造成的 bass 爆音。
       注意:以上只改"取样边界",逐拍钉死的时序(第 i 拍落在 i×B)完全不变。 */
    const s0=Math.floor(s*sr);
    const restS=s+aLen/sr, slot=L-aLen, restOutLen=slot+OLA_XF;
    let seg=null, off=0;
    if(e>restS+0.005 && slot>0){
      const r=(e-restS)/(slot/sr);
      if(r>0.4&&r<2.5){
        const a=Math.max(0, restS-OLA_MARGIN_SEC*r), b=Math.min(dur, e+OLA_MARGIN_SEC*r);
        seg=await stretchRamp(buffer, a, b, r, r);
        off=Math.round((restS-a)/r*sr);          // 所需内容在留边输出中的起点
      }
    }
    for(let c=0;c<nCh;c++){
      const src=buffer.getChannelData(c), dst=out[c], base=i*L;
      // 起音原样复制(多写 OLA_XF 供后续交叉);与上一拍的尾部交叉,而非淡到零
      for(let j=0;j<aLen+OLA_XF && s0+j<src.length; j++){
        const v=src[s0+j];
        dst[base+j] = j<BEAT_XF ? dst[base+j]*(1-j/BEAT_XF)+v*(j/BEAT_XF) : v;
      }
      if(seg){
        const sc=seg.ch[Math.min(c,seg.ch.length-1)];
        const cnt=Math.min(restOutLen, Math.max(0, sc.length-off));
        for(let j=0;j<cnt;j++){
          const v=sc[off+j], p=base+aLen+j;
          dst[p] = j<OLA_XF ? dst[p]*(1-j/OLA_XF)+v*(j/OLA_XF) : v;
        }
      }
    }
    if(i%16===0) await new Promise(r2=>setTimeout(r2));
  }
  return {ch:out.map(a=>a.subarray(0,n*L)), length:n*L};
}

function labelAt(t, time){
  const s=t.sections; if(!s) return null;
  const f=s.find(x=>time>=x.s&&time<x.e); return f? f.label:null;
}

function loopSafe(t, time){
  const l=labelAt(t,time);
  return l==="INTRO"||l==="OUTRO"||l==="BREAK";
}

function buildBeatSeq(t, k0, kEnd, needBeats){
  const g=t.beats, seq=[];
  for(let k=k0;k<kEnd && seq.length<needBeats;k++){
    if(g[k+1]>g[k]) seq.push([g[k],g[k+1]]);
  }
  if(seq.length>=needBeats || !seq.length) return {seq, looped:0};
  const L=LOOP_BARS*4;
  if(seq.length<L+4) return {seq, looped:0};                     // 素材本身不足一个循环乐句
  const loopStart=seq[seq.length-L][0];
  if(!loopSafe(t, loopStart)) return {seq, looped:0};             // 该段不适合循环(有旋律/人声)
  const loop=seq.slice(seq.length-L);
  let reps=0;
  while(seq.length<needBeats && reps<LOOP_MAX_REPEATS){
    for(const iv of loop){ if(seq.length>=needBeats) break; seq.push(iv); }
    reps++;
  }
  return {seq, looped:reps};
}

function dbIndexNear(t, time){
  const g=t.beats, ph=t.downbeatPhase||0;
  if(!g||!g.length) return null;
  let i=nearestBeatIdx(t, time), best=null, bd=Infinity;
  for(let k=-8;k<=8;k++){
    const j=i+k;
    if(j<0||j>=g.length) continue;
    if(((j-ph)%4+4)%4!==0) continue;
    const d=Math.abs(g[j]-time);
    if(d<bd){ bd=d; best=j; }
  }
  return best;
}

async function getProcessedBeatSync(t, Tin, Tout, cf, mode, full){
  const key="bs|"+Tin+"|"+Tout+"|"+cf+"|"+mode+"|"+(full?"F":"P");
  t._proc=t._proc||{};
  if(t._proc[key]) return t._proc[key];
  const g=t.beats, sr=t.buffer.sampleRate, nCh=t.buffer.numberOfChannels, N=g.length;
  const secs=t.sections||[];
  const firstDrop=secs.find(x=>x.label==="DROP");
  const lastDrop=[...secs].reverse().find(x=>x.label==="DROP");
  const lastBreak=[...secs].reverse().find(x=>x.label==="BREAK");
  const RAMP=32; // 进出恒速区的渐变拍数

  /* ---- 头部(入歌) ---- */
  const headSegs=[], headSrc=[]; let inAnchor=null, inLen=null, headEndIn=0, cueIdx=null, headOutLen=0;
  if(Tin!=null){
    const B=60/Tin;
    const dropModes = mode==="drop_drop"||mode==="break_drop"||mode==="build_drop";
    let anchorIdx, leadBeats=0;
    if(dropModes && firstDrop){
      anchorIdx=dbIndexNear(t, firstDrop.s);
      if(mode==="drop_drop") leadBeats=4;
      else if(mode==="build_drop"){
        const bd=secs.find(x=>x.label==="BUILD" && x.e>firstDrop.s-8 && x.e<firstDrop.s+8);
        const bi=bd? dbIndexNear(t, bd.s):null;
        leadBeats = (bi!=null && anchorIdx!=null && anchorIdx>bi)? Math.min(64, anchorIdx-bi) : 16;
      }else leadBeats=16;
    }else{
      anchorIdx=dbIndexNear(t, g[t.downbeatPhase||0]);
    }
    if(anchorIdx==null) anchorIdx=(t.downbeatPhase||0);
    cueIdx=Math.max(0, anchorIdx-leadBeats);
    const need=Math.ceil(cf/B)+80;                       // 恒速跑道:覆盖 crossfade + 充足余量
    const endIdx=Math.min(N-2, cueIdx+need);
    if(endIdx-cueIdx<8) return null;
    headSegs.push(await renderBeatSynced(t.buffer, g, cueIdx, endIdx, B));
    headSrc.push([g[cueIdx], g[endIdx]]);
    headOutLen=(endIdx-cueIdx)*Math.round(B*sr)/sr;
    inAnchor=(anchorIdx-cueIdx)*B;
    inLen=(endIdx-anchorIdx)*B;
    // 渐变回原速
    const rEnd=Math.min(N-1, endIdx+RAMP);
    if(rEnd>endIdx+2){
      const srcBeat=(g[rEnd]-g[endIdx])/(rEnd-endIdx);
      headSegs.push(await stretchRamp(t.buffer, g[endIdx], g[rEnd], srcBeat/B, 1));
      headSrc.push([g[endIdx], g[rEnd]]);
      headEndIn=g[rEnd];
    }else headEndIn=g[endIdx];
  }

  /* ---- 尾部(出歌) ---- */
  const tailSegs=[]; let outAnchor=null, outLen=null, foStartOut=null, foCap=null,
        tailRampStartIn=t.dur, tailKind="outro", tailOutStart=0;
  if(Tout!=null){
    const B=60/Tout;
    let anchorIdx=null, foIdx=null, endIdx=null;
    const half=t.dur*0.5;                                 // 硬约束:出歌锚点必须过半
    if((mode==="drop_intro") && lastDrop && lastDrop.s>=half){
      anchorIdx=dbIndexNear(t, lastDrop.s); foIdx=dbIndexNear(t, lastDrop.e); tailKind="dropStart";
    }else if((mode==="drop_drop"||mode==="build_drop") && lastDrop && lastDrop.s>=half){
      anchorIdx=dbIndexNear(t, lastDrop.e); foIdx=anchorIdx; tailKind="dropEnd";
    }else if(mode==="break_drop" && lastBreak && lastBreak.e>=half){
      anchorIdx=dbIndexNear(t, lastBreak.e); foIdx=anchorIdx; tailKind="breakEnd";
    }else{
      const outro=[...secs].reverse().find(x=>x.label==="OUTRO");
      const at=outro? Math.max(outro.s, half) : Math.max(half, t.dur-Math.min(60, t.dur*0.3));
      anchorIdx=dbIndexNear(t, at); foIdx=anchorIdx; tailKind="outro";
    }
    if(anchorIdx==null) return null;
    const startIdx=Math.max(0, anchorIdx-4);
    if(foIdx==null||foIdx<startIdx) foIdx=anchorIdx;
    const need=Math.ceil(cf/B)+80;
    endIdx=Math.min(N-2, Math.max(foIdx, anchorIdx)+need);
    if(endIdx-startIdx<8) return null;
    // 进入恒速区前的渐变
    const rStart=Math.max(0, startIdx-RAMP);
    if(startIdx-rStart>2){
      const srcBeat=(g[startIdx]-g[rStart])/(startIdx-rStart);
      tailSegs.push({ramp:[g[rStart], g[startIdx], 1, srcBeat/B]});
      tailRampStartIn=g[rStart];
    }else tailRampStartIn=g[startIdx];
    tailSegs.push({sync:[startIdx, endIdx, B]});
    outAnchor=(anchorIdx-startIdx)*B;                     // 相对尾部恒速段起点
    outLen=(endIdx-anchorIdx)*B;
    foStartOut=(foIdx-startIdx)*B;
    foCap=(endIdx-foIdx)*B;
  }

  /* ---- 拼接 ---- */
  const midS=Math.floor(headEndIn*sr), midE=Math.max(midS, Math.floor(tailRampStartIn*sr));
  const rendered=[], tailSrc=[];
  for(const s of tailSegs){
    if(s.ramp){ rendered.push(await stretchRamp(t.buffer, s.ramp[0], s.ramp[1], s.ramp[2], s.ramp[3])); tailSrc.push([s.ramp[0], s.ramp[1]]); }
    else { rendered.push(await renderBeatSynced(t.buffer, g, s.sync[0], s.sync[1], s.sync[2])); tailSrc.push([g[s.sync[0]], g[s.sync[1]]]); }
  }
  /* 预览模式只保留「头部同步段 + 尾部同步段」,不复制中间原速段:
     过渡只用到头尾各几十秒,中段是逐采样原样复制,却让每首歌内存翻倍
     (61 分钟歌单实测 1295MB 全长副本 → 206MB)。锚点由实际拼接位置 starts[] 推出,
     因此对齐算法完全不受影响。导出时改用 full=true 走完整拼接。 */
  const keepMid = full && midE>midS;
  let starts=null, totalLen=0; const chans=[];
  for(let c=0;c<nCh;c++){
    const parts=[];
    headSegs.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    if(keepMid) parts.push(t.buffer.getChannelData(c).subarray(midS,midE));
    rendered.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    const r=spliceConcat(parts);
    chans.push(r.arr); starts=r.starts; totalLen=r.arr.length;
  }
  ensureCtx();
  const out=ctx.createBuffer(nCh, totalLen, sr);
  for(let c=0;c<nCh;c++) out.getChannelData(c).set(chans[c]);
  /* 精确的 源时间→输出时间 分段映射(各段速率不同,不能用均匀比例换算) */
  const srcRanges=[...headSrc, ...(keepMid?[[headEndIn, tailRampStartIn]]:[]), ...tailSrc];
  const segLens=[...headSegs.map(x=>x.length), ...(keepMid?[midE-midS]:[]), ...rendered.map(x=>x.length)];
  const map=[];
  for(let i=0;i<srcRanges.length;i++){
    const o0=starts[i]/sr, o1=o0+segLens[i]/sr;
    if(srcRanges[i][1]>srcRanges[i][0]+1e-6) map.push({s0:srcRanges[i][0], s1:srcRanges[i][1], o0, o1});
  }
  // 尾部恒速段在输出中的起点 = starts 最后一项
  if(Tout!=null){
    tailOutStart=starts[starts.length-1]/sr;
    outAnchor+=tailOutStart; foStartOut+=tailOutStart;
  }
  const rec={buf:out, inAnchor, inLen, outAnchor, outLen, foStartOut, foCap,
             headKind:"intro", tailKind, beatSync:true, map};
  t._proc[key]=rec;
  return rec;
}

async function getProcessed(t, Tin, Tout, cf, mode, full){
  /* 有 Essentia 逐拍网格 → 一律走逐拍同步内核(用户要求:全程用 Essentia 节拍对齐) */
  if(t.beats && t.beats.length>32){
    try{
      const r=await getProcessedBeatSync(t, Tin, Tout, cf, mode, full);
      if(r) return r;
      console.warn("[beat] 逐拍同步不适用(锚点/拍数不足),回退:", t.name);
    }catch(e){ console.warn("[beat] 逐拍同步失败,回退:", t.name, e); }
  }
  if(mode==="v15") return getProcessedV15(t, Tin, Tout, cf);
  const key=Tin+"|"+Tout+"|"+cf+"|"+mode;
  t._proc=t._proc||{};
  if(t._proc[key]) return t._proc[key];
  const sr=t.buffer.sampleRate, nCh=t.buffer.numberOfChannels;
  const bpmX=t.bpmExact||t.bpm;
  const beat=60/bpmX, barN=4*beat;
  const rampBeats=Math.max(4, Math.min(64, Math.floor(t.dur*0.15*bpmX/60)));
  const rampIn=rampBeats*beat;
  const secs=t.sections||[];
  /* 恒速跑道:目标 48 小节,但一首歌头尾各需一条跑道,故上限取时长的 30%,
     并强制头部覆盖不越过尾部起点(否则区间倒置 → 渲染异常 → "生成失败") */
  const RUNWAY_SEC=Math.min(48*4*60/bpmX, t.dur*0.30);
  const HEAD_MAX=t.dur*0.55;
  const firstDrop=secs.find(x=>x.label==="DROP");
  const lastDrop=[...secs].reverse().find(x=>x.label==="DROP");

  /* ---- 头部(入歌侧):按接歌方式选 cue 点与锚点 ---- */
  const headSegs=[]; let cueIn=0, headEndIn=0, inAnchorIn=null, inLenIn=0, r2=1, headKind="intro";
  if(Tin!=null){
    const dropInModes = mode==="drop_drop"||mode==="break_drop"||mode==="build_drop";
    const wantDropIn = dropInModes && firstDrop && firstDrop.s>2*barN && firstDrop.s<t.dur*0.6;
    if(wantDropIn){ // 锚点 = 自己第一个 DROP 起点;cue 提前量按手法不同
      headKind="drop";
      let bpmH=gridLocalBPM(t, Math.max(0,firstDrop.s-40), Math.min(t.dur,firstDrop.s+50));
      if(!bpmH){
        bpmH=localExactBPM(t, Math.max(0,firstDrop.s-30), Math.min(t.dur,firstDrop.s+30))||bpmX;
        bpmH=preciseLocalBPM(t, Math.max(0,firstDrop.s-40), Math.min(t.dur,firstDrop.s+50), bpmH);
      }
      r2=Tin/bpmH;
      console.log("[align] 入歌", t.name, "本地BPM", bpmH.toFixed(3), "rate", r2.toFixed(5));
      const barH=4*60/bpmH;
      const anchor=refineDownbeat(t, firstDrop.s, bpmH); // 锚点 = 自己 drop 起点 downbeat
      let leadBars=4;                                     // break_drop:4 小节铺垫盖在出歌 break 上
      if(mode==="drop_drop") leadBars=1;                  // drop 续接:1 小节即砸
      else if(mode==="build_drop"){                       // buildup 进场:带完整 BUILD 段
        const build=secs.find(x=>x.label==="BUILD" && x.e>firstDrop.s-2*barH && x.e<firstDrop.s+2*barH);
        leadBars = build? Math.min(16, Math.max(4, Math.round((firstDrop.s-build.s)/barH))) : 4;
      }
      cueIn=Math.max(0, anchor-leadBars*barH);
      // 恒速跑道:防止入歌提前滑回原速导致与出歌越跑越远
      const coverEnd=Math.min(anchor+RUNWAY_SEC, HEAD_MAX);
      headEndIn=Math.min(coverEnd+rampIn, HEAD_MAX+rampIn);
      headSegs.push(await stretchRamp(t.buffer, cueIn, coverEnd, r2, r2));
      if(headEndIn>coverEnd+0.05) headSegs.push(await stretchRamp(t.buffer, coverEnd, headEndIn, r2, 1));
      inAnchorIn=anchor; inLenIn=coverEnd-anchor; // 跑道长度(锚点之后可用的恒速时长)
    }else{ // 默认:INTRO 从头进,锚点 = intro 第一个 downbeat
      let bpmH=gridLocalBPM(t, 0, Math.min(t.dur*0.6, 100));
      if(!bpmH){
        bpmH=localExactBPM(t, 0, Math.min(t.dur*0.5, 60))||bpmX;
        bpmH=preciseLocalBPM(t, 0, Math.min(t.dur*0.6, 100), bpmH);
      }
      r2=Tin/bpmH;
      console.log("[align] 入歌", t.name, "本地BPM", bpmH.toFixed(3), "rate", r2.toFixed(5));
      const intro=secs.find(x=>x.label==="INTRO");
      const introEndIn=Math.max(4*barN, Math.min(intro? intro.e : (t.barOffset||0)+16*barN, t.dur*0.4));
      const anchor0=Math.max(0, refineDownbeat(t, t.barOffset||0, bpmH));
      // 跑道 = max(intro 长度, RUNWAY 小节):出歌 outro/drop 可能远长于入歌 intro,
      // 平台必须一直铺到过渡结束,否则入歌中途滑回原速 → 与出歌越跑越远(v16 起的跑马根因)
      const coverIn=Math.min(Math.max(introEndIn+2*barN, anchor0+RUNWAY_SEC), HEAD_MAX);
      headEndIn=Math.min(coverIn+rampIn, HEAD_MAX+rampIn);
      headSegs.push(await stretchRamp(t.buffer, 0, coverIn, r2, r2));
      if(headEndIn>coverIn+0.05) headSegs.push(await stretchRamp(t.buffer, coverIn, headEndIn, r2, 1));
      inAnchorIn=Math.min(anchor0, coverIn-barN);
      inLenIn=coverIn-inAnchorIn;
    }
  }

  /* ---- 尾部(出歌侧):锚点硬性 ≥50% 时长(第一首必须大部分演奏完) ---- */
  const tailSegs=[]; let tailStartIn=t.dur, plateauStartIn=t.dur, cutIn=t.dur,
        outAnchorIn=null, foStartIn=null, r1=1, tailKind="outro";
  if(Tout!=null){
    let bpmT=gridLocalBPM(t, Math.max(0,t.dur-100), t.dur);
    if(!bpmT){
      bpmT=localExactBPM(t, Math.max(0,t.dur-60), t.dur)||bpmX;
      bpmT=preciseLocalBPM(t, Math.max(0,t.dur-100), t.dur, bpmT);
    }
    r1=Tout/bpmT;
    console.log("[align] 出歌", t.name, "本地BPM", bpmT.toFixed(3), "rate", r1.toFixed(5));
    const barT4=4*60/bpmT;
    const lastBreak=[...secs].reverse().find(x=>x.label==="BREAK");
    /* 按手法选出歌方案,缺 section 逐级回退(硬约束:锚点 ≥50% 时长) */
    let tailPlan="outro";
    if(mode==="drop_intro" && lastDrop && lastDrop.s>=t.dur*0.5) tailPlan="dropStart";
    else if((mode==="drop_drop"||mode==="build_drop") && lastDrop && lastDrop.s>=t.dur*0.5) tailPlan="dropEnd";
    else if(mode==="break_drop"){
      if(lastBreak && lastBreak.e>=t.dur*0.5) tailPlan="breakEnd";
      else if(lastDrop && lastDrop.s>=t.dur*0.5) tailPlan="dropEnd"; // 无 break 退为 drop 续接
    }
    if(tailPlan==="dropStart"||tailPlan==="dropEnd"){
      const ds=refineDownbeat(t, lastDrop.s, bpmT);                              // 末 drop 起点
      const de=refineDownbeat(t, Math.min(lastDrop.e, t.dur-2*barT4), bpmT);     // 末 drop 终点
      if(tailPlan==="dropStart"){ // 入歌骑 drop:对齐锚点=drop 起点;drop 放完(de)才开始淡出
        tailKind="dropStart"; outAnchorIn=ds; foStartIn=Math.max(de, ds+barT4); cutIn=t.dur;
      }else{ // drop 续接:对齐锚点=drop 终点,快速换手;终点后 2 小节即裁掉(不播 outro)
        tailKind="dropEnd"; outAnchorIn=de; foStartIn=de; cutIn=Math.min(de+2*barT4, t.dur);
      }
      plateauStartIn=Math.max(ds-barT4, t.dur*0.45, headEndIn);
    }else if(tailPlan==="breakEnd"){ // breakdown 演完,入歌 drop 在 break 结束 downbeat 上砸进来
      const be=refineDownbeat(t, Math.min(lastBreak.e, t.dur-2*barT4), bpmT);
      tailKind="breakEnd"; outAnchorIn=be; foStartIn=be; cutIn=Math.min(be+2*barT4, t.dur);
      plateauStartIn=Math.max(be-6*barT4, t.dur*0.4, headEndIn); // 平台盖住 break 尾 6 小节,供入歌铺垫叠放
    }else{ // 默认/回退:OUTRO 出
      const outro=[...secs].reverse().find(x=>x.label==="OUTRO");
      let anchor=outro? outro.s : t.dur-Math.min(16*barT4, t.dur*0.25);
      anchor=Math.min(Math.max(anchor, t.dur*0.5), t.dur-2*barT4);
      anchor=refineDownbeat(t, anchor, bpmT);
      outAnchorIn=anchor; foStartIn=anchor; cutIn=t.dur;
      plateauStartIn=Math.max(anchor-barT4, t.dur*0.45, headEndIn);
    }
    tailStartIn=Math.max(plateauStartIn-rampIn, headEndIn, t.dur*0.35);
    plateauStartIn=Math.max(plateauStartIn, tailStartIn);
    /* 头尾区域必须不重叠且尾部平台非空,否则放弃锚点走备用过渡(而不是抛异常) */
    if(!(cutIn>plateauStartIn+0.05) || !(plateauStartIn>=tailStartIn) || !(tailStartIn>=headEndIn-1e-6)){
      console.warn(`[align] ${t.name} 尾部区域退化(head到${headEndIn.toFixed(1)}s / tail起${tailStartIn.toFixed(1)}s / 平台${plateauStartIn.toFixed(1)}–${cutIn.toFixed(1)}s),该侧改用备用过渡`);
      tailSegs.length=0; tailStartIn=t.dur; plateauStartIn=t.dur; cutIn=t.dur;
      outAnchorIn=null; foStartIn=null;
    }else{
      tailSegs.push(await stretchRamp(t.buffer, tailStartIn, plateauStartIn, 1, r1));
      tailSegs.push(await stretchRamp(t.buffer, plateauStartIn, cutIn, r1, r1));
      if(outAnchorIn<plateauStartIn || foStartIn<plateauStartIn){ outAnchorIn=null; foStartIn=null; } // 退化放弃
    }
  }
  const midS=Math.floor(headEndIn*sr), midE=Math.max(midS, Math.floor(tailStartIn*sr));
  let starts=null, totalLen=0;
  const chans=[];
  for(let c=0;c<nCh;c++){
    const parts=[];
    headSegs.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    parts.push(t.buffer.getChannelData(c).subarray(midS,midE));
    tailSegs.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    const r=spliceConcat(parts);
    chans.push(r.arr); starts=r.starts; totalLen=r.arr.length;
  }
  ensureCtx();
  const out=ctx.createBuffer(nCh, totalLen, sr);
  for(let c=0;c<nCh;c++) out.getChannelData(c).set(chans[c]);
  const totalOut=totalLen/sr;
  /* 锚点/淡出窗换算到输出时间(平台内映射线性) */
  let inAnchor=null, inLen=null, outAnchor=null, outLen=null, foStartOut=null, foCap=null;
  if(Tin!=null && inAnchorIn!=null){
    inAnchor = starts[0]/sr + (inAnchorIn-cueIn)/r2;
    inLen = Math.max(0, inLenIn/r2);
  }
  if(Tout!=null && outAnchorIn!=null){
    const pOut=starts[starts.length-1]/sr;
    outAnchor = pOut + (outAnchorIn-plateauStartIn)/r1;
    foStartOut = pOut + (foStartIn-plateauStartIn)/r1;
    outLen = totalOut-outAnchor;
    foCap = totalOut-foStartOut;
  }
  const rec={buf:out, inAnchor, inLen, outAnchor, outLen, foStartOut, foCap, headKind, tailKind};
  t._proc[key]=rec;
  return rec;
}

async function buildSchedule(progress, full){
  const align = $("tempoAlign").checked;
  const n = tracks.length;
  const pairT=[], ovlBars=[], ovlInfo=[];
  for(let i=0;i<n-1;i++){
    const A=tracks[i], Bt=tracks[i+1], a=A.bpm, b=Bt.bpm;
    /* ① 节拍不稳(民谣/氛围/现场等自由速度)→ 不做 beatmatch,退回长音量淡化 */
    const steady = isBeatSteady(A) && isBeatSteady(Bt);
    pairT[i] = (align && steady)? pairTarget(a,b) : null;
    if(align && a && b && pairT[i]==null)
      (tracks[i]._noMixWhy=tracks[i]._noMixWhy||{})[i] = !steady? "节拍不稳" : `BPM 差 ${Math.abs(a-b).toFixed(1)}>20`;
    if(align && a && b && pairT[i]==null){
      const why = !steady? `节拍不稳(变异 ${(Math.max(beatSteadiness(A),beatSteadiness(Bt))*100).toFixed(1)}%)`
                         : `BPM 相差 ${Math.abs(a-b).toFixed(1)} > ${MAX_PAIR_DIFF}`;
      console.warn(`[mix] 过渡 ${i+1}→${i+2}:${why},不做变速对齐`);
    }
    /* ② 过渡长度 + 人声冲突决策 */
    const dec=chooseOverlapBars(A, Bt);
    ovlBars[i]=dec.bars; ovlInfo[i]=dec;
    if(dec.why) console.log(`[vocal] 过渡 ${i+1}→${i+2}:${dec.why}`);
  }
  /* 每首歌的渲染跑道按它实际参与的两个过渡取最大,避免为了 32 小节的余量白渲一大段 */
  const cfSecFor=i=>{
    const T=pairT[i]||pairT[i-1]||tracks[i].bpm||128, barT=4*60/T;
    const bars=Math.max(i>0? (ovlBars[i-1]||8):0, i<n-1? (ovlBars[i]||8):0, 4);
    return Math.min(bars, MAX_OVL_BARS)*barT;
  };
  /* 无法 beatmatch 时的回退过渡长度(秒):按所选小节数折算成时间。
     1.6 曾把它写死为 0,导致回退路径 overlap=0 —— 两首歌直接首尾相接、完全没有过渡。 */
  const bpmAvg=(()=>{ const v=tracks.map(t=>t.bpm).filter(Boolean); return v.length? v.reduce((a,b)=>a+b,0)/v.length : 120; })();
  const cf = Math.max(6, (parseInt($("ovlSel").value)||8) * 4*60/bpmAvg);
  const mode=$("mixMode").value;
  const items=[];
  const mk=(t,p,buf)=>{
    const dur=buf.length/buf.sampleRate;
    return {track:t, buf, dur,
      map:p?p.map:null,
      inAnchor:p?p.inAnchor:null, inLen:p?p.inLen:null,
      outAnchor:p?p.outAnchor:null, outLen:p?p.outLen:null,
      foStartOut:p?p.foStartOut:null, foCap:p?p.foCap:null,
      headKind:p?p.headKind:"intro", tailKind:p?p.tailKind:"outro",
      mode, beatSync:!!(p&&p.beatSync),
      start:0, cfIn:0, cfOut:0, foStart:dur};
  };
  let renderCount=0;
  const render=async (i, TinAdj)=>{
    renderCount++;
    const Tin=i>0? (TinAdj!=null? TinAdj : pairT[i-1]) : null, Tout=i<n-1? pairT[i]:null;
    if(Tin==null && Tout==null) return mk(tracks[i], null, tracks[i].buffer);
    const p=await getProcessed(tracks[i], Tin, Tout, cfSecFor(i), mode, full);
    return mk(tracks[i], p, p.buf);
  };
  /* 顺序处理:渲染 i → 与 i-1 做闭环速率校正(必要时按实测残差重渲 i)→ 排程该过渡 */
  for(let i=0;i<n;i++){
    if(progress) progress(i,n);
    let it=await render(i);
    if(i>0){
      const cur=items[i-1];
      if(pairT[i-1]!=null && cur.outAnchor!=null && it.inAnchor!=null){
        const T=pairT[i-1], barT=4*60/T, beatT=60/T;
        const win=Math.min(cur.outLen||0, it.inLen||0, 32*barT);
        if(win>=8*beatT && !full){
          /* 单轨实测:各自和目标 BPM 比,不依赖两曲互相关 */
          const mo=measureRenderedBeat(cur.buf, cur.outAnchor, cur.outAnchor+win, T);
          let mi=measureRenderedBeat(it.buf, it.inAnchor, it.inAnchor+win, T);
          const rep=(tag,m)=>m? `${m.bpm.toFixed(3)}BPM(${((m.bpm/T-1)*100).toFixed(3)}%)`:"测不到";
          console.log(`[align] 过渡 ${i}→${i+1} 目标${T}BPM 窗口${win.toFixed(0)}s · 出歌实测 ${rep("out",mo)} · 入歌实测 ${rep("in",mi)}`);
          /* 闭环速率校正只用于"匀速拉伸"路径。逐拍同步下速率已逐拍钉死(实测残差 <0.01%),
             再跑这个循环最多会把同一首歌重渲 3 次(共 4 份 buffer,一首 6 分钟歌每份 127MB),
             是生成缓慢与内存爆掉的主因之一,故直接跳过。 */
          if(mi && !(cur.beatSync && it.beatSync)){
            let acc=1;
            for(let k=0;k<3 && mi && Math.abs(mi.bpm/T-1)>0.0002; k++){
              acc*=T/mi.bpm;
              const cand=await render(i, T*acc);
              const mm=measureRenderedBeat(cand.buf, cand.inAnchor, cand.inAnchor+win, T);
              if(!mm) break;
              it=cand; mi=mm;
              console.log(`[align]   入歌第${k+1}轮 → ${mi.bpm.toFixed(3)}BPM(${((mi.bpm/T-1)*100).toFixed(3)}%)`);
            }
          }else if(mi){
            console.log(`[align]   逐拍同步:跳过闭环重渲(残差 ${((mi.bpm/T-1)*100).toFixed(3)}%)`);
          }
          // 残余静态错位仍用互相关(仅需对齐相位,±半拍内)
          /* 逐拍同步时锚点已精确对齐,不再叠加互相关相位微调(会把入歌推歪) */
          const m=(cur.beatSync&&it.beatSync)? null
                 : measureAlign(cur.buf, cur.outAnchor, it.buf, it.inAnchor, Math.min(win,8*barT), beatT);
          if(m && m.score>0.04) it.startShift=-(m.offset||0);
          const mo2=mo, mi2=mi;
          it.diag={T, out:mo2? mo2.bpm:null, in:mi2? mi2.bpm:null, win,
                   drift: (mo2&&mi2)? (mi2.bpm/mo2.bpm-1) : null,
                   offset: m? m.offset:null};
        }
      }
    }
    items.push(it);
    if(i>0){
      const inf=ovlInfo[i-1]||{};
      items[i-1].midCutDb=inf.midCutDb; it.midCutDb=inf.midCutDb;
      items[i-1].mixNote=inf.why||""; items[i-1].vocOut=inf.va; items[i-1].vocIn=inf.vb;
      schedulePair(items[i-1], it, pairT[i-1], cf, ovlBars[i-1]);
    }
  }
  const last=items[n-1];
  /* 清理陈旧的 _proc 缓存:每首歌只保留本次实际使用的那一份。
     每份全长副本对 6 分钟歌约 127MB,反复改参数重新生成会让旧副本一直被缓存引用而无法回收
     —— 这是"生成几次之后按钮要等十秒"的直接原因。 */
  let freed=0;
  for(const t of tracks){
    if(!t._proc) continue;
    const used=items.find(it=>it.track===t);
    for(const k of Object.keys(t._proc)){
      if(!used || t._proc[k].buf!==used.buf){ freed++; delete t._proc[k]; }
    }
  }
  console.log(`[perf] 生成完成:${n} 首歌渲染 ${renderCount} 次(理想=歌数)· 释放陈旧缓存 ${freed} 份`);
  const sch = { items, total: last.start+last.dur, pairT, ovlInfo, meta: currentMeta(), full:!!full };
  if(full) return sch;
  schedule = sch;
}

function schedulePair(cur, nxt, T, cf, ovlBars){
      /* v15 排程:overlap = slider 时长取整小节,全程等功率渐变(无平台段、无裁尾) */
      if(cur.mode==="v15"){
        if(T!=null && cur.outAnchor!=null && nxt.inAnchor!=null){
          const barT=4*60/T;
          const s=cur.start+cur.outAnchor-nxt.inAnchor+(nxt.startShift||0);
          let ovl=Math.min((ovlBars||8)*barT, cur.outLen-barT*0.25, nxt.inLen);
          ovl=Math.max(barT, Math.floor(ovl/barT+1e-6)*barT);
          cur.foStart=cur.outAnchor; cur.cfOut=Math.min(ovl, cur.dur-cur.outAnchor);
          nxt.cfIn=ovl; nxt.start=s;
        }else{
          const cfNom=Math.max(2, Math.min(cf, cur.dur*0.45, nxt.dur*0.45));
          cur.foStart=Math.max(0, cur.dur-cfNom); cur.cfOut=cfNom; nxt.cfIn=cfNom;
          nxt.start=cur.start+cur.dur-cfNom;
        }
        return;
      }
      if(T!=null && cur.outAnchor!=null && nxt.inAnchor!=null){
      const barT=4*60/T;
      const s=cur.start+cur.outAnchor-nxt.inAnchor+(nxt.startShift||0); // startShift=闭环实测的残余错位补偿
      /* 包络原则:淡入/淡出只占 overlap 两端各 ≤2 小节,中段两首歌全音量同奏(smooth 的关键) */
      let foStart=cur.foStartOut!=null? cur.foStartOut : cur.outAnchor;
      let fo, fi;
      if(cur.tailKind==="dropEnd"||cur.tailKind==="breakEnd"){ // drop/break 收尾快速换手;入歌 2 小节内推满,同奏整个铺垫段
        fo=Math.max(barT*0.5, Math.min(barT, cur.foCap||barT));
        fi=Math.max(barT*0.5, Math.min(2*barT, nxt.inLen||barT));
      }else if(cur.tailKind==="dropStart"){ // 入歌骑末尾 drop:2 小节推满,与 drop 全程同奏;drop 放完后 2 小节收掉
        fo=Math.max(barT, Math.min(2*barT, cur.foCap||barT));
        fi=Math.max(barT, Math.min(2*barT, nxt.inLen||2*barT));
      }else{  /* OUTRO 长混:overlap = 自适应小节数(受两侧恒速跑道上限约束)。
                 注意:1.6 之前这里用 min(跑道,64小节) 当 overlap,导致设 15s 实际混了 50s
                 —— 跑道里 80 拍的防漂移余量被当成过渡长度用掉了。现在跑道只做上限。 */
        const want=(ovlBars||8)*barT;
        let ovl=Math.min(want, cur.outLen-barT*0.25, nxt.inLen||barT);
        ovl=Math.max(barT, Math.floor(ovl/barT+1e-6)*barT);
        const fe=Math.max(barT*0.5, Math.min(2*barT, ovl/2)); // 缘淡变宽度
        fi=fe;
        fo=fe; foStart=foStart+ovl-fe; // 出歌满音量播完 overlap 中段,最后 fe 收掉
      }
      fo=Math.min(fo, cur.dur-foStart);
      /* 跑道校验:整个 overlap(从入歌进场到出歌淡出结束)必须落在两边的恒速平台内,
         否则一方会中途滑回原速造成持续漂移。超出则把出歌淡出提前到跑道末端。 */
      const overlapDur=(cur.start+foStart+fo)-s; // 全局时间轴上的 overlap 总长
      const runway=Math.min(nxt.inLen||Infinity, (cur.outLen||Infinity));
      if(overlapDur>runway+0.01){
        const cut=overlapDur-runway;
        foStart=Math.max(cur.outAnchor, foStart-cut);
        fo=Math.min(fo, cur.dur-foStart);
        console.warn(`[align] overlap ${overlapDur.toFixed(1)}s 超出跑道 ${runway.toFixed(1)}s,已缩短过渡`);
      }
      cur.foStart=foStart; cur.cfOut=fo; nxt.cfIn=fi;
      nxt.start=s;
      /* BASS SWAP:入歌进场时低频被切掉,到某个 downbeat 与出歌对调。
         两条 bassline 永不同时存在 —— 跨曲风通用的一条规则,同时解决浑浊与 headroom。
         交换点按接歌方式选:长混取 overlap 中点(对齐小节);drop 骑乘型在出歌 drop 放完时交;
         快速换手型就在锚点上交。 */
      {
        const ovlDur=(cur.start+foStart+fo)-s, ovlEnd=cur.start+foStart+fo;
        let swap;
        if(cur.tailKind==="dropStart") swap=cur.start+foStart;              // 出歌 drop 放完才交
        else if(cur.tailKind==="dropEnd"||cur.tailKind==="breakEnd") swap=s; // 快速换手:锚点即交
        else swap=s+Math.max(barT, Math.round(ovlDur/2/barT)*barT);          // 长混:中点对齐小节
        swap=Math.min(Math.max(swap, s), ovlEnd);
        setEqSwapTimes(cur, nxt, swap, s, ovlEnd, barT);
      }
      console.log(`[align] overlap=${((cur.start+cur.foStart+cur.cfOut)-s).toFixed(1)}s · 跑道 出${(cur.outLen||0).toFixed(1)}s 入${(nxt.inLen||0).toFixed(1)}s`);
    }else{
      /* 未做 beatmatch(BPM 差过大/节拍不稳):两轨节奏对不上,全音量同奏会很难听,
         改为全程等功率交叉淡化 —— 这也是 DJ 遇到接不了的歌时的做法。 */
      const cfNom=Math.max(2, Math.min(cf, cur.dur*0.45, nxt.dur*0.45));
      cur.foStart=Math.max(0, cur.dur-cfNom); cur.cfOut=cfNom; nxt.cfIn=cfNom;
      nxt.start=cur.start+cur.dur-cfNom;
      /* §3.5:回退路径(未 beatmatch)同样做三段 EQ 交换,交换点取 overlap 中点 */
      const s0=nxt.start, e0=cur.start+cur.foStart+cur.cfOut;
      setEqSwapTimes(cur, nxt, (s0+e0)/2, s0, e0, Math.max(1.2, cfNom/6));
    }
}

function curve(n, fn){ const a=new Float32Array(n); for(let i=0;i<n;i++) a[i]=fn(i/(n-1)); return a; }

function applyEnv(p, it, g0){
  // 全局时间轴上的包络区间(淡出窗口在 foStart 处,可早于音频末尾;之后保持静音)
  const aIn=it.start, bIn=it.start+it.cfIn, aOut=it.start+it.foStart, bOut=aOut+it.cfOut;
  if(it.cfOut>0 && g0>=bOut){ p.setValueAtTime(0, t0); return; } // 已过淡出终点:整段静音
  const toCtx = gt => t0 + (gt - g0);
  if(it.cfIn>0 && g0 < bIn){
    if(g0 <= aIn){ p.setValueAtTime(0, t0); p.setValueCurveAtTime(FADE_IN, toCtx(aIn), it.cfIn); }
    else { // 从淡入中途切入:先设当前值再线性补完
      p.setValueAtTime(Math.sin((g0-aIn)/it.cfIn*Math.PI/2), t0);
      p.linearRampToValueAtTime(1, toCtx(bIn));
    }
  } else p.setValueAtTime(1, t0);
  if(it.cfOut>0){
    if(g0 <= aOut) p.setValueCurveAtTime(FADE_OUT, toCtx(aOut), it.cfOut);
    else if(g0 < bOut){
      p.setValueAtTime(Math.cos((g0-aOut)/it.cfOut*Math.PI/2), t0);
      p.linearRampToValueAtTime(0, toCtx(bOut));
    }
  }
}

function encodeWAV(buf){
  const nCh=2, sr=buf.sampleRate, n=buf.length;
  const bytes = 44 + n*nCh*2;
  const ab=new ArrayBuffer(bytes), v=new DataView(ab);
  const wstr=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  wstr(0,"RIFF"); v.setUint32(4, bytes-8, true); wstr(8,"WAVE");
  wstr(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,nCh,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*nCh*2,true); v.setUint16(32,nCh*2,true); v.setUint16(34,16,true);
  wstr(36,"data"); v.setUint32(40, n*nCh*2, true);
  const L=buf.getChannelData(0), R=buf.numberOfChannels>1? buf.getChannelData(1):L;
  let o=44;
  for(let i=0;i<n;i++){
    let s=Math.max(-1,Math.min(1,L[i])); v.setInt16(o, s<0? s*0x8000 : s*0x7FFF, true); o+=2;
    s=Math.max(-1,Math.min(1,R[i]));     v.setInt16(o, s<0? s*0x8000 : s*0x7FFF, true); o+=2;
  }
  return new Blob([ab], {type:"audio/wav"});
}
function chooseOverlapBars(a, b){
  const want=parseInt($("ovlSel").value)||8;
  /* 层 2:人声冲突规避。取双方实际会重叠的区域来判断,而不是整曲。 */
  const outro=[...(a.sections||[])].reverse().find(x=>x.label==="OUTRO");
  const intro=(b.sections||[]).find(x=>x.label==="INTRO");
  const aFrom=outro? outro.s : Math.max(a.dur*0.5, a.dur-60), aTo=a.dur;
  const bFrom=0, bTo=intro? intro.e : Math.min(b.dur*0.4, 60);
  const va=vocalInRange(a, aFrom, aTo), vb=vocalInRange(b, bFrom, bTo);
  let bars=want, midCutDb=EQ3.midCut, why="";
  if(va!=null && vb!=null){
    if(va>0.35 && vb>0.35){                       // 两侧都有人声:缩短并加深中频切除
      bars=Math.min(want, (va>0.7&&vb>0.7)? 2 : 4);
      midCutDb=EQ3.midCutVocal;
      why=`两首在过渡区都有人声,已缩短到 ${bars} 小节并加强中频切除`;
    }else if(va>0.35 || vb>0.35){                 // 只有一侧:正常长混,加强那一侧保护
      midCutDb=EQ3.midCutVocal;
      why=`${va>0.35?"出歌":"入歌"}过渡区有人声,已加强中频保护`;
    }else{
      why="双方过渡区都是器乐段,可放心长混";
    }
  }
  return {bars, midCutDb, why, va, vb};
}

function transientsIn(buf, from, to){
  const sr=buf.sampleRate, ch=buf.getChannelData(0), hop=128;
  const i0=Math.max(0,Math.floor(from*sr)), i1=Math.min(buf.length,Math.floor(to*sr));
  const n=Math.floor((i1-i0)/hop); if(n<4) return [];
  const env=new Float32Array(n); let prev=0;
  for(let k=0;k<n;k++){
    const s=i0+k*hop; let e=0;
    for(let j=0;j<hop;j+=2){ const v=ch[s+j]; e+=v*v; }
    e=Math.sqrt(e); env[k]=Math.max(0,e-prev); prev=e;
  }
  let mx=0; for(let i=0;i<n;i++) if(env[i]>mx) mx=env[i];
  if(mx<=0) return [];
  const out=[], minGap=Math.round(0.08*sr/hop); let last=-1e9;
  for(let k=1;k<n-1;k++){
    if(env[k]<mx*0.28) continue;
    if(env[k]<env[k-1]||env[k]<env[k+1]) continue;
    if(k-last<minGap) continue;
    last=k; out.push({t:from+k*hop/sr, v:env[k]/mx});
  }
  return out;
}

async function getProcessedV15(t, Tin, Tout, cf){
  const key="v15|"+Tin+"|"+Tout+"|"+cf;
  t._proc=t._proc||{};
  if(t._proc[key]) return t._proc[key];
  const sr=t.buffer.sampleRate, nCh=t.buffer.numberOfChannels;
  const bpmX=t.bpmExact||t.bpm, beat=60/bpmX, barN=4*beat;
  const rampBeats=Math.max(4, Math.min(64, Math.floor(t.dur*0.2*bpmX/60)));
  const rampIn=rampBeats*beat;
  const headSegs=[]; let headEndIn=0, headPlateauIn=0, r2=1;
  if(Tin!=null){
    const bpmH=gridLocalBPM(t,0,Math.min(t.dur*0.6,100))||localExactBPM(t,0,Math.min(t.dur*0.5,60))||bpmX;
    r2=Tin/bpmH;
    const plateauOut=cf+4*60/Tin;                       // 平台 = crossfade + 1 小节余量
    headPlateauIn=Math.min(plateauOut*r2, t.dur*0.25);
    headEndIn=Math.min(headPlateauIn+rampIn, t.dur*0.45);
    headSegs.push(await stretchRamp(t.buffer, 0, headPlateauIn, r2, r2));
    headSegs.push(await stretchRamp(t.buffer, headPlateauIn, headEndIn, r2, 1));
  }
  const tailSegs=[]; let tailStartIn=t.dur, tailPlateauIn=0, r1=1;
  if(Tout!=null){
    const bpmT=gridLocalBPM(t,Math.max(0,t.dur-100),t.dur)||localExactBPM(t,Math.max(0,t.dur-60),t.dur)||bpmX;
    r1=Tout/bpmT;
    const plateauOut=cf+4*60/Tout;
    tailPlateauIn=Math.min(plateauOut*r1, t.dur*0.25);
    tailStartIn=Math.max(t.dur*0.55, t.dur-tailPlateauIn-rampIn, headEndIn);
    tailSegs.push(await stretchRamp(t.buffer, tailStartIn, t.dur-tailPlateauIn, 1, r1));
    tailSegs.push(await stretchRamp(t.buffer, t.dur-tailPlateauIn, t.dur, r1, r1));
  }
  const midS=Math.floor(headEndIn*sr), midE=Math.max(midS, Math.floor(tailStartIn*sr));
  let starts=null, totalLen=0; const chans=[];
  for(let c=0;c<nCh;c++){
    const parts=[];
    headSegs.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    parts.push(t.buffer.getChannelData(c).subarray(midS,midE));
    tailSegs.forEach(s=>parts.push(s.ch[Math.min(c,s.ch.length-1)]));
    const r=spliceConcat(parts);
    chans.push(r.arr); starts=r.starts; totalLen=r.arr.length;
  }
  ensureCtx();
  const out=ctx.createBuffer(nCh, totalLen, sr);
  for(let c=0;c<nCh;c++) out.getChannelData(c).set(chans[c]);
  const totalOut=totalLen/sr;
  /* v15 锚点:头部平台内第一条小节线 / 尾部平台内最后一条小节线 */
  let inAnchor=null, inLen=null, outAnchor=null, outLen=null;
  const barDurN=4*60/bpmX;
  const bo=(t.barOffset!=null? t.barOffset : 0);
  if(Tin!=null && bo<headPlateauIn-0.05){
    inAnchor=starts[0]/sr + bo/r2;
    inLen=Math.max(0,(headPlateauIn-bo)/r2);
  }
  if(Tout!=null){
    const tb=bo+Math.floor((t.dur-0.1-bo)/barDurN)*barDurN;
    if(tb>=t.dur-tailPlateauIn+0.05){
      const pi=starts.length-1;
      outAnchor=starts[pi]/sr + (tb-(t.dur-tailPlateauIn))/r1;
      outLen=totalOut-outAnchor;
    }
  }
  const rec={buf:out, inAnchor, inLen, outAnchor, outLen,
             foStartOut:null, foCap:null, headKind:"intro", tailKind:"outro"};
  t._proc[key]=rec;
  return rec;
}

function measureAlign(bufA, tA, bufB, tB, win, beatSec){
  const sr=bufA.sampleRate, maxLag=Math.round(beatSec*0.5*sr/ENV_HOP);
  const half=win/2;
  const r=(off,len)=>{
    const ea=onsetEnvOf(bufA, tA+off, tA+off+len);
    const eb=onsetEnvOf(bufB, tB+off, tB+off+len);
    return bestLagFrames(ea,eb,maxLag);
  };
  const r1=r(0,half), r2=r(half,half);
  const whole=r(0,win);
  if(!r1||!r2||!whole) return null;
  const f2s=ENV_HOP/sr;
  return {
    offset: whole.lag*f2s,                    // 静态错位(秒),正=入歌偏晚
    slope: (r2.lag-r1.lag)*f2s/half,          // 漂移速率(秒/秒),正=入歌偏慢
    score: Math.min(r1.score,r2.score,whole.score)
  };
}

function measureRenderedBeat(buf, from, to, targetBpm){
  const P0=60/targetBpm;
  const ons=transientsIn(buf, Math.max(0,from), Math.min(buf.length/buf.sampleRate, to));
  if(ons.length<8) return null;
  const t=ons.map(o=>o.t), w=ons.map(o=>o.v), T0=t[0];
  /* 1) 梳状搜索:周期 ±10% 全扫 + 相位全扫,取加权命中最高
        (不以目标周期为初值——实际速率偏离目标较多时,直接拟合会错配拍索引) */
  let bP=P0,bPh=0,bSc=-1;
  const tol=0.035;
  for(let P=P0*0.90; P<=P0*1.10; P+=P0*0.0008){
    for(let ph=0; ph<P; ph+=P/24){
      let sc=0;
      for(let i=0;i<t.length;i++){
        const x=(t[i]-T0-ph)/P, d=Math.abs(x-Math.round(x));
        if(d<tol) sc+=w[i];
      }
      if(sc>bSc){ bSc=sc; bP=P; bPh=ph; }
    }
  }
  /* 2) 最小二乘精修(剔除 off-beat 装饰音) */
  let P=bP, t0=T0+bPh, frac=0, cnt=0;
  for(let it=0; it<6; it++){
    const keep=[];
    for(let i=0;i<t.length;i++){
      const k=Math.round((t[i]-t0)/P);
      if(Math.abs(t[i]-(t0+k*P))<P*0.12) keep.push([k,t[i]]);
    }
    if(keep.length<5) return null;
    let n=keep.length,sx=0,sy=0,sxy=0,sxx=0;
    for(const [x,y] of keep){sx+=x;sy+=y;sxy+=x*y;sxx+=x*x;}
    const den=n*sxx-sx*sx; if(Math.abs(den)<1e-12) return null;
    const sl=(n*sxy-sx*sy)/den, ic=(sy-sl*sx)/n;
    if(!isFinite(sl)||sl<=0) return null;
    P=sl; t0=ic; frac=keep.length/t.length; cnt=keep.length;
  }
  if(Math.abs(P/P0-1)>0.12 || frac<0.3 || cnt<6) return null;
  return {period:P, bpm:60/P, n:cnt, frac};
}

function bestLagFrames(a,b,maxLag){
  const n=Math.min(a.length,b.length);
  if(n<20) return null;
  let best=-Infinity, bl=0;
  for(let L=-maxLag;L<=maxLag;L++){
    let s=0,na=0,nb=0;
    const i0=Math.max(0,-L), i1=Math.min(n, n-L);
    for(let i=i0;i<i1;i++){ const x=a[i], y=b[i+L]; s+=x*y; na+=x*x; nb+=y*y; }
    const d=Math.sqrt(na*nb);
    if(d<=0) continue;
    const v=s/d;
    if(v>best){ best=v; bl=L; }
  }
  return {lag:bl, score:best};
}

function onsetEnvOf(buffer, from, to){
  const sr=buffer.sampleRate, ch=buffer.getChannelData(0);
  const i0=Math.max(0,Math.floor(from*sr)), i1=Math.min(buffer.length, Math.floor(to*sr));
  const n=Math.max(0, Math.floor((i1-i0)/ENV_HOP));
  const a=new Float32Array(n);
  let prev=0;
  for(let k=0;k<n;k++){
    const s=i0+k*ENV_HOP; let e=0;
    for(let j=0;j<ENV_HOP;j+=2){ const v=ch[s+j]; e+=v*v; }
    e=Math.sqrt(e);
    a[k]=Math.max(0,e-prev); prev=e;
  }
  let m=0; for(let i=0;i<n;i++) m+=a[i]; m/=(n||1);
  for(let i=0;i<n;i++) a[i]-=m;
  return a;
}


/* ════════════════════════════════════════════════════════════════════════
   应用层 —— 设计稿(DCLogic)只会调用下面这些,不直接碰引擎
   ════════════════════════════════════════════════════════════════════════ */
const AUDIO_RE=/\.(mp3|wav|m4a|ogg|flac|aac)$/i;
let skipped=[];            // 解码失败/静音的文件,分析页会如实列出
let building=false;

function ensureCtxUser(){ ensureCtx(); if(ctx.state==="suspended") ctx.resume(); return ctx; }

/* ── 能量 ──
   energy = 0.35×感知响度 + 0.30×2–5kHz 占比 + 0.20×DROP/BUILD 占比 + 0.15×动态范围倒数
   四项在当前歌单内 min-max 归一。明确不含 BPM。 */
function rawEnergyFeatures(t){
  const buf=t.buffer, sr=buf.sampleRate, ch=buf.getChannelData(0);
  const FR=2048, HOP=Math.max(FR, Math.round(sr/4));
  const win=new Float32Array(FR); for(let i=0;i<FR;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/FR);
  const re=new Float32Array(FR), im=new Float32Array(FR);
  let harsh=0, tot=0; const rms=[];
  for(let p=0; p+FR<ch.length; p+=HOP){
    let e=0;
    for(let i=0;i<FR;i++){ const v=ch[p+i]; e+=v*v; re[i]=v*win[i]; im[i]=0; }
    rms.push(Math.sqrt(e/FR));
    fft(re,im);
    for(let b=1;b<FR/2;b++){
      const f=b*sr/FR, pw=re[b]*re[b]+im[b]*im[b];
      if(f>30 && f<16000){ tot+=pw; if(f>=2000 && f<=5000) harsh+=pw; }
    }
  }
  if(!rms.length) return {loud:-60, harsh:0, sec:0, dr:20, silent:true};
  const sorted=[...rms].sort((a,b)=>b-a);
  const top=sorted.slice(0, Math.max(1, sorted.length>>1));
  const loud=20*Math.log10(Math.max(top.reduce((a,b)=>a+b,0)/top.length, 1e-6));
  const asc=[...rms].sort((a,b)=>a-b);
  const q=p=>20*Math.log10(Math.max(asc[clamp(Math.floor(p*asc.length),0,asc.length-1)],1e-6));
  const dr=Math.max(1, q(0.95)-q(0.25));
  let sec=0;
  if(t.sections) for(const s of t.sections) if(s.label==="DROP"||s.label==="BUILD") sec+=s.e-s.s;
  return {loud, harsh:harsh/Math.max(tot,1e-12), sec:sec/Math.max(t.dur,1e-6), dr, silent:loud<-55};
}
function computeAllEnergy(){
  if(!tracks.length) return;
  const F=tracks.map(t=>{ const f=rawEnergyFeatures(t); t._ef=f; return f; });
  const norm=v=>{ const lo=Math.min(...v), hi=Math.max(...v);
    return hi-lo<1e-9? v.map(()=>0.5) : v.map(x=>(x-lo)/(hi-lo)); };
  const L=norm(F.map(f=>f.loud)), H=norm(F.map(f=>f.harsh)),
        S=norm(F.map(f=>f.sec)), D=norm(F.map(f=>f.dr));
  tracks.forEach((t,i)=>{
    t.energy=clamp(0.35*L[i]+0.30*H[i]+0.20*S[i]+0.15*(1-D[i]), 0.06, 1);
  });
  console.table(tracks.map(t=>({name:t.name, bpm:t.bpm, key:t.key,
    energy:+(t.energy*100).toFixed(0), loud:+t._ef.loud.toFixed(1),
    harsh:+(t._ef.harsh*100).toFixed(1)+"%", drop:+(t._ef.sec*100).toFixed(0)+"%",
    dyn:+t._ef.dr.toFixed(1)+"dB"})));
}

/* ── 编排:2-opt + Or-opt(段长 1–3)──
   cost = w1·|能量−曲线目标| + w2·BPM代价 + w3·调性代价
   BPM 差 >20 给 1000 罚分,等价硬约束。Or-opt 段长必须 >1,否则一个 BPM 簇里的
   曲子单独离队会立刻多出一个断点,搜索卡死在局部最优(实测)。 */
const W={curve:1.0, bpm:0.55, key:0.18}, BIG=1000;
function bpmCost(a,b){
  if(!a.bpm||!b.bpm) return 0.5;
  const d=Math.abs(a.bpm-b.bpm);
  if(d>MAX_PAIR_DIFF) return BIG;
  if(!isBeatSteady(a)||!isBeatSteady(b)) return 0.6;
  return d/MAX_PAIR_DIFF;
}
const keyCost=(a,b)=>(a.key&&b.key&&camelotCompatible(a.key,b.key))?0:1;
const sampleCurve=(es,f)=>{ const n=es.length-1, x=clamp(f,0,1)*n, i=Math.min(Math.floor(x),n-1), t=x-i;
  return es[i]*(1-t)+es[i+1]*t; };
function orderByCurve(list, es){
  const n=list.length;
  if(n<3) return list.slice();
  const target=i=>sampleCurve(es, n<2?0.5:(i+0.5)/n);
  const cost=o=>{ let c=0;
    for(let i=0;i<n;i++) c+=W.curve*Math.abs(o[i].energy-target(i));
    for(let i=0;i<n-1;i++) c+=W.bpm*bpmCost(o[i],o[i+1])+W.key*keyCost(o[i],o[i+1]);
    return c; };
  const tgt=Array.from({length:n},(_,i)=>({i,v:target(i)}));
  const pool=list.slice().sort((a,b)=>a.energy-b.energy);
  const byTgt=tgt.slice().sort((a,b)=>a.v-b.v);
  const seed=new Array(n); byTgt.forEach((t,k)=>seed[t.i]=pool[k]);
  const improve=start=>{
    let best=start.slice(), bc=cost(best);
    for(let pass=0;pass<40;pass++){
      let imp=false;
      for(let i=0;i<n-1;i++) for(let j=i+1;j<n;j++){
        const c2=best.slice(0,i).concat(best.slice(i,j+1).reverse(), best.slice(j+1));
        const c=cost(c2); if(c<bc-1e-9){ best=c2; bc=c; imp=true; }
      }
      for(let L=1;L<=Math.min(3,n-1);L++)
        for(let i=0;i+L<=n;i++) for(let j=0;j<=n-L;j++){
          if(j>=i && j<=i+L-1) continue;
          const c2=best.slice(), seg=c2.splice(i,L);
          c2.splice(j>i? j-L : j, 0, ...seg);
          const c=cost(c2); if(c<bc-1e-9){ best=c2; bc=c; imp=true; }
        }
      if(!imp) break;
    }
    return {best,bc};
  };
  let r=improve(seed); const r2=improve(seed.slice().reverse());
  if(r2.bc<r.bc) r=r2;
  return r.best;
}

/* ── 播放(信号链与本地版一致:响度 → 分频均衡 → EQ 交换 → 包络 → 限幅)── */
let playing=false, t0=0, sources=[], master=null, raf=0, seekOff=0, onTick=null, onEnd=null;
function startSet(seekTo){
  if(!schedule) return;
  stopSet(); ensureCtxUser();
  master=ctx.createGain();
  const lim=makeLimiter(ctx);
  master.connect(lim.input); lim.output.connect(ctx.destination);
  t0=ctx.currentTime+0.15;
  seekOff=clamp(seekTo||0, 0, Math.max(schedule.total-0.1,0));
  schedule.items.forEach((it,i)=>{
    if(it.start+it.dur<=seekOff+0.01 && i<schedule.items.length-1) return;
    const src=ctx.createBufferSource(); src.buffer=it.buf;
    const trim=ctx.createGain(); trim.gain.value=gainOf(it.track);
    const eq=makeBandEQ(ctx, bandCorrection(it.track));
    const sw=makeSwapEQ(ctx);
    applySwapEnv(sw, it, seekOff, t0, schedule.pairT? (schedule.pairT[i]||schedule.pairT[i-1]) : null);
    const g=ctx.createGain();
    src.connect(trim); trim.connect(eq.input); eq.output.connect(sw.input); sw.output.connect(g); g.connect(master);
    applyEnv(g.gain, it, seekOff);
    const rel=it.start-seekOff;
    src.start(t0+Math.max(rel,0), Math.max(-rel,0));
    if(i===schedule.items.length-1) src.onended=()=>{ if(playing){ stopSet(); if(onEnd) onEnd(); } };
    sources.push(src);
  });
  playing=true;
  const tick=()=>{ if(!playing) return;
    if(onTick) onTick(clamp(ctx.currentTime-t0+seekOff, 0, schedule.total));
    raf=requestAnimationFrame(tick); };
  raf=requestAnimationFrame(tick);
}
function stopSet(){
  sources.forEach(s=>{ s.onended=null; try{s.stop()}catch(e){} });
  sources=[]; playing=false; cancelAnimationFrame(raf);
  if(master){ try{master.disconnect()}catch(e){} master=null; }
  if(ctx && ctx.state==="suspended") ctx.resume();
}

/* ── 导出 ── */
function dl(blob, name){
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name;
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
function tracklistText(sch){
  const L=["MIXFLOW — tracklist","",`Total ${fmtT(sch.total)} · ${sch.items.length} tracks`,""];
  sch.items.forEach((it,i)=>{
    L.push(`${String(i+1).padStart(2,"0")}  ${fmtT(it.start)}  ${it.track.name}`);
    L.push(`      ${it.track.bpm?Math.round(it.track.bpm)+" BPM":"tempo unclear"}${it.track.key?" · "+it.track.key:""} · energy ${Math.round((it.track.energy||0)*100)}`);
    if(i<sch.items.length-1){
      const T=sch.pairT?sch.pairT[i]:null, bars=(sch.ovlInfo&&sch.ovlInfo[i]?sch.ovlInfo[i].bars:0);
      L.push(`      ↳ ${T==null? "fade (tempos too far apart)" : `blend ${bars} bars @ ${Math.round(T)} BPM`}`);
    }
  });
  return L.join("\n");
}
const fmtT=s=>{ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); };

/* ════════════ 暴露给设计稿的 API ════════════ */
const MF={
  /* —— 曲库 —— */
  tracks:()=>tracks,
  count:()=>tracks.length,
  skipped:()=>skipped,
  clear(){ stopSet(); tracks=[]; skipped=[]; schedule=null; },
  remove(name){ const i=tracks.findIndex(t=>t.name===name); if(i>=0){ tracks.splice(i,1); schedule=null; } },
  hasSchedule:()=>!!schedule,

  /* 给 UI 用的行数据:d = 这首歌在 set 里实际占的时长(算过 crossfade),没排程时用原始时长 */
  pool(){
    const it=schedule&&schedule.items;
    return tracks.map((t,i)=>{
      let d=t.dur;
      if(it && it[i]) d = i<it.length-1 ? (it[i+1].start-it[i].start) : (schedule.total-it[i].start);
      return {name:t.name, e:t.energy!=null?t.energy:0.5, d, bpm:t.bpm, key:t.key, ref:t};
    });
  },
  total(){ return schedule? schedule.total : tracks.reduce((a,t)=>a+t.dur,0); },

  /* —— 导入 —— */
  async addFiles(files, onProgress){
    const ok=[...files].filter(f=>f.type.startsWith("audio")||AUDIO_RE.test(f.name));
    for(const f of [...files]) if(!ok.includes(f))
      skipped.push({name:f.name, why:"Can't read this one — bring it as MP3, WAV, M4A or OGG"});
    ensureCtxUser();
    for(let i=0;i<ok.length;i++){
      const f=ok[i];
      if(onProgress) onProgress(i, ok.length, f.name);
      await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
      try{
        const buf=await ctx.decodeAudioData(await f.arrayBuffer());
        if(buf.duration<20){ skipped.push({name:f.name, why:"Too short to arrange — needs at least 20 seconds"}); continue; }
        tracks.push({ id:++uid, name:f.name.replace(/\.[^.]+$/,""), buffer:buf, dur:buf.duration,
          peaks:computePeaks(buf,240), gain:computeLoudnessGain(buf), bands:computeBands(buf),
          analyzing:true, key:null, bpm:null });
      }catch(err){
        skipped.push({name:f.name, why:"Can't read this one — the file looks damaged"});
      }
    }
    schedule=null;
    return tracks.length;
  },
  /* 样例包:托管在 http(s) 上时直接 fetch samples/,本地 file:// 时用内嵌的 base64 */
  async loadSample(onProgress){
    ensureCtxUser();
    tracks=[]; skipped=[]; schedule=null;
    let items=null;
    if(/^https?:$/.test(location.protocol)){
      try{
        const man=await (await fetch("samples/manifest.json")).json();
        items=man.tracks.map(t=>({name:t.name, get:()=>fetch("samples/"+t.file).then(r=>r.arrayBuffer())}));
      }catch(e){ console.warn("samples/ 取不到:", e.message); }
    }
    if(!items && window.MIXFLOW_SAMPLES){
      const b64=b=>{ const s=atob(b), u=new Uint8Array(s.length);
        for(let i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u.buffer; };
      items=window.MIXFLOW_SAMPLES.map(t=>({name:t.n, get:async()=>b64(t.b)}));
    }
    if(!items) throw new Error("样例音频包不可用");
    for(let i=0;i<items.length;i++){
      if(onProgress) onProgress(i, items.length, items[i].name);
      await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
      const buf=await ctx.decodeAudioData(await items[i].get());
      tracks.push({ id:++uid, name:items[i].name, buffer:buf, dur:buf.duration,
        peaks:computePeaks(buf,240), gain:computeLoudnessGain(buf), bands:computeBands(buf),
        analyzing:true, key:null, bpm:null });
    }
    return tracks.length;
  },

  /* —— 分析 —— */
  async analyzeAll(onEach){
    startEssentia();
    for(let i=0;i<tracks.length;i++){
      const t=tracks[i];
      await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
      try{ await analyzeTrack(t); }
      catch(e){ console.warn("分析失败", t.name, e); t.analyzing=false; }
      if(onEach) onEach(i+1, tracks.length, t.name);
      await new Promise(r=>setTimeout(r,0));
    }
    /* 全程静音的曲子没法编排,如实剔除并说明 */
    computeAllEnergy();
    for(let i=tracks.length-1;i>=0;i--) if(tracks[i]._ef && tracks[i]._ef.silent){
      skipped.push({name:tracks[i].name, why:"Silent all the way through — nothing to arrange"});
      tracks.splice(i,1);
    }
    computeAllEnergy();
    return tracks.length;
  },
  blendablePairs(){
    let n=0;
    for(let i=0;i<tracks.length;i++) for(let j=i+1;j<tracks.length;j++)
      if(canBeatmatch(tracks[i].bpm,tracks[j].bpm) && isBeatSteady(tracks[i]) && isBeatSteady(tracks[j])) n++;
    return n;
  },

  /* —— 编排 + 排程 ——
     排程还没跑时给「2-opt 建议顺序」(Shape 屏预览用);跑完之后直接给排程里的真实顺序。 */
  arrange(es){
    if(schedule) return MF.pool();
    const ord=orderByCurve(tracks, es);
    return ord.map(t=>({name:t.name, e:t.energy!=null?t.energy:0.5, d:t.dur, bpm:t.bpm, key:t.key, ref:t}));
  },
  async build(es, order, onProgress){
    if(building) return;
    building=true;
    stopSet();
    tracks = order? order.map(n=>tracks.find(t=>t.name===n)).filter(Boolean) : orderByCurve(tracks, es);
    try{ await buildSchedule(onProgress); }
    catch(e){ console.error("排程失败", e); building=false; throw e; }
    building=false;
    return schedule.total;
  },
  /* 每个过渡的人话说明,数据全部来自真实排程结果 */
  notes(){
    if(!schedule) return [];
    return schedule.items.slice(0,-1).map((it,i)=>{
      const nx=schedule.items[i+1], a=it.track, b=nx.track;
      const T=schedule.pairT? schedule.pairT[i] : null;
      const info=(schedule.ovlInfo&&schedule.ovlInfo[i])||{};
      if(T==null){
        const why=(a.bpm&&b.bpm&&Math.abs(a.bpm-b.bpm)>MAX_PAIR_DIFF)
          ? `${Math.round(a.bpm)} and ${Math.round(b.bpm)} BPM are too far apart to lock together`
          : "one of these two doesn't hold a steady pulse";
        return {warn:true, text:`No beat-match here — ${why}. MIXFLOW fades one into the other instead.`};
      }
      /* 说明必须报【实际】overlap,不是【请求】的小节数。
         schedulePair 会把 overlap 压到两侧素材允许的范围内:出歌的 outro 只有 5.8s 时,
         请求 8 小节(15s)实际只混得到 3.8s。以前这里读 info.bars(请求值),
         于是界面上写着「8 bars / 15 seconds」而耳朵听到的是 4 秒 —— 是在骗人。 */
      const barT=4*60/T;
      /* 两轨同时在响的那段才算 overlap:出歌的淡出长度与入歌的淡入长度取小 */
      const ovlSec=Math.min(it.cfOut||0, nx.cfIn||0);
      const secs=ovlSec>0? ovlSec : (info.bars||0)*barT;
      const bars=Math.max(1, Math.round(secs/barT));
      const want=info.bars||0;
      const squeezed = want>0 && secs < want*barT*0.85;
      const keyOK=a.key&&b.key&&camelotCompatible(a.key,b.key);
      return {warn:false,
        text:`Blends for ${bars} ${bars===1?'bar':'bars'} — about ${Math.round(secs)} seconds, both nudged to ${Math.round(T)} BPM.`,
        detail:`${Math.round(a.bpm)} → ${Math.round(T)}, ${Math.round(b.bpm)} → ${Math.round(T)}. `+
               (keyOK? `Keys ${a.key} and ${b.key} sit together, so they can overlap at full volume.`
                     : `Keys ${a.key||"?"} and ${b.key||"?"} clash a little, so the bass hands over early.`)
               + (squeezed? ` Shorter than the ${want} bars asked for — “${a.name}” doesn't leave enough clean outro.` : ``)};
    });
  },

  /* —— 播放 —— */
  play(seek, onT, onE){ onTick=onT; onEnd=onE; startSet(seek||0); },
  stop(){ stopSet(); },
  seek(sec){ startSet(sec); },
  playing:()=>playing,

  /* —— 导出 —— */
  async exportSet(kind, onProgress){
    if(!schedule) return;
    if(kind==="txt"){ dl(new Blob([tracklistText(schedule)],{type:"text/plain"}),"mixflow-tracklist.txt"); return; }
    const was=playing; stopSet();
    if(onProgress) onProgress("Preparing");
    await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
    const full=await buildSchedule((i,n)=>{ if(onProgress) onProgress(`Rendering ${i+1} of ${n}`); }, true);
    const sr=44100, oc=new OfflineAudioContext(2, Math.ceil(full.total*sr), sr);
    const lim=makeLimiter(oc); lim.output.connect(oc.destination);
    full.items.forEach((it,i)=>{
      const src=oc.createBufferSource(); src.buffer=it.buf;
      const trim=oc.createGain(); trim.gain.value=gainOf(it.track);
      const eq=makeBandEQ(oc, bandCorrection(it.track));
      const sw=makeSwapEQ(oc);
      applySwapEnv(sw, it, 0, 0, full.pairT? (full.pairT[i]||full.pairT[i-1]) : null);
      const g=oc.createGain();
      src.connect(trim); trim.connect(eq.input); eq.output.connect(sw.input); sw.output.connect(g); g.connect(lim.input);
      if(it.cfIn>0){ g.gain.setValueAtTime(0,0); g.gain.setValueCurveAtTime(FADE_IN, it.start, it.cfIn); }
      else g.gain.setValueAtTime(1,0);
      if(it.cfOut>0) g.gain.setValueCurveAtTime(FADE_OUT, it.start+it.foStart, it.cfOut);
      src.start(it.start);
    });
    if(onProgress) onProgress("Mixing down");
    const rendered=await oc.startRendering();
    for(const tr of tracks){ if(tr._proc) for(const k of Object.keys(tr._proc))
      if(!schedule.items.find(x=>x.buf===tr._proc[k].buf)) delete tr._proc[k]; }
    dl(new Blob([encodeWAV(rendered)],{type:"audio/wav"}),"mixflow-set.wav");
    dl(new Blob([tracklistText(full)],{type:"text/plain"}),"mixflow-tracklist.txt");
    if(was) startSet();
  },
  exportSize(kind){ if(!schedule) return ""; 
    return kind==="txt"? "1 KB" : Math.round(schedule.total*44100*4/1048576)+" MB"; },

  /* —— 设备能力 —— */
  isMobile(){
    const touch = matchMedia("(pointer:coarse)").matches;
    const small = Math.min(innerWidth, innerHeight) < 700;
    const mem = navigator.deviceMemory;
    return (touch && small) || (mem!=null && mem<=4);
  },
  fmt:fmtT
};
window.MF=MF;
})();
