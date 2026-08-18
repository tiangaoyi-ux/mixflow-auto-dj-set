# 部署

站点是**纯静态**的:11MB,零外部请求,全部相对路径 —— 所以它能放在任何能托管静态文件的地方,包括你个人网站的一个子目录。

```bash
cd mixflow-demo
git init && git add -A && git commit -m "MIXFLOW demo"
git remote add origin git@github.com:<你>/mixflow-demo.git
git push -u origin main
```

---

## 你的情况:要国内能直接打开

先说结论:**如果你的个人网站现在国内能正常打开,最省事的做法是把这个文件夹直接丢进去当子目录**,比如 `你的域名/mixflow/`。站点用的全是相对路径,放子目录不用改一行代码,而且它直接继承你现有域名的可达性 —— 不用再配一套托管。

如果非要独立部署,下面是实际情况(2026 年 8 月核实):

| 方案 | 国内能不能打开 | 要不要备案 | 说明 |
|---|---|---|---|
| `*.vercel.app` | **不行,域名已被墙** | 否 | 官方给了独立 IP 与 CNAME,但要自己配 DNS 绕 |
| `*.netlify.app` / `*.pages.dev` | 不稳,时快时断 | 否 | 没有国内节点,链路绕境外 |
| 自有域名 + Vercel/Netlify 源站 + CDN | 看 CDN | **要,才有国内节点** | 腾讯云 EdgeOne 免费版:**未备案只能用海外节点**,备案后才切国内节点 |
| 国内对象存储 + CDN(腾讯云 COS / 阿里云 OSS) | 快且稳 | **要** | 静态站的标准做法,这个仓库直接传上去就行 |
| 香港/新加坡主机 + 自有域名 | 通常能开,偏慢 | 否 | 不想备案又要独立域名时的折中 |

**所以:**

- 域名**已备案** → 传到腾讯云 COS 或阿里云 OSS + CDN,或者直接放进你现有站点。这是唯一又快又稳的路。
- 域名**没备案**、又不想等 → 放香港主机,或自有域名 CNAME 到 Netlify/Cloudflare。能开,但别指望快。
- **别用 `*.vercel.app` 的默认域名给国内的人看**,那个域名本身就打不开。

> 备案要几周,得有国内主体。如果这个 demo 只是给人点开看看,「塞进已备案的个人网站」几乎总是最优解。

---

## 各平台怎么连

### Vercel
Import GitHub 仓库 → Framework Preset 选 **Other** → Build Command 留空 → Output Directory 填 `.` → Deploy。`vercel.json` 已经配好缓存头。

### Netlify
Add new site → Import from Git。`netlify.toml` 里 `publish = "."`、`command = ""`,不用在界面上填。

### Cloudflare Pages
Create a project → 连仓库 → Build command 留空 → Build output directory 填 `/`。缓存头走 `_headers`。

### GitHub Pages
Settings → Pages → Source 选 `main` / `/ (root)`。仓库里有 `.nojekyll`,不然 Jekyll 会吃掉某些路径。**注意 GitHub Pages 有 1GB 仓库上限**,这个站 11MB 完全够用。

### 你自己的服务器 / 对象存储
把整个文件夹传上去就行,没有构建步骤。只有一条要确认:

```
.wasm  →  application/wasm
.m4a   →  audio/mp4
```

多数服务器默认就对。如果 Essentia 起不来,先去 Network 面板看 `essentia-wasm.web.wasm` 的 Content-Type 是不是 `application/wasm`。

---

## 首屏加载多大

| | 大小 | 什么时候下 |
|---|---|---|
| index.html + React + runtime + 字体 | ~370KB | 首屏 |
| `assets/engine.js` | 100KB | 首屏 |
| `assets/essentia-*.wasm` | 2.0MB | **点了导入/样例之后才下** |
| `samples/*.m4a` | 7.1MB | **点了「Try a sample playlist」才下** |

落地页首屏不到 500KB。2MB 的 wasm 和 7MB 的样例都是懒加载,滚落地页的人不会为它们等待。

如果想再瘦:开服务器的 gzip/brotli(JS 能压掉一大半;wasm 和 m4a 已经是压缩格式,压不动)。

---

## 上线前的检查清单

- [ ] **换掉 `samples/` 里的音频** —— 现在是从私人歌单裁的片段,版权不在你手里。换法见 `README.md`
- [ ] 用手机真机点一遍(应该只出现样例入口,不出现文件选择)
- [ ] 跑完整流程一次:样例 → 分析 → 拖曲线 → BUILD → 播放 → 导出 WAV
- [ ] 确认 `.wasm` 的 Content-Type
- [ ] 国内网络实测一次(不是"能 ping 通",是真的打开页面并点样例)
