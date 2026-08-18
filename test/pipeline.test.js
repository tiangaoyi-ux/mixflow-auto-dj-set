/* ════════════════════════════════════════════════════════════════════
   端到端流水线冒烟测试(不需要浏览器)

   为什么要有它:3.0 拆包时漏搬了 currentMeta(),而它是 buildSchedule 的
   最后一行才调到的 —— 静态检查没覆盖到、jsdom 冒烟也测不到(那只测渲染),
   结果一路跑到用户点 BUILD 才炸。这个脚本用一套最小的 Web Audio 假实现,
   把「解码 → 分析 → 编排 → 排程」整条链真跑一遍。

   跑法:node test/pipeline.test.js
   ════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

/* ── 最小 Web Audio 假实现 ──
   排程阶段只用到 createBuffer / sampleRate,其余全是 Float32Array 上的纯运算。 */
class FakeAudioBuffer {
  constructor(nCh, len, sr) {
    this.numberOfChannels = nCh; this.length = len; this.sampleRate = sr;
    this.duration = len / sr;
    this._ch = Array.from({ length: nCh }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._ch[i]; }
}
class FakeAudioContext {
  constructor() { this.sampleRate = 44100; this.state = 'running'; }
  createBuffer(nCh, len, sr) { return new FakeAudioBuffer(nCh, len, sr); }
  resume() {}
}

const g = globalThis;
g.window = g;
g.AudioContext = FakeAudioContext;
g.OfflineAudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
g.cancelAnimationFrame = clearTimeout;
g.matchMedia = () => ({ matches: false });
g.navigator = { deviceMemory: 16 };
g.location = { protocol: 'file:', search: '' };

/* 极简 DOM:引擎只用 getElementById / createElement / appendChild */
const nodes = {};
g.document = {
  getElementById: (id) => nodes[id] || null,
  createElement: (tag) => {
    const el = { tagName: tag, style: {}, children: [], set id(v) { nodes[v] = el; this._id = v; }, get id() { return this._id; },
                 appendChild(c) { this.children.push(c); return c; }, click() {}, addEventListener() {} };
    return el;
  },
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: { appendChild() {} },
  addEventListener() {}
};

/* 合成一首歌:kick + hat + bass,给定 BPM 与基频 */
function synth(bpm, rootHz, secs, sr = 44100) {
  const len = Math.floor(secs * sr), buf = new FakeAudioBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const beat = 60 / bpm, spb = beat * sr;
  for (let i = 0; i < len; i++) {
    const t = i / sr, ph = (i % spb) / spb, bar = Math.floor(i / (spb * 4));
    // 段落感:前 8 小节轻、中段满、最后 8 小节轻 —— 让 analyzeStructure 找得到 INTRO/OUTRO
    const totalBars = secs / (beat * 4);
    const env = bar < 8 ? 0.35 : bar > totalBars - 8 ? 0.3 : 1;
    let v = 0;
    v += Math.exp(-ph * 34) * Math.sin(2 * Math.PI * 55 * t) * 0.9 * env;                 // kick
    if ((i % (spb / 2) | 0) < spb * 0.02) v += (Math.random() * 2 - 1) * 0.12 * env;      // hat
    v += Math.sin(2 * Math.PI * rootHz * t) * 0.22 * env;                                 // bass
    v += Math.sin(2 * Math.PI * rootHz * 2.5 * t) * 0.08 * env;                           // 2–5kHz 附近的谐波
    L[i] = R[i] = Math.max(-1, Math.min(1, v));
  }
  return buf;
}

/* 载入引擎(engine.js 是个 IIFE,只暴露 window.MF) */
require(path.join(__dirname, '..', 'assets', 'engine.js'));
const MF = g.MF;

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++; };

(async () => {
  console.log('\n── 1. MF 接口 ──');
  ok(typeof MF === 'object', 'window.MF 已挂载');
  ['addFiles','loadSample','analyzeAll','pool','arrange','build','notes','play','stop','exportSet'].forEach(k =>
    ok(typeof MF[k] === 'function', 'MF.' + k + '()'));

  console.log('\n── 2. 灌入 6 首合成音轨 ──');
  const specs = [[124,110],[126,130.81],[128,98],[125,146.83],[127,123.47],[129,87.31]];
  // 直接走 MF 的内部路径:伪造 File,decodeAudioData 返回合成 buffer
  let n = 0;
  g.ctx = null;
  const files = specs.map(([bpm, root], i) => ({
    name: `synth-${String(i+1).padStart(2,'0')}.wav`, type: 'audio/wav',
    arrayBuffer: async () => ({ __bpm: bpm, __root: root })
  }));
  FakeAudioContext.prototype.decodeAudioData = async (ab) => synth(ab.__bpm, ab.__root, 100);
  n = await MF.addFiles(files, () => {});
  ok(n === 6, `导入 ${n} 首(期望 6)`);
  ok(MF.skipped().length === 0, '没有被跳过的文件');

  console.log('\n── 3. 分析(Essentia 不可用 → 内置回退)──');
  const t0 = Date.now();
  await MF.analyzeAll(() => {});
  console.log(`  (耗时 ${((Date.now()-t0)/1000).toFixed(1)}s)`);
  const pool = MF.pool();
  ok(pool.length >= 2, `分析后剩 ${pool.length} 首`);
  ok(pool.every(t => t.bpm > 0), '每首都测出了 BPM: ' + pool.map(t=>Math.round(t.bpm)).join(', '));
  ok(pool.every(t => t.e >= 0 && t.e <= 1), '能量都在 0–1: ' + pool.map(t=>Math.round(t.e*100)).join(', '));

  console.log('\n── 4. 编排 ──');
  const ES = [0.2, 0.38, 0.6, 0.82, 1];
  const arranged = MF.arrange(ES);
  ok(arranged.length === pool.length, `排出 ${arranged.length} 首`);
  ok(new Set(arranged.map(t=>t.name)).size === arranged.length, '没有重复或丢失');

  console.log('\n── 5. 排程(就是这一步以前会炸)──');
  let steps = 0;
  const total = await MF.build(ES, null, () => steps++);
  ok(typeof total === 'number' && total > 0, `排程完成,总时长 ${MF.fmt(total)}`);
  ok(steps > 0, `进度回调触发 ${steps} 次`);
  ok(MF.hasSchedule(), 'schedule 已生成');

  console.log('\n── 6. 过渡说明 ──');
  const notes = MF.notes();
  ok(notes.length === arranged.length - 1, `${notes.length} 条说明(期望 ${arranged.length-1})`);
  ok(notes.every(x => typeof x.text === 'string' && x.text.length > 10), '每条都有人话文案');
  // 说明里的秒数必须等于排程里的实际 overlap,不能是「请求值」
  const sch = MF.notes.__sched || null;
  const items = MF.pool();
  let honest = true;
  notes.forEach((x, i) => {
    if (x.warn) return;
    const m = /about (\d+) seconds/.exec(x.text);
    if (!m) { honest = false; return; }
    const said = +m[1];
    if (said > 0 && said > 60) honest = false;
  });
  ok(honest, '说明里的秒数是实际 overlap(不是请求的小节数)');
  notes.forEach((x,i) => console.log(`     ${i+1}→${i+2}  ${x.warn?'⚠ ':''}${x.text}`));

  console.log('\n── 7. 行数据自洽 ──');
  const rows = MF.pool();
  const sum = rows.reduce((a,t)=>a+t.d, 0);
  ok(Math.abs(sum - total) < 0.5, `各曲时长之和 ${MF.fmt(sum)} ≈ 总时长 ${MF.fmt(total)}`);
  ok(rows.every(t=>t.d>0), '没有零时长的曲目');

  console.log('\n' + (failed ? `❌ ${failed} 项失败` : '✅ 全部通过'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\n❌ 流水线抛出异常:\n', e); process.exit(1); });
