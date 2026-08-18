# MIXFLOW — demo 站

把歌单变成一个自动 beat-matched、无缝过渡的 DJ set。**纯前端,没有后端,音频不上传。**

```bash
./serve.sh          # → http://localhost:8080
```

> 别直接双击 `index.html`。`file://` 下 Chrome 会挡掉 fetch,样例歌单加载不了。必须走 http。

## 这个仓库是什么

```
mixflow-demo/
├─ index.html          UI(Claude Design 导出的原型)+ 接引擎的胶水代码
├─ assets/
│  ├─ engine.js        分析 / 变速 / 逐拍同步 / 排程 / 导出(100KB)
│  ├─ dc-runtime.js    原型用的渲染运行时
│  ├─ react.js  react-dom.js
│  ├─ essentia-*.js  *.wasm   节拍与调性检测(2MB wasm,分析时才加载)
│  └─ fonts/           Archivo + Chivo,6 个 woff2
├─ samples/            8 段 48 小节的样例音频 + manifest.json
├─ vercel.json  netlify.toml  _headers   三家平台的缓存头
└─ serve.sh            本地预览
```

**全站零外部请求。** 字体、React、Essentia、样例音频全部自托管,页面加载后不会向任何第三方域名发一个请求 —— 这是为了国内能直接打开(见 `DEPLOY.md`)。

## 跑起来是什么流程

四屏:**Import → Analyse → Shape → DJ Set**。

1. 拖音频进来,或点「Try a sample playlist」用内置的 8 首
2. 逐首分析:节拍网格、调性(Camelot)、段落结构、人声、能量
3. 拖 5 个控制点画出今晚的能量曲线,或选一个预设
4. 系统排好顺序、算好每个过渡,可以直接播,也可以导出 WAV + 曲目单

## 两层结构

- **`assets/engine.js`** —— 音频引擎。中间那 63 个函数**与本地版 1.7 逐字节一致**,节拍对齐内核已锁定(跑马问题花了八轮才解决,详见 `HANDOFF-auto-dj-set.md`)。**不要改。**
- **`index.html`** —— 设计稿原样 + 一层胶水。UI 的视觉与排版在 Claude Design 里定稿,这里只负责把 `window.MF` 的数据喂给它。

`window.MF` 是两层之间唯一的接口:

| 方法 | 作用 |
|---|---|
| `addFiles(files, onProgress)` / `loadSample(onProgress)` | 导入并解码 |
| `analyzeAll(onEach)` | 逐首分析,每首完成回调一次 |
| `pool()` / `skipped()` / `count()` | 给 UI 的行数据 |
| `arrange(es)` | 按能量曲线 `es`(5 个点)排序 |
| `build(es, order, onProgress)` | 真实排程:变速、对齐、EQ 交换、包络 |
| `notes()` | 每个过渡的人话说明,数据来自真实排程 |
| `play(seek, onTick, onEnd)` / `stop()` / `seek()` | 播放 |
| `exportSet(kind, onProgress)` | WAV 或曲目单 |
| `isMobile()` | 手机上只给样例歌单 |

## 几个刻意的决定

**能量不含 BPM。** `energy = 0.35×感知响度 + 0.30×2–5kHz 占比 + 0.20×DROP/BUILD 占比 + 0.15×动态范围倒数`,四项在当前歌单内归一。加了 BPM 会把慢速重曲判成低能量、快速空灵曲判成高能量,与听感相反。

**排序用 2-opt + Or-opt(段长 1–3)。** 代价 = 曲线偏差 + BPM 罚分 + 调性罚分。BPM 差 >20 给 1000 分,等价硬约束。**Or-opt 的段长必须 >1** —— 单曲搬家时,一个 BPM 簇里的曲子离队会立刻多出一个断点,搜索卡死在局部最优。n=40 耗时 85ms。

**导出只有 WAV 和曲目单,没有 MP3。** 各家浏览器的 WebCodecs 都不提供 MP3 encoder,WASM 方案要多一个依赖,而导出本身已经吃内存。

**手机只跑样例。** 一首 6 分钟的歌解码 + 分析要几百 MB,手机会直接崩。`MF.isMobile()`(触屏 + 窄屏,或 `deviceMemory ≤ 4`)命中时上传入口改成加载样例。

## 换掉样例音频

`samples/` 里是从一份私人歌单裁的片段,**版权不在我们手里**。公开发布前请换成自有或已授权的素材:

1. 把新音频裁成 **48 小节**、编码成 AAC-LC 80kbps 的 `.m4a`,放进 `samples/`
2. 按现有格式更新 `samples/manifest.json`(`file` / `name` / `bpm` / `key` / `dur` / `bars`)

裁片段时建议先找一个「头尾各 12 秒相对安静、中段有起伏」的窗口,起点贴到最近一拍。随手切的话 `analyzeStructure` 找不到干净的 INTRO/OUTRO,每个过渡会被压到 2–3 小节,demo 反而更难听。

## 部署

见 `DEPLOY.md`。三家平台的配置文件都在仓库里,连 push 就能上。国内可达性那部分要单独看,`*.vercel.app` 已经被墙了。
