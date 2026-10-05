/* ★ v53 验证脚本（原子目录/_verify_sun.js）
   ------------------------------------------------------------------
   目的：对本轮三项改动做**实测**验证，不靠肉眼读图。
     任务一：第一人称罗盘「东南西北」文字不随盘面旋转。
     任务二：多小人场景双击某个小人 → 以**该小人**为第一视角视点。
     任务三：地面视图物影测量在低太阳高度角下的方向与长度。
             —— 影长随高度角**单调递增**；在未被夹取的区间与 H/tan(alt) **吻合**。

   用法（本地静态服务已在 8795 端口运行，勿重启）：
     NODE_PATH=C:/Users/zheng/.workbuddy/binaries/node/workspace/node_modules \
     PW_CHROME=C:/Users/zheng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe \
     node 原子目录/_verify_sun.js

   产物：_shots/ 下若干 PNG + _meas_samples.json / _fp_multi.json */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, '_shots');
const URL_BASE = 'http://127.0.0.1:8795/index.html';
const PW_CHROME = process.env.PW_CHROME ||
  'C:/Users/zheng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------------------------------------------------------------- 工具 */
function hr(t) { console.log('\n' + '='.repeat(74) + '\n' + t + '\n' + '='.repeat(74)); }
function ok(c, msg) { console.log((c ? '  [PASS] ' : '  [FAIL] ') + msg); if (!c) process.exitCode = 1; return c; }

/* 在页面里等 n 帧（渲染循环是 rAF 驱动，状态每帧才刷新一次） */
const waitFrames = (page, n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  (function step() { if (i++ >= k) return res(); requestAnimationFrame(step); })();
}), n);

(async () => {
  const { chromium } = require('playwright-core');

  const browser = await chromium.launch({
    executablePath: PW_CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

  /* URL 带 module=sun&view=ground：应用本身可能不消费这两个 query，
     所以加载后再用 SUNVIEW / __svSyncViewSeg 显式切到太阳侧地面视图（双保险）。 */
  await page.goto(URL_BASE + '?module=sun&view=ground', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.SUNVIEW && !!window.__svFpMeas, null, { timeout: 30000 });
  await page.evaluate(() => { try { window.SUNVIEW.enter(); } catch (e) { /* noop */ } });
  await page.evaluate(() => {
    const S = window.SUNVIEW._S();
    S.view = 'ground'; S.indoor = false; S.fp = false; S.combo = { on: false };
    if (window.__svSyncViewSeg) window.__svSyncViewSeg();
  });
  await waitFrames(page, 8);

  /* ================================================================
     任务一：罗盘文字不随盘面旋转
     ================================================================ */
  hr('任务一：第一人称罗盘「东南西北」文字不随盘面旋转');

  const dialCheck = await page.evaluate(() => {
    const cmp = document.getElementById('svCompass');
    const dial = cmp && cmp.querySelector('.svc-dial');
    const lbls = Array.from(cmp.querySelectorAll('.svc-lbl'));
    return {
      hasDial: !!dial,
      dialChildren: dial ? Array.from(dial.children).map((n) => n.className) : [],
      lblCount: lbls.length,
      /* label 的父元素是 #svCompass（而非 dial）才说明它没被塞进旋转容器。
         注意用 parentElement 而非 offsetParent：HUD 未显示时 offsetParent 恒为 null。 */
      lblParentIsCmp: lbls.map((n) => n.parentElement ? n.parentElement.id : '(null)'),
      needleParentIsCmp: (() => { const nd = document.getElementById('svCompassNeedle'); return nd ? nd.parentElement.id : null; })()
    };
  });
  console.log('  dial 子节点：', JSON.stringify(dialCheck.dialChildren));
  console.log('  label 数量：', dialCheck.lblCount, ' offsetParent：', JSON.stringify(dialCheck.lblParentIsCmp));
  ok(dialCheck.lblCount === 4, '4 个 .svc-lbl 方位字都在');
  ok(dialCheck.dialChildren.every((c) => c.indexOf('svc-lbl') < 0),
     '.svc-dial 内已无 .svc-lbl（文字不参与 rotate）');
  ok(dialCheck.lblParentIsCmp.every((p) => p === 'svCompass'),
     '方位字的父级是 #svCompass（定位基准未变，CSS 偏移量无需改动）');
  ok(dialCheck.hasDial && dialCheck.dialChildren.some((c) => c.indexOf('svc-ring') >= 0),
     '.svc-dial 内保留 .svc-ring 刻度环（刻度仍随航向转）');

  /* 实测：在第一视角里**真实拖拽画布**改变航向（updateHUD 每帧按 fpYaw 重写 dial 的
     rotate），比较多个航向下 label 与 dial 的表现。 */
  await page.evaluate(() => {
    window.__svFpMeas.enterFP();              /* 无 host ⇒ 回退 figObj，本项只测罗盘 */
    const S = window.SUNVIEW._S(); S.fpmark.on = true;
  });
  await waitFrames(page, 4);

  const readCompass = () => page.evaluate(() => {
    const cmp = document.getElementById('svCompass');
    const dial = cmp.querySelector('.svc-dial');
    const nEl = cmp.querySelector('.svc-lbl.n');
    const cRect = cmp.getBoundingClientRect(), nRect = nEl.getBoundingClientRect();
    return {
      yawDeg: (window.SUNVIEW._cam().fpv.yaw * 180 / Math.PI + 360) % 360,
      dialTransform: getComputedStyle(dial).transform,
      nTransform: getComputedStyle(nEl).transform,
      /* 北字中心相对罗盘中心的偏移（px）—— 判据：恒定在正上方，不随航向漂移 */
      nOffsetX: (nRect.left + nRect.width / 2) - (cRect.left + cRect.width / 2),
      nOffsetY: nRect.top - cRect.top,
      nText: nEl.textContent
    };
  });

  /* 改变航向用**「锁定太阳」**这条真实代码路径：勾上后 updateFP 每帧执行
     `fpYaw = atan2(sdir.x, -sdir.z)`，即航向 = 太阳真实方位角。
     于是「改模拟时刻 → 太阳方位角变 → fpYaw 变 → updateHUD 重写 dial 的 rotate」，
     整条链都是产品真实逻辑，不依赖合成鼠标事件（headless 下画布拖拽不可靠）。 */
  const compassRows = [];
  await page.evaluate(() => {
    const S = window.SUNVIEW._S();
    S.fpmark.on = true; S.sunflower = true;              /* 锁定太阳 ⇒ yaw 跟随太阳方位 */
    const b = document.getElementById('svSunflower'); if (b) b.classList.add('on');
  });
  const dayBase = await page.evaluate(() => {
    const BR = window.SUN_BRIDGE;
    const p0 = BR.localParts(BR.getSimMs());
    const day0 = Date.UTC(2026, 0, 1) + (p0.doy - 1) * 86400000;
    return Math.floor((day0 - new Date().getTimezoneOffset() * 60000) / 60000) * 60000;
  });
  for (const mins of [480, 540, 600, 660, 720, 780]) {  /* 08:00 … 13:00 → 航向跨度很大 */
    await page.evaluate((ms) => { window.SUN_BRIDGE.setSimMs(ms); }, dayBase + mins * 60000);
    await waitFrames(page, 5);
    compassRows.push(await readCompass());
  }
  /* 末行 = 关掉锁定太阳后**手动拖拽转头**，验证手动转头同样不带动文字 */
  await page.evaluate(() => { window.SUNVIEW._S().sunflower = false; });
  await page.evaluate(() => {
    const cv = document.getElementById('svCanvas');
    const r = cv.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height * 0.18;
    const o = (px) => ({ bubbles: true, cancelable: true, clientX: px, clientY: y,
                         button: 0, buttons: 1, pointerId: 5, pointerType: 'mouse', isPrimary: true });
    cv.dispatchEvent(new PointerEvent('pointerdown', o(x)));
    for (let k = 1; k <= 10; k++) cv.dispatchEvent(new PointerEvent('pointermove', o(x + k * 22)));
    cv.dispatchEvent(new PointerEvent('pointerup', o(x + 220)));
  });
  await waitFrames(page, 5);
  compassRows.push(await readCompass());

  console.log('\n  航向实测（末行 = 手动拖拽转头）：');
  console.log('     航向°    dial transform                 北字transform      北字Δx   北字Δy');
  compassRows.forEach((r) => console.log(
    '  ' + r.yawDeg.toFixed(1).padStart(8) + '  ' + r.dialTransform.padEnd(30) +
    r.nTransform.padEnd(20) + r.nOffsetX.toFixed(1).padStart(7) + r.nOffsetY.toFixed(1).padStart(8)));
  await page.screenshot({ path: path.join(SHOTS, 'v53_task1_compass.png') });

  /* 断言 A：dial 的 transform 确实随航向变化（证明刻度盘仍在转 —— 不能是「整体都不转」蒙混过关）*/
  const dialTfSet = new Set(compassRows.map((r) => r.dialTransform));
  ok(dialTfSet.size >= 3, '刻度盘面 dial 的 transform 随航向改变（实测 ' + dialTfSet.size + ' 种取值）');

  /* 断言 B：方位字自身**不含旋转** —— computed transform 只有平移矩阵 */
  ok(compassRows.every((r) => r.nTransform === 'none' || /^matrix\(1, 0, 0, 1,/.test(r.nTransform)),
     '方位字自身只有平移、无 rotate 矩阵 ⇒ 恒定朝上');

  /* 断言 C：北字相对罗盘中心的偏移在整个航向扫描中**恒定**（不随 dial 旋转而漂移）*/
  const dx0 = compassRows[0].nOffsetX, dy0 = compassRows[0].nOffsetY;
  const drift = Math.max.apply(null, compassRows.map((r) => Math.hypot(r.nOffsetX - dx0, r.nOffsetY - dy0)));
  ok(drift < 0.6, '北字相对罗盘中心零漂移（各航向下最大偏移 ' + drift.toFixed(3) + 'px）');
  ok(Math.abs(dy0) > 0 && dy0 < 14, `北字仍位于罗盘顶部（Δy=${dy0.toFixed(1)}px，CSS top:2px 依旧生效）`);
  ok(Math.abs(dx0) < 1.5, `北字仍水平居中（Δx=${dx0.toFixed(1)}px）`);

  console.log('  截图：_shots/v53_task1_compass.png');

  /* 退出第一视角，后面测地面视图 */
  await page.evaluate(() => { window.__svFpMeas.exitFP(); });
  await waitFrames(page, 4);

  /* ================================================================
     任务三：物影测量 —— 影长 vs 太阳高度角
     ================================================================ */
  hr('任务三：物影测量在低太阳高度角下的方向与长度');

  /* 场景准备：暂停时间、放一个足够高的建筑（便于在低高度角下量到长影） */
  await page.evaluate(() => {
    window.SUN_BRIDGE.setPlaying(false);
  });

  /* 找一个**能扫过多档高度角**的观测点：直接改纬度到高纬，冬半年正午高度角也低。
     简单可靠的办法：不改观测点，而是把时间在一天内扫描，取样 0.2° ~ 60°。 */
  const geomInfo = await page.evaluate(() => {
    const g = window.SUNVIEW.geom();
    const api = window.__svFpMeas;
    return {
      GROUND_R: api.GROUND_R, GSIZE: api.GSIZE,
      SHADOW_MAX: api.SHADOW_MAX, SHADOW_MIN_ALT: api.SHADOW_MIN_ALT, SHADOW_FAR: api.SHADOW_FAR,
      shadowCam: (() => {
        const c = api.sunLight.shadow.camera;
        return { l: c.left, r: c.right, t: c.top, b: c.bottom, near: c.near, far: c.far,
                 lightDist: api.sunLight.position.length() };
      })(),
      obs: window.SUN_BRIDGE.getObs(),
      simMs: window.SUN_BRIDGE.getSimMs()
    };
  });
  console.log('  观测点：', JSON.stringify(geomInfo.obs));
  console.log('  GROUND_R=%s  GSIZE=%s', geomInfo.GROUND_R, geomInfo.GSIZE);
  console.log('  SHADOW_MAX=%s  SHADOW_MIN_ALT=%s  SHADOW_FAR=%s',
    geomInfo.SHADOW_MAX, geomInfo.SHADOW_MIN_ALT, geomInfo.SHADOW_FAR);
  console.log('  阴影视锥：', JSON.stringify(geomInfo.shadowCam));
  ok(Math.abs(geomInfo.shadowCam.far - geomInfo.SHADOW_FAR) < 1e-6, 'shadow camera far == SHADOW_FAR');
  ok(Math.abs(geomInfo.shadowCam.r - geomInfo.SHADOW_MAX) < 1e-3, 'shadow camera half-extent == SHADOW_MAX');
  ok(Math.abs(geomInfo.shadowCam.l + geomInfo.SHADOW_MAX) < 1e-3, 'shadow camera left == −SHADOW_MAX');
  ok(Math.abs(geomInfo.shadowCam.lightDist - geomInfo.SHADOW_FAR) < 1e-3, '光源距离 == SHADOW_FAR（否则光源落在视锥 far 外，阴影全丢）');

  /* 放一个高建筑并开启测量 —— 建筑高 ⇒ 低高度角下影长够长、便于核对 H/tan(alt) */
  const setupMeas = await page.evaluate(() => {
    const S = window.SUNVIEW._S();
    S.meas.on = true; S.ray.shadow = true;
    S.bld.floors = 8; S.bld.floorH = 3;                /* H = 24 m */
    if (window.__svSyncBinders) window.__svSyncBinders();
    const api = window.__svFpMeas;
    const bld = api.props.find((o) => o.userData && o.userData.kind === 'building');
    if (!bld) return { ok: false, why: 'no building' };
    bld.position.set(0, 0, 0); bld.rotation.y = 0.6;    /* 故意旋转，检验方向闭合 */
    api.beginMeasure(bld);
    return { ok: true, id: bld.userData.id, H: (bld.userData.floors || 1) * (bld.userData.floorH || 3),
             w: bld.userData.w, d: bld.userData.d, rotY: bld.rotation.y };
  });
  console.log('  测量对象：', JSON.stringify(setupMeas));
  ok(setupMeas.ok, '已选中建筑并开启物影测量');

  /* 扫描：把**一整天**的高度角曲线密集采下来（每 2 分钟一点），
     再对每个目标高度角做线性插值反解出时刻。
     ★ 不能用「先粗扫找第一个 ≤ w 的点」那种写法：一天里 alt 会先升到最高再降回，
       「第一个 ≤ w」永远是清晨那一点，20 个目标会全部撞在同一时刻（实测曾全部返回 0.6982°）。
       正确做法是先拿到完整曲线，再在曲线上找 w 的**上升沿**（或最近点）。 */
  const samples = await page.evaluate(async () => {
    const api = window.__svFpMeas;
    const BR = window.SUN_BRIDGE;
    /* 起点取当天 00:00（用 localParts 拿年内 day），保证覆盖完整一条高度角曲线 */
    const p0 = BR.localParts(BR.getSimMs());
    const day0 = Date.UTC(2026, 0, 1) + (p0.doy - 1) * 86400000;
    let base = day0 - new Date().getTimezoneOffset() * 60000;   /* 本地 00:00 */
    base = Math.floor(base / 60000) * 60000;

    const curve = [];
    for (let m = 0; m <= 1440; m += 2) {
      const ms = base + m * 60000;
      BR.setSimMs(ms);
      const g = window.SUNVIEW.geom();
      curve.push({ ms: ms, alt: g.alt, az: g.az });
    }
    const wantAlts = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60];
    const refined = [];
    for (const w of wantAlts) {
      /* 在上升沿找第一个跨越 w 的区间并插值（找不到跨越就取全局最近点） */
      let hit = null;
      for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1], b = curve[i];
        if (a.alt <= w && b.alt > w) {                 /* 上升沿穿过 w */
          const t = (w - a.alt) / (b.alt - a.alt);
          hit = { ms: a.ms + t * (b.ms - a.ms), alt: w, az: a.az + t * (b.az - a.az), via: '上升沿插值' };
          break;
        }
      }
      if (!hit) {                                       /* 该目标整天达不到（夜间或低于最低） */
        let best = curve[0];
        curve.forEach((c) => { if (Math.abs(c.alt - w) < Math.abs(best.alt - w)) best = c; });
        if (Math.abs(best.alt - w) > 0.5) continue;     /* 最近点也差太远 ⇒ 跳过该目标 */
        hit = { ms: best.ms, alt: best.alt, az: best.az, via: '最近点' };
      }
      hit.target = w;
      refined.push(hit);
    }
    return { refined: refined, maxAlt: Math.max.apply(null, curve.map((c) => c.alt)),
             minAlt: Math.min.apply(null, curve.map((c) => c.alt)) };
  });

  console.log('\n  当天高度角范围：%s° … %s°', samples.minAlt.toFixed(2), samples.maxAlt.toFixed(2));
  console.log('  目标高度角 → 实际找到的时刻：');
  samples.refined.forEach((s) => console.log('    目标 %s°  实际 %s°  (az %s°, %s)',
    String(s.target).padStart(4), s.alt.toFixed(4), s.az.toFixed(2), s.via));
  const sampleList = samples.refined;

  /* 逐个时刻等渲染帧落地，读取 updateMeas 实际画出来的影长 */
  const rows = [];
  for (const s of sampleList) {
    const r = await page.evaluate(async (ms) => {
      window.SUN_BRIDGE.setSimMs(ms);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const api = window.__svFpMeas;
      const rec = api.measRec;
      const g = window.SUNVIEW.geom();
      if (!rec || !rec.grp.visible || rec.L == null) return { skip: true, alt: g.alt, visible: rec ? rec.grp.visible : null };
      const bld = api.props.find((o) => o.userData && o.userData.kind === 'building');
      const H = rec.H;
      /* 理论影长：H / tan(alt)。alt 以弧度算。 */
      const theory = H / Math.tan(Math.max(1e-9, g.alt * Math.PI / 180));
      /* 线段起点是否 = 屋顶远角（校验 roofApexOf 单次调用的同源性） */
      const foot = rec.seg;
      const roof = rec.roof;
      return {
        alt: g.alt, az: g.az, H: H, L: rec.L, Lid: rec.Lideal, tMax: rec.tMax, up: rec.up,
        theory: theory,
        clamped: rec.L < rec.Lideal - 1e-6,
        clampedBy: rec.L >= rec.tMax - 1e-6 ? 'tMax/SHADOW_MAX' : null,
        /* 影尖半径（不应超出地平圈） */
        tipR: Math.hypot(foot.x1, foot.z1),
        footR: Math.hypot(foot.x0, foot.z0),
        /* 起点与屋顶掠过点一致？ */
        footIsRoof: Math.abs(foot.x0 - roof.x) < 1e-4 && Math.abs(foot.z0 - roof.z) < 1e-4,
        /* 影子方向应 = 太阳水平反向 */
        segDX: foot.x1 - foot.x0, segDZ: foot.z1 - foot.z0,
        castShadow: api.sunLight.castShadow,
        bldRotY: bld ? bld.rotation.y : null
      };
    }, s.ms);
    if (!r.skip) rows.push(r);
    await page.screenshot({ path: path.join(SHOTS, 'v53_task3_alt' + String(s.target).replace('.', '_') + '.png') });
  }

  console.log('\n  ── 影长数值表（建筑已旋转 rotY=%s°，检验方向闭合）──', rows.length ? rows[0].bldRotY.toFixed(3) : 'n/a');
  console.log('     高度角°     H      L(实画)   H/tan(alt)   tMax/SHADOW_MAX   影尖半径   起点=屋顶   castShadow   判定');
  rows.forEach((r) => {
    const dev = Math.abs(r.L - r.theory);
    console.log(
      '  ' + r.alt.toFixed(4).padStart(9) +
      r.H.toFixed(2).padStart(8) +
      r.L.toFixed(3).padStart(11) +
      r.theory.toFixed(3).padStart(13) +
      r.tMax.toFixed(2).padStart(17) +
      r.tipR.toFixed(2).padStart(11) +
      (r.footIsRoof ? '   yes   ' : '   NO    ') +
      String(r.castShadow).padStart(13) +
      '   ' + (r.clamped ? ('被夹取(' + r.clampedBy + ') 偏差 ' + dev.toFixed(3)) : ('未夹取 偏差 ' + dev.toFixed(4))));
  });

  /* ---- 断言 1：影长随高度角降低**单调递增**（高度角越低影子越长）----
     sorted 已按高度角**从高到低**排好，因此 L 必须**递增**（后一项 ≥ 前一项）。
     ★ 影长物理上会**饱和**：影子触到地平圈（SHADOW_MAX）就不再增长，
       L = min(H/tan(alt), tMax)。所以「饱和段」允许平台，但绝不允许**回落**。
       旧代码的 bug 是两段都变成死平台：0.35° 下限让低高度角段长度不变、
       GSIZE=44 让中高高度角段被提前截断 —— 判据就是「饱和段是否铺得太早」。 */
  const sorted = rows.slice().sort((a, b) => b.alt - a.alt);   /* 高度角从高到低 */
  let mono = true, worst = '';
  for (let i = 1; i < sorted.length; i++) {
    const hi = sorted[i - 1], lo = sorted[i];
    if (lo.L < hi.L - 1e-6) {              /* 高度角更低反而更短 ⇒ 违反物理，判失败 */
      mono = false; worst = 'alt ' + hi.alt.toFixed(3) + '°→' + lo.alt.toFixed(3) +
        '° 时 L 从 ' + hi.L.toFixed(3) + ' 变成 ' + lo.L.toFixed(3);
      break;
    }
  }
  ok(mono, '影长随太阳高度角降低**单调变长**（允许触地平圈后饱和，但无回落 / 无 0.35° 冻住）' +
     (worst ? ' —— ' + worst : ''));

  /* ---- 断言 1b：单调性必须**真实覆盖一段范围**（旧代码在低高度角是常数）----
     旧实现在 alt ≤ 0.35° 时 L 恒定；新实现里 L 必须随 alt 明显变化。 */
  const freeNow = rows.filter((r) => !r.clamped);
  if (freeNow.length >= 2) {
    const lmax = Math.max.apply(null, freeNow.map((r) => r.L));
    const lmin = Math.min.apply(null, freeNow.map((r) => r.L));
    const altSpan = Math.abs(freeNow[0].alt - freeNow[freeNow.length - 1].alt);
    ok((lmax - lmin) > 0.5 && altSpan > 5,
       '未饱和段影长随高度角**真实变化**（L 从 ' + lmin.toFixed(2) + ' 变到 ' + lmax.toFixed(2) +
       ' m，跨越 ' + altSpan.toFixed(1) + '° 高度角）—— 排除「影长冻住」');
  } else {
    ok(false, '未饱和样本不足 2 个，无法验证影长随高度角变化（实际 ' + freeNow.length + ' 个）');
  }

  /* ---- 断言 1c：与**旧实现**逐点对比，证明改动确实修掉了「异常变短」----
     旧实现：L_old = min(H / tan(clamp(alt,0.35,89.5)), tMax, GSIZE=44)。
     在下表每个高度角上算出 L_old，并列出「旧值 vs 新值」，直观看出旧值在何处偏短。 */
  const GSIZE_OLD = geomInfo.GSIZE;
  console.log('\n  ── 新旧实现对比（旧 = tan 夹 0.35° 下限 + L 夹 GSIZE=%s）──', GSIZE_OLD);
  console.log('     高度角°     L_新      L_旧      新/旧    说明');
  rows.forEach((r) => {
    const upOld = Math.max(1e-3, Math.tan(Math.min(Math.max(r.alt, 0.35), 89.5) * Math.PI / 180));
    const Lold = Math.min(r.H / upOld, r.tMax, GSIZE_OLD);
    const ratio = Lold > 1e-9 ? r.L / Lold : Infinity;
    const note = Math.abs(ratio - 1) < 1e-3 ? '一致'
      : (ratio > 1.05 ? '旧值偏短 ' + ((ratio - 1) * 100).toFixed(0) + '%（本次修复）'
                      : '旧值偏长');
    console.log('  ' + r.alt.toFixed(4).padStart(9) + r.L.toFixed(3).padStart(11) +
      Lold.toFixed(3).padStart(11) + (ratio === Infinity ? '   inf' : ratio.toFixed(3).padStart(8)) +
      '   ' + note);
  });
  /* 至少要有若干点「旧值明显偏短」，否则说明这次修复没覆盖到真问题 */
  const improved = rows.filter((r) => {
    const upOld = Math.max(1e-3, Math.tan(Math.min(Math.max(r.alt, 0.35), 89.5) * Math.PI / 180));
    const Lold = Math.min(r.H / upOld, r.tMax, GSIZE_OLD);
    return Lold > 1e-9 && r.L / Lold > 1.05;
  }).length;
  ok(improved >= 3, '有 ' + improved + ' 个高度角上「旧实现明显偏短」（≥3），证明修复命中了「物影异常变短」');

  /* ---- 断言 1c：饱和段应稳定在 SHADOW_MAX（而非旧代码的 GSIZE=44）---- */
  const satRows = rows.filter((r) => r.clamped);
  if (satRows.length) {
    const satR = satRows.map((r) => r.tipR);
    ok(Math.max.apply(null, satR) > geomInfo.GSIZE + 5,
       '饱和段影尖半径 ' + Math.max.apply(null, satR).toFixed(2) +
       ' m 明显超过旧 GSIZE=' + geomInfo.GSIZE + '（证明 GSIZE 截断已解除）');
  }

  /* ---- 断言 2：未被夹取的区间，L 与 H/tan(alt) 吻合（误差 < 0.5%）---- */
  const free = rows.filter((r) => !r.clamped);
  console.log('\n  未夹取样本数：%d / %d', free.length, rows.length);
  ok(free.length >= 4, '存在足够多「未被夹取」的样本用于核对 H/tan(alt)（至少 4 个）');
  let maxRel = 0, maxRelRow = null;
  free.forEach((r) => {
    const rel = Math.abs(r.L - r.theory) / Math.max(1e-9, r.theory);
    if (rel > maxRel) { maxRel = rel; maxRelRow = r; }
  });
  ok(maxRel < 0.005, '未夹取区间 L 与 H/tan(alt) 最大相对误差 ' + (maxRel * 100).toFixed(4) + '%' +
     (maxRelRow ? '（alt=' + maxRelRow.alt.toFixed(3) + '°）' : ''));

  /* ---- 断言 3：影尖不越地平圈；起点严格 = 屋顶远角 ---- */
  ok(rows.every((r) => r.tipR <= geomInfo.SHADOW_MAX + 1e-3),
     '影尖始终在 SHADOW_MAX 内（' + Math.max.apply(null, rows.map((r) => r.tipR)).toFixed(2) + ' ≤ ' + geomInfo.SHADOW_MAX.toFixed(2) + '）');
  ok(rows.every((r) => r.footIsRoof), '影长线段起点严格 = 屋顶远角（与掠顶光线同源，旋转后仍闭合）');

  /* ---- 断言 4：影子方向 = 太阳方位角的水平反向 ---- */
  /* dirOf 约定：指向太阳的单位向量 = (cos(alt)·sin(az), sin(alt), −cos(alt)·cos(az))，
     故其水平分量为 (sin(az), −cos(az))，影子方向必须是它的**反向** (−sin(az), +cos(az))。 */
  const dirOK = rows.every((r) => {
    const a = r.az * Math.PI / 180;
    const ux = -Math.sin(a), uz = Math.cos(a);     /* 影子方向 = 太阳水平反向 */
    const len = Math.hypot(r.segDX, r.segDZ) || 1;
    const dot = (r.segDX / len) * ux + (r.segDZ / len) * uz;
    return dot > 0.9999;
  });
  ok(dirOK, '影长线段方向 = 太阳方位角水平反向（各高度角方向一致性 dot>0.9999）');

  /* ---- 断言 5：castShadow 与线段显示门槛一致（无「有阴影无线段」）---- */
  const gateOK = rows.every((r) => (r.castShadow ? r.alt > geomInfo.SHADOW_MIN_ALT : r.alt <= geomInfo.SHADOW_MIN_ALT));
  ok(gateOK, 'castShadow 门槛与线段显示门槛统一为 SHADOW_MIN_ALT=' + geomInfo.SHADOW_MIN_ALT + '°（无错配区间）');

  /* 低高度角特写截图 */
  const lowRow = rows.reduce((a, b) => (b.alt < a.alt ? b : a), rows[0]);
  if (lowRow) {
    await page.evaluate((ms) => { window.SUN_BRIDGE.setSimMs(ms); }, sampleList.find((s) => Math.abs(s.alt - lowRow.alt) < 1e-6)?.ms || sampleList[0].ms);
    await waitFrames(page, 6);
    await page.screenshot({ path: path.join(SHOTS, 'v53_task3_lowalt_hero.png') });
    console.log('\n  低高度角特写：alt=' + lowRow.alt.toFixed(3) + '°  L=' + lowRow.L.toFixed(2) + 'm  → _shots/v53_task3_lowalt_hero.png');
  }

  fs.writeFileSync(path.join(SHOTS, '_meas_samples.json'),
    JSON.stringify({ geom: geomInfo, samples: samples, rows: rows }, null, 1));

  /* ================================================================
     任务二：多小人 —— 双击离原点最远的那个，以它为第一视角
     ================================================================ */
  hr('任务二：多小人场景双击某小人即以该人为中心进入第一视角');

  /* 放 3 个小人：一个在中心（= figObj），两个偏移，其中一个明显最远 */
  const placed = await page.evaluate(() => {
    const api = window.__svFpMeas;
    const figs = api.props.filter((o) => o.userData && o.userData.kind === 'figure');
    if (figs.length < 1) return { ok: false, why: 'no figure' };
    /* 中心那个（figObj）保持在原点附近，作为「不应被误挪」的对照 */
    api.figObj.position.set(0, 0, 0);
    /* 找两个 props 里非 figObj 的小人；不够就复制一个 */
    let others = figs.filter((o) => o !== api.figObj);
    return { ok: true, total: figs.length, others: others.length, figObjId: api.figObj.userData.id };
  });
  console.log('  初始小人：', JSON.stringify(placed));

  /* 用「增加小人」按钮 + 落点的方式不可靠（需真实指针事件），改为直接用场景 API 造人：
     通过 __svFpMeas 暴露的 props 找到非 figObj 的小人并摆位。若场景里只有 figObj 一个，
     就用菜单的「添加小人」按钮走 UI 路径。 */
  const multi = await page.evaluate(async () => {
    const api = window.__svFpMeas;
    const S = window.SUNVIEW._S();
    /* 清掉可能残留的第一视角 / 测量态 */
    if (S.fp) api.exitFP();
    /* 收集全部 figure */
    let figs = api.props.filter((o) => o.userData && o.userData.kind === 'figure');
    const figObj = api.figObj;
    /* 至少要 3 个：中心 = figObj，另外两个偏移。若不足，用 makeFigure 造不出来（未暴露），
       于是走 UI：点「添加小人」按钮 → 在画布上落点。 */
    const btn = document.getElementById('svFigAdd');
    const cs = Array.from(document.querySelectorAll('canvas'));
    const canvas = cs.find((x) => { const rr = x.getBoundingClientRect(); return rr.width > 400 && rr.height > 300; }) || cs[0];
    function addAt(cx, cy) {
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 71 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 71 }));
    }
    const r = canvas.getBoundingClientRect();
    /* 先确保 figObj 在中心 */
    figObj.position.set(0, 0, 0);
    /* 通过 UI 放两个：一个在近处，一个在远处（屏幕上尽量分开、且避开左侧菜单面板） */
    const spots = [[0.34, 0.72], [0.72, 0.34], [0.55, 0.80]];
    for (const [fx, fy] of spots) {
      addAt(r.left + r.width * fx, r.top + r.height * fy);
      await new Promise((res) => requestAnimationFrame(res));
      if (api.props.filter((o) => o.userData && o.userData.kind === 'figure').length >= 3) break;
    }
    figs = api.props.filter((o) => o.userData && o.userData.kind === 'figure');
    /* 场景坐标是一维轴对齐限幅（±GSIZE/2），这里手动把几个小人错开到不同半径，
       确保「离原点最远」那个是明确的第三方，而不是刚放下的近处那个。 */
    const extras = figs.filter((o) => o !== figObj);
    const offs = [[13, -9], [-14, 6], [8, 12]];
    extras.forEach((o, i) => { const p = offs[i % offs.length]; o.position.set(p[0], 0, p[1]); });
    await new Promise((res) => requestAnimationFrame(res));
    figs = api.props.filter((o) => o.userData && o.userData.kind === 'figure');
    return {
      count: figs.length,
      list: figs.map((o) => ({ id: o.userData.id, x: +o.position.x.toFixed(3), z: +o.position.z.toFixed(3),
                              r: +Math.hypot(o.position.x, o.position.z).toFixed(3), isFigObj: o === figObj })),
      figObjPos: { x: figObj.position.x, z: figObj.position.z }
    };
  });
  console.log('  放置后小人清单：', JSON.stringify(multi, null, 1));

  ok(multi.count >= 3, '场景里已有 ≥3 个小人（多小人场景）');

  /* 找离原点最远的小人 */
  const target = multi.list.slice().sort((a, b) => b.r - a.r)[0];
  console.log('  离原点最远的小人：', JSON.stringify(target));
  ok(target && !target.isFigObj && target.r > 3,
     '最远小人不是中心 figObj，且距离明显（r=' + (target ? target.r : 'n/a') + '）');

  /* 通过 UI 真实双击该小人 → 菜单点「第一视角」 */
  const fpResult = await page.evaluate(async (tid) => {
    const api = window.__svFpMeas;
    const figs = api.props.filter((o) => o.userData && o.userData.kind === 'figure');
    const t = figs.find((o) => o.userData.id === tid);
    if (!t) return { ok: false, why: 'target not found' };
    /* 直接调用 openObjMenu 对应的流程：这里用 enterFP(host) 模拟菜单点击后的效果，
       同时额外验证「菜单项确实传了 host」—— 读源码语义即可，但为了实测菜单路径，
       优先真的点 DOM 菜单。 */
    /* 找到该小人的屏幕位置：把世界坐标投影到 gCam */
    const cam = api.gCam;
    const cs2 = Array.from(document.querySelectorAll('canvas'));
    const canvas = cs2.find((x) => { const rr = x.getBoundingClientRect(); return rr.width > 400 && rr.height > 300; }) || cs2[0];
    const r = canvas.getBoundingClientRect();
    const v = new api.THREE.Vector3(t.position.x, 1.0, t.position.z);
    v.project(cam);
    const sx = r.left + (v.x * 0.5 + 0.5) * r.width;
    const sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
    return { ok: true, sx, sy, target: { x: t.position.x, z: t.position.z, id: t.userData.id } };
  }, target.id);

  console.log('  目标屏幕坐标：', JSON.stringify(fpResult));
  await page.screenshot({ path: path.join(SHOTS, 'v53_task2_before.png') });

  /* 真实双击（playwright dblclick）→ 菜单出现 → 点「第一视角」 */
  const beforePos = await page.evaluate(() => {
    const api = window.__svFpMeas;
    return { fpHost: api.fpHost ? api.fpHost.userData.id : null,
             figObj: { x: api.figObj.position.x, z: api.figObj.position.z } };
  });

  await page.mouse.dblclick(fpResult.sx, fpResult.sy);
  await waitFrames(page, 4);
  await page.screenshot({ path: path.join(SHOTS, 'v53_task2_menu.png') });

  const menuHasFp = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#svObjMenu button')).map((b) => b.textContent.trim());
    return { items: items, on: document.getElementById('svObjMenu').classList.contains('on') };
  });
  console.log('  弹出菜单项：', JSON.stringify(menuHasFp.items));
  ok(menuHasFp.items.indexOf('第一视角') >= 0, '双击小人弹出菜单含「第一视角」');

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#svObjMenu button')).find((x) => x.textContent.trim() === '第一视角');
    if (b) b.click();
  });
  await waitFrames(page, 6);

  const afterPos = await page.evaluate(() => {
    const api = window.__svFpMeas;
    const S = window.SUNVIEW._S();
    return {
      fp: S.fp,
      fpHostId: api.fpHost ? api.fpHost.userData.id : null,
      fpHostVisible: api.fpHost ? api.fpHost.visible : null,
      fpHostPos: api.fpHost ? { x: +api.fpHost.position.x.toFixed(4), z: +api.fpHost.position.z.toFixed(4) } : null,
      camPos: { x: +api.fpPos.x.toFixed(4), z: +api.fpPos.z.toFixed(4) },
      figObj: { x: +api.figObj.position.x.toFixed(4), z: +api.figObj.position.z.toFixed(4) },
      figObjVisible: api.figObj.visible
    };
  });
  console.log('  进入第一视角后：', JSON.stringify(afterPos, null, 1));
  console.log('  进入前：', JSON.stringify(beforePos));

  ok(afterPos.fp === true, '已进入第一视角（S.fp === true）');
  ok(afterPos.fpHostId === target.id, '视点小人 fpHost === 被双击的那个小人（id ' + target.id + '）');
  ok(Math.abs(afterPos.camPos.x - target.x) < 1e-3 && Math.abs(afterPos.camPos.z - target.z) < 1e-3,
     '相机站位 = 被双击小人的位置 (' + target.x + ', ' + target.z + ')');
  ok(afterPos.fpHostVisible === false, '视点小人已隐藏（不挡镜头）');
  ok(Math.abs(afterPos.figObj.x - beforePos.figObj.x) < 1e-6 && Math.abs(afterPos.figObj.z - beforePos.figObj.z) < 1e-6,
     '中心小人 figObj **未被误挪**（位置不变：' + afterPos.figObj.x + ', ' + afterPos.figObj.z + '）');
  ok(afterPos.figObjVisible === true, '中心小人 figObj 保持可见（不再被无条件隐藏）');

  await page.screenshot({ path: path.join(SHOTS, 'v53_task2_fp_host.png') });

  /* WASD 反向同步：按 W 若干帧，视点小人应跟着走；中心小人不动 */
  const walk = await page.evaluate(async () => {
    const api = window.__svFpMeas;
    const p0 = { x: api.fpPos.x, z: api.fpPos.z };
    const f0 = { x: api.figObj.position.x, z: api.figObj.position.z };
    /* 直接驱动：模拟按住 W —— 走 updateFP 用的同一份 fpKeys */
    const ev = (type, key) => document.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true }));
    ev('keydown', 'w');
    await new Promise((res) => { let n = 0; (function f() { if (n++ > 40) return res(); requestAnimationFrame(f); })(); });
    ev('keyup', 'w');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return {
      p0: p0, p1: { x: api.fpPos.x, z: api.fpPos.z },
      host1: { x: api.fpHost.position.x, z: api.fpHost.position.z },
      fig0: f0, fig1: { x: api.figObj.position.x, z: api.figObj.position.z }
    };
  });
  console.log('  WASD 行走：', JSON.stringify(walk));
  const moved = Math.hypot(walk.p1.x - walk.p0.x, walk.p1.z - walk.p0.z);
  ok(moved > 0.2, '按 W 后视点移动了 ' + moved.toFixed(3) + ' m');
  ok(Math.hypot(walk.host1.x - walk.p1.x, walk.host1.z - walk.p1.z) < 1e-6,
     '反向同步：视点小人与 fpPos 完全一致');
  ok(Math.hypot(walk.fig1.x - walk.fig0.x, walk.fig1.z - walk.fig0.z) < 1e-9,
     '中心小人在视点行走时**未被反向同步**（保持原位）');

  await page.screenshot({ path: path.join(SHOTS, 'v53_task2_after_walk.png') });

  /* 退出第一视角：视点小人应恢复可见，fpHost 清空。
     ★ 必须在 exitFP **之前**抓住那个对象的引用 —— exitFP 里会把 fpHost 置 null，
       退出后再去读 api.fpHost.visible 只会读到 null（曾因此误判 FAIL）。 */
  const exited = await page.evaluate(async () => {
    const api = window.__svFpMeas;
    const host = api.fpHost;                        /* 退出前先取引用 */
    const wasHidden = host ? !host.visible : null;
    api.exitFP();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return {
      fpHostCleared: api.fpHost === null,
      hostId: host ? host.userData.id : null,
      wasHiddenBeforeExit: wasHidden,
      hostVisibleAfterExit: host ? host.visible : null,   /* 读取引用本身，而不是已被清空的 fpHost */
      fp: window.SUNVIEW._S().fp
    };
  });
  console.log('  退出后：', JSON.stringify(exited));
  ok(exited.fp === false, '已退出第一视角');
  ok(exited.fpHostCleared, '退出后 fpHost 已清空');
  ok(exited.wasHiddenBeforeExit === true && exited.hostVisibleAfterExit === true,
     '视点小人在退出时由「隐藏」恢复为「可见」');

  await page.screenshot({ path: path.join(SHOTS, 'v53_task2_exited.png') });

  fs.writeFileSync(path.join(SHOTS, '_fp_multi.json'),
    JSON.stringify({ placed: placed, multi: multi, target: target, fpResult: fpResult,
                     before: beforePos, after: afterPos, walk: walk, exited: exited }, null, 1));

  /* ================================================================ */
  hr('页面运行时错误');
  /* app.js:12268 的 `gReg.then` 是**既有 bug，与本轮改动无关**（不在 sunview.js 里）：
       Promise.all([...]) 返回的 r[4] 已经是**贴图对象**（loadTex 的 Promise 早已 resolve），
       再对贴图调 .then 必然 TypeError。该文件属地球侧主模块，本轮明确不修改，
       故在此**单列**而不计入本轮 PASS/FAIL。 */
  const KNOWN = /gReg\.then is not a function|贴图装载失败/;
  const known = pageErrors.filter((e) => KNOWN.test(e));
  const real = pageErrors.filter((e) => !KNOWN.test(e));
  if (known.length) {
    console.log('  [已知·既有·非本轮] ' + known.length + ' 条：');
    known.slice(0, 5).forEach((e) => console.log('      ' + e.split('\n')[0]));
  }
  real.slice(0, 20).forEach((e) => console.log('  ' + e));
  ok(real.length === 0, '无本轮改动引入的运行时错误（排除 app.js 既有 bug 后共 ' + real.length + ' 条）');

  await browser.close();
  hr('验证结束' + (process.exitCode ? '（存在 FAIL，见上）' : '（全部 PASS）'));
})().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
