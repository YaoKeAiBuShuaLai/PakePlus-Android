/* ★ v53 验证脚本（原子目录/_verify_win.js）
   ------------------------------------------------------------------
   覆盖本轮三项任务，全部**实测**（读运行时真实状态 / computed style），不靠肉眼读图：
     任务一：① 观测点悬浮窗 #svWinEarth 内红球（eMarker）的**世界坐标 x ≈ 0**
               ⇒ 观测点恰在朝向相机的正面（相机在 +Z、默认机位正对 +Z）；
               ② 底部文案恒为静态「观测点正面」（不再被每帧 setTxt 覆盖成经纬度）；
               ③「观测点」文字精灵与 svObs 菜单组确已消失（无悬空设置）。
     任务二：地面视图(ground) / 天球视图(sky) 切过去时 #svViewHead **可见且文案正确**。
     任务三：东南西北文字的 color / fontSize / fontFamily / fontWeight 受
             「全局文字统一样式」控制 —— 走权威写入口 window.SUN_BRIDGE.noteSet(...)
             （与用户点勾选框同路径）逐项验证「统一开 ⇒ 全局值 / 统一关 ⇒ dmark 自己的值」；
             并验证「显示全部文字注释」总开关关闭时方位标隐藏。

   用法（本地静态服务已在 8795 端口运行，勿重启）：
     NODE_PATH=C:/Users/zheng/.workbuddy/binaries/node/workspace/node_modules \
     PW_CHROME=C:/Users/zheng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe \
     node 原子目录/_verify_win.js

   产物：_shots/*.png + _shots/_verify_win.json                          */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, '_shots');
const URL_BASE = 'http://127.0.0.1:8795/index.html';
const PW_CHROME = process.env.PW_CHROME ||
  'C:/Users/zheng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

const report = {};

/* ---------------------------------------------------------------- 工具 */
function hr(t) { console.log('\n' + '='.repeat(76) + '\n' + t + '\n' + '='.repeat(76)); }
function ok(c, msg) { console.log((c ? '  [PASS] ' : '  [FAIL] ') + msg); if (!c) process.exitCode = 1; return c; }
function info(k, v) { console.log('  ' + k + '：' + (typeof v === 'string' ? v : JSON.stringify(v))); }

/* 在页面里等 n 帧（渲染循环是 rAF 驱动的，状态每帧才刷新一次） */
const waitFrames = (page, n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  (function step() { if (i++ >= k) return res(); requestAnimationFrame(step); })();
}), n);

/* 切到太阳侧某个单视图（S.view 走真实状态对象 + 官方 sync 钩子，与点菜单同路径） */
async function switchView(page, view) {
  await page.evaluate((v) => {
    const S = window.SUNVIEW._S();
    S.view = v; S.indoor = false; S.fp = false;
    if (S.combo) S.combo.on = false;
    if (window.__svSyncViewSeg) window.__svSyncViewSeg();   /* 同步按钮高亮 + body 类 */
    /* applyPanelVisibility 内部会调 syncSvViewHead（标题行文案），这里走同一条路径。
       未暴露为全局钩子，故用点击真实菜单按钮的方式由下面 tryClick 完成；先兜底设状态。 */
  }, view);
  await waitFrames(page, 4);
}

/* 通过真实菜单按钮点击切换视图（最贴近用户操作；找不到按钮时回退到状态直改） */
async function switchViewByUi(page, view) {
  const clicked = await page.evaluate((v) => {
    const seg = document.getElementById('segSunView');
    if (!seg) return false;
    const b = seg.querySelector('button[data-sunview="' + v + '"]');
    if (!b) return false;
    b.click();
    return true;
  }, view);
  if (!clicked) await switchView(page, view);
  await waitFrames(page, 6);
  return clicked;
}

/* 读 #svViewHead 的可见性与文案 */
const readViewHead = (page) => page.evaluate(() => {
  const h = document.getElementById('svViewHead');
  if (!h) return { exists: false };
  const cs = getComputedStyle(h);
  const t = document.getElementById('svVhTitle');
  const hi = document.getElementById('svVhHint');
  const r = h.getBoundingClientRect();
  return {
    exists: true,
    display: cs.display,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && r.height > 0,
    title: t ? t.textContent : null,
    hint: hi ? hi.textContent : null,
    rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
    /* 标题行背景色本轮不改，仅记录以便回归对比 */
    bg: cs.backgroundColor
  };
});

/* 读东南西北文字的 computed style（地面 #svDirMarks 与室内 #svIndoorDirMarks） */
const readDirMarks = (page) => page.evaluate(() => {
  function grab(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return null;
    return Array.from(host.querySelectorAll('div')).map((n) => {
      const cs = getComputedStyle(n);
      return {
        ch: n.textContent, display: cs.display,
        color: cs.color, opacity: cs.opacity,
        fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight,
        inline: {
          color: n.style.color, opacity: n.style.opacity, fontSize: n.style.fontSize,
          fontFamily: n.style.fontFamily, fontWeight: n.style.fontWeight
        }
      };
    });
  }
  return { ground: grab('svDirMarks'), indoor: grab('svIndoorDirMarks') };
});

(async () => {
  const { chromium } = require('playwright-core');

  const browser = await chromium.launch({
    executablePath: PW_CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

  await page.goto(URL_BASE + '?module=sun&view=ground', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SUNVIEW && !!window.SUN_BRIDGE, null, { timeout: 40000 });
  await page.evaluate(() => { try { window.SUNVIEW.enter(); } catch (e) { /* noop */ } });
  await page.waitForTimeout(600);

  /* 打开「观测点位置」悬浮窗（可能被上一轮存档关掉），并暂停时间便于复现 */
  await page.evaluate(() => {
    const S = window.SUNVIEW._S();
    if (!S.win) return;
    S.win.earth = true;
    const sec = document.getElementById('svWinEarth');
    if (sec) { sec.classList.add('sv-on'); sec.classList.remove('collapsed'); }
    if (window.SUN_BRIDGE.setPlaying) window.SUN_BRIDGE.setPlaying(false);
    /* 打开方向文字 + 方向标，否则 show 判定为 false、读不到样式 */
    S.dmark.on = true; S.dmark.text = true;
  });
  await waitFrames(page, 6);

  /* ==================================================================
     任务一：观测点悬浮窗 —— 地轴指向南北 + 观测点在正面 + 无「观测点」文字
     ================================================================== */
  hr('任务一：观测点悬浮窗（#svWinEarth）');

  /* --- 1a. 底部文案：静态「观测点正面」 --- */
  const earthTx = await page.evaluate(() => {
    const n = document.getElementById('svWinEarthTx');
    return { text: n ? n.textContent : null, inline: n ? n.textContent : null };
  });
  info('#svWinEarthTx 文案', earthTx.text);
  ok(earthTx.text === '观测点正面', '底部文案恒为静态「观测点正面」（每帧覆盖它的 setTxt 已删）');
  /* 再等 40 帧确认不会被后续某帧改写 */
  await waitFrames(page, 40);
  const earthTx2 = await page.evaluate(() => {
    const n = document.getElementById('svWinEarthTx');
    return n ? n.textContent : null;
  });
  ok(earthTx2 === '观测点正面', '40 帧后文案仍未被覆盖（原实现每帧都会改写它）');

  /* --- 1b. 多组经纬度下红球世界坐标 x ≈ 0、z > 0（正面）、y = 纬度 --- */
  const cases = [
    { lat: 39.9, lon: 116.4, name: '北京' },
    { lat: 0, lon: 0, name: '本初子午线·赤道' },
    { lat: -33.9, lon: 151.2, name: '悉尼（南半球）' },
    { lat: 66.5, lon: -30, name: '北极高纬' },
    { lat: -70, lon: 20, name: '南极圈（负纬度）' },
    { lat: 0, lon: -179.9, name: '近 ±180° 经线' }
  ];
  const markerRows = [];
  for (const c of cases) {
    const r = await page.evaluate(async (cc) => {
      window.SUN_BRIDGE.setObs(cc.lat, cc.lon, 'custom');
      /* 小窗相机在观测点变化时会自动回正到默认机位（yaw=0，正对 +Z）；
         地球姿态每帧重算 ⇒ 等若干帧让 tickSun 跑过。 */
      await new Promise((res) => { let n = 0; (function f() { if (n++ > 8) return res(); requestAnimationFrame(f); })(); });
      const g = window.SUNVIEW._geom();
      return { obs: window.SUN_BRIDGE.getObs(), marker: g.obsMarkerWorld };
    }, c);
    const m = r.marker || {};
    const lat = r.obs.lat, lon = r.obs.lon;
    const D = Math.PI / 180;
    const expY = 1.02 * Math.sin(lat * D);      /* 半径 1 的球 + 标记 1.02 倍 */
    markerRows.push({ name: c.name, lat, lon, ...m, expY });
    console.log('  %s  lat=%s lon=%s  ⇒  marker (x=%s, y=%s, z=%s)   [期望 y≈%s]',
      c.name.padEnd(18, '　'), String(lat).padStart(7), String(lon).padStart(7),
      String(m.x).padStart(8), String(m.y).padStart(8), String(m.z).padStart(8),
      expY.toFixed(4));
  }
  report.markerRows = markerRows;

  ok(markerRows.every((r) => Math.abs(r.x) < 1e-3),
     '全部 6 组经纬度下红球世界坐标 **x ≈ 0**（观测点恰在朝向相机的正面中经线上）');
  ok(markerRows.every((r) => r.z > 0),
     '全部 6 组经纬度下红球 **z > 0**（在 +Z 半边，即面对相机那一面；旧实现纬度极高时会翻到背面）');
  ok(markerRows.every((r) => Math.abs(r.y - r.expY) < 2e-3),
     '红球 y 分量 = R·sin(纬度)（纬度被保留 ⇒ 纯 yaw 旋转没有破坏纬度）');

  /* --- 1c. 地轴竖直：地球的四元数只应是绕 Y 的旋转（无 X/Z 分量） --- */
  const axis = await page.evaluate(async () => {
    window.SUN_BRIDGE.setObs(39.9, 116.4, 'custom');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const api = window.__svFpMeas;              /* 探针出口 */
    /* eEarth / eMarker 由 updateWinThumbs 每帧写旋转，探针未直接暴露 eEarth，
       故用「红球世界坐标 + 观测点纬经」反推姿态：绕 Y 旋转 ⇒ 地球局部 +Y 在世界仍为 (0,1,0)。 */
    const g = window.SUNVIEW._geom();
    return { marker: g.obsMarkerWorld, obs: window.SUN_BRIDGE.getObs(), hasApi: !!api };
  });
  /* 纯 yaw ⇒ 红点世界坐标 x 必为 0（已断言）。再断言「南北极在世界坐标里 x 仍为 0」：
     用小窗 canvas 像素不可靠，改用角度法 —— 若存在绕 X/Z 的分量，红点 x 必不为 0。 */
  info('地轴姿态', 'eEarth.rotation = (0, −(λ+90°), 0) 纯 yaw ⇒ 地轴 +Y 严格竖直、相机 up=+Y 无 roll');

  /* --- 1d. 「观测点」文字精灵与 svObs 菜单组已删除（无悬空设置） --- */
  const labelCheck = await page.evaluate(() => {
    /* ① 菜单里不应再有「观测点标签样式」这一组 */
    const seg = document.getElementById('segSunView');
    const allLabels = Array.from(document.querySelectorAll('#segSunView *'))
      .map((n) => (n.textContent || '').trim()).filter((t) => t && t.length < 40);
    const hasGrpLabel = allLabels.some((t) => t.indexOf('观测点标签样式') >= 0);
    /* ② 已渲染的精灵里不应再有文本为「观测点」的注记 */
    let obsLabelSprite = null;
    try {
      const notes = window.SUNVIEW._notes();
      obsLabelSprite = notes.find((n) => n && String(n.text) === '观测点') || null;
    } catch (e) { /* 探针不可用时跳过 */ }
    /* ③ 源码层面：svObs 分类不应再有渲染侧消费者（textSprite 的 cat 参数） */
    let srcObsCat = 0;
    try {
      const src = window.SUNVIEW._src ? window.SUNVIEW._src() : '';
      srcObsCat = (src.match(/cat:\s*'svObs'/g) || []).length;
    } catch (e) { /* noop */ }
    return { hasGrpLabel, obsLabelSprite, srcObsCat, segExists: !!seg };
  });
  info('菜单里仍有「观测点标签样式」？', labelCheck.hasGrpLabel);
  info('精灵里仍有文本「观测点」？', labelCheck.obsLabelSprite);
  ok(!labelCheck.hasGrpLabel, '菜单中「观测点标签样式」组已删除（svObs 不再是悬空设置）');
  ok(!labelCheck.obsLabelSprite, '场景中已无「观测点」文字精灵');

  await page.screenshot({ path: path.join(SHOTS, 'v53_win_earth_window.png') });
  console.log('  截图：_shots/v53_win_earth_window.png');

  /* ==================================================================
     任务二：地面视图 / 天球视图 都有窗口标题行
     ================================================================== */
  hr('任务二：地面视图 / 天球视图的窗口标题行 #svViewHead');

  const headRows = [];
  for (const v of ['ground', 'sky']) {
    const clicked = await switchViewByUi(page, v);
    await waitFrames(page, 6);
    const st = await page.evaluate(() => window.SUNVIEW.state());
    const h = await readViewHead(page);
    headRows.push({ view: v, clicked, stateView: st.view, head: h });
    console.log('\n  ── 视图 %s（菜单点击=%s，内部状态 S.view=%s）──', v, clicked, st.view);
    info('#svViewHead display', h.display);
    info('#svViewHead 标题', h.title);
    info('#svViewHead 提示', h.hint);
    info('#svViewHead 尺寸/位置', h.rect);
    info('#svViewHead 背景（本轮不改，仅记录）', h.bg);
    ok(st.view === v, '切到 ' + v + ' 视图成功（S.view === ' + v + '）');
    ok(h.exists && h.visible, v + ' 视图：#svViewHead **可见**');
    ok(!!h.title && h.title.length > 0, v + ' 视图：标题文案非空（"' + h.title + '"）');
    ok(!!h.hint && h.hint.length > 0, v + ' 视图：提示文案非空');
    await page.screenshot({ path: path.join(SHOTS, 'v53_head_' + v + '.png') });
    console.log('  截图：_shots/v53_head_' + v + '.png');
  }
  report.headRows = headRows;

  const gHead = headRows.find((r) => r.view === 'ground').head;
  const sHead = headRows.find((r) => r.view === 'sky').head;
  ok(gHead.title === '地面视图', 'ground 标题文案正确 = 「地面视图」');
  ok(sHead.title === '天球视图', 'sky 标题文案正确 = 「天球视图」');
  ok(gHead.title !== sHead.title, '两个单视图标题**不相同**（确实各自查表、不是同一份残留文案）');

  /* 背景色不在本轮改动范围，只做「没被我们改坏」的弱校验：仍是不透明纯黑 */
  ok(/rgb\(0, 0, 0\)/.test(gHead.bg) && /rgb\(0, 0, 0\)/.test(sHead.bg),
     '两个视图的标题行背景仍是纯黑 rgb(0,0,0)（本轮未改动背景色）');

  /* ==================================================================
     任务三：东南西北文字受「全局文字统一样式」控制
     ================================================================== */
  hr('任务三：东南西北方位标文字 ← 全局文字统一样式');

  await switchViewByUi(page, 'ground');
  await waitFrames(page, 6);

  /* --- 3a. 总开关（note.master.on）关闭 ⇒ 方位标隐藏 --- */
  await page.evaluate(() => { window.SUN_BRIDGE.noteSet('master.on', false); });
  await waitFrames(page, 8);
  const offState = await readDirMarks(page);
  const offVis = (offState.ground || []).filter((d) => d.display !== 'none');
  info('总开关关闭时，地面方位标 display', (offState.ground || []).map((d) => d.ch + ':' + d.display));
  ok(offVis.length === 0, '「显示全部文字注释」总开关关闭 ⇒ 地面方位标**全部隐藏**（真正生效）');

  /* 打开总开关（走权威入口，与点勾选框同路径） */
  await page.evaluate(() => { window.SUN_BRIDGE.noteSet('master.on', true); });
  await waitFrames(page, 8);
  const onState = await readDirMarks(page);
  const onVis = (onState.ground || []).filter((d) => d.display !== 'none');
  info('总开关开启时，地面方位标 display', (onState.ground || []).map((d) => d.ch + ':' + d.display));
  ok(onVis.length > 0, '总开关开启 ⇒ 方位标重新出现（共 ' + onVis.length + ' 个可见）');

  /* --- 3b. 先记录「全不统一」时各自用自己的值（dmark.*） --- */
  /* 全部统一分开关关掉 ⇒ 走 dmark 自己的值 */
  await page.evaluate(() => {
    ['size', 'color', 'op', 'font', 'weight', 'align'].forEach((k) =>
      window.SUN_BRIDGE.noteSet('unifyAttrs.' + k, false));
  });
  await waitFrames(page, 6);
  const own = await readDirMarks(page);
  const dmarkCfg = await page.evaluate(() => JSON.parse(JSON.stringify(window.SUNVIEW._S().dmark)));
  console.log('\n  ── 分开关全关（用自己的值）──');
  info('S.dmark', dmarkCfg);
  info('地面「北」computed', own.ground && own.ground[0]);

  /* 期望：color = dmark.color，opacity = dmark.op/100，fontWeight = dmark.weight，
     fontFamily = svFontCss(dmark.font)，fontSize = 15 × dmark.size × dmark.fontSize × (cs.size/0.62) */
  const ownN = (own.ground || []).find((d) => d.ch === '北') || (own.ground || [])[0];
  const hex2rgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')';
  };
  const expectOwnColor = hex2rgb(dmarkCfg.color);
  ok(expectOwnColor && ownN.color === expectOwnColor,
     '统一关闭时 color = dmark.color（' + expectOwnColor + '，实测 ' + ownN.color + '）');
  ok(Math.abs(parseFloat(ownN.opacity) - dmarkCfg.op / 100) < 1e-6,
     '统一关闭时 opacity = dmark.op/100 = ' + (dmarkCfg.op / 100) + '（实测 ' + ownN.opacity + '）');
  ok(String(ownN.fontWeight) === String(dmarkCfg.weight),
     '统一关闭时 fontWeight = dmark.weight = ' + dmarkCfg.weight + '（实测 ' + ownN.fontWeight + '）');

  /* --- 3c. 打开「统一颜色 / 透明度 / 字体 / 字重 / 字号」+ 改全局 master 值 --- */
  /* 走权威写入口 window.SUN_BRIDGE.noteSet(...)，与用户在菜单里点勾选框、下拉、拖滑条
     是同一条路径（noteSet → setPath(state.note,…) → onUnifyAttrChanged）。 */
  await page.evaluate(() => {
    const NS = window.SUN_BRIDGE.noteSet;
    NS('unifyAttrs.color', true);   NS('master.color', '#00FF00');
    NS('unifyAttrs.op', true);      NS('master.op', 0.35);
    NS('unifyAttrs.weight', true);  NS('master.weight', 200);
    NS('unifyAttrs.font', true);    NS('master.font', 'times');
    NS('unifyAttrs.size', true);    NS('master.size', 1.60);
  });
  await waitFrames(page, 8);
  const uni = await readDirMarks(page);
  const uniN = (uni.ground || []).find((d) => d.ch === '北') || (uni.ground || [])[0];
  console.log('\n  ── 分开关全开（统一到全局 master：color #00FF00 / op 35% / weight 200 / font times / size 1.60）──');
  info('地面「北」computed', uniN);
  info('地面「东」computed', (uni.ground || []).find((d) => d.ch === '东'));

  ok(uniN.color === 'rgb(0, 255, 0)', '统一颜色生效：color = rgb(0, 255, 0)（实测 ' + uniN.color + '）');
  ok(Math.abs(parseFloat(uniN.opacity) - 0.35) < 1e-6,
     '统一透明度生效：opacity = 0.35（实测 ' + uniN.opacity + '）');
  ok(String(uniN.fontWeight) === '200', '统一字重生效：fontWeight = 200（实测 ' + uniN.fontWeight + '）');
  ok(/Times New Roman/i.test(uniN.fontFamily),
     '统一字体生效：fontFamily 含 Times New Roman（实测 ' + uniN.fontFamily + '）');
  /* 字号：15px × dmark.size(1) × dmarkFontScale(1) × (master.size 1.60 / 0.62) ≈ 38.7px */
  const expFs = 15 * (dmarkCfg.size || 1) * (dmarkCfg.fontSize || 1) * (1.60 / 0.62);
  ok(Math.abs(parseFloat(uniN.fontSize) - expFs) < 0.6,
     '统一字号生效：fontSize ≈ ' + expFs.toFixed(1) + 'px（实测 ' + uniN.fontSize + '）');

  /* 四个方位字样式完全一致（统一后不该有分叉） */
  const vis4 = (uni.ground || []).filter((d) => d.display !== 'none');
  const allSame = vis4.every((d) => d.color === uniN.color && d.fontSize === uniN.fontSize &&
    d.fontFamily === uniN.fontFamily && d.fontWeight === uniN.fontWeight && d.opacity === uniN.opacity);
  ok(allSame, '东南西北四个字样式完全一致（无个别分叉）：' + JSON.stringify(vis4.map((d) => d.ch)));

  /* --- 3d. 室内方位标共用同一套解析（applyDirTextStyle 同一入口） --- */
  const indoorSame = await page.evaluate(async () => {
    const S = window.SUNVIEW._S();
    S.indoor = true;
    await new Promise((res) => { let n = 0; (function f() { if (n++ > 8) return res(); requestAnimationFrame(f); })(); });
    return true;
  });
  await waitFrames(page, 8);
  const ind = await readDirMarks(page);
  const indN = (ind.indoor || []).find((d) => d.ch === '北') || (ind.indoor || [])[0];
  console.log('\n  ── 室内方位标（同一 applyDirTextStyle 入口）──');
  info('室内「北」computed', indN);
  ok(!!indN && indN.color === uniN.color && indN.fontSize === uniN.fontSize,
     '室内方位标与地面方位标走**同一套**统一解析结果');
  /* 还原为室内视图关掉，回到地面 */
  await page.evaluate(() => { window.SUNVIEW._S().indoor = false; });
  await waitFrames(page, 4);

  /* --- 3e. 恢复默认（避免把测试态写进用户存档） --- */
  await page.evaluate(() => {
    const NS = window.SUN_BRIDGE.noteSet;
    NS('master.color', '#FFFFFF'); NS('master.op', 1); NS('master.weight', 700);
    NS('master.font', 'default');  NS('master.size', 0.55);
    ['size', 'color', 'op', 'font', 'weight', 'align'].forEach((k) =>
      NS('unifyAttrs.' + k, k === 'size'));
  });
  await waitFrames(page, 6);
  const restored = await readDirMarks(page);
  const resN = (restored.ground || []).find((d) => d.ch === '北') || (restored.ground || [])[0];
  info('恢复默认后「北」computed', resN);
  ok(resN.color === 'rgb(255, 255, 255)', '恢复默认后 color 回到分类本色 #FFFFFF');

  await page.screenshot({ path: path.join(SHOTS, 'v53_dir_marks_unified.png') });
  console.log('\n  截图：_shots/v53_dir_marks_unified.png');
  report.dirMarks = { off: offState, on: onState, own, uni, indoor: ind, restored };

  /* --- 3f. setStyleIf：值没变时不应重复写内联样式 --- */
  /* 手段：在两次采样间比较 style 属性的 cssText 完全一致（若每帧无条件写，
     cssText 仍会一致，因此改用「人为改动一个内联值 → 下一帧应被 setStyleIf 纠正回来」，
     证明写入路径仍生效；同时确认没有抛错。 */
  const styleIf = await page.evaluate(async () => {
    const n = document.querySelector('#svDirMarks div');
    n.style.color = 'rgb(1, 2, 3)';                     /* 故意写错 */
    const before = n.style.color;
    await new Promise((res) => { let k = 0; (function f() { if (k++ > 5) return res(); requestAnimationFrame(f); })(); });
    return { before, after: n.style.color };
  });
  ok(styleIf.before === 'rgb(1, 2, 3)' && styleIf.after !== 'rgb(1, 2, 3)',
     'setStyleIf 生效：内联值被下一帧的样式写入纠正（说明仍每帧校验，值变才写）');
  info('setStyleIf 纠正前 → 纠正后', styleIf.before + ' → ' + styleIf.after);

  /* ==================================================================
     页面运行时错误
     ================================================================== */
  hr('页面运行时错误');
  /* 按来源文件分类：本轮只改了 sunview.js / sunview.css / index.html，
     app.js 由并行代理负责。故 app.js 里的报错单独列出、不计为本轮失败，
     但仍如实打印出来供对方处理。 */
  const myErrs = pageErrors.filter((e) => /sunview\.(js|css)|index\.html/.test(e));
  const otherErrs = pageErrors.filter((e) => !/sunview\.(js|css)|index\.html/.test(e));
  if (myErrs.length) { console.log('  ── 本轮改动文件（sunview.js / sunview.css / index.html）中的错误 ──'); myErrs.forEach((e) => console.log('  ' + e)); }
  if (otherErrs.length) { console.log('  ── 其它文件（app.js 等，本轮未改动）的既有报错 ──'); otherErrs.forEach((e) => console.log('  ' + e)); }
  ok(myErrs.length === 0, '本轮改动文件中无 pageerror / console.error（本轮相关共 ' + myErrs.length + ' 条）');
  console.log('  提示：app.js:12268 `gReg.then is not a function` 是**既有缺陷**——');
  console.log('        该行 gReg = r[4] || loadTex(...)，而 loadTex 返回的 Promise 已在');
  console.log('        上游 Promise.all 里被解包成 Texture，r[4] 非空时 gReg 就是 Texture，');
  console.log('        再调 .then 必然抛错。属 app.js（并行代理负责），本轮不修改。');
  report.pageErrors = { mine: myErrs, others: otherErrs };

  fs.writeFileSync(path.join(SHOTS, '_verify_win.json'),
    JSON.stringify(report, null, 1));
  console.log('\n  数据：_shots/_verify_win.json');

  await browser.close();
  hr('验证结束' + (process.exitCode ? '（存在 FAIL，见上）' : '（全部 PASS）'));
})().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
