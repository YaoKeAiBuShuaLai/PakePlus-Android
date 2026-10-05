/* v54 验证：地方时间滑块 ↔ 昼夜分段轨道 / 日出·日中天·日落刻度 垂直对齐。

做法：直接改**地方太阳时**（BR.msFromLocal），让滑块由 updateHUD 自然同步，
      再对「轨道条 / 刻度圆点 / thumb 圆心」做 DOM 几何 + 像素双重量测。
覆盖：桌面 1600 / 窄窗 1180 / 移动 430 三种宽度。 */
'use strict';
const path = require('path');
const fs = require('fs');


const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, '_shots');
const URL_BASE = 'http://127.0.0.1:8795/index.html';


const PW_CHROME = process.env.PW_CHROME ||
  'C:/Users/zheng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
function ok(c, m) { console.log((c ? '  [PASS] ' : '  [FAIL] ') + m); if (!c) fails++; }
const wait = (p, n) => p.evaluate((k) => new Promise((r) => { let i = 0; (function s() { i++ >= k ? r() : requestAnimationFrame(s); })(); }), n);

/* 页面内几何：轨道条 / 关键点层 / range，以及 thumb 圆心与各圆点的理论/实测位置 */
const PROBE = () => {
  const $ = (s) => document.querySelector(s);
  const R = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
  const track = $('.svtb-slider.wide'), bar = $('.svtb-slider.wide .svtb-bar');
  const nodes = $('.svtb-slider.wide .svtb-nodes'), range = $('#svHour');
  /* --ui 是 calc(var(--uiW)*var(--uiH))，getPropertyValue 拿不到计算值 ⇒ 用「内缩量」反推：
     轨道条左端相对 track 左端的内缩 = 实际渲染的 thumb 半径（= --trk-pad 的像素值）。 */
  const TR = R(track), BR_ = R(bar);
  const pad = BR_.l - TR.l;
  const t = pad * 2;                      /* thumb 直径 */
  const v = +range.value, mn = +range.min, mx = +range.max;
  const R_ = R(range);
  const thumbCx = R_.l + t / 2 + ((v - mn) / (mx - mn)) * (R_.w - t);
  const dots = Array.from(nodes.querySelectorAll('.svtb-node')).map((n) => {
    const b = n.getBoundingClientRect();
    const l0 = n.classList.contains('l0'), r0 = n.classList.contains('r0');
    const trkH = BR_.h;                  /* 轨道条高度 == 刻度圆点直径 */
    const dotCx = l0 ? b.left - trkH / 2 : (r0 ? b.right + trkH / 2 : b.left + b.width / 2);
    const q = n.style.left ? parseFloat(n.style.left) / 100 : (l0 ? 0 : 1);
    return { txt: n.textContent, l0, r0, dotCx, q, styleLeft: n.style.left };
  });
  return { value: v, pad, t, track: TR, bar: BR_, nodes: R(nodes), range: R_, thumbCx, dots };
};

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    executablePath: PW_CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  await page.goto(URL_BASE + '?module=sun&view=ground', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SUNVIEW, null, { timeout: 30000 });
  await page.evaluate(() => {
    const S = window.SUNVIEW._S();
    S.view = 'ground'; S.indoor = false; S.fp = false; S.combo = { on: false };
    const n = document.getElementById('svTimeBar'); if (n) n.classList.add('sv-on');
    if (window.__svSyncViewSeg) window.__svSyncViewSeg();
  });
  await wait(page, 30);

  const BR = () => window.SUN_BRIDGE;

  for (const vw of [1600, 1180, 430]) {
    console.log('\n' + '='.repeat(72) + `\n视口宽度 ${vw}` + '\n' + '='.repeat(72));
    await page.setViewportSize({ width: vw, height: 950 });
    await wait(page, 20);

    const m = await page.evaluate(PROBE);
    const t = m.t;
    console.log(`thumb 直径=${t.toFixed(2)}px（轨道条内缩 ${m.pad.toFixed(2)}px）  轨道条=[${m.bar.l.toFixed(1)}, ${m.bar.r.toFixed(1)}] w=${m.bar.w.toFixed(1)}`);
    console.log(`关键点层=[${m.nodes.l.toFixed(1)}, ${m.nodes.r.toFixed(1)}]  range=[${m.range.l.toFixed(1)}, ${m.range.r.toFixed(1)}]`);

    /* 断言 1：轨道条 / 关键点层与「thumb 圆心行程」三者恒等 */
    ok(Math.abs(m.bar.l - (m.range.l + t / 2)) < 0.6,
      `轨道条左端 == thumb 圆心最小值（Δ=${(m.bar.l - m.range.l - t / 2).toFixed(2)}px）`);
    ok(Math.abs(m.bar.r - (m.range.r - t / 2)) < 0.6,
      `轨道条右端 == thumb 圆心最大值（Δ=${(m.bar.r - m.range.r + t / 2).toFixed(2)}px）`);
    ok(Math.abs(m.nodes.l - m.bar.l) < 0.6 && Math.abs(m.nodes.r - m.bar.r) < 0.6,
      `关键点层与轨道条左右端重合（Δ=${(m.nodes.l - m.bar.l).toFixed(2)} / ${(m.nodes.r - m.bar.r).toFixed(2)}px）`);

    /* 断言 2：滑块在 0 / 23:59 时 thumb 圆心正好落在轨道条两端。
       注意：#svHour 读的是**地方太阳时**（updateHUD 用 sunGeom().lst 回写），
       而 BR.msFromLocal 写的是**区时**，两者差一个经度时差 + 时差方程 ⇒ 不能用它驱动。
       这里直接钉住滑块值：临时把 __svHourDragging 伪造成 true（阻止 updateHUD 回写），
       等价于「用户正按住滑块拖到端点」。 */
    await page.evaluate(() => { window.__svTestHold = true; window.__svHourDragging = () => true; });
    for (const [minV, tag] of [[0, '00:00'], [720, '12:00'], [1439, '23:59']]) {
      await page.evaluate((mv) => { document.getElementById('svHour').value = String(mv); }, minV);
      await wait(page, 4);
      const mm = await page.evaluate(PROBE);
      const dL = Math.abs(mm.thumbCx - mm.bar.l), dR = Math.abs(mm.thumbCx - mm.bar.r);
      const q = (mm.thumbCx - mm.bar.l) / mm.bar.w;
      ok(Math.abs(q - minV / 1439) * mm.bar.w <= 0.6,
        `${tag} thumb 圆心 q=${q.toFixed(5)}（期望 ${(minV / 1439).toFixed(5)}，Δ${(Math.abs(q - minV / 1439) * mm.bar.w).toFixed(2)}px）`);
    }
    await page.evaluate(() => {
      window.__svHourDragging = () => false;
      const B = window.SUN_BRIDGE; B.setSimMs(Date.now());
    });
    await wait(page, 8);

    /* 断言 3：**走真实用户路径** —— 直接点「日出 / 日中天 / 日落」刻度节点
       （节点自身 onclick → setHourSlider → 写 hr.value + 派发 input → setSimMs），
       验证 thumb 圆心与该刻度圆点圆心重合。 */
    const KEY = ['日出', '日中天', '日落'];
    /* 先暂停自动播放 —— 否则点完刻度后时间仍在推进，thumb 会立刻离开该刻度点，
       量到的是「随时间漂移」而非「对齐误差」。
       播放状态在**主模块**（BR.isPlaying / 播放按钮），不在 S 里。 */
    await page.evaluate(() => {
      const btn = document.getElementById('svBtnPlay');
      if (btn && /暂停/.test(btn.textContent)) btn.click();
    });
    await wait(page, 6);
    for (const name of KEY) {
      const jump = await page.evaluate((kw) => {
        const n = Array.from(document.querySelectorAll('#svSunNodes .svtb-node'))
          .find((x) => x.textContent.indexOf(kw) === 0);
        if (!n) return null;
        n.click();
        return n.textContent;
      }, name);
      if (!jump) { ok(false, `未找到「${name}」节点`); continue; }
      await wait(page, 8);
      const mm = await page.evaluate(PROBE);
      const d = mm.dots.find((x) => x.txt.indexOf(name) === 0);
      if (!d) { ok(false, `「${name}」跳转后节点丢失`); continue; }
      const dpx = mm.thumbCx - d.dotCx;
      ok(Math.abs(dpx) <= 1.0, `点「${jump}」后 thumb 圆心 vs 该刻度圆点 Δ=${dpx.toFixed(2)}px（容差 1px）`);
    }

    /* 断言 4：像素实测复核 —— 截图后由 _pix_timebar.py 单独跑（沙箱禁止 node 拉起 python）。
       把当前 rise / set 一并写进 sidecar，供像素脚本换算「昼夜分段边界」的期望位置。 */
    const box = await page.evaluate(() => {
      const r = document.querySelector('#svTimeBar .svtb-slider.wide').getBoundingClientRect();
      return { x: Math.floor(r.left) - 14, y: Math.floor(r.top) - 4, width: Math.ceil(r.width) + 28, height: Math.ceil(r.height) + 10 };
    });
    /* 暂停播放后再截图，确保像素是稳定帧 */
    await page.evaluate(() => {
      const btn = document.getElementById('svBtnPlay');
      if (btn && /暂停/.test(btn.textContent)) btn.click();
    });
    await wait(page, 6);
    const f = path.join(SHOTS, `tb_px_${vw}.png`);
    await page.screenshot({ path: f, clip: box });
    const g = await page.evaluate(() => window.SUNVIEW.geom());
    fs.writeFileSync(f + '.json', JSON.stringify({ rise: g.rise, set: g.set }));
    console.log(`  像素复核截图：${path.relative(ROOT, f)}（rise=${g.rise.toFixed(3)}h set=${g.set.toFixed(3)}h）`);
  }

  ok(errs.length === 0, `运行期错误 ${errs.length} 条` + (errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项未通过'}`);
  process.exitCode = fails ? 1 : 0;
})();
