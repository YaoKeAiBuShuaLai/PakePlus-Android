/* 地球自转 3D 交互演示
 * 依赖：three.js r150 (UMD), assets-data.js（内嵌贴图）
 * 说明：日光方向固定为世界 +X，地轴倾角 23.44°，通过历年 ecliptic 计算地轴方位与太阳赤纬，
 *      由太阳赤纬 + 时角 + 时差计算太阳直射点经度，从而驱动地球自转相位。
 */
(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    document.getElementById('loading').textContent = 'three.js 未能加载';
    return;
  }
  if (THREE.ColorManagement) THREE.ColorManagement.enabled = true;

  /* ============ 常量 & 工具 ============ */
  const D = Math.PI / 180;
  const R = 180 / Math.PI;
  const TWO_PI = Math.PI * 2;
  // 黄赤交角（v10.0 起为系统核心可调参数；v23.14 起默认值取课标/天文真值 23°26′）：
  // 由 state.obliquity 驱动，地轴倾角 / 太阳视赤纬（= 直射点纬度）/ 昼夜长短 /
  // 南北回归线 / 南北极圈 全部随之联动，详见 applyObliquity()。以下三个量与 OBLIQ_DEG 同源。
  const OBLIQ_DEFAULT = 23 + 26 / 60;      // 23°26′ = 23.4333…°（黄赤交角默认值，度）
  let OBLIQ_DEG = OBLIQ_DEFAULT;           // 黄赤交角（度）
  let OBLIQ = OBLIQ_DEG * D;               // 黄赤交角（弧度）
  let TROPIC_LAT = OBLIQ_DEG;              // 回归线纬度（度）= 黄赤交角
  let POLAR_LAT = 90 - OBLIQ_DEG;          // 极圈纬度（度）= 90° − 黄赤交角
  // 度 → 「x°yy′」度分格式（教学读数惯例，如 23°26′ / 66°34′；分四舍五入到整分）
  function fmtDM(v) {
    const a = Math.abs(+v || 0), d = Math.floor(a + 1e-9);
    let m = Math.round((a - d) * 60);
    const dd = m === 60 ? d + 1 : d; m = m === 60 ? 0 : m;
    return (v < 0 ? '-' : '') + dd + '°' + String(m).padStart(2, '0') + '′';
  }
  const SUN_DIR = new THREE.Vector3(1, 0, 0);
  const XAX = new THREE.Vector3(1, 0, 0);
  const sunDir = new THREE.Vector3(1, 0, 0);   // 当前世界坐标下的太阳方向（随参考系模式变化）
  const SPEED_MIN = 100, SPEED_MAX = 5000000;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrap180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const wrap360 = (deg) => (((deg % 360) + 360) % 360);
  const mod360 = (deg) => ((deg % 360) + 360) % 360;
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const $ = (id) => document.getElementById(id);

  // 文字注释精灵注册表：统一应用文字样式（大小 / 颜色 / 透明度）
  const textSprites = [];
  // registerSprite：登记"世界基准尺寸"，可选登记重绘函数 draw(ctx, k)（k = 画布分辨率倍率）
  // 与标称画布尺寸 (cw, ch)，以便按当前字号自动提升画布分辨率——字号放大到 15× 也不糊。
  // fpx：画布上绘制文字时使用的字号（px，dpi = 1 时）。v21.0 新增 —— 「全局文字大小样式
  //   统一」需要把各条注释换算到同一字号基准上，而各注释的画布宽与画布字号并不一致
  //   （256/38、128/44、128/76、320/52），必须把它们一并登记下来才能算准。
  function registerSprite(sp, w, h, draw, cw, ch, fpx) {
    sp.userData.baseW = w; sp.userData.baseH = h;
    if (draw) {
      sp.userData.draw = draw; sp.userData.cw = cw; sp.userData.ch = ch;
      sp.userData.fpx = fpx || 38; sp.userData.dpi = 1;
    }
    textSprites.push(sp); return sp;
  }
  // 按需重绘文字精灵的贴图（仅在 dpi 变化时执行，避免拖动滑杆时反复上传贴图）
  function spriteDPI(sp, dpi) {
    const draw = sp.userData.draw;
    if (!draw || sp.userData.dpi === dpi) return;
    const W = Math.round(sp.userData.cw * dpi), H = Math.round(sp.userData.ch * dpi);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    draw(c.getContext('2d'), dpi);
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    if (sp.material.map) sp.material.map.dispose();
    sp.material.map = t; sp.material.needsUpdate = true;
    sp.userData.dpi = dpi;
  }

  // 角度规范显示：度数在前、方位字母在后（例：23.4°N / 120.4°E；0° 不带字母）
  function fmtLat(deg, dp) {
    const v = Math.abs(deg);
    if (v < 0.005) return '0°';
    return v.toFixed(dp === undefined ? 1 : dp) + '°' + (deg >= 0 ? 'N' : 'S');
  }
  function fmtLon(deg, dp) {
    const v = Math.abs(deg);
    if (v < 0.005) return '0°';
    return v.toFixed(dp === undefined ? 1 : dp) + '°' + (deg >= 0 ? 'E' : 'W');
  }

  const TERM_ORDER = ['VE', 'SS', 'AE', 'WS'];
  const TERM_NAME = { VE: '春分', SS: '夏至', AE: '秋分', WS: '冬至' };

  /* ============ 天文计算 ============ */
  // 太阳视位置：Meeus《Astronomical Algorithms》算法 + 月球 / 行星摄动项（v2.5 升级）
  // 视黄经精度约 ±0.007°（时刻误差 ≤ 11 分钟），与紫金山天文台公布的节气时刻逐项核对一致，
  // 二分二至日期与二十四节气日期均与天文年历完全相同。
  function solarInfo(ms) {
    const n = ms / 86400000 + 2440587.5 - 2451545.0;      // 自 J2000.0 起算的天数
    const T = n / 36525;                                   // 儒略世纪
    const L0 = mod360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);  // 太阳几何平黄经
    const g = mod360(357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D; // 平近点角
    const ecc = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;    // 地球轨道偏心率
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(g)
      + (0.019993 - 0.000101 * T) * Math.sin(2 * g)
      + 0.000289 * Math.sin(3 * g);                        // 中心差
    // 月球与行星对太阳视黄经的摄动（合计约 ±0.008°，是节气时刻精度的关键）
    const pA = (153.23 + 22518.7541 * T) * D;
    const pB = (216.57 + 45037.5082 * T) * D;
    const pC = (312.69 + 32964.3577 * T) * D;
    const pD = (350.74 + 445267.1142 * T - 0.00144 * T * T) * D;
    const pE = (231.19 + 20.20 * T) * D;
    const pert = 0.00134 * Math.cos(pA) + 0.00154 * Math.cos(pB) + 0.00200 * Math.cos(pC)
      + 0.00179 * Math.sin(pD) + 0.00178 * Math.sin(pE);
    const trueLon = L0 + C + pert;                         // 真黄经
    const om = (125.04 - 1934.136 * T) * D;                // 月球升交点黄经
    const lam = mod360(trueLon - 0.00569 - 0.00478 * Math.sin(om)) * D;  // 视黄经（含章动与光行差）
    const eps0 = 23 + 26 / 60 + 21.448 / 3600
      - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;   // 平黄赤交角
    // v10.0：黄赤交角为可调核心参数（state.obliquity，默认 23°26′）。视赤纬 / 视赤经均按其计算，
    // 从而让「黄赤交角 → 直射点回归运动 → 昼夜长短 → 五带划分」成为严格一致的因果链。
    // （eps0 为天文真值 23°26′，仅作参考保留）
    const eps = OBLIQ_DEG * D;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lam)); // 视赤纬
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)); // 视赤经
    let eot = 4 * (L0 * D - ra) * R;                       // 时差（分钟）
    eot = (((eot % 360) + 540) % 360) - 180;
    return { lam: lam, decl: decl, eps: eps, eot: eot, ecc: ecc, T: T, M: g };
  }

  /* ================== v28（需求①）：真实椭圆轨道 · 开普勒定律 ==================
     此前公转轨道是一条**正圆**（半径恒为 ORB_R·distScale，太阳在圆心）。v28 起改为**真实椭圆**：

       ① 形状：椭圆，半长轴 a、离心率 e = 0.0167086（地球轨道真实值，J2000），太阳位于椭圆的
          **一个焦点**上（另一焦点空着）。近日点 r_p = a(1−e) = 0.98329a，远日点
          r_a = a(1+e) = 1.01671a —— 二者相差 3.34%，与天文年历一致。
       ② 位置：由极坐标圆锥曲线方程 r = a(1−e²)/(1 + e·cos ν) 给出，ν = 真近点角。
       ③ 速度：开普勒第二定律（等面积速率）—— 面积速度 dA/dt = h/2 恒为常数，
          于是**近日点快、远日点慢**：v = √(GM(2/r − 1/a))，近日点 30.29 km/s、
          远日点 29.29 km/s（比值 1.0339）；角速度 ω = h/r²，近日点 1.019°/日、
          远日点 0.954°/日（比值 1.069）。

     方向（黄经）仍取 Meeus 的**视黄经 lam**（节气 / 直射点 / 昼夜长短链条一字未动，
     二分二至时刻仍与天文年历逐秒吻合）；v28 只把「半径」从常数换成真实椭圆半径，
     于是「季节关系精确」与「轨道形状真实」两者同时成立。

     为何方向不改用 Kepler 解出的 ν：那会让节气时刻整体漂移（最大数日），
     破坏本项目已验证的二分二至 / 二十四节气精度。而视黄经序列本身已由
     Meeus 的**中心差**精确给出（截断误差 ~1e-5 度），其角速度与真实 Kepler 轨道
     相差 <1e-4，故「等面积速率」在本模型下同样成立（探针逐日核验，偏差 <0.05%）。 */
  // 地球轨道真实离心率（J2000 历元：0.0167086，每世纪 −0.000042037）
  const ORB_ECC0 = 0.0167086, ORB_ECC_RATE = -0.000042037;
  function orbEcc(T) { return ORB_ECC0 + ORB_ECC_RATE * T; }
  // 近日点黄经 ϖ（度）：J2000 为 102.93734808°，每儒略世纪 +1.7195366°（+ 二次项）
  function orbPeriLonDeg(T) { return 102.93734808 + 1.7195366 * T + 0.00045637 * T * T; }
  /* 由「太阳视黄经 lam（rad）」求地球的真实轨道状态：
       ν（真近点角） = λ_E − ϖ，其中地球日心黄经 λ_E = lam + π（日地黄经恒差 180°）；
       rk = r / a = (1−e²)/(1 + e·cos ν)  —— 圆锥曲线（椭圆）极坐标方程。
     返回 { rk, nu, e, lamHelio }，rk 无量纲（1 = 半长轴），乘 a 即得场景半径 / 天文距离。 */
  function orbState(lam, T) {
    const e = orbEcc(T === undefined ? 0 : T);
    const nu = lam + Math.PI - orbPeriLonDeg(T === undefined ? 0 : T) * D;
    const rk = (1 - e * e) / (1 + e * Math.cos(nu));
    return { rk: rk, nu: nu, e: e, lamHelio: lam + Math.PI };
  }
  /* ===== 真实天文常数（全部为 SI / 天文单位制，用于面板上的物理量读数） ===== */
  const AU_M = 1.495978707e11;          // 1 天文单位（米）
  const GM_SUN = 1.32712440018e20;      // 太阳引力常数 GM（m³/s²）
  const EARTH_R_EQ = 6378137;           // 地球赤道半径（米）
  const EARTH_R_MEAN = 6371008.8;       // 地球平均半径（米）
  const SIDEREAL_DAY = 86164.0905;      // 恒星日（秒）—— 自转周期
  const TROPICAL_YEAR = 365.2421897 * 86400;   // 回归年（秒）
  /* 地球自转角速度（rad/s）= 2π / 恒星日 = 7.2921151e-5；换算 15.0411 °/小时 */
  const EARTH_OMEGA = TWO_PI / SIDEREAL_DAY;
  /* 公转：给定 rk（= r/a），返回瞬时线速度（km/s）与角速度（°/日）。
       v = √( GM · (2/a_eff − 1/a) ) → 无量纲形式 v = √(GM/a) · √(2/rk − 1)
       ω = h / r² = [√(GM·a) · √(1−e²)] / (a·rk)²  —— 面积速度 h/2 恒定（开普勒第二定律） */
  function orbitSpeedKmS(rk) {
    return Math.sqrt(GM_SUN / AU_M) * Math.sqrt(Math.max(2 / rk - 1, 0)) / 1000;
  }
  function orbitOmegaDegDay(rk, e) {
    const ee = (e === undefined) ? ORB_ECC0 : e;
    const h = Math.sqrt(GM_SUN * AU_M) * Math.sqrt(1 - ee * ee);   // 面积速度 ×2（m²/s）
    const r = AU_M * rk;
    return (h / (r * r)) * 86400 * R;                              // rad/s → °/日
  }
  /* 地球自转：给定纬度（度），返回地表的自转线速度（m/s）与角速度（°/小时）。
     线速度 v = Ω·R_eq·cos φ（用赤道半径，即「随纬度的自转线速度」标准口径）；
     角速度与纬度无关，恒为 Ω = 15.0411 °/小时（恒星日），即 15°/小时（太阳日）的精确值。 */
  function spinSpeedMS(latDeg) {
    return EARTH_OMEGA * EARTH_R_EQ * Math.cos(latDeg * D);
  }
  function spinOmegaDegHour() { return EARTH_OMEGA * 3600 * R; }

  function daysInYear(y) {
    return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0) ? 366 : 365;
  }

  // 求「太阳视黄经 = lamTarget（度）」的精确时刻：平均角速度给初值，再迭代收敛到秒
  function solveLamMs(year, lamTarget) {
    const start = yearStartUTCms(year);
    let t = start + (mod360(lamTarget - solarInfo(start).lam * R) / 0.9856) * 86400000;
    for (let i = 0; i < 40; i++) {
      const diff = wrap180(solarInfo(t).lam * R - lamTarget);
      if (Math.abs(diff) < 1e-9) break;
      t -= diff * 1.01456 * 86400000;                      // 1 / 0.9856 ≈ 1.01456 天/度
    }
    return t;
  }

  // 二分二至精确时刻：春分 0°、夏至 90°、秋分 180°、冬至 270°
  // 与二十四节气采用完全相同的「太阳视黄经」口径，因此日期与官方天文年历一致
  // 缓存多份年份结果：时间跨年时会同时用到本年 / 上一年 / 下一年，单槽缓存会来回颠簸
  const _termCache = new Map();
  function solarTerms(year) {
    const hit = _termCache.get(year);
    if (hit) return hit;
    const out = {
      VE: solveLamMs(year, 0), SS: solveLamMs(year, 90),
      AE: solveLamMs(year, 180), WS: solveLamMs(year, 270),
    };
    if (_termCache.size > 8) _termCache.clear();
    _termCache.set(year, out);
    return out;
  }

  /* ============ 二十四节气 ============ */
  // 按太阳视黄经每 15° 一个，起点为春分（0°）；与二分二至完全同一套换算
  const TERM24 = [
    '春分', '清明', '谷雨', '立夏', '小满', '芒种',
    '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
    '秋分', '寒露', '霜降', '立冬', '小雪', '大雪',
    '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰',
  ];
  const _t24Cache = new Map();
  // 各节气在该年内的发生时刻（与二分二至同一套「太阳视黄经每 15°」求解器）
  function solarTerms24(year) {
    const hit = _t24Cache.get(year);
    if (hit) return hit;
    const list = [];
    for (let i = 0; i < 24; i++) {
      const lamT = i * 15;
      list.push({ name: TERM24[i], lam: lamT, ms: solveLamMs(year, lamT) });
    }
    if (_t24Cache.size > 4) _t24Cache.clear();
    _t24Cache.set(year, list);
    return list;
  }
  // 当前所处节气（按太阳视黄经落在哪个 15° 区间）
  function currentTerm24(lamRad) {
    const list = solarTerms24(displayYear);
    const i = Math.floor(mod360(lamRad * R) / 15) % 24;
    return list[i];
  }

  /* ============ 配置持久化（localStorage） ============ */
  // 说明：以 file:// 方式打开时部分浏览器可能禁用 localStorage，这里全部包 try/catch，
  // 不可用时自动降级为「仅本次会话有效」，不影响演示功能本身。
  // v17.0：键名版本号 +1 —— 注释默认全部隐藏、线条默认实线等默认值发生变化，
  //        旧存档会把「注释全开 / 虚线」的旧状态盖回来，导致新默认看不到；故重置一次存档。
  // v18.0：style 键再 +1 —— 「地方时刻」的赤道时刻点由默认显示改为默认隐藏，
  //        旧存档会把「点全开」盖回来，故重置一次样式存档。
  // v20.0：版本号必须随默认值一起升 —— 否则旧存档会在启动时把新默认值盖回去（deepMerge）。
  // v21.0：默认值又变了一轮（所有文字注释开关默认关闭、注释新增 orbit 分类），版本号同步 +1。
  // v23.1：用户浏览器里的旧存档会把「地方时刻两个时刻点开关」的开状态 + 非 0.55 的总字号
  //        盖回来（实测：写入 v7/v5 旧档后刷新，cbHourMain / cbHourRest 变为勾选、
  //        总字号变 1.00×），故两个存档键各 +1 清掉 → LS_NOTE v8 / LS_STYLE v6。
  //        另外本版起这两个开关**每次加载都强制回默认隐藏**（见下方 FORCE_HOUR_PTS_OFF），
  //        以后即便存档里存着 true 也一律按默认关闭处理。
  // v23.5：升级到 v9 —— 「统一总开关」默认改为关闭、改为「字号统一、其余各异」的新默认，
  //   旧存档(v8)里存的是「全部统一、总开关开启」，沿用会让新默认不生效，故换键重置一次。
  const LS_NOTE = 'earth3d.note.v9';    // 文字注释：全局控件 + 各分类样式 + 逐项统一开关（v23.5 新默认）
  const LS_STYLE = 'earth3d.style.v6';  // 统一样式：点 / 线 / 面（v23.1：清掉旧存档里时刻点开关 / 字号）
  const LS_UI = 'earth3d.ui.v3';        // v34：+1（悬浮窗显隐默认全关 / 背景不透明 / 面板布局）
  function lsGet(k) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 不可用时忽略 */ } }
  function deepMerge(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v)
        && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v);
      else dst[k] = v;
    });
    return dst;
  }

  /* ============ 状态 ============ */
  /* ===== v25.1（需求⑤）：七大洲的标识表 =====
     CONT_ORDER 同时是「大洲调色板贴图」的索引顺序（索引 1..7 依次对应下表；
     索引 0 预留给「无大洲」）。CONT_COLORS 为出厂填充色 —— 彼此在 RGB 空间分得足够开，
     着色器才能对 geo-cont.png 做「就近匹配」解码；用户可在菜单里逐洲改色（存 state.geo.cont.colors）。 */
  const CONT_ORDER = ['AS', 'EU', 'AF', 'NA', 'SA', 'OC', 'AN'];
  const CONT_COLORS = {
    AS: '#F2C14E',   // 亚洲   琥珀
    EU: '#6FA8DC',   // 欧洲   天蓝
    AF: '#E07A5F',   // 非洲   赭红
    NA: '#81B29A',   // 北美洲 灰绿
    SA: '#B088C9',   // 南美洲 淡紫
    OC: '#5EC9C0',   // 大洋洲 青绿
    AN: '#E9EDF2',   // 南极洲 霜白
  };
  const CONT_NAMES = { AS: '亚洲', EU: '欧洲', AF: '非洲', NA: '北美洲',
                       SA: '南美洲', OC: '大洋洲', AN: '南极洲' };
  const DEFAULTS = {
    playing: true,
    speed: 8640,
    mode: 'single',   // 打开默认：自转视图 · 单窗（可随时切三窗）
    /* ★ v40（需求六）：默认显示规则改为「画面简洁」。
       · 'consistent'（画面一致）—— 五个窗口的地球表面显示内容完全统一（同步显示 / 同步隐藏）；
       · 'simple'（画面简洁）—— 五个窗口各司其职：都保留「基础共性内容」，各自再重点显示本职要素。
       各窗口的要素取舍见 SIMPLE_FOCUS。 */
    comboMode: 'simple',
    lockAxis: false,
    // 三窗布局比例：splitX = 左窗宽度占比，splitY = 右列上窗高度占比
    splitX: 0.56, splitY: 0.5,
    // 光照：dayGain 昼面亮度 / nightGain 夜面环境光（0=全黑，仅剩城市灯光）/ soft 昼夜过渡带宽度
    //（0=生硬分界，越大越丝滑，模拟大气曙暮光）/ spec 昼半球海面高光反光强度（0=无反光）
    dayGain: 1.32, nightGain: 0.02, soft: 0.10, spec: 0.5,
    rays: false, raysCenter: false,
    /* v35（需求一）：太阳光线与体积光柱**默认都不显示**（用户明确要求）。
       光柱改为「各方向、内外强度完全一致的均匀半透明圆柱」——
       删除了旧的径向（|dot(N,V)|^edge）与轴向（地球端淡入 / 太阳端增亮）渐变，
       也不再区分 edge / diffuse 两个滑块（升级存档里的旧键由 restoreSaved 归一化剥离）。 */
    volShaft: { on: false, intensity: 85, op: 60, dia: 100, glow: 160, color: '#ffd873' },
    rayVert: { n: 5 },
    /* v34：主视图演示悬浮窗显隐 —— **六个一律默认关闭**（用户要求「全球昼夜悬浮窗默认不显示」：
       它体积最大且会压住 3D 画面）。全部由顶层【面板 › 演示悬浮窗】菜单按需勾选打开；
       位置与尺寸记在 ui.mvLayout。 */
    mvWin: { map: false, orbit: false, side: false, sub: false, north: false, south: false },
    // 晨昏线：晨线（日出侧）与昏线（日落侧）分别设置（默认隐藏）
    // 线宽 / 颜色 / 透明度 / 线型 → style.ln.dawn、style.ln.dusk
    term: false,
    dawn: { on: false },
    dusk: { on: false },
    /* ★ v41（需求二·2）：晨昏线「文字注释」组的**组级总开关**（与「地球表层 › 地方时刻 ›
       文字注释 › 主时刻 / 其余时刻」完全同构：一条组开关 + 每条注释各自一个标题行开关）。
       默认 true，只做「门控显隐」，不改变老存档的既有观感。 */
    termNote: { on: true },
    sub: false,
    // v23.17（需求②）：太阳直射点轨迹记录 —— 默认关闭；打开后随仿真时间推进自动记录
    //   直射点在地表的移动轨迹，经过南北回归线 / 赤道时自动打标记点。
    //   样式 → style.ln.subTrail（线条）/ style.pt.subTrailMark（标记点）
    subTrail: false,
    // v27.4：太阳直射点所在纬线与经线 —— 默认关闭；打开后随仿真时间实时显示
    //   直射点纬度（= 太阳赤纬 decl）对应的纬线圈（整圈平行圈）与直射点经度对应的经线
    //   （v27.5 起为半圆弧「北极→直射点→南极」；v27.4 原为整圈大圆）。
    //   线条样式 → style.ln.subLatCircle / style.ln.subLonCircle，与 subTrail 同一套属性与量纲。
    subCircle: { on: false },
    axis: false, axisLen: 3.5,
    // 黄赤交角（度）：系统核心参数，默认 23°26′（v23.14 起取课标/天文真值），可调 0°–90°。
    // 与地轴倾角、太阳视赤纬（= 直射点纬度）、昼夜长短、南北回归线 / 南北极圈严格联动 —— 见 applyObliquity()
    obliquity: OBLIQ_DEFAULT,
    // 重要纬线（特殊纬线：默认不显示）；样式 → style.ln.eq / tr / ar
    eq: { on: false },
    tr: { on: false },
    ar: { on: false },
    pm: { on: false },                     // 本初子午线（特殊经线，单独控制）
    // 观察位置
    polar: true,
    pd: { on: false },          // 极昼区：填充与描边 → style.fill.pd
    pn: { on: false },          // 极夜区：填充与描边 → style.fill.pn
    /* ★ v41（需求二·2）：极昼极夜「文字注释」组的组级总开关（同上，与晨昏线文字注释同构）。 */
    polarNote: { on: true },
    graticule: false, night: true, clouds: true, atmo: true, aurora: true, auroraBright: 0.55,
    // v25.1（需求④）：真实地球贴图开关 —— true = 显示真实地表贴图（默认）；false = 显示白色球，
    //   仅呈现太阳光照形成的明暗阴影（昼半球受光、夜半球背光变暗）。菜单入口：地球表层 › 表层效果。
    realTex: true,
    // v31（需求九）：太阳使用**真实贴图** —— 程序化生成的太阳表面纹理（米粒组织 + 黑子 + 临边增亮）。
    //   true（默认）= 自转 / 公转 / 综合三个视图的太阳盘都用真实贴图；false = 还原为原色（纯黄，
    //   自转 / 综合视图里原本不显示太阳盘，关闭后即恢复原样）。菜单入口：光照系统 › 光照与太阳光线 › 太阳外观。
    sun: { tex: true },
    // 经纬网：经线 / 纬线分别显隐、度数间隔分别可调（重构 v9.0）
    // v21.0（需求②③）：经纬网文字注释默认全部关闭；每一项还受「对应的经线 / 纬线 / 特殊经纬线
    //        是否显示」控制（经纬网 → 经线 → 经度注释，三级层级，缺一级就不显示）。
    /* v33（面板规格）：经纬网「显示间隔」由单选改为**多选** —— 勾选几个就同时画几套
       （画的是各间隔角度的并集，故勾 10°+30° 不会重复描线）。
       默认只勾 30°（与旧版 merStep / parStep = 30 完全等价）。 */
    grat: { mer: true, par: true,
      merSteps: { 10: false, 15: false, 20: false, 30: true, 45: false, 60: false },
      parSteps: { 10: false, 15: false, 20: false, 30: true, 45: false, 60: false },
      // v23.5：新增 eq —— 「赤道（标文字）」独立开关，与 tr / ar / pm 一样作为「特殊经纬线」单独控制
      note: { on: false, lon: false, lat: false, eq: false, tr: false, ar: false, pm: false } },
    // 点标注（添加点模式）：在地球表面添加可删除的点，注释默认 A/B/C… 轮着命名；
    // snap = 显示经纬网时靠近经纬线（±3°）自动吸附；点样式 → style.pt.ptLabel，文字 → note 分类
    points: { mode: false, snap: true, show: true, items: [] },
    /* ===== v27.0（需求一）：标记文本 =====
       在地球表面放置可编辑的「文字注释框」：拖拽放置、吸附地表、随球旋转缩放并保持
       相对位置与朝向（锚定到球面，非朝向相机的广告牌）。文本框默认继承「全局文字注释样式」
       （字体 / 字号 / 颜色 / 字重，对齐），仅当某实例显式覆盖时才保留自定义值；
       全局文字样式变更会同步到未覆盖的实例。框体本身（尺寸 / 填充色与透明度 / 描边色与宽 /
       圆角）另有默认并支持整体与逐实例自定义。 */
    markText: {
      on: false,                       // 显示标记文本（总开关 = 进入文本标记模式）
      snap: true,                      // 放置时吸附到经纬网上
      show: true,                      // 文本注释显隐（与 note 分组开关一致）
      items: [],                       // [{ id, lat, lon, text, box:{w,h,fill,fillOp,stroke,strokeW,radius}, ov:{size,color,op,weight,align,font} }]
      // 框体默认样式（世界单位，相对地球半径 1）
      /* v27.1（需求①）：默认框体缩小为 0.15×0.1（世界单位，相对地球半径 1）；
         宽 / 高菜单可调下限 0.001；描边宽度调到 0 即隐藏边框（渲染端 strokeW≤0 不描边）。 */
      box: { w: 0.15, h: 0.10, fill: '#FFF7D6', fillOp: 0.92, stroke: '#C9A227', strokeW: 0.008, radius: 0.05 },
    },
    /* ===== v25.1（需求⑥）：小人模型演示 =====
       从菜单面板把「小人」拖到地球表面后，小人会钉在地表随地球一起运动；
       它的影子按当前太阳方向**实际计算**（方向 = 太阳水平投影的反方向，
       长度由太阳高度角解出），于是拖动时间 / 日期即可观察影子的长短与朝向变化。
       小人是「地表固定点」——与标注点一样挂在 spin / spinOrb 上，两个视图自动一致。 */
    figure: {
      on: false,                       // 显示小人（总开关）
      snap: true,                      // 放到地表时吸附到经纬网上
      items: [],                       // [{ lat, lon }] 已放置的小人
      /* v27.3（需求）：小人脚下的「东南西北」方位箭头 ——
           on   箭头显隐（四个箭头一起，受 figure.on 总门控）；
           text N / S / W / E 文字注释显隐（与箭头一一对应，样式独立设置）。 */
      dir: { on: false, text: true },
      // 样式 → style.pt.figure（身高 / 颜色 / 透明度）
      //       style.ln.figShadow（阴影显隐 / 宽度 / 颜色 / 透明度 / 柔和度）
      //       style.pt.figDir（方位箭头：长度 / 杆宽 / 箭头占比 / 颜色 / 透明度 + 文字样式）
    },
    // 监听点：单击或预设选定一点后，可显示其所在纬线圈；与晨昏线相交则分成昼弧/夜弧，分别控制样式
    mon: {
      preset: 'none',                       // 'none' | 'beijing' | 'taiyuan' | 'london' | 'custom'
      custom: { lat: 39.9, lon: 116.4 },    // 自定义经纬度（度）
      day: true, night: true,               // v15.0 昼弧 / 夜弧分别显隐
      circle: false,                        // 是否显示该点所在纬线圈（昼弧 / 夜弧样式 → style.ln.monDay / monNight）
      // 监听数据面板内容（哪些行显示；默认只显示主要几项；tz = 时区，默认隐藏）
      // v28（需求④）：新增「自转线速度 / 自转角速度」两行，默认隐藏（可在 数据面板 菜单打开）
      panel: { pos: true, lst: true, daylen: true, term: true, tz: false, sub: false, sr: false, sraz: false, noon: false, year: false, curve: false, spinV: false, spinW: false },
    },
    // 赤道地方时时刻标注：0/6/12/18 四个主时刻一组，其余二十个整点一组
    // 点样式 → style.pt.hourMain / hourRest；文字样式 → note 分类 hourMain / hourRest
    // 时区图层（24 个理论时区：中时区 / 东一~东十一区 / 西一~西十一区 / 东西十二区）
    //   on = 图层显隐；填充 / 描边样式 → style.fill.tz（v14.0 起在时区面板内直接调节）
    tz: { on: false },
    /* ===== v25.1（需求⑦）：时差演示 =====
       把「因经度不同而地方时刻不同」落到球面上一眼看懂的五件事：
         · tz0    中时区（零时区）—— 以 0° 经线为中心的那个 15° 时区面，可单独显示 / 填充 / 描边
         · idl    国际日期变更线 —— 大致沿 180° 经线的日期分界
         · zero   0 时时刻所在经线 —— 地方时刻恰为 0:00 的那条经线（随地球自转移动）
         · newDay 新的一天（今天范围）—— 由 0 时经线向东到 180° 经线
         · oldDay 旧的一天（昨天范围）—— 由 180° 经线向东（绕经 0° 的另一侧）到 0 时经线
       0 时经线 = 直射点经线 + 180°，与「地方时刻」标注严格同源（都用 subsolarLonRad），
       因此三个动态要素永远与地球上的地方时刻读数一致。三条线 / 两个面的样式 →
       style.fill.tzdiff（面填充与描边 / 线粗细·颜色·透明度·线型）。 */
    tzdiff: {
      on: false,
      tz0: { on: true }, idl: { on: true }, zero: { on: true },
      newDay: { on: true }, oldDay: { on: true },
      note: { on: false, tz0: true, idl: true, zero: true, newDay: true, oldDay: true },
    },
    /* ===== v25.1（需求⑧）：球面最短距离（大圆劣弧）测量 =====
       入口：标记演示 › 球面最短距离。总开关 gcd.on 打开即「进入测量状态」——
       三种取点方式（gcd.mode）：
         · 'click'  在地球上依次点击两点（第一次设 A、第二次设 B；再点一次开始新一轮）
         · 'marker' 从已有标记点里选两点（state.points.items，无标记点时给出提示）
         · 'input'  直接输入两点的经纬度
       a / b = 已确定的两端点（{lat, lon}，null = 未确定）；msg = 状态提示文字。
       关闭总开关时清空 a / b / msg —— 地球上的实体与文字标签一并撤除（见 applyGcd）。 */
    gcd: {
      on: false,
      mode: 'click',
      a: null, b: null,
      mkA: 0, mkB: 1,                 // 「从标记点选取」两个下拉的当前索引
      inp: { aLat: 39.9, aLon: 116.4, bLat: 35.68, bLon: 139.69 },   // 手动输入的四元组
      ring: { on: true },             // 完整大圆环线显隐（样式 → style.ln.gcdRing）
      arc: { on: true },              // 劣弧线段显隐（样式 → style.ln.gcdArc）
      note: { on: false, dist: true, end: true },   // 距离标注 / 端点标注
      msg: '',                        // 当前状态提示（取点引导 / 边界情况警告）
    },
    /* ===== v25.1（需求⑤）：海陆分布 / 七大洲（球面掩膜叠加层） =====
       数据来源：地球表层 › 海陆分布 / 七大洲，矢量边界取自参考工程的
         LAND_SHELL（553 环 / 26498 点，全球陆地外壳）与 CONT_BOUNDARY（7 大洲 / 1425 环）。
       离线栅格化为等距圆柱掩膜贴图后随贴图加载：
         · assets/geo-land.png  R=陆地填充、G=到海岸线的距离场、B=到大洲界线的距离场
         · assets/geo-cont.png  RGB=大洲填充色（8 色调色板「就近匹配」解码）
       描边用距离场做阈值化 → 线宽可像其他面要素一样在运行时任意调节，且边缘自带抗锯齿。
       面样式 → style.fill.ocean / land / coast(海岸线) / contLine(大洲界线) */
    geo: {
      // 海洋陆地面：海洋填充 / 陆地填充 / 海岸线轮廓，三者各自可开关
      landSea: { on: false, ocean: true, land: true, coast: true, note: { on: false } },
      // 七大洲面：7 洲可单独显示（对应 CONT_ORDER），大洲界线轮廓可单独开关
      cont: {
        on: false, line: true,
        list: { AS: true, EU: true, AF: true, NA: true, SA: true, OC: true, AN: true },
        note: { on: false },
      },
      /* v26.1（需求③）：面是否「随昼夜明暗」。
         默认 **false** —— 海陆分布 / 七大洲 与下面新增的东西半球、南北半球、低中高纬度
         这些「面」要素，跟温度带 / 时区 / 时差面一样恒定显示。
         此前这几张面是唯一会被太阳昼夜压暗的（夜侧只剩 26% 不透明度），
         转到夜半球就几乎看不见，与其它面要素的口径不一致。 */
      dayDim: false,
    },
    /* ===== v26.1（需求⑨）：球面上的「区域」类面要素 =====
       三组与温度带同构的区域划分，属性控制也照温度带的样式（单独显示 / 填充色 / 透明度 /
       分界线描边 / 逐项文字注释）：
         · hemi.ew  东西半球 —— 东半球（20°W 向东到 160°E）/ 西半球（160°E 向东到 20°W）
         · hemi.ns  南北半球 —— 北半球 / 南半球（赤道分界）
         · latbelt  低中高纬度 —— 低纬 0°–30° / 中纬 30°–60° / 高纬 60°–90°（南北各一份）
       （v27.1 需求②：「主要地壳板块」整组功能与菜单已移除。）
       所有面都由代码按经纬度**直接生成球面几何**（不依赖任何外部数据文件），
       因此不会出现「数据缺失 → 面画不出来」的情况。 */
    hemi: {
      ew: {
        on: false, east: true, west: true, line: true,
        note: { on: false, east: false, west: false },
      },
      ns: {
        on: false, north: true, south: true, line: true,
        note: { on: false, north: false, south: false },
      },
    },
    latbelt: {
      on: false,
      bands: { low: true, mid: true, high: true },
      // v27.1（需求④）：±30° / ±60° 分界线独立显隐开关 + 独立线型（样式在 style.fill.latbelt.line）
      line: false,
      // v27.0（需求二.3）：取消低中高纬度的轮廓描边 —— 只保留填充与文字注释，
      //   style.fill.latbelt.line* 与菜单「描边（轮廓）」组一并删除（与温度带 v23.0 同口径）。
      note: { on: false, low: false, mid: false, high: false },
    },
    /* v27.1（需求②）：state.plates 整组删除（六大板块 / 生长·消亡边界 / 运动方向箭头）。
       style.fill.plates 与 note.cats.plateName/plateBd 只存在旧版 localStorage 存档里，
       restoreSaved 末尾统一清除（见上）。 */
    // 文字注释统一与分类样式（v5.0 · 集中式状态）
    //   master ＝ 全局总控（显隐 / 字号 / 颜色 / 透明度），优先级最高
    //   cats    ＝ 各分类独立样式；size / color 为 null 表示「跟随全局」，自定义后保留
    note: {
      // font：字体（default = 跟随系统界面字体）
      // font 字体 / weight 字重 / align 对齐 —— 与 size、color、op 同为全局统管项
      // v17.0：总开关默认关 —— 所有文字注释（含地方时标注）默认均不显示
      // v22.1：size 默认 0.55 —— 以「统一字号基准」(UNIFY_W=0.62) 折算，默认视角（相机距离
      //   4.35、fov 38°）下文字屏幕高度 ≈16px，即小四（12pt）字号；字体默认系统字体、
      //   颜色默认白色（见 makeTextSprite 的白字 + material.color 染色）。
      master: { on: false, size: 0.55, color: '#FFFFFF', op: 1, font: 'default', weight: '700', align: 'center' },
      // v23.5：总开关默认关闭；各属性统一开关中「字号」默认开启、其余默认关闭 ——
      //   默认效果：显示出的文字注释字号一致、颜色等其余属性各自保留（不受统一控制）。
      unify: false,
      // v23.5：每个注释文字属性的独立「统一开关」（真正控制是否统一的判据）：
      //   · 总开关(note.unify)开启 ⇒ 所有分开关自动全部开启（全部属性按全局设置统一）；
      //   · 总开关关闭 ⇒ 分开关仍可单独开启，各自控制对应属性是否统一。
      unifyAttrs: { size: true, color: false, op: false, font: false, weight: false, align: false },
      // v21.0（需求②）：各分类「注释显隐」默认全部 false —— 与 master.on 一起构成
      //   「总开关 → 地理事物开关 → 注释分类开关」的三级门控（见 spriteNoteGate）。
      //   三级同时为真时注释才显示，菜单里被上级压住的开关会同步置灰。
      cats: {
        axis: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },        // 地轴注释（N / S）→ 开关挂在「南北极注释」分组（cbAxisNote）
        // v22.0：下面两个分类在菜单里**没有「分类开关」**（显隐由上游的 grat.note.* /
        //   zones.note.* 控制，见 CAT_NO_SELF_SW），故 on 恒为 true —— 它们不参与
        //   「分类级『与』运算」，这样即便旧存档里存着 v21.0 写入的 false 也不会把注释永久压死。
        zone: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },         // 温度带注释 → zones.note.*
        lat: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },          // 经纬度 / 特殊纬线注释 → grat.note.*
        dawn: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },        // 晨线标注（昼夜分界 · 日出侧）
        dusk: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },        // 昏线标注（昼夜分界 · 日落侧）
        tz: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },          // 时区注释
        hourMain: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },    // 地方时特殊时刻标注（点本身由「点样式」单独控制）
        hourRest: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },    // 其他地方时标注
        terms: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },       // 二分二至位置注释
        terms24: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },     // 其余二十节气注释
        orbit: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },        // 公转轨道名称注释
        ray: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },         // 太阳光线注释
        pts: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },          // 点标注注释
        misc: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },         // 其他标注
        // v15.0：极昼 / 极夜区域、黄道面 / 赤道面 各自的注释分类
        pd: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },
        pn: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },
        ecl: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },
        equ: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },
        // v25.1（需求⑤）：海陆分布（四大洋名称）/ 七大洲名称。
        //   它们与 lat / zone 同类 —— 菜单里**没有**「分类开关」，显隐由上游的
        //   geo.landSea.note.* / geo.cont.note.* 控制（见 CAT_NO_SELF_SW），故 on 恒为 true。
        sea: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        cont: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        /* v25.1（需求⑦）：时差演示的 5 条注记各自一个分类 —— 菜单里这 5 项各有一个可展开的
           「文字注释样式」组（字号 / 字体 / 颜色 / 透明度 / 字重），所以样式也必须逐条独立，
           不能共用一个分类，否则改「中时区」的字号会把「新的一天」也一起改掉。
           它们与 lat / zone / sea / cont 同类：分类自身的 on 恒为 true（不参与「分类级与运算」），
           显隐由上游 tzdiff.note.tz0 / idl / zero / newDay / oldDay 控制（见 CAT_NO_SELF_SW）。 */
        tzdiffTz0: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        tzdiffIdl: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        tzdiffZero: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        tzdiffNew: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        tzdiffOld: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        /* v25.1（需求⑧）：球面最短距离的两类注记 —— 「距离标注」（弧中点，含两点经纬度）
           与「端点标注」（A / B 两个端点）。同样各带一个开关键，样式逐类独立。 */
        gcdDist: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        gcdEnd: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        /* v26.1（需求⑨）：四组「区域」面要素的注记 —— 与 lat / zone / sea / cont 同类：
           分类自身的 on 恒为 true（不参与「分类级与运算」），显隐由上游
           hemi.ew.note.* / hemi.ns.note.* / latbelt.note.* 控制
           （见 CAT_NO_SELF_SW）。每组只用一个分类，组内逐项由注释对象的子开关区分。 */
        hemiEW: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },   // 东 / 西半球
        hemiNS: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },   // 南 / 北半球
        latBelt: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },  // 低 / 中 / 高纬度
        /* v29（需求⑤）：公转速度演示的「位置标注」（近日点 / 远日点名称 + 日期 + 日地距离）
           分类开关默认开 —— 使「名称默认显示」在出厂即生效（其余子开关由 spd.apsisName /
           apsisDate / apsisDist 单独控制）。 */
        spd: { on: true, size: null, color: null, op: null, weight: null, align: null, font: null },
        /* ★ 本次修复（缺陷 A）：标记文本（v27.0 需求一）的注释分类此前**只**在运行时按需
           创建（redirectMarkText / noteStyleFor 里的懒建），DEFAULTS 里没有它 ——
           于是菜单叶子控件 `ncMarkTextOn`（path = note.cats.markText.on）在
           bindMenuLeaf 的通用绑定器里读 getPath(state, 'note.cats.markText.on') 时，
           路径前缀 note.cats.markText 尚不存在 → TypeError: ... reading 'on'
           （被 catch 吞成 console.warn）。这里按其余分类的同一形状预置，使其在加载期
           与各重置路径（deep copy DEFAULTS）后都稳定存在。size 等留 null = 跟随全局 /
           回落 NOTE_CAT_DEF.markText，与原懒建语义一致。 */
        markText: { on: false, size: null, color: null, op: null, weight: null, align: null, font: null },
      },
      // v20.0 清理：原 inst（单条注释实例覆盖表）已删除 —— v16.0 的「单条注释实例」面板
      // 在 v20.0 一并移除后，再没有任何写入方，保留只会成为永远读不到数据的死状态。
    },
    // 顶层视图：rotate=自转演示，revolve=公转动画，combo=综合视图
    view: 'rotate',
    // v23.17：公转动画的镜头方式（仅公转视图有意义）——
    //   global = 全局视角（完整显示公转轨道，默认）；close = 地球特写（镜头跟随地球）
    orbCam: 'global',
    // 温度带（五带填充）——自转 / 公转 / 综合所有视图统一
    zones: { on: false,        // 五带填充透明度 / 各带颜色 → style.fill.zone；分界线 → zones.line + style.fill.zone.line
      // v27.1（需求④）：五带分界线（南北回归线 / 南北极圈）独立显隐开关 + 独立线型
      line: false,
      bands: { coldN: true, tempN: true, tropic: true, tempS: true, coldS: true },   // v15.0 单独显示
      // v21.0（需求②）：五带文字注释默认关闭；每条还受「温度带总开关 + 该带是否显示」控制
      note: { on: false, coldN: false, tempN: false, tropic: false, tempS: false, coldS: false } },
    // 公转动画场景（轨道样式 / 节气标记 / 注释 / 光线；地表要素与自转共用同一组设置）
    orb: {
      sunScale: 1, earthScale: 1, distScale: 1, ecc: ORB_ECC0,   // 太阳大小 / 地球大小 / 日地距离 / 轨道离心率（相对示意值，可自由调节）
      orbit: { on: true },                                  // 轨道样式 → style.ln.orbit
      /* v28（需求①）：焦点可视化 —— 椭圆几何中心标记 + 「焦点（太阳）→ 几何中心」虚线。
         真实离心率 0.0167 下太阳偏离椭圆中心的量只有半长轴的 1.67%，肉眼几乎看不出；
         这两样东西让「太阳位于椭圆的一个焦点、而非中心」成为可读的几何事实。 */
      focus: { on: true, op: 1 },
      terms: { on: true, date: false },                     // 二分二至位置标记 → style.pt.term；date = 是否在标注中显示日期
      terms24: { on: false },                               // 其余二十节气位置标记 → style.pt.term24（v17.0：注释默认隐藏，故位置标记同时恢复默认隐藏）
      ray: { on: true },                                    // 公转直射光线样式 → style.ln.ray
      // 黄道面 / 赤道面（v10.0）：ecl / equ 各自可单独开关
      //   ecl = 黄道面（公转轨道所在平面，过太阳）；equ = 赤道面（垂直地轴）
      // v20.0：两者默认隐藏（原 arc「黄赤交角扇形」角度展示已按要求删除）
      // v26.1（需求⑫）：on 改回 true —— 它是「黄赤交角」菜单标题前的总开关，
      //   真正决定画不画的是下面的 ecl / equ（均默认 false）。写成 false 会让老存档里
      //   已经打开的黄道面 / 赤道面在升级后凭空消失。
      planes: { on: true, ecl: false, equ: false },
    },
    /* ===== v28（需求③）：公转速度演示 =====
       把「开普勒第二定律」落到轨道平面上一眼看懂的三件事：
         · 近日点 / 远日点位置标注（含距离与到达日期）；
         · 单位时间（可配置步长 Δt）内地球与太阳连线**扫过的面积**（扇形），
           同一 Δt 在近日点、远日点与当前位置各画一个 —— 三者面积相等，而弧长不等；
         · 面积速度 dA/dt = h/2 恒定不变（开普勒第二定律的直接表述）。
       dt   = 时间步长（天），0.25 ~ 60 可调（菜单里有 1 天 / 10 天 等一键预设）；
       unit = 面积单位：'km2' 万平方公里 / 'au2' 平方天文单位 / 'deg2' 平方度；
       cur / ref = 当前时刻扇形 / 近日点·远日点对比扇形；apsis = 近日点·远日点位置标记。
       样式 → style.fill.spd（扇形填充）、style.ln.spd（扇形边界线）、style.pt.apsis（位置点）。 */
    spd: {
      // v29（需求①）：unit（面积单位）已删除 —— 面积速度读数固定 km²/日。
      on: false, dt: 25, cur: true, ref: true, apsis: true, area: true,
      apsisName: true, apsisDate: false, apsisDist: false,
    },
    // 天文数据读数（时间面板底部，可分别显示）
    // v28（需求④）：新增「地球公转速度（瞬时线速度 / 角速度）」一行，默认隐藏（可打开）
    read: { sub: true, polar: true, obliq: true, orbV: false, orbArea: false },
    // 综合视图布局比例（左列宽占比 / 左列上格高占比 / 右列宽占比 / 右列上格高占比）
    cmb: { splitX: 0.22, splitY: 0.5, splitZ: 0.26, splitR: 0.5 },
    // 面板文字样式（v14.0）：控制所有显示面板 / 菜单 / 窗口标题中的文字，不含地球上的注释
    //   font 字体 / size 字号倍率 / color 颜色 / op 透明度
    // v15.0 表层效果强度：夜间城市灯光 / 云层 / 大气光晕 / 极光 各自的透明度·强度
    sfx: { nightOp: 1, cloudsOp: 1, atmoStr: 1, auroraOp: 1 },
    // v15.0 分组级注释总开关（与各分类自身开关为「与」关系）
    // v21.0（需求②③）：分组级注释开关默认全部关闭（总开关 → 地理事物 → 注释，三级「与」关系）
    hourNote: { on: false }, termsNote: { on: false }, obliqNote: { on: false },
    /* v26.1（需求⑫）：两个二级菜单原本没有「总开关」—— 现在菜单标题前的开关就是它俩，
       总开关关掉时该菜单下的全部要素（点组 / 节气标记）连同注记一起隐藏。
       与「显示真实地球」「显示海陆分布」这些已有的总开关是同一套语义。 */
    /* 两者默认 **true**（「菜单功能启用」），真正决定画不画的是下面各自的子开关
       （style.pt.hourMain.on / hourRest.on、orb.terms.on / terms24.on，均默认关）。
       这样既满足需求⑫「标题前的开关 = 该功能总开关」，又不会让老存档里已经打开的
       时刻点 / 节气标记在升级后凭空消失。 */
    hour: { on: true },      // 地方时刻（四个主时刻点 + 其余二十个整点）
    terms: { on: true },     // 二十四节气（二分二至位置 + 其余二十个节气位置）
    axisNote: { n: false, s: false },        // 地轴两端 N / S 标注分别显隐
    // v20.0：面板文字增加「字重」（weight，CSS font-weight 数值字符串）
    ui: { panel: { font: 'default', size: 1, color: '#1E293B', op: 1, weight: '400' },
          /* v31（需求十七）：UI 色系与半透明毛玻璃。
             scheme ='default' 即「原色系」（项目原有默认蓝），CSS 里由 body[data-ui] 覆写主题变量；
             glass  = 卡片底色不透明度（%）；blur = 毛玻璃模糊半径（px）。
             ★ v44（需求一）：新增**浅色 / 深色两种模式** +
               两种模式下面板底色与面板文字色**均可自定义**。
               · mode        = 'light'（白底黑字、面板浅蓝白半透明）/ 'dark'（黑底白字、面板黑色半透明）；
               · lightPanel / darkPanel = 该模式下所有卡片 / 浮层 / 二级菜单面板的底色（可自定义）；
               · lightInk  / darkInk    = 该模式下面板文字色（可自定义）。
               切换模式时把「当前模式的文字色」回写到 state.ui.panel.color（面板文字样式唯一来源），
               于是「面板文字颜色」控件与模式文字色始终是同一个值，不会出现两套互相打架的设置。 */
          theme: { scheme: 'default', glass: 88, blur: 14, mode: 'light',
                   lightPanel: '#f2f7ff', darkPanel: '#0a1018',
                   lightInk: '#1e293b', darkInk: '#eef4ff' },
          /* v31（需求八）：主视图演示悬浮窗的位置 / 尺寸 / 折叠状态（键 = 窗口 DOM id）。
             单独存放而非并入 state.mvWin（后者只存显隐），避免被 deepMerge 的整体替换波及。 */
          mvLayout: {} ,
          /* ★ v39（需求四·1）：主模块面板（设置 / 时间 / 观测点信息）拉伸后的尺寸 / 位置。 */
          pmSize: {} },
  };
  /* ======== 统一样式控制（v7.0）：点 / 线 / 面的默认显示属性集中在此 ========
     全项目点、线、面样式的唯一数据源：各处 UI 控件（原有分层控件 + 新增「🎨 统一样式控制」）
     都写入 state.style，渲染时统一从 state.style 读取 —— 不存在两份互相冲突的值。
     默认值全部取自 v7.0 之前的既有默认显示属性，因此升级后观感不变。 */
  const STYLE_DEF = {
    // ---- 点要素：大小 / 颜色 / 透明度 ----
    pt: {
      // v23.1（需求②）：下面两个开关是「会话级」的 —— 默认隐藏，点击才显示；
      //   重新打开一律回到隐藏（加载时在 restoreSaved 里强制压回 false，见该文件注释）。
      hourMain: { size: 0.022, color: '#F272A8', op: 1, on: false },  // v18.0：赤道 0/6/12/18 主时刻点 —— 默认隐藏（菜单「地球表层 › 地方时刻」控制）
      hourRest: { size: 0.014, color: '#C97BA9', op: 1, on: false },  // v18.0：赤道其余 20 个整点点 —— 默认隐藏
      sub: { size: 0.045, color: '#FF5A36', op: 1 },        // 太阳直射点
      marker: { size: 0.028, color: '#FF2D2D', op: 1 },     // 点击查询标记
      arrow: { size: 1, color: '#FFE9A8', op: 0.95 },       // 太阳光线箭头（size 为倍率）
      ptLabel: { size: 1, color: '#FFB020', op: 1 },        // 点标注圆点（倍率）
      term: { size: 1, color: '#FFE9A8', op: 1 },           // 二分二至轨道标记（倍率）
      term24: { size: 1, color: '#A9C489', op: 0.9 },       // 其余二十节气标记（倍率）
      // v23.17（需求②）：轨迹经过南北回归线 / 赤道时自动生成的标记点（size 为球面半径，
      //   地球半径 = 1）—— 颜色 / 大小 / 透明度均可设置
      subTrailMark: { size: 0.030, color: '#FF2D9B', op: 1 },
      // v25.1（需求⑥）：小人模型 —— size = 身高（地球半径的倍数，1 格 = 0.001）
      figure: { size: 0.075, color: '#FFD166', op: 1 },
      /* v28（需求③）：近日点 / 远日点位置标记点（size 为倍率，与二分二至标记同一量纲）
         v29（需求⑤）：默认 1.0 —— 与二分二至标记（term.size 默认 1.0、同一 0.055 基准球）
         初始大小完全一致；用户仍可在「公转速度 › 近日点与远日点 › 点大小」里单独调整。 */
      apsis: { size: 1.0, color: '#7DD3FC', op: 1 },
      /* v27.3（需求）：小人脚下的「东南西北」方位箭头 ——
         len  = 箭头长度（小人身高的倍率，1 格 = 0.01）
         w    = 箭杆宽度（小人身高的倍率，1 格 = 0.01）
         head = 箭头三角占全长的比例（0~1，越大箭尖越长）
         color / op = 箭头颜色与透明度
         text = N / S / W / E 文字注释（size = 字母高度，同为小人身高的倍率，1 格 = 0.001；
                字体 / 字重沿用全项目同一套选项；本组独立于「全局文字注释」体系，
                故不受 note.master 总开关与「统一字号」等设置影响）。 */
      figDir: {
        len: 1.60, w: 0.16, head: 0.32, color: '#FF8A3D', op: 0.95,
        text: { size: 0.42, font: 'default', color: '#FFFFFF', op: 1, weight: '700' },
      },
    },
    // ---- 线要素：线型 / 颜色 / 粗细 / 透明度（+ 虚线密度 / 实虚比）----
    // 注（v17.0）：除南北回归线、南北极圈按地理教学惯例固定为虚线外，其余线条默认全部为实线。
    ln: {
      axis: { w: 0.008, color: '#7DD3FC', op: 1, dash: 'solid', n: 40, ratio: 0.55 },
      grat: { w: 0.0018, color: '#FFFFFF', op: 0.17, dash: 'solid', n: 72, ratio: 0.55 },
      mer: { w: 0.0018, color: '#FFFFFF', op: 0.17, dash: 'solid', n: 72, ratio: 0.55 },   // 经线（v15.0 与纬线分开）
      par: { w: 0.0018, color: '#FFFFFF', op: 0.17, dash: 'solid', n: 72, ratio: 0.55 },   // 纬线
      eq: { w: 0.55, color: '#FFFFFF', op: 0.9, dash: 'solid', n: 72, ratio: 0.55 },
      tr: { w: 0.5, color: '#FFC94D', op: 0.95, dash: 'dash', n: 72, ratio: 0.55 },
      ar: { w: 0.5, color: '#6EC1FF', op: 0.95, dash: 'dash', n: 72, ratio: 0.55 },
      pm: { w: 0.5, color: '#FF5A36', op: 0.95, dash: 'solid', n: 72, ratio: 0.55 },   // 本初子午线（特殊经线，实线）
      dawn: { w: 0.9, color: '#FFD23F', op: 0.95, dash: 'solid', n: 64, ratio: 0.55 },
      dusk: { w: 0.9, color: '#FF7A45', op: 0.95, dash: 'solid', n: 64, ratio: 0.55 },
      monDay: { w: 0.5, color: '#FFD23F', op: 0.95, dash: 'solid', n: 64, ratio: 0.55 },
      monNight: { w: 0.5, color: '#4F7DFF', op: 0.9, dash: 'solid', n: 64, ratio: 0.55 },
      orbit: { w: 0.006, color: '#FFD23F', op: 0.85, dash: 'solid', n: 96, ratio: 0.55 },
      ray: { w: 0.011, color: '#FFD873', op: 0.92, dash: 'solid', n: 40, ratio: 0.55 },
      // v23.17（需求②）：太阳直射点轨迹 —— 与其余线要素完全同一套属性
      //   （粗细 / 颜色 / 透明度 / 线型 / 虚线密度 / 虚实比），控件类型也一致。
      //   w 的单位是「度」：渲染时按球面换算成管半径 w·π/180，与赤道 / 南北回归线等
      //   纬线带同一量纲（默认 0.55° ≈ 赤道带的视觉宽度），菜单读数以「°」显示。
      subTrail: { w: 0.55, color: '#FF5AC8', op: 0.95, dash: 'dash', n: 72, ratio: 0.55 },
      /* v27.4：太阳直射点所在的纬线圈（整圈平行圈，纬度 = 太阳赤纬 decl）与经线
         （v27.5 起为**半圆弧**「北极→直射点→南极」，经度 = 直射点经度 lonSub；v27.4 原为整圈大圆）。
         二者随仿真时间实时跟随直射点移动，线条样式与 subTrail
         完全同一套属性（粗细以「°」计，渲染时按球面换算成管半径 w·π/180），控件类型也一致。
         纬线圈用青色、经线用琥珀色，便于与直射点（红）及轨迹（品红）区分。 */
      subLatCircle: { w: 0.5, color: '#35E0C9', op: 0.95, dash: 'dash', n: 72, ratio: 0.55 },
      subLonCircle: { w: 0.5, color: '#FFB454', op: 0.95, dash: 'solid', n: 72, ratio: 0.55 },
      /* v28（需求③）：单位时间扫过面积的扇形**边界线**（太阳 → 起点 / 终点的两条半径线）。
         用 LineDashedMaterial 绘制（与参考图一致的细虚线）；该材质在 WebGL 下**线宽恒为
         1 px**（LineBasicMaterial.linewidth 被所有主流驱动的 WebGL 实现忽略），故这里
         **不设「线粗细」**，只给 颜色 / 透明度 / 线型 / 虚线密度 / 虚实比 五项 ——
         给了宽度也是死控件。虚线密度 n 与虚实比 ratio 按「以半长轴的 2 倍为参考长度」换算。 */
      spd: { color: '#9CC9FF', op: 0.95, dash: 'dash', n: 40, ratio: 0.55 },
      /* v25.1（需求⑥）：小人在地表投下的影子（沿球面的软边条带）。
         w    = 影宽（= 小人身宽的倍率，1 格 = 0.01）；
         soft = 边缘柔和度（0 = 硬边，1 = 最柔，带本影 / 半影过渡的观感）；
         on / color / op 与其它线要素同一套字段。 */
      figShadow: { on: true, w: 1.7, color: '#0B1220', op: 0.60, soft: 0.75 },
      /* v25.1（需求⑧）：球面最短距离的两条线 —— 完整大圆环（细虚线，冷色）与两点间的
         劣弧（粗实线，亮色），字段与其余线要素完全一致（w 单位为「度」，1 格 = 0.01°），
         另加 drape = 「是否贴地夹持地形」：
           true  → 紧贴地表（带几何沿球面铺开，半径 = GCD_RING_R / GCD_ARC_R）；
           false → 沿径向抬升 GCD_LIFT，呈现「离地圆环」，便于在球外观察整条大圆与
                   劣弧的空间关系（本项目无真实地形，抬升即「不夹持」的可见表达）。 */
      gcdRing: { w: 0.45, color: '#8BE9FD', op: 0.85, dash: 'dash', n: 48, ratio: 0.60, drape: true },
      gcdArc: { w: 0.26, color: '#FF4FA3', op: 1.00, dash: 'solid', n: 48, ratio: 0.60, drape: true },
    },
    // ---- 填充面要素：填充颜色 / 填充透明度 + 描边（显隐 / 线型 / 粗细 / 颜色 / 透明度）----
    fill: {
      /* v28（需求③）：单位时间扫过面积的**扇形填充**。
         fill / op      = 当前时刻扇形的填充色与透明度；
         refFill/refOp  = 近日点 / 远日点对比扇形的填充色与透明度
                          （两处同色 —— 它们本就是「同一 Δt 扫过的两份相等面积」，
                           用同一颜色才能一眼看出「面积一样」）。 */
      spd: { fill: '#5AA9FF', op: 0.32, refFill: '#FFB454', refOp: 0.32 },
      zone: {
        // v23.0（需求①）：「纬度带（五带）描边」整组取消 —— 五带只保留填充，不再绘制
        //   回归线 / 极圈那四条分界描边，style.fill.zone.stroke 与其菜单一并删除。
        //   需要分界线时用「经纬网 › 特殊经纬线 › 南北回归线 / 南北极圈」，线型样式更全。
        fill: '#FF7A45', op: 0.30,
        cTropic: '#FF7A45', cTempN: '#FFB55C', cTempS: '#FFB55C', cColdN: '#5B8DEF', cColdS: '#5B8DEF',
        // v27.1（需求④）：五带分界线的独立样式（显隐开关在 zones.line）
        // v35（需求二）：温度带分界线固定**虚线** —— dash 键删除，渲染侧写死 'dash'
        line: { color: '#FFFFFF', op: 0.85, w: 0.30, n: 72, ratio: 0.55 },
      },
      pd: {
        fill: '#FFD166', op: 0.42, pattern: 'solid',
        stroke: { on: true, color: '#FFFFFF', op: 0.95, w: 0.006, dash: 'solid', n: 96, ratio: 0.55 },
      },
      pn: {
        fill: '#5B8DEF', op: 0.42, pattern: 'solid',
        stroke: { on: true, color: '#FFFFFF', op: 0.95, w: 0.006, dash: 'solid', n: 96, ratio: 0.55 },
      },
      // 黄道面 / 赤道面（v10.0；v20.0 清理）
      //   黄道面：公转轨道所在平面（暖黄）；赤道面：垂直地轴的地球赤道平面（冷蓝）。
      //   两者只绘制半透明圆盘、没有轮廓 —— 原先预留的 stroke / 已删除的黄赤交角扇形
      //   obl 字段没有任何代码读取，属无用状态，已删除，避免菜单/存档里留下死配置。
      ecl: { r: 1, fill: '#FFD23F', op: 0.10 },
      equ: { r: 1, fill: '#7DD3FC', op: 0.16 },
      tz: {
        fill: '#7FD1FF', op: 0.16,
        // 交替填充（条纹）：奇数位改用第二套色 / 透明度；关闭则 24 面同色
        stripe: true, fill2: '#4FA8E0', op2: 0.30,
        stroke: { on: true, color: '#8BE9FD', op: 0.7, w: 0.003, dash: 'solid', n: 72, ratio: 0.55 },
      },
      /* v25.1（需求⑤）：海陆分布 / 七大洲 —— 配色沿用参考工程的约定
         （海洋 #1F6FEB、陆地 #C9A66B、轮廓深色）。
         面描边的 w 单位为「度」（沿球面的大圆角宽），与经纬网线要素同一口径；
         七洲各自的填充色见 CONT_COLORS，由调色板贴图逐洲写入。 */
      ocean: { fill: '#1F6FEB', op: 0.72 },
      land: { fill: '#C9A66B', op: 0.90 },
      cont: { op: 0.90, colors: JSON.parse(JSON.stringify(CONT_COLORS)) },
      //   ↑ 七大洲填充：colors 逐洲配色（除透明外还带调色板贴图，见 syncGeoPalette），
      //     放进 style 才随「统一样式」一起持久化（persist 只存 note / style / ui）
      coast: { on: true, color: '#0B1B33', op: 0.95, w: 0.22, dash: 'solid', n: 96, ratio: 0.55 },
      /* ★ v55（需求 1）：洲界描边默认关闭。配合 applyGeo 里 uCBndOn 与「填充总开关」的解耦，
         出厂即「填充只渲填充、不描边」；需要轮廓时由「大洲界线」开关单独开启。 */
      contLine: { on: false, color: '#3A2A12', op: 0.90, w: 0.20, dash: 'solid', n: 96, ratio: 0.55 },
      /* ===== v26.1（需求⑨）：四组区域面要素 =====
         字段组织与温度带 zone 一致：一个组级 op + 逐区域填充色（+ 分界线颜色 / 透明度 /
         线宽「度」+ 线型）。区域面全部由代码按经纬度生成球面几何，没有任何外部数据依赖。 */
      hemi: {
        op: 0.24,
        east: '#FFB84D', west: '#4C8DF6',          // 东半球（暖）/ 西半球（冷）
        // v35（需求二）：分界线固定实线 —— dash / n / ratio 三键删除（渲染侧亦强制）
        line: '#FFFFFF', lineOp: 0.85, lineW: 0.30,
      },
      hemiNS: {
        op: 0.22,
        north: '#5EC9C0', south: '#B088C9',        // 北半球（青）/ 南半球（紫）
        line: '#FFFFFF', lineOp: 0.85, lineW: 0.30,
      },
      latbelt: {
        op: 0.22,
        low: '#57C785', mid: '#F2C14E', high: '#7AA2F7',   // 低纬（绿）/ 中纬（黄）/ 高纬（蓝）
        // v27.1（需求④）：±30° / ±60° 分界线的独立样式（显隐开关在 latbelt.line）
        // v35（需求二）：固定实线 —— dash / n / ratio 删除
        line: { color: '#FFFFFF', op: 0.80, w: 0.22 },
      },
      /* v27.1（需求②）：style.fill.plates 整组删除。 */
      /* v25.1（需求⑦）：时差演示 —— 面（中时区 / 今天 / 昨天）与线（日期变更线 / 0 时经线）
         的属性都按现有「面 / 线」要素的同一套字段组织：面用 fill + op（+ stroke 子对象），
         线用 color + op + w(度) + dash + n + ratio。 */
      tzdiff: {
        fill: '#7FD1FF', op: 0.20,                       // 中时区（零时区）填充
        stroke: { on: true, color: '#8BE9FD', op: 0.75, w: 0.16, dash: 'solid', n: 96, ratio: 0.55 },
        newFill: '#FF7A45', newOp: 0.20,                 // 新的一天（今天范围）
        oldFill: '#5B8DEF', oldOp: 0.20,                 // 旧的一天（昨天范围）
        // 两条线的显隐由 state.tzdiff.idl.on / zero.on 控制（与面/点的开关语义一致），
        // 这里只存线本身的属性，避免出现「两个开关管同一件事」的死配置
        idl: { color: '#FF5A36', op: 0.95, w: 0.30, dash: 'dash', n: 72, ratio: 0.55 },
        zero: { color: '#FFD23F', op: 0.95, w: 0.30, dash: 'solid', n: 72, ratio: 0.55 },
      },
    },
  };
  DEFAULTS.style = JSON.parse(JSON.stringify(STYLE_DEF));
  const state = JSON.parse(JSON.stringify(DEFAULTS));
  // 启动即恢复：文字注释（全局控件 + 各分类）与统一样式（点 / 线 / 面）
  (function restoreSaved() {
    const nt = lsGet(LS_NOTE);
    if (nt && nt.master) state.note = deepMerge(JSON.parse(JSON.stringify(DEFAULTS.note)), nt);
    const st = lsGet(LS_STYLE);
    if (st && st.pt) state.style = deepMerge(JSON.parse(JSON.stringify(DEFAULTS.style)), st);
    /* v27.1（需求②）：旧存档里已移除功能的残留键 —— 恢复后清掉，保持 state 与 DEFAULTS 同构 */
    delete state.style.plates;
    delete state.note.cats.plateName;
    delete state.note.cats.plateBd;
    /* v27.2（修复①②）：v26.x 及更早的存档里，低中高纬度的描边是「扁平字段」——
       style.fill.latbelt.line = '#FFFFFF'（字符串）+ lineOp / lineW / lineDash / lineN / lineRatio。
       deepMerge 对「字符串覆盖对象」走直接赋值分支，会用旧存档的字符串 line 覆盖 v27.1
       引入的对象结构 style.fill.latbelt.line —— 后果：
         · 菜单面板读到 line.w / line.color / line.op 均为 undefined → 显示 NaN° / UNDEFINED / NaN%；
         · 渲染端以 NaN 透明度与 NaN 半宽生成分界线几何 → 整组线在 three.js 中不可见。
       恢复后把 line 归一化回对象（缺字段用默认值补齐），并清掉已废弃的扁平键。 */
    (function () {
      const lb = state.style.fill.latbelt;
      const def = STYLE_DEF.fill.latbelt.line;
      if (!lb || !lb.line || typeof lb.line !== 'object' || Array.isArray(lb.line)) {
        lb.line = JSON.parse(JSON.stringify(def));
      } else {
        Object.keys(def).forEach(function (k) {
          if (lb.line[k] === undefined) lb.line[k] = def[k];
        });
      }
      ['lineOp', 'lineW', 'lineDash', 'lineN', 'lineRatio'].forEach(function (k) { delete lb[k]; });
    })();
    /* v35（需求二）：分界线线型固定 —— 半球 / 纬度带 = 实线、温度带 = 虚线。
       老存档里的 lineDash / lineN / lineRatio（扁平组）与 line.dash（嵌套组）一并剥离，
       保持 state 与 DEFAULTS 同构（_audit_defkeys 死键 = 0 的前提）。 */
    (function () {
      const F = state.style.fill;
      ['hemi', 'hemiNS'].forEach(function (k) {
        ['lineDash', 'lineN', 'lineRatio'].forEach(function (d) { if (F[k]) delete F[k][d]; });
      });
      if (F.latbelt && F.latbelt.line) ['dash', 'n', 'ratio'].forEach(function (d) { delete F.latbelt.line[d]; });
      if (F.zone && F.zone.line) delete F.zone.line.dash;
    })();
    /* v27.3（需求）：方位箭头（style.pt.figDir / figure.dir）为新增字段 ——
       deepMerge 会从默认值补齐缺失键，但若老存档里恰好有同名「非对象」残留
       （或 figDir.text 不是对象），仍需归一化，否则渲染端读到 undefined → NaN 几何。 */
    (function () {
      const pd = state.style.pt.figDir, def = STYLE_DEF.pt.figDir;
      if (!pd || typeof pd !== 'object' || Array.isArray(pd)) state.style.pt.figDir = JSON.parse(JSON.stringify(def));
      else {
        Object.keys(def).forEach(function (k) {
          if (k === 'text') return;
          if (pd[k] === undefined) pd[k] = def[k];
        });
        const t = pd.text;
        if (!t || typeof t !== 'object' || Array.isArray(t)) pd.text = JSON.parse(JSON.stringify(def.text));
        else Object.keys(def.text).forEach(function (k) { if (t[k] === undefined) t[k] = def.text[k]; });
      }
      if (!state.figure.dir || typeof state.figure.dir !== 'object' || Array.isArray(state.figure.dir)) {
        state.figure.dir = { on: false, text: true };
      }
    })();
    /* v27.4（新增）：直射点纬线与经线的线样式（style.ln.subLatCircle / subLonCircle）
       为新增字段 —— deepMerge 会从默认值补齐缺失键；但若老存档恰好残留同名「非对象」
       字段，仍需归一化，否则渲染端读到 undefined → NaN 几何 / NaN 透明度。 */
    (function () {
      ['subLatCircle', 'subLonCircle'].forEach(function (k) {
        const c = state.style.ln[k], def = STYLE_DEF.ln[k];
        if (!c || typeof c !== 'object' || Array.isArray(c)) state.style.ln[k] = JSON.parse(JSON.stringify(def));
        else Object.keys(def).forEach(function (kk) { if (c[kk] === undefined) c[kk] = def[kk]; });
      });
    })();
    Object.keys(state.note.cats).forEach(function (k) {          // v15.0：字体可逐分类自定义
      if (state.note.cats[k].font === undefined) state.note.cats[k].font = null;
    });
    /* v23.1（需求②）：「地方时刻」的 24 个时刻点（四个主时刻 0/6/12/18 + 其余二十个整点）
       每次加载一律强制回默认隐藏 —— 不管存档里存的是 true 还是 false。
       理由：这两个开关此前只在「默认值」层面是关的，用户一旦点开过，deepMerge 就会把
       true 存档下来，下次打开又会自动显示，与「默认不显示、点击开关才显示」不符。
       这里在恢复存档之后、UI 绑定之前统一压回 false，等于把它变成「会话级开关」：
       当前会话点了就显示，重新打开回到默认隐藏。
       想「一打开就带时刻点」用分享参数 #hourmark=main / rest / all —— 它在更晚的
       URL 解析阶段现场置位（见 init 里的 hourmark 分支），不受本处影响。 */
    if (state.style.pt) {
      if (state.style.pt.hourMain) state.style.pt.hourMain.on = false;
      if (state.style.pt.hourRest) state.style.pt.hourRest.on = false;
    }
    /* v29（需求⑤）：近日点 / 远日点标记点大小的**语义**由「半径」改为「倍率」
       （旧的滑块区间 20~400、默认 1.1；新的区间 0.2~3、默认 1.0，与二分二至标记一致）。
       旧 v28 存档里存的 1.1 在新语义下会让该点比二分二至点大 10%，需一次性归一化回 1.0。
       用 style.__v 作幂等标记：仅对「首次升到 v29」的存档执行，升级后用户在滑块上主动
       设置的同名数值（哪怕正好是 1.1）不会再被覆盖。 */
    if (!st || typeof st.__v !== 'number' || st.__v < 2) {
      if (state.style.pt && state.style.pt.apsis) state.style.pt.apsis.size = 1.0;
      state.style.__v = 2;
    }
    const ui = lsGet(LS_UI);
    if (ui && ui.panel) state.ui.panel = deepMerge(JSON.parse(JSON.stringify(DEFAULTS.ui.panel)), ui.panel);
    /* v31（需求十七）：UI 色系 / 毛玻璃。旧存档没有 theme 字段 → 回落到默认（原色系）；
       并且无条件做一次类型与取值归一化（色系必须是已知 id，数值必须落在滑块区间内），
       否则脏存档会让 data-ui 变成未知值、整套主题变量失效。 */
    if (ui && ui.theme) state.ui.theme = deepMerge(JSON.parse(JSON.stringify(DEFAULTS.ui.theme)), ui.theme);
    /* v31（需求八）：悬浮窗几何 —— 纯扁平 map（{x,y,w,h,collapsed}），直接整体取回即可。 */
    if (ui && ui.mvLayout && typeof ui.mvLayout === 'object' && !Array.isArray(ui.mvLayout)) {
      state.ui.mvLayout = ui.mvLayout;
    }
    (function () {
      const th = state.ui.theme, SCHEMES = ['default', 'teal', 'green', 'amber', 'violet', 'rose', 'graphite'];
      if (SCHEMES.indexOf(th.scheme) < 0) th.scheme = 'default';
      th.glass = clamp(Math.round(+th.glass || 88), 20, 100);
      th.blur = clamp(Math.round(+th.blur || 0) || 14, 0, 40);
      /* ★ v44（需求一）：浅色 / 深色模式与「两种模式各自的面板底色 / 文字色」归一化。
         老存档没有这四个键（deepMerge 已按 DEF 补齐）或存了非法值（脏存档 / 手改
         localStorage）时，一律回落到默认，避免 data-mode 变成未知值、整套变量失效。 */
      if (th.mode !== 'dark') th.mode = 'light';
      const HEXOK = function (v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); };
      if (!HEXOK(th.lightPanel)) th.lightPanel = DEFAULTS.ui.theme.lightPanel;
      if (!HEXOK(th.darkPanel)) th.darkPanel = DEFAULTS.ui.theme.darkPanel;
      if (!HEXOK(th.lightInk)) th.lightInk = DEFAULTS.ui.theme.lightInk;
      if (!HEXOK(th.darkInk)) th.darkInk = DEFAULTS.ui.theme.darkInk;
    })();
    /* v31（需求七 / 八）：三个新增的「对象型」字段 —— volShaft / rayVert / mvWin。
       deepMerge 会用默认值补齐缺失键；但若老存档残留同名「非对象」字段（或某键类型不对），
       渲染端会读到 undefined → NaN 几何 / NaN 透明度（整组不可见）。这里无条件归一化。 */
    (function () {
      function obj(o, def) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return JSON.parse(JSON.stringify(def));
        Object.keys(def).forEach(function (k) { if (o[k] === undefined) o[k] = def[k]; });
        return o;
      }
      state.volShaft = obj(state.volShaft, DEFAULTS.volShaft);
      state.volShaft.intensity = clamp(+state.volShaft.intensity || 0, 0, 100);
      state.volShaft.op = clamp(+state.volShaft.op || 0, 0, 100);
      state.volShaft.dia = clamp(+state.volShaft.dia || 100, 60, 400);
      /* v37（需求一·3）：外围光束范围（100–320%）与光柱颜色归一化 ——
         老存档没有这两个键时按 DEF 补默认（obj() 已补），这里再夹取 / 校验一遍。 */
      state.volShaft.glow = clamp(+state.volShaft.glow || 160, 100, 320);
      if (typeof state.volShaft.color !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(state.volShaft.color)) {
        state.volShaft.color = DEFAULTS.volShaft.color;
      }
      /* v35（需求一）：旧档残留的 edge / diffuse 已无消费点，直接剥离；
         太阳光线（rays）与体积光柱按需求**无条件强制默认关闭** —— 升级后首屏不显示太阳光。 */
      delete state.volShaft.edge;
      delete state.volShaft.diffuse;
      state.volShaft.on = false;
      state.rays = false;
      state.rayVert = obj(state.rayVert, DEFAULTS.rayVert);
      state.rayVert.n = clamp(Math.round(+state.rayVert.n) || 5, 3, 25);   // 上限 25 = RAY_VMAX + 1（此处早于其声明，故写字面量）
      state.mvWin = obj(state.mvWin, DEFAULTS.mvWin);
      Object.keys(DEFAULTS.mvWin).forEach(function (k) { state.mvWin[k] = !!state.mvWin[k]; });
    })();
  })();

  /* ======== 文字注释分类（v5.0）：集中式状态 · 全局 / 分级控制 ======== */
  const NOTE_CATS = [
    ['axis', '地轴注释', '地轴两端的 N / S 极标注'],
    ['zone', '温度带注释', '热带 / 北温带 / 南温带 / 北寒带 / 南寒带 五带名称'],
    ['lat', '特殊纬度注释', '赤道 / 南北回归线 / 南北极圈'],
    ['dawn', '晨线标注', '晨线（夜→昼分界）位置标注'],
    ['dusk', '昏线标注', '昏线（昼→夜分界）位置标注'],
    ['tz', '时区注释', '东八区 UTC+8 等 24 个时区的名称标注'],
    ['hourMain', '地方时特殊时刻标注', '赤道 0 / 6 / 12 / 18 时四个主时刻'],
    ['hourRest', '其他地方时标注', '赤道其余 20 个整点时刻'],
    ['terms', '二分二至位置', '春分 / 夏至 / 秋分 / 冬至 轨道位置标签'],
    ['terms24', '剩余二十节气标注', '清明 / 谷雨 等其余二十个节气标签'],
    ['orbit', '公转轨道注释', '「公转轨道」轨道名称标注（公转视图）'],
    ['ray', '太阳光标注', '「太阳光」文字标注'],
    ['pts', '点标注注释', '点标注的 A / B / C… 注释文字'],
    ['misc', '其他标注', '未归入以上分类的文字注释'],
    ['pd', '极昼区注释', '极昼区（太阳终日不落）区域名称'],
    ['pn', '极夜区注释', '极夜区（太阳终日不出）区域名称'],
    ['ecl', '黄道面注释', '黄道面名称标注'],
    ['equ', '赤道面注释', '赤道面名称标注'],
    // v26.1（需求⑨）：四组区域面要素的注记分类
    ['hemiEW', '东西半球注释', '东半球 / 西半球 名称'],
    ['hemiNS', '南北半球注释', '北半球 / 南半球 名称'],
    ['latBelt', '低中高纬度注释', '低纬度 / 中纬度 / 高纬度 名称'],
    // v28（需求③）：公转速度演示的文字标注（近日点 / 远日点 + 扇形面积 + 面积速度）
    ['spd', '公转速度注释', '近日点 / 远日点位置、各扇形扫过的面积、面积速度 dA/dt'],
  ];
  /* ---- 字重 / 对齐：与字号、颜色一样属于「全局文字注释」统一管的样式 ---- */
  const NOTE_WEIGHTS = [
    ['300', '细体'], ['400', '常规'], ['500', '中等'], ['600', '半粗'], ['700', '粗体'],
  ];
  const NOTE_ALIGNS = [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']];
  /* ---- v22.1：注释贴图一律白字 ----
     原先这里有一张「基础字色表」（NOTE_BASE / NOTE_BASE_INST / noteBaseColor()）：
     每个分类把各自的本色（'#ffd23f' 金、'#7dd3fc' 蓝 …）直接**烘焙进文字贴图**，
     再由 material.color（= noteStyleFor().color，默认白）做乘法染色 ——
     白色染色 × 彩色贴图 = 仍是彩色，于是「颜色为白色」这个全局默认永远不会生效。
     现在贴图一律画白色，最终颜色完全由 st.color（全局/分类叠加色）决定：
     默认即白，用户改颜色（全局或任意分类）也照常生效。 */
  /* 取某条注释的最终样式（v8.0 / v20.0 修订）：
     优先级 全局总控 > 分类；分类未自定义则向上回落到全局。
     key 为注释实例标识（如 'R.lat.eq'、'tz8'）—— 原 v8.0 用于取「实例本色」，
     v22.1 起贴图一律白字、本色表已删，key 不再参与任何样式解析：
    v16.0 的「单条注释实例」面板已在 v20.0 移除，无写入方即为死路，故删除。 */
  /* v22.0（修复）：这两个分类在显示设置菜单里**没有「分类开关」**（即没有任何控件写
     note.cats.lat.on / note.cats.zone.on），它们的显隐完全由上游开关决定：
       lat  → 经纬网 › 文字注释 › 经度 / 纬度 / 特殊经纬线（grat.note.*）
       zone → 温度带 › 文字注释 › 各带（zones.note.*）
     而 v21.0 把 note.cats 各分类的 on 统一改成 false（默认全关）之后，
     noteStyleFor 里那句 `c.on !== false` 对这两个分类就成了「永远为假」——
     表现即「经纬网文字注释 / 温度带文字注释怎么开都不显示、开关像是失灵」。
     因此这里对「没有分类开关」的分类豁免该项判定。
     判定依据是 menu.js 里的三处写法：noteGrp 的 swId 为 null（该组没有自己的开关），
     且外层分组用的是 grat.note.on / zones.note.on 这类**另一套**状态路径，
     而不是 note.cats.<cat>.on。对照：axis 分类的分类开关挂在「南北极注释」分组上
     （sw: 'cbAxisNote'、swPath: 'note.cats.axis.on'），所以它**不在**这份豁免名单里。 */
  /* v25.1（需求⑦）：时差演示的「要素键 → 注释分类」对照表。
     五个要素（tz0 中时区 / idl 国际日期变更线 / zero 0 时经线 / newDay 新的一天 / oldDay 旧的一天）
     各带一条注记，且菜单里各有独立的样式组 —— 所以注释分类必须逐条独立（tzdiffTz0 …）。 */
  const TZDIFF_NOTE_CAT = { tz0: 'tzdiffTz0', idl: 'tzdiffIdl', zero: 'tzdiffZero',
                            newDay: 'tzdiffNew', oldDay: 'tzdiffOld' };
  const CAT_NO_SELF_SW = { lat: 1, zone: 1, sea: 1, cont: 1,
                           tzdiffTz0: 1, tzdiffIdl: 1, tzdiffZero: 1, tzdiffNew: 1, tzdiffOld: 1,
                           gcdDist: 1, gcdEnd: 1,     // v25.1（需求⑧）：显隐由 gcd.note.dist / end 控制
                           // v26.1（需求⑨）：三组区域面注记 —— 显隐由 hemi.* / latbelt 的 note.* 控制
                           hemiEW: 1, hemiNS: 1, latBelt: 1 };
  /* ===== v23.9：各注释分类的「固有样式」NOTE_CAT_DEF =====
     语义：分类**自身**的属性值 —— 即「不处于统一控制下、且用户尚未单独自定义」时，
       该条注释本来就该有的样子（尺寸 / 颜色 / 透明度 / 字重 / 对齐 / 字体）。
     为什么必须有它：v23.5 起「是否统一」由 note.unifyAttrs.*（逐属性分开关）判定，
       分开关关闭时要求「恢复并展示其自身的独立属性值」。此前该回退目标写成了全局
       master 值 —— 而各分类的 note.cats[cat].* 出厂全是 null，于是关闭分开关后
       取到的仍是全局值，界面上看不出任何变化（表现为「关掉开关没反应 / 回退不正确」）。
     取值依据：字号按「每类注释的文本长度与重要度」定基准（短标签大、长串小），
       统一开启时（默认）全部收敛到 master.size，故默认观感不变；只有用户主动关掉
       「统一字号」后，各类注释才会回到这里各自的大小（颜色即 v23.5 的「本色」）。 */
  const NOTE_CAT_DEF = {
    axis:     { size: 0.66, color: '#E9D5FF', op: 1, weight: '700', align: 'center', font: 'default' },  // 南北极 N/S
    lat:      { size: 0.55, color: '#7DD3FC', op: 1, weight: '700', align: 'center', font: 'default' },  // 经纬度 / 特殊纬线
    zone:     { size: 0.62, color: '#FCA5A5', op: 1, weight: '700', align: 'center', font: 'default' },  // 温度带
    dawn:     { size: 0.60, color: '#FDE68A', op: 1, weight: '700', align: 'center', font: 'default' },  // 晨线
    dusk:     { size: 0.60, color: '#FDBA74', op: 1, weight: '700', align: 'center', font: 'default' },  // 昏线
    tz:       { size: 0.48, color: '#6EE7B7', op: 1, weight: '700', align: 'center', font: 'default' },  // 时区名（长串）
    hourMain: { size: 0.70, color: '#FEF08A', op: 1, weight: '700', align: 'center', font: 'default' },  // 主时刻 0/6/12/18
    hourRest: { size: 0.52, color: '#FDE68A', op: 1, weight: '700', align: 'center', font: 'default' },  // 其余整点
    terms:    { size: 0.66, color: '#F0ABFC', op: 1, weight: '700', align: 'center', font: 'default' },  // 二分二至
    terms24:  { size: 0.46, color: '#F5D0FE', op: 1, weight: '700', align: 'center', font: 'default' },  // 其余二十节气
    orbit:    { size: 0.62, color: '#FCD34D', op: 1, weight: '700', align: 'center', font: 'default' },  // 公转轨道名
    ray:      { size: 0.62, color: '#FFE38A', op: 1, weight: '700', align: 'center', font: 'default' },  // 太阳光线
    pts:      { size: 0.56, color: '#93C5FD', op: 1, weight: '700', align: 'center', font: 'default' },  // 点标注
    misc:     { size: 0.55, color: '#E5E7EB', op: 1, weight: '700', align: 'center', font: 'default' },  // 其他
    pd:       { size: 0.62, color: '#BFDBFE', op: 1, weight: '700', align: 'center', font: 'default' },  // 极昼区
    pn:       { size: 0.62, color: '#C7D2FE', op: 1, weight: '700', align: 'center', font: 'default' },  // 极夜区
    ecl:      { size: 0.58, color: '#FDA4AF', op: 1, weight: '700', align: 'center', font: 'default' },  // 黄道面
    equ:      { size: 0.58, color: '#86EFAC', op: 1, weight: '700', align: 'center', font: 'default' },  // 赤道面
    sea:      { size: 0.54, color: '#7FD1FF', op: 1, weight: '700', align: 'center', font: 'default' },  // v25.1：四大洋
    cont:     { size: 0.60, color: '#F5D08A', op: 1, weight: '700', align: 'center', font: 'default' },  // v25.1：七大洲
    // v25.1（需求⑦）：时差演示的 5 条注记 —— 颜色与该要素在球面上的颜色一致（表里如一）
    tzdiffTz0:  { size: 0.50, color: '#7FD1FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 中时区（面蓝）
    tzdiffIdl:  { size: 0.48, color: '#FF8A66', op: 1, weight: '700', align: 'center', font: 'default' }, // 国际日期变更线（红）
    tzdiffZero: { size: 0.48, color: '#FFD23F', op: 1, weight: '700', align: 'center', font: 'default' }, // 0 时经线（黄）
    tzdiffNew:  { size: 0.52, color: '#FFB08A', op: 1, weight: '700', align: 'center', font: 'default' }, // 新的一天（橙）
    tzdiffOld:  { size: 0.52, color: '#9DB8F5', op: 1, weight: '700', align: 'center', font: 'default' }, // 旧的一天（蓝）
    /* v25.1（需求⑧）：球面最短距离 —— 距离标注用与劣弧同色（洋红，表里如一），
       端点 A / B 用与端点小球同色；距离标注是多行长文本，固有字号略小。 */
    gcdDist:    { size: 0.50, color: '#FF7AC0', op: 1, weight: '700', align: 'center', font: 'default' }, // 最短距离
    gcdEnd:     { size: 0.56, color: '#FF4FA3', op: 1, weight: '700', align: 'center', font: 'default' }, // 端点 A / B
    /* v26.1（需求⑨）：四组区域面注记 —— 本色与各自区域面的填充色呼应，便于「表里如一」地对上。 */
    hemiEW:     { size: 0.60, color: '#FFD166', op: 1, weight: '700', align: 'center', font: 'default' }, // 东 / 西半球
    hemiNS:     { size: 0.60, color: '#7DD3FC', op: 1, weight: '700', align: 'center', font: 'default' }, // 南 / 北半球
    latBelt:    { size: 0.56, color: '#A7F3D0', op: 1, weight: '700', align: 'center', font: 'default' }, // 低 / 中 / 高纬度
    // v27.0（需求一）：标记文本 —— 本色与「文字注释」分组一致（黄），字号基准略小（多行长文本）
    markText:   { size: 0.50, color: '#1F2937', op: 1, weight: '700', align: 'center', font: 'default' },
    /* v28（需求③）：公转速度演示的标注 —— 与扇形的两种颜色呼应（当前时刻蓝 / 对比扇形橙），
       日期与距离连写，字号基准略小。 */
    spd:        { size: 0.48, color: '#CFE3FF', op: 1, weight: '700', align: 'center', font: 'default' },
    /* ★ v32（需求六）：太阳视运动模块的各要素注释类型 ——
       它们与主模块共用同一套「全局文字样式」体系（master / unifyAttrs / cats），
       因此既能被「全局统一 ××」统一管理，也能在太阳视运动的
       「全局文字样式 › 各注释单独样式」里逐个自定义。
       size 是「世界基准宽度」，与 UNIFY_W = 0.62 同量纲（0.62 ≈ 倍率 1.00）。 */
    svSun:      { size: 0.62, color: '#FFE9B0', op: 1, weight: '700', align: 'center', font: 'default' }, // 太阳
    svTraj:     { size: 0.62, color: '#FFE9B0', op: 1, weight: '700', align: 'center', font: 'default' }, // 轨迹时刻 / 日出日落
    svHour:     { size: 0.62, color: '#FFE9B0', op: 1, weight: '700', align: 'center', font: 'default' }, // 整点时刻
    /* ★ v52（太阳需求4）：二分二至轨迹名称注释**独立分类** —— 此前与 svTraj（当日轨道 /
       日出日落中天）共用，导致「文字注释 › 二分二至」与「日出日落中天」改一处两处同步。
       现拆出 svTerm4，三者（svTraj / svHour / svTerm4）与影长数值（svMeasL）各自独立可调。 */
    svTerm4:    { size: 0.62, color: '#FFE9B0', op: 1, weight: '700', align: 'center', font: 'default' }, // 二分二至轨道名称
    svHrLine:   { size: 0.62, color: '#9FF0BF', op: 1, weight: '700', align: 'center', font: 'default' }, // 地平圈
    svHrPlane:  { size: 0.62, color: '#8FD6A8', op: 1, weight: '700', align: 'center', font: 'default' }, // 地平面
    svEqu:      { size: 0.62, color: '#7FD8FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 天赤道
    svEquPlane: { size: 0.62, color: '#6CB8E8', op: 1, weight: '700', align: 'center', font: 'default' }, // 天赤道平面
    svPoleN:    { size: 0.62, color: '#E6F0FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 天北极
    svPoleS:    { size: 0.62, color: '#E6F0FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 天南极
    svZen:      { size: 0.56, color: '#E6F0FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 天顶
    svNad:      { size: 0.56, color: '#E6F0FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 天底
    svHrDir:    { size: 0.62, color: '#BFF0CF', op: 1, weight: '700', align: 'center', font: 'default' }, // 地平圈方位
    /* ★ v41（需求一·12）：物影的三条注释各自成组 ⇒ 各自一个分类，可分别设字号 / 字色。
       svMeas = 物体高度，svMeasL = 影长数值，svMeasA = 太阳高度角。 */
    svMeas:     { size: 0.62, color: '#FFE3A8', op: 1, weight: '700', align: 'center', font: 'default' }, // 物影·物体高度
    svMeasL:    { size: 0.62, color: '#FFD8A0', op: 1, weight: '700', align: 'center', font: 'default' }, // 物影·影长数值
    svMeasA:    { size: 0.62, color: '#A8D8FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 物影·太阳高度角
    svObs:      { size: 0.62, color: '#FFD7D7', op: 1, weight: '700', align: 'center', font: 'default' }, // 观测点标签
    svIndoor:   { size: 0.62, color: '#E6F0FF', op: 1, weight: '700', align: 'center', font: 'default' }, // 室内注释
    /* ★ v43（一·6 / 三·2）：**东南西北方位文字**（地面方向文字 + 室内方位文字）——
       此前两者是 DOM 覆盖层，字号走「15px × dmark.size」这套孤立口径，完全不经过
       noteStyleFor ⇒ 「全局文字样式大小」对它们无效（用户报告「方位注释不受统一设置」）。
       现给它们一个正式分类，size 仍是世界基准宽度（0.62 = 倍率 1.00），
       由 applyDirTextStyle 换算成 DOM 像素。 */
    svDirMark:  { size: 0.62, color: '#FFFFFF', op: 1, weight: '400', align: 'center', font: 'default' }, // 方位文字
  };
  /* 取某分类某属性的固有值（表中缺项则回落全局默认） */
  function catDef(cat, key, masterDefault) {
    const d = NOTE_CAT_DEF[cat];
    if (d && d[key] !== undefined && d[key] !== null) return d[key];
    return masterDefault;
  }
  /* ★ v32（需求六）+ 本次修复（缺陷 A / B，根因）：为各注释分类（含 14 个 sunview 分类
     sv* 与标记文本 markText）预置「独立属性值」，确保 state.note.cats 始终具备**全部分类**。
     这样「全局文字样式 › 各注释单独样式」里的控件一打开就显示该注释的真实取值，
     「统一 ××」关闭时也能精确回落到分类本色 / 本字号，而不是空值（显示成 0 / 细体）。
     （注意：本函数不能放进 restoreSaved —— 那是模块顶部的 IIFE，此刻 NOTE_CAT_DEF 尚未初始化，TDZ。）
     此前的做法有二：
       · 缺陷 B：sv* 只写进 state（DEFAULTS.note.cats 里没有），而
         resetAllSettings / #preReset / #btnResetAll 都是
         `Object.assign(state, JSON.parse(JSON.stringify(DEFAULTS)))` ——
         重置把 state.note 整体换成**不含 sv* 分类**的新对象，于是 sunview 侧
         `@note.cats.<svCat>.*` 的绑定器（sunview.js 的 svNoteGrp：size/font/color/op/weight）
         读 BR.noteGet('cats.<svCat>.font') → getPath 落到 undefined 上再取属性会抛
         TypeError: Cannot read properties of undefined (reading 'font'/'color'/'op'/'weight')。
       · 缺陷 A：标记文本分类 markText 只在运行时按需懒建，菜单叶子控件 ncMarkTextOn
         （path = note.cats.markText.on）在 bindMenuLeaf 的通用绑定器里读
         getPath(state, 'note.cats.markText.on') 时前缀尚不存在 → ... reading 'on'。
     统一收敛为一个**幂等**函数，数据源唯一为 NOTE_CAT_DEF，只在缺失时补齐、绝不覆盖已有值。
     调用点（时序缺一不可，见各处注释）：
       ① 模块初始化（此处立即执行一次）；
       ② 菜单绑定 bindMenuTree 之前；
       ③ resetAllSettings 里 deep copy DEFAULTS 赋值之后、applyPanelFont 之前。 */
  function ensureNoteCats() {
    const cats = state.note.cats || (state.note.cats = {});
    const defCats = DEFAULTS.note.cats || (DEFAULTS.note.cats = {});
    Object.keys(NOTE_CAT_DEF).forEach(function (k) {
      const d = NOTE_CAT_DEF[k];
      const isSv = k.indexOf('sv') === 0;
      /* ① 分类整条缺失 → 新建。sv* 用 NOTE_CAT_DEF 的固有值（sunview 控件需要可读的
         真实初值，且「统一 ××」关闭时能精确回落本类本色 / 本字号）；其余沿用出厂 null
         形状（size/color/op/weight = null 表示「跟随全局」，与 DEFAULTS 里各分类同构）。 */
      if (!cats[k]) {
        cats[k] = isSv
          ? { on: false, size: d.size, color: d.color, op: d.op, weight: d.weight, align: d.align, font: d.font }
          : { on: false, size: null, color: null, op: null, weight: null, align: null, font: null };
      }
      /* ② sv* 字段级补齐：sunview 绑定器直接读取 .font/.color/.op/.weight，null/undefined 即抛错 */
      if (isSv) {
        const c = cats[k];
        if (c.size == null) c.size = d.size;
        if (c.color == null) c.color = d.color;
        if (c.op == null) c.op = d.op;
        if (c.weight == null) c.weight = d.weight;
        if (c.align == null) c.align = d.align;
        if (c.font == null) c.font = d.font;
      }
      /* ③ DEFAULTS 侧补齐：使「初始化时 state 的形状」与「重置时 deep copy DEFAULTS 的
         形状」完全一致 —— 各重置路径自动带上完整分类（三处调用中 ③ 只需生效一次即可）。 */
      if (!defCats[k]) {
        defCats[k] = isSv
          ? { on: false, size: d.size, color: d.color, op: d.op, weight: d.weight, align: d.align, font: d.font }
          : { on: false, size: null, color: null, op: null, weight: null, align: null, font: null };
      }
    });
    return cats;
  }
  /* ① 初始化：位于 restoreSaved（state.note 可能被存档深合并替换）之后、任何菜单 / 控件
     绑定之前，先原地补齐一次。此处用 IIFE 之外的普通调用，函数声明已提升、可被后文复用。 */
  ensureNoteCats();
  function noteStyleFor(cat, key) {
    const m = state.note.master;
    if (!state.note.cats[cat]) state.note.cats[cat] = { on: false, size: null, color: null, op: null, weight: null, align: null, font: null };
    const c = state.note.cats[cat];
    const pick = function (b, d) { return (b != null) ? b : d; };
    // v23.5：每个注释文字属性各自独立的「统一开关」(note.unifyAttrs) —— 它才是「是否统一」
    //   的真正判据：为 true 的属性取全局 master 值；为 false 的属性恢复为统一前的原有值
    //   （分类自定义值，无自定义则回落全局默认 / 分类本色）。总开关(note.unify)只是一个
    //   「一键全部开启分开关」的便捷按钮，不直接参与这里的判定。
    const ua = state.note.unifyAttrs || { size: true, color: false, op: false, font: false, weight: false, align: false };
    const U = function (k) { return !!ua[k]; };
    const dColor = m.color || '#FFFFFF', dWeight = m.weight || '400',
          dAlign = m.align || 'center', dFont = m.font || 'default';
    /* v23.9（根因修复）：分开关关闭（该属性不统一）时，回退目标是**分类自身的独立值** ——
       优先取用户在该分类菜单里设过的 note.cats[cat][k]，否则取该分类的固有值
       NOTE_CAT_DEF[cat][k]（颜色即 v23.5 的「本色」）。
       此前这里回退的是全局 master 值，而分类的 cats[cat][k] 出厂全为 null，
       于是「关掉统一 X」取到的仍是全局值 —— 界面上毫无变化，即用户报告的
       「属性控制失效 / 数值回退不正确」。 */
    const own = function (k, mDefault) { return pick(c[k], catDef(cat, k, mDefault)); };
    return {
      show: !!m.on && (CAT_NO_SELF_SW[cat] || c.on !== false) && !catGateOff(cat),
      size: U('size') ? m.size : own('size', m.size),
      color: U('color') ? dColor : own('color', dColor),
      op: U('op') ? clamp(m.op == null ? 1 : m.op, 0, 1) : clamp(own('op', m.op == null ? 1 : m.op), 0, 1),
      weight: U('weight') ? dWeight : own('weight', dWeight),
      align: U('align') ? dAlign : own('align', dAlign),
      font: U('font') ? dFont : own('font', dFont),
      // 各分类的「是否自定义」，供面板显示「跟随 / 自定义」
      custom: c.size != null,
      customCat: c.size != null,
    };
  }
  /* v15.0 分组级注释总开关：菜单里「文字注释」这一级的 ☑️ 关闭时，
     其下所有分类的注释一并隐藏（与各分类自身开关为「与」关系）。 */
  const CAT_GATE = {
    hourMain: 'hourNote', hourRest: 'hourNote',
    terms: 'termsNote', terms24: 'termsNote',
    ecl: 'obliqNote', equ: 'obliqNote',
  };
  function catGateOff(cat) {
    const g = CAT_GATE[cat];
    if (!g) return false;
    const o = state[g];
    return !!(o && o.on === false);
  }
  // v20.0 清理：原 v16.0 的 noteInst() / noteInstReset() 两个工具函数（按需创建 / 清空单条注释实例）
  // 已无任何调用点，且「单条注释实例」面板在 v20.0 一并移除，故整块删除。
  /* ---- 文字注释字体：默认「系统默认」= 跟随操作系统界面字体（微软雅黑 / 苹方 / Noto），
     字形饱满、粗体为真实字重 —— 比宋体的「伪粗体」更清晰美观，中英混排也统一。
     仍保留宋体 / 黑体 / Times New Roman 供需要传统排版的场景切换。 ---- */
  // canvas 上 font 家族一旦为空字符串，整条 font 声明会失效、退回 10px 默认字体 —— 必须有兜底字族
  const CANVAS_FALLBACK_FONT = 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",Arial,sans-serif';
  const NOTE_FONTS = [
    ['default', '系统默认', CANVAS_FALLBACK_FONT],
    ['both', '宋体 / Times New Roman', '"SimSun","宋体","Times New Roman",Times,serif'],
    ['simsun', '宋体', '"SimSun","宋体",serif'],
    ['hei', '黑体', '"SimHei","黑体","Microsoft YaHei",sans-serif'],
    ['times', 'Times New Roman', '"Times New Roman",Times,serif'],
  ];
  /* 面板文字字体（v14.0）：作用于所有显示面板 / 菜单 / 窗口标题，不含地球上的注释。
     首项保留系统默认界面字体，便于一键回到原始观感。 */
  const PANEL_FONTS = [
    ['default', '系统默认', ''],
    ['both', '宋体 / Times New Roman', '"SimSun","宋体","Times New Roman",Times,serif'],
    ['simsun', '宋体', '"SimSun","宋体",serif'],
    ['hei', '黑体', '"SimHei","黑体","Microsoft YaHei",sans-serif'],
    ['times', '新罗马字体（Times New Roman）', '"Times New Roman",Times,serif'],
  ];
  function panelFontCss(id) {
    for (let i = 0; i < PANEL_FONTS.length; i++) if (PANEL_FONTS[i][0] === id) return PANEL_FONTS[i][2];
    return PANEL_FONTS[0][2];
  }
  // 把面板文字样式写入 CSS 变量：字体 / 字号倍率 / 颜色（含透明度）
  // 颜色只覆盖 --ink / --ink-dim / --ink-faint 三个「文字色」变量，不影响边框与背景
  function applyPanelFont() {
    const p = state.ui.panel, r = document.documentElement;
    const fam = panelFontCss(p.font);
    if (fam) r.style.setProperty('--ui-font', fam);
    else r.style.removeProperty('--ui-font');
    r.style.setProperty('--ui-fs', String(p.size));
    // v21.0（需求⑪）：面板文字「字重」要真正作用到显示设置面板 / 浮层 / 窗口标题的
    //   全部文字上 —— 光改基准字重不行（标题、分组名、读数此前把 600 / 700 写死在 CSS 里）。
    //   这里由所选等级推出「中粗 / 加粗」两档，CSS 中对应的 600 / 700 / 800 已改为读这两个变量。
    const fw = parseInt(p.weight, 10) || 400;
    const step100 = function (v) { return String(Math.min(900, Math.max(100, Math.round(v / 100) * 100))); };
    r.style.setProperty('--ui-fw', step100(fw));
    r.style.setProperty('--ui-fw-m', step100(Math.max(fw + 150, fw * 1.25)));
    r.style.setProperty('--ui-fw-b', step100(Math.max(fw + 300, fw * 1.6)));
    const hex = p.color || '#1E293B';
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const a = function (k) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (p.op * k).toFixed(3) + ')'; };
    r.style.setProperty('--ink', a(1));
    r.style.setProperty('--ink-dim', a(0.72));
    r.style.setProperty('--ink-faint', a(0.52));
    /* ★ v35（需求十七）：两处「面板文字样式设置」双向同步 —— 主模块侧改动后，
       太阳侧「全局文字样式 › 面板文字样式设置」的控件读数立即跟随（反之由
       BR.panelSet → runAllBinders 完成另一方向）。applyPanelFont 是两侧 ui.panel
       改动的共同汇聚点，在此挂一次即可全覆盖。 */
    /* ★ v44（需求一）：面板文字色就是「当前模式」的文字色 —— 用户在此处改颜色时同步写回
       theme.lightInk / darkInk，切到另一种模式再切回来仍是他自己设定的值。
       主题自身写入时由 _uiThemeApplying 抑制；首次 applyUiTheme 之前不写（避免默认色被固化）。 */
    if (_uiThemeApplied && !_uiThemeApplying) {
      const k = (state.ui.theme.mode === 'dark') ? 'darkInk' : 'lightInk';
      if (state.ui.theme[k] !== hex) state.ui.theme[k] = hex;
    }
    if (window.__svSyncBinders) { try { window.__svSyncBinders(); } catch (e) { } }
    /* ★ v62（需求 3）：面板字号倍率（--ui-fs）一变，太阳侧「观测点与时间控制」面板的宽度
       也必须同比缩放（该面板宽 = 占屏宽比例 × 字号倍率，见 sunview.css 的 clamp 与
       sunview.js 的 fitTimeBarScale）—— 否则要等到下一次窗口 resize / 面板显隐才生效。 */
    if (window.__svRefitTimeBar) { try { window.__svRefitTimeBar(); } catch (e) { } }
  }
  /* v31（需求十七）：UI 色系与半透明毛玻璃 ——
     · scheme → body[data-ui]（style.css 里覆写主题变量：强调色 / 卡片底色 / 边框 / 阴影）；
     · glass  → :root 的 --glass-a（卡片底色不透明度）；
     · blur   → :root 的 --glass-blur（毛玻璃模糊半径）。
     三者都由「设置 › 界面与主题」实时写入，因此切换色系 / 拖动滑块立刻见效。 */
  /* ★ v32（需求三）：「面板背景不透明度」要**同时**作用到卡面、卡头、内部浮层菜单、
     按钮 / 分段控件 —— 此前只有一个 --glass-a 且仅被 .card 引用，卡头 / 浮层 / 按钮
     全是写死的近白色，拖动滑块时「只有卡身变透明」，观感割裂。
     这里按 base 值派生出若干档位变量（卡头略更实、浮层略更透、控件居中），
     全部由 CSS 引用 ⇒ 一处拖动，整块 UI 一起变。 */
  /* ★ v44（需求一）：主题计算用的小工具 —— 十六进制解析 / 混合。
     「浅色模式」的面板底色默认 #f2f7ff（浅蓝白），再按当前「色系」淡染 45%，
     于是换色系时面板底色仍有细微差别（保留 v31 的观感），但明暗两套模式各有一套底色。 */
  function hexOk(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mixHex(a, b, t) {
    if (!hexOk(a)) a = '#ffffff';
    if (!hexOk(b)) return a;
    const A = hexRgb(a), B = hexRgb(b);
    const c = A.map(function (v, i) { return Math.round(v + (B[i] - v) * clamp(t, 0, 1)); });
    return '#' + c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }
  /* applyUiTheme 内部会改写 state.ui.panel.color（模式文字色 ⇄ 面板文字样式的唯一来源），
     这个标志用来阻止 applyPanelFont 把「刚被主题写进去的值」再当成用户自定义值回写。 */
  let _uiThemeApplying = false, _uiThemeApplied = false;
  function uiModeKey(k) { return (state.ui.theme.mode === 'dark') ? ('dark' + k) : ('light' + k); }
  function applyUiTheme() {
    const t = (state.ui && state.ui.theme) || DEFAULTS.ui.theme, r = document.documentElement;
    const body = document.body;
    const dark = (t.mode === 'dark');
    if (body) {
      body.dataset.ui = t.scheme || 'default';
      body.dataset.mode = dark ? 'dark' : 'light';
    }
    const g = clamp(+t.glass || 88, 20, 100) / 100;
    r.style.setProperty('--glass-a', g.toFixed(2));
    r.style.setProperty('--glass-head', Math.min(1, g + 0.09).toFixed(2));
    r.style.setProperty('--glass-fly', Math.min(1, Math.max(0.42, g + 0.04)).toFixed(2));
    r.style.setProperty('--glass-ctl', Math.min(1, Math.max(0.30, g * 0.94)).toFixed(2));
    r.style.setProperty('--glass-blur', clamp(Math.round(+t.blur || 0), 0, 40) + 'px');
    /* ---------- v44（需求一）：面板底色 ----------
       色系淡染值由 CSS 的 `body[data-ui=…] { --scheme-tint: … }` 单点提供（不在 JS 里再抄一遍
       十六进制，避免两处不一致）；先写 data-ui 再读计算值即可拿到。 */
    let tint = '#ffffff';
    if (body) {
      try { tint = (getComputedStyle(body).getPropertyValue('--scheme-tint') || '').trim() || '#ffffff'; } catch (e) { }
      if (!hexOk(tint)) tint = '#ffffff';
    }
    const base = hexOk(dark ? t.darkPanel : t.lightPanel)
      ? (dark ? t.darkPanel : t.lightPanel)
      : (dark ? DEFAULTS.ui.theme.darkPanel : DEFAULTS.ui.theme.lightPanel);
    const panel = dark ? base : mixHex(base, tint, 0.45);
    /* ★ 本批次修复 #269（深色模式面板底色不跟随）：--panel 定义在 :root 且内部嵌了
       var(--panel-rgb)。自定义属性的代入在**声明所在元素**（:root）就完成，body 上再写
       --panel-rgb 已经来不及 —— :root 的 --panel 早已用「默认白」冻结成
       rgba(255,255,255,.88)，于是深色模式下面板底色仍是白底、而文字已被 --ink 提亮成
       浅色 ⇒ 浅底浅字，整块面板读不出来（探针实测 cardBg=rgba(255,255,255,.88)）。
       修法：与 --glass-a 等一样写到 **documentElement**，让 :root 的 --panel 直接拿到
       当前模式的底色。（浅色模式同样受益：换色系时底色立刻跟着变。） */
    r.style.setProperty('--panel-rgb', hexRgb(panel).join(','));
    /* ---------- v44：面板文字色（模式文字色 → 面板文字样式，同一把尺） ---------- */
    const ink = dark
      ? (hexOk(t.darkInk) ? t.darkInk : DEFAULTS.ui.theme.darkInk)
      : (hexOk(t.lightInk) ? t.lightInk : DEFAULTS.ui.theme.lightInk);
    if (state.ui.panel.color !== ink) {
      _uiThemeApplying = true;
      state.ui.panel.color = ink;
      try { applyPanelFont(); } finally { _uiThemeApplying = false; }
    }
    _uiThemeApplied = true;
  }
  function fontCss(id) {
    for (let i = 0; i < NOTE_FONTS.length; i++) if (NOTE_FONTS[i][0] === id) return NOTE_FONTS[i][2];
    return NOTE_FONTS[0][2];
  }
  /* ★ v32（需求六）：全局文字样式变动后，通知太阳视运动模块同步刷新它自己的注记精灵
     （两边共用 state.note，但渲染在各自的 three 场景里）。sunview.js 后于本文件加载，
     这里一律做存在性判断。 */
  function notifyNoteChange() {
    if (window.SUNVIEW && window.SUNVIEW._refreshNotes) {
      try { window.SUNVIEW._refreshNotes(); } catch (e) { }
    }
  }
  // 某分类当前使用的 CSS font-family（供文字精灵绘制时取用）；空值兜底为标准系统无衬线字族
  function noteFontOf(cat, key) { return fontCss(noteStyleFor(cat || 'misc', key).font) || CANVAS_FALLBACK_FONT; }
  // 字体切换后强制全部文字精灵重绘（贴图上的字是烘焙进去的，必须重画）
  function invalidateNoteSprites() { textSprites.forEach(function (sp) { sp.userData.dpi = 0; }); }
  /* v23.9：把某个属性在各分类的「独立值」显式固化下来（未自定义的填为该分类固有值）。
     调用时机：该属性的「统一 X」分开关 由开 → 关（该属性退出统一控制）时。
     作用：① 让「独立属性值」真正被保存 —— 此前分类该属性留 null 表示「没有独立值」，
              回退时无值可用，只能落回全局值；
           ② 再次开启统一时**不覆盖**这些独立值，于是下次关闭即精确恢复用户自己的值，
              即「恢复并展示其自身的独立属性值（应用统一设置之前的数值）」。 */
  function materializeCatOwn(key) {
    const cats = state.note.cats || {};
    Object.keys(cats).forEach(function (cat) {
      const c = cats[cat];
      if (!c || c[key] != null) return;
      c[key] = catDef(cat, key, state.note.master[key]);
    });
  }
  /* v23.9：统一总开关 / 任一属性分开关切换后，立即刷新所有菜单控件的显示值与可用态。
     重点是各分类的「字号 / 字体 / 颜色 / 透明度 / 字重」控件：处于统一中的属性置灰并
     显示统一值，脱离统一后恢复可编辑并显示该分类自身的值 ——
     解决「开启统一后未能立即同步为统一设置的属性」以及「统一期间改动无效」的失效感。 */
  function refreshNoteCtlState() {
    binders.forEach(function (f) { try { f(); } catch (e) {} });
  }
  // 字号越大，画布分辨率越高（1× → 4×），保证放大后文字依然清晰不发虚
  /* 字号越大，画布分辨率越高（1× → 4×），保证放大后文字依然清晰不发虚。
     ★ v53（性能）：加入**滞回区间**（每一档的分界上下各留 12% 余量）。
     为什么需要：spriteDPI 只在「目标档位 ≠ 当前档位」时才重烘贴图，而拖动字号滑块时
     字号会反复跨过分界线 —— 每次跨档都要为**全部 249 条**文字注释重建 CanvasTexture
     （建 canvas → 绘字 → 上传 GPU → 释放旧贴图），这正是用户反馈的「菜单卡顿」主因。
     滞回后：只有当字号明确走出当前档位的 ±12% 边界才换档并重烘，
     档位内的小幅拖动纯粹走 setNoteScale（改 scale，零贴图开销），手感明显更跟手。
     视觉上 12% 的分辨率迟滞不可察觉（相邻档的清晰度差异本就细微）。 */
  function noteDPI(s) {
    const d = _noteDpiCur || 1;
    const HY = 0.12;
    var EDGE = [0, 1.6, 3, 6];
    var i = 0;
    while (i < EDGE.length - 1 && s >= EDGE[i + 1]) i++;      // 目标档（不含滞回）
    /* 已经处于更高档时，只有明显跌破该档下界才降档（避免在边界反复抖动） */
    if (d > 1) {
      var edgeLo = EDGE[d] || 6, edgeHi = EDGE[d + 1] !== undefined ? EDGE[d + 1] : Infinity;
      if (s > edgeLo * (1 - HY) && s <= edgeHi) return d;
    }
    return i + 1;
  }
  /* 当前生效的贴图档位（由 applyAll 在批量重烘前统一设定，避免每条各算一次） */
  var _noteDpiCur = 1;

  /* ===== v21.0（需求⑩）：「全局文字大小样式统一」时的字号基准归一 =====
     背景：每条注释的「世界基准宽度」是按各自文本长度手工定的（0.18 / 0.30 / 0.5 / 0.62 /
     0.72 / 0.9 / 0.95…），画布宽与画布字号也不统一（256/38、128/44、128/76、320/52）。
     只把 st.size 统一成一个值，屏幕上看到的大小依然各不相同 —— 这正是「勾选了统一，
     大小还是不一致」的原因。
     做法：把这些差异全部折算回「画布宽 256、画布字号 38px」这一套基准上：
       统一后的世界宽度 = UNIFY_W × (画布宽 / 256) × (38 / 画布字号)
     于是每条注释在画布上的字号都等于 38px，落到屏幕上的字高自然完全一致。 */
  const UNIFY_W = 0.62;
  function unifyBaseK(sp) {
    const u = sp.userData;
    const cw = u.cw || 256, fpx = u.fpx || 38, bw = u.baseW || 1;
    return (UNIFY_W * (cw / 256) * (38 / fpx)) / bw;
  }
  function persist() { lsSet(LS_NOTE, state.note); lsSet(LS_STYLE, state.style); lsSet(LS_UI, state.ui); }
  /* ★ 本次性能修复：拖动滑块 / 取色器时的持久化去抖 ——
     高频 'input' 事件若每次都同步写 localStorage 会拖慢帧率，故攒到 200ms 静默后统一落盘；
     窗口隐藏 / 卸载前用 persistNow() 立即补写，避免丢档。persist() 本体保持同步落盘语义不变。 */
  let _persistTimer = null;
  function persistNow() {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    persist();
  }
  function persistSoon() {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(function () { _persistTimer = null; persist(); }, 200);
  }
  window.addEventListener('visibilitychange', function () { if (document.hidden) persistNow(); });
  window.addEventListener('pagehide', function () { persistNow(); });
  /* ★ v40（需求一）：把「面板 / 浮层尺寸记忆表」与持久化函数暴露给 menu.js ——
     二级菜单浮层（.opt-fly）的拖拽尺寸需要写入同一张表（state.ui.pmSize）； */
  window.__pmSize = state.ui.pmSize = state.ui.pmSize || {};
  window.__persistUI = persist;

  /* ==========================================================================
     ★ v44（需求三）：**面板 / 悬浮窗尺寸与布局的统一约束**（主模块与太阳侧共用）
     --------------------------------------------------------------------------
     此前各类面板各写各的：
       · 最小尺寸是写死的 minW/minH（与内容无关）⇒ 拖小就把内容裁掉；
       · 拖动允许把面板推出屏幕（`clamp(x, 4 - w + 64, innerWidth - 64)`）；
       · 面板之间没有任何避让 ⇒ 拖到一起就互相压住。
     这里统一成一份工具（挂在 window.__panelFit，sunview.js 复用）：
       · PROFILE    —— 每类面板的最小宽高与**宽高比区间**；
       · uiScale()  —— 读 --ui（用探针元素实测，custom property 的 calc 不能 parseFloat）；
       · natural()  —— 离屏克隆实测「内容不被裁剪」所需的自然尺寸；
       · applyMin() —— 把自然尺寸写成 --pm-min-w / --pm-min-h；
       · clampRect()-> 尺寸夹到 [min, 视口]，并夹进宽高比区间；
       · clampPos() —— 位置夹到可见区域内（含标题栏下沿）；
       · resolve()  —— 逐个消解「用户手动摆过」的面板与其它面板的重叠。
     ========================================================================== */
  const __panelFit = (function () {
    const P = {
      /* key: { minW, minH, ar: [最小宽高比, 最大宽高比] } —— 单位 px（未乘 --ui） */
      menu: { minW: 268, minH: 148, ar: [0.42, 2.40] },   // 三级菜单型设置面板（竖向长条）
      time: { minW: 300, minH: 150, ar: [0.46, 2.60] },   // 时间面板（内容偏横）
      info: { minW: 236, minH: 118, ar: [0.55, 2.40] },   // 观测点 / 数据面板
      bar: { minW: 400, minH: 112, ar: [1.30, 6.00] },   // 底部横排控制面板
      win: { minW: 188, minH: 166, ar: [0.72, 1.70] },   // 3D 缩略悬浮窗
      fly: { minW: 210, minH: 120, ar: [0.50, 2.40] }    // 二级菜单浮层
    };
    const GAP = 8;
    function prof(key) { return P[key] || P.info; }

    /* --ui 是 calc(var(--uiW) * var(--uiH))，parseFloat 读不出来 —— 用探针元素实测。 */
    let _probe = null;
    function uiScale() {
      if (!_probe) {
        _probe = document.createElement('div');
        _probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:calc(100px * var(--ui));height:0;pointer-events:none;';
        document.body.appendChild(_probe);
      }
      const w = _probe.offsetWidth;
      return (isFinite(w) && w > 10) ? (w / 100) : 1;
    }

    function rectOf(n) { return n.getBoundingClientRect(); }
    function visible(n) {
      if (!n) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = rectOf(n);
      return r.width > 2 && r.height > 2;
    }

    /* 内容自然尺寸：离屏克隆一份（强制展开态 / 去掉限高与缩放）量两次，量完即删。
       · w / h        —— max-content（内容完全不折行 / 不滚动的理想尺寸）；
       · minW / minH  —— min-content（再窄就会「切字 / 切控件」的硬下限）。
       面板的最小宽高取的是 **min-content**：折行是被允许的（内容仍然完整），
       裁剪是不允许的 —— 这正是「内容完整显示、不被裁剪」的准确判据。 */
    function _measure(node, wmode) {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.classList.remove('collapsed', 'pm-folding');
      clone.style.cssText += ';position:fixed!important;left:-99999px!important;top:0!important;' +
        'right:auto!important;bottom:auto!important;width:' + wmode + '!important;height:auto!important;' +
        'max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;' +
        'zoom:1!important;transform:none!important;opacity:0!important;visibility:hidden!important;' +
        'transition:none!important;pointer-events:none!important;';
      clone.querySelectorAll('*').forEach(el => { el.style.transition = 'none'; });
      document.body.appendChild(clone);
      let w = 0, h = 0;
      try {
        Array.prototype.forEach.call(clone.children, ch => {
          ch.style.maxHeight = 'none'; ch.style.overflow = 'visible';
        });
        w = clone.offsetWidth; h = clone.offsetHeight;
      } finally { if (clone.parentNode) clone.parentNode.removeChild(clone); }
      return { w: Math.round(w), h: Math.round(h) };
    }
    function natural(node, atW) {
      const a = _measure(node, 'auto');
      const b = _measure(node, 'min-content');
      const h = (atW && isFinite(atW) && atW > 40) ? _measure(node, Math.round(atW) + 'px').h : a.h;
      return { w: a.w, h: a.h, minW: Math.min(a.w, b.w), minH: b.h, wrapH: h };
    }

    /* 把「内容最小尺寸」写进 CSS 变量，供拉伸夹取与探针核对。
       口径：min-content 宽度 / 高度（再窄就会切字切控件）与「基准最小尺寸」取大者，
       并给一个 1.8 倍基准的上限，避免个别超长行（如「（含二分二至）」长标签）
       把面板的最小宽度撑到离谱。 */
    function applyMin(node, key, force) {
      if (!node) return null;
      const k0 = uiScale();
      /* 缓存：同「档位 + --ui 缩放」只量一次（内容本身是静态的）——
         面板从 display:none 变可见、或窗口尺寸变化时会自动重算。 */
      /* 末位 = 「当前是否可测量」：display:none 时离屏克隆量不出内容（得到 0），
         面板真正显示出来后签名变化 ⇒ 自动重算一次。 */
      const sig = (key || 'info') + '@' + k0.toFixed(3) + '|' + (node.getBoundingClientRect().width > 2 ? 'v' : 'h');
      if (!force && node.dataset.pmMinSig === sig && node.dataset.pmMinDone === '1') return null;
      const k = k0, p = prof(key);
      const baseW = Math.round(p.minW * k), baseH = Math.round(p.minH * k);
      let minW = baseW, minH = baseH;
      try {
        /* 最小宽：内容的 min-content 宽度（再窄就会切字 / 切控件），基准与 1.8 倍基准之间夹取 */
        const nat = natural(node);
        if (nat.minW > 0) minW = Math.max(baseW, Math.min(nat.minW, Math.round(baseW * 1.8)));
        /* 最小高：**在面板当前宽度下**内容所需的高度（面板本身 height:auto，所以要防的
           只是「用户把高度拖得比内容还矮」）；正文自带内部滚动的面板除外（它本来就是
           滚动体，最小高回归基准值）。上限取 78vh，保证任何面板都还能在屏内存在。 */
        const body = bodyOf(node);
        const scrolls = body ? /auto|scroll/.test(getComputedStyle(body).overflowY) : false;
        if (!scrolls && nat.wrapH > 0) {
          const curW = Math.max(minW, Math.round(rectOf(node).width) || minW);
          const nat2 = natural(node, curW);
          minH = Math.max(baseH, Math.min(nat2.wrapH, Math.round(window.innerHeight * 0.78)));
        }
      } catch (e) { /* 测量失败就只用基准值 */ }
      node.style.setProperty('--pm-min-w', minW + 'px');
      node.style.setProperty('--pm-min-h', minH + 'px');
      node.dataset.pmKind = key || 'info';
      node.dataset.pmMinSig = sig;
      node.dataset.pmMinDone = '1';
      return { minW, minH };
    }
    function minOf(node, key) {
      const k = uiScale(), p = prof(key || node.dataset.pmKind);
      const mw = parseFloat(node.style.getPropertyValue('--pm-min-w'));
      const mh = parseFloat(node.style.getPropertyValue('--pm-min-h'));
      return {
        minW: isFinite(mw) ? mw : Math.round(p.minW * k),
        minH: isFinite(mh) ? mh : Math.round(p.minH * k),
        ar: p.ar
      };
    }

    /* 尺寸夹取：先夹 [min, 视口]，再把宽高比夹进本类区间。 */
    function clampRect(node, w, h, key) {
      const m = minOf(node, key);
      const W = window.innerWidth, H = window.innerHeight;
      /* ★ 本批次（需求一·拉伸异常）修复：最大尺寸原先按**整个视口**算（h ≤ H-4），
         可标题栏之下真正可用的高度只有 H - 标题栏 - 边距。于是把面板拉到极限高度时，
         clampPos 只能把 y 夹到标题栏下沿，面板底边仍越过视口下沿（实测 svTimeTop
         拉伸到 584×836 时 inView=false，底部被切）。这里改为按**可用区域**夹取，
         并让内容最小尺寸在视口不足时也能退让，保证「再���拉也留在可视区内」。 */
      const tb = document.getElementById('titleBar');
      const top = (tb ? tb.getBoundingClientRect().bottom : 0) + 2;
      const availW = Math.max(80, W - 4);
      const availH = Math.max(80, H - top - 4);
      const minW = Math.min(m.minW, availW), minH = Math.min(m.minH, availH);
      let nw = Math.max(minW, Math.min(w, availW));
      let nh = Math.max(minH, Math.min(h, availH));
      const ar = m.ar;
      if (ar && nw > 0 && nh > 0) {
        let r = nw / nh;
        if (r < ar[0]) { nw = Math.min(availW, Math.max(minW, nh * ar[0])); }
        else if (r > ar[1]) { nh = Math.min(availH, Math.max(minH, nw / ar[1])); }
        /* 夹一次可能又越界，做一次回收 */
        const r2 = nw / nh;
        if (r2 < ar[0]) nh = Math.max(minH, Math.min(availH, nw / ar[0]));
        else if (r2 > ar[1]) nw = Math.max(minW, Math.min(availW, nh * ar[1]));
      }
      return { w: Math.round(nw), h: Math.round(nh) };
    }

    /* 位置夹取：整块面板必须留在可见区域内（下界含标题栏下沿）。 */
    /* ★ 本批次（需求三）**顶边内缩量钩子** ——
       默认是「主标题栏下沿 + 2」。太阳视运动视图有自己的窗口标题栏（#svViewHead，
       位于地球侧窗格同一高度），面板必须夹在**那道标题栏之下**，否则内容会溢出到
       标题栏上方、甚至压住它。sunview.js 在进入太阳视图时用 setTopInset 覆盖，
       离开时传 null 还原。*/
    let _topInsetFn = null;
    function topInset() {
      if (_topInsetFn) {
        try { const v = _topInsetFn(); if (typeof v === 'number' && isFinite(v)) return v; } catch (e) { }
      }
      const tb = document.getElementById('titleBar');
      return (tb ? tb.getBoundingClientRect().bottom : 0) + 2;
    }
    function setTopInset(fn) { _topInsetFn = (typeof fn === 'function') ? fn : null; }

    function clampPos(node) {
      const r = rectOf(node);
      const top = topInset();
      const W = window.innerWidth, H = window.innerHeight;
      const maxX = Math.max(2, W - r.width - 2);
      const maxY = Math.max(top, H - r.height - 2);
      const x = Math.max(2, Math.min(r.left, maxX));
      const y = Math.max(top, Math.min(r.top, maxY));
      if (Math.abs(x - r.left) > 0.5 || Math.abs(y - r.top) > 0.5) {
        node.style.left = Math.round(x) + 'px';
        node.style.top = Math.round(y) + 'px';
        node.style.right = 'auto'; node.style.bottom = 'auto';
        return true;
      }
      return false;
    }

    function overlaps(a, b, tol) {
      const t = tol == null ? 1 : tol;
      return a.left < b.right - t && a.right > b.left + t && a.top < b.bottom - t && a.bottom > b.top + t;
    }

    /* ★ v55（需求 5）：面板之间**不再相互避让 / 碰撞**。
       直接返回 false —— 不做任何推开。用户明确要求取消面板避让逻辑。
       注意：clampPos（视口内夹取，防止面板被拖出屏幕外）仍保留，不属于「面板互避」。 */
    function resolve(node, others) {
      return false;
    }

    /* 拖动 / 拉伸时统一走这里：尺寸 + 位置 + 边界 + 宽高比一次到位。 */
    function fit(node, w, h, key) {
      const s = clampRect(node, w, h, key);
      node.style.width = s.w + 'px';
      node.style.height = s.h + 'px';
      clampPos(node);
      return s;
    }

    /* ---------- 折叠 / 展开（需求 1+2）----------
       统一入口：卡片真的收缩成「只有表头」，四角圆角一致，且展开 / 收起有平滑过渡。
       关键点：折叠时**清掉拉伸留下的 inline height**（旧实现只把正文 display:none，
       卡片仍占着原高度 —— 用户看到的就是「内容没了、面板还那么大」）。 */
    function bodyOf(node) {
      return node.querySelector(':scope > .card-body, :scope > .svtt-body, :scope > .svtb-body, :scope > .svmon-body')
        || Array.prototype.find.call(node.children, c =>
          c !== node.querySelector(':scope > .card-head') &&
          !c.classList.contains('sv-grip') && !c.classList.contains('pm-grip'));
    }
    function setFolded(node, on) {
      if (!node) return;
      on = !!on;
      const was = node.classList.contains('collapsed');
      const head = node.querySelector(':scope > .card-head');
      const body = bodyOf(node);
      if (head) {
        const hh = Math.round(head.getBoundingClientRect().height + 2);
        if (hh > 4) node.style.setProperty('--fold-h', hh + 'px');
      }
      if (on === was) { return; }
      let fin = false;
      const done = function () {
        if (fin) return; fin = true;
        node.classList.remove('pm-folding');
        if (body) {
          body.style.maxHeight = ''; body.style.overflow = '';
          /* 动画结束后再把正文真正 display:none —— 这样折叠态卡片的宽度
             （width:auto 的收缩宽度）只由表头决定，面板才真的「紧凑」。 */
          body.style.display = on ? 'none' : '';
        }
        if (!on && node.dataset.preH) { node.style.height = node.dataset.preH; delete node.dataset.preH; }
      };
      node.classList.add('pm-folding');
      if (!body) { node.classList.toggle('collapsed', on); setTimeout(done, 300); return; }
      body.style.overflow = 'hidden';
      if (on) {
        /* 先记下展开高度作为过渡起点，再挂 collapsed 同时把高度推到 0 */
        body.style.maxHeight = body.scrollHeight + 'px';
        if (node.style.height) { node.dataset.preH = node.style.height; node.style.height = ''; }
        void body.offsetHeight;
        node.classList.add('collapsed');
        body.style.maxHeight = '0px';
      } else {
        node.classList.remove('collapsed');
        body.style.display = '';            // 先恢复显示（折叠结束时被设成了 none）
        body.style.maxHeight = '0px';
        void body.offsetHeight;
        body.style.maxHeight = body.scrollHeight + 'px';
      }
      const te = function (ev) {
        if (ev && ev.target !== body) return;
        if (ev && ev.propertyName && ev.propertyName !== 'max-height') return;
        body.removeEventListener('transitionend', te); done();
      };
      body.addEventListener('transitionend', te);
      setTimeout(done, 420);
    }

    return { PROFILE: P, uiScale, natural, applyMin, minOf, clampRect, clampPos, resolve, overlaps, fit, visible, setFolded, bodyOf, setTopInset, topInset };
  })();
  window.__panelFit = __panelFit;
  /* ★ v39（需求四·1）：主模块面板拉伸尺寸 / 位置随 state.ui 一并持久化（UI 态，非几何态）。 */
  // 时区图层：v14.0 移除「可交互 / 选中 / 禁用」后不再有需要单独持久化的状态

  const tzMinutes = -new Date().getTimezoneOffset();        // 本机时区偏移（分钟）
  let displayYear = new Date().getFullYear();                // 当前演示年份：随模拟时间跨年自动推进（2026 → 2027 → 2028 …）
  let simMs = Date.now();                                    // 模拟时间（UTC epoch ms），可无限向前推进
  let terms = solarTerms(displayYear);

  // 显示年内的时间区间
  function yearStartUTCms(year) { return Date.UTC(year, 0, 1); }
  function yearEndUTCms(year) { return Date.UTC(year, 0, 1) + daysInYear(year) * 86400000; }

  // 把时刻限制在本年内（用于日期滑块 / 分享参数等「年内定位」的场景，不做跨年回绕）
  // ★ v32（需求二）：边界按**本地年**计算（与 localParts / msFromLocal 同口径）。
  //   旧版用 UTC 年边界，导致「本地 1 月 1 日 00:30」（= UTC 前一年 12 月 31 日 16:30）
  //   被夹回 UTC 年首，界面上显示成 08:00 —— 自定义时间/日期滑块在年初年末都会跳。
  function clampToYear(ms) {
    const off = tzMinutes * 60000;
    const a = yearStartUTCms(displayYear) - off, b = yearEndUTCms(displayYear) - off - 1;
    if (ms < a) return a;
    if (ms > b) return b;
    return ms;
  }

  // 本地日期/时刻 -> UTC epoch ms
  function msFromLocal(year, doy, minutes) {
    return Date.UTC(year, 0, 1) + (doy - 1) * 86400000 + minutes * 60000 - tzMinutes * 60000;
  }
  function localParts(ms) {
    const p = new Date(ms + tzMinutes * 60000);
    const y = p.getUTCFullYear();
    const doy = Math.floor((Date.UTC(y, p.getUTCMonth(), p.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    return {
      y: y, doy: doy,
      mo: p.getUTCMonth() + 1, day: p.getUTCDate(), week: p.getUTCDay(),
      hh: p.getUTCHours(), mm: p.getUTCMinutes(), ss: p.getUTCSeconds(),
      minutes: p.getUTCHours() * 60 + p.getUTCMinutes() + Math.round(p.getUTCSeconds() / 60),
    };
  }
  function utcHoursOf(ms) {
    return (((ms % 86400000) + 86400000) % 86400000) / 3600000;
  }
  // 太阳直射点经度（rad，东经为正）
  function subsolarLonRad(ms, eot) {
    const lonDeg = wrap180(15 * (12 - utcHoursOf(ms)) - eot / 4);
    return lonDeg * D;
  }

  /* ============ 渲染器 & 场景 ============ */
  const canvas = $('gl');
  // 注意：不要开启 logarithmicDepthBuffer。地球 / 云层 / 大气等使用自定义 ShaderMaterial，
  // 不会写入对数深度（gl_FragDepth），而经纬网等内置材质会写入 —— 两者深度尺度不一致，
  // 会导致"透过地球看到背面经纬网"。本演示的尺度范围内普通深度缓冲精度足够。
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  const DPR_CAP = Math.min(window.devicePixelRatio || 1, 2);   // 目标像素比上限（自适应会在此基础上逐级下调）
  renderer.setPixelRatio(DPR_CAP);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setClearColor(0x04070e, 1);
  // 多视图分区渲染：整块画布每帧只清屏一次，各视图用 scissor 划分区域且不再重复清屏
  // （旧写法是"全屏清一次 + 每个视图再各清一次"，三窗/综合视图下每帧要多做 2~4 次全屏清屏）
  renderer.autoClear = false;

  const scene = new THREE.Scene();

  // 主相机：透视
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  // 极区俯视相机：正交
  const camNorth = new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.01, 40);
  const camSouth = new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.01, 40);
  let camNZoom = 1, camSZoom = 1;

  // 坐标系层级：orbit(绕黄极转动 ψ) -> tilt(地轴倾斜 ε) -> spin(自转 ρ)
  const orbit = new THREE.Group(); scene.add(orbit);
  const tilt = new THREE.Group(); orbit.add(tilt);
  const spin = new THREE.Group(); tilt.add(spin);

  // 公转动画场景：其中放置与自转"同一套地表要素"的地球 rig（缩放 ORB_E），
  // rig 不随公转自转参考系旋转 —— 地轴始终指向固定的北极星方向（需求③）
  const orbitScene = new THREE.Scene();
  const orbitCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
  const ORB_R = 2.6;     // 公转轨道半径
  const ORB_E = 0.68;    // 公转地球 rig 缩放
  const orbRig = new THREE.Group(); orbRig.scale.setScalar(ORB_E); orbitScene.add(orbRig);
  const tiltOrb = new THREE.Group(); tiltOrb.rotation.z = -OBLIQ; orbRig.add(tiltOrb);
  const spinOrb = new THREE.Group(); tiltOrb.add(spinOrb);

  /* ============ 贴图加载 ============ */
  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();

  function loadTex(uri, srgb) {
    return new Promise(function (resolve) {
      if (!uri) { resolve(null); return; }
      loader.load(uri, function (t) {
        t.encoding = srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
        t.anisotropy = MAX_ANISO;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        resolve(t);
      }, undefined, function () { resolve(null); });
    });
  }
  /* ===== v26.1（需求③）：海陆 / 大洲掩膜的数据源 =====
     优先用 assets-geo.js 内嵌的 Data URI（与地球本体贴图同等待遇，永不 404），
     没有该文件时再退回外链 PNG 路径（保持对旧包的兼容）。
     geoDataState 记录实际装载结果，供两个面板顶部显示状态（不再「静默失效」）。 */
  let geoDataState = 'loading';        // 'loading' | 'ok' | 'part' | 'missing'
  let geoMaskW = 0;                    // 掩膜宽度（像素），用于把「线粗细(度)」换算成像素半宽
  function GEO_URI(key, fallbackPath) {
    const G = window.EARTH_GEO;
    return (G && typeof G[key] === 'string' && G[key]) ? G[key] : fallbackPath;
  }
  function syncGeoStat() {
    const txt = {
      loading: '数据：装载中…',
      ok: '数据：已装载（内嵌掩膜，' + (geoMaskW ? geoMaskW + '×' + (geoMaskW >> 1) : '') + '）',
      
      missing: '数据：缺失！assets-geo.js 未装载且 assets/geo-*.png 读取失败 —— 请确认这两者至少存在一个，否则本图层画不出任何东西。',
    }[geoDataState] || '';
    /* 只有「海陆分布 / 七大洲」两张面依赖掩膜贴图，所以状态行只出现在这两个面板里
       （列表里其余 id 在菜单中并不存在，`$(id)` 拿到 null 时直接跳过 ——
        写全是为了以后再新增掩膜图层时不必回来改这里）。 */
    ['landSeaStat', 'contStat', 'hemiStat', 'latbeltStat'].forEach(function (id) {
      const el = $(id); if (!el) return;
      el.textContent = txt;
      el.className = 'geo-stat' + (geoDataState === 'missing' ? ' bad'
        : (geoDataState === 'ok' ? ' ok' : ''));
    });
  }

  // 生成降级贴图（贴图加载失败时使用）
  function fallbackCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function fallbackDay() {
    const c = fallbackCanvas(1024, 512), g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, '#dbeafe'); grd.addColorStop(0.16, '#0b3d91');
    grd.addColorStop(0.5, '#0a2a63'); grd.addColorStop(0.84, '#0b3d91'); grd.addColorStop(1, '#dbeafe');
    g.fillStyle = grd; g.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 220; i++) {
      const y = 70 + Math.random() * 372;
      const w = 18 + Math.random() * 60, h = 12 + Math.random() * 46;
      const x = Math.random() * 1024;
      g.fillStyle = 'rgb(' + (58 + Math.random() * 55 | 0) + ',' + (92 + Math.random() * 60 | 0) + ',' + (48 + Math.random() * 40 | 0) + ')';
      g.beginPath(); g.ellipse(x, y, w, h, Math.random() * 3, 0, 6.28); g.fill();
    }
    g.fillStyle = 'rgba(240,250,255,0.93)'; g.fillRect(0, 0, 1024, 22); g.fillRect(0, 490, 1024, 22);
    return c.toDataURL('image/jpeg', 0.88);
  }
  function fallbackNight() {
    const c = fallbackCanvas(1024, 512), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 900; i++) {
      const y = 90 + Math.random() * 330;
      g.fillStyle = 'rgba(255,214,140,' + (0.25 + Math.random() * 0.6).toFixed(2) + ')';
      g.beginPath(); g.arc(Math.random() * 1024, y, Math.random() * 1.8, 0, 6.28); g.fill();
    }
    return c.toDataURL('image/jpeg', 0.85);
  }
  function fallbackGray(v) {
    const c = fallbackCanvas(8, 8), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 8, 8);
    const rgb = Math.round(v * 255);
    g.fillStyle = 'rgb(' + rgb + ',' + rgb + ',' + rgb + ')'; g.fillRect(0, 0, 8, 8);
    return c.toDataURL('image/png');
  }

  /* ============ 通用着色器片段 ============ */
  const SRGB_FN = `
    float srgbF(float c){ return c <= 0.0031308 ? c*12.92 : 1.055*pow(c, 0.41666) - 0.055; }
    vec3 toSRGB(vec3 c){ return vec3(srgbF(c.r), srgbF(c.g), srgbF(c.b)); }
  `;
  // 地球专用顶点着色器：额外传出几何本地坐标（单位球 → 本地方向），供极光计算纬度/经度
  const EARTH_VS = `
    varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec3 vLocal;
    void main(){
      vUv = uv;
      vLocal = normalize(position);
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vP = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  const WORLD_VS = `
    varying vec2 vUv; varying vec3 vN; varying vec3 vP;
    void main(){
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vP = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  /* ============ 地球 ============ */
  const earthMat = new THREE.ShaderMaterial({
    extensions: { derivatives: true },
    uniforms: {
      uDay: { value: null }, uNight: { value: null }, uWater: { value: null }, uClouds: { value: null },
      uSunDir: { value: SUN_DIR.clone() },
      uSpinAxis: { value: new THREE.Vector3(0, 1, 0) },
      uE1: { value: new THREE.Vector3(0, 0, -1) }, uE2: { value: new THREE.Vector3(0, 1, 0) },
      uCloudShift: { value: 0 }, uHasClouds: { value: 1 }, uHasNight: { value: 1 },
      // v25.1（需求④）：真实地球 / 白色球切换 —— 1 = 使用真实地表贴图；0 = 纯白球，
      //   仅呈现太阳光照形成的明暗阴影（昼半球受光、夜半球背光变暗），便于观察光照与昼夜。
      uRealTex: { value: state.realTex ? 1 : 0 },
      uDayGain: { value: state.dayGain }, uNightGain: { value: state.nightGain }, uSoft: { value: state.soft },
      uNightOp: { value: 1 },                    // v15.0 夜间城市灯光透明度
      uAuroraOp: { value: 1 },                   // v15.0 极光透明度
      uSpec: { value: state.spec },
      uTermOn: { value: 1 },
      uDawnOn: { value: 1 }, uDuskOn: { value: 1 },
      uDawnW: { value: 0.9 * D }, uDuskW: { value: 0.9 * D },
      uDawnColor: { value: new THREE.Color('#FFD23F') },
      uDuskColor: { value: new THREE.Color('#FF7A45') },
      uDawnDash: { value: 0 }, uDuskDash: { value: 1 },
      uDawnN: { value: 64 }, uDuskN: { value: 64 },
      uDawnRatio: { value: 0.55 }, uDuskRatio: { value: 0.55 },
      uDawnOpacity: { value: 0.95 }, uDuskOpacity: { value: 0.95 },
      // 极光（极夜区 · 极光卵）：形状随机（uAuroraSeed 每次载入随机）、缓慢飘动（uAuroraT）
      uAuroraOn: { value: state.aurora ? 1 : 0 },
      uAuroraT: { value: 0 }, uAuroraSeed: { value: Math.random() * 30 },
          uAuroraStr: { value: 0.55 },
      uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: EARTH_VS,
    fragmentShader: `
      uniform sampler2D uDay, uNight, uWater, uClouds;
      uniform vec3 uSunDir, uSpinAxis, uE1, uE2;
      uniform float uCloudShift, uHasClouds, uHasNight;
      uniform float uRealTex;
      uniform float uDayGain, uNightGain, uSoft, uTermOn, uSpec, uNightOp;
      uniform float uDawnOn, uDuskOn, uDawnW, uDuskW, uDawnDash, uDuskDash;
      uniform float uDawnN, uDuskN, uDawnRatio, uDuskRatio;
      uniform float uDawnOpacity, uDuskOpacity;
      uniform vec3 uDawnColor, uDuskColor;
      uniform float uAuroraOn, uAuroraT, uAuroraSeed, uAuroraStr, uAuroraOp;
      uniform vec3 uSunLocal;
      varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec3 vLocal;
      ${SRGB_FN}
      // ---- 极光用程序化噪声（值噪声 + fbm），无需贴图 ----
      float aHash(vec3 p){
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float aNoise(vec3 x){
        vec3 ii = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(aHash(ii), aHash(ii + vec3(1.0, 0.0, 0.0)), f.x),
                       mix(aHash(ii + vec3(0.0, 1.0, 0.0)), aHash(ii + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                   mix(mix(aHash(ii + vec3(0.0, 0.0, 1.0)), aHash(ii + vec3(1.0, 0.0, 1.0)), f.x),
                       mix(aHash(ii + vec3(0.0, 1.0, 1.0)), aHash(ii + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
      }
      float aFbm(vec3 p){
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++){ s += a * aNoise(p); p = p * 2.03 + vec3(11.3, 5.1, 7.7); a *= 0.5; }
        return s;
      }
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vP);
        float sd = dot(N, uSunDir);                       // 太阳高度角正弦
        // v25.1（需求④）：rt = 1 取真实地表贴图；rt = 0 则退化为「纯白球」——
        //   地表颜色取中性白、夜景灯光 / 云层起伏 / 海面高光等贴图相关效果一并关闭，
        //   只保留 uDayGain 的太阳光照项与夜面环境光项，从而呈现干净的明暗阴影。
        float rt = clamp(uRealTex, 0.0, 1.0);
        vec3 day = mix(vec3(1.0), texture2D(uDay, vUv).rgb, rt);
        vec3 night = texture2D(uNight, vUv).rgb * rt;
        float water = texture2D(uWater, vUv).r * rt;
        float cloud = texture2D(uClouds, vec2(fract(vUv.x + uCloudShift), vUv.y)).r * rt;

        // 柔和的昼夜过渡（相当于大气折射形成的曙暮光带）
        float lit = smoothstep(-uSoft, uSoft, sd);
        float lam = max(sd, 0.0);

        // ---- 昼面 ----
        vec3 dayCol = day * (uDayGain * (0.16 + 0.95 * pow(lam, 0.70)));
        dayCol *= (1.0 - 0.28 * smoothstep(0.20, 0.85, cloud) * lit * uHasClouds);
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 180.0) * step(0.0, sd) * (0.30 + 0.70 * water) * 0.36 * uSpec;
        dayCol += vec3(1.0, 0.97, 0.90) * spec * lit;
        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
        // 白球模式下减弱边缘大气蓝光，保持球面为纯白、只留太阳光照的明暗
        dayCol += vec3(0.10, 0.24, 0.55) * rim * lit * 0.40 * (0.25 + 0.75 * rt);

        // ---- 夜面（近中性的极暗环境光 + 暖色城市灯光）----
        vec3 nightCol = day * uNightGain * vec3(0.88, 0.90, 0.92);
        float nm = smoothstep(0.04, -0.16, sd);
        nightCol += night * nm * 1.55 * uHasNight * uNightOp * vec3(1.0, 0.82, 0.58);

        vec3 col = mix(nightCol, dayCol, lit);

        // ---- 晨昏线：晨线（由夜入昼）与昏线（由昼入夜）分开绘制 ----
        if (uTermOn > 0.5) {
          // 地表点正随自转进入白昼 => dot(自转轴, N x 太阳方向) > 0
          float side = dot(uSpinAxis, cross(N, uSunDir));
          float isDawn = step(0.0, side);
          float w  = mix(uDuskW, uDawnW, isDawn);
          float en = mix(uDuskOn, uDawnOn, isDawn);
          float dn = mix(uDuskN, uDawnN, isDawn);
          float dr = mix(uDuskRatio, uDawnRatio, isDawn);
          float dsh = mix(uDuskDash, uDawnDash, isDawn);
          vec3 tc = mix(uDuskColor, uDawnColor, isDawn);

          float aa = clamp(fwidth(sd) * 1.5, 1e-5, 0.4);
          float line = 1.0 - smoothstep(w - aa, w + aa, abs(sd));
          // 沿晨昏大圆的弧长参数 -> 虚线
          float phi = atan(dot(N, uE2), dot(N, uE1));
          float t = phi * 0.15915494 * dn;
          float f = fract(t);
          float aw = clamp(fwidth(t) * 0.7, 1e-4, 0.5);
          float dash = smoothstep(0.0, aw, f) * (1.0 - smoothstep(dr, dr + aw, f));
          float lop = mix(uDuskOpacity, uDawnOpacity, isDawn);
          col = mix(col, tc, line * mix(1.0, dash, dsh) * en * lop);
        }
        // ---- 极光（极光卵 · 只在极夜区可见） ----
        // 真实的极光发生在「极光卵」上：以磁极为中心、磁纬约 62°~72° 的环带，
        // 并向子夜侧（背对太阳）鼓起；幕帘由沿磁力线下落的粒子激发，呈竖直丝带、缓慢飘动。
        // 这里在地球表面着色阶段绘制：纬度取本地系（+Y = 自转轴），太阳方向由 JS 每帧
        // 变换到本地系（uSunLocal），因此卵形相对日地连线稳定、地球在其下自转（真实情形）。
        if (uAuroraOn > 0.5) {
          vec3 ln = vLocal;
          float alat = asin(clamp(abs(ln.y), 0.0, 1.0));      // 磁纬绝对值（弧度）
          // 平滑纬度门控（取代旧的 alat>0.88 硬阈值）：卵形内外连续过渡，不再有圆形硬边
          float latMask = smoothstep(0.78, 0.92, alat);
          if (latMask > 0.002) {                               // 只在高纬（≈45° 以上）才做噪声计算
            float dark = smoothstep(0.05, -0.12, dot(ln, uSunLocal));   // 太阳在地平线下才可见
            if (dark > 0.003) {
              float sgn = (ln.y >= 0.0) ? 1.0 : -1.0;
              float az  = atan(ln.z * sgn, ln.x * sgn);
              float azS = atan(uSunLocal.z * sgn, uSunLocal.x * sgn);
              float azMid = azS + 3.14159265;                  // 子夜方位（背对太阳）
              // 位置随机更新：整个卵形的鼓起方位与中心纬度都随时间缓慢游走，
              // 且每次载入种子（uAuroraSeed）不同 → 位置与形状随机、不重复
              azMid += (aFbm(vec3(5.1, uAuroraT * 0.005, uAuroraSeed)) - 0.5) * 1.2;
              float wander = aFbm(vec3(uAuroraSeed * 0.9, uAuroraT * 0.006, 7.3));
              float bulge = -0.115 * cos(az - azMid);          // 卵形向子夜侧鼓起
              // 卵形中轴的方位起伏 + 每次载入随机的种子 → 形状随机、不重复
              float wob = aFbm(vec3(az * 1.6 + uAuroraSeed, alat * 5.0, uAuroraT * 0.014));
              float center = 1.185 + bulge + 0.060 * (wob - 0.5) + (wander - 0.5) * 0.10;
              float wid = 0.058 + 0.045 * wob;
              // ---- 多层低透明度渐变色带：主环 + 极侧内环 + 赤道侧宽环，各自独立羽化 ----
              float d0 = (alat - center) / max(wid, 0.014);
              // 非对称截面：极侧收得快、赤道侧拖出柔和长尾 —— 与真实极光卵的形态一致
              float dd0 = max(d0, 0.0) * 0.80 + min(d0, 0.0) * 1.30;
              float ringA = exp(-dd0 * dd0);
              // 极侧内层副环：更窄更暗、中心略偏极侧，打破单一色带的规则轮廓
              float d1 = (alat - center - 0.62 * wid) / max(wid * 0.66, 0.010);
              float ringB = exp(-d1 * d1 * 1.15);
              // 赤道侧外层副环：更宽更弥散，充当向低纬方向的羽化过渡
              float d2 = (alat - center + 0.55 * wid) / max(wid * 1.25, 0.014);
              float ringC = exp(-d2 * d2 * 0.55);
              // 弥散大光晕：比旧版更宽更弱，与背景天空连续衔接、无可见边界
              float halo = exp(-d0 * d0 * 0.085);

              // 幕帘：沿纬度缓慢流动的丝带
              float flow = uAuroraT * 0.028;                   // 时间系数约减半 → 飘动更慢更平滑
              float c = aFbm(vec3(az * 3.0 + uAuroraSeed * 1.3, alat * 18.0 - flow, flow * 0.5));
              // 叠加细尺度扰动分量，打破均匀呆板的质感
              float c2 = aFbm(vec3(az * 9.0 + uAuroraSeed * 2.7, alat * 34.0 - flow * 1.6, 4.2));
              float curtain = smoothstep(0.20, 0.92, c * (1.0 + 0.55 * ringA) + 0.18 * (c2 - 0.5));

              // 丝束：相位被噪声扰动 → 自然弯曲、粗细不匀（不再像机械辐条）
              // 注意：GLSL ES 3.00 里 patch / sample / filter / smooth / flat 等是保留字，不能作标识符
              float bend = aFbm(vec3(az * 4.6 + uAuroraSeed * 3.1, alat * 7.0, uAuroraT * 0.028));
              float rays = 0.50
                         + 0.26 * sin(az * 74.0 + bend * 9.5 + uAuroraSeed * 5.0)
                         + 0.17 * sin(az * 41.0 - bend * 5.5 + uAuroraSeed * 2.0 + 1.7);
              rays = smoothstep(0.30, 0.98, rays);              // 过渡区间加宽 → 明暗羽化更柔
              // 沿幕帘长度方向的亮度起伏：顶端渐隐，形成"垂帘"的观感
              float fallA = smoothstep(-2.8, 0.5, d0) * (1.0 - 0.45 * smoothstep(0.0, 2.8, d0));
              float fallB = smoothstep(-2.2, 0.8, d1) * (1.0 - 0.40 * smoothstep(-0.4, 2.2, d1));
              float fallC = smoothstep(-2.0, 1.2, d2) * (1.0 - 0.50 * smoothstep(-0.2, 2.6, d2));

              // 大尺度斑块：真实极光常有亮弧与暗段交替，不是均匀一圈
              float blob = aFbm(vec3(az * 1.15 + uAuroraSeed * 2.1, uAuroraT * 0.007, 3.7));
              float gaps = smoothstep(0.06, 0.70, blob * 0.80 + 0.30 * wob);

              // 细颗粒噪点：打散分层着色的带状纹路（banding），幅度很小只影响质感
              float grain = (aNoise(vec3(ln.x * 96.0, ln.y * 96.0, ln.z * 96.0 + uAuroraT * 0.05)) - 0.5) * 0.16;
              // 亮度合成：弥散底光 + 主环亮弧 + 上下两层低透明度副环（多层渐变叠加，边缘各自羽化）
              float glow = (halo * 0.10
                          + ringA * (0.08 + 0.82 * curtain) * rays * fallA
                          + ringB * 0.38 * curtain * fallB
                          + ringC * 0.20 * (0.4 + 0.6 * curtain) * fallC) * gaps;
              glow *= 1.0 + grain;
              // 掠射视线穿过更厚的极光层 → 低仰角时看起来更高更亮
              float graze = clamp(1.0 / max(0.30, clamp(dot(N, V), 0.0, 1.0)), 1.0, 3.4);

              // 高度分层配色：赤道侧低层 = 氧原子绿（557.7nm），极侧高层 = 氧原子红，
              // 底缘混入氮分子紫红
              float t = clamp(d0 * 0.34 + 0.5, 0.0, 1.0);
              vec3 ac = mix(vec3(0.10, 1.00, 0.42), vec3(1.00, 0.30, 0.36), smoothstep(0.46, 1.10, t));
              ac = mix(vec3(0.58, 0.34, 1.00), ac, smoothstep(0.16, 0.52, t));   // 底缘紫红大范围淡入
              // 分层配色：内层副环偏紫红（高层发射），外层副环偏纯绿（低层氧发射）
              vec3 acB = mix(vec3(0.58, 0.34, 1.00), vec3(1.00, 0.30, 0.36), 0.35);
              vec3 acC = vec3(0.14, 0.95, 0.50);
              vec3 emit = ac * ringA + acB * (ringB * 0.38) + acC * (ringC * 0.20);
              emit /= (ringA + ringB * 0.38 + ringC * 0.20 + 1e-4);
              col += emit * glow * dark * latMask * graze * 0.40 * uAuroraStr * uAuroraOp;
            }
          }
        }
        gl_FragColor = vec4(toSRGB(col), 1.0);
      }
    `,
  });
  /* ===== v26.1（需求⑧）：绘制层级总表 —— 自上而下 =====
       文字注释 40 ~ 43（经纬度 40 < 温度带 / 区域注记 41 < 时区 42 < 地方时 / 距离 43）
       点要素   30          （标注点 / 直射点 / 时刻点 / 球面距离端点 / 小人本体 28）
       线要素   20 ~ 26     （经纬网 / 特殊经纬线 / 纬线圈 / 板块边界 23 / 箭头 25）
       面要素   2 ~ 13      （极昼极夜 2-3 < 黄道/赤道面 3 < 温度带 5 < 南北半球 6 <
                             东西半球 7 < 海陆 / 七大洲 8 < 纬度带 9 < 板块 10 < 时区 12-13）
       地球表层效果 1       （大气光晕；夜间灯光 / 云层 / 极光在地球着色器里，与球同体）
       白球 / 地球本体 0
     小人影子 18（贴地，压在所有面之上、线之下）；标记点标签 900（永远最顶）。 */
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), earthMat);
  earth.renderOrder = 0;                                   // 白球 / 地球本体：层级最底
  spin.add(earth);
  // 公转场景中的地球：克隆材质（各自持有 uniform，便于两个视图同时渲染），
  // 共享几何体与贴图；所有显示设置在 applyAll 中同步到两套材质
  const earthMatOrb = earthMat.clone();
  const earthOrb = new THREE.Mesh(earth.geometry, earthMatOrb);
  earthOrb.renderOrder = 0;
  spinOrb.add(earthOrb);

  /* ============ v53：海陆分布 / 七大洲（**单一掩膜，四者同源**） ============
     ★ v53（需求一·1）本模块彻底废弃「两套并行数据」的做法，改为一张掩膜派生四者：
       数据：assets/geo-reg.png（由 tools/_build_geo_reg.py 从旧 geo-cont.png 生成，
         内嵌于 assets-geo.js → window.EARTH_GEO.reg）
           R = 大洲索引（0=海洋，1..7 依次 AS/EU/AF/NA/SA/OC/AN），**精确整数**，
               着色器用 round(r*7) 直接还原索引 —— 不再对颜色做「就近匹配」，
               因此**结构上不可能出现「点 A 洲却染成 B 洲色」的错配**；
           G = 到海岸线（陆地并集外边界）的距离场，量程 GEO_SPREAD px；
           B = 到大洲界线（两个不同洲的交界）的距离场，量程同上。
       四者派生关系（全部落在同一张球面掩膜上，边界天然闭合、逐像素对齐）：
         ① 海洋填充   ← 索引 = 0
         ② 陆地填充   ← 索引 > 0（**七洲的并集** = 合并各洲填充为统一陆地填充）
         ③ 七大洲填色 ← 索引 = k 且该洲被勾选（**只显填充，不带任何外围描边**）
         ④ 海岸线     ← G 距离场阈值化（= 合并边界的**外**边界）
         ⑤ 大洲界线   ← B 距离场阈值化（= 洲与洲之间的**内**边界）
       ★ 里海：源掩膜里里海本就是「无洲」（索引 0），故并集后**天然是海洋**，
         v52 那套「经纬度包围盒 + contHas」补丁已删除。
       ★ 旧 assets/coast-vectors.js（GEO_COAST：全球海岸线 + 7 大洲边界**合并成的
         扁平数组**，与洲索引无关）整体废弃并从 index.html 移除加载 ——
         它正是「只勾亚洲却把欧洲/非洲/大洋洲描边一起画出来」的根源。 */
  const GEO_SPREAD = 24;                            // 与生成脚本的 spread 一致（像素）
  const GEO_VS = `
    varying vec2 vUv; varying vec3 vN;
    void main(){
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const GEO_FS = `
    uniform sampler2D uReg, uPal;
    uniform vec3 uSunDir;
    uniform float uDayDim;
    uniform float uOceanOn, uLandOn, uCoastOn, uContOn, uCBndOn;
    uniform float uOceanOp, uLandOp, uCoastOp, uContOp, uCBndOp;
    uniform float uCoastW, uCBndW, uSpread;
    uniform vec3 uOceanColor, uLandColor, uCoastColor, uCBndColor;
    varying vec2 vUv; varying vec3 vN;
    ${SRGB_FN}
    // 距离场阈值化：dpx = 到线的距离（像素），halfW = 期望半宽（像素）
    float strokeA(float dpx, float halfW){
      float aa = clamp(fwidth(dpx) * 1.2, 0.55, 3.0);
      return 1.0 - smoothstep(halfW - aa, halfW + aa, dpx);
    }
    void main(){
      vec3 rg = texture2D(uReg, vUv).rgb;
      /* ★ 大洲索引：R 通道存 round(k*255/7)，round 回来即精确整数索引（0..7）。
         绝不能对颜色做「就近匹配」—— 用户改色 / 色彩空间转换都会让匹配漂到邻近洲。 */
      int bi = int(floor(rg.r * 7.0 + 0.5));
      float landM = (bi > 0) ? 1.0 : 0.0;
      // 预乘 alpha 合成（最后再除以 a 还原为非预乘，供普通 alpha 混合）
      vec3 pm = vec3(0.0); float a = 0.0;
      #define GEO_OVER(c, sa) { pm = (c) * (sa) + pm * (1.0 - (sa)); a = (sa) + a * (1.0 - (sa)); }
      // ① 海洋（索引 = 0，含里海）
      GEO_OVER(uOceanColor, uOceanOn * (1.0 - landM) * uOceanOp)
      // ② 统一陆地填充（七洲并集）
      GEO_OVER(uLandColor, uLandOn * landM * uLandOp)
      // ③ 七大洲填色：按索引取调色板；pv.a = 该洲显隐。**只叠填充，不叠描边** ——
      //    洲界线由 ⑤ 单独控制，两者互不影响。
      // ③ 七大洲填色：按索引取调色板；pv.a = 该洲显隐。**只叠填充，不叠描边** ——
      //    洲界线由 ⑤ 单独控制，两者互不影响。
      // ★ 采样坐标必须是 (bi + 0.5)/8 —— 8×1 调色板里第 i 个纹素横跨 [i/8,(i+1)/8)，
      //   中心才是 (i+0.5)/8。写成 (bi - 0.5)/8 会整体错位一个纹素：
      //   亚洲读到「无洲」槽（alpha=0，不显示）、北美洲读到非洲槽 —— 于是
      //   「只勾非洲」时会在美洲大陆上出现非洲的赭红色（用户反馈的填色错配）。
      if (uContOn > 0.002 && bi > 0) {
        vec4 pv = texture2D(uPal, vec2((float(bi) + 0.5) / 8.0, 0.5));
        GEO_OVER(pv.rgb, uContOn * pv.a * uContOp)
      }
      // ④ 海岸线（陆地并集的外边界）/ ⑤ 大洲界线（两洲之间的内边界）
      if (uCoastOn > 0.002) GEO_OVER(uCoastColor, uCoastOn * strokeA(rg.g * uSpread, uCoastW) * uCoastOp)
      if (uCBndOn  > 0.002) GEO_OVER(uCBndColor,  uCBndOn  * strokeA(rg.b * uSpread, uCBndW)  * uCBndOp)
      a *= mix(uDayDim, 1.0, smoothstep(-0.16, 0.20, dot(normalize(vN), uSunDir)));
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(pm / max(a, 1e-4)), a);
    }
  `;
  // 7 大洲（顺序即调色板索引 1..7；索引 0 = 海洋）。标识表 CONT_ORDER / CONT_COLORS /
  // CONT_NAMES 定义在文件顶部的状态区（DEFAULTS 需要用它作出厂色）。
  // 调色板贴图（8×1 RGBA）。DataTexture 不会被预乘 alpha 影响，颜色/显隐都是精确值。
  // 颜色以 **线性** 值存入（THREE.Color 会把 CSS 十六进制转成线性），与末端 toSRGB 配套。
  const geoPalData = new Uint8Array(8 * 4);
  const geoPalTex = new THREE.DataTexture(geoPalData, 8, 1, THREE.RGBAFormat);
  geoPalTex.magFilter = THREE.NearestFilter; geoPalTex.minFilter = THREE.NearestFilter;
  geoPalTex.generateMipmaps = false; geoPalTex.needsUpdate = true;
  const _geoPalC = new THREE.Color();
  function syncGeoPalette() {
    const FC = state.style.fill.cont || {}, L = state.geo.cont.list || {}, CO = FC.colors || CONT_COLORS;
    geoPalData[0] = geoPalData[1] = geoPalData[2] = 0; geoPalData[3] = 0;
    for (let i = 0; i < CONT_ORDER.length; i++) {
      const k = CONT_ORDER[i], o = (i + 1) * 4;
      _geoPalC.set(CO[k] || CONT_COLORS[k]);
      geoPalData[o] = Math.round(clamp(_geoPalC.r, 0, 1) * 255);
      geoPalData[o + 1] = Math.round(clamp(_geoPalC.g, 0, 1) * 255);
      geoPalData[o + 2] = Math.round(clamp(_geoPalC.b, 0, 1) * 255);
      geoPalData[o + 3] = (L[k] === false) ? 0 : 255;      // 该洲显隐
    }
    geoPalTex.needsUpdate = true;
  }
  function makeGeoMat() {
    const m = new THREE.ShaderMaterial({
      extensions: { derivatives: true },
      uniforms: {
        uReg: { value: null }, uPal: { value: geoPalTex },
        uSunDir: { value: SUN_DIR.clone() },
        uDayDim: { value: 0.26 },                       // 夜侧压暗后的残余不透明度
        uOceanOn: { value: 1 }, uLandOn: { value: 1 }, uCoastOn: { value: 1 },
        uContOn: { value: 0 }, uCBndOn: { value: 1 },
        uOceanOp: { value: 0.72 }, uLandOp: { value: 0.9 },
        uCoastOp: { value: 0.95 }, uContOp: { value: 0.9 }, uCBndOp: { value: 0.9 },
        uCoastW: { value: 2.5 }, uCBndW: { value: 2.3 }, uSpread: { value: GEO_SPREAD },
        uOceanColor: { value: new THREE.Color('#1F6FEB') },
        uLandColor: { value: new THREE.Color('#C9A66B') },
        uCoastColor: { value: new THREE.Color('#0B1B33') },
        uCBndColor: { value: new THREE.Color('#3A2A12') },
      },
      vertexShader: GEO_VS, fragmentShader: GEO_FS,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    return m;
  }
  const geoMatR = makeGeoMat(), geoMatO = makeGeoMat();
  const geoMeshR = new THREE.Mesh(new THREE.SphereGeometry(1.0018, 192, 144), geoMatR);
  const geoMeshO = new THREE.Mesh(geoMeshR.geometry, geoMatO);
  /* ★ v53：层级必须是 **8**，不是 4。
     app.js 内的「绘制层级总表」（见 earth 创建处注释）规定：
       地球本体 0  <  南北半球 6  <  东西半球 7  <  **海陆 / 七大洲 8**  <  纬度带 9 …
     早前这里写成 4（早于东西半球、且与南北半球同级），叠加时会被
     7 / 6 层与地球本体「抢深度」——表现为填色只残留在球边缘一小圈、
     正面大陆反而没有颜色。层级表是全局约定，改动必须与之一致。 */
  geoMeshR.renderOrder = 8; geoMeshO.renderOrder = 8;
  geoMeshR.visible = false; geoMeshO.visible = false;
  spin.add(geoMeshR); spinOrb.add(geoMeshO);
  syncGeoPalette();

  /* 把状态写进海陆 / 大洲材质（两套材质逐项同步）。
     线宽：状态里存「度」（与经纬网线要素同口径），掩膜宽 4096 px 对应 360°，
       故 半宽(px) = 度 ÷ 360 × 4096 ÷ 2；上限夹到 GEO_SPREAD-0.5 px
       （距离场的量程，超出量程处一律饱和，再宽也画不出来）。 */
  function applyGeo() {
    const L = state.geo.landSea, C = state.geo.cont, F = state.style.fill;
    /* 度 → 掩膜像素半宽 */
    const pxPerDeg = (geoMaskW || 4096) / 360;
    const hwOf = function (deg) { return clamp((deg || 0) * pxPerDeg * 0.5, 0.02, GEO_SPREAD - 0.5); };
    [geoMatR, geoMatO].forEach(function (m) {
      const u = m.uniforms;
      /* v26.1（需求③⑧）：面的「随昼夜明暗」——
         默认关闭：海陆分布 / 七大洲 / 东西半球 / 南北半球 / 低中高纬度 与温度带、时区
         一样**恒定显示**，不再被太阳昼夜压到夜侧只剩 26% 不透明度（那会让夜半球
         看起来像「面根本没显示」）。需要保留昼夜明暗观感时可在面板里打开。 */
      u.uDayDim.value = state.geo.dayDim ? 0.26 : 1.0;
      u.uOceanOn.value = (L.on && L.ocean) ? 1 : 0;
      u.uLandOn.value = (L.on && L.land) ? 1 : 0;
      /* v53：海岸线 / 大洲界线改由**同一张掩膜**的距离场绘制（见上方 GEO_FS 的 ④⑤），
         与填充逐像素对齐 —— 不再存在「填色是一套、描边是另一套」的错配可能。 */
      u.uCoastOn.value = (L.on && L.coast && F.coast.on) ? 1 : 0;
      u.uContOn.value = C.on ? 1 : 0;
      /* ★ v55（需求 1）：洲界描边与「填充总开关」彻底解耦 —— 只由洲界自身的开关
         （C.line 与 style.fill.contLine.on）决定。这样「勾选某洲填充」时**只画该洲填充**、
         绝不连带画出其它大洲的轮廓描边；独立的「大洲界线」开关仍可单独开启全部洲界。 */
      u.uCBndOn.value = (C.line && F.contLine.on) ? 1 : 0;
      u.uSpread.value = GEO_SPREAD;
      u.uCoastW.value = hwOf(F.coast.w);
      u.uCBndW.value = hwOf(F.contLine.w);
      u.uContOp.value = F.cont.op;
      u.uOceanColor.value.set(F.ocean.fill); u.uOceanOp.value = F.ocean.op;
      u.uLandColor.value.set(F.land.fill); u.uLandOp.value = F.land.op;
      u.uCoastColor.value.set(F.coast.color); u.uCoastOp.value = F.coast.op;
      u.uCBndColor.value.set(F.contLine.color); u.uCBndOp.value = F.contLine.op;
    });
    syncGeoPalette();                                   // 七大洲各自的显隐写在调色板 alpha 上
    const vis = !!(L.on || C.on);
    geoMeshR.visible = vis; geoMeshO.visible = vis;
  }
  /* ============ 云层 ============ */
  const cloudMat = new THREE.ShaderMaterial({
    extensions: { derivatives: true },
    uniforms: {
      uClouds: { value: null }, uSunDir: { value: SUN_DIR.clone() }, uOpacity: { value: 1 },
    },
    vertexShader: WORLD_VS,
    fragmentShader: `
      uniform sampler2D uClouds; uniform vec3 uSunDir; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      ${SRGB_FN}
      void main(){
        float c = texture2D(uClouds, vUv).r;
        float a = smoothstep(0.10, 0.55, c) * uOpacity;
        if (a < 0.012) discard;
        vec3 N = normalize(vN);
        float sd = dot(N, uSunDir);
        float lit = smoothstep(-0.10, 0.13, sd);
        vec3 V = normalize(cameraPosition - vP);
        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
        vec3 night = vec3(0.006, 0.010, 0.020);
        vec3 day = vec3(1.0, 0.99, 0.96);
        vec3 col = mix(night, day, lit) * (0.06 + 1.10 * max(sd, 0.0) * lit + 0.24 * rim * lit);
        gl_FragColor = vec4(toSRGB(col), a);
      }
    `,
    transparent: true, depthWrite: false,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.006, 96, 64), cloudMat);
  spin.add(clouds);
  let cloudRot = 0;
  const cloudMatOrb = cloudMat.clone();
  const cloudsOrb = new THREE.Mesh(clouds.geometry, cloudMatOrb);
  spinOrb.add(cloudsOrb);

  /* ============ 大气光晕（v3.9 解析散射 · 紧凑壳层） ============ */
  // 真实地球的大气辉光只有薄薄一圈：亮度在「贴地平线」处最高，向外迅速衰减到 0，
  // 而且昼侧亮、夜侧几乎不可见、晨昏处转暖。旧版把壳层做到 +13.5% 半径且用纯菲涅尔，
  // 结果是一圈厚而均匀的霓虹蓝管，看着就很假。现在：
  //   · 壳层只比地表高 7%（约 450 km），辉光贴边、不再是个大气球；
  //   · 用「视线穿过壳的光学厚度」做密度：掠射最厚、外缘为 0 → 外沿天然平滑淡出；
  //   · 昼/夜/晨昏三段权重分离：日侧青白、晨昏暖橙、夜侧仅剩一丝冷辉；
  //   · 加前向散射项（逆光看最亮），符合真实的迎光观感。
  // 只渲染球壳背面 → 地球圆面内不参与，辉光正好是贴着地边的一圈。
  const ATMO_ROUT = 1.048;           // 大气外半径（地球半径 = 1）→ 可见辉光只有薄薄一圈
  const ATMO_FS = `
    uniform vec3 uSunDir; uniform float uStrength;
    uniform vec3 uCenter; uniform float uRin, uRout;
    varying vec2 vUv; varying vec3 vN; varying vec3 vP;
    ${SRGB_FN}
    void main(){
      vec3 V = normalize(cameraPosition - vP);
      vec3 D = -V;
      vec3 toC = uCenter - cameraPosition;
      float dist = length(toC);
      float b = length(toC - dot(toC, D) * D);         // 视线到地心的垂距
      if (b >= uRout) discard;

      float ho = sqrt(max(uRout * uRout - b * b, 0.0));
      float hi = (b < uRin) ? sqrt(max(uRin * uRin - b * b, 0.0)) : 0.0;
      float od = ho - hi;                              // 穿过壳的光学厚度
      float odMax = sqrt(max(uRout * uRout - uRin * uRin, 1e-6));
      float x = clamp(od / odMax, 0.0, 1.0);           // 0=壳外缘 1=掠地平线

      vec3 pIn = cameraPosition + D * (dist - ho);     // 视线进入壳层的点
      vec3 N = normalize(pIn - uCenter);               // 该点球面法线（精确）
      float sd = dot(N, uSunDir);
      float day  = smoothstep(-0.05, 0.30, sd);        // 夜侧迅速归零
      float dusk = exp(-pow(sd / 0.085, 2.0));         // 晨昏暖弧：很窄，只贴分界线
      float fwd  = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 8.0);

      // 密度：掠地平线最亮，向外迅速衰减 → 视觉上就是贴边的一条细亮线
      float dens = pow(x, 3.10);
      vec3 blue = vec3(0.30, 0.58, 1.00);
      vec3 pale = vec3(0.80, 0.92, 1.00);
      vec3 col = mix(blue, pale, pow(x, 3.20));
      col *= dens * (0.012 + 0.70 * day + 0.30 * fwd * day);
      col += vec3(1.00, 0.60, 0.32) * dens * dusk * 0.28;   // 晨昏暖环（窄而淡）
      col += blue * dens * 0.003 * (1.0 - day);             // 夜侧只剩极淡冷辉
      gl_FragColor = vec4(toSRGB(col * uStrength), 1.0);
    }
  `;
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() }, uStrength: { value: 1 },
      uCenter: { value: new THREE.Vector3(0, 0, 0) },
      uRin: { value: 1 }, uRout: { value: ATMO_ROUT },
    },
    vertexShader: WORLD_VS,
    fragmentShader: ATMO_FS,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(ATMO_ROUT, 96, 64), atmoMat);
  atmosphere.renderOrder = 1;        // v26.1（需求⑧）：地球表层效果 —— 压在白球之上、所有面要素之下
  scene.add(atmosphere);
  const atmoMatOrb = atmoMat.clone();
  const atmosphereOrb = new THREE.Mesh(atmosphere.geometry, atmoMatOrb);
  atmosphereOrb.renderOrder = 1;
  orbRig.add(atmosphereOrb);
  // 公转场景的地球随轨道移动、半径随「地球大小比例」变化 → 每帧同步球心与内外半径
  function syncOrbAtmo() {
    const sc = orbRig.scale.x || 1;
    atmoMatOrb.uniforms.uRin.value = sc;
    atmoMatOrb.uniforms.uRout.value = sc * ATMO_ROUT;
    orbRig.getWorldPosition(atmoMatOrb.uniforms.uCenter.value);
  }

  /* ============ 极光：时间与坐标系 ============ */
  // 极光直接在「地球着色器」里绘制（见 earthMat 的极光段）——这样几何天然贴合球面、
  // 背面自动被剔除、不需要额外几何体与 draw call，两个视图（自转/公转）自动一致。
  let auroraTime = 0;
  const _qAur = new THREE.Quaternion(), _vAur = new THREE.Vector3();
  // 世界太阳方向 → 地球本地系（本地球几何的 +Y 即自转轴）
  function auroraSunLocal(mesh, sunWorld, mat) {
    mesh.getWorldQuaternion(_qAur).invert();
    _vAur.copy(sunWorld).applyQuaternion(_qAur);
    mat.uniforms.uSunLocal.value.copy(_vAur);
  }
  function auroraTick(dt) {
    auroraTime += dt;
    earthMat.uniforms.uAuroraT.value = auroraTime;
    earthMatOrb.uniforms.uAuroraT.value = auroraTime;
  }

  /* ============ 星空 ============ */
  (function buildStars() {
    const N = 2400, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * TWO_PI, r = Math.sqrt(1 - u * u);
      const R0 = 300;
      pos[i * 3] = Math.cos(a) * r * R0; pos[i * 3 + 1] = u * R0; pos[i * 3 + 2] = Math.sin(a) * r * R0;
      const b = 0.35 + Math.pow(Math.random(), 2.2) * 0.75;
      const warm = Math.random();
      col[i * 3] = b * (warm > 0.85 ? 1.0 : 0.86);
      col[i * 3 + 1] = b * 0.92;
      col[i * 3 + 2] = b * (warm < 0.2 ? 0.85 : 1.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.1, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    scene.add(stars);
    // v20.0：公转场景此前没有星空（自转视图有、公转视图一片空黑）—— 共享同一份星空几何，
    //        让两个视角的背景「显示内容」也保持一致。
    orbitScene.add(stars.clone());
  })();

  /* ============ 管状线材质（v7.0）：经纬网 / 轨道环 / 极区描边 统一使用 ============
     WebGL 的 LineBasicMaterial 不支持线宽，改用圆管网格后「粗细」才能真正生效；
     虚线由片元着色器按管长（uv.x）周期开合，与球面纬线带同源。 */
  const TUBE_VS = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `;
  const TUBE_FS = `
    uniform vec3 uColor; uniform float uOpacity, uDash, uDashN, uDashRatio;
    varying vec2 vUv;
    ${SRGB_FN}
    void main(){
      float a = uOpacity;
      if (uDash > 0.5) {
        float t = vUv.x * uDashN;
        float f = fract(t);
        float w = clamp(fwidth(t) * 0.6, 1e-4, 0.5);
        a *= smoothstep(0.0, w, f) * (1.0 - smoothstep(uDashRatio, uDashRatio + w, f));
      }
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function tubeMat(color, op) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color || '#FFFFFF') }, uOpacity: { value: op == null ? 1 : op },
        uDash: { value: 0 }, uDashN: { value: 96 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: TUBE_VS, fragmentShader: TUBE_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }
  // 把一条线要素的样式（颜色 / 透明度 / 线型 / 虚线参数）写进管状材质
  function setTube(mat, cfg) {
    if (!mat || !mat.uniforms) return;
    mat.uniforms.uColor.value.set(cfg.color);
    mat.uniforms.uOpacity.value = cfg.op;
    mat.uniforms.uDash.value = cfg.dash === 'dash' ? 1 : 0;
    mat.uniforms.uDashN.value = cfg.n;
    mat.uniforms.uDashRatio.value = cfg.ratio;
  }

  /* ============ 经纬网（自转 / 公转共用构建器） ============ */
  const GRAT_LATS = [-60, -30, 0, 30, 60];
  const GRAT_R = 1.0025;
  const gratGroups = [];
  let _gratWM = -1, _gratWP = -1, gratMerGeo = null;
  // 线宽变化时重建几何（仅 6 份几何，自转 / 公转共用）
  let _gratMerStep = -1, _gratParStep = -1;
  // 线宽变化时重建几何（自转 / 公转共用）；纬线纬度可变，逐条重算
  // v15.0：经线 / 纬线各自一套线宽（几何）与材质
  function gratEnsure(wMer, wPar) {
    const twM = Math.max(wMer, 0.0004), twP = Math.max(wPar, 0.0004);
    if (Math.abs(twM - _gratWM) < 1e-7 && Math.abs(twP - _gratWP) < 1e-7) return;
    _gratWM = twM; _gratWP = twP;
    if (gratMerGeo) gratMerGeo.dispose();
    gratMerGeo = new THREE.TorusGeometry(GRAT_R, twM, 6, 128);
    gratGroups.forEach(function (g) {
      g.userData.mer.forEach(function (m) { m.geometry = gratMerGeo; });
      g.userData.par.forEach(function (m) {
        if (m.geometry) m.geometry.dispose();
        m.geometry = new THREE.TorusGeometry(Math.cos(m.userData.lat * D) * GRAT_R, twP, 6, 160);
      });
    });
  }
  // 按度数间隔重建经线 / 纬线（v9.0：间隔可调、经线纬线分别显隐）
  /* v33（面板规格）：「显示间隔」多选 —— 取所有已勾选间隔的**角度并集**。
     例：勾 10° + 30° ⇒ 经线仍是 36 条（30° 的倍数本就是 10° 的倍数的子集），
     勾 20° + 30° ⇒ 0/20/30/40/60/80/90/100/120… 两套并起来、不重复描线。
     round6 是为了让 30 与 10*3 算出的同一个角度能落到同一个 Set 键上。 */
  const round6 = function (v) { return Math.round(v * 1e6) / 1e6; };
  function gratStepKeys(kind) {
    const m = (kind === 'mer' ? state.grat.merSteps : state.grat.parSteps) || {};
    const ks = Object.keys(m).map(Number).filter(function (k) { return m[k]; }).sort(function (a, b) { return a - b; });
    return ks.length ? ks : [30];       // 一个都不勾时退回 30°，避免整片空白
  }
  function gratMerLons() {
    const s = new Set();
    gratStepKeys('mer').forEach(function (k) { for (let v = 0; v < 360 - 1e-6; v += k) s.add(round6(v)); });
    return Array.from(s).sort(function (a, b) { return a - b; });
  }
  /* 吸附用：取已勾选间隔里**最小**的一套（最密的网格），与旧版单值语义最接近 */
  function gratSnapStep(kind) { return gratStepKeys(kind)[0]; }
  function gratParLats() {
    const s = new Set();
    gratStepKeys('par').forEach(function (k) {
      for (let v = -90 + k; v <= 90 - k + 1e-6; v += k) s.add(round6(v));
    });
    return Array.from(s).sort(function (a, b) { return a - b; });
  }
  function gratRebuild(grp, merLons, parLats) {
    const twM = Math.max(state.style.ln.mer.w, 0.0004), twP = Math.max(state.style.ln.par.w, 0.0004);
    if (_gratWM < 0) _gratWM = twM;
    if (_gratWP < 0) _gratWP = twP;
    const mg = gratMerGeo || new THREE.TorusGeometry(GRAT_R, twM, 6, 128);
    // 经线：每个已选间隔的倍数各一条大圆（并集，去重）
    grp.userData.mer.forEach(function (m) { grp.remove(m); });
    grp.userData.mer = [];
    (merLons || gratMerLons()).forEach(function (lon) {
      const m = new THREE.Mesh(mg, grp.userData.matMer);
      m.rotation.set(0, lon * D, Math.PI / 2);
      m.renderOrder = 20;
      grp.add(m); grp.userData.mer.push(m);
    });
    // 纬线：每个已选间隔的倍数各一条（含赤道，排除两极点）
    grp.userData.par.forEach(function (m) { if (m.geometry) m.geometry.dispose(); grp.remove(m); });
    grp.userData.par = [];
    (parLats || gratParLats()).forEach(function (lat) {
      const r = Math.cos(lat * D) * GRAT_R;
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, _gratWP, 6, 160), grp.userData.matPar);
      m.rotation.x = -Math.PI / 2; m.position.y = Math.sin(lat * D) * GRAT_R;
      m.userData.lat = lat; m.renderOrder = 20;
      grp.add(m); grp.userData.par.push(m);
    });
  }
  function buildGraticule(parent) {
    const grp = new THREE.Group(); parent.add(grp);
    const matMer = tubeMat('#FFFFFF', 0.17), matPar = tubeMat('#FFFFFF', 0.17);
    grp.userData.mat = matMer;                 // 兼容旧引用
    grp.userData.matMer = matMer; grp.userData.matPar = matPar;   // v15.0 经线 / 纬线样式分开
    grp.userData.mer = []; grp.userData.par = [];
    gratRebuild(grp, gratMerLons(), gratParLats());   // 按当前「显示间隔」生成
    _gratMerStep = gratStepKeys('mer').join(','); _gratParStep = gratStepKeys('par').join(',');
    gratGroups.push(grp);
    return grp;
  }
  const graticule = buildGraticule(spin);
  const graticuleOrb = buildGraticule(spinOrb);

  /* ============ 重要纬线（赤道 / 回归线 / 极圈） ============ */
  function buildBandGeometry(seg) {
    const n = (seg + 1) * 2;
    const az = new Float32Array(n), sd = new Float32Array(n), pos = new Float32Array(n * 3);
    const idx = [];
    for (let j = 0; j <= seg; j++) {
      const a = (TWO_PI * j) / seg;
      az[j * 2] = a; sd[j * 2] = -1;
      az[j * 2 + 1] = a; sd[j * 2 + 1] = 1;
    }
    for (let j = 0; j < seg; j++) {
      const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('azimuth', new THREE.BufferAttribute(az, 1));
    g.setAttribute('bside', new THREE.BufferAttribute(sd, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.15);
    return g;
  }
  const bandGeo = buildBandGeometry(360);
  const bandVS = `
    attribute float azimuth; attribute float bside;
    uniform float uLat, uWidth, uRadius;
    varying float vAz; varying float vSide;
    void main(){
      float lat = uLat + bside * uWidth;
      float cl = cos(lat), sl = sin(lat);
      vec3 p = vec3(cl * cos(azimuth), sl, cl * sin(azimuth)) * uRadius;
      vAz = azimuth; vSide = bside;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `;
  const bandFS = `
    uniform vec3 uColor; uniform float uOpacity, uDash, uDashN, uDashRatio;
    varying float vAz; varying float vSide;
    ${SRGB_FN}
    void main(){
      float a = uOpacity;
      // 带边缘（横向）抗锯齿
      float e = max(fwidth(vSide) * 1.1, 1e-4);
      a *= 1.0 - smoothstep(1.0 - e, 1.0, abs(vSide));
      // 虚线：沿纬圈按方位角周期开合
      if (uDash > 0.5) {
        float t = vAz * 0.15915494 * uDashN;
        float f = fract(t);
        float w = clamp(fwidth(t) * 0.6, 1e-4, 0.5);
        a *= smoothstep(0.0, w, f) * (1.0 - smoothstep(uDashRatio, uDashRatio + w, f));
      }
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function makeBand(latDeg) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLat: { value: latDeg * D }, uWidth: { value: 0.35 * D }, uRadius: { value: 1.0045 },
        uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0.9 },
        uDash: { value: 0 }, uDashN: { value: 72 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: bandVS, fragmentShader: bandFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(bandGeo, mat);
    m.renderOrder = 20;
    spin.add(m);
    return m;
  }
  const bandEq = makeBand(0);
  const bandTrN = makeBand(23.43928), bandTrS = makeBand(-23.43928);
  const bandArN = makeBand(66.5607), bandArS = makeBand(-66.5607);
  const bands = [bandEq, bandTrN, bandTrS, bandArN, bandArS];
  function setBand(mat, cfg, dashed) {
    mat.uniforms.uColor.value.set(cfg.color);
    mat.uniforms.uOpacity.value = cfg.op;
    mat.uniforms.uWidth.value = Math.max(cfg.w, 0.02) * D;
    mat.uniforms.uDash.value = dashed ? 1 : 0;
    mat.uniforms.uDashN.value = cfg.n;
    mat.uniforms.uDashRatio.value = cfg.ratio;
  }
  // 公转场景中的重要纬线：克隆材质、共享几何体，样式与自转完全一致
  function cloneBand(src, parent) {
    const m = new THREE.Mesh(src.geometry, src.material.clone());
    m.renderOrder = src.renderOrder; parent.add(m); return m;
  }
  const bandEqOrb = cloneBand(bandEq, spinOrb);
  const bandTrNOrb = cloneBand(bandTrN, spinOrb), bandTrSOrb = cloneBand(bandTrS, spinOrb);
  const bandArNOrb = cloneBand(bandArN, spinOrb), bandArSOrb = cloneBand(bandArS, spinOrb);

  /* ============ 本初子午线（0° 经线）：特殊经线，单独控制、始终实线（v9.0） ============ */
  // v9.0 修复：本初子午线是 0° 经线 —— 一条 南极→北极 的半圆弧，不是整条大圆。
  // 旧实现复用赤道整圆 bandGeo 立起 90°，会把 180° 经线一侧也画出来，且旋转后实际
  // 落在 ±90° 经线上（显示位置错误）。现改为专用半圆几何 + 专用顶点着色器：
  // 几何直接建在方位角 0（a = -lon 约定下即 0° 经线，+X 方向），无需任何旋转。
  function buildMerHalfGeo(seg) {
    const n = (seg + 1) * 2;
    const mlat = new Float32Array(n), sd = new Float32Array(n), pos = new Float32Array(n * 3);
    const idx = [];
    for (let j = 0; j <= seg; j++) {
      const lat = -Math.PI / 2 + (Math.PI * j) / seg;   // 南极 → 北极
      mlat[j * 2] = lat; sd[j * 2] = -1;
      mlat[j * 2 + 1] = lat; sd[j * 2 + 1] = 1;
    }
    for (let j = 0; j < seg; j++) {
      const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mlat', new THREE.BufferAttribute(mlat, 1));
    g.setAttribute('bside', new THREE.BufferAttribute(sd, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.15);
    return g;
  }
  const pmGeo = buildMerHalfGeo(180);
  const merVS = `
    attribute float mlat; attribute float bside;
    uniform float uWidth, uRadius;
    varying float vAz; varying float vSide;
    void main(){
      float az = bside * uWidth;              // 宽度方向 = 经度偏移（半圆弧横向展开）
      float cl = cos(mlat), sl = sin(mlat);
      vec3 p = vec3(cl * cos(az), sl, cl * sin(az)) * uRadius;
      vAz = mlat; vSide = bside;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `;
  function makePrimeMeridian(parent) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: 0.22 * D }, uRadius: { value: 1.0055 },
        uColor: { value: new THREE.Color('#FF5A36') }, uOpacity: { value: 0.95 },
        uDash: { value: 0 }, uDashN: { value: 72 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: merVS, fragmentShader: bandFS,   // 复用 bandFS：边缘抗锯齿 + 虚线（本初子午线恒实线）
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(pmGeo, mat);
    m.renderOrder = 20; parent.add(m); return m;   // 几何已建在 0° 经线上，无需旋转
  }
  const pmEq = makePrimeMeridian(spin);
  const pmEqOrb = makePrimeMeridian(spinOrb);
  function applyPmStyle() {
    const on = !!state.pm.on, L = state.style.ln.pm;
    pmEq.visible = state.graticule && on; pmEqOrb.visible = state.graticule && on;
    // v20.0：本初子午线也允许切换实线 / 虚线（只有南北回归线、南北极圈固定虚线）
    const dashed = L.dash === 'dash';
    setBand(pmEq.material, L, dashed); setBand(pmEqOrb.material, L, dashed);
  }

  /* ============ 监听点纬线圈（昼弧 / 夜弧，可单独控制样式） ============ */
  // 与特殊纬线共用几何体与顶点着色器；片元着色器额外支持“按方位角范围裁剪”，从而把整圈纬线
  // 切成昼弧、夜弧两段（被晨昏线分割）。方位角即该点在 spin 局部系下的经度（与点击换算一致）。
  const orbSunDir = new THREE.Vector3(-1, 0, 0);   // 公转场景中地心指向太阳的世界方向（供分弧使用）
  // 昼夜判定与地球表面着色器完全同源：把太阳方向换算到该 spin 局部系，
  // 用「弧上点方向 · 太阳方向」> 0 判昼（= 0 处即晨昏线），每帧实时重算。
  const monFS = `
    uniform vec3 uColor; uniform float uOpacity;
    uniform vec3 uSunLocal; uniform float uKind;   // uKind: 1 = 昼弧, -1 = 夜弧
    uniform float uLat, uWidth, uDash, uDashN, uDashRatio;
    varying float vAz; varying float vSide;
    ${SRGB_FN}
    void main(){
      float a = uOpacity;
      // 带边缘（横向）抗锯齿
      float e = max(fwidth(vSide) * 1.1, 1e-4);
      a *= 1.0 - smoothstep(1.0 - e, 1.0, abs(vSide));
      // 该像素在球面上的方向（含带宽偏移，故高纬处分界自然呈微倾，与晨昏线严格一致）
      float lat = uLat + vSide * uWidth;
      float cl = cos(lat), sl = sin(lat);
      vec3 dir = vec3(cl * cos(vAz), sl, cl * sin(vAz));
      float s = dot(normalize(dir), normalize(uSunLocal)) * uKind;
      if (s < 0.0) discard;                        // 另一半球交给另一条弧绘制
      float aa = max(fwidth(s) * 1.2, 1e-4);       // 晨昏线处抗锯齿
      a *= smoothstep(0.0, aa, s);
      // 虚线：沿纬圈按方位角周期开合（与球面纬线带同源）
      if (uDash > 0.5) {
        float t = vAz * 0.15915494 * uDashN;
        float f = fract(t);
        float dw = clamp(fwidth(t) * 0.6, 1e-4, 0.5);
        a *= smoothstep(0.0, dw, f) * (1.0 - smoothstep(uDashRatio, uDashRatio + dw, f));
      }
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function makeMonBand(kind) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLat: { value: 0 }, uWidth: { value: 0.5 * D }, uRadius: { value: 1.006 },
        uColor: { value: new THREE.Color('#FFD23F') }, uOpacity: { value: 0.95 },
        uSunLocal: { value: new THREE.Vector3(1, 0, 0) }, uKind: { value: kind },
        uDash: { value: 0 }, uDashN: { value: 64 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: bandVS, fragmentShader: monFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(bandGeo, mat);
    m.renderOrder = 20; m.visible = false;
    return m;
  }
  const monDay = makeMonBand(1), monNight = makeMonBand(-1);
  spin.add(monDay); spin.add(monNight);
  const monDayOrb = makeMonBand(1), monNightOrb = makeMonBand(-1);
  spinOrb.add(monDayOrb); spinOrb.add(monNightOrb);
  function setMonStyle(mat, cfg) {
    mat.uniforms.uColor.value.set(cfg.color);
    mat.uniforms.uOpacity.value = cfg.op;
    mat.uniforms.uWidth.value = Math.max(cfg.w, 0.02) * D;
    mat.uniforms.uDash.value = cfg.dash === 'dash' ? 1 : 0;
    mat.uniforms.uDashN.value = cfg.n;
    mat.uniforms.uDashRatio.value = cfg.ratio;
  }
  // 每帧更新：太阳方向传入各自局部系后，昼弧/夜弧由「局部点·太阳方向」正负实时切分，
  // 分界线即晨昏线，随自转与季节连续移动。
  function updateMonitor() {
    const on = state.mon.circle && !!clickState;
    // 标记球按记录的地理经纬度放置（地理经度固定于地球纹理，不随自转相位变化）
    if (clickState) {
      clickMarker.position.copy(markerLocal(clickState.lat, clickState.lon, _mL1)).normalize();
      clickMarkerOrb.position.copy(markerLocal(clickState.lat, clickState.lon, _mL2)).normalize();
    }
    monDay.visible = on && state.mon.day !== false; monNight.visible = on && state.mon.night !== false;   // v15.0
    monDayOrb.visible = on && state.mon.day !== false; monNightOrb.visible = on && state.mon.night !== false;
    if (!on) return;
    const L = clickState.lat * D;
    const apply = function (dayM, nightM, spinRef, sunWorld) {
      dayM.material.uniforms.uLat.value = L; nightM.material.uniforms.uLat.value = L;
      setMonStyle(dayM.material, state.style.ln.monDay); setMonStyle(nightM.material, state.style.ln.monNight);
      // 世界系太阳方向 → 该 spin 局部系（含地轴倾角），与地球贴图坐标系一致
      localSunDir(spinRef, sunWorld, _sunMon);
      dayM.material.uniforms.uSunLocal.value.copy(_sunMon);
      nightM.material.uniforms.uSunLocal.value.copy(_sunMon);
    };
    apply(monDay, monNight, spin, sunDir);
    apply(monDayOrb, monNightOrb, spinOrb, orbSunDir);
  }
  // 世界系方向 → 指定 spin 的局部系（用于昼夜判定，与地球着色器同源）
  function localSunDir(spinRef, sunWorld, out) {
    spinRef.getWorldQuaternion(_qmon).invert();
    return out.copy(sunWorld).applyQuaternion(_qmon);
  }
  // 监听点此刻的昼夜状态：太阳高度角正弦 = 局部点方向 · 局部太阳方向
  function monitorSunAlt() {
    if (!clickState) return 0;
    const d = markerLocal(clickState.lat, clickState.lon, _mL3);
    const sl = localSunDir(spin, sunDir, _sunAlt);
    return Math.asin(clamp(d.dot(sl), -1, 1)) * R;
  }
  const _qmon = new THREE.Quaternion(), _sunMon = new THREE.Vector3(), _sunAlt = new THREE.Vector3();
  const _mL1 = new THREE.Vector3(), _mL2 = new THREE.Vector3(), _mL3 = new THREE.Vector3();

  /* ======== 赤道地方时时刻标注（v2.9 ①）：0/6/12/18 四个主时刻一组，其余二十个整点一组 ======== */
  // 时刻点固定于「太阳几何」而非地表：12 时 = 直射点经线（正午），6 时 = 晨线∩赤道（早晨），
  // 18 时 = 昏线∩赤道（傍晚），0 时 = 背面子夜线。挂在地轴倾斜层（tilt / tiltOrb）下，
  // 每帧把世界系太阳方向转入该局部系，令 rig 旋转角 = −直射点方位角，即把 12 时对准太阳。
  const HOUR_R = 1.014;                                    // 时刻点所在半径（地球半径 = 1）
  const hourDotGeo = new THREE.SphereGeometry(1, 14, 10);  // 共享点几何，按组缩放
  // 时刻文字：白色绘制 + material.color 染色
  /* v23.10（缺陷修复）：字体 / 字重原先被**硬编码烘焙**进贴图（'bold 44px ' + 字体），
     而且这个精灵**没有登记进 textSprites 重绘表** —— 于是「统一字体 / 统一字重」开启后，
     invalidateNoteSprites() 遍历不到它、贴图永不重绘，地方时注释的字体一直停在创建时那一刻，
     只有字号（走 sp.scale）能跟着变。
     现在改为与其余注释同一套机制：提供 draw(ctx, k) 重绘函数并 registerSprite 登记，
     字体的取值在**绘制时**实时从 noteStyleFor(cat) 取，因此字体 / 字重一旦变更即可重绘生效。 */
  const HOUR_LABEL_CW = 128, HOUR_LABEL_CH = 64, HOUR_LABEL_FPX = 44;
  function mkHourLabel(txt, cat) {
    const draw = function (g2, k) {
      const st = noteStyleFor(cat);
      g2.font = st.weight + ' ' + (HOUR_LABEL_FPX * k) + 'px ' + noteFontOf(cat);
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      // v17.0：文字一律不描边（去黑边），仅实心填充
      g2.fillStyle = '#ffffff'; g2.fillText(txt, HOUR_LABEL_CW / 2 * k, 34 * k);
    };
    const c = document.createElement('canvas'); c.width = HOUR_LABEL_CW; c.height = HOUR_LABEL_CH;
    draw(c.getContext('2d'), 1);
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: true }));
    // 基准尺寸 × 字号 = 最终大小；cw / ch / fpx 供「全局统一」换算字号基准与提升画布分辨率
    registerSprite(sp, 0.5, 0.25, draw, HOUR_LABEL_CW, HOUR_LABEL_CH, HOUR_LABEL_FPX);
    sp.userData.hourLabel = true;   // 标记：样式（含重绘）由 applyHourStyle 单独管理
    return sp;
  }
  function buildHourRig(tiltRef) {
    const rig = new THREE.Group(); tiltRef.add(rig);
    const mk = function (key, hours) {
      const cfg = state.style.pt[key === 'main' ? 'hourMain' : 'hourRest'];
      const grp = new THREE.Group();
      grp.userData.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.color), transparent: true, opacity: cfg.op });
      grp.userData.dots = []; grp.userData.labels = [];
      hours.forEach(function (t) {
        const a = -(t - 12) * 15 * D;                      // 12 时 → 0°（正对 +x），向东时角 → 负方位角
        const dot = new THREE.Mesh(hourDotGeo, grp.userData.mat);
        dot.position.set(Math.cos(a) * HOUR_R, 0.004, Math.sin(a) * HOUR_R);
        dot.renderOrder = 30;                              // 与标注一致：只被地球遮挡，不被光线挡住
        grp.add(dot); grp.userData.dots.push(dot);
        const lab = mkHourLabel(t + '时', key === 'main' ? 'hourMain' : 'hourRest');
        const r2 = HOUR_R + 0.055;                         // 标注统一紧贴时刻点（15° 间距远大于文字宽度，无需奇偶错开）
        lab.position.set(Math.cos(a) * r2, 0.05, Math.sin(a) * r2);
        lab.renderOrder = 43;                              // v23.12：文字层顶（43：经纬度40<温度带41<时区42<地方时43），只被地球遮挡
        grp.add(lab); grp.userData.labels.push(lab);
      });
      grp.visible = cfg.on;
      rig.add(grp);
      return grp;
    };
    rig.userData.main = mk('main', [0, 6, 12, 18]);
    rig.userData.rest = mk('rest', [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23]);
    return rig;
  }
  const hourRig = buildHourRig(tilt);
  const hourRigOrb = buildHourRig(tiltOrb);
  const _qh = new THREE.Quaternion(), _sunHour = new THREE.Vector3();
  // 每帧：太阳方向（世界系）→ tilt 局部系 → rig 对准直射点经线（12 时贴太阳，随季节/自转实时移动）
  function updateHourMarks() {
    const setRig = function (rig, sunWorld, tiltRef) {
      tiltRef.getWorldQuaternion(_qh).invert();
      _sunHour.copy(sunWorld).applyQuaternion(_qh);
      rig.rotation.y = -Math.atan2(_sunHour.z, _sunHour.x);
    };
    setRig(hourRig, sunDir, tilt);
    setRig(hourRigOrb, orbSunDir, tiltOrb);
  }
  // 样式（applyAll 调用）：可见性 / 点大小与颜色（点样式独立）+ 文字样式（由 note 分类统一控制）
  // v23.0（需求④）：原 HOUR_TXT_BASE = { main: 0.40, rest: 0.27 }（两类标注各自的历史倍率）
  //   已删除 —— 它与「字号基准归一」是两套量纲，会让时刻标注的字号滑条与总字号滑条
  //   对不上（同一个数大小不一样）。现在一律走 unifyBaseK，与其余注释完全同量纲。
  function applyHourStyle() {
    [hourRig, hourRigOrb].forEach(function (rig) {
      // v21.0（需求⑩）：时刻标注挂在公转场景的那一份也要做相机后退补偿，
      //   否则「全局统一」后它在公转视图里会比别的注释小一截。
      const orbMul = (rig === hourRigOrb) ? orbAnnMul() : 1;
      ['main', 'rest'].forEach(function (key) {
        const grp = rig.userData[key], cfg = state.style.pt[key === 'main' ? 'hourMain' : 'hourRest'];
        const st = noteStyleFor(key === 'main' ? 'hourMain' : 'hourRest');
        grp.visible = cfg.on !== false;                         // 标注点开关只控制点，不控制文字
        grp.userData.mat.color.set(cfg.color); grp.userData.mat.opacity = cfg.op;
        grp.userData.dots.forEach(function (d2) { d2.scale.setScalar(cfg.size); });
        grp.userData.labels.forEach(function (sp) {
          // 层级（需求③）：文字显隐由注释分类只判自身，地理事物开关（主 / 其余时刻点）另判
          // v23.11：门控结果记到 noteGate，供渲染前的「置顶 + 背面剔除」(earthNotesPass) 复用 ——
          //   最终 visible 由剔除函数统一合成（门控 ∩ 正面朝向），避免把「本帧转到背面」误判为门控关闭。
          sp.userData.noteGate = st.show && thingGateOn(key === 'main' ? 'hourMain' : 'hourRest');
          sp.visible = sp.userData.noteGate;
          // v23.0（需求④）：字号基准归一恒生效（与其余注释完全一致）——
          //   于是「时刻标注」分类的字号滑条与总字号滑条同量纲：同一个数 = 一样大。
          const mul = unifyBaseK(sp) * orbMul;
          const s = st.size * mul;
          setNoteScale(sp, sp.userData.baseW * s, sp.userData.baseH * s);
          // v23.10：按字号提升贴图分辨率，并在「字体 / 字重」变更（invalidateNoteSprites 把 dpi
          //   归 0）后重绘贴图 —— 这是地方时注释字体能跟着「统一字体」生效的关键一步。
          spriteDPI(sp, noteDPI(st.size));
          sp.material.color.set(st.color);
          sp.userData.baseOp = st.op;   // v23.12：记录基准透明度，供每帧「临边淡出」按朝向度折算
          sp.material.opacity = st.op;
        });
      });
    });
  }

  /* ============ 地轴（自转 / 公转共用材质与构建器） ============ */
  const axisMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#7DD3FC'), transparent: true, opacity: 1 });
  let AXIS_LEN = state.axisLen;            // 地轴长度（地球半径倍数），可在面板调节
  const AXIS_SEG = 28;      // 地轴杆等分段数：虚线 = 隔段隐藏，实线 = 全部显示
  function mkAxisLabel(txt, key) {
    const draw = function (g2, k) {
      g2.font = 'bold ' + (76 * k) + 'px ' + noteFontOf('axis');
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      // v17.0：文字一律不描边（去黑边），仅实心填充
      g2.fillStyle = '#e8f4ff'; g2.fillText(txt, 64 * k, 66 * k);
    };
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    draw(c.getContext('2d'), 1);
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: true }));
    const s2 = registerSprite(sp, 0.18, 0.18, draw, 128, 128, 76);
    s2.userData.cat = 'axis'; if (key) s2.userData.key = key;   // v15.0：N / S 各自独立控制
    return s2;
  }
  function buildAxisRig(group) {
    const rig = { group: group, caps: [], segs: [] };
    rig.rod = new THREE.Group(); group.add(rig.rod);
    const h = AXIS_LEN / AXIS_SEG;
    for (let i = 0; i < AXIS_SEG; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, h, 12, 1, true), axisMat);
      seg.position.y = -AXIS_LEN / 2 + h * (i + 0.5);
      seg.userData.h = h;
      rig.rod.add(seg); rig.segs.push(seg);
    }
    [-1, 1].forEach(function (s) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), axisMat);
      cap.position.y = s * (AXIS_LEN / 2);
      group.add(cap); rig.caps.push(cap);
    });
    const ln = mkAxisLabel('N', 'axis.N'); ln.position.y = AXIS_LEN / 2 + 0.16;
    const ls = mkAxisLabel('S', 'axis.S'); ls.position.y = -AXIS_LEN / 2 - 0.16;
    rig.labels = [ln, ls];                       // 记录 N / S 标签，长度变化时重摆
    group.add(ln); group.add(ls);
    return rig;
  }
  // 按当前 AXIS_LEN 重摆杆段 / 端点 / N·S 标签（长度可调的核心）
  function rebuildAxisRig(rig, radius, dash) {
    const h = AXIS_LEN / AXIS_SEG;
    rig.segs.forEach(function (s, i) {
      s.geometry.dispose();
      s.geometry = new THREE.CylinderGeometry(radius, radius, h, 12, 1, true);
      s.userData.h = h;
      s.position.y = -AXIS_LEN / 2 + h * (i + 0.5);
      s.visible = !dash || (i % 2 === 0);          // 虚线：隔段隐藏
    });
    rig.caps.forEach(function (c, i) {
      const s = i === 0 ? -1 : 1;
      c.geometry.dispose();
      c.geometry = new THREE.SphereGeometry(Math.max(radius * 1.9, 0.012), 16, 12);
      c.position.y = s * (AXIS_LEN / 2);
    });
    if (rig.labels) {
      rig.labels[0].position.y = AXIS_LEN / 2 + 0.16;
      rig.labels[1].position.y = -AXIS_LEN / 2 - 0.16;
    }
  }
  let _axisR = -1, _axisDash = null, _axisLen = -1;
  function applyAxisStyle() {
    const L = state.style.ln.axis, r = Math.max(L.w, 0.0008), d = L.dash === 'dash';
    axisGroup.visible = state.axis; axisOrbGroup.visible = state.axis;
    const lenChanged = Math.abs(AXIS_LEN - state.axisLen) > 1e-7;
    if (lenChanged) AXIS_LEN = state.axisLen;   // 长度变化：更新模块变量，交给 rebuildAxisRig 重摆
    if (Math.abs(r - _axisR) > 1e-7 || d !== _axisDash || lenChanged) {   // 粗细 / 线型 / 长度任一变化即重建
      _axisR = r; _axisDash = d; _axisLen = AXIS_LEN;
      rebuildAxisRig(axisRigMain, r, d); rebuildAxisRig(axisRigOrb, r, d);
    }
    axisMat.color.set(L.color); axisMat.opacity = L.op;
  }
  const axisGroup = new THREE.Group(); tilt.add(axisGroup);
  const axisRigMain = buildAxisRig(axisGroup);
  const axisOrbGroup = new THREE.Group(); tiltOrb.add(axisOrbGroup);
  const axisRigOrb = buildAxisRig(axisOrbGroup);

  /* ============ 温度带（五带填充 · 自转/公转/综合所有视图统一） ============ */
  function makeZone(parent, geo) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.renderOrder = 6; parent.add(m); return m;   // v27.1（需求⑤）：温度带填充 —— 面层内高于海陆/七大洲（4/5）
  }
  // 五带填充的统一着色（自转 / 公转两套网格共用，避免重复书写五个分支）
  function applyZoneSet(set) {
    const z = state.style.fill.zone, on = !!state.zones.on;
    ['tropic', 'tempN', 'tempS', 'coldN', 'coldS'].forEach(function (k) {
      const m = set[k]; if (!m) return;
      m.visible = on && (state.zones.bands ? state.zones.bands[k] !== false : true);   // v15.0 单独显示
      m.material.color.set(z['c' + k.charAt(0).toUpperCase() + k.slice(1)]);
      m.material.opacity = z.op;
    });
    applyZoneLines();                                   // v27.1（需求④）：分界线随填充联动刷新
  }
  /* v23.0（需求①）：五带分界描边（makeLatBand / buildZoneStroke / applyZoneStroke / zSR / zSO）
     整块删除 —— 「纬度带描边及其设置」全部取消，五带只保留填充面与各带颜色。
     回归线 / 极圈的分界线本身仍可在「经纬网 › 特殊经纬线」里单独开关，不受影响。 */
  const zGeoTropic = sphereBandGeom(-TROPIC_LAT * D, TROPIC_LAT * D, 1.012);
  const zGeoTempN = sphereBandGeom(TROPIC_LAT * D, POLAR_LAT * D, 1.012);
  const zGeoTempS = sphereBandGeom(-POLAR_LAT * D, -TROPIC_LAT * D, 1.012);
  const zGeoColdN = sphereBandGeom(POLAR_LAT * D, 90 * D, 1.012);
  const zGeoColdS = sphereBandGeom(-90 * D, -POLAR_LAT * D, 1.012);
  // 自转视图（scene）中的温度带
  const zR = {
    tropic: makeZone(tilt, zGeoTropic),
    tempN: makeZone(tilt, zGeoTempN), tempS: makeZone(tilt, zGeoTempS),
    coldN: makeZone(tilt, zGeoColdN), coldS: makeZone(tilt, zGeoColdS),
  };
  // 公转场景中的温度带：共享同一组几何体
  const zO = {
    tropic: makeZone(tiltOrb, zGeoTropic),
    tempN: makeZone(tiltOrb, zGeoTempN), tempS: makeZone(tiltOrb, zGeoTempS),
    coldN: makeZone(tiltOrb, zGeoColdN), coldS: makeZone(tiltOrb, zGeoColdS),
  };
  // v23.0：原 zSR / zSO（五带分界描边）随「纬度带描边」一并删除
  /* ---- v27.1（需求④）：五带分界线（南北回归线 / 南北极圈共 4 条）----
     与 v23.0 删掉的「面描边」不同：这是**独立图层**，有自己的显隐开关（zones.line）
     与独立线型（style.fill.zone.line），不随填充面开关联动，随黄赤交角重建位置。 */
  function zoneLineSet(parent) {
    const grp = new THREE.Group(); parent.add(grp);
    const mk = function () {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
      }));
      m.renderOrder = 7; grp.add(m); return m;   // v27.1（需求⑤）：温度带分界线 —— 高于温度带填充（6）
    };
    return { grp: grp, trN: mk(), trS: mk(), arN: mk(), arS: mk() };
  }
  const zLR = zoneLineSet(tilt), zLO = zoneLineSet(tiltOrb);
  function rebuildZoneLineGeos() {
    const F = state.style.fill.zone.line, R = 1.0128;   // 略高于五带填充（1.012），避免 z-fighting
    /* v35（需求二）：温度带分界线固定**虚线** —— dash 写死，旧档残留 solid 无效 */
    const cfg = { dash: 'dash', n: F.n, ratio: F.ratio };
    [zLR, zLO].forEach(function (S) {
      [['trN', TROPIC_LAT], ['trS', -TROPIC_LAT], ['arN', POLAR_LAT], ['arS', -POLAR_LAT]].forEach(function (e) {
        const pts = []; for (let i = 0; i <= 96; i++) pts.push([-180 + 3.75 * i, e[1]]);
        const g = spherePolylineGeom(pts, R, (F.w || 0.3) * D * 0.5, 3, cfg);
        const m = S[e[0]]; const old = m.geometry; m.geometry = g; if (old) old.dispose();
      });
    });
  }
  var _zoneLineSig = '';
  function applyZoneLines() {
    const F = state.style.fill.zone.line, on = !!state.zones.on && !!state.zones.line;
    /* ★ v36（需求三）：线粗细 / 虚线密度 / 虚实比烘在几何里 —— 旧实现只有黄赤交角变化
       才重建几何，拖这三个滑块（以及颜色 / 透明度）全部「没反应」。现在走签名缓存：
       样式任何一项变化 ⇒ 下一帧重建一次几何；颜色 / 透明度仍走材质直写。 */
    const sig = [F.w, F.n, F.ratio].join('|');
    if (sig !== _zoneLineSig) { _zoneLineSig = sig; rebuildZoneLineGeos(); }
    [zLR, zLO].forEach(function (S) {
      S.grp.visible = on;
      ['trN', 'trS', 'arN', 'arS'].forEach(function (k) {
        const m = S[k]; if (!m) return;
        m.material.color.set(F.color); m.material.opacity = F.op;
      });
    });
  }

  /* ============ 黄赤交角（v10.0 核心参数）：二面可视化 + 全局联动 ============
     ε = 黄赤交角 = 地轴倾角 = 回归线纬度 = 90° − 极圈纬度，并决定太阳视赤纬的年内振幅
     （sin δ = sin ε · sin λ）。因此「黄赤交角 → 直射点回归运动 → 昼夜长短 → 五带划分」
     是一条严格因果链：ε 一改，地轴倾角、直射点纬度、昼长、回归线 / 极圈与五带范围
     全部同步更新。默认 23°26′，可调 0°–90°（0° = 全年昼夜等长无四季，90° = 地轴躺在轨道面上）。 */
  /* ===== v21.0（需求③）：注释显隐的「三级层级」=====
     ① 全局文字注释总开关（note.master.on，由 noteStyleFor 的 st.show 判定）
     ② 地理事物开关（本函数 thingGateOn）
     ③ 该注释分类 / 单项开关（noteSwitchOn）
     三级是严格的「与」关系：上一层没打开，下一层的注释一律不显示；
     菜单里被上级压住的开关由 syncMenuGates() 同步置灰并禁用，保证「先开总开关 →
     再开地理事物 → 最后开注释」这个顺序在界面上也是自明的。
     例：晨昏线 → 显示晨昏线 → 晨线 → 晨线注释；经纬网 → 显示经纬网 → 经线 → 经度注释。 */
  function thingGateOn(cat, sp) {
    const P = state.style.pt;
    switch (cat) {
      case 'ray': return !!state.rays;                        // 光照与太阳光线 → 显示太阳光线箭头
      case 'dawn': return !!state.term && !!state.dawn.on;    // 晨昏线 → 晨线
      case 'dusk': return !!state.term && !!state.dusk.on;    // 晨昏线 → 昏线
      case 'hourMain': return P.hourMain.on !== false;        // 地方时刻 → 四个主时刻点
      case 'hourRest': return P.hourRest.on !== false;        // 地方时刻 → 其余二十个时刻点
      case 'pts': return !!state.points.show;                 // 标注点 → 点样式显隐
      case 'orbit': return !!state.orb.orbit.on;              // 公转系统 → 公转轨道
      // v26.1（需求⑫）：黄赤交角补「总开关」orb.planes.on（此前该字段是死配置，无人读取）——
      //   它是二级菜单标题前的开关，关掉后黄道面 / 赤道面及其注记一并隐藏；
      //   「黄赤交角」滑杆本身是物理参数（决定地轴倾角与直射点回归），不受它影响。
      case 'ecl': return !!state.orb.planes.on && !!state.orb.planes.ecl;
      case 'equ': return !!state.orb.planes.on && !!state.orb.planes.equ;
      // v25.1（需求⑤）：海陆分布 / 七大洲 → 各自的面总开关
      case 'sea': return !!state.geo.landSea.on;
      case 'cont': return !!state.geo.cont.on;
      // v25.1（需求⑦）：时差演示 → 面总开关 + 该要素自身的显隐开关
      case 'tzdiffTz0': return !!state.tzdiff.on && state.tzdiff.tz0.on !== false;
      case 'tzdiffIdl': return !!state.tzdiff.on && state.tzdiff.idl.on !== false;
      case 'tzdiffZero': return !!state.tzdiff.on && state.tzdiff.zero.on !== false;
      case 'tzdiffNew': return !!state.tzdiff.on && state.tzdiff.newDay.on !== false;
      case 'tzdiffOld': return !!state.tzdiff.on && state.tzdiff.oldDay.on !== false;
      // v25.1（需求⑧）：球面最短距离 → 总开关 + 两个端点都已确定，才谈得上注记
      case 'gcdDist': return !!state.gcd.on && !!(state.gcd.a && state.gcd.b);
      // v26.1（需求⑤）：端点标注只要「总开关开着 + 该端点已确定」就显示 ——
      //   取点过程中也要实时标出已选中的点（此前要求两端都齐，导致刚点完 A 看不到任何反馈）。
      case 'gcdEnd': {
        if (!state.gcd.on) return false;
        const k = sp && sp.userData && sp.userData.key;   // 'A' / 'B'（见 makeGcdEndSprite）
        if (k === 'A') return !!state.gcd.a;
        if (k === 'B') return !!state.gcd.b;
        return !!(state.gcd.a || state.gcd.b);
      }
      // v26.1（需求⑨）：四组区域面 → 各自的面总开关
      case 'hemiEW': return !!state.hemi.ew.on;
      case 'hemiNS': return !!state.hemi.ns.on;
      case 'latBelt': return !!state.latbelt.on;
      default: return true;
    }
  }
  // v23.5：赤道（eq）从「纬度」里拆出，改用独立的「赤道（标文字）」开关（grat.note.eq），
  //   与南北回归线 / 极圈 / 本初子午线同为「特殊经纬线」单独控制。
  const LAT_NOTE_MAP = { eq: 'eq', trN: 'tr', trS: 'tr', arN: 'ar', arS: 'ar' };
  function noteSwitchOn(noteObj, subKey) {
    return noteObj && noteObj.on !== false && !(subKey && noteObj[subKey] === false);
  }
  /* ★ v53（需求二·2 / 全局需求·2）：全局文字注释门控的**优先级链**。
     从高到低：
       ① 显示/隐藏全局文字注释（note.master.on，由上方 noteStyleFor 的 st.show 判定）
       ② 二级菜单标题开关（catGateOff：菜单里「文字注释」这一级的总开关）
       ③ 地理事物开关（thingGateOn：该注释所属的地理事物本身是否显示）
       ④ 自身文字注释开关（noteSwitchOn：该分类 / 该项自己的开关）
     v53 前 ② 与 ③ 的次序在部分分支里是反的（例如 spriteNoteGate 的 cat 分支先查自身
     开关、再由别处补查地理事物），导致「关掉地理事物却仍显示文字」或反之。
     这里把 ②③ 抽成显式的两级判定并固定次序，④ 保持各 cat 分支的既有语义不变。 */
  function noteGateLevel2(cat, sp) {
    if (catGateOff(cat)) return false;              // ② 二级菜单标题开关
    if (!thingGateOn(cat, sp)) return false;        // ③ 地理事物开关
    return true;
  }
  function spriteNoteGate(sp) {
    const _c0 = sp && sp.userData && sp.userData.cat;
    if (_c0 && !noteGateLevel2(_c0, sp)) return false;   // 优先级 ② → ③
    const cat = sp.userData.cat, k = sp.userData.key || '';
    const k2 = k.indexOf('.') >= 0 ? k.slice(k.indexOf('.') + 1) : k;
    if (!thingGateOn(cat, sp)) return false;                              // ② 地理事物开关
    if (cat === 'zone') {
      if (!state.zones.on) return false;                                    // 温度带总开关
      if (state.zones.bands && state.zones.bands[k2] === false) return false; // 单带开关
      return noteSwitchOn(state.zones.note, k2);
    }
    if (cat === 'lat') {
      if (!state.graticule) return false;                                   // 经纬网总开关
      // 本初子午线（0° 经线）标注：随地球自转，受「本初子午线」开关 + 经纬网文字注释 › 本初子午线 控制
      if (sp.userData.gratPm) return !!state.pm.on && noteSwitchOn(state.grat.note, 'pm');
      // v20.0：经度 / 纬度 数字标注（v21.0 起还要求「经线 / 纬线」本身是显示的）
      if (sp.userData.gratLon) return !!state.grat.mer && noteSwitchOn(state.grat.note, 'lon');
      if (sp.userData.gratLat) return !!state.grat.par && noteSwitchOn(state.grat.note, 'lat');
      const map = LAT_NOTE_MAP[k2]; if (!map) return true;
      // 特殊经纬线自身开关：eq / tr / ar / pm
      if (k2 === 'eq' && !state.eq.on) return false;
      if ((k2 === 'trN' || k2 === 'trS') && !state.tr.on) return false;
      if ((k2 === 'arN' || k2 === 'arS') && !state.ar.on) return false;
      return noteSwitchOn(state.grat.note, map);
    }
    if (cat === 'axis') {
      if (!state.axis) return false;                                        // 地轴总开关
      const a = state.axisNote;
      if (k2 === 'N' && a && a.n === false) return false;
      if (k2 === 'S' && a && a.s === false) return false;
      return noteSwitchOn(a);
    }
    // v23.0（需求②）：极昼 / 极夜注释同样受「显示极昼极夜」总开关约束（此前漏判这一级，
    //   关掉总开关后区域虽然隐藏、注释却能单独显示，层级不自洽）
    if (cat === 'pd') return !!state.polar && !!state.polarNote.on && !!state.pd.on && noteSwitchOn(state.note.cats.pd);
    if (cat === 'pn') return !!state.polar && !!state.polarNote.on && !!state.pn.on && noteSwitchOn(state.note.cats.pn);
    /* state.term / dawn.on / dusk.on 已在 thingGateOn 里判过，这里只加组级总开关 */
    if (cat === 'dawn') return !!state.termNote.on && noteSwitchOn(state.note.cats.dawn);
    if (cat === 'dusk') return !!state.termNote.on && noteSwitchOn(state.note.cats.dusk);
    /* ★ v41（需求二·2）：晨昏线 / 极昼极夜的文字注释各多一级「组级总开关」
       （termNote / polarNote），结构同「地方时刻 › 文字注释（主时刻 / 其余时刻）」。 */
    // v26.1（需求⑫）：地方时刻补「总开关」hour.on —— 二级菜单标题前的开关就是它，
    //   总开关关掉时两组时刻点及其注记一并隐藏（此前该菜单没有总开关）。
    if (cat === 'hourMain') return !!state.hour.on && noteSwitchOn(state.note.cats.hourMain);
    if (cat === 'hourRest') return !!state.hour.on && noteSwitchOn(state.note.cats.hourRest);
    if (cat === 'pts') return noteSwitchOn(state.note.cats.pts);
    if (cat === 'orbit') return noteSwitchOn(state.note.cats.orbit);
    // v28（需求③）：公转速度演示的标注 —— 总开关 spd.on + 该分类的文字注释开关
    // v29（需求⑤）：近日点 / 远日点位置标注还要受「显示位置标记」与「名称 / 日期 / 日地距离」子开关约束
    if (cat === 'spd') {
      if (!state.spd.on) return false;
      if (sp) {
        const kk = sp.userData.key;
        if (kk === 'spd.peri' || kk === 'spd.aph') {
          const sd = state.spd;
          if (!sd.apsis) return false;
          if (!(sd.apsisName || sd.apsisDate || sd.apsisDist)) return false;
        }
      }
      return noteSwitchOn(state.note.cats.spd);
    }
    // 黄道面 / 赤道面：② 的平面开关已在 thingGateOn 里判过，这里只判「文字注释」这一级
    if (cat === 'ecl') return noteSwitchOn(state.note.cats.ecl);
    if (cat === 'equ') return noteSwitchOn(state.note.cats.equ);
    if (cat === 'tz') return !!state.tz.on && noteSwitchOn(state.note.cats.tz);
    // v25.1（需求⑤）：海陆分布（四大洋）/ 七大洲 —— ② 已在 thingGateOn 里判过面总开关，
    //   七大洲再判「该洲是否单独显示」（关掉的洲连同其名称一起隐藏）。
    if (cat === 'sea') return noteSwitchOn(state.geo.landSea.note);
    if (cat === 'cont') {
      if (state.geo.cont.list && state.geo.cont.list[k2] === false) return false;
      return noteSwitchOn(state.geo.cont.note);
    }
    // v25.1（需求⑦）：时差演示的 5 条注记，各自一个开关（tzdiff.note.tz0 / idl / zero / newDay / oldDay）
    if (TZDIFF_NOTE_CAT[k2]) return noteSwitchOn(state.tzdiff.note, k2);
    // v25.1（需求⑧）：球面最短距离的两类注记 —— ② 已在 thingGateOn 里判过总开关与
    //   「两端点是否确定」，这里只判各自的注释开关（gcd.note.dist / gcd.note.end）。
    if (cat === 'gcdDist') return noteSwitchOn(state.gcd.note, 'dist');
    if (cat === 'gcdEnd') return noteSwitchOn(state.gcd.note, 'end');
    // v26.1（需求⑨）：四组区域面注记 —— ② 已在 thingGateOn 里判过各自的面总开关，
    //   这里再判「该区域 / 该板块 / 该边界是否单独显示」+ 各自的注释开关。
    if (cat === 'hemiEW') {
      if (state.hemi.ew[k2] === false) return false;
      return noteSwitchOn(state.hemi.ew.note, k2);
    }
    if (cat === 'hemiNS') {
      if (state.hemi.ns[k2] === false) return false;
      return noteSwitchOn(state.hemi.ns.note, k2);
    }
    if (cat === 'latBelt') {
      /* v27.0（需求二.4）：注记 key 为 lowN / lowS / midN / … —— 归一化回分带键后再判
         「该带是否单独显示」与「该带注释开关」，南北两条同受同一组开关控制。 */
      const bk = String(k2).replace(/N$|S$/, '');
      if (state.latbelt.bands && state.latbelt.bands[bk] === false) return false;
      return noteSwitchOn(state.latbelt.note, bk);
    }
    // v26.1（需求⑫）：二十四节气补「总开关」terms.on（二级菜单标题前的开关）
    if (cat === 'terms') return !!state.terms.on && !!state.orb.terms.on && noteSwitchOn(state.note.cats.terms);
    if (cat === 'terms24') return !!state.terms.on && !!state.orb.terms24.on && noteSwitchOn(state.note.cats.terms24);
    // 太阳光线注释（自转「太阳光」+ 公转「直射光线」）：② 已在 thingGateOn 里判过
    if (cat === 'ray') return noteSwitchOn(state.note.cats.ray);
    return true;
  }
  function setBandLat(mesh, latDeg) { if (mesh && mesh.material) mesh.material.uniforms.uLat.value = latDeg * D; }
  // 五带填充几何：随回归线 / 极圈纬度重建（自转与公转两套网格共用同一份几何）
  function rebuildZoneGeos() {
    const mk = {
      tropic: sphereBandGeom(-TROPIC_LAT * D, TROPIC_LAT * D, 1.012),
      tempN: sphereBandGeom(TROPIC_LAT * D, POLAR_LAT * D, 1.012),
      tempS: sphereBandGeom(-POLAR_LAT * D, -TROPIC_LAT * D, 1.012),
      coldN: sphereBandGeom(POLAR_LAT * D, 90 * D, 1.012),
      coldS: sphereBandGeom(-90 * D, -POLAR_LAT * D, 1.012),
    };
    Object.keys(mk).forEach(function (k) {
      const g = mk[k], a = zR[k], b = zO[k];
      const old = a ? a.geometry : null;
      if (a) a.geometry = g;
      if (b) b.geometry = g;
      if (old && old !== g) old.dispose();
    });
    rebuildZoneLineGeos();                              // v27.1（需求④）：分界线纬度随 ε 重建
  }
  // 地表注释（回归线 / 极圈 / 五带名称）所在纬度跟随 ε
  function syncSurfSpecLat() {
    const T = TROPIC_LAT, P = POLAR_LAT;
    SURF_SPEC.forEach(function (s) {
      if (s.k === 'trN') s.lat = T;
      else if (s.k === 'trS') s.lat = -T;
      else if (s.k === 'arN') s.lat = P;
      else if (s.k === 'arS') s.lat = -P;
      else if (s.k === 'tempN') s.lat = (T + P) / 2;
      else if (s.k === 'tempS') s.lat = -(T + P) / 2;
      else if (s.k === 'coldN') s.lat = (90 + P) / 2;
      else if (s.k === 'coldS') s.lat = -(90 + P) / 2;
    });
    invalidateNoteSprites();
  }
  /* ---- 黄道面 / 赤道面 ----
     黄道面 = 公转轨道所在平面（过太阳、含整条轨道）；赤道面 = 垂直地轴的地球赤道平面。
     赤道面挂在 tiltOrb 下随倾角自动摆正，黄道面固定在轨道平面。
     v20.0：① 两者默认隐藏；② 删除「黄赤交角」角度展示（原交角扇形 oblArc + 文字标注）；
            ③ 名称标注移到圆盘外侧、且抬离盘面，避免与盘面/地球穿模、也不再压住盘面中心。 */
  function makePlaneMesh(parent, colorHex, op) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.renderOrder = 3; parent.add(m); return m;
  }
  const oblF = STYLE_DEF.fill;                                    // 仅用于初值，运行时一律读 state.style.fill
  const planeEcl = makePlaneMesh(orbitScene, oblF.ecl.fill, oblF.ecl.op);
  planeEcl.rotation.x = -Math.PI / 2;                             // 圆面默认在 XY → 转到轨道平面 XZ
  const planeEqu = makePlaneMesh(tiltOrb, oblF.equ.fill, oblF.equ.op);
  planeEqu.rotation.x = -Math.PI / 2;                             // 赤道面（随地球位置与倾角）
  /* 二面名称标注：黄道面标注挂在轨道场景（不随地球公转、不随自转），
     赤道面标注挂在倾角层 tiltOrb（随倾角摆动，但不随自转旋转，故文字不会打转）。
     两者都放在圆盘外缘（0.88 R）并抬离盘面，处于「地理事物的上方 / 外围」。 */
  /* 画布宽 256（与其它注释一致）：3 个汉字占画布的高度比更高，落地文字更大更清楚 */
  const eclLabel = makeTextSprite('黄道面', 0.62, true, 'ecl', 'O.obl.ecl', 256);
  eclLabel.renderOrder = 40;                                 // v23.12：文字注释统一 40+
  orbitScene.add(eclLabel);
  const equLabel = makeTextSprite('赤道面', 0.62, true, 'equ', 'O.obl.equ', 256);
  equLabel.renderOrder = 40;                                 // v23.12：文字注释统一 40+
  tiltOrb.add(equLabel);
  function applyPlanes() {
    const P = state.orb.planes, F = state.style.fill;
    // v26.1（需求⑫）：总开关 orb.planes.on 是「黄赤交角」菜单标题前的开关 ——
    //   它关掉时黄道面 / 赤道面一并隐藏（此前该字段是死配置，没有任何代码读它）。
    const eclOn = !!P.on && !!P.ecl, equOn = !!P.on && !!P.equ;
    planeEcl.visible = eclOn;
    planeEqu.visible = equOn;
    planeEcl.material.color.set(F.ecl.fill); planeEcl.material.opacity = F.ecl.op;
    planeEqu.material.color.set(F.equ.fill); planeEqu.material.opacity = F.equ.op;
    const rEcl = orbRNow * 1.12 * (F.ecl.r || 1);                 // 黄道面随日地距离缩放（× 填充半径倍率）
    const rEqu = 1.55 * (F.equ.r || 1);
    planeEcl.scale.setScalar(rEcl);
    planeEqu.scale.setScalar(rEqu);
    /* v20.0（需求⑥）：名称标注的位置与尺寸都修正。
       位置：原先贴在 rEcl×0.9 ≈ 轨道半径处 —— 正好压在游戏里那条「公转轨道环」上，
             并且和二分二至（春分/夏至/秋分/冬至分别位于 +Z/−X/−Z/+X 四个正方向）抢同一根辐条。
             现在改到「盘面外缘内侧」并且走 135° 斜向：既离开轨道环，也与四个正方向各差 45°。
       高度：抬到盘面之上（y > 0），避免与半透明盘面同深度打架（depthTest 开启，再压盘面就被吞掉）。
       尺寸：不再写死 baseW —— 交给 applyAll 的注释循环按 orbAnnMul() 补偿，
             于是「日地距离」拉大时它和别的注释一样保持屏幕观感不变（原先被这里覆盖，会越拉越小）。 */
    const ECL_DIR = 135 * D;                                      // 斜向，避开二分二至所在的四个正方向
    eclLabel.position.set(Math.cos(ECL_DIR) * rEcl * 0.97, Math.max(rEcl * 0.05, 0.26), -Math.sin(ECL_DIR) * rEcl * 0.97);
    equLabel.position.set(rEqu * 0.92, 0.26, 0);
  }
  let _oblApplied = -1;                     // 已应用的交角（避免每次 applyAll 都重建五带几何）
  function applyObliquity() {
    OBLIQ_DEG = Math.min(90, Math.max(0, +state.obliquity || 0));
    if (Math.abs(_oblApplied - OBLIQ_DEG) > 1e-9) {
      _oblApplied = OBLIQ_DEG;
      applyObliquityCore();
    }
    applyPlanes();                          // 二面半径随日地距离变化，每次都刷新
  }
  function applyObliquityCore() {
    OBLIQ = OBLIQ_DEG * D;
    TROPIC_LAT = OBLIQ_DEG;
    POLAR_LAT = 90 - OBLIQ_DEG;
    // 特殊纬线（南北回归线 / 南北极圈）纬度：自转 + 公转两套材质同步
    setBandLat(bandTrN, TROPIC_LAT); setBandLat(bandTrS, -TROPIC_LAT);
    setBandLat(bandArN, POLAR_LAT); setBandLat(bandArS, -POLAR_LAT);
    setBandLat(bandTrNOrb, TROPIC_LAT); setBandLat(bandTrSOrb, -TROPIC_LAT);
    setBandLat(bandArNOrb, POLAR_LAT); setBandLat(bandArSOrb, -POLAR_LAT);
    // v23.0：原「五带分界描边」的纬度同步（zSR / zSO）已随描边一并删除
    rebuildZoneGeos();
    syncSurfSpecLat();
    tiltOrb.rotation.z = -OBLIQ;      // 公转场景地轴倾角（自转场景在 updateScene 每帧读取 OBLIQ）
    applyPlanes();
  }

  /* ============ 时区图层（v8.0）：24 个理论时区 · 24 个独立填充面 + 界线 + 注释 ============
     时区按地理经度划分，因此固定在地球表面（挂 spin / spinOrb，随地球自转）。
     每区跨 15°，中央经线 = 15° × 时区号；编号取 −11 … +12（共 24 区，合计 360°）。
     注：UTC+12 与 UTC−12 中央经线同为 180°（跨国际日期变更线），是同一个区，
     故 24 个区正好覆盖「UTC−12 至 UTC+12」这 24 个小时刻度，不会出现 25 个。

     v8.0 把「一整块统一填充」拆成 24 个独立填充面：
       · 每个时区一个 Mesh + 一份专属 Material（互相独立，可单独改色 / 改透明度 / 改状态）
       · 几何仍共用一份 15° 扇区（tzGeo），靠 rotation.y = 15×off 摆位 ——
         第 i 面覆盖 [15i−7.5°, 15i+7.5°]，第 i+1 面覆盖 [15i+7.5°, 15i+22.5°]，
         边界严格共享同一条经线：不重叠、无缝隙，拼合轮廓与拆分前完全一致。
       · 奇数位 / 偶数位交替填充（条纹），由 style.fill.tz.stripe 控制。
       · 每个面四态：默认 / 选中 / 高亮（hover）/ 禁用，各自一套颜色与透明度。
       · 仅改填充逻辑：界线、注释、半径、布局与拆分前保持一致。 */
  const TZ_OFF_MIN = -11, TZ_OFF_MAX = 12;
  // 24 个时区号（有序；索引的奇偶决定交替填充取哪一套）
  const TZ_LIST = [];
  for (let _o = TZ_OFF_MIN; _o <= TZ_OFF_MAX; _o++) TZ_LIST.push(_o);
  const TZ_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  function tzName(off) {
    if (off === 0) return '中时区';
    if (off === 12) return '东西十二区';
    return (off > 0 ? '东' : '西') + TZ_CN[Math.abs(off)] + '区';
  }
  function tzUtc(off) { return off === 0 ? 'UTC±0' : (off > 0 ? 'UTC+' + off : 'UTC-' + off); }
  // v23.0：原 inkPxOf()（估算文字墨迹宽度，供「时区注释隔一个标一个」的碰撞判定使用）
  //   已随该需求一并删除 —— 注释一律全部标注后，再没有任何调用点。
  // 以本初子午线为中心的 15° 球面扇区，各时区靠 rotation.y 摆位（24 个时区共用一份几何）
  function tzSectorGeom(radius) {
    const g = new THREE.BufferGeometry(), pos = [], idx = [];
    const sa = 16, sb = 6, half = 7.5 * D;
    for (let i = 0; i <= sa; i++) {
      const lat = -Math.PI / 2 + Math.PI * i / sa;
      const r = Math.cos(lat) * radius, y = Math.sin(lat) * radius;
      for (let j = 0; j <= sb; j++) {
        const az = -half + (2 * half) * j / sb;
        pos.push(r * Math.cos(az), y, r * Math.sin(az));
      }
    }
    const cols = sb + 1;
    for (let i = 0; i < sa; i++) for (let j = 0; j < sb; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.05);
    return g;
  }
  const tzGeo = tzSectorGeom(1.006);
  // 模板材质：每个时区面 clone() 一份，互不影响（24 份材质才谈得上"独立样式与状态"）
  const tzFillMat = new THREE.MeshBasicMaterial({
    color: 0x7fd1ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
  });
  // 时区界线：沿经线的大圆细带（与重要纬线共用球面带几何：uLat = 0 即大圆，再旋转到目标经度）
  const tzLineMat = new THREE.ShaderMaterial({
    uniforms: {
      uLat: { value: 0 }, uWidth: { value: 0.22 * D }, uRadius: { value: 1.0085 },
      uColor: { value: new THREE.Color('#8BE9FD') }, uOpacity: { value: 0.7 },
      uDash: { value: 1 }, uDashN: { value: 72 }, uDashRatio: { value: 0.55 },
    },
    vertexShader: bandVS, fragmentShader: bandFS,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  function makeMeridianBand(parent, lonDeg) {
    const m = new THREE.Mesh(bandGeo, tzLineMat);
    m.renderOrder = 20;
    m.rotation.set(0, lonDeg * D, Math.PI / 2);
    parent.add(m);
    return m;
  }
  function buildTz(parent, labelW) {
    const grp = new THREE.Group(); parent.add(grp);
    // cells：24 个独立填充面；fills 保留旧字段名以兼容既有引用（= cells 的 mesh 列表）
    const out = { grp: grp, cells: [], fills: [], lines: [], labels: [] };
    TZ_LIST.forEach(function (off, idx) {
      // 每个面一份专属材质：颜色 / 透明度 / 状态互不影响
      const mat = tzFillMat.clone();
      const f = new THREE.Mesh(tzGeo, mat);
      f.rotation.y = 15 * off * D; f.renderOrder = 12;
      f.userData.tzOff = off;                 // 拾取时据此回查是哪一个时区
      grp.add(f);
      out.cells.push({ off: off, idx: idx, mesh: f, mat: mat });
      out.fills.push(f);
      out.lines.push(makeMeridianBand(grp, 15 * (off - 1) + 7.5));
      // v23.12：时区注释分两行（中文名 + UTC）。修复「全部注释同开」时的两类重叠 ——
      //   ① 时区 ↔ 地方时（赤道带）：原先时区在 lat=4、地方时在 lat≈2.7，二者仅差 1.3° 而互相压字；
      //   ② 相邻时区彼此：24 条 15° 间距、两行宽字在赤道附近横向间距不足，互相覆盖（如「西四区」压住「UTC-7」）。
      //   改法：整组南移并「双排交错」——按 TZ_LIST 索引奇偶分到两条南纬带：
      //   相邻时区经度差 15°、纬度差 7°，两行错开即不再压字。
      //   v23.13：双排从 -7/-15 再南移到 -10/-17 —— 赤道/热带标注（lat -3.2，见 SURF_SPEC）需要
      //   插在「地方时下沿(≈0.7°N)」与「时区第一排上沿」之间的空档里，-10 保证其上沿(-6.4°S)
      //   与赤道标注下沿(-5.5°S)仍有约 0.9° 间距；-17 的下沿(-20.7°S)距南回归线标注上沿(-21.2°S)
      //   仍有约 0.5° 间距，两端都不越界。
      //   半径仍 1.045（只做上下错位，未做径向位移），保留「贴地表」观感。
      const lat = (idx % 2 === 0) ? -10 : -17;
      const txt = tzName(off) + '\n' + tzUtc(off);
      const sp = makeTextSprite(txt, labelW, true, 'tz', 'tz' + off, 400);
      sp.userData.tz = true; sp.renderOrder = 42;   // v23.12：文字层 40+（经纬度40<温度带41<时区42<地方时43），全部高于点30/线20/面2~12
      // v23.0：原 sp.userData.inkFrac（墨迹宽度占比）随「时区注释间隔显示」一并删除 ——
      //   它只服务于每帧的相邻碰撞判定，如今注释一律全部标注，不再需要。
      sp.userData.tzLat = lat; sp.userData.tzLon = off;    // v20.0：供每帧重排 + 防穿模使用
      const la = lat * D, lo = -15 * off * D;             // 与 markerLocal 同一套换算（a = -lon）
      sp.position.set(Math.cos(la) * Math.cos(lo) * 1.045, Math.sin(la) * 1.045, Math.cos(la) * Math.sin(lo) * 1.045);
      grp.add(sp); out.labels.push(sp);
    });
    return out;
  }
  const tzR = buildTz(spin, 0.40);            // 自转视图（地球半径 = 1）
  const tzO = buildTz(spinOrb, 0.59);         // 公转视图（地球 rig 按 ORB_E 缩放）
  /* ---- 单个填充面的最终样式：奇数位取交替套（条纹开启时），其余取默认套 ---- */
  function tzCellStyle(off) {
    const F = state.style.fill.tz;
    const idx = TZ_LIST.indexOf(off);
    // 交替填充（条纹）：奇数位取第二套填充色 / 透明度
    if (F.stripe && idx % 2 === 1) return { st: 'alt', color: F.fill2, op: F.op2 };
    return { st: 'base', color: F.fill, op: F.op };
  }
  function applyTz() {
    const on = !!state.tz.on, fz = state.style.fill.tz;
    // v20.0：「描边粗细」与极昼 / 极夜描边同量纲（世界单位），此前被当成「度」再乘 D，
    //        0.0076 的粗细实际只有 0.0076° 宽（≈ 0.0001 个地球半径）—— 于是「描边不显示」。
    setBand(tzLineMat, fz.stroke, fz.stroke.dash === 'dash');
    tzLineMat.uniforms.uWidth.value = Math.max(fz.stroke.w, 0.0006);
    [tzR, tzO].forEach(function (t) {
      t.grp.visible = on;
      t.cells.forEach(function (c) {
        const s = tzCellStyle(c.off);
        c.mat.color.set(s.color); c.mat.opacity = s.op;   // 逐面独立写入
        c.mesh.visible = on;
      });
      t.lines.forEach(function (m) { m.visible = on && !!fz.stroke.on; });
    });
  }

  /* ============ v25.1（需求⑦）：时差演示 ============
     只讲清一件事：地方时刻因经度而异，于是「今天 / 昨天」与「0 时」在全球的位置也不同。
     五个要素：
       · 中时区（零时区）—— 以 0° 经线为中心的 15° 时区面 + 两侧经线描边（复用 tzSectorGeom / merVS）
       · 国际日期变更线 —— 大致沿 180° 经线（半大圆带，复用 pmGeo）
       · 0 时时刻所在经线 —— 地方时刻恰为 0:00 的经线（同上，随自转逐帧转动）
       · 新的一天 / 旧的一天 —— 由 0 时经线与 180° 经线把全球分成两半，各用一个球壳面着色
     0 时经线 = 直射点经线 + 180°，与「地方时刻」标注同源（subsolarLonRad），
     所以三个动态要素与球面上的地方时刻读数永远一致（需求⑦「与地方时刻对应并符合实际情况」）。 */
  const TZDIFF_FILL_R = 1.0145;      // 面：夹在温度带面(1.012)与时区界线(1.0085)之外
  const TZDIFF_LINE_R = 1.018;       // 线：最外层，不被任何面压住
  let tzdiffZeroLon = 180;           // 0 时经线在 spin 局部系中的地理经度（度，0..360）
  function tzdiffZeroLonDeg(ms, eot) { return wrap360(subsolarLonRad(ms, eot) / D + 180); }
  // 「新的一天」区域的角宽（自 0 时经线向东量到 180° 经线）：= mod(180 − λ0, 360)
  function tzdiffNewSpan() { return wrap360(180 - tzdiffZeroLon); }

  // ① 中时区（零时区）面：15° 扇区，几何构建在 -7.5°~+7.5°（中心为 0° 经线）
  const tzdiffTz0Geo = tzSectorGeom(TZDIFF_FILL_R);
  const tzdiffTz0Mat = new THREE.MeshBasicMaterial({
    color: 0x7fd1ff, transparent: true, opacity: 0.20, depthWrite: false, side: THREE.DoubleSide,
  });
  // ② 中时区两条边界经线（±7.5°）＋ ③ 国际日期变更线（180°）＋ ④ 0 时经线
  function makeTzdiffMeridian(lonDeg, color, w, dashed) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: w * D }, uRadius: { value: TZDIFF_LINE_R },
        uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.95 },
        uDash: { value: dashed ? 1 : 0 }, uDashN: { value: 72 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: merVS, fragmentShader: bandFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(pmGeo, mat);
    m.rotation.y = lonDeg * D;        // pmGeo 建在 0° 经线上 → 转到目标经度
    m.renderOrder = 20;
    return m;
  }
  // ⑤ 新的一天 / 旧的一天：整球壳按「到 0 时经线的角距」二分着色（无几何重建，只换 uniform）
  const TZDIFF_DAY_VS = `
    varying vec3 vLocal;
    void main(){
      vLocal = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const TZDIFF_DAY_FS = `
    uniform float uZeroLon;      // 0 时经线的地理经度（度，0..360）
    uniform float uIsNew;        // 1 = 新的一天，0 = 旧的一天
    uniform vec3 uColor; uniform float uOpacity;
    varying vec3 vLocal;
    ${SRGB_FN}
    void main(){
      // 地理经度：本体系里方向 = (cos lat·cos az, sin lat, cos lat·sin az)，az = −经度
      float lon = degrees(-atan(vLocal.z, vLocal.x));
      float d = mod(lon - uZeroLon, 360.0);              // 自 0 时经线向东的角距
      float w = mod(180.0 - uZeroLon, 360.0);            // 新一天区域的角宽
      float has = (d <= w) ? 1.0 : 0.0;
      float want = (uIsNew > 0.5) ? 1.0 : 0.0;
      float a = uOpacity * (1.0 - abs(has - want));      // 只在本区域着色（其余 discard）
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function makeTzdiffDayShell(isNew) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZeroLon: { value: 180 }, uIsNew: { value: isNew ? 1 : 0 },
        uColor: { value: new THREE.Color(isNew ? '#FF7A45' : '#5B8DEF') }, uOpacity: { value: 0.20 },
      },
      vertexShader: TZDIFF_DAY_VS, fragmentShader: TZDIFF_DAY_FS,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    const m = new THREE.Mesh(earth.geometry, mat);
    m.scale.setScalar(TZDIFF_FILL_R);
    m.renderOrder = 13;
    return m;
  }
  function buildTzdiff(parent, labelW, tag) {
    const grp = new THREE.Group(); parent.add(grp);
    const fill = new THREE.Mesh(tzdiffTz0Geo, tzdiffTz0Mat);
    fill.renderOrder = 13;
    const edgeA = makeTzdiffMeridian(7.5, '#8BE9FD', 0.16, false);
    const edgeB = makeTzdiffMeridian(-7.5, '#8BE9FD', 0.16, false);
    const idl = makeTzdiffMeridian(180, '#FF5A36', 0.30, true);
    const zero = makeTzdiffMeridian(180, '#FFD23F', 0.30, false);
    const dayNew = makeTzdiffDayShell(true);
    const dayOld = makeTzdiffDayShell(false);
    [fill, edgeA, edgeB, idl, zero, dayNew, dayOld].forEach(function (m) { grp.add(m); });
    // 文字注释（5 条；与其它地表注释同样挂在倾斜系下，随地球自转 / 受背面剔除）
    //   v25.1：每条一个独立分类（TZDIFF_NOTE_CAT），菜单里可分别设字号 / 颜色 / 字重；
    //   key 形如 'R.tz0' / 'O.newDay'，spriteNoteGate 取 '.' 之后的部分即要素键。
    const notes = {};
    const mk = function (key, txt) {
      const sp = makeTextSprite(txt, labelW, true, TZDIFF_NOTE_CAT[key], tag + '.' + key);
      sp.renderOrder = 42;                                 // 与「时区」注释同层（40<41<42<43）
      grp.add(sp); notes[key] = sp;
    };
    mk('tz0', '中时区'); mk('idl', '国际日期变更线'); mk('zero', '0°时刻所在经线');
    mk('newDay', '新的一天'); mk('oldDay', '旧的一天');
    grp.visible = false;
    return { grp: grp, fill: fill, edgeA: edgeA, edgeB: edgeB, idl: idl, zero: zero,
             dayNew: dayNew, dayOld: dayOld, notes: notes };
  }
  const tzdiffR = buildTzdiff(spin, 0.34, 'R');
  const tzdiffO = buildTzdiff(spinOrb, 0.50, 'O');
  // 时差层的全部对象（供窗口级裁剪 featObjects 使用）
  function tzdiffObjs(t) {
    if (!t) return [];
    const L = [t.fill, t.edgeA, t.edgeB, t.idl, t.zero, t.dayNew, t.dayOld];
    Object.keys(t.notes || {}).forEach(function (k) { L.push(t.notes[k]); });
    return L;
  }
  /* 每帧同步：0 时经线的位置 + 中时区样式 + 线样式（applyTzdiff 由 applyAll 调用；
     0 时经线的经度随仿真时间变化，故在 updateScene / updateOrbit 里各自刷新一次）。 */
  function applyTzdiff() {
    const S = state.tzdiff, F = state.style.fill.tzdiff;
    const on = !!S.on;
    [tzdiffR, tzdiffO].forEach(function (t) {
      const vis = { tz0: on && S.tz0.on, idl: on && S.idl.on, zero: on && S.zero.on,
                    newDay: on && S.newDay.on, oldDay: on && S.oldDay.on };
      t.fill.visible = vis.tz0;
      t.dayNew.visible = vis.newDay;
      t.dayOld.visible = vis.oldDay;
      // 中时区面
      t.fill.material.color.set(F.fill); t.fill.material.opacity = F.op;
      // 中时区描边（两侧经线）
      const st = F.stroke;
      [t.edgeA, t.edgeB].forEach(function (m) {
        m.visible = vis.tz0 && st.on;
        setBand(m.material, { color: st.color, op: st.op, w: st.w, dash: st.dash, n: st.n, ratio: st.ratio },
                st.dash === 'dash');
      });
      // 国际日期变更线 / 0 时经线（显隐由 state.tzdiff.*.on 控制）
      t.idl.visible = vis.idl;
      setBand(t.idl.material, F.idl, F.idl.dash === 'dash');
      t.zero.visible = vis.zero;
      setBand(t.zero.material, F.zero, F.zero.dash === 'dash');
      // 两个日期面
      t.dayNew.material.uniforms.uColor.value.set(F.newFill);
      t.dayNew.material.uniforms.uOpacity.value = F.newOp;
      t.dayOld.material.uniforms.uColor.value.set(F.oldFill);
      t.dayOld.material.uniforms.uOpacity.value = F.oldOp;
      t.grp.visible = on;
    });
  }
  // 0 时经线的位置（自转 / 公转两套实例共用一个经度，只是所在场景不同）
  function syncTzdiffZero() {
    tzdiffZeroLon = tzdiffZeroLonDeg(simMs, currentInfo ? currentInfo.eot : 0);
    [tzdiffR, tzdiffO].forEach(function (t) {
      t.zero.rotation.y = tzdiffZeroLon * D;
      t.dayNew.material.uniforms.uZeroLon.value = tzdiffZeroLon;
      t.dayOld.material.uniforms.uZeroLon.value = tzdiffZeroLon;
    });
  }

  /* ============ v25.1（需求⑧）：球面最短距离（大圆劣弧）测量 ============
     确定两点 A / B 之后做三件事：
       ① 距离 —— 大圆劣弧长度（球面上两点的最短路径）：d = R·θ，θ = acos(Â·B̂)，
          R 取地球平均半径 6371.0088 km；单位按距离自适应（< 1 km 用「米」）。
       ② 完整大圆环线 —— 过 A、B 两点的那条大圆（360° 整圈）。
       ③ 劣弧线段 —— 两点之间的较短弧，也就是「球面最短距离」本身。
     ②③ 共用同一套「大圆带」几何，见下面 gcGeo / gcVS：几何建在「以 A 为 0°」的局部基
     (e0 = Â, e1 = n̂ × e0, n̂ = 大圆平面法向) 上，顶点着色器只需要一个 uSpan 就能
     同时表达「整圈」(2π) 与「恰好到 B 的劣弧」(θ) —— 于是环线与劣弧永远重合在正确的位置上，
     不会出现「弧画歪了」这类几何不一致。
     端点钉在地表（挂 spin / spinOrb），随地球自转 / 公转一起运动，与标注点同一套机制。
     边界情况（重合点 / 对跖点）见 gcdSolve / gcdStatus，提示写在菜单面板里。 */
  const GCD_SEG = 512;              // 环向分段数（512 段 → 每段 0.70°），劣弧同样用它采样
  const GCD_RING_R = 1.0200;        // 完整大圆环半径：高于全部既有图层（时差线 1.018 之上）
  const GCD_ARC_R = 1.0215;         // 劣弧半径：再抬一点 → 叠在环线之上，两条线一眼可分
  const GCD_LIFT = 0.34;            // 「不贴地」时沿径向抬升的高度（离地圆环观感）
  const GCD_PT_R = 1.0240;          // 端点小球半径
  const GCD_NOTE_R = 1.100;         // 距离标注的球面半径
  const GCD_NOTE_PT = 1.070;        // 端点 A / B 标注的球面半径
  const GCD_R_KM = 6371.0088;       // 地球平均半径（IUGG 均值），用于圆心角 → 距离
  const GCD_COLINEAR = 1e-12;       // 共线判据：|Â × B̂|² 小于它 → 重合或对跖
  const GCD_NOISE_DEG = 0.05;       // 小于该圆心角（≈5.6 km）视为「可忽略的小弧」，仅用于提示
  const GCD_RING_RO = 21, GCD_ARC_RO = 22, GCD_PT_RO = 30, GCD_NOTE_RO = 43;

  /* ---- 大圆带几何：gt ∈ [0,1] 沿弧向、bside ∈ {-1,+1} 两侧各半宽 ---- */
  function buildGcGeo(seg) {
    const n = (seg + 1) * 2;
    const gt = new Float32Array(n), sd = new Float32Array(n), pos = new Float32Array(n * 3);
    const idx = [];
    for (let j = 0; j <= seg; j++) {
      const t = j / seg;
      gt[j * 2] = t; sd[j * 2] = -1;
      gt[j * 2 + 1] = t; sd[j * 2 + 1] = 1;
    }
    for (let j = 0; j < seg; j++) { const a = j * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('gt', new THREE.BufferAttribute(gt, 1));
    g.setAttribute('bside', new THREE.BufferAttribute(sd, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.6);
    return g;
  }
  const gcGeo = buildGcGeo(GCD_SEG);
  /* 顶点：dir = cos(ang)·e0 + sin(ang)·e1（ang = gt·uSpan，uSpan = 2π 即整圈、θ 即劣弧）；
     厚度方向取大圆平面法向 n̂ —— 加出去再归一化，带子就贴着球面铺开。
     vAz 直接用弧度，于是片元着色器的虚线按「每圈 uDashN 段」分布，
     与环线 / 劣弧的长度无关（二者虚线段长度天然一致）。片元着色器复用 bandFS。 */
  const gcVS = `
    attribute float gt; attribute float bside;
    uniform vec3 uE0, uE1, uN;
    uniform float uWidth, uRadius, uSpan;
    varying float vAz; varying float vSide;
    void main(){
      float ang = gt * uSpan;
      vec3 dir = normalize(cos(ang) * uE0 + sin(ang) * uE1);
      vec3 p = normalize(dir + uN * (bside * uWidth)) * uRadius;
      vAz = ang; vSide = bside;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `;
  function makeGcdLineMat(radius, span) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uE0: { value: new THREE.Vector3(1, 0, 0) },
        uE1: { value: new THREE.Vector3(0, 0, 1) },
        uN: { value: new THREE.Vector3(0, -1, 0) },
        uWidth: { value: 0.45 * D }, uRadius: { value: radius }, uSpan: { value: span },
        uColor: { value: new THREE.Color('#FFFFFF') }, uOpacity: { value: 1 },
        uDash: { value: 0 }, uDashN: { value: 48 }, uDashRatio: { value: 0.6 },
      },
      vertexShader: gcVS, fragmentShader: bandFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }
  function buildGcd(parent, tag) {
    const grp = new THREE.Group(); parent.add(grp); grp.visible = false;
    const ring = new THREE.Mesh(gcGeo, makeGcdLineMat(GCD_RING_R, Math.PI * 2));
    const arc = new THREE.Mesh(gcGeo, makeGcdLineMat(GCD_ARC_R, Math.PI));
    ring.renderOrder = GCD_RING_RO; arc.renderOrder = GCD_ARC_RO;
    const dotGeo = new THREE.SphereGeometry(0.018, 16, 12);
    const ptA = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xff4fa3, transparent: true, opacity: 1 }));
    const ptB = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xff4fa3, transparent: true, opacity: 1 }));
    ptA.renderOrder = GCD_PT_RO; ptB.renderOrder = GCD_PT_RO;
    [ring, arc, ptA, ptB].forEach(function (m) { grp.add(m); });
    /* 文字注释：距离标注固定 3 行（文本随测量结果改写，故用 setText —— 见 makeTextSprite），
       端点标注就一个字 A / B。两条注释各挂一个分类，样式仍由「全局文字样式」统一管。 */
    const mkNote = function (txt, w, cat, key, cw) {
      const sp = makeTextSprite(txt, w, true, cat, tag + '.' + key, cw);
      sp.renderOrder = GCD_NOTE_RO;
      grp.add(sp); return sp;
    };
    const dist = mkNote('最短距离 —\nA —\nB —', 0.42, 'gcdDist', 'dist', 384);
    dist.center.set(0.5, 0.5);
    const endA = mkNote('A', 0.24, 'gcdEnd', 'A');
    const endB = mkNote('B', 0.24, 'gcdEnd', 'B');
    endA.center.set(0.5, -0.34); endB.center.set(0.5, -0.34);   // 抬到端点圆点上方
    return { grp: grp, ring: ring, arc: arc, ptA: ptA, ptB: ptB, dist: dist, endA: endA, endB: endB, tag: tag };
  }
  const gcdR = buildGcd(spin, 'R');
  const gcdO = buildGcd(spinOrb, 'O');

  const _gcA = new THREE.Vector3(), _gcB = new THREE.Vector3(), _gcN = new THREE.Vector3();
  const _gcE1 = new THREE.Vector3(), _gcM = new THREE.Vector3(), _gcP = new THREE.Vector3();
  const _gcBd = new THREE.Vector3();     // B 端点方向（= e0·cosθ + e1·sinθ），复用以免每帧分配
  /* 解算两点。返回 null（点数不足）/ { ok:false, why:'same' }（重合）/ 其余为可用解。
     对跖时 Â × B̂ ≈ 0（方向无意义），此时任取一个与该方向垂直的平面作大圆
     （amb = true 表示「大圆不唯一」，面板里给出提示）。 */
  function gcdSolve() {
    const G = state.gcd;
    if (!G.a || !G.b) return null;
    geoDir(G.a.lat, G.a.lon, _gcA);
    geoDir(G.b.lat, G.b.lon, _gcB);
    const cosT = clamp(_gcA.dot(_gcB), -1, 1);
    const ang = Math.acos(cosT);
    _gcN.crossVectors(_gcA, _gcB);
    const colin = _gcN.lengthSq() < GCD_COLINEAR;
    if (colin && cosT > 0) return { ok: false, why: 'same', ang: ang };
    let amb = false;
    if (colin) {                                   // 对跖：大圆不唯一，任取一条
      amb = true;
      _gcN.set(0, 1, 0).cross(_gcA);
      if (_gcN.lengthSq() < 1e-8) _gcN.set(1, 0, 0).cross(_gcA);
    }
    _gcN.normalize();
    _gcE1.crossVectors(_gcN, _gcA).normalize();     // 右手系：e1 = n × e0 → 指向 B 一侧
    return { ok: true, amb: amb, ang: ang, n: _gcN.clone(), e0: _gcA.clone(), e1: _gcE1.clone() };
  }
  /* 当前测量状态：无点 / 重合 / 对跖 / 正常。面板据此出提示与读数。 */
  function gcdStatus() {
    const G = state.gcd;
    if (!G.on || !G.a || !G.b) return { kind: 'idle' };
    const sol = gcdSolve();
    if (!sol) return { kind: 'idle' };
    if (!sol.ok) return { kind: 'same', sol: sol };
    if (sol.amb) return { kind: 'anti', sol: sol };
    return { kind: 'ok', sol: sol };
  }
  /* 距离自适应格式：< 1 km 用米（< 100 m 保留一位小数），否则用千米（< 100 km 一位小数，
     再大取整并加千位分隔）。球面最短距离恒为劣弧长度，故 0 ≤ d ≤ πR ≈ 20015 km。 */
  function fmtGcdDist(ang) {
    const m = ang * GCD_R_KM * 1000;
    if (!(m > 0)) return '0 米';
    if (m < 1000) return (m < 100 ? m.toFixed(1) : String(Math.round(m))) + ' 米';
    const km = m / 1000;
    if (km < 100) return km.toFixed(1) + ' 千米';
    return String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 千米';
  }
  /* B 端点的单位方向 = e0·cosθ + e1·sinθ（θ = 圆心角，即解算出的劣弧长度） */
  function gcdBDir(sol, out) {
    return out.copy(sol.e0).multiplyScalar(Math.cos(sol.ang))
      .addScaledVector(sol.e1, Math.sin(sol.ang));
  }
  function gcdDistText() {
    const G = state.gcd, st = gcdStatus();
    if (st.kind === 'idle' || !st.sol) return '最短距离 —\nA —\nB —';
    const tip = st.kind === 'anti' ? '（对跖 · 大圆不唯一）' : '';
    return '球面最短距离 ' + fmtGcdDist(st.sol.ang) + tip +
      '\nA ' + fmtLat(G.a.lat) + ' ' + fmtLon(G.a.lon) +
      '\nB ' + fmtLat(G.b.lat) + ' ' + fmtLon(G.b.lon);
  }
  /* 显隐 / 样式 / 位置三件事都在这里同步；由 applyAll 调用（样式控件改了也走它）。
     两端点未确定时整个组隐藏 —— 于是「关闭」与「未测量」都不留任何实体与标签。 */
  function applyGcd() {
    const G = state.gcd, on = !!G.on;
    const st = on ? gcdStatus() : { kind: 'idle' };
    const sol = st.sol || null;
    const draw = !!(on && sol && st.kind !== 'same');
    const LR = state.style.ln.gcdRing, LA = state.style.ln.gcdArc;
    const ringR = GCD_RING_R + (LR.drape ? 0 : GCD_LIFT);
    const arcR = GCD_ARC_R + (LA.drape ? 0 : GCD_LIFT);
    const lift = LA.drape ? 0 : GCD_LIFT;         // 标注跟着劣弧一起抬（否则会被环压在下面）
    const txt = gcdDistText();
    [gcdR, gcdO].forEach(function (t) {
      setBand(t.ring.material, LR, LR.dash === 'dash');
      setBand(t.arc.material, LA, LA.dash === 'dash');
      t.ring.material.uniforms.uRadius.value = ringR;
      t.arc.material.uniforms.uRadius.value = arcR;
      t.ring.visible = draw && !!G.ring.on;
      t.arc.visible = draw && !!G.arc.on;
      /* v26.1（需求⑤）：选点过程中实时显示已选中的点 ——
         A 一确定就把 A 点的圆点与「A」标注画出来（此前要等两点都齐才出现，
         刚点完第一下没有任何反馈，看不出选没选上）。B 仍要等解算成立。 */
      const hasA = !!(on && G.a);
      t.ptA.visible = hasA && st.kind !== 'same';
      t.ptB.visible = draw;
      t.ptA.material.color.set(LA.color); t.ptB.material.color.set(LA.color);
      t.ptA.material.opacity = LA.op; t.ptB.material.opacity = LA.op;
      if (hasA && !sol) {                       // 只取到 A：直接按它的经纬度落位
        geoDir(G.a.lat, G.a.lon, _gcA);
        t.ptA.position.copy(_gcA).multiplyScalar(GCD_PT_R);
      }
      if (draw) {
        const U = function (m) {
          m.uniforms.uE0.value.copy(sol.e0);
          m.uniforms.uE1.value.copy(sol.e1);
          m.uniforms.uN.value.copy(sol.n);
        };
        U(t.ring.material); U(t.arc.material);
        t.ring.material.uniforms.uSpan.value = Math.PI * 2;
        // 劣弧的 uSpan 就是圆心角 θ —— 环线与劣弧因此严格共用同一条大圆
        t.arc.material.uniforms.uSpan.value = Math.max(sol.ang, 1e-5);
        t.ptA.position.copy(sol.e0).multiplyScalar(GCD_PT_R);
        gcdBDir(sol, _gcBd);
        t.ptB.position.copy(_gcBd).multiplyScalar(GCD_PT_R);
      }
      if (t.dist.userData.noteText !== txt) { t.dist.userData.setText(txt); t.dist.userData.dpi = 0; }
      t.dist.userData.gcdLift = lift;
      t.dist.userData.gcdDraw = draw;
      t.grp.visible = draw || !!(on && (G.a || G.b));       // 只取到 A 点时也显示组（便于下一步）
    });
  }
  /* 注释摆位：与该窗口的相机一起算（综合视图下每个子窗各算一遍，见 earthNotesPass）。 */
  function layoutGcdNotes(t, cam) {
    if (!t || !t.grp || !t.grp.visible) return;
    const st = gcdStatus();
    const G = state.gcd;
    /* v26.1（需求⑤）：只取到 A 点时也要把「A」标注摆出来（与上面的圆点同步）。
       B 未定 → 没有大圆解，A 标注直接按 A 点的经纬度落位。 */
    if (st.kind !== 'ok' && st.kind !== 'anti') {
      t.dist.visible = false; t.endB.visible = false;
      if (!!state.gcd.on && G.a) {
        t.endA.visible = true;
        t.grp.updateWorldMatrix(true, false);
        _snM.copy(t.grp.matrixWorld).invert();
        _snCamL.copy(cam.position).applyMatrix4(_snM);
        noteCamBasis(cam, _snM);
        geoDir(G.a.lat, G.a.lon, _gcP).multiplyScalar(GCD_NOTE_PT);
        pushNoteClear(_gcP, _snCamL, t.endA.scale.x, t.endA.scale.y);
        t.endA.position.copy(_gcP);
        applyNoteFrontCull(t.endA, _gcP, _snCamL);
      } else {
        t.endA.visible = false;
      }
      return;
    }
    const sol = st.sol;
    t.dist.visible = true; t.endA.visible = true; t.endB.visible = true;
    t.grp.updateWorldMatrix(true, false);
    _snM.copy(t.grp.matrixWorld).invert();
    _snCamL.copy(cam.position).applyMatrix4(_snM);
    noteCamBasis(cam, _snM);
    const lift = t.dist.userData.gcdLift || 0;
    const place = function (sp, dir, r) {
      _gcP.copy(dir).multiplyScalar(r);
      pushNoteClear(_gcP, _snCamL, sp.scale.x, sp.scale.y);
      sp.position.copy(_gcP);
      applyNoteFrontCull(sp, _gcP, _snCamL);
    };
    /* 距离标注落在**劣弧中点**：中点方向 = normalize(Â + B̂)（= e0(1+cosθ) + e1·sinθ）。
       ★ 别写成 e0 + e1·sinθ —— 那只在 θ=90° 时才对，一般情形会偏出大圆、标签飞到别处
       （像素探针实测：北京—东京那组会偏到几十度之外）。对跖时 Â+B̂ = 0，退回 Â 方向。 */
    gcdBDir(sol, _gcBd);
    _gcM.copy(sol.e0).add(_gcBd);
    if (_gcM.lengthSq() < 1e-9) _gcM.copy(sol.e0); else _gcM.normalize();
    place(t.dist, _gcM, GCD_NOTE_R + lift);
    place(t.endA, sol.e0, GCD_NOTE_PT + lift);
    place(t.endB, gcdBDir(sol, _gcBd), GCD_NOTE_PT + lift);
  }

  /* ============ 太阳直射点标记 ============ */
  const subGroup = new THREE.Group(); scene.add(subGroup);
  const subMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#FF5A36'), transparent: true, opacity: 1 });
  const subRingMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#FF5A36'), side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const subDot = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), subMat);
  const subRing = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.1, 48), subRingMat);
  subDot.renderOrder = 30; subRing.renderOrder = 30;   // v23.12：点要素统一 30（高于线 20 / 面 2~12）
  subRing.rotation.y = Math.PI / 2;          // 环面朝向 +X（太阳方向）
  subGroup.add(subDot); subGroup.add(subRing);
  // 公转场景中的直射点标记（共享材质，样式同步）
  const subOrbGroup = new THREE.Group(); orbRig.add(subOrbGroup);
  const _subDotOrb = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), subMat);
  _subDotOrb.renderOrder = 30;                        // v23.12：点要素统一 30
  subOrbGroup.add(_subDotOrb);
  const subRingOrb = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.1, 48), subRingMat);
  subRingOrb.renderOrder = 30;                        // v23.12：点要素统一 30
  subRingOrb.rotation.y = Math.PI / 2;
  subOrbGroup.add(subRingOrb);
  /* v27.4：太阳直射点所在的纬线圈（平行圈）与经线（半圆弧）。
     两个要素都挂在 spin / spinOrb（地球固定系）下，以「地理经纬度」定位：
       · 纬线圈 = 纬度 decl（= 太阳赤纬）的**整圈**平行圈，随 decl 缓慢变化，几何按需重建；
       · 经线   = 经度 lonSub（= 直射点经度）的**半圆弧**（北极 → 直射点 → 南极，只画直射点这一侧），
                  每帧只需绕 Y 轴旋转。
     二者随仿真时间实时跟随直射点移动；样式 → style.ln.subLatCircle / subLonCircle。 */
  const subLatMat = tubeMat('#35E0C9', 0.95);
  const subLonMat = tubeMat('#FFB454', 0.95);
  function _makeSubCircleMesh(mat, arc) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(GRAT_R, 0.01, 6, 160, arc || Math.PI * 2), mat);
    m.renderOrder = 20;       // 线要素统一 20
    return m;
  }
  const subLatCircle = _makeSubCircleMesh(subLatMat);                 // 纬线圈：整圈平行圈
  const subLonCircle = _makeSubCircleMesh(subLonMat, Math.PI);        // 经线：半圆弧
  const subCircleGroup = new THREE.Group(); spin.add(subCircleGroup);
  subCircleGroup.add(subLatCircle); subCircleGroup.add(subLonCircle);
  const subLatCircleO = _makeSubCircleMesh(subLatMat);
  const subLonCircleO = _makeSubCircleMesh(subLonMat, Math.PI);
  const subCircleOrbGroup = new THREE.Group(); spinOrb.add(subCircleOrbGroup);
  subCircleOrbGroup.add(subLatCircleO); subCircleOrbGroup.add(subLonCircleO);
  subCircleGroup.visible = false; subCircleOrbGroup.visible = false;   // 默认关闭（由 applySubCircle 控制）
  let _subLatDecl = -999, _subTubeLat = -1, _subTubeLon = -1;
  // 纬线圈（平行圈）：半径 r=cos(decl)·GRAT_R、抬升高度 sin(decl)·GRAT_R 都随直射点纬度变化 → 随 declRad 重建
  function rebuildSubLatCircle(declRad) {
    const tubeLat = Math.max(state.style.ln.subLatCircle.w * D, 0.0006);
    const r = Math.cos(declRad) * GRAT_R;
    subLatCircle.geometry.dispose(); subLatCircleO.geometry.dispose();
    subLatCircle.geometry = new THREE.TorusGeometry(Math.max(r, 1e-4), tubeLat, 6, 160);
    subLatCircleO.geometry = new THREE.TorusGeometry(Math.max(r, 1e-4), tubeLat, 6, 160);
    subLatCircle.rotation.x = -Math.PI / 2; subLatCircle.position.y = Math.sin(declRad) * GRAT_R;
    subLatCircleO.rotation.x = -Math.PI / 2; subLatCircleO.position.y = Math.sin(declRad) * GRAT_R;
    _subLatDecl = declRad; _subTubeLat = tubeLat;
  }
  /* ★ 本次性能修复：经线半圆弧的半径恒为 GRAT_R，**根本不随 declRad 变化** ——
     原先它和纬圈共用 rebuildSubCircles()，于是 declRad 每变一点就顺带重建这根经线（白费）。
     现将其重建条件从 declRad 条件中拆出：只有线宽 tubeLon 变化时才重建。 */
  function rebuildSubLonCircle() {
    const tubeLon = Math.max(state.style.ln.subLonCircle.w * D, 0.0006);
    subLonCircle.geometry.dispose(); subLonCircleO.geometry.dispose();
    // 经线只画半圆弧（arc = π），配合下方 rotation.z = 3π/2 使弧沿穿过直射点那一侧
    subLonCircle.geometry = new THREE.TorusGeometry(GRAT_R, tubeLon, 6, 160, Math.PI);
    subLonCircleO.geometry = new THREE.TorusGeometry(GRAT_R, tubeLon, 6, 160, Math.PI);
    _subTubeLon = tubeLon;
  }
  // 每帧：把纬线圈（平行圈）与经线（半圆弧）对齐到当前直射点的地理纬度 / 经度
  //   经线半圆弧：TorusGeometry 的 arc 自局部 u=0 起算（满圈为 2π），
  //   z 旋转取 3π/2（= π/2 + π）把弧平移半圈，使其两点端落在南北极、中点穿过直射点所在经度的赤道点；
  //   纬线圈仍是整圈平行圈，绕 X 轴放平（rotation.x = -π/2）+ 抬到 sin(decl)·R 高度。
  function updateSubCircle(declRad, lonSubRad) {
    const tubeLat = Math.max(state.style.ln.subLatCircle.w * D, 0.0006);
    const tubeLon = Math.max(state.style.ln.subLonCircle.w * D, 0.0006);
    if (Math.abs(declRad - _subLatDecl) > 1e-4 || Math.abs(tubeLat - _subTubeLat) > 1e-7) {
      rebuildSubLatCircle(declRad);          // 纬圈：随纬度 / 线宽变化重建
    }
    if (Math.abs(tubeLon - _subTubeLon) > 1e-7) {
      rebuildSubLonCircle();                 // 经线：仅随线宽变化重建（与 declRad 无关）
    }
    subLonCircle.rotation.set(0, lonSubRad, Math.PI * 1.5);
    subLonCircleO.rotation.set(0, lonSubRad, Math.PI * 1.5);
  }
  // 样式与显隐（线条 → style.ln.subLatCircle / subLonCircle；显隐 → state.subCircle.on）
  function applySubCircle() {
    const on = !!state.subCircle.on;
    subCircleGroup.visible = on; subCircleOrbGroup.visible = on;
    setTube(subLatMat, state.style.ln.subLatCircle);
    setTube(subLonMat, state.style.ln.subLonCircle);
    _subTubeLat = -1; _subTubeLon = -1;   // 强制下一帧按新线宽重建管状几何
  }
  // 极区描边：只在描边粗细变化时才重建圆环几何（applyAll 每次调用都会走到这里）
  let _pdSW = -1, _pnSW = -1;
  function rebuildStrokes() {
    const a = Math.max(state.style.fill.pd.stroke.w, 0.0005), b = Math.max(state.style.fill.pn.stroke.w, 0.0005);
    if (Math.abs(a - _pdSW) > 1e-7) {
      _pdSW = a; rebuildStroke(strokeDay, a); rebuildStroke(strokeDayOrb, a);
    }
    if (Math.abs(b - _pnSW) > 1e-7) {
      _pnSW = b; rebuildStroke(strokeNight, b); rebuildStroke(strokeNightOrb, b);
    }
  }
  /* 太阳光线样式（自转 / 公转一次设置，两处同时生效 —— v20.0 统一）：
     线颜色 / 透明度 / 线型 / 虚线密度 / 虚实比作用于「箭杆材质」，
     线粗细作用于「箭杆半径 + 箭头半径」（箭头长度恒定），
     箭头颜色 / 透明度 / 大小倍率来自「箭头样式」。 */
  function applyRayStyle() {
    const L = state.style.ln.ray, k = L.w / RAY_R0;
    const A = state.style.pt.arrow || { size: 1, color: '#FFE9A8', op: 0.95 };
    [shaftMatsR, shaftMatsO].forEach(function (list) {
      list.forEach(function (it) {
        const u = it.mat.uniforms;
        u.uColor.value.set(L.color);
        u.uOpacity.value = L.op * (it.mul == null ? 1 : it.mul);
        u.uDash.value = L.dash === 'dash' ? 1 : 0;
        u.uDashN.value = Math.max(2, L.n * it.len / RAY_DASH_REF);   // 按杆长换算，疏密观感一致
        u.uDashRatio.value = L.ratio;
      });
    });
    /* v23.7（自转箭头可见度修复）：箭头半径原本写成 RAY_HR0 * (L.w / RAY_HR0)，恒等于 L.w ——
       正好等于箭杆半径，箭头退化成一个「由粗到尖」的锥尖，自转视图里几乎看不出是箭头。
       改为与箭杆同一倍率 k（= L.w / RAY_R0），箭头半径 ≈ 箭杆的 5.5 倍，箭头形态清晰。 */
    const headScale = RAY_HR0 * k * (A.size == null ? 1 : A.size);
    rayHeads.forEach(function (h) { h.scale.set(headScale, RAY_HEAD_L, headScale); });
    // v23.5：公转地球半径（ER ≈ 0.68）远小于自转（1）、相机也更远 —— 箭头若沿用自转尺寸
    //   几乎看不见。这里按地球半径等比放大（并随「箭头大小」倍率），位置在 updateOrbit 里
    //   贴「朝日一侧地表外」摆放，保证公转视图里箭头清晰可见。
    const erO = ORB_E * ((state.orb && state.orb.earthScale) || 1);
    const aMul = (A.size == null ? 1 : A.size);
    orbRayHeadLenW = erO * 0.30 * aMul;
    const orbHeadR = erO * 0.075 * aMul;
    orbRayHead.scale.set(orbHeadR, orbRayHeadLenW, orbHeadR);
    orbRayFieldHeads.forEach(function (h) { h.scale.set(orbHeadR, orbRayHeadLenW, orbHeadR); });  // v23.7：与中间箭头同尺寸
    // 线粗细 → 箭杆半径（长度在构建 / 每帧更新时写入，不动）
    rayShafts.forEach(function (s) { s.scale.x = RAY_R0 * k; s.scale.z = RAY_R0 * k; });
    rayMats.forEach(function (m) { m.color.set(A.color); m.opacity = A.op; });
    orbRayFieldHeadMat.opacity = A.op * 0.45;   // v23.7：与光场箭杆同一压暗倍率
  }
  function applySubSize(s) {
    subGroup.scale.setScalar(s);       // 位置随太阳方向在 updateScene 中更新
    subOrbGroup.scale.setScalar(s);    // 位置随太阳方向在 updateOrbit 中更新
  }
  applySubSize(state.style.pt.sub.size);

  /* ============================================================================
     v23.17（需求②）：太阳直射点轨迹记录
     ----------------------------------------------------------------------------
     记录的东西是什么？
       直射点在地表的位置 = 「地心 → 太阳」方向与地球表面相交的那一点。若把地球的**自转**
       拿掉（只剩地轴指向与季节性摆动），这个方向在一年里会沿球面划出一条闭合曲线：
       纬度在 ±黄赤交角之间往复（夏至到北回归线、冬至到南回归线、二分过赤道），
       经度一年整整绕一圈 —— 这正是教科书里「太阳直射点的回归运动」。
       所以轨迹不能挂在 spin / spinOrb（自转系）上，那样一天就会被地球自转抹成一整条纬度带；
       而应挂在 tilt / tiltOrb（**非自转**的地理系）上：tilt 绕 Z 倾斜 −黄赤交角、tiltOrb 同理，
       二者都不含自转角，正是「太阳直射点回归运动」的自然参考系。

     两条轨迹线：自转视图用 tilt 系（太阳方向 = sunDir），公转视图用 tiltOrb 系
       （太阳方向 = orbSunDir）。二者用「父级世界四元数求逆」换算，与地轴固定模式、
       黄赤交角实时改动等所有情形自动一致，不需要额外分支。

     采样：按角步长 TRAIL_STEP_ANG（≈0.35°）在前后两个方向之间做球面插值补点，
       于是「慢放」时每帧最多补 1 个点、「快进」时一帧补齐一段，轨迹分辨率与速度无关，
       一整圈固定约 900 个点（TRAIL_CAP 留一点余量），记满自动停止，避免无限增长。

     几何：手写固定容量的管状网格（顶点数一次分配、只更新前 n 圈，用 drawRange 裁掉尾部）。
       截面基用「平行输运」（与 three 的 computeFrenetFrames 同法）逐圈推，不依赖
       TubeGeometry（它内部按弧长参数化，会破坏「第 j 圈 = 第 j 个采样点」的定点对应）。
       uv.x = j /(容量−1) → 虚线长度与「整圈虚线密度」设定绑定，记录越多虚线越密，
       与其它线要素（uv.x 绕整圈 0→1）语义一致。
     ========================================================================== */
  /* v25.1（需求②）：轨迹记录必须「完整、不缺段」。
     ---------------------------------------------------------------------------
     旧实现的两个缺陷合起来会让轨迹**只记到约半圈**（用户反馈的「总缺失一段」）：
       ① 帧内补点用 `k = ceil(ang / 步长)`，再按 t = i/k 均匀铺点 ——
          于是**实际步长 = ang / ceil(ang/步长)**。当 ang 只比步长大一点点时
          （默认播放速度下恰好如此：角步长每帧累积到刚过 0.35° 才触发），
          ceil 得 2 → 实际步长被腰斩成 ≈0.175°，一圈要 2057 个点，
          而容量只有 1080 → 记录到 189°（约半圈）就填满停止，后面整段没有。
       ② 大跳变（拖动时间轴）时两点之间直接取「最短大圆弧」，会把真实路径拉直。
     现在改为：
       · **固定弧长精确采样** —— 未走满一个步长时**不推进基准点**，让弧长自然累积；
         走满后按 floor(ang/步长) 个点、且严格落在弧长整数倍的位置上（t = i·步长/ang）。
         于是相邻采样点的弧长间隔恒为 0.35°，一圈恰好 ≈ 360/0.35 = 1029 个点。
       · 单帧时间跨度过大时**按时间细分**（见 trailTick），逐段求真实直射点方向后再采样。
     ========================================================================== */
  const TRAIL_CAP = 1200;                       // 轨迹最大采样点数（一圈 ≈1029 点，留约 17% 余量）
  const TRAIL_STEP_ANG = 0.35 * D;              // 相邻采样点的角步长（0.35°，恒定）
  /* 单帧补点上限。时间细分后每段跨度很小，此上限只作兜底保护。 */
  const TRAIL_KMAX = 4096;
  /* 时间细分：单帧仿真时间跨度超过 TRAIL_SUB_MS 时，按不超过 TRAIL_SUB_MAX 段逐段求解
     （每段跨度越小，「最短大圆弧」与真实路径的偏差越小 —— 32 段时一年跳变每段约 11°，
      对 0.35° 分辨率的轨迹而言偏差 < 0.2°，肉眼不可辨）。 */
  const TRAIL_SUB_MS = 2 * 86400000, TRAIL_SUB_MAX = 48;
  /* 一整圈的弧长：直射点在「不含自转的地理参考系」里的方向 = (sinλ·cosε, sinλ·sinε, cosλ)，
     对 λ 求导后模长恒为 1，故一个回归年（λ 走满 2π）刚好对应 2π 的弧长 ——
     记录到 2π 即为一整圈，再多补半个步长以确保首尾相接、不留缝。 */
  const TRAIL_LAP_ARC = TWO_PI;
  const TRAIL_ARC_MAX = TRAIL_LAP_ARC + TRAIL_STEP_ANG * 0.5;
  const TRAIL_R = 1.012;                        // 轨迹线所在球面半径（略高于地表，压住贴图）
  const TRAIL_MARK_R = 1.022;                   // 标记点所在球面半径（再高一点，压在线上）
  const TRAIL_RADIAL = 6;                       // 管截面分段数
  const TRAIL_MARK_MAX = 200;                   // 标记点数量上限（超出后丢弃最早的）
  const TRAIL_TROPIC_TOL = 0.25;                // 判定「到达回归线」的纬度容差（度）
  const TRAIL_DEDUP_DOT = Math.cos(3 * D);      // 同类标记点的合并阈值（3° 内视为同一处）
  const TRAIL_COS_STEP = Math.cos(TRAIL_STEP_ANG);

  // 自转 / 公转两个视图共用一套线材质与一套标记材质（样式只有一个数据源）
  const trailMat = tubeMat('#FF5AC8', 0.95);
  const trailMarkGeo = new THREE.SphereGeometry(1, 14, 10);
  const trailMarkMat = new THREE.MeshBasicMaterial({
    color: 0xFF2D9B, transparent: true, opacity: 1, depthWrite: false,
  });

  // 一个「轨迹集合」= 一条管状线 + 若干标记点，全部挂在给定的（非自转）参考系下
  function makeTrailSet(parent, name) {
    const ringV = TRAIL_RADIAL + 1, nv = TRAIL_CAP * ringV;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    const nrm = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    const uvs = new THREE.BufferAttribute(new Float32Array(nv * 2), 2);
    const idx = new Uint16Array((TRAIL_CAP - 1) * TRAIL_RADIAL * 6);
    let p = 0;
    for (let j = 0; j < TRAIL_CAP - 1; j++) {
      for (let i = 0; i < TRAIL_RADIAL; i++) {
        const a = j * ringV + i, b = (j + 1) * ringV + i;
        idx[p++] = a; idx[p++] = b; idx[p++] = a + 1;
        idx[p++] = b; idx[p++] = b + 1; idx[p++] = a + 1;
      }
    }
    geo.setAttribute('position', pos);
    geo.setAttribute('normal', nrm);
    geo.setAttribute('uv', uvs);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    const grp = new THREE.Group();
    grp.name = name;
    grp.visible = false;
    parent.add(grp);
    const line = new THREE.Mesh(geo, trailMat);
    line.frustumCulled = false;              // 顶点是增量写入的，包围球不可靠
    line.renderOrder = 24;                   // v23.12 图层：线 20 之上、点 30 之下
    grp.add(line);
    const marks = new THREE.Group();
    grp.add(marks);

    return {
      grp: grp, geo: geo, pos: pos, nrm: nrm, uvs: uvs, marks: marks,
      pts: new Float32Array(TRAIL_CAP * 3),          // 采样点（单位方向，球心在原点）
      tan: new Float32Array(TRAIL_CAP * 3),          // 切向
      frmN: new Float32Array(TRAIL_CAP * 3),         // 截面基 · 法向
      frmB: new Float32Array(TRAIL_CAP * 3),         // 截面基 · 副法向
      n: 0, markList: [],
      /* v23.18（需求②）：轨迹分段起点索引。
         "记录中途关闭再打开"会在两段之间产生一个真实的时间空档 —— 若仍按一条连续管连接，
         就会在两个相隔很远的采样点之间拉出一道穿越地球的直线（实测跨度 30.5°）。
         这里记录每段的起始采样索引，重建几何时在该处**不生成连接三角形**，轨迹自然断开。 */
      segs: [0],
    };
  }
  const trailSetR = makeTrailSet(tilt, 'subTrailR');        // 自转视图（tilt 系）
  const trailSetO = makeTrailSet(tiltOrb, 'subTrailO');     // 公转视图（tiltOrb 系）

  const _tq = new THREE.Quaternion();
  const _dR = new THREE.Vector3(1, 0, 0), _dO = new THREE.Vector3(1, 0, 0);
  const _pR = new THREE.Vector3(1, 0, 0), _pO = new THREE.Vector3(1, 0, 0);
  const _sR = new THREE.Vector3(), _sO = new THREE.Vector3();
  /* v23.17 修复：本批插值的「起点」必须与「上一采样点」分开存。
     trailPush() 末尾会执行 _pR.copy(dirR)（把 _pR 推进到刚推入的那个点，
     供回归线 / 赤道标记点判定用）；若插值循环直接用 _pR 当起点，循环每推一个点
     起点就被改写一次，导致批内采样点逐次收敛 —— 实测角步长从 0.588° 衰减到 0，
     并产生重复点（零长度管段），虚线每段长度也跟着忽长忽短。 */
  const _bR = new THREE.Vector3(1, 0, 0), _bO = new THREE.Vector3(1, 0, 0);
  const _mR = new THREE.Vector3(), _mO = new THREE.Vector3();
  // v25.1（需求②）：时间细分时逐段求解用的直射点方向缓存
  const _dR2 = new THREE.Vector3(), _dO2 = new THREE.Vector3();
  let trailLastMs = 0;                     // 上一次采样所对应的仿真时刻（用于识别大跳变）
  let trailArc = 0;                        // 已记录的总弧长（弧度）；达到一整圈即停止记录
  let trailPrimed = false, trailHaveLat = false;
  let trailLat = 0, trailDLat = 0;
  let trailDirtyR = false, trailDirtyO = false;

  // 世界方向 → 某参考系的局部方向（该参考系不含自转，即「地理系」）
  function trailLocalDir(obj, worldDir, out) {
    obj.updateWorldMatrix(true, false);
    obj.getWorldQuaternion(_tq);
    return out.copy(worldDir).applyQuaternion(_tq.invert());
  }
  // 单位向量球面线性插值（用于在两个采样时刻之间补点）
  function trailSlerp(a, b, t, out) {
    const c = clamp(a.dot(b), -1, 1), om = Math.acos(c), s = Math.sin(om);
    if (s < 1e-6) return out.copy(b);
    const w1 = Math.sin((1 - t) * om) / s, w2 = Math.sin(t * om) / s;
    return out.set(a.x * w1 + b.x * w2, a.y * w1 + b.y * w2, a.z * w1 + b.z * w2);
  }
  function trailLineRadius() { return Math.max(state.style.ln.subTrail.w * D, 0.0006); }

  // 往轨迹里追加一个采样点（自转 / 公转两个系同步推进，索引一一对应）
  function trailPush(dirR, dirO) {
    const S = trailSetR;
    if (S.n >= TRAIL_CAP) return;
    const i = S.n * 3;
    S.pts[i] = dirR.x; S.pts[i + 1] = dirR.y; S.pts[i + 2] = dirR.z;
    trailSetO.pts[i] = dirO.x; trailSetO.pts[i + 1] = dirO.y; trailSetO.pts[i + 2] = dirO.z;
    S.n++; trailSetO.n++;
    trailDirtyR = trailDirtyO = true;

    /* 标记点：纬度用「地理纬度」（局部方向与地轴夹角），
         · 赤道 —— 纬度穿越 0°（一次穿越一个点，两点线性插值到纬度恰为 0 处）；
         · 南北回归线 —— 纬度取到极值的那一点（数学上极值恰为 ±黄赤交角，即真正的二至点），
           故判定「导函数变号 且 峰值已越过回归线容差」后，把标记打在**前一个**采样点上。 */
    const lat = Math.asin(clamp(dirR.y, -1, 1)) * R;
    if (trailHaveLat) {
      const d = lat - trailLat;
      if (TROPIC_LAT > 0.5) {
        if (trailDLat > 1e-9 && d <= 0 && trailLat > TROPIC_LAT - TRAIL_TROPIC_TOL) {
          trailAddMark(1, _mR.copy(_pR), _mO.copy(_pO));   // 北回归线（极值在前一个采样点上）
        }
        if (trailDLat < -1e-9 && d >= 0 && trailLat < -(TROPIC_LAT - TRAIL_TROPIC_TOL)) {
          trailAddMark(-1, _mR.copy(_pR), _mO.copy(_pO));  // 南回归线
        }
      }
      if ((trailLat < 0 && lat >= 0) || (trailLat > 0 && lat <= 0)) {
        const den = Math.abs(trailLat) + Math.abs(lat);
        const f = den > 1e-9 ? Math.abs(trailLat) / den : 0.5;
        trailAddMark(0, _mR.copy(_pR).lerp(dirR, f).normalize(),
          _mO.copy(_pO).lerp(dirO, f).normalize());        // 赤道
      }
      trailDLat = d;
    } else {
      trailHaveLat = true;
    }
    trailLat = lat;
    _pR.copy(dirR); _pO.copy(dirO);
  }
  // kind: +1 北回归线 / 0 赤道 / −1 南回归线
  function trailAddMark(kind, dirR, dirO) {
    const list = trailSetR.markList;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === kind && list[i].dir.dot(dirR) > TRAIL_DEDUP_DOT) return;   // 同一处已记过
    }
    const s = Math.max(state.style.pt.subTrailMark.size, 0.0005);
    const pair = [trailSetR.marks, trailSetO.marks].map(function (host, k) {
      const m = new THREE.Mesh(trailMarkGeo, trailMarkMat);
      m.position.copy(k === 0 ? dirR : dirO).multiplyScalar(TRAIL_MARK_R);
      m.scale.setScalar(s);
      m.renderOrder = 26;
      m.frustumCulled = false;
      host.add(m);
      return m;
    });
    list.push({ kind: kind, dir: dirR.clone(), meshes: pair });
    if (list.length > TRAIL_MARK_MAX) {                 // 超上限：连同公转侧一起丢弃最早的一对
      const old = list.shift();
      old.meshes.forEach(function (m) { if (m.parent) m.parent.remove(m); });
    }
  }
  /* 重建管状线几何：先算切向，再用平行输运推截面基，最后写顶点。
     只写前 n 圈，drawRange 也只画前 n−1 段 —— 尾部保持上一次的内容 / 退化，不被绘制。 */
  function rebuildTrailGeo(S, radius) {
    const n = S.n, ringV = TRAIL_RADIAL + 1, p = S.pts;
    if (n < 2 || radius <= 0) { S.geo.setDrawRange(0, 0); return; }
    const posA = S.pos.array, nrmA = S.nrm.array, uvA = S.uvs.array;
    const tanA = S.tan, frN = S.frmN, frB = S.frmB;
    // 1) 切向（中心差分）
    for (let j = 0; j < n; j++) {
      const a = Math.max(0, j - 1) * 3, b = Math.min(n - 1, j + 1) * 3, o = j * 3;
      let tx = p[b] - p[a], ty = p[b + 1] - p[a + 1], tz = p[b + 2] - p[a + 2];
      const L = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (L < 1e-9) { tx = 0; ty = 0; tz = 1; } else { tx /= L; ty /= L; tz /= L; }
      tanA[o] = tx; tanA[o + 1] = ty; tanA[o + 2] = tz;
    }
    // 2) 截面基：起始法向取「与切向分量最小的坐标轴」正交化，其后逐圈平行输运
    let nx, ny, nz;
    if (Math.abs(tanA[0]) > Math.abs(tanA[2])) { nx = -tanA[1]; ny = tanA[0]; nz = 0; }
    else { nx = 0; ny = -tanA[2]; nz = tanA[1]; }
    let l0 = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l0; ny /= l0; nz /= l0;
    frN[0] = nx; frN[1] = ny; frN[2] = nz;
    frB[0] = tanA[1] * nz - tanA[2] * ny;
    frB[1] = tanA[2] * nx - tanA[0] * nz;
    frB[2] = tanA[0] * ny - tanA[1] * nx;
    for (let j = 1; j < n; j++) {
      const o = j * 3, q = (j - 1) * 3;
      const tx = tanA[o], ty = tanA[o + 1], tz = tanA[o + 2];
      const bx = frB[q], by = frB[q + 1], bz = frB[q + 2];
      let vx = ty * bz - tz * by, vy = tz * bx - tx * bz, vz = tx * by - ty * bx;
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vl < 1e-9) { vx = 0; vy = 0; vz = 0; } else { vx /= vl; vy /= vl; vz /= vl; }
      const ct = clamp(tx * bx + ty * by + tz * bz, -1, 1), st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const px = frN[q], py = frN[q + 1], pz = frN[q + 2];
      let ax = px * ct + vx * st, ay = py * ct + vy * st, az = pz * ct + vz * st;
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      ax /= al; ay /= al; az /= al;
      frN[o] = ax; frN[o + 1] = ay; frN[o + 2] = az;
      frB[o] = ty * az - tz * ay; frB[o + 1] = tz * ax - tx * az; frB[o + 2] = tx * ay - ty * ax;
    }
    // 3) 逐圈铺顶点
    for (let j = 0; j < n; j++) {
      const o = j * 3, u = j / (TRAIL_CAP - 1);
      const cx = p[o] * TRAIL_R, cy = p[o + 1] * TRAIL_R, cz = p[o + 2] * TRAIL_R;
      const ax = frN[o], ay = frN[o + 1], az = frN[o + 2];
      const bx = frB[o], by = frB[o + 1], bz = frB[o + 2];
      for (let i = 0; i <= TRAIL_RADIAL; i++) {
        const v = (i / TRAIL_RADIAL) * TWO_PI;
        const si = Math.sin(v), co = -Math.cos(v);
        let dx = co * ax + si * bx, dy = co * ay + si * by, dz = co * az + si * bz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        const k = (j * ringV + i) * 3, ku = (j * ringV + i) * 2;
        posA[k] = cx + radius * dx; posA[k + 1] = cy + radius * dy; posA[k + 2] = cz + radius * dz;
        nrmA[k] = dx; nrmA[k + 1] = dy; nrmA[k + 2] = dz;
        uvA[ku] = u; uvA[ku + 1] = i / TRAIL_RADIAL;
      }
    }
    S.pos.needsUpdate = true; S.nrm.needsUpdate = true; S.uvs.needsUpdate = true;
    /* 4) v23.18：重建索引 —— 在「段起点」处跳过与前一圈的连接，使轨迹在空档处断开。
       索引缓冲在 makeTrailSet 里已按最大容量分配；drawRange 收到实际写入的三角形数。 */
    const idxA = S.geo.index.array;
    let q = 0;
    for (let j = 0; j < n - 1; j++) {
      if (isTrailSegStart(S, j + 1)) continue;
      const rowA = j * ringV, rowB = rowA + ringV;
      for (let i = 0; i < TRAIL_RADIAL; i++) {
        const a = rowA + i, b = rowB + i;
        idxA[q++] = a; idxA[q++] = b; idxA[q++] = a + 1;
        idxA[q++] = a + 1; idxA[q++] = b; idxA[q++] = b + 1;
      }
    }
    S.geo.index.needsUpdate = true;
    S.geo.setDrawRange(0, q);
  }
  // 采样索引 j 是否是某一「段」的起点（段 0 的起点 0 不算断点）
  function isTrailSegStart(S, j) {
    for (let i = 1; i < S.segs.length; i++) { if (S.segs[i] === j) return true; }
    return false;
  }

  // 样式 → 场景（由 applyAll 统一调用）
  let _trailWasOn = false;                 // v23.18：记录开关的上一帧状态（用于识别「重新开启」）
  function applySubTrail() {
    const L = state.style.ln.subTrail, M = state.style.pt.subTrailMark;
    setTube(trailMat, { color: L.color, op: L.op, dash: L.dash, n: L.n, ratio: L.ratio });
    trailMarkMat.color.set(M.color);
    trailMarkMat.opacity = M.op;
    trailSetR.markList.forEach(function (m) {
      m.meshes.forEach(function (x) { x.scale.setScalar(Math.max(M.size, 0.0005)); });
    });
    const on = !!state.subTrail;
    trailSetR.grp.visible = on;
    trailSetO.grp.visible = on;
    /* v23.18（需求②）：记录中途关掉再打开时，**不要**把关闭期间的空档补成一条穿越线 ——
       重新开启的瞬间把「上一采样点」重置到当前时刻的直射点，并把这里记为新一段的起点
       （几何上断开，见 rebuildTrailGeo / isTrailSegStart）。
       （关闭期间本来就不该记录；补空档既不算「记录完整」，还会在轨迹上留一道直线。） */
    if (on && !_trailWasOn) {
      trailPrimed = false; trailHaveLat = false; trailDLat = 0;
      trailLastMs = simMs;                     // v25.1：重新开启时从当前时刻续记（不做时间细分）
      trailArc = 0;                            // 重新开启＝重新记一整圈
      if (trailSetR.n > 0) { trailSetR.segs.push(trailSetR.n); trailSetO.segs.push(trailSetO.n); }
    }
    _trailWasOn = on;
    trailDirtyR = trailDirtyO = true;      // 线宽 / 容量相关参数变化 → 下一帧重建几何
  }
  // 「清除轨迹并重新记录」：清空已记录的点与标记点，从当前时刻重新开始
  function clearSubTrail() {
    [trailSetR, trailSetO].forEach(function (S) {
      S.n = 0;
      S.segs.length = 0; S.segs.push(0);
      S.markList.forEach(function (m) { m.meshes.forEach(function (x) { if (x.parent) x.parent.remove(x); }); });
      S.markList.length = 0;
    });
    trailPrimed = false; trailHaveLat = false; trailDLat = 0;
    trailLastMs = simMs;                       // v25.1：清空后从当前时刻重新开始
    trailArc = 0;
    trailDirtyR = trailDirtyO = true;
  }
  /* v25.1（需求②）：把「上一采样点 → 当前直射点」这一段按**固定弧长**采样。
     · 弧长不足一个步长时**不推进基准点**（_pR 保持不动），弧长自然累积到下一帧 ——
       这是「实际步长恒为 0.35°」的关键；
     · 弧长走满后推入 floor(ang/步长) 个点，且严格落在弧长的整数倍处
       （t = i·步长 / ang），不再用 i/k 均匀铺 —— 后者会把步长压缩成 ang/ceil。
     trailPush() 末尾会把 _pR 推进到「刚推入的那个点」，因此本函数不需要再动 _pR。 */
  function trailFeed(dirR, dirO) {
    if (trailSetR.n >= TRAIL_CAP || trailArc >= TRAIL_ARC_MAX) return;
    if (!trailPrimed) { trailPrimed = true; _pR.copy(dirR); _pO.copy(dirO); return; }
    const ang = Math.acos(clamp(_pR.dot(dirR), -1, 1));
    if (ang < TRAIL_STEP_ANG) return;                     // 还没走够一步：等弧长继续累积
    let k = Math.floor(ang / TRAIL_STEP_ANG);
    if (k > TRAIL_KMAX) k = TRAIL_KMAX;
    _bR.copy(_pR); _bO.copy(_pO);                         // 本批插值起点（trailPush 会推进 _pR，必须另存）
    for (let i = 1; i <= k; i++) {
      const t = Math.min(1, (i * TRAIL_STEP_ANG) / ang);
      trailPush(trailSlerp(_bR, dirR, t, _sR), trailSlerp(_bO, dirO, t, _sO));
      trailArc += TRAIL_STEP_ANG;
      if (trailSetR.n >= TRAIL_CAP || trailArc >= TRAIL_ARC_MAX) break;
    }
  }
  // 每帧：先补几何，再按「固定弧长」采样（大跳变时按时间细分）
  function trailTick() {
    if (trailDirtyR) { rebuildTrailGeo(trailSetR, trailLineRadius()); trailDirtyR = false; }
    if (trailDirtyO) { rebuildTrailGeo(trailSetO, trailLineRadius()); trailDirtyO = false; }
    if (!state.subTrail || trailSetR.n >= TRAIL_CAP || trailArc >= TRAIL_ARC_MAX) { trailLastMs = simMs; return; }
    const dt = simMs - trailLastMs;
    trailLastMs = simMs;
    /* v25.1（需求②）：单帧时间跨度过大（拖动时间轴 / 极高倍速）时按时间细分 ——
       两点之间直接取最短大圆弧会把真实路径拉直，细分后逐段求真实直射点方向再采样。 */
    if (dt > TRAIL_SUB_MS) {
      const from = simMs - dt;
      let cnt = Math.ceil(dt / TRAIL_SUB_MS);
      if (cnt > TRAIL_SUB_MAX) cnt = TRAIL_SUB_MAX;
      for (let i = 1; i <= cnt; i++) {
        simMs = from + dt * (i / cnt);
        updateScene(); updateOrbit();
        trailLocalDir(tilt, sunDir, _dR2);
        trailLocalDir(tiltOrb, orbSunDir, _dO2);
        trailFeed(_dR2, _dO2);
        if (trailSetR.n >= TRAIL_CAP || trailArc >= TRAIL_ARC_MAX) break;
      }
      simMs = from + dt;                                  // 复原到当前时刻
      updateScene(); updateOrbit();
      return;
    }
    trailLocalDir(tilt, sunDir, _dR);
    trailLocalDir(tiltOrb, orbSunDir, _dO);
    trailFeed(_dR, _dO);
  }

  /* ============ 极昼 / 极夜区域 ============ */
  function buildCapGeometry(rings, segs) {
    const v = new Float32Array((rings + 1) * (segs + 1) * 2);
    const idx = [];
    let p = 0;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      for (let j = 0; j <= segs; j++) {
        const az = (TWO_PI * j) / segs;
        v[p++] = az; v[p++] = t;
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * (segs + 1) + j, b = a + segs + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('azimuth', new THREE.BufferAttribute(new Float32Array(v.filter(function (_, i) { return i % 2 === 0; })), 1));
    g.setAttribute('radial', new THREE.BufferAttribute(new Float32Array(v.filter(function (_, i) { return i % 2 === 1; })), 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
    return g;
  }

  const capVS = `
    attribute float azimuth; attribute float radial;
    uniform float uCapAngle, uDir, uRadius;
    varying float vRadial;
    void main(){
      float th = radial * uCapAngle;
      vec3 p = vec3(sin(th) * cos(azimuth), uDir * cos(th), sin(th) * sin(azimuth)) * uRadius;
      vRadial = radial;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `;
  const capFS = `
    uniform vec3 uColor; uniform float uOpacity; uniform float uPattern;
    varying float vRadial;
    ${SRGB_FN}
    void main(){
      float a = uOpacity;
      if (uPattern > 1.5) {
        vec2 c = mod(gl_FragCoord.xy, vec2(9.0)) - vec2(4.5);
        a *= mix(0.22, 1.0, step(2.6, length(c)));
      } else if (uPattern > 0.5) {
        a *= mix(0.24, 1.0, step(0.45, fract((gl_FragCoord.x + gl_FragCoord.y) / 13.0)));
      }
      a *= mix(1.0, 0.86, smoothstep(0.86, 1.0, vRadial));
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function makeCap(dir) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCapAngle: { value: 0 }, uDir: { value: dir }, uRadius: { value: 1.004 },
        uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0.4 }, uPattern: { value: 0 },
      },
      vertexShader: capVS, fragmentShader: capFS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(buildCapGeometry(20, 128), mat);
    mesh.renderOrder = 2;
    tilt.add(mesh);
    return mesh;
  }
  const capDay = makeCap(1);     // 极昼（随赤纬正负切换南北）
  const capNight = makeCap(-1);
  const capMatDay = capDay.material, capMatNight = capNight.material;
  // 公转场景中的极昼极夜（共享几何体、克隆材质）
  const capDayOrb = new THREE.Mesh(capDay.geometry, capMatDay.clone()); capDayOrb.renderOrder = 2; tiltOrb.add(capDayOrb);
  const capNightOrb = new THREE.Mesh(capNight.geometry, capMatNight.clone()); capNightOrb.renderOrder = 2; tiltOrb.add(capNightOrb);
  const capMatDayOrb = capDayOrb.material, capMatNightOrb = capNightOrb.material;

  // 极区边界描边
  const strokeDay = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 8, 160), tubeMat('#FFFFFF', 0.95));
  const strokeNight = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 8, 160), tubeMat('#FFFFFF', 0.95));
  strokeDay.rotation.x = -Math.PI / 2; strokeNight.rotation.x = -Math.PI / 2;
  strokeDay.renderOrder = 3; strokeNight.renderOrder = 3;
  tilt.add(strokeDay); tilt.add(strokeNight);
  // 公转场景中的极区描边（各自持有几何体，避免重建时互相影响）
  const strokeDayOrb = new THREE.Mesh(strokeDay.geometry.clone(), strokeDay.material.clone());
  const strokeNightOrb = new THREE.Mesh(strokeNight.geometry.clone(), strokeNight.material.clone());
  strokeDayOrb.rotation.x = -Math.PI / 2; strokeNightOrb.rotation.x = -Math.PI / 2;
  strokeDayOrb.renderOrder = 3; strokeNightOrb.renderOrder = 3;
  tiltOrb.add(strokeDayOrb); tiltOrb.add(strokeNightOrb);

  function rebuildStroke(mesh, tube) {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.TorusGeometry(1, tube, 8, 200);
  }

  /* ============ 太阳光线箭头 ============ */
  const rayMats = [];                     // 箭头材质（颜色 / 透明度由「箭头样式」设置）
  const shaftMatsR = [], shaftMatsO = []; // 自转 / 公转箭杆材质（含各自杆长，用于虚线密度换算）
  const raysGroup = new THREE.Group(); scene.add(raysGroup);
  const rayCenterGroup = new THREE.Group(); // 中间直射的那一条
  const rayRingGroup = new THREE.Group();   // 外围一圈平行光线
  raysGroup.add(rayCenterGroup); raysGroup.add(rayRingGroup);
  const rayShafts = [], rayHeads = [];
  /* v32（需求一）：竖排太阳光线的常量与容器 ——
     光线按**纬度**纵向分布（北极 / 南极 / 赤道 / 南北纬 45° 各一条为默认 5 条）；
     RAY_VMAX 是插槽上限（= 最大条数 − 1，因为赤道那条走 rayCenterArrowRef）。 */
  const RAY_VMAX = 24;
  const rayVertArrows = [];
  let rayCenterArrowRef = null;
  let rayHeadMat = null;      // 箭头材质（供「箭头样式」单独设置颜色 / 透明度）
  /* ===== v20.0：太阳光线「自转 / 公转统一」渲染 =====
     旧实现里，自转用圆柱箭杆（永远实线）+ 独立几何的箭头，公转用 LineDashedMaterial 细线 +
     另一个尺寸的圆锥 —— 两个视图的「虚实线类型」「箭头设置」互不相通。
     现在两个视图共用同一套几何与材质：
       · 箭杆 = 单位圆柱 + 片元着色器按 uv.y（沿杆长 0→1）周期开合 → 支持虚线 / 虚线密度 / 虚实比；
       · 箭头 = 单位圆锥 ×（线粗细比例 × 箭头大小倍率），颜色 / 透明度取「箭头样式」；
       · 箭杆基准半径 RAY_R0（= 默认线粗细）、箭头基准半径 RAY_HR0、箭头长度 RAY_HEAD_L 全部共用。
     dashN 按杆长换算（RAY_DASH_REF 为基准长度），保证长短不同的光线虚线疏密观感一致。 */
  /* v23.7：箭头基准尺寸上调（原 0.036 / 0.12）—— 自转视图里原箭头半径被公式抵消成箭杆半径
     （见 applyRayStyle 的说明），几乎看不出箭头。现在箭头基准半径 = 箭杆的 5.5 倍、长度翻倍，
     自转视图的箭头清晰可辨；公转视图的箭头另按地球半径换算，不受这两个常量影响。 */
  const RAY_R0 = 0.011, RAY_HR0 = 0.060, RAY_HEAD_L = 0.24, RAY_DASH_REF = 3;
  // v23.5：公转箭头在世界坐标下的长度（按地球半径换算，供 updateOrbit 定位）。
  //   必须在 RAY_HEAD_L 声明之后再初始化 —— 否则会踩 const 的「暂时性死区(TDZ)」，
  //   在初始化阶段抛 ReferenceError，导致整个 IIFE 中断、页面永久卡在「正在加载贴图…」。
  let orbRayHeadLenW = RAY_HEAD_L;
  const RAY_UNIT_SHAFT = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const RAY_UNIT_HEAD = new THREE.ConeGeometry(1, 1, 14);
  const RAY_TUBE_FS = `
    uniform vec3 uColor; uniform float uOpacity, uDash, uDashN, uDashRatio;
    varying vec2 vUv;
    ${SRGB_FN}
    void main(){
      float a = uOpacity;
      if (uDash > 0.5) {
        float t = (1.0 - vUv.y) * uDashN;
        float f = fract(t);
        float w = clamp(fwidth(t) * 0.6, 1e-4, 0.5);
        a *= smoothstep(0.0, w, f) * (1.0 - smoothstep(uDashRatio, uDashRatio + w, f));
      }
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function rayShaftMat(color, op) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color || '#FFD873') }, uOpacity: { value: op == null ? 1 : op },
        uDash: { value: 0 }, uDashN: { value: 40 }, uDashRatio: { value: 0.55 },
      },
      vertexShader: TUBE_VS, fragmentShader: RAY_TUBE_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }
  // 箭杆材质登记（mat + 杆长 + 透明度倍率），样式变化时统一写入
  function pushShaftMat(list, mat, len, mul) { list.push({ mat: mat, len: len, mul: mul == null ? 1 : mul }); return mat; }
  (function buildRays() {
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95, depthWrite: false });
    rayMats.push(headMat); rayHeadMat = headMat;
    const makeArrow = function (oy, oz) {
      const b2 = oy * oy + oz * oz;
      const xEnd = Math.sqrt(Math.max(1.0008 - b2, 0.0004)) + 0.035;
      const len = Math.max(2.95 - xEnd, 0.2);
      const g = new THREE.Group();
      const rec = { mat: null, len: len };
      const mat = pushShaftMat(shaftMatsR, rayShaftMat(state.style.ln.ray.color, state.style.ln.ray.op), len);
      rec.mat = shaftMatsR[shaftMatsR.length - 1];
      const shaft = new THREE.Mesh(RAY_UNIT_SHAFT, mat);
      shaft.rotation.z = Math.PI / 2;
      shaft.scale.set(RAY_R0, len, RAY_R0);
      shaft.position.x = (2.95 + xEnd) / 2;
      const head = new THREE.Mesh(RAY_UNIT_HEAD, headMat);
      head.rotation.z = Math.PI / 2;
      head.scale.set(RAY_HR0, RAY_HEAD_L, RAY_HR0);
      head.position.x = xEnd + RAY_HEAD_L / 2;   // 锥尖恰好落在 xEnd（球外一点）—— 随箭头长度自动跟随
      g.add(shaft); g.add(head);
      rayShafts.push(shaft); rayHeads.push(head);
      g.position.set(0, oy, oz);
      g.userData.vShaft = shaft; g.userData.vHead = head; g.userData.vRec = rec;
      return g;
    };
    rayCenterArrowRef = makeArrow(0, 0);
    rayCenterGroup.add(rayCenterArrowRef);
    /* ★ v32（需求一）：太阳光线改为**按纬度纵向分布** ——
       极点 / ±45° / 赤道各有光线，条数由「光线密度」控制（见 applyRayVertLayout）。
       这里一次性建满 RAY_VMAX 个插槽（先摆在赤道），运行时按纬度重排 / 显隐。 */
    for (let k = 0; k < RAY_VMAX; k++) {
      const a = makeArrow(0, 0);
      rayRingGroup.add(a);
      rayVertArrows.push(a);
    }
    // “太阳光”文字精灵
    const draw = function (g2, k) {
      g2.font = 'bold ' + (52 * k) + 'px ' + noteFontOf('ray');
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      // v17.0：文字一律不描边（去黑边），仅实心填充
      g2.fillStyle = '#ffe38a'; g2.fillText('太阳光', 160 * k, 50 * k);
    };
    const c = document.createElement('canvas'); c.width = 320; c.height = 96;
    draw(c.getContext('2d'), 1);
    const t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: true }));
    registerSprite(sp, 0.9, 0.27, draw, 320, 96, 52); sp.userData.cat = 'ray'; sp.userData.key = 'ray.sun'; sp.position.set(2.55, 1.15, 0);
    raysGroup.add(sp);
  })();

  /* ============================================================================
     v37（需求一·3）：太阳「体积光柱」重做 —— 实心光柱 + 外围柔光束
     ----------------------------------------------------------------------------
     参照科教可视化目标效果：一根**细长平行**的实心光柱（直径默认 = 地球直径）连接
     太阳与地球，外围再包一层**长条形半透明白色体积光束**：
       · 核心圆柱：颜色可设（默认暖黄），亮度均匀（实心观感），滤色发光（Additive）；
       · 外围光束：固定白色，屏幕空间径向衰减 —— alpha ∝ |dot(N,V)|^1.6，
         正对柱心的面最亮、轮廓边缘趋于 0 ⇒ 边缘柔和衰减向外淡化；
     两层都是 AdditiveBlending（滤色发光）+ depthWrite 关 / depthTest 开 ——
     不遮挡星空背景，没有镜头眩光 / 爆闪，被地球挡住的部分正常隐藏。
     自转 / 公转 / 综合视图同步（volShaftR / volShaftO 同一套材质逻辑）。
     ========================================================================== */
  /* ★ v38（需求一）：光柱改为**实心圆柱体**（带端盖），且边缘与宇宙背景**平滑过渡**。
     关键改动（相对 v37 的空心观感）：
       · 几何：openEnded = false ⇒ 圆柱封口，配合 alpha 径向渐变呈现「实心柱体」；
       · 材质：屏幕空间径向衰减 —— 柱心（正对视线处，|dot(N,V)|≈1）最亮，柱缘轮廓
         （|dot(N,V)|≈0）alpha→0 平滑融入背景；端盖面朝相机时也有渐变，柱体整体呈
         一根发光实心棒；
       · 近地端：光柱自**地心**起算，与地球相交的部分被地球本体（depthTest）裁掉 ⇒
         露出的近地端轮廓正好是地球轮廓圆，即**晨昏圈**（近地侧边缘 = 晨昏线）。
     自转 / 公转 / 综合视图同步（volShaftR / volShaftO 同一套材质逻辑）。
     ========================================================================== */
  const VOL_UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 64, 1, false);
  const _vsUp = new THREE.Vector3(0, 1, 0);
  /* 实心光柱：颜色可设；alpha = uOp · smoothstep(0, uEdge, |dot(N,V)|)^falloff
     —— 柱心亮、轮廓处**彻底归零**（与宇宙背景无缝平滑过渡，无硬边界）。 */
  function volCoreMat() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#ffd873') },
        uOp: { value: 0.5 },
        uFall: { value: 1.0 },
        uEdge: { value: 0.86 },
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vLocal;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vN = normalize(mat3(modelMatrix) * normal);',
        '  vV = normalize(cameraPosition - wp.xyz);',
        /* ★ v40（需求二）：把圆柱自身局部坐标传出 —— 用它做**轴向**淡出：
           cylinder geometry 高度 1、中心在原点 ⇒ y ∈ [−0.5, 0.5]，
           越靠近两端（与地球 / 太阳相接处）越透明，避免端盖形成生硬圆盘。 */
        '  vLocal = position;',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOp; uniform float uFall; uniform float uEdge;',
        'varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vLocal;',
        SRGB_FN,
        'void main(){',
        '  if (uOp < 0.004) discard;',
        /* 实心柱体轮廓：|dot| 在轮廓处 → 0；先 smoothstep 归零（消硬边），再取幂调中心亮度 */
        '  float f = abs(dot(normalize(vN), normalize(vV)));',
        '  float g = smoothstep(0.0, uEdge, f);',
        '  float a = uOp * pow(g, uFall);',
        /* ★ v40（需求二）：轴向柔化 —— 圆柱两端（与地球 / 太阳球面接触处）
           在 12% 长度内平滑淡出到 0，使光柱与两天体的接壤处自然消隐、无色块硬边。 */
        '  float t = clamp(vLocal.y + 0.5, 0.0, 1.0);',
        '  float axial = smoothstep(0.0, 0.14, t) * smoothstep(1.0, 0.86, t);',
        '  a *= axial;',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(toSRGB(uColor), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }
  /* 外层柔光束：白色、范围更大、衰减更陡 ⇒ 实心光柱外侧只留一层极柔光晕。
     独立阈值 uEdge：外壳半径更大，轮廓出现在 |dot| 较大处 —— 用更高的 soft 上限
     让它在自身半径内就淡化到 0，避免在大半径上留下可辨认的外缘。 */
  function volSheathMat() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#ffffff') },
        uOp: { value: 0.25 },
        uFall: { value: 1.4 },
        uEdge: { value: 0.94 },
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vLocal;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vN = normalize(mat3(modelMatrix) * normal);',
        '  vV = normalize(cameraPosition - wp.xyz);',
        '  vLocal = position; vUv = uv;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOp; uniform float uFall; uniform float uEdge;',
        'varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vLocal;',
        SRGB_FN,
        'void main(){',
        '  float f = abs(dot(normalize(vN), normalize(vV)));',
        '  float g = smoothstep(0.0, uEdge, f);',
        '  float a = uOp * pow(g, uFall);',
        /* ★ v40（需求二）：外壳同样做轴向柔化，让外围光晕在两端自然收敛。 */
        '  float t = clamp(vLocal.y + 0.5, 0.0, 1.0);',
        '  float axial = smoothstep(0.0, 0.18, t) * smoothstep(1.0, 0.82, t);',
        '  a *= axial;',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(toSRGB(uColor), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }
  /* v38：双层壳 —— 内层实心光柱（renderOrder 18）+ 外层白色柔光束（19）。
     两层几何都封口（实心柱体）；内核用较低的衰减指数（柱心到边缘渐变柔和），
     外壳用较高指数（更聚焦到柱心，向外快速淡化）。
     ★ v39（需求一·1）：径向分段数大幅提高（64/48 → 192/160）——
       光柱直径可放大到地球直径的 3 倍，低分段时圆柱侧面是粗多面体，
       与地球相交的轮廓处会露出**圆弧形锯齿**；高分段后轮廓按像素级平滑。 */
  const VOL_CORE_CYL = new THREE.CylinderGeometry(1, 1, 1, 192, 1, false);
  const VOL_SHEATH_CYL = new THREE.CylinderGeometry(1, 1, 1, 160, 1, false);
  function makeVolShaft() {
    const grp = new THREE.Group();
    const core = new THREE.Mesh(VOL_CORE_CYL, volCoreMat());
    core.renderOrder = 18;
    const sheath = new THREE.Mesh(VOL_SHEATH_CYL, volSheathMat());
    sheath.renderOrder = 19;
    grp.add(core); grp.add(sheath);
    return { grp: grp, core: core, sheath: sheath };
  }
  const volShaftR = makeVolShaft(); scene.add(volShaftR.grp);
  const volShaftO = makeVolShaft(); orbitScene.add(volShaftO.grp);
  /* 摆放：dir = 由地球指向太阳的单位向量；earthR = 地球的世界半径；
     len = 光柱远端到地心的距离（通常取日地距离 ⇒ 抵达太阳球心）。
     ★ v38（需求一）：光柱自**地心**（0）起算 —— 与地球相交的近地端被地球本体
       （depthTest）自然裁掉，露出的近地端轮廓 = 地球轮廓圆 = **晨昏圈**
       （「靠近地球一侧的边缘即为晨昏线」）。
     直径：核心半径 = 地球半径 × 直径%；外围光束半径 = 核心半径 × 外围光束范围%。 */
  function layoutVolShaft(sh, dir, earthR, len) {
    const V = state.volShaft;
    const dia = Math.max(0.6, clamp(+V.dia || 100, 60, 400) / 100);
    const glow = Math.max(1.0, clamp(+V.glow || 160, 100, 320) / 100);
    const R = earthR * dia, RG = R * glow;
    const x0 = 0, x1 = Math.max(earthR * 0.4, len);
    sh.core.quaternion.setFromUnitVectors(_vsUp, dir);
    sh.core.scale.set(R, (x1 - x0), R);
    sh.core.position.copy(dir).multiplyScalar((x0 + x1) / 2);
    sh.sheath.quaternion.copy(sh.core.quaternion);
    sh.sheath.scale.set(RG, (x1 - x0), RG);
    sh.sheath.position.copy(sh.core.position);
  }
  function styleVolShaft(sh, on) {
    sh.grp.visible = !!on;
    if (!on) return;
    const V = state.volShaft;
    const op = clamp(+V.op || 0, 0, 100) / 100;
    const inten = clamp(+V.intensity || 0, 0, 100) / 100;
    const uc = sh.core.material.uniforms, us = sh.sheath.material.uniforms;
    uc.uColor.value.set(V.color || '#ffd873');
    /* ★ v38（需求一）：实心柱体自地心起算、端盖朝相机，alpha 由柱心向边缘渐变。 */
    uc.uOp.value = op * inten * 1.0;
    /* ★ v39（需求一·1）：uEdge 0.72 → 0.86、衰减指数 1.0 ——
       扩大「轮廓附近平滑归零」的过渡带，使圆柱侧面与地球相交处的
       多边形轮廓彻底消隐（配合 192 分段，接壤处呈柔滑圆形边界，无锯齿）。 */
    uc.uFall.value = 1.0;
    uc.uEdge.value = 0.86;
    us.uColor.value.set('#ffffff');
    us.uOp.value = op * inten * 0.26;
    us.uFall.value = 1.4;
    /* ★ v39（需求一·1）：外壳 uEdge 0.9 → 0.94，同理扩大平滑带、消除外缘锯齿。 */
    us.uEdge.value = 0.94;
  }
  const volShaftOn = function () {
    return !!state.volShaft.on && state.volShaft.intensity > 0 && state.volShaft.op > 0;
  };
  let _volSigR = '', _volSigO = '';
  /* ★ v32（需求一）：太阳光线「按纬度纵向分布」。
     把一条光线重新摆到「命中地球纬度 lat 的平行光线」上：
       光线恒在 y = sin(lat)（z=0）的水平线上由太阳射向地球，箭头锥尖落在
       x = √(1.0008 − y²) —— 即**地表朝日侧**，因此箭头恒指向地表。 */
  function setVertArrow(g, latDeg) {
    const y = clamp(Math.sin(latDeg * D), -0.999, 0.999);
    const xEnd = Math.sqrt(Math.max(1.0008 - y * y, 0.0004)) + 0.035;
    const len = Math.max(2.95 - xEnd, 0.2);
    const u = g.userData;
    u.vShaft.scale.y = len;
    u.vShaft.position.x = (2.95 + xEnd) / 2;
    u.vHead.position.x = xEnd + RAY_HEAD_L / 2;
    if (u.vRec) u.vRec.len = len;          // 虚线密度按杆长换算（与 applyRayStyle 同口径）
    g.position.set(0, y, 0);
  }
  /* 竖排光线的纬度表：默认 5 条 ⇒ 北极 90° / 北纬 45° / 赤道 0° / 南纬 45° / 南极 −90°。
     条数 n 均匀铺满 [−90°, 90°]，n 为奇数时正中那条即赤道（直射光线）。 */
  function rayVertLats(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(-90 + 180 * i / (n - 1));
    return out;
  }
  /* ★ v33（需求四）：把「光线组」的姿态统一为 —— 局部 X 指向太阳、局部 Y = **地轴在垂直
     光线方向上的投影**（即南北方向）。旧写法用 setFromUnitVectors(XAX, sunDir)，得到的
     纵向是「任意一条垂直线」，与地轴无关；公转视图则干脆是 7 条横向平移的平行光场 ——
     两个视图的太阳光线长得完全不一样。统一之后：
       · 自转 / 公转 / 综合三个视图共用同一张纬度表 rayVertLats() 与同一个条数 rayVert.n；
       · 纵向一律沿「南北」，光线幕才是真正的「按纬度分布」。
     地轴与光线平行（太阳正在天顶 / 天底）时投影退化，回落到任意垂直方向。 */
  const _rq1 = new THREE.Vector3(), _rq2 = new THREE.Vector3(), _rq3 = new THREE.Vector3();
  const _rqM = new THREE.Matrix4();
  function rayAimQuat(q, dir, axis) {
    const ax = _rq1.copy(axis);
    ax.addScaledVector(dir, -ax.dot(dir));
    if (ax.lengthSq() < 1e-10) { q.setFromUnitVectors(XAX, dir); return q; }
    ax.normalize();
    const ez = _rq2.copy(dir).cross(ax).normalize();
    _rq3.copy(ax).cross(ez).normalize();          // 重新正交化后的 dir
    _rqM.makeBasis(_rq3, ax, ez);                 // 列 = 局部 X / Y / Z
    return q.setFromRotationMatrix(_rqM);
  }
  /* 竖排太阳光线的可见条数与纬度分布（n 未变则直接返回 —— 每帧调用但几乎零开销） */
  let _rayVertSig = -1;
  function applyRayVertLayout(force) {
    const n = clamp(Math.round(+state.rayVert.n) || 5, 3, RAY_VMAX + 1);
    if (!force && n === _rayVertSig) return;
    _rayVertSig = n;
    const lats = rayVertLats(n);
    /* 最接近赤道的那条 = 直射光线（走 rayCenterArrowRef，受「只显示直射光线」门控） */
    let mid = 0;
    for (let i = 1; i < n; i++) if (Math.abs(lats[i]) < Math.abs(lats[mid])) mid = i;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i === mid && rayCenterArrowRef) {
        setVertArrow(rayCenterArrowRef, lats[i]);
        rayCenterArrowRef.visible = true;
      } else {
        const g = rayVertArrows[j++];
        if (!g) continue;
        setVertArrow(g, lats[i]);
        g.visible = true;
      }
    }
    for (; j < rayVertArrows.length; j++) rayVertArrows[j].visible = false;
    applyRayStyle();     // 杆长变了 → 箭头尺寸 / 虚线密度跟着刷新
  }

  /* ============ 公转动画场景（地轴指向固定 · 自由视角） ============ */
  // 太阳
  /* v31（需求九）：太阳使用**真实贴图** —— 程序化生成太阳表面纹理（米粒组织 / 对流斑 / 黑子 /
     临边增亮），不依赖外链图片；自转 / 公转 / 综合三个视图的太阳盘共用同一材质与同一开关。 */
  function makeSunTexture() {
    const w = 512, h = 256;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#ff9d24'; g.fillRect(0, 0, w, h);
    let seed = 20260929 >>> 0;
    const rnd = function () { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    // ① 米粒组织：大量细小高光 / 暗斑（太阳表面的对流颗粒）
    for (let i = 0; i < 6000; i++) {
      const x = rnd() * w, y = rnd() * h, r = 1.6 + rnd() * 6;
      const bright = rnd() > 0.52;
      g.beginPath(); g.arc(x, y, r, 0, 6.2832);
      g.fillStyle = bright ? 'rgba(255,242,196,' + (0.05 + rnd() * 0.12).toFixed(3) + ')'
                           : 'rgba(206,86,0,' + (0.04 + rnd() * 0.10).toFixed(3) + ')';
      g.fill();
    }
    // ② 中大尺度对流斑：柔和扩散的明暗块
    for (let i = 0; i < 240; i++) {
      const x = rnd() * w, y = rnd() * h, r = 12 + rnd() * 40;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const bright = rnd() > 0.5;
      grd.addColorStop(0, (bright ? 'rgba(255,238,176,' : 'rgba(196,78,0,') + (0.05 + rnd() * 0.06).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    // ③ 黑子：少量深色斑点（中心更暗、边缘渐淡）
    for (let i = 0; i < 7; i++) {
      const x = 40 + rnd() * (w - 80), y = 40 + rnd() * (h - 80), r = 4 + rnd() * 9;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(108,34,0,0.88)');
      grd.addColorStop(0.6, 'rgba(168,66,0,0.5)');
      grd.addColorStop(1, 'rgba(210,130,24,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    // ④ 两极提亮（球面 UV 的 v≈0/1 靠近两极），配合外层光晕形成真实观感
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, 'rgba(255,246,214,0.35)');
    lg.addColorStop(0.5, 'rgba(255,246,214,0)');
    lg.addColorStop(1, 'rgba(255,246,214,0.35)');
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    return tex;
  }
  const sunTexMap = makeSunTexture();
  // 共用材质：on = 真实贴图（白底乘贴图）；off = 原色纯黄
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: sunTexMap, fog: false });
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 32), sunMat);
  orbitScene.add(sunMesh);
  /* v31（需求九）：自转 / 综合视图（scene 场景）里的太阳盘 —— 与公转太阳共用同一材质，
     每帧沿当前太阳方向 sunDir 摆到远处（见 updateScene），实现「三个视图的太阳都是真实贴图」。 */
  const SUN_SCENE_DIST = 15;                       // 自转视图里太阳盘的摆放距离（场景单位）
  const sunDiskR = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 32), sunMat);
  sunDiskR.scale.setScalar(1.0 / 0.62);            // 目视半径约 1.0（与公转视图太阳观感一致）
  sunDiskR.visible = false;
  scene.add(sunDiskR);
  /* 根据 state.sun.tex 切换太阳材质（真实贴图 ↔ 原色纯黄）。脚本开头与复原存档后各调用一次。 */
  function applySunTex() {
    const on = !(state.sun && state.sun.tex === false);
    sunMat.map = on ? sunTexMap : null;
    sunMat.color.set(on ? 0xffffff : 0xffd23f);
    sunMat.needsUpdate = true;
  }
  let sunHalo = null;   // v23.17：太阳光晕（Sprite）——「地球特写」时相机贴近太阳，需隐藏它
  (function () {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    /* v37（需求一·2）：弱化太阳光晕 —— 整体亮度减淡、内核更柔和、Sprite 半径 2.4 → 1.5，
       让光晕只作为太阳贴图的柔和衬底，不再糊成一大团亮斑。 */
    const rad = g.createRadialGradient(64, 64, 14, 64, 64, 64);
    rad.addColorStop(0, 'rgba(255,228,150,0.62)'); rad.addColorStop(0.35, 'rgba(255,196,80,0.26)'); rad.addColorStop(1, 'rgba(255,180,60,0)');
    g.fillStyle = rad; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(1.5, 1.5, 1); sunMesh.add(halo);
    sunHalo = halo;
  })();
  /* ===== v28（需求①）：公转轨道 —— 由「正圆」改为**真实椭圆**（太阳位于一个焦点） =====
     轨道线几何由极坐标圆锥曲线 r = a(1−e²)/(1 + e·cos ν) 逐点采样得到，与地球位置函数
     orbState() 同源 —— 故「地球球心必定严格落在轨道线上」，不会出现地球脱离轨道的观感。
     椭圆在场景里的朝向跟着近日点黄经走（近日点方向 = 黄经 ϖ），故轨道线也会随世纪缓慢进动。 */
  let orbRNow = ORB_R;       // 半长轴 a（场景单位）= ORB_R × 日地距离比例
  let orbRFar = ORB_R;       // 远日点距离 a(1+e) —— 相机取景按它留白，保证整条轨道都在画面内
  let orbPeriLonNow = orbPeriLonDeg(0) * D;   // 当前近日点黄经（rad）
  let orbEccNow = ORB_ECC0;  // 当前离心率（随儒略世纪缓慢减小）
  /* v28（需求①）一致性：离心率 e 与近日点黄经 ϖ 都是**随时间缓慢变化**的量
     （e 每世纪 −0.000042、ϖ 每世纪 +1.72°）。若「轨道线 / 节气标记 / 焦点标记 / 地球位置 /
     速度扇形」各自取不同时刻的 T，彼此就会相差万分之一量级 —— 肉眼看不出来，但
     「地球球心严格落在轨道线上」这条几何不变量不再成立（探针实测偏差 ~2.5e-6）。
     解决办法是把这组量收成一个唯一入口 syncOrbShape()：**每帧刷新一次**，同一帧内
     所有要素一律用同一组 (a, e, ϖ)，差值严格为 0（探针验证到 1e-12 以下）。 */
  let orbA0 = ORB_R;         // 当前半长轴 a（场景单位，随「日地距离」比例变化）
  function syncOrbShape(a, T) {
    if (a !== undefined && a !== null) orbA0 = a;
    orbRNow = orbA0;
    // v29（需求⑦）：离心率改由「天体与轨道 › 轨道离心率」滑块控制（默认取地球真实离心率），
    //   不再随时间缓慢变化 —— 用户可随时调圆或调回真实值。近日点黄经仍随时间缓慢进动。
    orbEccNow = (state.orb && typeof state.orb.ecc === 'number') ? state.orb.ecc : ORB_ECC0;
    orbPeriLonNow = orbPeriLonDeg(T || 0) * D;
    orbRFar = orbA0 * (1 + orbEccNow);          // 远日点距离 a(1+e)
  }
  /* 与 syncOrbShape 同源的真近点角 / 半径换算 —— 不再各自依赖某个 T，
     凡要用到「当前轨道形状」的地方都走它（地球位置 / 扇形 / 近日点）。 */
  function orbStateNow(lam) {
    const e = orbEccNow;
    const nu = lam + Math.PI - orbPeriLonNow;
    return { rk: (1 - e * e) / (1 + e * Math.cos(nu)), nu: nu, e: e, lamHelio: lam + Math.PI };
  }
  /* 焦点可视化随 e / ϖ 每帧同步（几何中心 = 自焦点沿「远日点方向」外移 a·e） */
  function syncOrbFocus() {
    if (!orbCenterMark) return;
    const aC = orbPeriLonNow + Math.PI - Math.PI / 2;
    const dc = orbRNow * orbEccNow;
    orbCenterMark.position.set(Math.cos(aC) * dc, 0, -Math.sin(aC) * dc);
    orbCenterMark.scale.setScalar(Math.max(0.8, orbRNow * 0.35));
    const lp = orbFocusLine.geometry.attributes.position;
    lp.setXYZ(0, 0, 0, 0);
    lp.setXYZ(1, orbCenterMark.position.x, orbCenterMark.position.y, orbCenterMark.position.z);
    lp.needsUpdate = true;
    orbFocusLine.geometry.computeBoundingSphere();
    if (orbFocusLine.computeLineDistances) orbFocusLine.computeLineDistances();
  }
  /* v28（需求①④）：本帧的真实轨道运动学量 —— updateOrbit 每帧写入，面板与速度读数直接取用。
       rk（= r/a，无量纲）、nu（真近点角 rad）、e（离心率）、rScene（场景半径）、rAU（天文单位）、
       vKmS（瞬时线速度 km/s）、omegaDegDay（瞬时角速度 °/日）。 */
  const orbKin = { rk: 1, nu: 0, e: ORB_ECC0, rScene: ORB_R, rAU: 1, vKmS: 29.785, omegaDegDay: 0.9856 };
  /* 近日点 / 远日点位置（场景坐标）与到达时刻 —— 「公转速度」标注与等面积演示共用。
     ν = 0 为近日点、ν = π 为远日点；位置换算与 orbitPathPoints 完全一致。 */
  function orbitApsisPoint(nu, a, e, periLon, out) {
    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const al = nu + periLon - Math.PI / 2;
    return (out || new THREE.Vector3()).set(Math.cos(al) * r, 0, -Math.sin(al) * r);
  }
  /* 求「太阳视黄经 = lamDeg」的时刻（ms）—— 轨道上的任意点都能换算成日期。 */
  function msAtLam(lamDeg) { return solveLamMs(displayYear, mod360(lamDeg)); }
  /* 近日点 / 远日点的太阳视黄经（度）：ν = 0 → λ_E = ϖ → λ_sun = ϖ + 180°；远日点再加 180°。 */
  function apsisLamDeg(which, T) {
    const peri = orbPeriLonDeg(T || 0);
    return mod360(peri + 180 + (which === 'aph' ? 180 : 0));
  }
  /* 给定半长轴 a、离心率 e、近日点黄经（rad），返回轨道椭圆的闭合采样点（场景 XZ 平面）。
     与 updateOrbit 的换算严格一致：α = λ_E − π/2 = ν + ϖ − π/2，半径 r = a·rk(ν)。 */
  function orbitPathPoints(a, e, periLon, N) {
    const pts = [], n = N || 512;
    for (let i = 0; i < n; i++) {
      const nu = (i / n) * TWO_PI;
      const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
      const al = nu + periLon - Math.PI / 2;
      pts.push(new THREE.Vector3(Math.cos(al) * r, 0, -Math.sin(al) * r));
    }
    return pts;
  }
  // 公转轨道椭圆环（圆管网格沿椭圆生成，粗细可调）
  const orbitRing = new THREE.Mesh(
    new THREE.BufferGeometry(),
    tubeMat('#FFD23F', 0.85));
  orbitScene.add(orbitRing);
  /* 太阳位于椭圆焦点的可视化辅助：椭圆几何中心（= 焦点沿「远日点方向」偏移 a·e 处）
     与一条「焦点 → 几何中心」的虚线。真实离心率下偏移量只有 a 的 1.67%，肉眼几乎看不出，
     这两样东西让「太阳在焦点上、不在中心」变成可读的几何事实。 */
  const orbCenterMark = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x8FA6C4, transparent: true, opacity: 0.9 }));
  orbitScene.add(orbCenterMark);
  const orbFocusLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: 0x8FA6C4, transparent: true, opacity: 0.55, dashSize: 0.09, gapSize: 0.07 }));
  orbitScene.add(orbFocusLine);
  const _orbTarget = new THREE.Vector3(0, 0, 0);   // 公转相机注视点（太阳位于原点）
  // 轨道装饰（轨道环 / 二分二至标记 / 二十四节气标记 / 轨道标签）随日地距离 / 日心重排，
  // 保证调整"日地距离"时地球球心始终落在公转轨道上。
  function layoutOrbitDecor(a, e, periLon) {
    const ee = (e === undefined) ? ORB_ECC0 : e;
    const pl = (periLon === undefined) ? 0 : periLon;
    const place = function (c) {
      const nu = c.userData.nu; if (nu === undefined) return;
      const r = a * (1 - ee * ee) / (1 + ee * Math.cos(nu));
      const al = nu + pl - Math.PI / 2;
      const rr = r + (c.userData.rrOff || 0);
      c.position.set(Math.cos(al) * rr, c.userData.yoff || 0, -Math.sin(al) * rr);
    };
    orbitTerms.children.forEach(place);
    orbitTerms24.children.forEach(place);
    nOrbit.position.set(0, 0, a + 0.4);
  }
  // 二分二至位置标记（固定在轨道上，位置由该节气的太阳黄经反解）
  // depthTestOn：是否开启深度测试。公转注释 / 节气标签等悬浮文字需要"永远可见"，
  // 默认关闭（原行为）；点标注注释固定在地表，必须开启 —— 否则转到地球背面的
  // 标注会隔着球体透出来（用户截图问题①）。
  // cw：贴图画布宽度（默认 256）。长文本（如「东西十二区 UTC+12」）需传更大值，否则会被画布裁掉。
  // 用法：makeTextSprite(文字, 宽, 深度测试, 分类, 实例key, 画布宽)
  // 字色 / 字号 / 字重 / 对齐一律来自「全局文字注释」模块（noteStyleFor），组件内不再硬编码。
  function makeTextSprite(txt, w, depthTestOn, cat, key, cw) {
    /* v25.1（需求⑧）：文字改为「可改写」。球面最短距离的距离标注要随测量结果换字，
       而精灵的样式绑定 / DPI / 世界尺寸都建立在创建那一刻 —— 重建精灵既昂贵又会丢配置。
       于是把文本放进一个可变盒子（box.txt），draw 每次都从盒子里取当前文字；
       对外暴露 setText()：换字后只需把 dpi 置 0 触发一次重绘（见 spriteDPI）。
       行数变化时会同步更新画布高 ch 与基准高 baseH，保证竖向居中与缩放比仍然正确。 */
    const box = { txt: String(txt) };
    const lineH = 38, gap = 6, pad = 6;   // v17.0：多行标签行距收紧（10 → 6），两行标签更紧凑美观
    const CW = cw || 256;
    const nLinesOf = function () { return String(box.txt).split('\n').length; };
    const chOf = function () { return Math.max(Math.round(CW / 4), nLinesOf() * (lineH + gap) + pad * 2); };
    const draw = function (g, k) {
      const lines = String(box.txt).split('\n');
      const CH = chOf();
      const st = noteStyleFor(cat, key);                       // 字重 / 对齐 / 字体均取自样式模块
      g.font = st.weight + ' ' + (lineH * k) + 'px ' + noteFontOf(cat, key);
      g.textAlign = st.align; g.textBaseline = 'middle';
      const px = st.align === 'left' ? pad * k : (st.align === 'right' ? CW * k - pad * k : CW / 2 * k);
      const totalH = lines.length * (lineH + gap) * k;
      const startY = (CH * k - totalH) / 2 + (lineH + gap) * k / 2;
      g.fillStyle = '#FFFFFF';                                 // v22.1：贴图一律白字，颜色全由 material.color 染色
      /* v23.11：贴图完整性保险 —— 文本宽度超出画布可用宽度时按比例收字号（只缩不放），
         保证「每个标签都完整渲染」：长文本（如「东西十二区 UTC+12」）不会再被画布左右裁断，
         而已适配的标签（宽度未超）完全不受影响，字体大小与原先一致。 */
      const avail = (CW - pad * 2) * k;
      let widest = 0;
      lines.forEach(function (ln) { widest = Math.max(widest, g.measureText(ln).width); });
      if (widest > avail && widest > 0) {
        g.font = st.weight + ' ' + (lineH * k * (avail / widest)) + 'px ' + noteFontOf(cat, key);
      }
      // v17.0：文字一律不描边 —— 仅实心填充，边缘干净（原黑边描边已移除）
      lines.forEach(function (ln, i) {
        g.fillText(ln, px, startY + i * (lineH + gap) * k);
      });
    };
    const CH = chOf();
    const c = document.createElement('canvas'); c.width = CW; c.height = CH;
    draw(c.getContext('2d'), 1);
    const tex = new THREE.CanvasTexture(c); if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace; else tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !!depthTestOn }));
    const s3 = registerSprite(sp, w || 0.95, (w || 0.95) * (CH / CW), draw, CW, CH);
    s3.userData.cat = cat || 'misc';
    s3.userData.key = key || (cat || 'misc') + ':' + txt;      // 实例标识：同内容的每一处互不干扰
    s3.userData.noteText = box.txt;
    // v25.1（需求⑧）：改写文字（不重建精灵）；行数变化时一并更新画布高 / 基准高并强制重绘
    s3.userData.setText = function (t) {
      const s = String(t);
      if (s === box.txt) return;
      const n0 = nLinesOf();
      box.txt = s;
      if (nLinesOf() !== n0) {
        const ch = chOf();
        s3.userData.ch = ch;
        s3.userData.baseH = (w || 0.95) * (ch / CW);
        s3.userData.dpi = 0;                 // 画布尺寸变了 → 必须重绘
      }
      s3.userData.noteText = s;
    };
    return s3;
  }
  const orbitTerms = new THREE.Group(); orbitScene.add(orbitTerms);
  // v20.0：所有二十四节气文字标注统一使用同一外偏移与同一高度（位置整齐一致）
  const TERM_LABEL_R = 0.46, TERM_LABEL_Y = 0.20;
  const termDotMatMain = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 1 });
  /* v29（需求⑥）：二分二至近似日期（与教材一致），仅用于标注「另起一行」显示，不逐帧刷新。
     置于 buildOrbitTerms 之前，保证初始化首次调用 refreshTermLabels 时已就绪。 */
  var TERM_DATE_APPROX = { VE: '3月21日前后', SS: '6月22日前后', AE: '9月23日前后', WS: '12月22日前后' };
  /* v28（需求①）：节气标记挂在**椭圆**轨道上 —— 存「真近点角 ν」而不是旧的角度 th，
     由 layoutOrbitDecor() 按当前 a / e / 近日点黄经反算位置（地球走到该节气时与之重合）。 */
  (function buildOrbitTerms() {
    TERM_ORDER.forEach(function (k) {
      const si = solarInfo(terms[k]);
      const st = orbState(si.lam, si.T);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), termDotMatMain);
      // 与 updateOrbit 完全一致的换算（逆时针方向）；记录 ν 以便轨道半径 / 日地距离变化时重排
      dot.userData.nu = st.nu; dot.userData.yoff = 0; dot.userData.rrOff = 0;
      orbitTerms.add(dot);
      // v20.0：全部节气文字统一放在「轨道外侧同一圈 + 同一高度」——位置整齐一致
      const sp = makeTextSprite(TERM_NAME[k], 0.72, true, 'terms', 'terms.' + k);
      sp.userData.nu = st.nu; sp.userData.yoff = TERM_LABEL_Y; sp.userData.rrOff = TERM_LABEL_R;
      sp.userData.termKey = k;        // v29（需求⑥）：供 refreshTermLabels 改写（含日期）
      orbitTerms.add(sp);
    });
    refreshTermLabels();             // v29（需求⑥）：按默认开关初始化「名称 / 日期」文本
  })();
  /* v29（需求⑥）：二分二至标注 = 名称 +（可选）日期，日期另起一行显隐。
     日期为近似常数字符串（与教材一致），仅在开关切换时改写，不逐帧刷新。 */
  function refreshTermLabels() {
    orbitTerms.children.forEach(function (c) {
      if (!c.userData || !c.userData.termKey) return;
      const k = c.userData.termKey;
      const date = state.orb.terms.date ? ('\n' + (TERM_DATE_APPROX[k] || '')) : '';
      c.userData.setText(TERM_NAME[k] + date);
    });
  }
  // 其余二十个节气（清明/谷雨…）：标记更小、文字更淡，默认隐藏
  const orbitTerms24 = new THREE.Group(); orbitScene.add(orbitTerms24);
  const termDotMat24 = new THREE.MeshBasicMaterial({ color: 0xa9c489, transparent: true, opacity: 0.9 });
  (function buildOrbitTerms24() {
    solarTerms24(displayYear).forEach(function (t, i) {
      if (i % 6 === 0) return;                  // 春分/夏至/秋分/冬至由 orbitTerms 绘制
      const si = solarInfo(t.ms);
      const st = orbState(t.lam * D, si.T);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), termDotMat24);
      dot.userData.nu = st.nu; dot.userData.yoff = 0; dot.userData.rrOff = 0;
      orbitTerms24.add(dot);
      // v20.0：与二分二至标注统一到同一圈、同一高度（24 个节气间隔 15°，0.46 的外偏移已足够
      //        容纳文字而不会相互重叠），不再内外交错 —— 位置整齐一致。
      const sp = makeTextSprite(t.name, 0.46, true, 'terms24', 'terms24.' + i);
      sp.userData.nu = st.nu; sp.userData.yoff = TERM_LABEL_Y; sp.userData.rrOff = TERM_LABEL_R;
      orbitTerms24.add(sp);
    });
  })();

  /* ==================== v28（需求③）：公转速度演示 ====================
     开普勒第二定律（等面积速率）的可视化 + 数值化：
       · 近日点 / 远日点位置标记与标注（距离 + 到达日期）；
       · 「单位时间扫过的面积」—— 同一个时间步长 Δt，在**当前位置 / 近日点 / 远日点**各画一个
         以太阳为顶点、以轨道弧为曲边的扇形。三者面积严格相等（这正是等面积速率），
         而扇形张角与弧长明显不同 —— 「近日点快、远日点慢」由此一眼可见；
       · 每个扇形的标签直接写出它的面积，便于对照验证「三个数字一样」。
     扇形几何与轨道线、地球位置三者**同源**（都取自圆锥曲线方程），故扇形曲边与轨道线
     严丝合缝，不会出现「扇形跑到轨道外面」的观感。 */
  const SPD_SEG = 30;                        // 扇形曲边的分段数（30 段已足够平滑）
  const spdGroup = new THREE.Group(); orbitScene.add(spdGroup);
  const spdFillMatCur = new THREE.MeshBasicMaterial({
    color: 0x5AA9FF, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
  });
  const spdFillMatRef = new THREE.MeshBasicMaterial({
    color: 0xFFB454, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
  });
  /* 扇形网格：顶点 0 = 太阳（焦点），顶点 1..N+1 = 沿轨道弧的采样点。
     容量固定、逐帧只改 position 数组（不做几何重建，避免每帧 GC）。 */
  function makeSpdWedge(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SPD_SEG + 2) * 3), 3));
    const idx = [];
    for (let i = 1; i <= SPD_SEG; i++) idx.push(0, i, i + 1);
    g.setIndex(idx);
    g.setDrawRange(0, idx.length);
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 12;            // 面要素层（2–13），压在地球白球之上、线要素（20+）之下
    m.frustumCulled = false;       // 顶点逐帧变化，包围球不更新 → 关掉视锥剔除以免误剔
    m.visible = false;
    spdGroup.add(m);
    return m;
  }
  const spdCur = makeSpdWedge(spdFillMatCur);
  const spdPeri = makeSpdWedge(spdFillMatRef);
  const spdAph = makeSpdWedge(spdFillMatRef);
  /* 扇形的两条半径边（太阳 → 起点、太阳 → 终点）—— 用一条 4 顶点的 LineSegments 画。
     容量固定（起点 + 终点），逐帧改 position。 */
  function makeSpdEdge(color, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const ln = new THREE.LineSegments(g, new THREE.LineDashedMaterial({
      color: color, transparent: true, opacity: opacity, dashSize: 0.09, gapSize: 0.07,
    }));
    ln.renderOrder = 23;           // 线要素层（20–26）
    ln.frustumCulled = false;
    ln.visible = false;
    spdGroup.add(ln);
    return ln;
  }
  const spdEdgeCur = makeSpdEdge(0x9CC9FF, 0.95);
  const spdEdgePeri = makeSpdEdge(0xFFB454, 0.95);
  const spdEdgeAph = makeSpdEdge(0xFFB454, 0.95);
  // 近日点 / 远日点位置标记点
  const apsisPeriDot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshBasicMaterial({ color: 0x7DD3FC, transparent: true, opacity: 1 }));
  const apsisAphDot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshBasicMaterial({ color: 0x7DD3FC, transparent: true, opacity: 1 }));
  spdGroup.add(apsisPeriDot); spdGroup.add(apsisAphDot);
  // v29（需求①）：取消三个扇形面积标注与面积速度标注（面积速度已移至时间面板）。
  //   仅保留近日点 / 远日点位置标注（名称 / 日期 / 日地距离 三部分，见 updateSpeedDemo）。
  const spdNotePeri = makeTextSprite('近日点', 0.80, true, 'spd', 'spd.peri');
  const spdNoteAph = makeTextSprite('远日点', 0.80, true, 'spd', 'spd.aph');
  [spdNotePeri, spdNoteAph].forEach(function (s) { spdGroup.add(s); });
  spdGroup.visible = false;
  /* 由「太阳视黄经 lam」求真近点角 ν（与 orbState 同源，保证扇形与地球位置一致）。 */
  // ★用 orbStateNow（而不是带 T 的 orbState）—— 保证扇形 / 近日点与**
  //   当天当前的轨道形状**同源，三者严格重合于同一条椭圆上。
  function nuAtMs(ms) { const si = solarInfo(ms); return orbStateNow(si.lam).nu; }
  /* 从 ms0 起、向前 Δt 扫过的真近点角区间（自动处理 ±π 分支切割）。 */
  function nuForward(ms0, dtMs) {
    const a0 = nuAtMs(ms0);
    let d = nuAtMs(ms0 + dtMs) - a0;
    while (d < 0) d += TWO_PI;                 // 时间前进 → ν 单调增
    while (d >= TWO_PI) d -= TWO_PI;
    return { nu0: a0, nu1: a0 + d, dnu: d };
  }
  /* 面积速度 dA/dt（开普勒第二定律：恒定不变）= h/2，单位 km²/日。 */
  function orbArealRateKm2Day(e) {
    const ee = (e === undefined) ? ORB_ECC0 : e;
    const h = Math.sqrt(GM_SUN * AU_M) * Math.sqrt(1 - ee * ee);   // m²/s
    return h / 2 * 86400 / 1e6;                                    // → km²/日
  }
  /* 一个扇形的几何 + 数值。返回 { areaA2（以 a² 计的面积） }。
     mesh 的顶点按 a 缩放到场景单位；两条半径边写入 edge（LineSegments）。 */
  function setWedgeGeo(mesh, edge, nu0, nu1, a, e, periLon) {
    const pos = mesh.geometry.attributes.position.array;
    const N = SPD_SEG, h = (nu1 - nu0) / N;
    pos[0] = 0; pos[1] = 0; pos[2] = 0;                        // 顶点 = 太阳（椭圆焦点）
    let areaA2 = 0;
    const rkAt = function (nu) { return (1 - e * e) / (1 + e * Math.cos(nu)); };
    let rk0 = rkAt(nu0);
    for (let i = 0; i <= N; i++) {
      const nu = nu0 + h * i;
      const rk = rkAt(nu);
      const r = a * rk;
      const al = nu + periLon - Math.PI / 2;
      pos[(i + 1) * 3] = Math.cos(al) * r;
      pos[(i + 1) * 3 + 1] = 0;
      pos[(i + 1) * 3 + 2] = -Math.sin(al) * r;
      if (i > 0) areaA2 += (rk0 * rk0 + rk * rk) / 4 * h;      // ∫(1/2)r²dν 的梯形积分
      rk0 = rk;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    if (edge) {
      const ep = edge.geometry.attributes.position.array;
      const p0 = [pos[3], 0, pos[5]];                          // i = 0 → 顶点 1
      const pN = [pos[(N + 1) * 3], 0, pos[(N + 1) * 3 + 2]];
      ep[0] = 0; ep[1] = 0; ep[2] = 0; ep[3] = p0[0]; ep[4] = 0; ep[5] = p0[2];
      ep[0] = 0; ep[1] = 0; ep[2] = 0;
      ep[3] = pN[0]; ep[4] = 0; ep[5] = pN[2];
      edge.geometry.attributes.position.needsUpdate = true;
      edge.geometry.computeBoundingSphere();
      if (edge.computeLineDistances) edge.computeLineDistances();
    }
    return areaA2;
  }
  const _spdP0 = new THREE.Vector3(), _spdP1 = new THREE.Vector3();
  let _spdSig = '';
  /* v29（需求①）：原先这里的「扇形面积文字标注」链条（wedgeLabelPos / spdAreaText /
     spdRateText / SPD_UNIT / AU2_IN_KM2）已随「取消两者对应的文字注释 + 去掉面积单位」
     一并删除 —— 面积速度改在时间面板以固定 km²/日 读数显示（见 updateUI 的 fOrbArea）。 */
  /* 公转速度演示：每帧更新（扇形几何 + 位置标记 + 标注文本）。
     挂在 updateOrbit 末尾 —— 它需要本帧的 orbKin / orbRNow / 近日点黄经。 */
  function updateSpeedDemo() {
    const sd = state.spd;
    if (!sd.on) return;
    const a = orbRNow, e = orbEccNow, peri = orbPeriLonNow;
    const dtMs = Math.max(0.05, +sd.dt || 10) * 86400000;
    const T = (currentInfo || solarInfo(simMs)).T || 0;
    const tPeri = msAtLam(apsisLamDeg('peri', T));
    const tAph = msAtLam(apsisLamDeg('aph', T));
    const arcPeri = nuForward(tPeri, dtMs);
    const arcAph = nuForward(tAph, dtMs);
    const arcCur = nuForward(simMs, dtMs);
    // ① 扇形几何（三块：当前时刻 / 近日点 / 远日点），面积以 a² 为单位返回
    const areaCur = setWedgeGeo(spdCur, spdEdgeCur, arcCur.nu0, arcCur.nu1, a, e, peri);
    const areaPeri = sd.ref ? setWedgeGeo(spdPeri, spdEdgePeri, arcPeri.nu0, arcPeri.nu1, a, e, peri) : 0;
    const areaAph = sd.ref ? setWedgeGeo(spdAph, spdEdgeAph, arcAph.nu0, arcAph.nu1, a, e, peri) : 0;
    // ② 近日点 / 远日点位置标记
    orbitApsisPoint(0, a, e, peri, _spdP0);
    orbitApsisPoint(Math.PI, a, e, peri, _spdP1);
    apsisPeriDot.position.copy(_spdP0);
    apsisAphDot.position.copy(_spdP1);
    const dPeri = a * (1 - e), dAph = a * (1 + e);              // 场景距离（相对半长轴）
    /* v29（需求⑤）修正：AU_M 的单位是**米**（1.495978707e11），而「亿 km」= 1e8 km = 1e11 m，
       故换算系数应为 / 1e11（v28 误写成 / 1e8，导致读数放大 1000 倍，显示 1470.98 亿 km）。 */
    const PERI_KM = 0.9832914 * AU_M / 1e11, APH_KM = 1.0167086 * AU_M / 1e11;  // 亿 km（常数）
    const fy = function (ms) { const p = localParts(ms); return p.mo + '月' + p.day + '日'; };
    /* v29（需求⑤）：近日点 / 远日点位置标注 = 名称（默认显示）+ 日期 + 日地距离，
       日期与日地距离可选择性另起一行显隐。只在会改变文本的量变化时重写（避免每帧拼串）。 */
    const sig = (sd.apsisName ? 1 : 0) + '|' + (sd.apsisDate ? 1 : 0) + '|' + (sd.apsisDist ? 1 : 0) + '|' + displayYear;
    if (sig !== _spdSig) {
      _spdSig = sig;
      const periTxt = '近日点'
        + (sd.apsisDate ? '\n' + fy(tPeri) : '')
        + (sd.apsisDist ? '\n' + PERI_KM.toFixed(4) + ' 亿 km' : '');
      const aphTxt = '远日点'
        + (sd.apsisDate ? '\n' + fy(tAph) : '')
        + (sd.apsisDist ? '\n' + APH_KM.toFixed(4) + ' 亿 km' : '');
      spdNotePeri.userData.setText(periTxt);
      spdNoteAph.userData.setText(aphTxt);
    }
    /* ④ 标注摆位：近日点 / 远日点沿半径再外移 8%（落在轨道外侧） */
    spdNotePeri.position.copy(_spdP0).multiplyScalar(1.085); spdNotePeri.position.y = 0.30;
    spdNoteAph.position.copy(_spdP1).multiplyScalar(1.085); spdNoteAph.position.y = 0.30;
    // ⑤ 显隐（样式在 applySpeedDemo；此处只处理与每帧状态相关的部分）
    //   门控口径与 spriteNoteGate 的 'spd' 分支完全一致：spd.on ∩ 位置标注分类开关
    //   (note.cats.spd.on) ∩ 显示位置标记(spd.apsis) ∩ 至少勾选了名称 / 日期 / 距离 之一。
    const apsisShow = spriteNoteGate(spdNotePeri) && spriteNoteGate(spdNoteAph);
    spdNotePeri.visible = apsisShow;
    spdNoteAph.visible = apsisShow;
    // 扇形 / 边界线显隐（受总开关 spd.area 与各自子开关控制；v29 需求①）
    spdCur.visible = !!sd.area && !!sd.cur; spdEdgeCur.visible = !!sd.area && !!sd.cur;
    spdPeri.visible = spdAph.visible = !!sd.area && !!sd.ref;
    spdEdgePeri.visible = spdEdgeAph.visible = !!sd.area && !!sd.ref;
  }
  /* 公转速度演示：样式应用（applyAll 调用；一次性，不随每帧走）。 */
  function applySpeedDemo() {
    const sd = state.spd;
    spdGroup.visible = !!sd.on;
    if (!sd.on) return;
    const FC = state.style.fill.spd, LC = state.style.ln.spd, PT = state.style.pt.apsis;
    spdFillMatCur.color.set(FC.fill); spdFillMatCur.opacity = FC.op;
    spdFillMatRef.color.set(FC.refFill); spdFillMatRef.opacity = FC.refOp;
    const period = (2 * Math.max(orbRNow, 0.2)) / Math.max(LC.n || 40, 1);
    const ds = period * clamp(LC.ratio, 0.05, 0.95);
    const solid = (LC.dash === 'solid');
    [spdEdgeCur, spdEdgePeri, spdEdgeAph].forEach(function (ln) {
      const mt = ln.material;
      mt.color.set(LC.color); mt.opacity = LC.op;
      mt.dashSize = solid ? 1e6 : ds;
      mt.gapSize = solid ? 0 : Math.max(period - ds, 1e-4);
      ln.computeLineDistances();
    });
    const ac = state.style.pt.apsis.color;
    apsisPeriDot.material.color.set(ac); apsisPeriDot.material.opacity = PT.op;
    apsisAphDot.material.color.set(ac); apsisAphDot.material.opacity = PT.op;
    // v29（需求⑤）：点大小改为「倍率」，默认 1.0 → 半径 0.055，与二分二至标记完全一致
    //   （旧写法按 orbRNow 放大导致近日点 / 远日点远大于二分二至点，且滑块默认值越界失效）。
    apsisPeriDot.scale.setScalar(PT.size);
    apsisAphDot.scale.setScalar(PT.size);
    _spdSig = '';                       // 强制下一帧重写标注文本（开关可能已变）
  }
  // 文字注释（跟随地球）
  // 球带几何（温度带 / 五带填充，自转与公转共享）
  function sphereBandGeom(latA, latB, radius) {
    const g = new THREE.BufferGeometry(); const pos = [], idx = []; const sa = 24, sb = 96;
    for (let i = 0; i <= sa; i++) { const lat = latA + (latB - latA) * i / sa; const r = Math.cos(lat) * radius, y = Math.sin(lat) * radius;
      for (let j = 0; j <= sb; j++) { const lon = TWO_PI * j / sb; pos.push(r * Math.cos(lon), y, r * Math.sin(lon)); } }
    const cols = sb + 1;
    for (let i = 0; i < sa; i++) for (let j = 0; j < sb; j++) { const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  // 太阳直射光线：中间一条主线 + 平行光场（v20.0 起与自转视图共用箭杆 / 箭头几何与材质）
  const orbRayGroup = new THREE.Group(); orbitScene.add(orbRayGroup);     // 中间那条（含箭头）
  const orbRayField = new THREE.Group(); orbitScene.add(orbRayField);     // 外围平行光场
  const orbRayHeadMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95, depthWrite: false });
  const orbRayHead = new THREE.Mesh(RAY_UNIT_HEAD, orbRayHeadMat);
  orbRayGroup.add(orbRayHead);
  rayMats.push(orbRayHeadMat);
  const orbRayShaft = new THREE.Mesh(RAY_UNIT_SHAFT, pushShaftMat(shaftMatsO, rayShaftMat('#FFD873', 0.92), 1));
  orbRayGroup.add(orbRayShaft);
  /* v23.7：外围平行光场的每一条光线也各带一个箭头。
     位置由 updateOrbit 统一写到与「中间那条」相同的「光程站位」上（见那里的注释），
     于是全部箭头对齐在垂直于光线的同一个平面内；尺寸与中间箭头完全一致，
     透明度沿用光场箭杆的压暗倍率（0.45），观感与各自的箭杆匹配。 */
  const orbRayFieldHeadMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95, depthWrite: false });
  rayMats.push(orbRayFieldHeadMat);
  /* v33（需求四）：公转 / 综合视图的外围光线与自转视图**完全统一** ——
     同样是「按纬度纵向分布」、条数同样由 state.rayVert.n 决定、纬度表同样用 rayVertLats()、
     纵向同样取「地轴在垂直光线方向上的投影」（即南北方向）。
     旧的固定 7 条横向平移平行光场（offset = i × 0.42，与纬度无关）已整体移除。
     插槽一次建满 RAY_VMAX，运行时按纬度重排 / 显隐。 */
  const orbRayFieldShafts = [], orbRayFieldHeads = [];
  for (let i = 0; i < RAY_VMAX; i++) {
    const sh = new THREE.Mesh(RAY_UNIT_SHAFT, pushShaftMat(shaftMatsO, rayShaftMat('#FFD873', 0.92), 1, 0.45));
    orbRayField.add(sh); orbRayFieldShafts.push(sh);
    const hd = new THREE.Mesh(RAY_UNIT_HEAD, orbRayFieldHeadMat);
    orbRayField.add(hd); orbRayFieldHeads.push(hd);
  }
  // 文字注释
  const orbNotes = new THREE.Group(); orbitScene.add(orbNotes);
  function noteSprite(text, cat, key) {
    const sp = makeTextSprite(text, 0.95, true, cat, key); orbNotes.add(sp); return sp;
  }
  /* v21.0（需求⑦）：公转视角中的「太阳」「地球」文字注释已按要求删除 ——
     这两个天体在公转示意里位置与体量都很直观，名称标注反而遮挡轨道与节气标记。
     保留「公转轨道」名称标注，并把它独立成 orbit 分类（菜单「公转系统 › 天体与轨道 ›
     公转轨道注释」，显隐与字号 / 字体 / 颜色 / 透明度 / 字重都可单独调，需求⑥）。 */
  const nOrbit = noteSprite('公转轨道', 'orbit', 'O.orbit'); nOrbit.position.set(0, 0, ORB_R + 0.4);
  // v20.0：公转「直射光线」标注并入「太阳光线注释」分类（key = ray），
  //        这样「光照与太阳光线 › 注释」这一项在自转 / 公转两个视图都能正常生效。
  const nRay = noteSprite('直射光线', 'ray', 'O.ray.sun');
  nOrbit.material.depthTest = nRay.material.depthTest = true;   // v16.0：被地球遮挡

  /* ===== v20.0：极昼 / 极夜 文字注释 =====
     原先「极昼注释 / 极夜注释」两个菜单只有样式没有任何文字 → 永远显示不出来。
     现在补上真正的「极昼」「极夜」标注：贴在对应极点上方的球外（1.32 R，不压球面、不被地球遮挡），
     南北随赤纬正负自动交换（夏季北极极昼、冬季南极极昼），赤纬为 0 时随极区一起消失。 */
  const CAP_NOTE_R = 1.32;
  function mkCapNote(txt, cat, key, parent) {
    const sp = makeTextSprite(txt, 0.5, true, cat, key, 320);
    sp.renderOrder = 40; parent.add(sp); return sp;   // v23.12：极昼极夜注释与其他文字统一 40+
  }
  const pdLabel = mkCapNote('极昼', 'pd', 'R.pd', tilt);
  const pnLabel = mkCapNote('极夜', 'pn', 'R.pn', tilt);
  const pdLabelOrb = mkCapNote('极昼', 'pd', 'O.pd', tiltOrb);
  const pnLabelOrb = mkCapNote('极夜', 'pn', 'O.pn', tiltOrb);

  /* ===== v18.0：公转系统文字注释「屏幕尺寸恒定」补偿 =====
     公转相机距离与「日地距离」等比例后退（orbView.tDist = 8.4 × 比例），这是为了让
     拉大日地距离后地球仍留在画面内。副作用是：世界坐标里大小固定的文字注释，
     在距离拉大后会越看越小。这里按相机后退倍数把文字同比放大，
     使它在屏幕上的观感大小与基准距离（比例 = 1）完全一致 —— 调「日地距离」只有
     地球和轨道在变，文字注释大小保持不动。
     判定：精灵挂在公转场景（orbitScene）下即视为公转注释（含节气、天体、地表、时刻、
     时区、点标注等公转视图实例）；自转视图的注释放置在另一个场景，不受影响。 */
  const ORB_CAM_BASE = 9.0;                                             // 基准相机距离（比例 = 1 时）
  function orbCamTDist() { return clamp(ORB_CAM_BASE * (+state.orb.distScale || 1), 3.2, 60); }
  function orbAnnMul() { return orbCamTDist() / ORB_CAM_BASE; }         // 文字注释缩放补偿倍数
  function isOrbitSprite(sp) {
    if (sp.userData.orbFix !== undefined) return sp.userData.orbFix;    // 首次判定后缓存，避免每帧遍历父链
    let o = sp.parent, r = false;
    while (o) { if (o === orbitScene) { r = true; break; } o = o.parent; }
    sp.userData.orbFix = r; return r;
  }
  /* v23.17（需求①）：文字注释的世界尺寸统一由本函数写入，同时把「基准尺寸」记在
     sp.userData.baseScale 上 —— 地球特写（相机贴近）时按 orbNoteK 等比缩小，
     注释的屏幕观感大小保持恒定（见 applyOrbNoteK）。 */
  function setNoteScale(sp, sx, sy) {
    sp.scale.set(sx, sy, 1);
    if (!sp.userData.baseScale) sp.userData.baseScale = new THREE.Vector2();
    sp.userData.baseScale.set(sx, sy);
  }
  /* 地球特写（公转视图 · 相机贴地球）时，注释的世界尺寸按「相机距离 / 基准距离」等比缩小：
     相机越近缩得越多，屏幕上看着始终是同一号字，不会糊满整个地球。
     由 updateOrbCamClose() 每帧写入，earthNotesPass() 在渲染公转场景前应用。 */
  let orbNoteK = 1;
  function applyOrbNoteK() {
    const k = orbNoteK;
    textSprites.forEach(function (sp) {
      if (!isOrbitSprite(sp)) return;
      const b = sp.userData.baseScale; if (!b) return;
      sp.scale.set(b.x * k, b.y * k, 1);
    });
  }
  /* ★ v35（需求七）：自转视图「屏幕字号恒定」补偿 —— 与公转的 applyOrbNoteK 对称。
     文字精灵的世界尺寸固定，自转 / 综合各窗相机可滚轮推拉 ⇒ 拉远字变小、贴近糊满地球。
     这里按「该窗相机到地心的实际距离 / 基准距离 MAIN_BASE_D(4.35)」等比放大，
     使屏幕观感恒为默认机位下的字号；正交相机（北极 / 南极 / 直射点窗）投影与距离无关，
     直接跳过。 */
  /* ★ v41（需求二·3）：字号 = **屏幕上的显示占比**，与视角缩放完全无关。
     旧写法拿「相机到地心的距离」整帧乘同一个系数 k = cd / MAIN_BASE_D：同一帧里
     贴着晨昏线的注释和远在天顶的注释拿到同一个 k，俯视 / 侧视一换，屏幕字号仍在变。
     改为按**每条注释到相机的真实距离 d** 补偿 —— 世界尺寸 ∝ d 时，
     屏幕占比 = 世界尺寸 / (2·d·tan(fov/2)) 恒定；标称距离 d0 在首次调用时自校准。 */
  let _kTmpA = null, _spinKCd = -1;
  const _d0Reg = {};      /* ★ v41（需求二·3）：标称距离登记表（键 = 文本|分类） */
  function applySpinNoteK(cam) {
    if (!cam || cam.isOrthographicCamera) return;
    const cd = cam.position.length();
    if (Math.abs(cd - _spinKCd) < 0.2) return;      // 相机没动 ⇒ 不必再整表重算
    _spinKCd = cd;
    if (!_kTmpA) _kTmpA = new THREE.Vector3();
    textSprites.forEach(function (sp) {
      if (isOrbitSprite(sp)) return;
      const b = sp.userData.baseScale; if (!b) return;
      const u = sp.userData;
      _kTmpA.setFromMatrixPosition(sp.matrixWorld);
      const d = cam.position.distanceTo(_kTmpA);
      if (!isFinite(d) || d <= 1e-4) { sp.scale.set(b.x, b.y, 1); return; }
      /* ★ v41：标称距离跨精灵重建复用（换文本的精灵是新 userData，现采现用会漂移） */
      if (u._d0 == null) {
        const key = (u.text || '') + '|' + (u.cat || '');
        if (_d0Reg[key] != null) u._d0 = _d0Reg[key];
        else { u._d0 = Math.max(d, 1e-3); _d0Reg[key] = u._d0; }
      }
      const k = clamp(d / u._d0, 0.2, 3.2);
      if (Math.abs(k - 1) < 0.004) sp.scale.set(b.x, b.y, 1);
      else sp.scale.set(b.x * k, b.y * k, 1);
    });
  }

  /* ===== 地表注释（五带 / 特殊纬线 / 晨昏线）：自转与公转共用同一套定义与布局 =====
     每条注释紧贴它描述的要素：纬线名贴在对应纬线上、五带名贴在所属带的中心纬度、
     晨线 / 昏线贴在各自的昼夜分界经线上（相对太阳方向 ±90°）。整组注释随相机方位
     绕地轴缓慢调整经度，始终落在可见半球；背面部分由深度测试自动隐藏。
     spec：lat = 纬度（度）；az = 相对相机方位的经向偏移（度）；term = ±1 贴晨线 / 昏线。 */
  // 注：不再写 c（颜色）—— 字色统一由「全局文字注释」模块的分类/全局叠加色决定（v22.1 起贴图白字）
  // r：相对基准半径（1.06）的额外外推系数 —— 让标注落在「地理事物的上方 / 外围」：
  //    纬线 / 五带名贴在球面外侧一点点；晨线 / 昏线推到球体轮廓之外，不再压在球面上（穿模）。
  const SURF_SPEC = [
    // v23.13：赤道 / 热带标注从 lat 0 南移到 -3.2° —— 赤道带上还排着 24 个地方时标签
    //  （+2.7°N、每 15° 一个，随太阳走），标注放 lat 0 时只要正午/子夜经线转到视野中心
    //   就必然与「12时/0时」压字（探针 cu_5 实测）。-3.2° 恰在「地方时下沿(≈0.7°N)」与
    //   「时区第一排上沿(≈-6.4°S，v23.13 起双排在 -10/-17)」之间的空档：上沿 -0.9°S、
    //   下沿 -5.5°S，对上对下都有 ≥0.9° 静态间距 —— 无论经线转到哪里都不会再压字。
    //   标注仍紧贴赤道线下方（上沿距线不到 1°），归属一目了然。
    { k: 'eq', t: '赤道', cat: 'lat', lat: -3.2, az: 0, r: 1.06 },
    { k: 'trN', t: '北回归线', cat: 'lat', lat: TROPIC_LAT, az: 0, r: 1.06 },
    { k: 'trS', t: '南回归线', cat: 'lat', lat: -TROPIC_LAT, az: 0, r: 1.06 },
    { k: 'arN', t: '北极圈', cat: 'lat', lat: POLAR_LAT, az: 0, r: 1.06 },
    { k: 'arS', t: '南极圈', cat: 'lat', lat: -POLAR_LAT, az: 0, r: 1.06 },
    { k: 'tropic', t: '热带', cat: 'zone', lat: -3.2, az: -34, r: 1.06 },
    { k: 'tempN', t: '北温带', cat: 'zone', lat: (TROPIC_LAT + POLAR_LAT) / 2, az: -34, r: 1.06 },
    { k: 'tempS', t: '南温带', cat: 'zone', lat: -(TROPIC_LAT + POLAR_LAT) / 2, az: -34, r: 1.06 },
    { k: 'coldN', t: '北寒带', cat: 'zone', lat: (90 + POLAR_LAT) / 2, az: -34, r: 1.06 },
    { k: 'coldS', t: '南寒带', cat: 'zone', lat: -(90 + POLAR_LAT) / 2, az: -34, r: 1.06 },
    { k: 'dawn', t: '晨线', cat: 'dawn', lat: 40, term: 1, r: 1.28 },
    { k: 'dusk', t: '昏线', cat: 'dusk', lat: -40, term: -1, r: 1.28 },
  ];
  // sceneTag：自转视图 'R' / 公转视图 'O'。同一条注释在两个场景各有一份实例，
  // 因此「每处相同内容的注释」可以分别控制（见「全局文字注释 › 分类样式 › 本分类注释实例」）。
  function buildSurfaceNotes(parent, w, sceneTag) {
    const g = {};
    SURF_SPEC.forEach(function (s) {
      const sp = makeTextSprite(s.t, w, true, s.cat, sceneTag + '.' + s.k);   // 开启深度测试：随视角正确遮挡
      sp.renderOrder = 41;                                   // v23.12：温度带/特殊纬线 41（经纬度40<温度带41<时区42<地方时43）
      parent.add(sp); g[s.k] = sp;
    });
    return g;
  }
  const surfR = buildSurfaceNotes(scene, 0.34, 'R');          // 自转视图（地球半径 = 1）
  const surfO = buildSurfaceNotes(orbitScene, 0.5, 'O');      // 公转视图（地球 rig 按 ORB_E 缩放）
  const _snDir = new THREE.Vector3(), _snCam = new THREE.Vector3(), _snSun = new THREE.Vector3();
  const _snCtr = new THREE.Vector3(), _snM = new THREE.Matrix4();
  const _snCamL = new THREE.Vector3();

  /* ===== v20.0（需求⑦⑲）：防止文字注释与地球「穿模」 =====
     背景：地表注释原先统一贴在 1.06 R 处，只比地表多 6%，而一条注释精灵本身有宽高 ——
     靠近地球剪影的注释，靠里的一部分会落进地球的屏幕轮廓内；注释又开着 depthTest，
     于是被地球切掉一块，就是截图里的「穿模 / 被地球遮挡」。
     做法：在「地球半径 = 1」的局部坐标系里，以相机为原点建一组「视线轴 + 屏面径向」坐标，
        · 先用相机右 / 上方向算出注释四个角点，任一角点被球面挡住才算「穿模」；
        · 若四个角点都没被挡 → 不动（含「浮在地球正前方」的情形）；
        · 否则沿屏面径向把注释往外推，二分求最小推力，使四个角点刚好全部离开剪影。
     推力有上限：地球背面（远端）的注释本就该被遮住，不会被硬拽到边缘上。
     注释的宽高直接取 sprite 的 scale（几何体是 1×1 单位面），天然含字号与公转尺寸补偿。 */
  const _pgAxis = new THREE.Vector3(), _pgW = new THREE.Vector3(), _pgPerp = new THREE.Vector3();
  const _pgU = new THREE.Vector3(), _pgQ = new THREE.Vector3();
  const _pgBase = new THREE.Vector3(), _pgTest = new THREE.Vector3();
  const _pgR = new THREE.Vector3(), _pgUp = new THREE.Vector3();
  // 该点是否被「球心在原点、半径 1」的地球遮挡（相机在 camLocal）
  function globeOccludes(pt, camLocal) {
    _pgU.copy(pt).sub(camLocal);
    const L = _pgU.length(); if (L < 1e-6) return false;
    _pgU.divideScalar(L);
    const b = camLocal.dot(_pgU), cc = camLocal.lengthSq() - 1;
    const disc = b * b - cc;
    if (disc <= 0) return false;                            // 视线不与球相交 → 不被挡
    return L > (-b - Math.sqrt(disc)) + 1e-3;               // 超过近交点 → 被球面挡住
  }
  /* ===== v23.11：贴地文字注释的「置顶 + 背面剔除」统一机制 =====
     用户反馈：靠近地球边缘的注释（时区 / 地方时等）被球面切掉一角，出现「空洞 / 截断」；
     且要求「运转到地球背面要被地球遮挡，只有在正面才显示」。
     处理：
       ① 关闭深度测试 —— 注释永远绘制在所有地理要素（球面 / 经纬网 / 圆点 / 光线 / 云层 /
          五带填充）之上，不再被任何要素切出空洞；
       ② 关掉深度测试后，背面的注释不会再被球面「自然」遮住，于是改为逐帧用 globeOccludes
          判定：锚点落到球体背面（相机看不到的那半球）时把整条注释隐藏 ——
          「正面完整显示 / 背面被地球挡住」两全。
     localPos 为该注释锚点在「rig 局部系」中的位置（该系里地球是半径 1 的单位球），
     camLocal 为相机在同系中的位置。 */
  function applyNoteFrontCull(sp, localPos, camLocal) {
    sp.material.depthTest = false;
    sp.visible = sp.userData.noteGate !== false && !globeOccludes(localPos, camLocal);
    /* v23.12：赤道带四类注释（经纬度 / 温度带 / 时区 / 地方时）的「临边淡出」——
       任何纬度环投影到球体轮廓附近时都会向边缘收拢，而文字精灵尺寸不变，
       于是靠近轮廓的标签会互相压字（时区 ↔ 地方时 / 相邻时区）。对这四类按
       「朝向度」f = normalize(anchor)·normalize(camera)（单位球局部系，1=正对相机、
       0=轮廓）做透明度淡出：f ≥ 0.39 完全不透明，f ≤ 0.13 完全隐藏（v23.15 收紧 ——
       原 0.34/0.10 下轮廓附近标签仍以半透明态互相叠字，如相邻时区在轮廓处收拢相撞）——
       标签在到达轮廓前更早平滑退场，正面主视区不受任何影响。
       其余类别（地轴 N·S / 极昼极夜等高纬注释、点标注）不做淡出。 */
    if (LIMB_FADE_CATS[sp.userData.cat] && sp.userData.baseOp != null && camLocal.lengthSq() > 0.25) {
      const f = _pgU.copy(localPos).normalize().dot(_pgW.copy(camLocal).normalize());
      sp.material.opacity = sp.userData.baseOp * Math.max(0, Math.min(1, (f - 0.13) / 0.26));
    }
  }
  const LIMB_FADE_CATS = { lat: 1, zone: 1, tz: 1, hourMain: 1, hourRest: 1 };
  // 批量版：list 里每条注释都按其 rigRef 局部系做同样的置顶 + 背面剔除。
  //   用世界矩阵回转，不依赖中间层级的变换关系 —— 适用于地方时 / 地轴 / 极昼极夜等
  //   挂在 tilt / tiltOrb 之下、层级各异的注释。
  const _cnM = new THREE.Matrix4(), _cnP = new THREE.Vector3(), _cnC = new THREE.Vector3();
  function cullEarthNoteList(list, rigRef, cam) {
    if (!list || !list.length) return;
    rigRef.updateWorldMatrix(true, false);
    _cnM.copy(rigRef.matrixWorld).invert();
    _cnC.copy(cam.position).applyMatrix4(_cnM);
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      sp.updateWorldMatrix(true, false);
      _cnP.setFromMatrixPosition(sp.matrixWorld).applyMatrix4(_cnM);
      applyNoteFrontCull(sp, _cnP, _cnC);
    }
  }
  function noteCornerOccluded(center, camLocal, hx, hy) {
    if (hx < 1e-5 && hy < 1e-5) return globeOccludes(center, camLocal);
    return globeOccludes(_pgQ.copy(center).addScaledVector(_pgR, hx).addScaledVector(_pgUp, hy), camLocal)
      || globeOccludes(_pgQ.copy(center).addScaledVector(_pgR, hx).addScaledVector(_pgUp, -hy), camLocal)
      || globeOccludes(_pgQ.copy(center).addScaledVector(_pgR, -hx).addScaledVector(_pgUp, hy), camLocal)
      || globeOccludes(_pgQ.copy(center).addScaledVector(_pgR, -hx).addScaledVector(_pgUp, -hy), camLocal);
  }
  // 相机在局部系里的右 / 上方向（由相机世界矩阵取出，再转到局部系）
  function noteCamBasis(cam, toLocalM) {
    cam.updateWorldMatrix(true, false);
    const e = cam.matrixWorld.elements;
    _pgR.set(e[0], e[1], e[2]).transformDirection(toLocalM);
    _pgUp.set(e[4], e[5], e[6]).transformDirection(toLocalM);
  }
  function pushNoteClear(pos, camLocal, sx, sy) {
    const D = camLocal.length();
    if (!(D > 1.02)) return;
    /* v21.0（需求⑤）：注释的锚点已经落到地球背面（被球体本身挡住）时，一律不做位移 ——
       直接让地球把它遮住。原先会沿「屏面径向」把它往外推，结果是转到背面的注释
       不是被挡住、而是顺着地球轮廓飞出去（看起来像从球顶 / 球侧滑过），既漏了信息
       又很晃眼。这里用「锚点是否被球体遮挡」作判据，只对可见半球的边缘注释做推让。 */
    if (globeOccludes(pos, camLocal)) return;
    const hx = sx * 0.5, hy = sy * 0.5;
    _pgAxis.copy(camLocal).multiplyScalar(-1).divideScalar(D);            // 视线（相机 → 球心）
    _pgW.copy(pos).sub(camLocal);
    const a = _pgW.dot(_pgAxis);
    if (a <= 0.02) return;                                               // 跑到相机背后，不动
    _pgPerp.copy(_pgW).addScaledVector(_pgAxis, -a);                     // 屏面径向分量
    let p = _pgPerp.length();
    _pgPerp.multiplyScalar(p < 1e-4 ? 0 : 1 / p);
    if (p < 1e-4) _pgPerp.copy(_pgUp);                                   // 正对相机：任取一个屏面方向
    _pgBase.copy(camLocal).addScaledVector(_pgAxis, a);
    if (!noteCornerOccluded(_pgTest.copy(_pgBase).addScaledVector(_pgPerp, p), camLocal, hx, hy)) return;
    // v21.0：推力上限收窄到「半个注释尺寸 + 0.12」，刚好够把压在球体轮廓上的那一角让出去，
    //        不再允许被拽到远离原要素的位置（原先上限 0.9 R，视觉上「跑了」）。
    const hi0 = p + Math.min(0.5, Math.max(0.18, Math.max(hx, hy) * 1.1 + 0.12));
    if (noteCornerOccluded(_pgTest.copy(_pgBase).addScaledVector(_pgPerp, hi0), camLocal, hx, hy)) return;
    let lo = p, hi = hi0;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      if (noteCornerOccluded(_pgTest.copy(_pgBase).addScaledVector(_pgPerp, mid), camLocal, hx, hy)) lo = mid; else hi = mid;
    }
    pos.copy(_pgBase).addScaledVector(_pgPerp, hi);
  }

  // 统一布局：把 tilt 局部的「纬度 + 经度」方向换算到世界坐标（自动跟随倾斜 / rig 缩放 / 位置）
  function layoutSurfaceNotes(g, tiltRef, cam, sunWorld, radius) {
    tiltRef.updateWorldMatrix(true, false);
    const m = tiltRef.matrixWorld;
    _snM.copy(m).invert();
    _snCtr.setFromMatrixPosition(m);
    const camPos = cam.position;
    _snCam.copy(camPos).sub(_snCtr).transformDirection(_snM);   // 相机方向 → tilt 局部
    _snCamL.copy(camPos).applyMatrix4(_snM);                    // 相机位置 → tilt 局部（点；该系里地球半径 = 1）
    noteCamBasis(cam, _snM);                                    // 注释角点估算用的相机右 / 上方向
    const camAz = Math.atan2(_snCam.z, _snCam.x);
    _snSun.copy(sunWorld).transformDirection(_snM);
    const sunAz = Math.atan2(_snSun.z, _snSun.x);
    SURF_SPEC.forEach(function (s) {
      const sp = g[s.k]; if (!sp) return;
      const az = s.term ? sunAz + s.term * Math.PI / 2 : camAz + s.az * D;
      const lr = s.lat * D, cl = Math.cos(lr);
      const rr = radius * (s.r || 1);
      _snDir.set(cl * Math.cos(az), Math.sin(lr), cl * Math.sin(az)).multiplyScalar(rr);
      pushNoteClear(_snDir, _snCamL, sp.scale.x, sp.scale.y);         // v20.0 防穿模
      sp.position.copy(_snDir).applyMatrix4(m);
      applyNoteFrontCull(sp, _snDir, _snCamL);                        // v23.11：置顶 + 背面剔除
    });
  }
  /* ===== v20.0：经纬度文字注释 =====
     「经度（除了本初子午线）」「纬度（除了特殊纬线）」两项此前只有开关、没有任何文字。
     现在按经纬网当前间隔生成对应的数字标注：经线标「30°E / 120°W」、纬线标「30°N / 60°S」，
     特殊经纬线仍用汉字名称（赤道 / 北回归线 / …，见 SURF_SPEC），互不重复。
     位置：纬线名贴在该纬线「朝相机一侧」的外沿；经线名贴在赤道稍北的那条经线上；
     半径 1.10 R —— 在球面之上（不被地球遮挡），又不会离要素太远。 */
  const GRAT_NOTE_R = 1.10;
  function buildGratLabels(parent, w, tag) {
    const grp = new THREE.Group(); parent.add(grp);
    grp.userData.tag = tag; grp.userData.w = w; grp.userData.sprites = [];
    return grp;
  }
  const gratLabelR = buildGratLabels(scene, 0.30, 'R');
  const gratLabelO = buildGratLabels(orbitScene, 0.30, 'O');
  let _gratNoteSig = '';
  function rebuildGratLabels() {
    const merLons = gratMerLons(), parLats = gratParLats();   // v33：间隔多选后的角度并集
    [gratLabelR, gratLabelO].forEach(function (grp) {
      const tag = grp.userData.tag, W = grp.userData.w;
      grp.userData.sprites.forEach(function (sp) {
        grp.remove(sp);
        if (sp.material.map) sp.material.map.dispose();
        sp.material.dispose();
        const i = textSprites.indexOf(sp); if (i >= 0) textSprites.splice(i, 1);
      });
      const list = [];
      const add = function (txt, key, lon, lat, isLon) {
        const sp = makeTextSprite(txt, W, true, 'lat', tag + '.' + key, 256);
        sp.renderOrder = 40;                                 // v23.12：文字注释统一抬到 40+（点30/线20/面2~12 之上）
        if (isLon) sp.userData.gratLon = true; else sp.userData.gratLat = true;
        sp.userData.geoLon = lon; sp.userData.geoLat = lat;   // 供布局换算（地理经度，度）
        grp.add(sp); list.push(sp);
      };
      // 经线：0° 是本初子午线（另有汉字标注），跳过
      merLons.forEach(function (lon) {
        if (lon < 1e-6) return;                                // 0° 是本初子午线，另有汉字标注
        const deg = lon > 180 ? lon - 360 : lon;
        add(fmtLon(deg, 0), 'lon' + Math.round(lon), deg, 9, true);  // v23.12：纬度 9°（原 7°），与地方时(+2.7°)标签拉开间距
      });
      // 纬线：特殊纬线（赤道 / 回归线 / 极圈）另有汉字标注，跳过
      parLats.forEach(function (lat) {
        const special = Math.abs(lat) < 0.5 || Math.abs(Math.abs(lat) - TROPIC_LAT) < 0.5
          || Math.abs(Math.abs(lat) - POLAR_LAT) < 0.5;
        if (special) return;
        add(fmtLat(lat, 0), 'lat' + Math.round(lat), null, lat, false);
      });
      // 本初子午线（0° 经线）：特殊经线，单独控制；标注固定在 0° 经线上、随地球自转移动
      // （v23.3：从原「相对相机、不随自转」的地表注释改为 geo-fixed，使标签始终贴在 0° 经线并跟随地球旋转）
      const pmSp = makeTextSprite('本初子午线', W, true, 'lat', tag + '.pm', 256);
      pmSp.renderOrder = 40;                                 // v23.12：文字注释统一 40+
      pmSp.userData.gratPm = true;                       // 区别于普通经线数字：受「本初子午线」开关控制
      // v23.12：标注从赤道交点（0°）北移到 12°N —— 赤道交点处同时有地方时标签（+2.7°）与
      //   赤道/热带文字，三者在屏幕上互相压字（「10时」压「本初子午线」）；12°N 处与本初子午线
      //   经线仍严格对齐，且远离经度数字（9°N，最近在 ±30° 经线）与北回归线（23.5°N）。
      pmSp.userData.geoLon = 0; pmSp.userData.geoLat = 12; // 地理经度 0°（12°N 处），随地球自转
      grp.add(pmSp); list.push(pmSp);
      grp.userData.sprites = list;
    });
  }
  const _glCam = new THREE.Vector3(), _glDir = new THREE.Vector3(), _glM = new THREE.Matrix4();
  function layoutGratLabels(grp, spinRef, cam, radius) {
    if (!grp.userData.sprites.length) return;
    spinRef.updateWorldMatrix(true, false);
    const m = spinRef.matrixWorld;
    _glM.copy(m).invert();
    // 相机位置 → spin 局部系（该系里「地理东经 = -atan2(z, x)」，与地球贴图约定一致，地球半径 = 1）
    _glCam.copy(cam.position).applyMatrix4(_glM);
    noteCamBasis(cam, _glM);
    const camAz = Math.atan2(_glCam.z, _glCam.x);
    grp.userData.sprites.forEach(function (sp) {
      let az;
      if (sp.userData.gratLon) az = -(sp.userData.geoLon * D);   // 经线上固定方位角
      else if (sp.userData.gratPm) az = 0;                       // 本初子午线：固定 0° 经线（随地球自转）
      else az = camAz;                                          // 纬线：取朝相机那一侧
      const lr = (sp.userData.geoLat || 0) * D, cl = Math.cos(lr);
      _glDir.set(cl * Math.cos(az), Math.sin(lr), cl * Math.sin(az)).multiplyScalar(radius);
      pushNoteClear(_glDir, _glCam, sp.scale.x, sp.scale.y);          // v20.0 防穿模
      sp.position.copy(_glDir).applyMatrix4(m);
      applyNoteFrontCull(sp, _glDir, _glCam);                         // v23.11：置顶 + 背面剔除
    });
  }
  /* 时区注释：纬度固定、经度与时区一一对应。v20.0 起同样走防穿模 —— 靠近地球剪影的
     那几个时区标注原先会被地球切掉一角，现在统一推到剪影之外。
     ===== v23.0（需求③）：取消「间隔显示」，24 个时区注释一律完整显示 =====
     v21.1 曾加过一层「密集遮挡分级」：字号调大后相邻标注会叠在一起，于是每隔一个时区
     才标一次。实际使用下来这层筛选用处不大 —— 字号本来就统一了，而「少标一半」会让
     时区序列读起来断断续续（东五区后面直接跳到东七区），反而丢信息。
     因此这里整块删除：碰撞检测、滞回阈值、奇偶保留全部移除，显隐只由三级门控决定
     （sp.userData.noteGate），转到地球背面的仍由深度测试自然遮挡。 */
  // v23.0：原 _tzCamN（相机方向单位向量）只服务于已删除的「正面可见 / 密集遮挡」判定，一并移除
  function layoutTzLabels(t, spinRef, cam) {
    spinRef.updateWorldMatrix(true, false);
    cam.updateMatrixWorld();
    _glM.copy(spinRef.matrixWorld).invert();
    _glCam.copy(cam.position).applyMatrix4(_glM);
    noteCamBasis(cam, _glM);
    // 注意：时区注释挂在 spin / spinOrb 之下（不是 scene 直挂），所以这里写入的是
    //       spin 局部坐标本身，不能再乘一次 matrixWorld（否则会被自转角双重旋转）。
    // v23.0：原来这里还要把每条标注投影到 NDC 做「相邻碰撞检测」，已随间隔显示一并删除 ——
    //       现在只需要摆位置，不再需要相机投影矩阵 / 墨迹宽度这些中间量。
    t.labels.forEach(function (sp) {
      const la = (sp.userData.tzLat || 0) * D, lo = -15 * (sp.userData.tzLon || 0) * D;
      const cl = Math.cos(la);
      _glDir.set(cl * Math.cos(lo) * 1.045, Math.sin(la) * 1.045, cl * Math.sin(lo) * 1.045);
      /* v22.0（需求①）：时区标注**只做环形排列** —— 24 条严格落在各自时区的经线上、
         固定半径 1.045 R，一字排开绕地球一圈（纬度由 buildTz 按索引奇偶分到 -6° / -14°
         两条南纬带，见 v23.12：双排交错以避免相邻时区互相压字、并整体避开赤道的经纬度 /
         地方时标签）。
         这里不再做防穿模外推：原先那套处理会把靠近地球剪影的那几条
         （典型就是「中时区」）沿屏面径向往外拽，脱离环体甩到球外、和左右两条错位，
         看上去就是在「跳动」。现在统一贴着球面走，落到背面 / 边缘的由地球自然遮挡
         （深度测试 + globeOccludes 判定），与既有需求「直接被地球挡住即可」一致。 */
      sp.position.copy(_glDir);
      /* v23.11（回归修复）：v22.0 取消了时区注释的「防穿模外推」，直接让球面把靠边的
         正面注释切掉 —— 表现为边缘时区文字缺一角（用户截图问题）。现改为「置顶 +
         背面剔除」：注释永远绘制在球面之上（不被球面 / 经纬网 / 光线切出空洞），
         只有锚点落到球体背面（相机看不到的那半球）时才整条隐藏。 */
      applyNoteFrontCull(sp, sp.position, _glCam);
    });
  }
  /* v23.17（需求③）：贴地注释的「布局 + 置顶 + 背面剔除」**按正在渲染的相机**执行。
     ----------------------------------------------------------------------------
     旧实现只在每帧开头用 camera（自转主相机）/ orbitCam（公转相机）各做一次；而综合视图的
     同一批注释会被 4 个相机分别渲染（主视 / 直射点回归运动 subCam / 北极 / 南极俯视），
     三窗模式下更是 3 个相机 —— 于是「按主相机判定为背面」的注释在 subCam 那一格里会整条
     消失、「按主相机判定为正面」的又会浮在 subCam 的背面半球上，表现为
     「正面该显示的不显示、背面该挡住的不挡住」。
     现在把这一整套（摆位 + 防穿模外推 + 背面剔除 + 临边淡出）搬进渲染循环：
     每个子窗口在 renderer.render 之前，用「它自己的相机」重算一次，于是每一格都自洽 ——
     正面内容清晰可见、背面内容被地球挡住。布局本身也只算一次/格（原来是一帧一次），
     代价是多几遍矩阵运算，远低于一次 draw call。
     orb = true 表示本次要处理的是挂在公转 rig 上的那一套注释。 */
  /* ===== v25.1（需求⑤）：海陆分布 / 七大洲的文字注释 =====
     位置直接用固定经纬度给出（都落在各自范围内部，避免压到别的洲 / 洋上）。
     注意参照系要用 **spin / spinOrb**（地球自转系）而不是 tilt —— 经纬度是钉在地表上的，
     必须随地球自转一起转；用 tilt 系会让标签「不跟着地球转」。 */
  const GEO_SITES = [
    { cat: 'cont', k: 'AS', t: '亚洲', lat: 42, lon: 88 },
    { cat: 'cont', k: 'EU', t: '欧洲', lat: 52, lon: 22 },
    { cat: 'cont', k: 'AF', t: '非洲', lat: 4, lon: 20 },
    { cat: 'cont', k: 'NA', t: '北美洲', lat: 45, lon: -100 },
    { cat: 'cont', k: 'SA', t: '南美洲', lat: -12, lon: -60 },
    { cat: 'cont', k: 'OC', t: '大洋洲', lat: -25, lon: 134 },
    { cat: 'cont', k: 'AN', t: '南极洲', lat: -80, lon: 20 },
    { cat: 'sea', k: 'PAC', t: '太平洋', lat: -8, lon: -150 },
    { cat: 'sea', k: 'ATL', t: '大西洋', lat: 12, lon: -38 },
    { cat: 'sea', k: 'IND', t: '印度洋', lat: -24, lon: 80 },
    { cat: 'sea', k: 'ARC', t: '北冰洋', lat: 86, lon: 0 },
  ];
  const GEO_NOTE_R = 1.06;                                  // 与地表注释同一半径（球面之上、又不离得太远）
  /* ===========================================================================
     v26.1（需求⑨）：区域面 —— 东西半球 / 南北半球 / 低中高纬度 / 主要地壳板块
     ---------------------------------------------------------------------------
     四组「区域」都是球面上按经纬度划分的 **面** 要素，属性控制与温度带同构：
       总开关 → 逐区域显隐 → 填充色 / 填充透明度 → 分界线（颜色/透明度/线宽「度」/线型）
       → 逐条文字注释（字号 / 字体 / 颜色 / 透明度 / 字重）。
     ★ 全部几何都在运行时由经纬度直接生成（spherePatchGeom / spherePolygonGeom /
       spherePolylineGeom），**不依赖任何外部数据文件** —— 因此不可能出现
       「数据缺失 → 勾了开关什么都不显示」这种静默失效。
       （对比：海陆分布 / 七大洲用的是离线栅格化的掩膜贴图，一旦图丢了就会静默失效 ——
         这也是 v26.1 需求③ 把掩膜改成内嵌 Data URI 的原因。）
     ★ 板块边界与运动方向是**示意性**的：按教材常用的六大板块划分与主要边界位置绘制，
       用于说明「生长边界（张裂）/ 消亡边界（碰撞俯冲）」与两板块相背 / 相向运动，
       不与专业地质图逐点对应。
     =========================================================================== */
  // 半径分层：区域面贴在「面」这一层的顶部，分界线略高，箭头再高一点（都低于线 20 / 点 30）
  const REGION_R = 1.0034, REGION_LINE_R = 1.0056;
  const REGION_RO = { ns: 8, ew: 9, belt: 10 };   // v27.1（需求⑤）：区域填充全部在 海陆(4)/大洲线(5)/温度带(6,7) 之上
  function mkRegionMat(hex, op) {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex || '#FFFFFF'), transparent: true,
      opacity: (op == null ? 1 : op), depthWrite: false, side: THREE.DoubleSide,
    });
  }
  /* 经纬度矩形面片（东/西半球、南北半球、低中高纬度的每一条带都是一个矩形面片）。
     顶点方向沿用本体系约定 dir(lat, lon) = (cos lat·cos az, sin lat, cos lat·sin az)、az = −lon。 */
  function spherePatchGeom(latA, latB, lonA, lonB, radius, sa, sb) {
    sa = sa || 18; sb = sb || 72;
    const pos = [], idx = [];
    for (let i = 0; i <= sa; i++) {
      const la = (latA + (latB - latA) * i / sa) * D, cl = Math.cos(la), y = Math.sin(la);
      for (let j = 0; j <= sb; j++) {
        const az = -(lonA + (lonB - lonA) * j / sb) * D;
        pos.push(cl * Math.cos(az) * radius, y * radius, cl * Math.sin(az) * radius);
      }
    }
    const cols = sb + 1;
    for (let i = 0; i < sa; i++) for (let j = 0; j < sb; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  /* 任意经纬度多边形 → 球面面片。
     ① 先在「经纬平面」里做耳切三角化（多边形都不跨越 180° 经线，由数据保证）；
     ② 每个三角形再按边长细分并把每个采样点**抬回球面**，于是长边也贴着大圆走、不切进球里。 */
  function _polyArea(p) { let s2 = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s2 += p[i][0] * q[1] - q[0] * p[i][1]; } return s2 * 0.5; }
  function _triCross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  function _ptInTri(p, a, b, c) {
    const d1 = _triCross(a, b, p), d2 = _triCross(b, c, p), d3 = _triCross(c, a, p);
    const neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(neg && pos);
  }
  function earClipPoly(poly) {
    const P = poly.slice();
    if (_polyArea(P) < 0) P.reverse();
    const V = [], out = [];
    for (let i = 0; i < P.length; i++) V.push(i);
    let guard = P.length * 3;
    while (V.length > 3 && guard-- > 0) {
      let clipped = false;
      for (let i = 0; i < V.length; i++) {
        const ia = V[(i + V.length - 1) % V.length], ib = V[i], ic = V[(i + 1) % V.length];
        const A = P[ia], B = P[ib], C = P[ic];
        if (_triCross(A, B, C) <= 0) continue;                 // 凹角 / 退化 → 不是耳朵
        let ok = true;
        for (let j = 0; j < V.length && ok; j++) {
          const p = V[j];
          if (p === ia || p === ib || p === ic) continue;
          if (_ptInTri(P[p], A, B, C)) ok = false;
        }
        if (!ok) continue;
        out.push(A, B, C);
        V.splice(i, 1);
        clipped = true; break;
      }
      if (!clipped) break;                                     // 数据异常时兜底，避免死循环
    }
    for (let i = 1; i + 1 < V.length; i++) out.push(P[V[0]], P[V[i]], P[V[i + 1]]);
    return out;
  }
  const _rgDir = new THREE.Vector3();
  function spherePolygonGeom(pts, radius) {
    const tris = earClipPoly(pts);
    const pos = [], idx = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const A = tris[t], B = tris[t + 1], C = tris[t + 2];
      const len = Math.max(Math.hypot(B[0] - A[0], B[1] - A[1]),
                           Math.hypot(C[0] - B[0], C[1] - B[1]),
                           Math.hypot(A[0] - C[0], A[1] - C[1]));
      /* v27.0（需求二.5）：边缘细分从「每 5° 一个采样」加密到「每 2.5°」——
         板块面片的边界若采样太粗，与贴地描边线（每 2° 采样）会出现肉眼可见的
         缝隙 / 错位；加密后两者贴合（顶点量增加约一倍，仍属一次性构建，可接受）。 */
      const sub = clamp(Math.ceil(len / 2.5), 2, 48);
      const base = pos.length / 3, off = [];
      for (let i = 0; i <= sub; i++) {
        off[i] = pos.length / 3 - base;
        for (let j = 0; j + i <= sub; j++) {
          const u = i / sub, v = j / sub, w = 1 - u - v;
          const lon = A[0] * w + B[0] * v + C[0] * u;
          const lat = A[1] * w + B[1] * v + C[1] * u;
          geoDir(lat, lon, _rgDir);
          pos.push(_rgDir.x * radius, _rgDir.y * radius, _rgDir.z * radius);
        }
      }
      for (let i = 0; i < sub; i++) {
        for (let j = 0; j + i < sub; j++) {
          const a = base + off[i] + j, b = base + off[i + 1] + j, c = base + off[i] + j + 1;
          idx.push(a, b, c);
          if (i + j + 1 < sub) idx.push(b, base + off[i + 1] + j + 1, c);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  /* 任意经纬度折线 → 贴地的「扁带」（与项目其余线要素同一观感：不是圆管，是有宽度的带）。
     半宽以世界单位给出（线宽「度」× D × 0.5）。
     v27.0（需求二.5）：支持 dashStyle = { dash:'dash'|'solid', n, ratio } —— 虚线按
     「整条线分 n 个周期、每周期 ratio 比例画实」的规则跳过缺口段的索引，几何顶点仍全量
     生成（省一次重采样），只影响 idx，因此线型 / 密度 / 虚实比改动只需重建几何即可实时生效。 */
  const _rgC = new THREE.Vector3(), _rgT = new THREE.Vector3(), _rgS = new THREE.Vector3();
  function spherePolylineGeom(pts, radius, halfW, stepDeg, dashStyle) {
    const dashed = !!(dashStyle && dashStyle.dash === 'dash');
    const dn = clamp(dashStyle && dashStyle.n ? dashStyle.n : 60, 4, 400);
    const dr = clamp(dashStyle && dashStyle.ratio != null ? dashStyle.ratio : 0.55, 0.05, 0.98);
    const path = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const dLon = B[0] - A[0], dLat = B[1] - A[1];
      const n = Math.max(2, Math.ceil(Math.hypot(dLon, dLat) / (dashed ? (stepDeg || 3) * 0.5 : (stepDeg || 3))));
      for (let k = 0; k < n; k++) path.push([A[0] + dLon * k / n, A[1] + dLat * k / n]);
    }
    path.push(pts[pts.length - 1]);
    const pos = [], idx = [];
    for (let i = 0; i < path.length; i++) {
      geoDir(path[i][1], path[i][0], _rgC);
      const pv = i > 0 ? geoDir(path[i - 1][1], path[i - 1][0], new THREE.Vector3()) : null;
      const nx = i + 1 < path.length ? geoDir(path[i + 1][1], path[i + 1][0], new THREE.Vector3()) : null;
      _rgT.copy(nx || _rgC).sub(pv || _rgC);
      if (_rgT.lengthSq() < 1e-14) { _rgT.set(_rgC.z, 0, -_rgC.x); }   // 退化时取任意切向
      _rgT.normalize();
      _rgS.copy(_rgC).cross(_rgT).normalize();                        // 侧向 = 径向 × 切向
      const cx = _rgC.x * radius, cy = _rgC.y * radius, cz = _rgC.z * radius;
      pos.push(cx + _rgS.x * halfW, cy + _rgS.y * halfW, cz + _rgS.z * halfW);
      pos.push(cx - _rgS.x * halfW, cy - _rgS.y * halfW, cz - _rgS.z * halfW);
    }
    const last = path.length - 1;
    for (let i = 0; i + 1 < path.length; i++) {
      if (dashed) {
        // 以段中点的「全线进度」判断该段落在实段还是缺口（首尾保证有笔触，避免断头）
        const f = (i + 0.5) / last;
        let ph = f * dn - Math.floor(f * dn);
        if (f < 1 / dn * 0.5 || f > 1 - 1 / dn * 0.5) ph = 0;          // 起止端各留半周期实线
        if (ph >= dr) continue;
      }
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  /* ---- 数据：区域注记落点 ----
     v27.0（需求二.4）：低中高纬度注记改为**南北各一份**（共 6 条），文字里标明半球；
     key 以 N / S 结尾（保证 sprite key 唯一），门控时归一化回 low / mid / high ——
     菜单里「低 / 中 / 高纬度」的注释开关与分带开关依旧各管一整条带（南 + 北）。 */
  const REGION_SITES = {
    hemiEW: [{ k: 'east', t: '东半球', lat: 22, lon: 72 },
             { k: 'west', t: '西半球', lat: 22, lon: -108 }],
    hemiNS: [{ k: 'north', t: '北半球', lat: 46, lon: -42 },
             { k: 'south', t: '南半球', lat: -46, lon: -42 }],
    latBelt: [{ k: 'lowN', t: '低纬度\n（北半球）', lat: 16, lon: -142 },
              { k: 'lowS', t: '低纬度\n（南半球）', lat: -16, lon: -142 },
              { k: 'midN', t: '中纬度\n（北半球）', lat: 45, lon: -142 },
              { k: 'midS', t: '中纬度\n（南半球）', lat: -45, lon: -142 },
              { k: 'highN', t: '高纬度\n（北半球）', lat: 74, lon: -142 },
              { k: 'highS', t: '高纬度\n（南半球）', lat: -74, lon: -142 }],
  };

  /* ---- 网格：面 / 线 / 箭头（自转与公转各一套材质，几何共用） ---- */
  function buildRegionFaces(parent, tag) {
    const grp = new THREE.Group(); parent.add(grp);
    const F = function () { return state.style.fill; };
    const mk = function (geom, hex, op, ro) {
      const m = new THREE.Mesh(geom, mkRegionMat(hex, op));
      m.renderOrder = ro; grp.add(m); return m;
    };
    const g = {};
    // 东西半球 —— 东半球：20°W 向东到 160°E；西半球：160°E 向东到 20°W
    g.ewEast = mk(spherePatchGeom(-90, 90, -20, 160, REGION_R, 26, 90), F().hemi.east, F().hemi.op, REGION_RO.ew);
    g.ewWest = mk(spherePatchGeom(-90, 90, 160, 340, REGION_R, 26, 90), F().hemi.west, F().hemi.op, REGION_RO.ew);
    // 南北半球
    g.nsNorth = mk(spherePatchGeom(0, 90, -180, 180, REGION_R, 22, 90), F().hemiNS.north, F().hemiNS.op, REGION_RO.ns);
    g.nsSouth = mk(spherePatchGeom(-90, 0, -180, 180, REGION_R, 22, 90), F().hemiNS.south, F().hemiNS.op, REGION_RO.ns);
    // 低中高纬度（南北各一条带，同一开关同一颜色）
    const beltBands = { low: [[0, 30], [-30, 0]], mid: [[30, 60], [-60, -30]], high: [[60, 90], [-90, -60]] };
    g.belt = {};
    ['low', 'mid', 'high'].forEach(function (k) {
      g.belt[k] = beltBands[k].map(function (b) {
        return mk(spherePatchGeom(b[0], b[1], -180, 180, REGION_R, 10, 90), F().latbelt[k], F().latbelt.op, REGION_RO.belt);
      });
    });
    /* v27.1（需求②）：六大板块面片整组删除。 */
    return { grp: grp, g: g, tag: tag };
  }
  function buildRegionLines(parent, tag) {
    // 分界线（东西半球用两条经线，南北半球用赤道）。
    // v27.0（需求二.3）：低中高纬度不再绘制 ±30°/±60° 轮廓线（整组取消，菜单同步删除）；
    //   东西 / 南北半球描边保持「正确的半球分界线」：20°W 与 160°E 两条经线、赤道一条纬线。
    // v35（需求二）：半球 / 纬度带分界线固定**实线** —— mkLine 统一强制 dash:'solid'，
    //   旧存档残留的 lineDash:'dash' 不再有任何效果。
    const mkLine = function (pts, hex, op, wDeg, dashCfg) {
      const cfg = Object.assign({}, dashCfg, { dash: 'solid' });
      const m = new THREE.Mesh(spherePolylineGeom(pts, REGION_LINE_R, (wDeg || 0.3) * D * 0.5, 3, cfg),
                               mkRegionMat(hex, op));
      m.renderOrder = REGION_RO.belt; return m;
    };
    const lonCircle = function (lon, latA, latB) {
      const p = []; const step = (latB - latA) / 24;
      for (let i = 0; i <= 24; i++) p.push([lon, latA + step * i]);
      return p;
    };
    const latCircle = function (lat, lonA, lonB) {
      const p = []; const step = (lonB - lonA) / 96;
      for (let i = 0; i <= 96; i++) p.push([lonA + step * i, lat]);
      return p;
    };
    const grp = new THREE.Group(); parent.add(grp);
    const F = state.style.fill;
    const o = {
      ew: [mkLine(lonCircle(-20, -90, 90), F.hemi.line, F.hemi.lineOp, F.hemi.lineW, F.hemi),
           mkLine(lonCircle(160, -90, 90), F.hemi.line, F.hemi.lineOp, F.hemi.lineW, F.hemi)],
      ns: [mkLine(latCircle(0, -180, 180), F.hemiNS.line, F.hemiNS.lineOp, F.hemiNS.lineW, F.hemiNS)],
      // v27.1（需求④）：低中高纬度分界线（±30° / ±60°）回归 —— 独立显隐开关（latbelt.line）+ 独立线型
      belt: [30, -30, 60, -60].map(function (la) {
        return mkLine(latCircle(la, -180, 180), F.latbelt.line.color, F.latbelt.line.op, F.latbelt.line.w, F.latbelt.line);
      }),
    };
    [].concat(o.ew, o.ns, o.belt).forEach(function (m) { grp.add(m); });
    /* v27.1（需求②）：板块生长 / 消亡边界与运动方向箭头整组删除。 */
    return { grp: grp, lines: o };
  }
  const regionR = buildRegionFaces(spin, 'R');
  const regionO = buildRegionFaces(spinOrb, 'O');
  const regionLR = buildRegionLines(spin, 'R');
  const regionLO = buildRegionLines(spinOrb, 'O');
  [[regionR, regionLR], [regionO, regionLO]].forEach(function (p) {
    [p[0].grp, p[1].grp].forEach(function (g) { g.visible = false; });
  });
  /* 把状态写进区域面（两组场景逐项同步）。
     注意「分界线」的颜色 / 透明度 / 线宽在几何里已经烘进顶点（半宽是顶点位置的一部分），
     运行时改这三项需要重建几何 —— 这里统一用 rebuildRegionLineGeos() 处理。 */
  function rebuildRegionLineGeos() {
    const F = state.style.fill;
    const lonCircle = function (lon) { const p = []; for (let i = 0; i <= 24; i++) p.push([lon, -90 + 7.5 * i]); return p; };
    const latCircle = function (lat) { const p = []; for (let i = 0; i <= 96; i++) p.push([-180 + 3.75 * i, lat]); return p; };
    const put = function (mesh, pts, wDeg, dashCfg) {
      if (!mesh) return;
      // v35（需求二）：半球 / 纬度带分界线固定实线（与 buildRegionLines 同口径）
      const cfg = Object.assign({}, dashCfg, { dash: 'solid' });
      const g2 = spherePolylineGeom(pts, REGION_LINE_R, (wDeg || 0.3) * D * 0.5, 3, cfg);
      const old = mesh.geometry; mesh.geometry = g2; if (old) old.dispose();
    };
    [[regionLR, F.hemi, F.hemiNS], [regionLO, F.hemi, F.hemiNS]].forEach(function (row) {
      const L = row[0], HE = row[1], HN = row[2];
      put(L.lines.ew[0], lonCircle(-20), HE.lineW, HE);
      put(L.lines.ew[1], lonCircle(160), HE.lineW, HE);
      put(L.lines.ns[0], latCircle(0), HN.lineW, HN);
      [30, -30, 60, -60].forEach(function (la, i) { put(L.lines.belt[i], latCircle(la), F.latbelt.line.w, F.latbelt.line); });
    });
  }
  function applyRegions() {
    const F = state.style.fill;
    const setVis = function (mesh, on) { if (mesh) mesh.visible = !!on; };
    const setOp = function (mesh, hex, op) {
      if (!mesh) return;
      mesh.material.color.set(hex); mesh.material.opacity = op;
    };
    [[regionR, regionLR], [regionO, regionLO]].forEach(function (p) {
      const R = p[0], L = p[1], G = R.g;
      const HE = state.hemi.ew, HN = state.hemi.ns, LB = state.latbelt;
      // ---- 东西半球 ----
      setVis(G.ewEast, HE.on && HE.east); setVis(G.ewWest, HE.on && HE.west);
      setOp(G.ewEast, F.hemi.east, F.hemi.op); setOp(G.ewWest, F.hemi.west, F.hemi.op);
      // ---- 南北半球 ----
      setVis(G.nsNorth, HN.on && HN.north); setVis(G.nsSouth, HN.on && HN.south);
      setOp(G.nsNorth, F.hemiNS.north, F.hemiNS.op); setOp(G.nsSouth, F.hemiNS.south, F.hemiNS.op);
      // ---- 低中高纬度 ----
      ['low', 'mid', 'high'].forEach(function (k) {
        G.belt[k].forEach(function (m) { setVis(m, LB.on && LB.bands[k] !== false); setOp(m, F.latbelt[k], F.latbelt.op); });
      });
      // ---- 分界线 ----
      // v27.1（需求④）：纬度带分界线（±30°/±60°）回归，独立开关 latbelt.line + 独立线型；
      //   东西 / 南北半球分界线保持「正确的半球分界线」：20°W 与 160°E 两条经线、赤道一条纬线。
      /* v27.1（需求④）修复：原 lineOn(spec) 把三组线写进同一个闭包、按 `spec === 'ew'` 等判显隐，
         连续调用 lineOn('ew')/('ns')/('belt') 时互相覆盖 —— 后两次调用把 ew / ns 线组重新判为
         false 隐藏，导致半球分界线自 v27.0 起**从未真正显示过**（探针当时只查几何未查显隐）。
         现改为一次遍历、各组按各自的开关独立判定。 */
      L.lines.ew.forEach(function (m) { setVis(m, HE.on && HE.line); });
      L.lines.ns.forEach(function (m) { setVis(m, HN.on && HN.line); });
      L.lines.belt.forEach(function (m) { setVis(m, LB.on && LB.line); });
      L.lines.ew.forEach(function (m) { m.material.color.set(F.hemi.line); m.material.opacity = F.hemi.lineOp; });
      L.lines.ns.forEach(function (m) { m.material.color.set(F.hemiNS.line); m.material.opacity = F.hemiNS.lineOp; });
      L.lines.belt.forEach(function (m) { m.material.color.set(F.latbelt.line.color); m.material.opacity = F.latbelt.line.op; });
      /* v27.1（需求②）：板块边界 + 箭头整组删除。 */
      // 整组显隐（都关掉时彻底不画，省一次遍历）
      R.grp.visible = !!(HE.on || HN.on || LB.on);
      L.grp.visible = R.grp.visible;
    });
    /* 分界线的「线宽」烘进了顶点（半宽是位置的一部分），改宽度必须重建几何 ——
       用签名比对避免每次 applyAll 都重算（applyAll 每次改任意参数都会走到）。 */
    /* v35（需求二）：线型固定（半球 / 纬度带实线、温度带虚线）⇒ 签名只剩线宽三项。 */
    const sig = [F.hemi.lineW, F.hemiNS.lineW, F.latbelt.line.w].join(',');
    if (sig !== _regionLineSig) { _regionLineSig = sig; rebuildRegionLineGeos(); }
  }
  let _regionLineSig = '';

  function buildGeoNotes(parent, w, tag) {
    const arr = [];
    GEO_SITES.forEach(function (s) {
      const sp = makeTextSprite(s.t, w, true, s.cat, tag + '.' + s.k);
      sp.renderOrder = 41;
      sp.userData.geoSite = s;
      parent.add(sp); arr.push(sp);
    });
    // v26.1（需求⑨）：四组区域面的注记（同一条「钉在地表」的流水线）
    Object.keys(REGION_SITES).forEach(function (cat) {
      REGION_SITES[cat].forEach(function (s) {
        /* key 只写 tag + '.' + k（不带 cat）—— spriteNoteGate 取的是「第一个点之后」的子键，
           写成 'R.hemiEW.east' 会得到 'hemiEW.east'，与 hemi.ew.east 对不上，门控失效。 */
        const sp = makeTextSprite(s.t, w, true, cat, tag + '.' + s.k);
        sp.renderOrder = 41;
        sp.userData.geoSite = { k: s.k, cat: cat, lat: s.lat, lon: s.lon, t: s.t };
        parent.add(sp); arr.push(sp);
      });
    });
    /* v27.1（需求②）：板块名称 / 边界注记整组删除。 */
    return arr;
  }
  const geoNotesR = buildGeoNotes(scene, 0.34, 'R');
  const geoNotesO = buildGeoNotes(orbitScene, 0.5, 'O');
  // 经纬度方向（本地系约定：az = −经度，见经纬网 / 时区面）
  function geoDir(latDeg, lonDeg, out) {
    const lr = latDeg * D, az = -lonDeg * D, cl = Math.cos(lr);
    return out.set(cl * Math.cos(az), Math.sin(lr), cl * Math.sin(az));
  }
  /* v26.1（需求⑨）：区域注记的「面级门控」 —— 与面的开关同口径，
     区域整组关掉 / 单个分带关掉时，对应的文字一起隐藏。 */
  function regionSiteOn(s) {
    const HE = state.hemi.ew, HN = state.hemi.ns, LB = state.latbelt;
    if (s.cat === 'hemiEW') return !!(HE.on && HE[s.k] !== false);
    if (s.cat === 'hemiNS') return !!(HN.on && HN[s.k] !== false);
    /* v27.0（需求二.4）：低中高纬度注记按南北各一条（lowN / lowS / …），
       门控归一化回分带键 low / mid / high —— 南北两条同受该带开关控制。 */
    if (s.cat === 'latBelt') {
      const bk = String(s.k).replace(/N$|S$/, '');
      return !!(LB.on && LB.bands[bk] !== false);
    }
    return true;
  }
  function layoutGeoNotes(arr, spinRef, cam, radius) {
    spinRef.updateWorldMatrix(true, false);
    const m = spinRef.matrixWorld;
    _snM.copy(m).invert();
    _snCamL.copy(cam.position).applyMatrix4(_snM);
    noteCamBasis(cam, _snM);
    const L = state.geo.cont.list || {};
    const _d = new THREE.Vector3(), _p = new THREE.Vector3();
    arr.forEach(function (sp) {
      const s = sp.userData.geoSite; if (!s) return;
      // 单独关掉的洲连同名称一起隐藏（门控结果由 spriteNoteGate 写入 noteGate，这里只提前短路）
      if (s.cat === 'cont' && L[s.k] === false) { sp.visible = false; return; }
      /* v26.1（需求⑨）：区域注记跟随所属区域的开关 —— 关掉整组区域时，
         连同它的文字一起隐藏（与「七大洲单独关掉一个洲就隐藏该洲名称」同口径）。 */
      if (regionSiteOn && !regionSiteOn(s)) { sp.visible = false; return; }
      geoDir(s.lat, s.lon, _d);
      _p.copy(_d).multiplyScalar(radius);
      pushNoteClear(_p, _snCamL, sp.scale.x, sp.scale.y);
      /* ★ 本组注释挂在 **scene** 之下（不是 spin 之下），所以要把 spin 局部的坐标
         乘回世界矩阵 —— 与 layoutSurfaceNotes 同口径。漏掉这一步的后果：注释会被
         「黄赤交角旋转 + rig 缩放」漏掉，亚洲的标签会飘到别的经度上去。 */
      sp.position.copy(_p).applyMatrix4(m);
      applyNoteFrontCull(sp, _p, _snCamL);
    });
  }

  /* ===== v25.1（需求⑦）：时差演示的文字注释 =====
     5 条注记的经度不是常数：0 时经线与两个日期范围都随时刻移动，
     因此每帧按当前 tzdiffZeroLon 重新定位（纬度固定，选在不易与其它注释打架的位置）。 */
  const TZDIFF_SITES = [
    { k: 'tz0', lat: 20, lon: function () { return 0; } },                       // 中时区 → 固定 0° 经线
    { k: 'idl', lat: -34, lon: function () { return 180; } },                    // 国际日期变更线 → 180°
    { k: 'zero', lat: 34, lon: function () { return tzdiffZeroLon; } },          // 0 时时刻所在经线
    { k: 'newDay', lat: -46, lon: function () { return wrap360(tzdiffZeroLon + tzdiffNewSpan() / 2); } },
    { k: 'oldDay', lat: 46, lon: function () { return wrap360(tzdiffZeroLon + tzdiffNewSpan() / 2 + 180); } },
  ];
  function layoutTzdiffNotes(t, cam, radius) {
    if (!t || !t.notes || !t.grp) return;
    t.grp.updateWorldMatrix(true, false);
    _snM.copy(t.grp.matrixWorld).invert();
    _snCamL.copy(cam.position).applyMatrix4(_snM);
    noteCamBasis(cam, _snM);
    const span = tzdiffNewSpan();
    const _p = new THREE.Vector3();
    TZDIFF_SITES.forEach(function (s) {
      const sp = t.notes[s.k]; if (!sp) return;
      // 「新的一天」区域退化成一条线（0 时经线与 180° 重合 → 全球同一天）时不标注；
      // 「旧的一天」铺满全球时同样不标注 —— 这两种情况下标签必然落在错误的位置上。
      if (s.k === 'newDay' && span < 8) { sp.visible = false; return; }
      if (s.k === 'oldDay' && span > 352) { sp.visible = false; return; }
      geoDir(s.lat, s.lon(), _p).multiplyScalar(radius);
      pushNoteClear(_p, _snCamL, sp.scale.x, sp.scale.y);
      sp.position.copy(_p);
      applyNoteFrontCull(sp, _p, _snCamL);
    });
  }

  /* ★ 本次性能修复：earthNotesPass 去重 ——
     同一帧内同一台相机只执行一次（renderCombo 每格调用、mvRender3DThumbs 多窗再调用）。
     键 = camera.uuid + 帧号；帧号在渲染主循环 tick() 每帧自增。不同相机（多窗口各自独立
     相机，uuid 不同）键不同，互不影响。 */
  let _notePassFrame = 0;
  const _notePassDone = new Map();
  function earthNotesPass(cam, orb) {
    const _cid = (cam && cam.uuid) || 'nocam';
    if (_notePassDone.get(_cid) === _notePassFrame) return;   // 本帧该相机已算过 → 直接跳过
    _notePassDone.set(_cid, _notePassFrame);
    if (!state.note.master.on) return;
    if (orb) {
      applyOrbNoteK();       // v23.17：地球特写下注释按相机距离等比缩小（屏幕字号恒定）
      layoutSurfaceNotes(surfO, tiltOrb, cam, orbSunDir, 1.06);
      layoutGratLabels(gratLabelO, spinOrb, cam, GRAT_NOTE_R);
      layoutTzLabels(tzO, spinOrb, cam);
      layoutGeoNotes(geoNotesO, spinOrb, cam, GEO_NOTE_R);
      layoutTzdiffNotes(tzdiffO, cam, GEO_NOTE_R);
      layoutGcdNotes(gcdO, cam);        // v25.1（需求⑧）：球面最短距离的距离 / 端点标注
      cullEarthNoteList(hourRigOrb.userData.main.userData.labels, tiltOrb, cam);
      cullEarthNoteList(hourRigOrb.userData.rest.userData.labels, tiltOrb, cam);
      cullEarthNoteList(axisRigOrb.labels, tiltOrb, cam);
      cullEarthNoteList([pdLabelOrb, pnLabelOrb], tiltOrb, cam);
      updatePointLabels(cam, spinOrb, 'orb');
    } else {
      applySpinNoteK(cam);   // ★ v35（需求七）：自转 / 综合透视窗按相机距离补偿字号
      layoutSurfaceNotes(surfR, tilt, cam, sunDir, 1.06);
      layoutGratLabels(gratLabelR, spin, cam, GRAT_NOTE_R);
      layoutTzLabels(tzR, spin, cam);
      layoutGeoNotes(geoNotesR, spin, cam, GEO_NOTE_R);
      layoutTzdiffNotes(tzdiffR, cam, GEO_NOTE_R);
      layoutGcdNotes(gcdR, cam);        // v25.1（需求⑧）：球面最短距离的距离 / 端点标注
      cullEarthNoteList(hourRig.userData.main.userData.labels, tilt, cam);
      cullEarthNoteList(hourRig.userData.rest.userData.labels, tilt, cam);
      cullEarthNoteList(axisRigMain.labels, tilt, cam);
      cullEarthNoteList([pdLabel, pnLabel], tilt, cam);
      updatePointLabels(cam, spin, 'spin');
    }
  }

  const _v1b = new THREE.Vector3(), _v2b = new THREE.Vector3(), _v3b = new THREE.Vector3();
  const _e1o = new THREE.Vector3(), _e2o = new THREE.Vector3(), _rayPerp = new THREE.Vector3();
  /* v33（需求四）：公转视图光线布局的临时向量（地轴 / 南北展开方向） */
  const _orbAxisTmp = new THREE.Vector3(), _orbPerpO = new THREE.Vector3();
  const _orbHeadBase = new THREE.Vector3();   // v23.7：公转光线箭头「统一站位」的基准点（复用，避免每帧新建）
  let _orbW = -1;    // 上次应用的轨道粗细（避免每帧重建几何体）
  let _orbRGeo = -1; // 上次应用的轨道半长轴（v28 起＝椭圆半长轴，随日地距离变化时重建）
  let _orbEc = -1;   // v28：上次应用的离心率（与半长轴一起决定椭圆几何）
  let _orbPk = -1;   // v28：上次应用的近日点黄经（量化后，椭圆朝向）
  let _lastDistScale = null;   // v20.0：上次应用的「日地距离」比例（仅它变化时才缩放相机距离）
  // 直射点回归运动专用相机（聚焦地球直射点区域）
  // v21.0（需求①）：这个窗口的内容要能缩放 —— 加一个 subZoom 倍率，
  //   SUB_HALF 是「倍率 = 1」时的取景半宽（正交相机的最短半轴），默认 1.16 让整颗地球
  //   连同一点余量完整落在窗口内；滚轮在该窗口内上下滚动即等比缩放。
  const SUB_HALF = 1.16;
  let subZoom = 1;
  const subCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 40);
  function updateOrbit() {
    const info = currentInfo || solarInfo(simMs);
    // 地轴固定指向北极星方向（rig 不随参考系旋转）。
    // 由"轴-太阳夹角 = 赤纬"反解轨道角：-P̂·n̂ = sinδ 且 n̂=(sinε,cosε,0)
    //  => cosθ = -sinδ/sinε  =>  θ = π/2 + λ（λ 为太阳视黄经，全年单调）
    // 从北天极（+Y）俯视为逆时针 = 自西向东公转：P=(cosθ, 0, -sinθ)
    const th = Math.PI / 2 + info.lam;
    /* v28（需求①）：半径由常数改为**真实椭圆**半径 r = a(1−e²)/(1+e·cos ν)。
       方向（黄经）保持 Meeus 的视黄经不变 —— 于是节气 / 直射点 / 昼夜长短链条一字不动，
       而轨道形状与「近日点远、远日点近」的实际上距离关系成立。
       ★(a, e, ϖ) 每帧在这里统一刷新一次，随后地球位置 / 焦点标记 / 节气标记 / 速度扇形
       全部用同一组值 —— 保证「地球球心严格落在轨道线上」（误差 0，而非万分之一）。 */
    syncOrbShape(undefined, info.T);
    const st = orbStateNow(info.lam);
    const rScene = orbRNow * st.rk;
    const P = _v1b.set(Math.cos(th), 0, -Math.sin(th)).multiplyScalar(rScene);
    orbRig.position.copy(P);
    /* v28（需求④）：本帧的公转瞬时运动学量（供「公转速度」面板 / 天文数据读数使用）。
       v（线速度）= √(GM(2/r−1/a))；ω（角速度）= h/r² —— 由开普勒第二定律同步给出。 */
    orbKin.rk = st.rk; orbKin.nu = st.nu; orbKin.e = st.e; orbKin.rScene = rScene;
    orbKin.rAU = st.rk;                                  // 半长轴按 1 AU 计 → r 的天文单位值
    orbKin.vKmS = orbitSpeedKmS(st.rk);
    orbKin.omegaDegDay = orbitOmegaDegDay(st.rk, st.e);
    /* v28：焦点标记与节气标记跟着同一组 (a, e, ϖ) 走 —— 每帧重排一次（共 28 个小对象，
       开销可忽略），于是「标记永远贴在同一条椭圆上」，不会因 T 的取值不同出现万分之一漂移。 */
    syncOrbFocus();
    layoutOrbitDecor(orbRNow, orbEccNow, orbPeriLonNow);
    syncOrbAtmo();   // 大气球心 / 半径随地球位置与大小比例同步
    // 太阳方向（地心指向太阳）
    const sDir = _v2b.copy(P).multiplyScalar(-1).normalize();
    orbSunDir.copy(sDir);                                // 供监听点纬线圈昼夜分弧实时使用
    // 自转相位：保证直射点经度与时间系统一致（地轴固定，只调自转角 ρ）
    // 与自转视图统一：ρ = -(太阳在 tilt 系的经度) - 直射点地理经度
    // （贴图经度约定：地理东经 = -atan2(z,x)，故取负号）
    const se = Math.sin(OBLIQ), ce = Math.cos(OBLIQ);
    const sTx = sDir.x * ce - sDir.y * se, sTz = sDir.z;   // 太阳方向在 tilt 局部系
    spinOrb.rotation.y = -Math.atan2(sTz, sTx) - subsolarLonRad(simMs, info.eot);
    syncTzdiffZero();                                 // v25.1（需求⑦）：0 时经线随地方时刻实时移动
    updateFigureShadows(orbSunDir, spinOrb, 'O');     // v25.1（需求⑥）：小人影子按太阳方向实时解算
    // 着色器所需方向 / 云影
    earthMatOrb.uniforms.uSunDir.value.copy(sDir);
    earthMatOrb.uniforms.uSpinAxis.value.set(se, ce, 0);
    earthMatOrb.uniforms.uCloudShift.value = earthMat.uniforms.uCloudShift.value;
    _e1o.copy(YAX).cross(sDir);
    if (_e1o.lengthSq() < 1e-8) _e1o.copy(ZAX).cross(sDir);
    _e1o.normalize(); _e2o.copy(sDir).cross(_e1o).normalize();
    earthMatOrb.uniforms.uE1.value.copy(_e1o);
    earthMatOrb.uniforms.uE2.value.copy(_e2o);
    cloudMatOrb.uniforms.uSunDir.value.copy(sDir);
    atmoMatOrb.uniforms.uSunDir.value.copy(sDir);
    geoMatO.uniforms.uSunDir.value.copy(sDir);        // v25.1（需求⑤）：海陆 / 大洲层的昼夜压暗
    auroraSunLocal(earthOrb, sDir, earthMatOrb);   // 极光：太阳方向转到地球本地系
    cloudsOrb.rotation.y = clouds.rotation.y;
    // 直射点标记
    subOrbGroup.quaternion.setFromUnitVectors(XAX, sDir);
    subOrbGroup.position.copy(sDir).multiplyScalar(1 + state.style.pt.sub.size * 0.25);
    // v27.4：直射点纬线与经线跟随直射点实时移动（公转场景）
    updateSubCircle(info.decl, subsolarLonRad(simMs, info.eot));
    // 极昼极夜（公转视角永远使用真实赤纬）
    const capRad = Math.abs(info.decl);
    const northIsDay = info.decl > 0;
    capMatDayOrb.uniforms.uDir.value = northIsDay ? 1 : -1;
    capMatNightOrb.uniforms.uDir.value = northIsDay ? -1 : 1;
    capMatDayOrb.uniforms.uCapAngle.value = capRad;
    capMatNightOrb.uniforms.uCapAngle.value = capRad;
    const sgn = Math.sin(capRad), csg = Math.cos(capRad), RR = 1.0065;
    const posDay = northIsDay ? 1 : -1;
    strokeDayOrb.scale.setScalar(sgn); strokeDayOrb.position.y = posDay * csg * RR;
    strokeNightOrb.scale.setScalar(sgn); strokeNightOrb.position.y = -posDay * csg * RR;
    // 极昼 / 极夜文字注释（与自转视图同一套规则）
    const showCapO = state.polar && capRad > 0.0015;
    pdLabelOrb.position.set(0, posDay * CAP_NOTE_R, 0);
    pnLabelOrb.position.set(0, -posDay * CAP_NOTE_R, 0);
    pdLabelOrb.userData.noteGate = showCapO && state.pd.on && pdLabelOrb.userData.noteOK !== false;
    pnLabelOrb.userData.noteGate = showCapO && state.pn.on && pnLabelOrb.userData.noteOK !== false;
    pdLabelOrb.visible = pdLabelOrb.userData.noteGate;
    pnLabelOrb.visible = pnLabelOrb.userData.noteGate;
    // 直射光线（中间直射线 + 箭头 + 平行光场）：与自转视图同一套单位圆柱 / 单位圆锥
    const dir = _v3b.copy(P).normalize();
    const rl = Math.max(P.length(), 0.2);            // 日地距离（世界单位）
    /* v31（需求七）：公转视图的太阳体积光柱 —— 从地球朝日侧一路铺到太阳；
       半径按地球世界半径等比（UI 下限 100% ⇒ 直径不小于地球直径）。 */
    {
      const _erVS = ORB_E * ((state.orb && state.orb.earthScale) || 1);
      const _o = volShaftOn();
      const _sg = _o + '|' + state.volShaft.intensity + '|' + state.volShaft.op + '|' +
        state.volShaft.dia + '|' + state.volShaft.color + '|' + state.volShaft.glow;
      if (_sg !== _volSigO) { _volSigO = _sg; styleVolShaft(volShaftO, _o); }
      if (_o) layoutVolShaft(volShaftO, dir, _erVS, rl);
    }
    const kO = state.style.ln.ray.w / RAY_R0;
    // v23.5：箭头贴在地球「朝日一侧」地表之外（原先落在球心附近 → 被地球完全遮挡、看不见）；
    //   地球世界半径 = ER，锥尖落在球面上、锥体沿太阳方向外伸。
    const erW = ORB_E * ((state.orb && state.orb.earthScale) || 1);
    const perp = _rayPerp.set(0, 1, 0).cross(dir); if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1); perp.normalize();
    /* ★ v33（需求四）：与自转视图**同一套**纬度分布。
       公转场景里太阳在原点、地球在 P，故 dir 是「太阳 → 地球」，距离从太阳起算：
         · 命中纬度 lat 的平行光线，横向偏移 = erW · sin(lat)（沿南北展开方向 _orbPerp）；
         · 锥尖到太阳的距离 = rl − erW · cos(lat)（正好落在地球朝日侧的地表上）。
       注：updateOrbit 每帧先跑、applyOrbit 里的 applyRayStyle 随后刷新 orbRayHeadLenW，
       故这里用的是上一帧的箭头长度；差值亚像素级，下一帧即自洽。 */
    const _orbAxisO = _orbAxisTmp.set(Math.sin(OBLIQ), Math.cos(OBLIQ), 0);   // 公转场景的地轴（orbRig 无旋转）
    _orbPerpO.copy(_orbAxisO).addScaledVector(dir, -_orbAxisO.dot(dir));
    if (_orbPerpO.lengthSq() < 1e-10) _orbPerpO.copy(perp); else _orbPerpO.normalize();
    const nO = clamp(Math.round(+state.rayVert.n) || 5, 3, RAY_VMAX + 1);
    const latsO = rayVertLats(nO);
    let midO = 0;
    for (let i = 1; i < nO; i++) if (Math.abs(latsO[i]) < Math.abs(latsO[midO])) midO = i;
    /* 中间那条（赤道 / 直射光线） */
    const latM = latsO[midO] * D;
    const offM = erW * Math.sin(latM), tipM = rl - erW * Math.cos(latM);
    const shaftLenM = Math.max(tipM - orbRayHeadLenW, 0.2);
    orbRayShaft.quaternion.setFromUnitVectors(YAX, dir);
    orbRayShaft.scale.set(RAY_R0 * kO, shaftLenM, RAY_R0 * kO);
    orbRayShaft.position.copy(_orbPerpO).multiplyScalar(offM).addScaledVector(dir, shaftLenM / 2);
    _orbHeadBase.copy(_orbPerpO).multiplyScalar(offM).addScaledVector(dir, tipM - orbRayHeadLenW * 0.5);
    orbRayHead.quaternion.setFromUnitVectors(YAX, dir);
    orbRayHead.position.copy(_orbHeadBase);
    /* 其余各条：按纬度纵向排布，箭杆末端截到自己箭头的尾端 */
    let jO = 0;
    for (let i = 0; i < nO; i++) {
      if (i === midO) continue;
      const sh = orbRayFieldShafts[jO], hd = orbRayFieldHeads[jO];
      if (!sh || !hd) break;
      jO++;
      const lat = latsO[i] * D;
      const off = erW * Math.sin(lat), tipD = rl - erW * Math.cos(lat);
      const tailD = Math.max(tipD - orbRayHeadLenW, 0.2);
      sh.visible = true; hd.visible = true;
      sh.quaternion.setFromUnitVectors(YAX, dir);
      sh.scale.set(RAY_R0 * kO, tailD, RAY_R0 * kO);
      sh.position.copy(_orbPerpO).multiplyScalar(off).addScaledVector(dir, tailD / 2);
      hd.quaternion.setFromUnitVectors(YAX, dir);
      hd.position.copy(_orbPerpO).multiplyScalar(off).addScaledVector(dir, tipD - orbRayHeadLenW * 0.5);
    }
    for (; jO < orbRayFieldShafts.length; jO++) {
      orbRayFieldShafts[jO].visible = false; orbRayFieldHeads[jO].visible = false;
    }
    // 天体注释（地表注释由 earthNotesPass 在渲染前按当前相机统一紧贴布局）
    // v21.0（需求⑦）：太阳 / 地球的名称标注已删除，这里不再摆放；
    //   仅保留「直射光线」标注（挂在轨道中点上方）。
    nRay.position.copy(P.clone().multiplyScalar(0.5)).add(new THREE.Vector3(0, 0.3, 0));
    // v28（需求③）：公转速度演示（近日点 / 远日点标记 + 单位时间扫过的面积）
    updateSpeedDemo();
  }
  function applyOrbit() {
    const o = state.orb;
    // 尺寸与距离比例（示意，可自由调节）
    const ER = ORB_E * o.earthScale;                           // 公转地球显示半径
    const sunR = 0.62 * o.sunScale;
    orbRig.scale.setScalar(ER);
    sunMesh.scale.setScalar(sunR / 0.62);
    syncOrbAtmo();                                             // 大气内外半径随地球大小比例同步
    const meanR = ORB_R * o.distScale;     // v28：这里改指**半长轴 a**（场景单位）
    orbRNow = meanR;
    /* v28（需求①）：离心率 / 近日点黄经按当前仿真时刻取值（都是极缓慢的量：离心率每世纪
       −0.000042、近日点黄经每世纪 +1.72°）。远日点距离 a(1+e) 供相机取景留白。
       ★与地球位置 / 节气标记 / 速度扇形**同一个入口** —— 详见 syncOrbShape 注释。 */
    syncOrbShape(meanR, (currentInfo || solarInfo(simMs)).T || 0);
    const LO = state.style.ln.orbit;
    orbitRing.visible = o.orbit.on;
    setTube(orbitRing.material, LO);
    /* 轨道环 = **椭圆**（太阳位于一个焦点）：几何按圆锥曲线逐点采样，随「日地距离」滑杆
       实时重建；地球球心必定严格落在这条线上。重建钥匙含半长轴 / 线宽 / 离心率 /
       近日点黄经（后者精度取到 1e-3°，即约 350 年一变）。 */
    const _periKey = Math.round(orbPeriLonNow * 1e5);
    if (_orbW !== LO.w || _orbRGeo !== meanR || _orbEc !== orbEccNow || _orbPk !== _periKey) {
      orbitRing.geometry.dispose();
      const pts = orbitPathPoints(meanR, orbEccNow, orbPeriLonNow, 512);
      const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
      orbitRing.geometry = new THREE.TubeGeometry(curve, 512, Math.max(LO.w, 0.0015), 8, true);
      _orbW = LO.w; _orbRGeo = meanR; _orbEc = orbEccNow; _orbPk = _periKey;
    }
    /* 焦点可视化：椭圆几何中心 = 焦点沿「远日点方向」外移 a·e；
       虚线连「太阳（焦点）→ 几何中心」，并放一个小球标出几何中心。
       v28 默认离心率是**真实值** 0.0167，偏移量只有半长轴的 1.67%（肉眼极难分辨）——
       靠这两样东西把「太阳在焦点、不在中心」变成可读的几何事实。 */
    if (orbCenterMark) {
      /* 椭圆几何中心：自焦点沿「远日点方向」外移 a·e（远日点本身在 a(1+e) 处，别混淆）。 */
      syncOrbFocus();
      orbCenterMark.visible = o.orbit.on && state.orb.focus.on;
      orbFocusLine.material.opacity = 0.55 * (state.orb.focus.op === undefined ? 1 : state.orb.focus.op);
      orbFocusLine.visible = o.orbit.on && state.orb.focus.on;
    }
    // 轨道装饰（二分二至 / 二十四节气标记 / 轨道标签）随椭圆半长轴 / 离心率 / 近日点黄经重排
    layoutOrbitDecor(meanR, orbEccNow, orbPeriLonNow);
    // 公转相机取景随"日地距离"等比放大，调整距离后地球仍在画面中、轨道完整可见
    orbitCam.far = 2000; orbitCam.near = 0.05;
    /* v20.0：相机距离不再被每次调参强制重置。
       旧写法 `orbView.tDist = orbView.dist = orbCamTDist()` 会在任何一次 applyAll（改任意参数、
       拖任意滑杆）时把公转相机拉回「默认日地距离对应的距离」，用户手动缩放的结果被丢弃，
       画面因此「闪一下变回默认日地距离」。现在只在「日地距离」本身变化时按比例缩放目标距离，
       用户自己的缩放倍率得以保留；orbAnnMul() 的注释尺寸补偿仍以 orbCamTDist() 为准。 */
    const dsNow = +state.orb.distScale || 1;
    if (_lastDistScale == null) _lastDistScale = dsNow;
    if (Math.abs(dsNow - _lastDistScale) > 1e-9) {
      const rate = dsNow / _lastDistScale;
      orbView.tDist *= rate; orbView.dist *= rate;
      _lastDistScale = dsNow;
    }
    const PT = state.style.pt;
    orbitTerms.visible = !!o.terms.on;
    termDotMatMain.color.set(PT.term.color); termDotMatMain.opacity = PT.term.op;
    orbitTerms.children.forEach(function (c, i) { if (i % 2 === 0) c.scale.setScalar(PT.term.size); });
    orbitTerms24.visible = !!(o.terms24 && o.terms24.on);
    termDotMat24.color.set(PT.term24.color); termDotMat24.opacity = PT.term24.op;
    orbitTerms24.children.forEach(function (c, i) { if (i % 2 === 0) c.scale.setScalar(PT.term24.size); });
    orbNotes.visible = true;   // 公转注释的显隐同样交给总开关 / 分类开关
    /* 公转直射光线：与自转视图共用同一套样式（v20.0 统一）
       —— 线颜色 / 透明度 / 线型（实线·虚线）/ 虚线密度 / 虚实比 / 箭头颜色·大小 全部一致。
       杆长随日地距离变化，故先刷新杆长再写样式（虚线密度按杆长换算）。 */
    shaftMatsO.forEach(function (it) { it.len = meanR; });
    applyRayStyle();
    const rayShow = state.rays && !!o.ray.on;
    orbRayGroup.visible = rayShow;
    orbRayField.visible = rayShow && !state.raysCenter;   // 「只显示直射光线」时隐藏平行光场
    // 重要纬线：与自转视图共用同一组开关 / 颜色 / 粗细 / 虚线样式
    // v23.0（需求②）：同自转视图 —— 特殊经纬线受「经纬网总开关」约束
    const gratOnO = !!state.graticule;
    bandEqOrb.visible = gratOnO && state.eq.on; setBand(bandEqOrb.material, state.style.ln.eq, state.style.ln.eq.dash === 'dash');
    bandTrNOrb.visible = bandTrSOrb.visible = gratOnO && state.tr.on;
    setBand(bandTrNOrb.material, state.style.ln.tr, true); setBand(bandTrSOrb.material, state.style.ln.tr, true);
    bandArNOrb.visible = bandArSOrb.visible = gratOnO && state.ar.on;
    setBand(bandArNOrb.material, state.style.ln.ar, true); setBand(bandArSOrb.material, state.style.ln.ar, true);
    // 温度带（公转地球）：五带统一着色（v23.0：分界描边已取消）
    applyZoneSet(zO);
    // 地轴 / 直射点 / 经纬网 / 云层 / 大气 / 夜灯（全视图统一）
    axisOrbGroup.visible = state.axis;
    subOrbGroup.visible = state.sub;
    graticuleOrb.visible = state.graticule;
    // v27.4（修复）：与自转场景同 —— 云层 / 大气 / 夜灯 / 极光一并门控到「显示真实地球」总开关
    const _rtO = !!state.realTex;
    cloudsOrb.visible = _rtO && state.clouds;
    atmosphereOrb.visible = _rtO && state.atmo;
    earthMatOrb.uniforms.uAuroraOn.value = (_rtO && state.aurora) ? 1 : 0;   // 极光显隐
    earthMatOrb.uniforms.uAuroraStr.value = state.auroraBright;    // 极光亮度
    earthMatOrb.uniforms.uHasNight.value = (_rtO && state.night) ? 1 : 0;
    earthMatOrb.uniforms.uHasClouds.value = (_rtO && state.clouds) ? 1 : 0;
    // 极昼极夜
    const showCap = state.polar;
    capDayOrb.visible = showCap && state.pd.on;
    strokeDayOrb.visible = showCap && state.pd.on && !!state.style.fill.pd.stroke.on;
    capNightOrb.visible = showCap && state.pn.on;
    strokeNightOrb.visible = showCap && state.pn.on && !!state.style.fill.pn.stroke.on;
    capMatDayOrb.uniforms.uColor.value.set(state.style.fill.pd.fill);
    capMatDayOrb.uniforms.uOpacity.value = state.style.fill.pd.op;
    capMatDayOrb.uniforms.uPattern.value = patternId(state.style.fill.pd.pattern);
    setTube(strokeDayOrb.material, state.style.fill.pd.stroke);
    capMatNightOrb.uniforms.uColor.value.set(state.style.fill.pn.fill);
    capMatNightOrb.uniforms.uOpacity.value = state.style.fill.pn.op;
    capMatNightOrb.uniforms.uPattern.value = patternId(state.style.fill.pn.pattern);
    setTube(strokeNightOrb.material, state.style.fill.pn.stroke);
  }

  /* ============ 相机控制 ============ */
  const view = { theta: 0, phi: 0, dist: 3.1, tTheta: 0, tPhi: 0, tDist: 3.1 };
  function setViewFromVec(v) {
    const d = v.length();
    view.dist = view.tDist = d;
    view.phi = view.tPhi = Math.acos(clamp(v.y / d, -1, 1));
    view.theta = view.tTheta = Math.atan2(v.z, v.x);
  }
  const VIEW_DEFAULT = new THREE.Vector3(0.34, 0.28, 0.895).normalize().multiplyScalar(4.35);
  // 赤道上空：相机位于世界 +Z，太阳（+X）恰好位于屏幕右侧
  const VIEW_EQUATOR = new THREE.Vector3(0, 0, 1).normalize().multiplyScalar(4.1);
  function applyView(v) { setViewFromVec(v); updateCamera(); }
  setViewFromVec(VIEW_DEFAULT);

  /* ===== v23.8：地球 / 公转轨道「随演示窗口自适应」 =====
     相机距离原先是写死的（自转 4.35、公转 9.0）：宽屏桌面上取景正好；换成竖屏手机、
     平板、窄演示窗口时，透视相机的「横向视场」随宽高比同步变窄，地球 / 公转轨道会被
     左右切掉一截。这里只在「当前渲染窗口装不下」时把相机等比后退到刚好装得下的距离：
       · 补偿倍率恒 ≥ 1，够用时为 1 —— 桌面端渲染结果与改动前完全一致；
       · 滚轮 / 双指缩放依旧作用在原来的 tDist 上，二者互不干扰。 */
  const MAIN_BASE_D = VIEW_DEFAULT.length();     // 自转基准距离（4.35）
  const ORB_BASE_D = 9.0;                        // 公转基准距离（原默认 dist）
  const FIT_R_MAIN = 1.22;                       // 自转取景半径（地球本体 + 地表注释壳层）
  /* 透视相机「刚好装下半径 rH 的场景」所需的距离：横向、竖直分别验算取大者。
     vRatio = 场景在屏幕竖直方向的压扁比（俯视一个平面圆时 < 1；球体为 1）。 */
  function perspFitMul(baseDist, rH, rw, rh, fovDeg, vRatio) {
    if (!(rw > 8) || !(rh > 8)) return 1;
    const hv = fovDeg * D * 0.5;                        // 竖直半视场（弧度）
    const hh = Math.atan(Math.tan(hv) * (rw / rh));     // 横向半视场（随宽高比变化）
    const needH = rH / Math.sin(hh);
    const needV = rH * (vRatio == null ? 1 : vRatio) / Math.sin(hv);
    return Math.max(1, Math.max(needH, needV) / baseDist);
  }
  // 当前帧「自转主视角 / 公转视角」实际被渲染到的矩形（单窗 / 三窗 / 综合视图各不相同）
  function mainViewRect() {
    if (state.view === 'combo') {
      const r = cmbLayout.main;
      return (r && r.h - r.head > 8) ? { w: r.w, h: r.h - r.head } : null;
    }
    return layout.main;
  }
  function orbRenderRect() {
    if (state.view === 'combo') {
      const r = cmbLayout.orbit;
      return (r && r.h - r.head > 8) ? { w: r.w, h: r.h - r.head } : null;
    }
    return orbitViewRect();
  }

  function updateCamera() {
    view.theta = lerp(view.theta, view.tTheta, 0.16);
    view.phi = lerp(view.phi, view.tPhi, 0.16);
    view.dist = lerp(view.dist, view.tDist, 0.14);
    const sp = Math.sin(view.phi);
    // v23.8：窗口太窄装不下时等比后退（宽够时倍率为 1，与原先完全一致）
    const mr = mainViewRect();
    const md = view.dist * (mr ? perspFitMul(MAIN_BASE_D, FIT_R_MAIN, mr.w, mr.h, camera.fov, 1) : 1);
    camera.position.set(
      md * sp * Math.cos(view.theta),
      md * Math.cos(view.phi),
      md * sp * Math.sin(view.theta)
    );
    camera.lookAt(0, 0, 0);
  }

  // 公转视角：自由环绕相机（拖动旋转 / 滚轮缩放），用于公转视图与综合视图左上窗
  // 默认视角：从北天极侧上方俯视（屏幕右 = 世界 +X），
  // 于是二分二至呈：春分上 · 夏至左 · 秋分下 · 冬至右，绕行为逆时针（自西向东）
  const orbView = { theta: Math.PI / 2, phi: 0.52, dist: 9.0, tTheta: Math.PI / 2, tPhi: 0.52, tDist: 9.0 };
  /* ===== v23.17：公转动画的第二种镜头「地球特写」 =====
     需求：镜头聚焦地球并随地球公转同步移动，地球始终在画面内、可缩放、太阳直射点保持在
     画面中心附近、视角相对地球保持稳定不动（便于观察直射点的运动）。
     做法：
       · 注视点 = 地球球心（orbRig.position），相机随之公转同步平移；
       · 相机方向以「地心 → 太阳」为基准轴 U（默认正对直射点 → 直射点在画面正中），
         再用 yaw / pitch 在其正交基上偏移（用户拖拽），up 取地轴在 ⊥U 面内的分量
         —— 地轴恒在画面里竖直朝上，地球不会翻滚，与自转/公转相位无关；
       · 距离 = zoom ×「刚好装下整颗地球」的取景距离（按窗口宽高比验算），
         故缩放范围内地球始终完整落在画面里；同时尽量把相机留在「太阳与地球之间」，
         免得太阳挡住视线。 */
  /* v25.1（需求①）：**增大缩放上下限范围** ——
       下限 0.55 → 0.13（可贴近地表细看直射点附近的地形）；
       上限 3.0 → 9.0（可退远把地球看得更小；实际可用距离仍受「不越过太阳 / 不与太阳重叠」限制）。
     防穿模由 updateOrbCamClose 里的「与球心最小距离」+「动态近裁剪面」两道约束共同保证。 */
  const ORB_CLOSE_DEF = 1.22, ORB_CLOSE_MIN = 0.13, ORB_CLOSE_MAX = 9.0;
  /* v28（需求②）：俯仰上限 —— 取 74.5°（1.30 rad）。
     不能放到 ±90°：那里「画面上方」（地轴在 ⊥U 面内的分量）与视线方向重合，正交基退化，
     画面会毫无预告地翻滚（这正是用户报告的「视角错误」之一）。74.5° 已能看到极地附近，
     且与视线始终留有 15.5° 夹角，几何稳定。 */
  const ORB_CLOSE_PITCH_MAX = 1.30;
  /* v23.18（需求⑤）：特写的「默认视角」（底部「默认视角」按钮的重置目标）——
     相机在「地心 → 太阳」轴（U）的正交基上偏移：E1 = 东、E2 = 北、U = 地心→太阳。
       · yaw > 0 → 相机偏东 → 画面中心（正对相机的地表点）落在直射点的**西**侧；
       · pitch < 0 → 相机偏南 → 画面中心落在直射点的**北**侧；
     合起来即「相机视角中心位于太阳直射点位置的西北侧」。 */
  const ORB_CLOSE_DEF_YAW = 15 * D, ORB_CLOSE_DEF_PITCH = -9 * D;
  const orbClose = {
    yaw: ORB_CLOSE_DEF_YAW, pitch: ORB_CLOSE_DEF_PITCH, dist: ORB_CLOSE_DEF,
    tYaw: ORB_CLOSE_DEF_YAW, tPitch: ORB_CLOSE_DEF_PITCH, tDist: ORB_CLOSE_DEF,
    dwNow: 0,          // v28：上一帧实际使用的相机距离（世界单位）—— 拖动开始时锁定它
  };
  /* v28（需求②）：拖动期间锁定的相机距离（null = 未拖动）。锁定后「拖方向」与「调缩放」
     彻底分离 —— 拖动不会顺带改变远近，杜绝「缩放后拖动错位 / 画面边拖边缩放」。 */
  let orbCloseLock = null;
  /* v28（需求②）：当前朝向下的可用缩放倍率区间（由 updateOrbCamClose 在非拖动状态下刷新）。
     滚轮 / 捏合按它收口，使缩放到底就是真的到底（旧写法只按 ORB_CLOSE_MIN/MAX 收口，
     实际距离还被方向相关的约束进一步压缩 → 手感「缩不动了但滑条还在走」）。 */
  const orbCloseFit = { fit: 1, tMin: ORB_CLOSE_MIN, tMax: ORB_CLOSE_MAX };
  function orbCloseMode() { return state.view === 'revolve' && state.orbCam === 'close'; }
  function resetOrbCam() {
    orbView.tTheta = Math.PI / 2; orbView.tPhi = 0.52; orbView.tDist = 9.0;
    orbClose.tYaw = ORB_CLOSE_DEF_YAW; orbClose.tPitch = ORB_CLOSE_DEF_PITCH;
    orbClose.tDist = ORB_CLOSE_DEF;
    orbCloseLock = null;                 // v28：复位时一并解除拖动距离锁定
  }
  /* v23.18（需求①）／ v29（需求②）：给定相机方向 dir 与地心 P，求「相机落点沿 dir 距地心
     P 多远会进入 / 离开太阳球」—— 返回 { dNear, dFar }（进入 / 离开临界距离，均 >0 时有效），
     或 null（该方向线不穿过太阳球）。太阳球心在公转场景原点，半径 sunR。
     旧写法在此直接把 dw 上限卡在 dNear，使相机永远停在太阳前侧、无法绕到其后方
     （太阳处于相机与地球之间时太阳反而不可见、只剩地球）。
     v29：此处不再封顶，真正的「禁止落在太阳球内部」交给 updateOrbCamClose 的「跳过内部」处理。 */
  function orbSunHit(dir, P) {
    const sunR = 0.62 * ((state.orb && state.orb.sunScale) || 1) + 0.12;   // 太阳半径 + 安全余量
    const k = P.dot(dir);
    const disc = k * k - (P.lengthSq() - sunR * sunR);
    if (disc <= 1e-9) return null;     // 该方向线不穿过太阳球（背离太阳一侧），无需限制
    const sr = Math.sqrt(disc);
    return { dNear: -k - sr, dFar: -k + sr };  // 近侧 / 远侧入球临界距离
  }
  /* v23.18（需求①）：太阳光晕（Sprite）不再因「特写」而整体隐藏，改为按「相机到太阳中心
     的距离」淡出 —— 只有相机贴近 / 进入太阳球体时才隐去光晕（否则光晕会糊满整个画面）。 */
  function syncSunHalo() {
    if (!sunHalo) return;
    const sunR = 0.62 * ((state.orb && state.orb.sunScale) || 1);
    const d = orbitCam.position.length();
    const t = clamp((d - sunR) / Math.max(sunR * 0.65, 1e-3), 0, 1);
    sunHalo.material.opacity = t;
    sunHalo.visible = t > 0.02;
  }
  /* v23.18（需求①）：特写相机的第二个距离约束 —— 太阳与地球在画面上**不重叠**。
     相机越退越远，太阳越来越小、但太阳中心越来越靠近视线，到某个距离后太阳盘就会压住
     地球盘（实测 5.5× 取景距离时太阳正好糊在地球上）。这里求 f(d) = 两盘中心夹角 −
     两盘角半径之和 的零点（f 在可用区间上单调递减，直接二分即可）。
     若全程都不重叠（例如相机背对太阳）则返回 Infinity。 */
  function orbCloseSkyLimit(fit, P, dir, dwMin) {
    const R0 = P.length();
    if (R0 < 1e-6) return Infinity;
    const cosT = -dir.dot(P) / R0;                        // dir 与「地心 → 太阳」（U）的夹角余弦
    const ER = ORB_E * ((state.orb && state.orb.earthScale) || 1);
    const sunR = 0.62 * ((state.orb && state.orb.sunScale) || 1);
    const MARGIN = 0.06;                                  // 两盘之间再留约 3.4° 空隙
    const f = function (d) {
      const c = Math.sqrt(Math.max(d * d - 2 * R0 * d * cosT + R0 * R0, 1e-9));   // |相机|
      const ang = Math.acos(clamp((d - R0 * cosT) / c, -1, 1));                   // 两盘中心夹角
      const angS = Math.asin(clamp(sunR / c, -1, 1));                             // 太阳盘角半径
      const angE = Math.asin(clamp(ER / Math.max(d, 1e-6), -1, 1));               // 地球盘角半径
      return ang - (angS + angE);
    };
    /* 可用距离区间取「缩放下限」与「不穿进球体的最小距离」二者的较大值 —— 与
       updateOrbCamClose 的 dwMin 完全同口径，否则二分区间会把相机放进球体内部。 */
    const lo = Math.max(fit * ORB_CLOSE_MIN, dwMin || 0), hi = fit * ORB_CLOSE_MAX;
    /* v25.1（需求①）：把「两盘不重叠」当成一条**单调递增**的约束来解 ——
       相机沿固定方向后退时，太阳盘与地球盘的角半径都在缩小、而两盘中心的夹角收敛得更快，
       故 f(d) 随 d 单调递增（越远越分开）。由此只需看区间两端：
         · f(lo) > MARGIN —— 连最近处都已分开 ⇒ 全程无约束，返回 Infinity；
         · f(hi) ≤ MARGIN —— 最远处仍不够分开 ⇒ 区间内无解，真正的可行上限就是 hi 本身，
                              同样返回 Infinity（不额外限制）。旧版这里会一路二分到返回 lo，
                              于是「缩放被钉死在最近处」——正是用户反馈的背光侧无法拉远。 */
    if (f(lo) > MARGIN) return Infinity;
    if (f(hi) <= MARGIN) return Infinity;
    let a = lo, b = hi;
    for (let i = 0; i < 18; i++) {
      const m = (a + b) * 0.5;
      if (f(m) > MARGIN) a = m; else b = m;
    }
    return a;
  }
  const _ocA = new THREE.Vector3(), _ocU = new THREE.Vector3(), _ocE1 = new THREE.Vector3();
  const _ocE2 = new THREE.Vector3(), _ocDir = new THREE.Vector3();
  function updateOrbCamClose() {
    orbClose.yaw = lerp(orbClose.yaw, orbClose.tYaw, 0.18);
    orbClose.pitch = lerp(orbClose.pitch, orbClose.tPitch, 0.18);
    orbClose.dist = lerp(orbClose.dist, orbClose.tDist, 0.14);
    const P = orbRig.position;                                  // 地球球心（世界）
    _ocU.copy(orbSunDir);                                       // 地心 → 太阳（单位向量）
    if (_ocU.lengthSq() < 1e-9) _ocU.set(1, 0, 0); else _ocU.normalize();
    // 地轴世界方向（tiltOrb 只绕 z 转 -ε，orbRig 无旋转）→ 取它在 ⊥U 面内的分量作「画面上方」
    _ocA.set(Math.sin(OBLIQ), Math.cos(OBLIQ), 0);
    _ocE2.copy(_ocA).addScaledVector(_ocU, -_ocA.dot(_ocU));
    if (_ocE2.lengthSq() < 1e-8) _ocE2.set(0, 1, 0);
    _ocE2.normalize();
    _ocE1.copy(_ocE2).cross(_ocU).normalize();                  // 右手正交基 (E1, E2, U)
    const cy = Math.cos(orbClose.yaw), sy = Math.sin(orbClose.yaw);
    const cp = Math.cos(orbClose.pitch), spp = Math.sin(orbClose.pitch);
    _ocDir.copy(_ocU).multiplyScalar(cp * cy)
      .addScaledVector(_ocE1, cp * sy)
      .addScaledVector(_ocE2, spp).normalize();
    // 「刚好装下整颗地球」的距离（含窗口宽高比修正）；fitMul 与 perspFitMul 同一口径
    const ERw = ORB_E * ((state.orb && state.orb.earthScale) || 1);
    const orr = orbRenderRect();
    let fit = ERw * 1.04 / Math.sin(orbitCam.fov * D * 0.5);
    if (orr && orr.w > 8 && orr.h > 8) {
      const hv = orbitCam.fov * D * 0.5;
      const hh = Math.atan(Math.tan(hv) * (orr.w / orr.h));
      fit = ERw * 1.04 / Math.sin(Math.min(hv, hh));
    }
    fit = Math.max(fit, 1e-3);
    /* 距离 = 缩放倍率 × 取景距离（取景距离按窗口宽高比验算 → 缩放区间内地球始终在画面内）。
       v25.1（需求①）：缩放区间由 0.55×~3× 放宽到 ORB_CLOSE_MIN=0.13×~ORB_CLOSE_MAX=9×，
       实际可用的下限 / 上限再被两个安全约束收窄：
         ① 相机不进入太阳球体（越过太阳会被太阳挡住视线）；
         ② 太阳盘与地球盘在画面上不重叠。
       于是太阳本体始终完好地留在场景里，且不会与地球相互遮挡。 */
    /* v28（需求②）：防「穿模」—— 下限由「球壳最外层」决定，而不是只看地球本体。
       场景里地球外面还套着三层可见球壳：海陆/大洲层 1.0018、云层 1.006、大气辉光 1.048
       （均为地球半径的倍数）。旧代码把下限设成 1.03×地球半径，正好落在大气壳（1.048）
       **内部** —— 相机从大气球壳里向外看，表现就是用户报告的「穿模 / 错误的夜半球地球」。
       现在按「当前实际可见的最外壳 + 2% 余量」定下限，并把近裁剪面同步收紧：贴地观察时
       地表不会被近平面切掉。 */
    const shellK = Math.max(1.0018,
      (state.realTex && state.clouds) ? 1.006 : 1,
      (state.realTex && state.atmo) ? ATMO_ROUT : 1);
    const ocClear = ERw * (shellK + 0.02);
    const dwMin = Math.max(fit * ORB_CLOSE_MIN, ocClear);
    /* 硬约束：相机不得进入太阳球体（否则视线被太阳本体挡住，等于穿模）。
       软约束：太阳盘与地球盘在画面上不重叠 —— 它是**观感**约束，只在用户主动缩放时生效。
       ★「拖动时冻结距离」：拖动期间相机距离锁定为本次拖动开始时的值（仅受硬约束收窄），
       于是「拖方向」绝不会顺带改变「缩放」。旧写法每帧都按当前朝向重算软约束 → 拖动时
       距离被约束推着变，画面边拖边缩放，正是用户报告的「缩放后拖动错位」。 */
    const sunHit = orbSunHit(_ocDir, P);
    const dwHardMax = Infinity;   // 允许相机越过太阳停在后方；球体内部由下方「跳过内部」排除
    const dwSoftMax = Math.max(dwMin,
      Math.min(fit * ORB_CLOSE_MAX, dwHardMax, orbCloseSkyLimit(fit, P, _ocDir, dwMin)));
    let dw;
    if (orbCloseLock !== null) {
      // 拖动中：距离锁定（只受硬约束收窄）→ 拖方向绝不改变缩放
      dw = clamp(orbCloseLock, dwMin, dwHardMax);
    } else {
      dw = clamp(orbClose.dist * fit, dwMin, dwSoftMax);
      /* 供滚轮 / 捏合使用的「当前朝向下的可用缩放倍率区间」——
         有了它，缩放滑到底就真正到底（不会出现「手感缩到底了、再往回缩好几格才动」）；
         且只在**用户主动缩放**时读用，拖动永远不会读到它 → 不产生漂移。 */
      orbCloseFit.fit = fit;
      orbCloseFit.tMin = Math.max(ORB_CLOSE_MIN, ocClear / fit);
      orbCloseFit.tMax = Math.max(orbCloseFit.tMin, Math.min(ORB_CLOSE_MAX, dwHardMax / fit));
    }
    /* v29（需求②）：若相机落点落在太阳球内部（dNear < dw < dFar），越过到远侧出球面 dFar，
       保证太阳以正常正面显示（不再因停在球内部、背面剔除而只剩地球）。 */
    if (sunHit && sunHit.dNear > 0 && dw > sunHit.dNear && dw < sunHit.dFar) dw = sunHit.dFar;
    orbClose.dwNow = dw;                     // 供「拖动开始」时锁定
    /* 近裁剪面：与「相机到最近球壳表面的距离」挂钩（留 1/3 余量），既不会切掉地表，
       也不会把近平面放到球壳之外。 */
    const gap = Math.max(Math.abs(dw) - ocClear, ERw * 0.002);
    const nearWant = clamp(Math.min(dw * 0.012, gap * 0.35), 0.0015, 0.05);
    if (Math.abs(orbitCam.near - nearWant) > 1e-6) {
      orbitCam.near = nearWant; orbitCam.updateProjectionMatrix();
    }
    orbitCam.position.copy(P).addScaledVector(_ocDir, dw);
    orbitCam.up.copy(_ocE2);
    orbitCam.lookAt(P);
    if (sunMesh) sunMesh.visible = true;         // v23.18（需求①）：太阳必须保留显示
    syncSunHalo();
    /* v23.17：文字注释的世界尺寸按「实际相机距离 / 全局视角的基准距离」等比缩小 ——
       特写把地球放大了约 4 倍，注释若沿用原尺寸就会糊满整个球面；缩小后屏幕字号恒定。 */
    orbNoteK = clamp(dw / Math.max(orbCamTDist(), 0.5), 0.22, 1);
  }
  function updateOrbCam() {
    if (orbCloseMode()) { updateOrbCamClose(); return; }
    if (sunMesh) sunMesh.visible = true;
    // v25.1（需求①）：全景视角恢复默认近裁剪面（特写会把它收紧，切回来必须还原）
    if (Math.abs(orbitCam.near - 0.05) > 1e-6) { orbitCam.near = 0.05; orbitCam.updateProjectionMatrix(); }
    orbNoteK = 1;                       // 全景视角：注释用回原尺寸（v23.17）
    orbView.theta = lerp(orbView.theta, orbView.tTheta, 0.16);
    orbView.phi = lerp(orbView.phi, orbView.tPhi, 0.16);
    orbView.dist = lerp(orbView.dist, orbView.tDist, 0.14);
    const sp = Math.sin(orbView.phi);
    // v23.8：同上 —— 保证整条轨道（含二分二至标记）始终完整落在窗口内。
    //   俯视时轨道圆在屏幕竖直方向被压扁为 cos(phi)，故竖直方向按该比例验算。
    const orr = orbRenderRect();
    // v28：取景半径用**远日点**距离 —— 太阳在焦点上，离太阳最远的点正是远日点 a(1+e)，
    //   按它留白才能保证整条椭圆（含远日点标记）都落在窗口内。
    const oR = orbRFar * 1.13 + ORB_E * ((state.orb && state.orb.earthScale) || 1) * 0.6 + 0.5;
    const omul = orr ? perspFitMul(ORB_BASE_D, oR, orr.w, orr.h, orbitCam.fov, Math.max(0.3, Math.cos(orbView.phi))) : 1;
    const od = orbView.dist * omul;
    orbitCam.position.set(
      _orbTarget.x + od * sp * Math.cos(orbView.theta),
      _orbTarget.y + od * Math.cos(orbView.phi),
      _orbTarget.z + od * sp * Math.sin(orbView.theta)
    );
    orbitCam.lookAt(_orbTarget);
    syncSunHalo();
  }

  // 鼠标交互
  const layout = { main: null, north: null, south: null };
  let drag = null;       // 自转主视角拖动
  let orbDrag = null;    // 公转视角拖动
  // 当前视图中"公转相机"对应的可交互矩形（公转视图整屏 / 综合视图左上窗）
  /* v20.0（需求⑧ 配套）：公转视图的可视矩形改为「上让开标题栏、下让开底部工具条」。
     原先占满整窗高度，轨道近端的地球正好落在底部工具条后面、下半球被挡住，
     公转地球看不出与自转地球"表面一致"。现在把可视区收到工具条上沿，地球完整可见。
     渲染、拾取、拖动三处必须用同一矩形，故统一由此函数给出。 */
  function orbitViewRect() {
    const w = window.innerWidth, h = window.innerHeight;
    let bot = h;
    if (!IMMERSIVE) {
      const cb = $('controlBar');
      if (cb) {
        const r = cb.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top > h * 0.5) bot = Math.min(bot, Math.round(r.top));
      }
    }
    /* v26.1（需求⑪）：窗口顶部与页面最顶部的标题栏之间留出空隙 ——
       与自转视图（三窗 top = TITLE_H + pad）、综合视图（y = TITLE_H + COMBO_PAD）
       同一个 8px 间距；此前公转视图直接贴着标题栏（间距 0），三个视图不一致。 */
    const pad = IMMERSIVE ? 0 : 8;
    const top = TITLE_H + pad;
    return { x: 0, y: top, w: w, h: Math.max(160, bot - top) };
  }
  function orbCellRect() {
    if (state.view === 'revolve') return orbitViewRect();
    if (state.view === 'combo' && cmbLayout.orbit && cmbLayout.orbit.h > COMBO_HEAD_H)
      return { x: cmbLayout.orbit.x, y: cmbLayout.orbit.y + COMBO_HEAD_H, w: cmbLayout.orbit.w, h: cmbLayout.orbit.h - COMBO_HEAD_H };
    return null;
  }
  // 综合视图中指针所在子窗口
  function comboPaneAt(x, y) {
    const keys = ['orbit', 'main', 'sub', 'north', 'south'];
    for (let i = 0; i < keys.length; i++) {
      const r = cmbLayout[keys[i]];
      if (r && r.h > COMBO_HEAD_H && inRect(x, y, { x: r.x, y: r.y + COMBO_HEAD_H, w: r.w, h: r.h - COMBO_HEAD_H })) return keys[i];
    }
    return null;
  }
  canvas.addEventListener('pointerdown', function (e) {
    const or = orbCellRect();
    if (or && inRect(e.clientX, e.clientY, or)) {
      orbDrag = { x: e.clientX, y: e.clientY, close: orbCloseMode() };
      // v28（需求②）：特写镜头在「按下」的一刻锁定相机距离 —— 整个拖动过程只改朝向，
      //   缩放由滚轮 / 捏合单独控制。这样「拖动」与「缩放」互不干扰，不再出现拖动时画面缩放漂移。
      if (orbDrag.close) orbCloseLock = orbClose.dwNow || null;
      // v23.8：与另外两条分支一致地容错 —— 多指触摸时若该指针已被浏览器回收，
      //   setPointerCapture 会抛异常并中断本处理器（拖动吸附会随之失效）。
      try { canvas.setPointerCapture(e.pointerId); } catch (e2) { /* 合成/已失效指针 */ }
      canvas.classList.add('grabbing');
      return;
    }
    if (state.view === 'combo') {
      // 综合视图：仅侧视窗内可拖动旋转自转视角
      const m = cmbLayout.main;
      const mr = m ? { x: m.x, y: m.y + COMBO_HEAD_H, w: m.w, h: m.h - COMBO_HEAD_H } : null;
      if (!mr || !inRect(e.clientX, e.clientY, mr)) return;
      drag = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch (e2) { /* 合成/已失效指针 */ }
      canvas.classList.add('grabbing');
      return;
    }
    if (layout.main && !(e.clientX >= layout.main.x && e.clientX <= layout.main.x + layout.main.w &&
      e.clientY >= layout.main.y && e.clientY <= layout.main.y + layout.main.h)) return;
    drag = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (e2) { /* 合成/已失效指针 */ }
    canvas.classList.add('grabbing');
  });
  window.addEventListener('pointerup', function (e) {
    drag = null; orbDrag = null;
    /* v28（需求②）：松开手时把**缩放目标**同步为「本次拖动实际显示的距离」，
       而不是把画面拉回拖动前的目标值 —— 否则只要当前朝向的距离约束（例如
       「太阳盘与地球盘不重叠」）在拖动中收紧过，松手瞬间画面就会突然跳一下，
       表现为「拖完之后画面又变了 / 好像回弹」。fit 在拖动期间不会被改写
       （只在非拖动分支里刷新），故用它反算倍率是安全的。 */
    if (orbCloseLock !== null && orbCloseFit.fit > 1e-6) {
      orbClose.tDist = clamp(orbClose.dwNow / orbCloseFit.fit, orbCloseFit.tMin, orbCloseFit.tMax);
    }
    orbCloseLock = null;
    orbClose.dist = orbClose.tDist;      // 平滑值归位到目标值，避免松手后相机再「追」一下
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove('grabbing');
  });
  window.addEventListener('pointermove', function (e) {
    if (orbDrag) {
      /* v28（需求②）：拖动灵敏度一律按「该窗口的实际高度」折算，不再用 window.innerHeight ——
         综合视图左上窗只有整窗的几分之一高，用整窗高度会让特写在那个窗口里格外迟钝。 */
      const orrK = orbRenderRect();
      const pH = (orrK && orrK.h > 40) ? orrK.h : Math.max(260, window.innerHeight);
      if (orbDrag.close) {
        /* ===== v28（需求②）：★特写镜头的「1:1 跟手」灵敏度（严格推导，不是经验值） =====
           设相机在球心距 dw 处（透视焦距 f = (H/2)/tan(fov/2) 像素），地球半径 R = ERw。
           球面上与视线夹角 θ 的点，其屏幕横坐标（以小角近似，θ 从视轴量起）为：
               x(θ) = f · R·sinθ / (dw − R·cosθ)      →      dx/dθ |₀ = f·R / (dw − R)
           相机绕球心转过 δψ 时，该点相对视轴的夹角变化 −δψ，于是画面位移
               Δx = −(dx/dθ)·δψ = −f·R·δψ/(dw − R)
           令「画面位移 = 光标位移」（内容 1:1 跟手，与地图 / 看图软件一致）即得
               δψ = −dx · (dw − R) / (f·R)
                  = −dx · 2·tan(fov/2) · (dw − R) / (R · H)
           ★关键在于因子 (dw − R)/R —— 它正是「缩放倍率」的体现：相机贴到地表时该因子趋近 0
           （稍微一转地表就跑很远，灵敏度必须极小）；退远时该因子变大（要转很多才动）。
           这就是「缩放后拖动错位 / 灵敏度异常」的根因 ——
           旧写法 δψ = dx·2π/H 是个与缩放、与窗口尺寸都无关的**常数**，
           默认取景下比正确值快约 3.3 倍（拖 400 px 画面要转 205°），越放大越抓不住。
           ★方向：yaw 增大 = 相机向东移 = 画面内容向西走，故水平必须取负号，
           让「向右拖 → 内容向右移动」，与自转视图 / 公转全景同一约定（内容随光标）；
           纵向同理（向下拖 = 相机北移 = 内容向下走），取正号，与全景一致。 */
        const dwNow = Math.max(orbClose.dwNow || 0, 1e-4);
        const ERwK = ORB_E * ((state.orb && state.orb.earthScale) || 1);
        const spanK = Math.max(dwNow - ERwK, ERwK * 0.02);   // (dw − R)，贴地时给 2% 半径的保底
        const k = 2 * Math.tan(orbitCam.fov * D * 0.5) * spanK / Math.max(ERwK * pH, 1e-6);
        orbClose.tYaw -= (e.clientX - orbDrag.x) * k;
        orbClose.tPitch = clamp(orbClose.tPitch + (e.clientY - orbDrag.y) * k, -ORB_CLOSE_PITCH_MAX, ORB_CLOSE_PITCH_MAX);
      } else {
        const k = TWO_PI / clamp(pH, 260, 1400);
        orbView.tTheta += (e.clientX - orbDrag.x) * k;
        orbView.tPhi = clamp(orbView.tPhi - (e.clientY - orbDrag.y) * k, 0.05, Math.PI - 0.05);
      }
      orbDrag.x = e.clientX; orbDrag.y = e.clientY;
      return;
    }
    if (!drag) return;
    const k = TWO_PI / clamp(layout.main ? layout.main.h : window.innerHeight, 260, 1400);
    // 向右拖，地球跟着向右转；向下拖，地球跟着向下转（与鼠标同向）
    view.tTheta += (e.clientX - drag.x) * k;
    view.tPhi = clamp(view.tPhi - (e.clientY - drag.y) * k, 0.06, Math.PI - 0.06);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    const k = Math.exp(clamp(e.deltaY, -120, 120) * 0.0016);
    // 公转视角（公转视图整屏 / 综合视图左上窗）
    const or = orbCellRect();
    if (or && inRect(e.clientX, e.clientY, or)) {
      // 演示模式：缩放范围随日地距离放宽（dMax 至少能看全整条轨道）
      // v28（需求②）：按「当前朝向下的实际可用区间」收口 —— 缩到底就是真的到底，
      //   不会出现「手感已经缩到极限、滑条却还在走」的错位感。
      if (orbCloseMode()) { orbClose.tDist = clamp(orbClose.tDist * k, orbCloseFit.tMin, orbCloseFit.tMax); return; }
      const dMin = 3.2, dMax = Math.max(40, orbRFar * 4);
      orbView.tDist = clamp(orbView.tDist * k, dMin, dMax);
      return;
    }
    if (state.view === 'combo') {
      const p = comboPaneAt(e.clientX, e.clientY);
      if (p === 'north') camNZoom = clamp(camNZoom / k, 0.55, 3.2);
      else if (p === 'south') camSZoom = clamp(camSZoom / k, 0.55, 3.2);
      // v21.0（需求①）：「直射点回归运动」窗口内容可缩放（滚轮等比缩放，0.35×–6×）
      else if (p === 'sub') { subZoom = clamp(subZoom / k, 0.35, 6); syncSubCam(subCam); }
      else if (p === 'main') view.tDist = clamp(view.tDist * k, 1.6, 16);
      return;
    }
    const n = hitPane(e.clientX, e.clientY);
    if (n === 'north') camNZoom = clamp(camNZoom / k, 0.55, 3.2);
    else if (n === 'south') camSZoom = clamp(camSZoom / k, 0.55, 3.2);
    else view.tDist = clamp(view.tDist * k, 1.6, 16);
  }, { passive: false });

  /* ★ 本次可访问性修复：#gl 画布键盘可达 —— 焦点落在画布上时，方向键旋转视角、
     +/− / PageUp / PageDown 缩放。复用与鼠标拖拽完全相同的目标球坐标
     （自转 / 综合侧视用 view，公转全景用 orbView，公转特写用 orbClose），
     故键盘与拖拽手感一致；仅画布聚焦时生效，其它按键不拦截。 */
  canvas.addEventListener('keydown', function (e) {
    const rev = (state.view === 'revolve');
    const close = rev && orbCloseMode();
    const stepK = TWO_PI / clamp(layout.main ? layout.main.h : window.innerHeight, 260, 1400);
    const step = stepK * 60;      // 每按一次 ≈ 拖动 60px 的旋转量
    const zk = 1.12;              // 每按一次缩放的倍率
    let used = true;
    if (close) {
      // 公转特写：方向键改朝向（与特写拖拽同一约定）
      if (e.key === 'ArrowLeft') orbClose.tYaw += step;
      else if (e.key === 'ArrowRight') orbClose.tYaw -= step;
      else if (e.key === 'ArrowUp') orbClose.tPitch = clamp(orbClose.tPitch - step, -ORB_CLOSE_PITCH_MAX, ORB_CLOSE_PITCH_MAX);
      else if (e.key === 'ArrowDown') orbClose.tPitch = clamp(orbClose.tPitch + step, -ORB_CLOSE_PITCH_MAX, ORB_CLOSE_PITCH_MAX);
      else if (e.key === '+' || e.key === '=' || e.key === 'PageUp') orbClose.tDist = clamp(orbClose.tDist / zk, orbCloseFit.tMin, orbCloseFit.tMax);
      else if (e.key === '-' || e.key === '_' || e.key === 'PageDown') orbClose.tDist = clamp(orbClose.tDist * zk, orbCloseFit.tMin, orbCloseFit.tMax);
      else used = false;
    } else {
      const o = rev ? orbView : view;
      const pMin = rev ? 0.05 : 0.06, pMax = Math.PI - (rev ? 0.05 : 0.06);
      const dMin = rev ? 3.2 : 1.6;
      const dMax = rev ? Math.max(40, orbRFar * 4) : 16;
      if (e.key === 'ArrowLeft') o.tTheta -= step;
      else if (e.key === 'ArrowRight') o.tTheta += step;
      else if (e.key === 'ArrowUp') o.tPhi = clamp(o.tPhi + step, pMin, pMax);
      else if (e.key === 'ArrowDown') o.tPhi = clamp(o.tPhi - step, pMin, pMax);
      else if (e.key === '+' || e.key === '=' || e.key === 'PageUp') o.tDist = clamp(o.tDist / zk, dMin, dMax);
      else if (e.key === '-' || e.key === '_' || e.key === 'PageDown') o.tDist = clamp(o.tDist * zk, dMin, dMax);
      else used = false;
    }
    if (used) e.preventDefault();
  });

  function hitPane(x, y) {
    if (layout.north && inRect(x, y, layout.north)) return 'north';
    if (layout.south && inRect(x, y, layout.south)) return 'south';
    if (layout.main && inRect(x, y, layout.main)) return 'main';
    return 'main';
  }
  function inRect(x, y, r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

  /* ===== v23.8：触摸屏「双指捏合缩放」 =====
     没有滚轮的设备（手机 / 平板 / 触摸屏一体机）原先完全无法缩放视角 —— 上面只有 wheel
     一条支路。这里补一条纯触摸支路：双指张开 = 拉近、捏合 = 拉远（与地图 / 看图 App 一致）。
     鼠标滚轮的监听与算式一律保持原样（不去动它），两条支路各自独立运行。
     与滚轮同口径的几条规则：
       · 只统计落在画布上的指针 —— 浮窗上的手势照旧留给原生滚动；
       · 缩放对象在「第二指落下」的那一刻锁定（此刻落在哪个窗口就缩放哪个），
         手势中途跨越窗口不会漂到另一个窗口上去；
       · 缩放范围与滚轮完全同一套取值：自转 1.6–16、公转 3.2–max(40, 轨道×4)、
         南北极俯视 0.55–3.2、直射点回归运动 0.35–6；
       · 捏合期间暂停单指旋转；松开一根手指后以剩下那根续接旋转（视角不跳变）；
       · 捏合开始即取消「点击查询」（downPt 置空），不会误弹出观测点面板。 */
  const touchPts = new Map();      // pointerId -> 当前坐标（仅画布上的触摸 / 触控笔）
  let pinch = null;
  function pinchTargetAt(x, y) {
    const or = orbCellRect();
    if (or && inRect(x, y, or)) return 'orbit';
    if (state.view === 'combo') { const p = comboPaneAt(x, y); if (p) return p; }
    return hitPane(x, y) || 'main';
  }
  // k 的含义与滚轮 handler 里的 k 完全一致：k > 1 = 拉远，k < 1 = 拉近
  function pinchZoomBy(target, k) {
    if (target === 'orbit') {
      if (orbCloseMode()) { orbClose.tDist = clamp(orbClose.tDist * k, orbCloseFit.tMin, orbCloseFit.tMax); return; }
      orbView.tDist = clamp(orbView.tDist * k, 3.2, Math.max(40, orbRFar * 4)); return;
    }
    if (target === 'north') { camNZoom = clamp(camNZoom / k, 0.55, 3.2); return; }
    if (target === 'south') { camSZoom = clamp(camSZoom / k, 0.55, 3.2); return; }
    if (target === 'sub') { subZoom = clamp(subZoom / k, 0.35, 6); syncSubCam(subCam); return; }
    view.tDist = clamp(view.tDist * k, 1.6, 16);
  }
  function pinchDist() {
    const it = touchPts.values(), a = it.next().value, b = it.next().value;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function beginPinch() {
    const it = touchPts.values(), a = it.next().value, b = it.next().value;
    downPt = null;                                   // 已进入手势 → 不再判定为点击
    pinch = {
      target: pinchTargetAt((a.x + b.x) / 2, (a.y + b.y) / 2),
      prev: Math.max(1, pinchDist()),
      hadDrag: drag, hadOrb: orbDrag,
    };
    drag = null; orbDrag = null;                     // 捏合期间暂停单指旋转
    canvas.classList.remove('grabbing');
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;           // 鼠标只有一个指针，不参与捏合
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size >= 2) beginPinch();
  });
  window.addEventListener('pointermove', function (e) {
    const p = touchPts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (!pinch) return;
    const d = Math.max(1, pinchDist());
    pinchZoomBy(pinch.target, pinch.prev / d);       // 张开 → d 变大 → 比值 < 1 → 拉近
    pinch.prev = d;
  }, { passive: true });
  function endPointer(e) {
    if (!touchPts.delete(e.pointerId)) return;       // 不是画布上的指针 → 不介入
    if (touchPts.size < 2 && pinch) {
      const p = touchPts.values().next().value;
      // 松一指还剩一指 → 以剩下这根的当前位置续接原先的旋转，避免视角跳变
      if (p && pinch.hadOrb) orbDrag = { x: p.x, y: p.y };
      else if (p && pinch.hadDrag) drag = { x: p.x, y: p.y };
      pinch = null;
    }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  /* ============ 场景刷新（依据模拟时间） ============ */
  let currentInfo = null;
  function updateScene() {
    const info = solarInfo(simMs);
    currentInfo = info;
    const psi = Math.PI / 2 - info.lam;                 // 地轴方位角（公转相位）
    const lonSub = subsolarLonRad(simMs, info.eot);

    let declEff = info.decl;                            // 相对地轴的有效太阳赤纬（季节关系）
    if (state.lockAxis) {
      // 地轴固定模式：地轴竖直向上（倾角固定 0°），地球正常自转，
      // 太阳在右侧（仰角 = 当日赤纬）：春分秋分正东水平、夏至右上、冬至右下，
      // 地轴-太阳夹角恒为 90°−赤纬，季节关系与真实二分二至一致
      orbit.rotation.y = 0;
      tilt.rotation.z = 0;
      sunDir.set(Math.cos(info.decl), Math.sin(info.decl), 0);
      spin.rotation.y = -lonSub;                        // 太阳不动，地球自转
      _axis.set(0, 1, 0);
    } else {
      // 参考系固定在太阳上：太阳光沿 +X 平行入射，地轴随公转摆动
      orbit.rotation.y = psi;
      tilt.rotation.z = -OBLIQ;
      const stx = Math.cos(psi) * Math.cos(info.eps);
      const stz = Math.sin(psi);
      const alphaSun = Math.atan2(-stz, stx);
      spin.rotation.y = alphaSun - lonSub;
      sunDir.set(1, 0, 0);
      // 地轴世界方向：R_y(psi) · R_z(-ε) · (0,1,0)
      _axis.set(Math.sin(OBLIQ) * Math.cos(psi), Math.cos(OBLIQ), -Math.sin(OBLIQ) * Math.sin(psi));
    }

    // v31（需求九）：自转 / 综合视图的太阳盘沿当前太阳方向摆到远处（共用真实贴图）
    if (sunDiskR) {
      sunDiskR.visible = !!(state.sun && state.sun.tex !== false);
      if (sunDiskR.visible) sunDiskR.position.copy(sunDir).multiplyScalar(SUN_SCENE_DIST);
    }

    // 光照 / 晨昏线所需 uniform
    earthMat.uniforms.uSunDir.value.copy(sunDir);
    cloudMat.uniforms.uSunDir.value.copy(sunDir);
    atmoMat.uniforms.uSunDir.value.copy(sunDir);
    geoMatR.uniforms.uSunDir.value.copy(sunDir);      // v25.1（需求⑤）：海陆 / 大洲层的昼夜压暗
    syncTzdiffZero();                                 // v25.1（需求⑦）：0 时经线随地方时刻实时移动
    updateFigureShadows(sunDir, spin, 'R');           // v25.1（需求⑥）：小人影子按太阳方向实时解算
    auroraSunLocal(earth, sunDir, earthMat);         // 极光：太阳方向转到地球本地系
    earthMat.uniforms.uSpinAxis.value.copy(_axis);
    _e1.copy(YAX).cross(sunDir);
    if (_e1.lengthSq() < 1e-8) _e1.copy(ZAX).cross(sunDir);
    _e1.normalize();
    _e2.copy(sunDir).cross(_e1).normalize();
    earthMat.uniforms.uE1.value.copy(_e1);
    earthMat.uniforms.uE2.value.copy(_e2);

    // 光线箭头与直射点标记始终对准太阳
    /* v33（需求四）：姿态改为「X→太阳、Y→地轴的垂直投影」，与公转视图统一 */
    rayAimQuat(_qA, sunDir, _axis);
    raysGroup.quaternion.copy(_qA);
    subGroup.quaternion.copy(_qA);
    subGroup.position.copy(sunDir).multiplyScalar(1 + state.style.pt.sub.size * 0.25);
    /* v32（需求一）：太阳体积光柱 —— 连接**太阳球心与地球球心**，沿太阳方向实时重建；
       地球半径 = 1，太阳盘摆在 SUN_SCENE_DIST ⇒ 光柱一直延伸到太阳球面；
       近端已由 layoutVolShaft 收在地表（只显示地表以外部分）。 */
    const _vsOn = volShaftOn();
    const _vsSig = _vsOn + '|' + state.volShaft.intensity + '|' + state.volShaft.op + '|' +
      state.volShaft.dia + '|' + state.volShaft.color + '|' + state.volShaft.glow;
    if (_vsSig !== _volSigR) { _volSigR = _vsSig; styleVolShaft(volShaftR, _vsOn); }
    if (_vsOn) layoutVolShaft(volShaftR, sunDir, 1, SUN_SCENE_DIST);
    applyRayVertLayout();      // v32（需求一）：竖排光线的纬度分布（n 未变则零开销）

    // v27.4：直射点纬线与经线跟随直射点实时移动（纬度 = decl，经度 = lonSub）
    updateSubCircle(info.decl, lonSub);

    // 云层缓慢相对漂移（跟随自转，叠加微小偏移）
    cloudRot = (simMs / 86400000) * 0.16;
    clouds.rotation.y = cloudRot;
    earthMat.uniforms.uCloudShift.value = -cloudRot / TWO_PI;

    // 极昼极夜：球冠的极角半径 = |赤纬|（地轴固定模式用倾斜后的有效赤纬）
    info.declEff = declEff;
    const declDeg = Math.abs(declEff * R);
    const capRad = Math.abs(declEff);
    const northIsDay = declEff > 0;
    capDay.material.uniforms.uDir.value = northIsDay ? 1 : -1;
    capNight.material.uniforms.uDir.value = northIsDay ? -1 : 1;
    capDay.material.uniforms.uCapAngle.value = capRad;
    capNight.material.uniforms.uCapAngle.value = capRad;

    const sgn = Math.sin(capRad), csg = Math.cos(capRad), RR = 1.0065;
    const posDay = northIsDay ? 1 : -1;
    strokeDay.scale.setScalar(sgn); strokeDay.position.y = posDay * csg * RR;
    strokeNight.scale.setScalar(sgn); strokeNight.position.y = -posDay * csg * RR;

    const show = state.polar && capRad > 0.0015;
    capDay.visible = show && state.pd.on;
    strokeDay.visible = show && state.pd.on && !!state.style.fill.pd.stroke.on;
    capNight.visible = show && state.pn.on;
    strokeNight.visible = show && state.pn.on && !!state.style.fill.pn.stroke.on;
    // 极昼 / 极夜文字注释：贴在对应极点上方（球外），南北随赤纬自动交换
    pdLabel.position.set(0, posDay * CAP_NOTE_R, 0);
    pnLabel.position.set(0, -posDay * CAP_NOTE_R, 0);
    // v23.11：门控结果记到 noteGate，最终 visible 交给 earthNotesPass 合成（门控 ∩ 正面朝向）
    pdLabel.userData.noteGate = show && state.pd.on && pdLabel.userData.noteOK !== false;
    pnLabel.userData.noteGate = show && state.pn.on && pnLabel.userData.noteOK !== false;
    pdLabel.visible = pdLabel.userData.noteGate;
    pnLabel.visible = pnLabel.userData.noteGate;

    updatePolarCameras();
    return info;
  }

  const _axis = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
  const _qA = new THREE.Quaternion();
  const YAX = new THREE.Vector3(0, 1, 0);
  const ZAX = new THREE.Vector3(0, 0, 1);

  function updatePolarCameras() {
    // 画面“上方”：太阳方向在垂直于地轴平面上的投影（两种参考系下都稳定）
    _up.copy(sunDir);
    _up.addScaledVector(_axis, -_up.dot(_axis));
    if (_up.lengthSq() < 1e-8) { _up.set(1, 0, 0).addScaledVector(_axis, -_axis.x); }
    if (_up.lengthSq() < 1e-8) _up.set(0, 0, 1); else _up.normalize();

    camNorth.position.copy(_axis).multiplyScalar(12);
    camNorth.up.copy(_up); camNorth.lookAt(0, 0, 0);
    camNorth.userData.half = 1.26 / camNZoom;

    camSouth.position.copy(_axis).multiplyScalar(-12);
    camSouth.up.copy(_up); camSouth.lookAt(0, 0, 0);
    camSouth.userData.half = 1.26 / camSZoom;
  }

  function syncOrthoFrustum(cam, aspect) {
    const half = cam.userData.half || 1.26;
    const hw = aspect >= 1 ? half * aspect : half;
    const hh = aspect >= 1 ? half : half / aspect;
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
    cam.updateProjectionMatrix();
  }

  /* ============ 状态 -> 场景 ============ */
  function applyAll() {
    // 直射点（样式 → style.pt.sub）
    subGroup.visible = state.sub;
    applySubSize(state.style.pt.sub.size);
    subMat.color.set(state.style.pt.sub.color); subMat.opacity = state.style.pt.sub.op;
    subRingMat.color.set(state.style.pt.sub.color); subRingMat.opacity = state.style.pt.sub.op;
    // v23.17：太阳直射点轨迹（线条 / 标记点样式 + 显隐）
    applySubTrail();
    // v27.4：直射点所在纬线与经线（样式 + 显隐）
    applySubCircle();
    // 光照
    earthMat.uniforms.uDayGain.value = state.dayGain;
    earthMat.uniforms.uNightGain.value = state.nightGain;
    earthMat.uniforms.uSoft.value = state.soft;
    earthMat.uniforms.uSpec.value = state.spec;
    // v25.1（需求④）：真实地球贴图 / 白色球（仅太阳光照阴影）切换
    earthMat.uniforms.uRealTex.value = state.realTex ? 1 : 0;
    earthMat.uniforms.uNightOp.value = state.sfx.nightOp;      // v15.0 灯光透明度
    earthMat.uniforms.uAuroraOp.value = state.sfx.auroraOp;    // v15.0 极光透明度
    // 晨昏线（晨线 / 昏线独立）
    earthMat.uniforms.uTermOn.value = state.term ? 1 : 0;
    earthMat.uniforms.uDawnOn.value = state.dawn.on ? 1 : 0;
    earthMat.uniforms.uDuskOn.value = state.dusk.on ? 1 : 0;
    const LD = state.style.ln.dawn, LK = state.style.ln.dusk;
    earthMat.uniforms.uDawnW.value = Math.sin(Math.max(LD.w, 0.05) * D);
    earthMat.uniforms.uDuskW.value = Math.sin(Math.max(LK.w, 0.05) * D);
    earthMat.uniforms.uDawnColor.value.set(LD.color);
    earthMat.uniforms.uDuskColor.value.set(LK.color);
    earthMat.uniforms.uDawnOpacity.value = LD.op;
    earthMat.uniforms.uDuskOpacity.value = LK.op;
    earthMat.uniforms.uDawnDash.value = LD.dash === 'dash' ? 1 : 0;
    earthMat.uniforms.uDuskDash.value = LK.dash === 'dash' ? 1 : 0;
    earthMat.uniforms.uDawnN.value = LD.n;
    earthMat.uniforms.uDuskN.value = LK.n;
    earthMat.uniforms.uDawnRatio.value = LD.ratio;
    earthMat.uniforms.uDuskRatio.value = LK.ratio;
    // 公转场景中的地球材质同步（同一套显示设置，需求⑥）
    ['uDayGain', 'uNightGain', 'uSoft', 'uSpec', 'uTermOn', 'uDawnOn', 'uDuskOn', 'uDawnW', 'uDuskW',
     'uDawnDash', 'uDuskDash', 'uDawnN', 'uDuskN', 'uDawnRatio', 'uDuskRatio', 'uHasNight', 'uHasClouds',
     'uDawnOpacity', 'uDuskOpacity', 'uNightOp', 'uAuroraOp', 'uRealTex']
      .forEach(function (u) { earthMatOrb.uniforms[u].value = earthMat.uniforms[u].value; });
    // v20.0：补上 uSpec（高光反光）—— 此前漏同步，导致「昼面高光反光」只对自转地球生效，
    //        公转地球的海面反光与自转视图不一致。
    earthMatOrb.uniforms.uDawnColor.value.copy(earthMat.uniforms.uDawnColor.value);
    earthMatOrb.uniforms.uDuskColor.value.copy(earthMat.uniforms.uDuskColor.value);
    /* 重要纬线（样式 → style.ln.eq / tr / ar；回归线与极圈固定虚线）
       v23.0（需求②）：特殊经纬线（赤道 / 回归线 / 极圈 / 本初子午线）属于「经纬网」——
       经纬网总开关关闭时，它们与经线 / 纬线一起全部隐藏（此前只关经线 / 纬线，
       特殊经纬线仍然显示，层级逻辑不自洽）。 */
    const gratOn = !!state.graticule;
    bandEq.visible = gratOn && state.eq.on; setBand(bandEq.material, state.style.ln.eq, state.style.ln.eq.dash === 'dash');
    bandTrN.visible = bandTrS.visible = gratOn && state.tr.on;
    setBand(bandTrN.material, state.style.ln.tr, true); setBand(bandTrS.material, state.style.ln.tr, true);
    bandArN.visible = bandArS.visible = gratOn && state.ar.on;
    setBand(bandArN.material, state.style.ln.ar, true); setBand(bandArS.material, state.style.ln.ar, true);
    // 温度带（自转视图；公转视图在 applyOrbit 中同步）：五带统一着色（v23.0：分界描边已取消）
    applyZoneSet(zR);
    // v25.1（需求⑤）：海陆分布 / 七大洲（面要素，两套材质同步）
    applyGeo();
    // v26.1（需求⑨）：东西半球 / 南北半球 / 低中高纬度 / 主要地壳板块（面 + 分界线 + 板块边界 + 箭头）
    applyRegions();
    // v25.1（需求⑦）：时差演示（面 / 线 / 注释门的样式同步）
    applyTzdiff();
    // v25.1（需求⑧）：球面最短距离（大圆环 + 劣弧 + 端点 + 距离标注）
    applyGcd();
    // 地轴（自转 / 公转统一；样式 → style.ln.axis）
    applyAxisStyle();
    // 太阳光线（样式 → style.ln.ray）
    raysGroup.visible = state.rays;
    rayCenterGroup.visible = state.rays;
    rayRingGroup.visible = state.rays && !state.raysCenter;
    applyRayStyle();
    // 极昼极夜（样式 → style.fill.pd / pn）
    capMatDay.uniforms.uColor.value.set(state.style.fill.pd.fill);
    capMatDay.uniforms.uOpacity.value = state.style.fill.pd.op;
    capMatDay.uniforms.uPattern.value = patternId(state.style.fill.pd.pattern);
    setTube(strokeDay.material, state.style.fill.pd.stroke);
    capMatNight.uniforms.uColor.value.set(state.style.fill.pn.fill);
    capMatNight.uniforms.uOpacity.value = state.style.fill.pn.op;
    capMatNight.uniforms.uPattern.value = patternId(state.style.fill.pn.pattern);
    setTube(strokeNight.material, state.style.fill.pn.stroke);
    rebuildStrokes();
    // 时区图层（填充 + 界线；注释由 note 分类 tz 控制）
    applyTz();
    // 其他
    // 经纬网（经线 / 纬线分别显隐、间隔分别可调；本初子午线为特殊经线）
    graticule.visible = state.graticule; graticuleOrb.visible = state.graticule;
    // v33：间隔改为多选后，用「已选间隔列表」的字符串作为变更判据
    if (gratStepKeys('mer').join(',') !== _gratMerStep || gratStepKeys('par').join(',') !== _gratParStep) {
      _gratMerStep = gratStepKeys('mer').join(','); _gratParStep = gratStepKeys('par').join(',');
      gratRebuild(graticule, gratMerLons(), gratParLats());
      gratRebuild(graticuleOrb, gratMerLons(), gratParLats());
    }
    gratEnsure(state.style.ln.mer.w, state.style.ln.par.w);
    [graticule, graticuleOrb].forEach(function (g2) {
      setTube(g2.userData.matMer, state.style.ln.mer);
      setTube(g2.userData.matPar, state.style.ln.par);
      g2.userData.mer.forEach(function (m) { m.visible = state.graticule && state.grat.mer; });
      g2.userData.par.forEach(function (m) { m.visible = state.graticule && state.grat.par; });
    });
    applyPmStyle();
    // 经纬度数字标注：间隔或回归线 / 极圈纬度变化时重建（数量与文本都随之改变）
    const gratSig = gratStepKeys('mer').join(',') + '|' + gratStepKeys('par').join(',') + '|' + TROPIC_LAT + '|' + POLAR_LAT;
    if (gratSig !== _gratNoteSig) { _gratNoteSig = gratSig; rebuildGratLabels(); }
    // 文字注释（v5.0）：总开关 / 总字号 / 总颜色 / 总透明度 + 各分类独立样式
    // 优先级：总开关关闭 → 全部隐藏；分类自定义字号 / 颜色优先于全局
    /* ★ v53（性能）：先按「全局统一字号」定下本帧的贴图档位（滞回后的结果），
       再让每条注释用同一个档位去问 spriteDPI。
       此前每条各自调用 noteDPI(st.size)，而 st.size 可能因分类自定义而略有差异 ——
       同一帧里相邻两条就可能落在档位分界两侧，造成**无谓的**重烘。
       这里以全局字号为准定档：分类自定义字号只影响 scale，不触发重烘。 */
    _noteDpiCur = noteDPI((state.note.unifyAttrs && state.note.unifyAttrs.size)
      ? state.note.master.size : 1);
    textSprites.forEach(function (sp) {
      // v23.10：地方时标签（0/6/12/18 主时刻 + 其余 20 个整点）的样式由 applyHourStyle
      //   单独管理（就在本次遍历之后紧接着执行），这里跳过 —— 避免通用逻辑再叠一层，
      //   也避免它被当成 'misc' 参与门控。
      if (sp.userData.hourLabel) return;
      const _cat0 = sp.userData.cat || 'misc';
      /* ★ v53（需求二·2）：全局文字注释门控的**优先级链**，从高到低 ——
           ① 显示/隐藏全局文字注释（本行的早退）
           ② 二级菜单标题开关（catGateOff）
           ③ 地理事物开关（thingGateOn）
           ④ 自身文字注释开关（spriteNoteGate 内各 cat 分支）
         ① 关掉时**立即隐藏全部文字注释**，任何分类开关都救不回来；
         ② ③ 由 noteGateLevel2 统一按次序判定，避免两条路径次序不一致。 */
      if (!state.note.master.on) { sp.visible = false; sp.userData.noteGate = false; return; }
      if (!noteGateLevel2(_cat0, sp)) { sp.visible = false; sp.userData.noteGate = false; return; }
      const st = noteStyleFor(_cat0, sp.userData.key);
      /* ★ v52（F1）guard：契约「文字注释精灵永远绘制在标记文本框背景板（MT_RO）之上」——
         个别注释精灵创建时未显式设 renderOrder（默认 0），会先于文本框绘制而被其半透明底盖住。
         这里统一兜底抬到 MT_RO+1 以上（其余精灵本就 40+，不受影响；仍低于标注点 30 之后的自有层级）。 */
      if (!(sp.renderOrder > MT_RO)) sp.renderOrder = MT_RO + 1;
      // v21.0：显隐一律由「总开关（st.show）→ 地理事物 → 注释分类」三级门控决定，
      //   不再为黄道面 / 赤道面 / 时区保留特殊旁路（那套旁路正是「开关控制失灵」的来源）。
      // v21.1（需求③）：门控结果另存一份 —— 时区注释每帧还要按「密集遮挡」再筛一次，
      //   布局函数里若直接读 sp.visible 会把「本帧被筛掉」误当成「门控关闭」，下一帧
      //   放大回来就再也恢复不了；必须让布局函数始终以门控结果为准再叠筛选。
      sp.userData.noteGate = st.show && spriteNoteGate(sp);
      sp.visible = sp.userData.noteGate;
      spriteDPI(sp, noteDPI(st.size));
      // v18.0：公转场景的注释按相机后退倍数同比放大 —— 调「日地距离」时文字观感大小不变
      // v21.0（需求⑩）→ v23.0（需求④）：字号基准归一**恒生效**（不再只在勾选「统一」时生效）。
      //   各条注释的世界基准宽度本就不同（0.18 ~ 0.95）、贴图画布宽与画布字号也不统一，
      //   不折算的话「分类字号」滑条与「总字号」滑条量纲不同 —— 拖出同一个数，
      //   屏幕上却一大一小。折算后任何一根字号滑条都是同一个量纲：同一个数 = 一样大。
      //   「全局文字大小样式统一」勾选框现在只管「是否用全局一套值覆盖各分类的自定义」。
      const _sm = st.size * (isOrbitSprite(sp) ? orbAnnMul() : 1);
      const _uk = unifyBaseK(sp);
      setNoteScale(sp, sp.userData.baseW * _uk * _sm, sp.userData.baseH * _uk * _sm);
      sp.material.color.set(st.color);
      sp.userData.baseOp = st.op;     // v23.12：记录基准透明度，供每帧「临边淡出」按朝向度折算
      sp.material.opacity = st.op;
    });
    orbNotes.visible = true;   // 显隐改由「总开关 / 分类开关」逐精灵控制
    // 极昼 / 极夜文字注释：除此处的门控结果外，还要「当期确实存在极昼极夜」——
    // 该条件随赤纬逐帧变化，故缓存门控结果，由 updateScene / updateOrbit 每帧合成最终显隐
    [pdLabel, pnLabel, pdLabelOrb, pnLabelOrb].forEach(function (sp) { sp.userData.noteOK = sp.visible; });
    // 点击查询标记样式（自转 / 公转两个地球同步；→ style.pt.marker）
    clickMarker.scale.setScalar(state.style.pt.marker.size / 0.028);
    clickMarker.material.color.set(state.style.pt.marker.color);
    clickMarker.material.opacity = state.style.pt.marker.op;
    clickMarkerOrb.scale.setScalar(state.style.pt.marker.size / 0.028);
    clickMarkerOrb.material.color.set(state.style.pt.marker.color);
    clickMarkerOrb.material.opacity = state.style.pt.marker.op;
    applyHourStyle();  // 赤道时刻标注（0/6/12/18 一组、其余整点一组，样式独立）
    applyPanelRows();  // 观测点数据面板：按开关决定各行显隐
    /* v27.4（修复）：地球表层效果总开关（realTex / 「显示真实地球」）关闭时，夜间城市灯光 /
       云层 / 大气光晕 / 极光 四个子效果必须**立即**一并隐藏（无需再逐个关子开关）。
       根因：bindSwitch 在 after 回调**之前**就调用了 applyAll()，关闭总开关时 after 才把
       clouds/atmo/aurora/night 置 false，可见性早已用旧值应用过 —— 于是「取消勾选但仍显示」。
       现把四者可见性统一门控到 state.realTex：总开关关 → 不论子开关如何一律不显示。
       （cbRealEarth 的 after 回调仍会把四个子开关勾选框复位为 off，使 UI 与渲染始终保持一致。） */
    const _rt = !!state.realTex;
    earthMat.uniforms.uHasNight.value = (_rt && state.night) ? 1 : 0;
    clouds.visible = _rt && state.clouds;
    cloudMat.uniforms.uOpacity.value = state.sfx.cloudsOp;          // v15.0 云层透明度
    cloudMatOrb.uniforms.uOpacity.value = state.sfx.cloudsOp;
    earthMat.uniforms.uHasClouds.value = (_rt && state.clouds) ? 1 : 0;
    atmosphere.visible = _rt && state.atmo;
    atmoMat.uniforms.uStrength.value = state.sfx.atmoStr;           // v15.0 大气光晕强度
    atmoMatOrb.uniforms.uStrength.value = state.sfx.atmoStr;
    earthMat.uniforms.uAuroraOn.value = (_rt && state.aurora) ? 1 : 0;      // 极光显隐
    earthMat.uniforms.uAuroraStr.value = state.auroraBright;       // 极光亮度
    syncPoints();                                                   // 点标注按签名增量重建
    syncFigure(); applyFigure();                                    // v25.1（需求⑥）：小人模型 + 影子样式
    syncMarkText(); applyMarkText();                                // v27.0（需求一）：标记文本（贴地文本框 + 文字）
    // 添加点模式 / 球面最短距离的「点击拾取」模式：十字光标
    syncCanvasCursor();
    applyOrbit();
    // v28（需求③）：公转速度演示的样式与总显隐 —— **必须排在 applyOrbit 之后**：
    //   它要用本帧刚写入的 orbRNow（半长轴）/ orbEccNow（离心率）/ orbPeriLonNow（近日点黄经）。
    applySpeedDemo();
    applyObliquity();   // 黄赤交角联动（须在 applyOrbit 之后：黄道面半径取 orbRNow）
    updatePickTip();    // v26.1（需求⑤⑦）：选点模式提示条（含「已选中的点」）
    syncPanelCap();   // 面板高度夹取（视口 / 遮挡约束变化后立即生效）
  }
  function patternId(p) { return p === 'hatch' ? 1 : p === 'dot' ? 2 : 0; }

  /* ============ v15.0：菜单 DOM 由 MENU 数据生成（必须早于任何面板元素查询 / 绑定） ============ */
  if (window.renderMenu) window.renderMenu();

  /* ============ UI ============ */
  const ui = {
    date: $('tDate'), clock: $('tClock'), meta: $('tMeta'), tMini: $('tMini'),
    outDate: $('outDate'), outHour: $('outHour'),
    rngDate: $('rngDate'), rngHour: $('rngHour'),
    fDecl: $('fDecl'), fSubLon: $('fSubLon'), fSeason: $('fSeason'),
    fSubLatBox: $('fSubLatBox'), fSubLonBox: $('fSubLonBox'),
    fPolarDayBox: $('fPolarDayBox'), fPolarNightBox: $('fPolarNightBox'),
    fPolarDay: $('fPolarDay'), fPolarNight: $('fPolarNight'),
    fObliq: $('fObliq'), fObliqBox: $('fObliqBox'),
    fTilt: $('fTilt'), fTiltBox: $('fTiltBox'),   // 地轴倾角（数值＝黄赤交角，共用同一读数开关）
    // v28（需求④）：地球公转瞬时速度读数（默认隐藏）；v29 拆为两行 + 面积速度
    fOrbV1: $('fOrbV1'), fOrbV2: $('fOrbV2'), fOrbVBox: $('fOrbVBox'),
    fOrbArea: $('fOrbArea'), fOrbAreaBox: $('fOrbAreaBox'),
    termChips: $('termChips'), termNote: $('termNote'),
    outSpeed: $('outSpeed'), playLabel: $('playLabel'), iconPlay: $('iconPlay'),
    hintNorth: $('hintNorth'), hintSouth: $('hintSouth'),
    termBtns: {},          // 节气小卡片按钮缓存（避免每次 updateUI 都做 DOM 查询）
  };
  // 只在内容真正变化时才写 DOM：时间面板 / 数据面板每秒被调用十余次，
  // 大量"写上同样的值"会触发无谓的样式与布局重算，是卡顿的常见来源。
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }
  function setDisp(el, on) { if (el) { const v = on ? '' : 'none'; if (el.style.display !== v) el.style.display = v; } }

  // 节气小卡片
  function buildTermChips() {
    ui.termChips.innerHTML = '';
    TERM_ORDER.forEach(function (k) {
      const ms = terms[k];
      const p = localParts(ms);
      const btn = document.createElement('button');
      btn.className = 'term'; btn.dataset.term = k;
      /* ★ v59（需求 2）：二分二至日期精确到时分秒（旧版只到「月/日」）。 */
      const dTxt = p.mo + '/' + p.day + ' ' + pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss);
      btn.innerHTML = '<span class="n">' + TERM_NAME[k] + '</span><span class="d">' + dTxt + '</span>';
      btn.title = displayYear + '年' + p.mo + '月' + p.day + '日 ' + pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss) + '（本地时间）';
      btn.addEventListener('click', function () { jumpToTerm(k); });
      ui.termChips.appendChild(btn);
      ui.termBtns[k] = btn;
    });
  }
  function jumpToTerm(k) {
    const ms = terms[k];
    const p = localParts(ms);
    const doy = p.doy;
    simMs = msFromLocal(displayYear, clamp(doy, 1, daysInYear(displayYear)), 12 * 60);
    simMs = clampToYear(simMs);
    syncSliders(); updateScene(); updateUI(true);
  }

  // 刻度
  function buildTicks() {
    const days = daysInYear(displayYear);
    const wrap = $('dateTicks'); wrap.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const doy = Math.floor((Date.UTC(displayYear, m - 1, 1) - Date.UTC(displayYear, 0, 1)) / 86400000) + 1;
      const el = document.createElement('span');
      el.className = 'tk'; el.style.left = ((doy - 1) / (days - 1) * 100) + '%';
      el.textContent = m;
      el.title = displayYear + '年' + m + '月';
      wrap.appendChild(el);
    }
    /* ★ v38（需求二）：二分二至刻度由单字「春/夏/秋/冬」改为全称
       「春分 / 夏至 / 秋分 / 冬至」，四个视图（自转 / 公转 / 综合 + 太阳视运动右上
       时间面板）统一口径，与时间面板上的节气按钮名称一致。 */
    const TERM_CHAR = { VE: '春分', SS: '夏至', AE: '秋分', WS: '冬至' };
    TERM_ORDER.forEach(function (k) {
      const p = localParts(terms[k]);
      const el = document.createElement('span');
      el.className = 'tk key t2'; el.style.left = ((p.doy - 1) / (days - 1) * 100) + '%';
      el.textContent = TERM_CHAR[k];
      el.title = TERM_NAME[k] + '：' + displayYear + '-' + p.mo + '-' + p.day + ' ' + pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss);
      wrap.appendChild(el);
    });
    const hw = $('hourTicks'); hw.innerHTML = '';
    for (let h = 0; h <= 24; h += 3) {
      const el = document.createElement('span');
      el.className = 'tk'; el.style.left = (h / 24 * 100) + '%';
      el.textContent = h;
      hw.appendChild(el);
    }
  }

  // 模拟时间跨入新的一年时，同步一切与年份相关的内容：
  // 二分二至 / 二十四节气的精确时刻、节气小卡片、时间轴刻度、日期滑块范围
  function syncYear(force) {
    const y = localParts(simMs).y;
    if (!force && y === displayYear) return false;
    displayYear = y;
    terms = solarTerms(y);
    buildTermChips();
    buildTicks();
    ui.rngDate.min = '1';
    ui.rngDate.max = String(daysInYear(y));
    return true;
  }

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  let uiAccum = 0;
  function updateUI(force) {
    const p = localParts(simMs);
    setText(ui.date, p.mo + '月' + p.day + '日');
    setText(ui.clock, pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss));
    setText(ui.meta, p.y + '年 星期' + WEEK[p.week] + ' · UTC' + (tzMinutes >= 0 ? '+' : '') + (tzMinutes / 60));
    setText(ui.outDate, p.mo + '月' + p.day + '日');
    setText(ui.outHour, pad2(p.hh) + ':' + pad2(p.mm));
    setText(ui.tMini, p.mo + '月' + p.day + '日 ' + pad2(p.hh) + ':' + pad2(p.mm));

    const info = currentInfo || solarInfo(simMs);
    const declDeg = (info.declEff !== undefined ? info.declEff : info.decl) * R;
    setText(ui.fDecl, fmtLat(declDeg, 2));
    const lonDeg = wrap180(subsolarLonRad(simMs, info.eot) * R);
    setText(ui.fSubLon, fmtLon(lonDeg, 1));

    // 读数分组可分别显示 / 隐藏
    setDisp(ui.fSubLatBox, state.read.sub);
    setDisp(ui.fSubLonBox, state.read.sub);
    setDisp(ui.fPolarDayBox, state.read.polar);
    setDisp(ui.fPolarNightBox, state.read.polar);
    setDisp(ui.fObliqBox, state.read.obliq);
    /* v28（需求④）：地球公转的实时瞬时线速度 / 角速度。
       线速度 v = √(GM(2/r − 1/a))，角速度 ω = h/r²（h = 面积速度 ×2，恒定）——
       两者都由**真实椭圆轨道**解算：近日点 30.29 km/s · 1.019°/日，
       远日点 29.29 km/s · 0.954°/日，全年均值 29.78 km/s · 0.986°/日（与天文年历一致）。
       日地距离 r 同时给出，便于把「近 → 快」的因果直接对上。 */
    // v29（需求④）：瞬时线速度 / 角速度分两行显示，避免单行拥挤
    setDisp(ui.fOrbVBox, state.read.orbV);
    if (state.read.orbV) {
      setText(ui.fOrbV1, (orbKin.vKmS).toFixed(3) + ' km/s（线速度）');
      setText(ui.fOrbV2, (orbKin.omegaDegDay).toFixed(4) + ' °/日 · 日地距 ' + (orbKin.rAU).toFixed(5) + ' AU（角速度）');
    }
    /* v29（需求③）：地球公转面积速度 dA/dt = h/2（开普勒第二定律，恒定），移至时间面板。
       数值由当前离心率解算，单位固定 km²/日（面积单位选择器已移除）。 */
    setDisp(ui.fOrbAreaBox, state.read.orbArea);
    if (state.read.orbArea) {
      const rKm2 = orbArealRateKm2Day(orbEccNow);
      setText(ui.fOrbArea, rKm2.toExponential(3).replace('e', '×10^') + ' km²/日（等面积速率）');
    }
    setText(ui.fObliq, fmtDM(state.obliquity));            // v23.14：度分读数（默认 23°26′）
    setDisp(ui.fTiltBox, state.read.obliq);      // 地轴倾角与黄赤交角同源，共用同一读数开关
    // 地轴倾角 = 地轴与黄道面的夹角 = 90° − 黄赤交角（教材惯例，二者互余、和为 90°）
    setText(ui.fTilt, fmtDM(90 - (+state.obliquity)));     // v23.14：度分读数（默认 66°34′）

    // 极昼 / 极夜纬度范围：以极点为界，范围 = 90° − |赤纬| 到极点
    const absDecl = Math.abs(declDeg);
    if (absDecl < 0.05) {
      setText(ui.fPolarDay, '无（直射赤道）');
      setText(ui.fPolarNight, '无（直射赤道）');
    } else {
      const b = 90 - absDecl;                     // 极昼/极夜边界纬度
      const northDay = declDeg > 0;               // 太阳直射北半球 → 北极圈内极昼
      setText(ui.fPolarDay, fmtLat(northDay ? b : -b, 1) + '–' + (northDay ? '90°N' : '90°S'));
      setText(ui.fPolarNight, fmtLat(northDay ? -b : b, 1) + '–' + (northDay ? '90°S' : '90°N'));
    }

    // 节气进度：以「上一个已过的二分二至 → 下一个二分二至」为一段，
    // 跨年时自动取上一年的冬至 / 下一年的春分，因此时间无限推进也始终正确
    const yr = p.y;
    const tCur = solarTerms(yr);
    let prevK = 'WS', prevMs = solarTerms(yr - 1).WS;
    let nextK = 'VE', nextMs = tCur.VE;
    const seq = [['VE', tCur.VE], ['SS', tCur.SS], ['AE', tCur.AE], ['WS', tCur.WS]];
    for (let i = 0; i < seq.length; i++) {
      if (seq[i][1] <= simMs) { prevK = seq[i][0]; prevMs = seq[i][1]; }
      else { nextK = seq[i][0]; nextMs = seq[i][1]; break; }
    }
    if (nextMs <= prevMs) { nextK = 'VE'; nextMs = solarTerms(yr + 1).VE; }   // 已过冬至 → 下一次春分在来年
    TERM_ORDER.forEach(function (k) {
      const btn = ui.termBtns[k];
      if (btn && btn.classList.contains('active') !== (prevK === k)) btn.classList.toggle('active', prevK === k);
    });
    const dTxt = Math.max(0, Math.floor((nextMs - simMs) / 86400000 + 0.0001)) + ' 天';
    setText(ui.termNote, TERM_NAME[prevK] + '之后 · 距' + TERM_NAME[nextK] + '还有 ' + dTxt);
    setText(ui.fSeason, TERM_NAME[prevK] + ' — ' + TERM_NAME[nextK]);

    const absD = Math.abs(declDeg);
    const bd = Math.max(0, 90 - absD).toFixed(1);
    setText(ui.hintNorth, declDeg > 0.2 ? '北方极昼 · 北界 ' + bd + '°N'
      : declDeg < -0.2 ? '北方极夜 · 北界 ' + bd + '°N' : '昼夜平分 · 无极昼极夜');
    setText(ui.hintSouth, declDeg > 0.2 ? '南方极夜 · 南界 ' + bd + '°S'
      : declDeg < -0.2 ? '南方极昼 · 南界 ' + bd + '°S' : '昼夜平分 · 无极昼极夜');

    if (!dragSlider.date) ui.rngDate.value = String(p.doy);
    if (!dragSlider.hour) ui.rngHour.value = String(clamp(p.minutes, 0, 1439));
    if (TIME_CUSTOM_SYNC) TIME_CUSTOM_SYNC();   // v31（需求九）：自定义时间六个输入框跟随
    setText(ui.outSpeed, fmtSpeed(state.speed));
    setText(ui.playLabel, state.playing ? '暂停' : '播放');
    if (ui.iconPlay.dataset.playing !== String(state.playing)) {   // 只在播放状态变化时改 SVG
      ui.iconPlay.dataset.playing = String(state.playing);
      ui.iconPlay.innerHTML = state.playing
        ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>'
        : '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    }
    // 点击查询弹窗随模拟时间实时刷新（昼长 / 节气）
    if (clickState && geoInfo.classList.contains('on')) renderGeoInfo();
  }

  function fmtSpeed(mult) {
    const secPerTurn = 86400 / mult;
    let s;
    if (mult >= 1000000) s = (mult / 1000000).toFixed(mult % 1000000 ? 2 : 0) + 'M×';
    else if (mult >= 1000) s = (mult / 1000).toFixed(mult % 1000 ? 1 : 0) + 'k×';
    else s = mult.toFixed(mult < 10 ? 1 : 0) + '×';
    if (secPerTurn >= 60) s += ' · ' + (secPerTurn / 60).toFixed(1) + ' 分/圈';
    else s += ' · ' + secPerTurn.toFixed(secPerTurn < 10 ? 2 : 0) + ' 秒/圈';
    return s;
  }

  const dragSlider = { date: false, hour: false };
  function syncSliders() {
    const p = localParts(simMs);
    ui.rngDate.value = String(p.doy);
    ui.rngHour.value = String(clamp(p.minutes, 0, 1439));
  }

  // 日期滑块
  ui.rngDate.min = '1'; ui.rngDate.max = String(daysInYear(displayYear));
  ui.rngDate.addEventListener('pointerdown', function () { dragSlider.date = true; });
  window.addEventListener('pointerup', function () { dragSlider.date = false; dragSlider.hour = false; });
  ui.rngDate.addEventListener('input', function () {
    const p = localParts(simMs);
    const days = daysInYear(displayYear);
    const doy = clamp(parseInt(ui.rngDate.value, 10), 1, days);
    simMs = clampToYear(msFromLocal(displayYear, doy, clamp(p.minutes, 0, 1439)));
    updateScene(); updateUI(true);
  });
  ui.rngHour.addEventListener('pointerdown', function () { dragSlider.hour = true; });
  ui.rngHour.addEventListener('input', function () {
    const p = localParts(simMs);
    const minutes = clamp(parseInt(ui.rngHour.value, 10), 0, 1439);
    simMs = clampToYear(msFromLocal(displayYear, p.doy, minutes));
    updateScene(); updateUI(true);
  });

  $('btnNow').addEventListener('click', function () {
    simMs = Date.now();
    syncYear(true);                    // 回到本机当前时刻，并同步二分二至 / 刻度 / 滑块范围
    updateScene(); updateUI(true);
  });

  /* v31（需求九）：时间「年月日 / 时分秒」可自定义 ——
     六个数字输入框 + 「应用」。输入后按「应用」即把仿真时间跳到该时刻；
     年可以改（跨年会触发 syncYear 重建节气 / 刻度），月 / 日 / 时分秒越界会被规范化
     （例如 2 月 31 日 → 3 月 3 日），保证任何输入都能落到一个合法时刻。
     输入框的显示值始终跟随当前仿真时间，只有正在编辑的那一个不被覆盖
     （同步函数挂在 updateUI 里调用，见 TIME_CUSTOM_SYNC）。 */
  var TIME_CUSTOM_SYNC = null;
  (function () {
    const ids = ['tInY', 'tInMo', 'tInD', 'tInH', 'tInMi', 'tInS'];
    const els = ids.map(function (id) { return $(id); });
    const KEYS = ['y', 'mo', 'day', 'hh', 'mm', 'ss'];
    /* ★ v32（需求二）修复「自定义时间失效」：
       旧逻辑只在「该输入框正被聚焦」时跳过实时同步 —— 用户一按下鼠标去点「应用」，
       输入框先失焦，下一帧 updateUI → sync() 就把刚输入的年月日时分秒**整个覆盖回当前仿真时间**，
       于是「应用」读到的仍是旧值 ⇒ 看起来完全没反应。
       现在改为**脏标记**：只要用户动过任何一个框，就停止实时同步，直到按下「应用」为止
       （应用后按规范化结果重新同步一次并清除脏标记）。 */
    let dirty = false;
    const markDirty = function () { dirty = true; };
    const sync = function (force) {
      if (dirty && !force) return;          // 用户正在编辑自定义时间 → 不覆盖
      if (force) dirty = false;
      const p = localParts(simMs);
      els.forEach(function (el, i) {
        if (!el || (!force && document.activeElement === el)) return;
        const s = String(p[KEYS[i]]);
        if (el.value !== s) el.value = s;
      });
    };
    TIME_CUSTOM_SYNC = sync;
    sync(true);
    const ap = $('btnTApply');
    if (ap) ap.addEventListener('click', function () {
      const v = els.map(function (el) { return parseInt(el && el.value, 10); });
      const cur = localParts(simMs);
      const y = clamp(Number.isFinite(v[0]) ? v[0] : cur.y, 1900, 2200);
      const mo = clamp(Number.isFinite(v[1]) ? v[1] : 1, 1, 12);
      const d = clamp(Number.isFinite(v[2]) ? v[2] : 1, 1, 31);
      const hh = clamp(Number.isFinite(v[3]) ? v[3] : 0, 0, 23);
      const mi = clamp(Number.isFinite(v[4]) ? v[4] : 0, 0, 59);
      const ss = clamp(Number.isFinite(v[5]) ? v[5] : 0, 0, 59);
      // Date.UTC 会自动把越界日期规范化（2/31 → 3/3），再扣掉时区偏移得到本地时刻。
      // v32：先按目标时刻推进「演示年」，再 clampToYear —— 这样跨年输入也能生效。
      simMs = Date.UTC(y, mo - 1, d, hh, mi, ss) - tzMinutes * 60000;
      displayYear = localParts(simMs).y;
      simMs = clampToYear(simMs);
      syncYear(true);                  // 重建二分二至 / 刻度 / 日期滑块范围
      updateScene(); updateUI(true); sync(true);
    });
    els.forEach(function (el) {
      if (!el) return;
      el.addEventListener('input', markDirty);
      el.addEventListener('change', markDirty);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && ap) ap.click(); });
    });
  })();

  /* ---- 设置面板绑定 ---- */
  function getPath(obj, path) {
    const r = redirectMarkText(path); if (r) return r.get();
    return path.split('.').reduce(function (o, k) { return o[k]; }, obj);
  }
  function setPath(obj, path, v) {
    const r = redirectMarkText(path); if (r) { r.set(v); return; }
    const ks = path.split('.'); let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = v;
  }
  const binders = [];
  const BOUND = new Set();            // v15.0：已显式绑定的控件 id（通用绑定器跳过它们）
  function bindSwitch(id, path, after) {
    const el = $(id); if (!el) return;
    BOUND.add(id);
    SW_PATH_REG[id] = path;                         // ★ v36：登记 id → path（级联自动推导查表用）
    /* ★ 本次可访问性：同步 checked 时一并写入 aria-checked（开关初始同步与 applyAll 时的
       binders 回填都会走到这里）。 */
    const sync = function () {
      el.checked = !!getPath(state, path);
      el.setAttribute('aria-checked', String(el.checked));
    };
    sync();
    el.addEventListener('change', function () {
      setPath(state, path, el.checked);
      el.setAttribute('aria-checked', String(el.checked));
      applyCascadeRules(path);                  // v35（需求三）：父开关关闭 → 受控子开关级联关闭
      applyAll(); persist();
      if (after) after();                       // 附加副作用（如时区面状态复位、同步统一样式面板）
    });
    binders.push(sync);
  }
  /* ---- v35（需求三 / 八）：开关级联规则表 —— 「上关下必关、上开下才能开」 ----
     父开关被关闭 ⇒ 受控子开关**全部强制置 false**（状态 + 菜单 DOM 同步刷新）；
     父开关被打开 ⇒ 子开关恢复可用（保持各自当前值，不强制打开）。
     规则在 bindSwitch 的 change 里触发；初次绑定完成后也统一跑一遍（归一化老存档：
     父已关而子仍开的矛盾状态）。 */
  const CASCADE_RULES = [
    // 需求三：地方时刻总开关（hour.on）→ 四个主时刻点 / 其余二十个时刻点两组开关
    ['hour.on', ['style.pt.hourMain.on', 'style.pt.hourRest.on']],
  ];
  /* ★ v36 修正：老式开关的 id → path 登记表 —— 大量组开关（cbRays/cbTerm/cbZones…）
     仍是「手动 bindSwitch(id, path)」绑定，菜单节点上只有 sw 没有 swPath，
     自动推导从树里拿不到它们的 path。bindSwitch 在绑定时顺手登记到这里，
     collectBoolPaths / buildCascadeRules 遇到「sw 无 swPath」或 use 引用节点时查表兜底。
     时序：手动绑定段（模块级）先于 buildCascadeRules（10742 附近）执行，表已填满。 */
  var SW_PATH_REG = {};
  /* ★ v36（需求五）：级联规则**从菜单树自动推导** —— 二级条目 / 分组标题前的每一个
     开关（swPath）都是其浮层内容的上级：上关则下级全部强制关、上级开下级才能开。
     旧实现只手写了 hour.on 一条，用户点名的「光照与太阳光线」等绝大多数组都没覆盖。
     推导规则：对每个带 swPath 的节点，收集其**直接子树**里的布尔开关
     （sw 叶子的 path + 直接子组的 swPath）；带开关的子组不深入（它自己的规则会递归传播），
     无开关的组继续深入。 */
  function collectBoolPaths(nodes, out) {
    function push(p) { if (out.indexOf(p) < 0) out.push(p); }
    (nodes || []).forEach(function (nd) {
      if (!nd) return;
      if (nd.k === 'sw' && nd.path) { push(nd.path); return; }
      if (nd.swPath) { push(nd.swPath); return; }   // 子组：交给它自己的规则递归
      /* ★ v36 修正：老式组标题开关（sw 无 swPath）与 use 引用的开关叶子 ——
         path 登记在 SW_PATH_REG，查表后同样「收路径即返回，不深入」。 */
      if (nd.sw && SW_PATH_REG[nd.sw]) { push(SW_PATH_REG[nd.sw]); return; }
      if (nd.id && !nd.k && SW_PATH_REG[nd.id]) { push(SW_PATH_REG[nd.id]); return; }   // use 叶子
      if (nd.children) collectBoolPaths(nd.children, out);
    });
    return out;
  }
  function buildCascadeRules(nodes, rules) {
    (nodes || []).forEach(function (nd) {
      if (!nd) return;
      /* ★ v36 修正：父级路径 = swPath，或老式组开关查 SW_PATH_REG */
      const pPath = nd.swPath || (nd.sw && !nd.swPath ? SW_PATH_REG[nd.sw] : null);
      if (pPath) {
        const kids = collectBoolPaths(nd.children || [], []);
        if (kids.length && !rules.some(function (r) { return r[0] === pPath; })) rules.push([pPath, kids]);
      }
      if (nd.children) buildCascadeRules(nd.children, rules);
    });
  }
  function runAllBinders() {
    for (let i = 0; i < binders.length; i++) { try { binders[i](); } catch (e) { } }
  }
  function applyCascadeRules(changedPath) {
    let hit = false;
    for (let i = 0; i < CASCADE_RULES.length; i++) {
      const rule = CASCADE_RULES[i];
      if (rule[0] !== changedPath) continue;
      if (getPath(state, rule[0]) !== false) continue;   // 父开 → 子不受限
      for (let j = 0; j < rule[1].length; j++) setPath(state, rule[1][j], false);
      hit = true;
    }
    if (hit) runAllBinders();     // 子开关 DOM 勾选状态同步（直接改 checked，不触发 change）
  }
  function bindRange(id, path, map, outId, fmt, after) {
    const el = $(id), out = outId ? $(outId) : null;
    if (!el) return;                                  // 元素缺失时静默跳过，不影响其余绑定
    /* ★ v43（需求三·1）：**全线宽统一为「相对倍率」口径** —— 见下方 LW_BASE / lwRel。
       带 __lwRel 标记的 map 会被就地替换成「以该路径的基准线宽为 1.00×」的换算，
       fmt 传 null 时也自动改用统一的倍率读数。状态里存的仍是物理单位（度 / 世界单位），
       渲染侧一行都不用改；改的只有「滑块量程」与「读数口径」这两件用户看得见的事。 */
    if (map && map.__lwRel) {
      const b = LW_BASE[path] || 1;
      const mult = (v) => ((+v || 0) / b);
      map = {
        toSlider: (v) => Math.round(mult(v) * 100),
        fromSlider: (v) => clamp((+v || 0) / 100, 0.10, 3.00) * b,
      };
      /* 读数一律换成倍率（fmt 传什么都被覆盖 —— 用户要求「相同线宽显示一致」） */
      fmt = (v) => mult(v).toFixed(2) + '\u00d7';
    }
    BOUND.add(id);
    const sync = function () {
      el.value = String(map.toSlider(getPath(state, path)));
      if (out && fmt) out.textContent = fmt(getPath(state, path));
    };
    sync();
    el.addEventListener('input', function () {
      setPath(state, path, map.fromSlider(parseFloat(el.value)));
      applyAll(); persistSoon();
      if (out && fmt) out.textContent = fmt(getPath(state, path));
      if (after) after();
    });
    el.addEventListener('change', persistNow);   // 松手 / 提交时立即落盘
    binders.push(sync);
  }
  function bindColor(id, path, hexId, after) {
    const el = $(id), hex = hexId ? $(hexId) : null;
    if (!el) return;                                  // 同上
    BOUND.add(id);
    const sync = function () {
      el.value = getPath(state, path);
      if (hex) hex.textContent = String(getPath(state, path)).toUpperCase();
    };
    sync();
    el.addEventListener('input', function () {
      setPath(state, path, el.value);
      if (hex) hex.textContent = el.value.toUpperCase();
      applyAll(); persistSoon();
      if (after) after();
    });
    el.addEventListener('change', persistNow);   // 取色确认时立即落盘
    binders.push(sync);
  }
  function bindSelect(id, path, after) {
    const el = $(id);
    if (!el) return;                                  // 同上
    BOUND.add(id);
    const sync = function () { el.value = getPath(state, path); };
    sync();
    el.addEventListener('change', function () {
      setPath(state, path, el.value); applyAll(); persist();
      if (after) after();
    });
    binders.push(sync);
  }
  const lin01 = { toSlider: (v) => Math.round(v * 100), fromSlider: (v) => v / 100 };
  const thousandth = { toSlider: (v) => Math.round(v * 1000), fromSlider: (v) => v / 1000 };  // 速度滑块：在 SPEED_MIN ~ SPEED_MAX 之间按对数均匀分布（滑块 0~1000）
  const SPEED_LOG_SPAN = Math.log(SPEED_MAX / SPEED_MIN);
  const thousand = {
    toSlider: function (mult) {
      const m = clamp(mult, SPEED_MIN, SPEED_MAX);
      return Math.round((Math.log(m / SPEED_MIN) / SPEED_LOG_SPAN) * 1000);
    },
    fromSlider: function (v) {
      return clamp(SPEED_MIN * Math.exp((v / 1000) * SPEED_LOG_SPAN), SPEED_MIN, SPEED_MAX);
    },
  };

  const deg10 = { toSlider: (v) => Math.round(v * 10), fromSlider: (v) => v / 10 };
  const w100 = { toSlider: (v) => Math.round(v * 100), fromSlider: (v) => v / 100 };
  // v29（需求⑦）：轨道离心率滑块 —— 与 raw4 展示（4 位小数）同粒度，滑条 1 格 = 0.0001
  const w10000 = { toSlider: (v) => Math.round(v * 10000), fromSlider: (v) => v / 10000 };
  const int1 = { toSlider: (v) => Math.round(v), fromSlider: (v) => Math.round(v) };
  const strokeW = { toSlider: (v) => Math.round(v * 10000), fromSlider: (v) => v / 10000 };
  // v25.1（需求⑤）：面要素描边「线粗细」—— 状态单位为「度」（沿球面的大圆角宽），滑条 1 格 = 0.01°
  const deg100 = { toSlider: (v) => Math.round(v * 100), fromSlider: (v) => v / 100 };
  const pct = (v) => Math.round(v * 100) + '%';
  /* v37（需求一·3）：状态本身已是「人读百分比」（0–100）时用这个格式 ——
     旧版三个光柱滑块误用 pct（再 ×100）把 97% 显示成 9700%（见菜单侧修复）。 */
  const pctInt = (v) => Math.round(v) + '%';
  /* ============================================================================
     ★ v43（需求三·1）：**全线宽统一为「相对倍率」口径**
     ----------------------------------------------------------------------------
     背景（用户报告：「所有线条的属性控制中，粗细控制原理要一致，不能有的粗有的细，
     滑块上下限要一致」）：改动前全站线宽控件分成**五套互不相容的单位与量程** ——
       球面线（度）      0.5–0.55，滑块 5–120（×100），读数「0.55°」
       面要素描边（度）  0.16–0.30，滑块 1–600（×1000），读数「0.220°」
       晨昏线（度）      0.9，滑块 2–40（×10），读数「0.9°」
       空间线（世界单位）0.003–0.011，滑块 1–40 / 2–60（×1000 / ×10000），读数「0.008」
       经纬网（度）      0.0018，滑块 1–60（×1000），读数「0.0018」
     后果很具体：同一条「线粗细」滑块，拖到最左在 A 处细得看不见、在 B 处粗成一片；
     数值读数也无法互相比较（0.55 和 0.008 谁更粗？答不上来）。
     方案：**不改动任何渲染代码、不改动状态的物理单位**，只统一「滑块量程」与「读数口径」——
       · 状态里仍存各自的物理单位（度 / 世界单位），渲染侧照旧读取，零风险；
       · 每个线宽路径登记一个**基准值**（= 旧默认值，即视觉上「1.00×」的粗细）；
       · 滑块一律 10–300（step 1），即 **0.10× – 3.00×**，读数一律「1.00×」这种倍率；
       · 于是「所有线宽滑块的上下限一致、控制原理一致（都是相对自身默认粗细的倍数）、
         相同倍率 ⇒ 相同视觉粗细」，而每条线的默认观感完全保持不变。
     LW_BASE 的取值全部等于 STYLE_DEF 里各线要素的**默认 w**（度类）或默认世界线宽。
     ========================================================================== */
  const LW_BASE = {
    /* —— 球面线（单位：度）—— */
    'style.ln.eq.w': 0.55,
    'style.ln.tr.w': 0.50,
    'style.ln.ar.w': 0.50,
    'style.ln.pm.w': 0.50,
    'style.ln.dawn.w': 0.90,
    'style.ln.dusk.w': 0.90,
    'style.ln.monDay.w': 0.50,
    'style.ln.monNight.w': 0.50,
    'style.ln.subTrail.w': 0.55,
    'style.ln.subLatCircle.w': 0.50,
    'style.ln.subLonCircle.w': 0.50,
    'style.ln.gcdArc.w': 0.26,
    'style.ln.gcdRing.w': 0.45,
    'style.ln.mer.w': 0.0018,
    'style.ln.par.w': 0.0018,
    /* —— 面要素描边（单位：度）—— */
    'style.fill.coast.w': 0.22,
    'style.fill.contLine.w': 0.20,
    'style.fill.hemi.lineW': 0.30,
    'style.fill.hemiNS.lineW': 0.30,
    'style.fill.zone.line.w': 0.30,
    'style.fill.latbelt.line.w': 0.22,
    'style.fill.tzdiff.stroke.w': 0.16,
    'style.fill.tzdiff.idl.w': 0.30,
    'style.fill.tzdiff.zero.w': 0.30,
    'style.fill.pd.stroke.w': 0.006,
    'style.fill.pn.stroke.w': 0.006,
    'style.fill.tz.stroke.w': 0.003,
    /* —— 空间线（单位：世界单位）—— */
    'style.ln.axis.w': 0.008,
    'style.ln.orbit.w': 0.006,
    'style.ln.ray.w': 0.011,
  };
  /* 线宽滑块的统一量程：10–300 ⇒ 0.10× – 3.00×，step 1（0.01×） */
  const LW_MIN = 10, LW_MAX = 300, LW_STEP = 1;
  const lwRel = { __lwRel: true, toSlider: (v) => v, fromSlider: (v) => v };
  /* 菜单端用：把这批控件的量程统一成 10–300 */
  function lwCtl(id, name, path, out) {
    return rg(id, name, path, LW_MIN, LW_MAX, LW_STEP, out, 'lwRel', 'lwX');
  }
  /* ---- v15.0 通用绑定器：菜单由 MENU 数据渲染，带 path 且未被显式绑定的节点在此统一接上 ---- */
  /* ★ v43（需求三·1）：MAPS 新增 lwRel（线宽统一倍率口径）—— bindRange 会按 path 查 LW_BASE
     把它换成「以基准线宽为 1.00×」的真实换算，lwX 读数格式同理由 fmt 自动接管。 */
  const MAPS = { lin01: lin01, thousandth: thousandth, w100: w100, w10000: w10000, int1: int1, strokeW: strokeW, deg10: deg10, deg100: deg100, lwRel: lwRel };
  const FMTS = {
    pct: pct, pctInt: pctInt, x: function (v) { return (+v).toFixed(2) + '\u00d7'; },
    /* v43（需求三·1）：线宽统一读数 —— 「1.00×」即「该线自身的默认粗细」。
       真正取值由 bindRange 注入（需要 path 查 LW_BASE），此处的 v 已是换算后的倍率。 */
    lwX: function (v) { return (+v).toFixed(2) + '\u00d7'; },
    raw: function (v) { return String(Math.round(v)); },
    /* v42（代码审查改法 B）：「掠过段长度」这类本身即「米 · 一位小数」的量直接用它读数，
       不要再套 pct（会 ×100 变成 600%）或其他倍率格式。 */
    raw1: function (v) { return (+v).toFixed(1); },
    raw3: function (v) { return (+v).toFixed(3); }, raw4: function (v) { return (+v).toFixed(4); },
    deg: function (v) { return (+v).toFixed(2) + '\u00b0'; },   // 纬线圈昼夜弧「线粗细」（角宽度 °）
    deg3: function (v) { return (+v).toFixed(3) + '\u00b0'; },  // v27.1：海岸线 / 大洲界线线粗细（下限 0.001°）
    // v28（需求③）：公转速度演示的时间步长（天）—— ≥10 天只留一位小数，短步长保留两位
    day: function (v) {
      var x = +v;
      var s = Math.abs(x - Math.round(x)) < 1e-6 ? String(Math.round(x)) : (x >= 10 ? x.toFixed(1) : x.toFixed(2));
      return s + ' \u5929';
    },
  };
  /* v23.9：属性统一开关（note.unifyAttrs.*）切换后的处理 ——
     关闭（退出统一）：先把各分类该属性的独立值固化保存（未自定义者填该分类固有值），
       于是「独立属性值」被真正写入存档，刷新后仍是各自的独立值；
     开启（进入统一）：**不覆盖**已保存的独立值，留作下次关闭时的精确恢复依据。 */
  function onUnifyAttrChanged(key) {
    if (!(state.note.unifyAttrs && state.note.unifyAttrs[key])) materializeCatOwn(key);
    refreshNoteCtlState();     // 分类控件即时切到「统一中置灰 / 独立可编辑」
    persist();
  }
  function bindMenuLeaf(n) {
    if (!n || !n.id || !n.path || BOUND.has(n.id)) return;
    BOUND.add(n.id);
    // v20.0：字重（weight）也纳入分类注释样式的「未自定义则跟随全局」逻辑
    if (/^note\.cats\.[A-Za-z0-9]+\.(font|size|color|op|weight|align)$/.test(n.path)) { bindNoteCatCtl(n); return; }
    // v20.0 修复：通用绑定器在 after 之前已经调用过 applyAll()，而 invalidateNoteSprites()
    //   只是把 dpi 清零、要等下一次 applyAll() 才会真正重画贴图 —— 结果是「改字体 / 字重 /
    //   切换全局统一」要等下一次无关操作才生效。这里改为清零后立刻再 applyAll() 一次，
    //   保证字号 / 字体 / 字重 / 颜色 / 全局统一等改动即时反映到地球上的文字注释。
    // v23.9：属性统一分开关切换后，先固化 / 保留各分类独立值并刷新分类控件，
    //   再重绘贴图 —— 保证「关掉统一 → 各类恢复自身值」「打开统一 → 各类立即统一」都即时可见。
    const isUnifyAttr = /^note\.unifyAttrs\./.test(n.path);
    /* v29（需求⑥）：二分二至「显示日期」标注刷新 —— 与 note.* 分支同理，setText() 只把 dpi
       归 0、并不立刻重绘贴图，而 **spriteDPI 只在 applyAll() 里被调用**；after 又晚于本次
       applyAll()，若不在这里补一次 applyAll()，标注会一直停在「名称」单行旧贴图上（数据已更新、
       画面不变）。故 refreshTermLabels() 之后必须再跑一次 applyAll() 触发贴图重绘。 */
    const after = /^note\./.test(n.path) ? function () {
      if (isUnifyAttr) onUnifyAttrChanged(n.path.split('.')[2]);
      invalidateNoteSprites(); applyAll();
      notifyNoteChange();          // v32（需求六）：太阳视运动的注记同步刷新
    } : (n.path === 'orb.terms.date' ? function () { refreshTermLabels(); applyAll(); }
      /* v29（需求⑤）：近日点 / 远日点标注的 名称 / 日期 / 日地距离 三个开关同理 ——
         setText() 只把 dpi 归 0，spriteDPI 只在 applyAll() 里被调用，必须补一次 applyAll()。
         但该标注文本由 updateSpeedDemo() 按 sig 懒重写（applySpeedDemo 会把 _spdSig 清空，
         等下一帧才写新文本），故要先 updateSpeedDemo() 立刻算出新文本、再 applyAll() 重绘。 */
      : (/^spd\.apsis(Name|Date|Dist)$/.test(n.path)
        ? function () { updateSpeedDemo(); applyAll(); }
        /* v31（需求十七）：UI 色系 / 毛玻璃三个控件改完立即重写主题变量（无需等下一次 applyAll） */
        : (/^ui\.theme\./.test(n.path) ? function () { applyUiTheme(); }
          /* v31（需求九）：太阳真实贴图开关 —— 立即切换太阳材质贴图 */
          : (n.path === 'sun.tex' ? function () { applySunTex(); } : null))));
    /* ★注意：after 在 setPath → applyAll 之后调用（见 bindSwitch），因此
       refreshTermLabels 读到的一定是**切换后**的 orb.terms.date。
       切勿改成在外部另加 change 监听（那条监听会先于 bindSwitch 的监听触发，
       读到的是切换前的旧值 → 标注文本总是慢一拍）。 */
    try {   // 单个控件失败不影响其余菜单（元素缺失 / 路径异常由各 binder 自行跳过）
      if (n.k === 'range') bindRange(n.id, n.path, MAPS[n.map] || lin01, n.out, FMTS[n.fmt] || pct, after);
      else if (n.k === 'color') bindColor(n.id, n.path, n.hex, after);
      else if (n.k === 'sel') bindSelect(n.id, n.path, after);
      else if (n.k === 'sw') bindSwitch(n.id, n.path, after);
    } catch (e) { console.warn('[menu] 绑定失败', n.id, n.path, e && e.message); }
  }
  /* 「统一 X」分开关 → 中文名（用于分类控件的置灰提示） */
  const UNIFY_LABEL = { size: '字号', color: '颜色', op: '透明度', font: '字体', weight: '字重', align: '对齐' };
  /* 分类注释样式（字号 / 字体 / 颜色 / 透明度 / 字重）控件。
     取值语义（v23.9 起）：
       · 该属性**处于统一中** → 控件置灰并显示全局统一值（统一设置优先，单独设置无意义）；
       · 该属性**未统一**     → 控件可编辑，显示该分类自身的独立值
                                （用户自定义值 → 分类固有值 NOTE_CAT_DEF）。 */
  function bindNoteCatCtl(n) {
    const parts = n.path.split('.');
    const cat = parts[2], key = parts[3];
    const el = $(n.id), out = n.out ? $(n.out) : null;
    if (!el) return;
    BOUND.add(n.id);
    const unified = function () { return !!(state.note.unifyAttrs && state.note.unifyAttrs[key]); };
    const cur = function () {
      if (unified()) return state.note.master[key];      // 统一中 → 一律显示全局统一值
      const v = getPath(state, n.path);                  // 未统一 → 自身独立值（自定义 → 固有）
      return (v != null) ? v : catDef(cat, key, state.note.master[key]);
    };
    const sync = function () {
      const v = cur();
      if (n.k === 'range') { el.value = String((MAPS[n.map] || lin01).toSlider(v)); if (out) out.textContent = (FMTS[n.fmt] || pct)(v); }
      else if (n.k === 'sel') el.value = v;
      else if (n.k === 'color') el.value = v;
      const u = unified();
      el.disabled = u;
      el.title = u ? ('该属性正受「全局文字大小样式统一 › 统一' + (UNIFY_LABEL[key] || key) +
                      '」统一控制；关闭该开关后可在此单独设置本类注释。') : '';
    };
    sync();
    el.addEventListener(n.k === 'sel' ? 'change' : 'input', function () {
      if (unified()) { sync(); return; }   // 统一中不接受单独修改（控件已置灰，此处为双保险）
      const v = (n.k === 'range') ? (MAPS[n.map] || lin01).fromSlider(parseFloat(el.value)) : el.value;
      setPath(state, n.path, v);
      invalidateNoteSprites(); applyAll(); persist(); sync();
      notifyNoteChange();          // v32（需求六）
    });
    binders.push(sync);
  }
  function bindMenuTree(nodes) {
    (nodes || []).forEach(function (nd) {
      if (!nd) return;
      if (nd.sw && nd.swPath) bindMenuLeaf({ id: nd.sw, k: 'sw', path: nd.swPath });
      if (nd.ctl) bindMenuLeaf(nd.ctl);
      bindMenuLeaf(nd);
      if (nd.children) bindMenuTree(nd.children);
    });
  }

  // 光照
  bindSwitch('cbRays', 'rays');
  bindSwitch('cbRaysCenter', 'raysCenter');

  // 温度带（全视图统一）
  bindSwitch('cbZones', 'zones.on');
  bindRange('rngZoneOp', 'style.fill.zone.op', lin01, 'outZoneOp', pct);
  bindColor('clrZtropic', 'style.fill.zone.cTropic', 'hexZtropic');
  bindColor('clrZtempN', 'style.fill.zone.cTempN', 'hexZtempN');
  bindColor('clrZtempS', 'style.fill.zone.cTempS', 'hexZtempS');
  bindColor('clrZcoldN', 'style.fill.zone.cColdN', 'hexZcoldN');
  bindColor('clrZcoldS', 'style.fill.zone.cColdS', 'hexZcoldS');
  // 公转动画设置（轨道 / 节气标记 / 注释 / 光线样式）
  // 黄赤交角与黄道面 / 赤道面（v10.0）
  bindRange('rngObliq', 'obliquity', { toSlider: (v) => Math.round(v * 10), fromSlider: (v) => v / 10 },
    'outObliq', fmtDM, function () { updateScene(); updateUI(true); });
  bindSwitch('cbPlaneEcl', 'orb.planes.ecl');
  bindSwitch('cbPlaneEqu', 'orb.planes.equ');
  // v23.14：黄赤交角一键重置为默认值 23°26′（= 23.4333…°，课标/天文真值）
  (function () {
    /* v29（需求⑦）：公转轨道离心率快捷预设 —— 圆（离心率0）/ 地球真实离心率。
       按钮只改 state.orb.ecc，滑杆与读数由已登记的 binder（rngOrbEcc）自动同步。 */
    [['btnOrbEcc0', 0], ['btnOrbEccReal', ORB_ECC0]].forEach(function (p) {
      const bb = $(p[0]); if (!bb) return;
      bb.addEventListener('click', function () {
        state.orb.ecc = p[1];
        applyAll(); persist(); updateUI(true);
      });
    });
    /* v29（需求⑥）：二分二至「显示日期」标注刷新走 bindMenuLeaf 的 after（见该处注释）；
       v29（需求①）：已删除 v28 的「时间步长」快捷预设按钮（半天/1天/10天/30天）。 */
    const b = $('btnObliqReset'); if (!b) return;
    b.addEventListener('click', function () {
      state.obliquity = OBLIQ_DEFAULT;
      applyAll(); persist();
      // 滑杆与滑杆旁输出由 binders 同步（bindRange('rngObliq') 已登记）；
      // v23.14：黄赤交角 / 地轴倾角两处仪表读数（fObliq / fTilt）只由 updateUI 更新，须显式调用
      updateUI(true);
    });
  })();
  bindColor('clrEcl', 'style.fill.ecl.fill', 'hexEcl', syncStyleUI);
  bindRange('rngEclOp', 'style.fill.ecl.op', lin01, 'outEclOp', pct);
  bindColor('clrEqu', 'style.fill.equ.fill', 'hexEqu', syncStyleUI);
  bindRange('rngEquOp', 'style.fill.equ.op', lin01, 'outEquOp', pct);
  bindSwitch('cbOrbOrbit', 'orb.orbit.on');
  bindColor('clrOrbOrbit', 'style.ln.orbit.color', 'hexOrbOrbit', syncStyleUI);
  /* ★ v43（需求三·1）：线宽统一为倍率口径（lwRel + LW_BASE['style.ln.orbit.w'] = 0.006） */
  bindRange('rngOrbOrbitW', 'style.ln.orbit.w', lwRel, 'outOrbOrbitW', null, syncStyleUI);
  bindRange('rngOrbOrbitOp', 'style.ln.orbit.op', lin01, 'outOrbOrbitOp', pct, syncStyleUI);
  bindSwitch('cbOrbTerms', 'orb.terms.on');
  bindRange('rngTermsSize', 'style.pt.term.size', w100, 'outTermsSize', (v) => v.toFixed(2) + '×', syncStyleUI);
  bindColor('clrTerms', 'style.pt.term.color', 'hexTerms', syncStyleUI);
  bindSwitch('cbOrbTerms24', 'orb.terms24.on');
  bindRange('rngT24Size', 'style.pt.term24.size', w100, 'outT24Size', (v) => v.toFixed(2) + '×', syncStyleUI);
  bindColor('clrT24', 'style.pt.term24.color', 'hexT24', syncStyleUI);
  /* ★ v52（F2/F3）：总开关「显示全部文字注释」—— 三级语义（自定义绑定，取代旧 bindSwitch）：
       ① 打开 → 所有文字注释显示：把各注释分类 / 组级开关**全部打开**（菜单勾选态随之同步）；
       ② 关闭 → 全部隐藏且**最高优先级**：渲染侧 noteStyleFor / earthNotesPass 只认
          note.master.on=false ⇒ 任何分类即便仍开着也一律隐藏；
       ③ 再次打开 → **不丢失**各分类原有设置：关闭时还原「打开前的分类 / 组开关快照」，
          打开时重新快照。快照存于 state.note._allSnap 并随设置持久化，刷新后仍可精确还原。 */
  function noteAllSwitchPaths() {
    const cats = ensureNoteCats();
    const arr = Object.keys(cats).map(function (c) { return 'note.cats.' + c + '.on'; });
    return arr.concat(['termNote.on', 'polarNote.on', 'obliqNote.on', 'hourNote.on']);
  }
  function setNoteMasterAll(on) {
    const M = state.note;
    const paths = noteAllSwitchPaths();
    if (on) {
      if (!M._allSnap) { M._allSnap = {}; paths.forEach(function (p) { M._allSnap[p] = getPath(state, p); }); }
      paths.forEach(function (p) { setPath(state, p, true); });
    } else if (M._allSnap) {
      Object.keys(M._allSnap).forEach(function (p) { setPath(state, p, M._allSnap[p]); });
      M._allSnap = null;
    }
    M.master.on = !!on;
    refreshNoteCtlState();
    invalidateNoteSprites(); applyAll(); persist();
    notifyNoteChange();          // v32（需求六）：太阳视运动注记同步刷新
  }
  (function () {
    const el = $('cbNoteAll'); if (!el) return;
    BOUND.add('cbNoteAll');
    SW_PATH_REG['cbNoteAll'] = 'note.master.on';      // ★ v36：登记 id→path，供级联自动推导查表
    const sync = function () { el.checked = !!state.note.master.on; el.setAttribute('aria-checked', String(el.checked)); };
    sync();
    el.addEventListener('change', function () { setNoteMasterAll(el.checked); });
    binders.push(sync);
  })();
  /* v23.5：全局统一「总开关」= 便捷总控 —— 打开即把所有分开关一并打开；关闭时不动各分开关
     （分开关仍可用，各自控制对应属性是否统一）。真正的统一判据是 note.unifyAttrs.*
     （见 noteStyleFor）。这里显式绑定，故菜单节点不带 path、不走通用绑定器。 */
  (function () {
    const el = $('cbNoteUnify'); if (!el) return;
    BOUND.add('cbNoteUnify');
    const KEYS = ['size', 'color', 'op', 'font', 'weight', 'align'];
    const sync = function () {
      el.checked = !!state.note.unify;
      el.setAttribute('aria-checked', String(el.checked));
    };
    sync();
    el.addEventListener('change', function () {
      state.note.unify = el.checked;
      if (el.checked) {                                  // 总开关开启 ⇒ 所有分开关自动开启
        const ua = state.note.unifyAttrs
          || (state.note.unifyAttrs = { size: true, color: false, op: false, font: false, weight: false, align: false });
        KEYS.forEach(function (k) { ua[k] = true; });
      }
      refreshNoteCtlState();       // 同步所有分开关勾选状态 + v23.9 各分类控件的统一态（置灰/取值）
      invalidateNoteSprites(); applyAll(); persist();
    });
    binders.push(sync);
  })();
  // 文字注释样式（全局：总字号 / 总颜色 / 总透明度 / 字重 / 对齐）
  // v20.0：总字号不再顺手清掉各分类的自定义字号 —— 「全部统一」改由「全局文字大小样式统一」
  //        勾选框显式触发（未勾选时各分类 / 单条的自定义照旧生效）。
  bindRange('rngNoteSize', 'note.master.size', w100, 'outNoteSize', (v) => v.toFixed(2) + '×', syncStyleUI);
  bindColor('clrNoteColor', 'note.master.color', 'hexNoteColor', syncStyleUI);
  bindRange('rngNoteOp', 'note.master.op', lin01, 'outNoteOp', pct, syncStyleUI);
  // 面板文字样式（v14.0）：字体 / 字号 / 颜色 / 透明度 —— 只影响界面文字，不影响地球上的注释
  bindSelect('selPanelFont', 'ui.panel.font', applyPanelFont);
  bindRange('rngPanelFont', 'ui.panel.size', w100, 'outPanelFont', (v) => v.toFixed(2) + '×', applyPanelFont);
  bindColor('clrPanelFont', 'ui.panel.color', 'hexPanelFont', applyPanelFont);
  bindRange('rngPanelFontOp', 'ui.panel.op', lin01, 'outPanelFontOp', pct, applyPanelFont);
  // v20.0：面板文字字重
  bindSelect('selPanelWeight', 'ui.panel.weight', applyPanelFont);
  // 字重 / 对齐：与字体一样需要重绘文字贴图（字重烘焙在贴图里）
  bindSelect('selNoteWeight', 'note.master.weight', function () { invalidateNoteSprites(); applyAll(); });
  bindSelect('selNoteAlign', 'note.master.align', function () { invalidateNoteSprites(); applyAll(); });
  // 字体：切换后文字精灵贴图需要重绘
  (function () {
    const sf = $('selNoteFont'); if (!sf) return;
    const sy = function () { sf.value = state.note.master.font; };
    sy();
    sf.addEventListener('change', function () {
      state.note.master.font = sf.value; invalidateNoteSprites(); applyAll(); persist();
    });
    binders.push(sy);
  })();

  /* v20.0 清理：v16.0 已删除「分类与单条注释」菜单（见 menu.js），其配套的
     selNoteCat 下拉、分类样式同步、单条注释实例面板（renderNoteInst）以及一整套
     动态 DOM 小工具（sel2 / mkRow / mkRange2 / ...）随之成为死代码，已整块移除。
     各分类的注释样式改由各菜单里的「文字注释」组直接控制；
     「全部统一」由「全局文字大小样式统一」勾选框 + note.unify 实现。 */
  const styleSyncs = [];
  function syncStyleUI() { styleSyncs.forEach(function (f) { f(); }); }
  binders.push(syncStyleUI);
  bindSwitch('cbTz', 'tz.on');
  // 时区图层：24 个填充面的交互与状态（v8.0）
  // 时区填充面：填充样式（颜色 / 透明度 / 相邻面交替填充）与描边（轮廓）
  bindSwitch('cbTzStripe', 'style.fill.tz.stripe', syncTzStripeRows);
  bindColor('clrTzFill', 'style.fill.tz.fill', 'hexTzFill', applyTz);
  bindRange('rngTzFillOp', 'style.fill.tz.op', lin01, 'outTzFillOp', pct, applyTz);
  bindColor('clrTzFill2', 'style.fill.tz.fill2', 'hexTzFill2', applyTz);
  bindRange('rngTzFillOp2', 'style.fill.tz.op2', lin01, 'outTzFillOp2', pct, applyTz);
  bindSwitch('cbTzStroke', 'style.fill.tz.stroke.on');
  bindColor('clrTzStroke', 'style.fill.tz.stroke.color', 'hexTzStroke', applyTz);
  bindRange('rngTzStrokeW', 'style.fill.tz.stroke.w', lwRel, 'outTzStrokeW', null, applyTz);
  bindRange('rngTzStrokeOp', 'style.fill.tz.stroke.op', lin01, 'outTzStrokeOp', pct, applyTz);
  bindSelect('selTzStrokeDash', 'style.fill.tz.stroke.dash', applyTz);
  bindRange('rngTzStrokeN', 'style.fill.tz.stroke.n', int1, 'outTzStrokeN', (v) => String(Math.round(v)), applyTz);
  bindRange('rngTzStrokeRatio', 'style.fill.tz.stroke.ratio', lin01, 'outTzStrokeRatio', pct, applyTz);
  /* v25.1（需求⑦）：时差演示 —— 只有「中时区描边」这一个开关走显式绑定
     （它由 menu.js 的 strokeGrp 生成，没有自带 path，通用绑定器接不上）；
     其余控件（面填充 / 两条线 / 两个日期面）都带 path，由通用绑定器自动接管。 */
  bindSwitch('cbTzdiffStroke', 'style.fill.tzdiff.stroke.on');
  // v23.0（需求①）：温度带描边整组取消，menu.js 里已不再生成对应控件，
  //   原先依赖「控件带 path → 通用绑定器自动接管」的注释也随之作废。
  // 公转直射光线样式
  bindRange('rngRayW', 'style.ln.ray.w', lwRel, 'outRayW', null, syncStyleUI);
  bindColor('clrOrbRay', 'style.ln.ray.color', 'hexOrbRay', syncStyleUI);
  bindRange('rngOrbRayOp', 'style.ln.ray.op', lin01, 'outOrbRayOp', pct, syncStyleUI);
  bindSelect('selRayDash', 'style.ln.ray.dash', syncStyleUI);
  bindRange('rngRayN', 'style.ln.ray.n', int1, 'outRayN', (v) => String(Math.round(v)), syncStyleUI);
  bindRange('rngRayRatio', 'style.ln.ray.ratio', lin01, 'outRayRatio', pct, syncStyleUI);
  // 公转动画：太阳大小 / 地球大小 / 日地距离（示意比例，可自由调节）
  bindRange('rngSunScale', 'orb.sunScale', w100, 'outSunScale', (v) => v.toFixed(2) + '×');
  bindRange('rngEarthScale', 'orb.earthScale', w100, 'outEarthScale', (v) => v.toFixed(2) + '×');
  bindRange('rngDistScale', 'orb.distScale', w100, 'outDistScale', (v) => v.toFixed(2) + '×');
  // 经纬网样式（经线 / 纬线各自独立，见菜单「地球表层 › 经纬网」）/ 点击标记样式
  bindRange('rngMarkerSize', 'style.pt.marker.size', { toSlider: (v) => Math.round(v * 1000), fromSlider: (v) => v / 1000 }, 'outMarkerSize', (v) => v.toFixed(3), syncStyleUI);
  bindColor('clrMarker', 'style.pt.marker.color', 'hexMarker', syncStyleUI);
  // 监听点：预设（北京 / 太原 / 伦敦）/ 自定义经纬度 / 清除；及所在纬线圈昼夜分弧样式
  (function () {
    document.querySelectorAll('[data-mon]').forEach(function (b) {
      b.addEventListener('click', function () {
        const lat = parseFloat(b.dataset.lat), lon = parseFloat(b.dataset.lon);
        state.mon.preset = b.dataset.mon;
        state.mon.custom.lat = lat; state.mon.custom.lon = lon;
        $('inMonLat').value = lat; $('inMonLon').value = lon;
        document.querySelectorAll('[data-mon]').forEach(function (x) { x.classList.toggle('on', x === b); });
        setMonitor(lat, lon, { x: window.innerWidth * 0.5, y: TITLE_H + 70 });
      });
    });
    $('btnMonCustom').addEventListener('click', function () {
      const lat = clamp(parseFloat($('inMonLat').value) || 0, -90, 90);
      let lon = parseFloat($('inMonLon').value) || 0; if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
      state.mon.preset = 'custom';
      state.mon.custom.lat = lat; state.mon.custom.lon = lon;
      document.querySelectorAll('[data-mon]').forEach(function (x) { x.classList.remove('on'); });
      setMonitor(lat, lon, { x: window.innerWidth * 0.5, y: TITLE_H + 70 });
    });
    $('btnMonClear').addEventListener('click', function () {
      clickState = null; clickMarker.visible = clickMarkerOrb.visible = false;
      geoInfo.classList.remove('on');
      document.querySelectorAll('[data-mon]').forEach(function (x) { x.classList.remove('on'); });
    });
    /* ★ v43（需求三·1）：纬线圈宽也并入**线宽统一倍率口径** —— 与其余线宽滑块同量程
       （10–300 ⇒ 0.10×–3.00×）、同读数（0.50° 这一路的物理值只作为内部状态保留）。
       基准取 LW_BASE['style.ln.monDay.w'] = 0.50（旧默认值）。 */
    const MONW_BASE = LW_BASE['style.ln.monDay.w'];
    $('rngMonW').addEventListener('input', function () {
      const v = clamp(parseFloat(this.value) / 100, 0.10, 3.00) * MONW_BASE;
      state.style.ln.monDay.w = v; state.style.ln.monNight.w = v;
      $('outMonW').textContent = (v / MONW_BASE).toFixed(2) + '×';
      syncStyleUI(); applyAll(); persist();
    });
    binders.push(function () {
      const v = state.style.ln.monDay.w;
      $('rngMonW').value = String(Math.round(v / MONW_BASE * 100));
      $('outMonW').textContent = (v / MONW_BASE).toFixed(2) + '×';
    });
  })();
  bindSwitch('cbMonCircle', 'mon.circle');
  bindColor('clrMonDay', 'style.ln.monDay.color', 'hexMonDay', syncStyleUI);
  bindRange('rngMonDayOp', 'style.ln.monDay.op', lin01, 'outMonDayOp', pct, syncStyleUI);
  bindColor('clrMonNight', 'style.ln.monNight.color', 'hexMonNight', syncStyleUI);
  bindRange('rngMonNightOp', 'style.ln.monNight.op', lin01, 'outMonNightOp', pct, syncStyleUI);
  // 赤道地方时时刻标注（v2.9）：0/6/12/18 一组、其余二十个整点一组，样式各自独立
  bindSwitch('cbHourMain', 'style.pt.hourMain.on');         // v16.0：控制点的显隐，文字由注释分类独立控制
  bindRange('rngHourMainSize', 'style.pt.hourMain.size', thousandth, 'outHourMainSize', (v) => v.toFixed(3), syncStyleUI);
  bindColor('clrHourMain', 'style.pt.hourMain.color', 'hexHourMain', syncStyleUI);
  bindSwitch('cbHourRest', 'style.pt.hourRest.on');         // v16.0：同上
  bindRange('rngHourRestSize', 'style.pt.hourRest.size', thousandth, 'outHourRestSize', (v) => v.toFixed(3), syncStyleUI);
  bindColor('clrHourRest', 'style.pt.hourRest.color', 'hexHourRest', syncStyleUI);
  // 观测点数据面板：各行内容可选展示
  bindSwitch('piPos', 'mon.panel.pos');
  bindSwitch('piLst', 'mon.panel.lst');
  bindSwitch('piTerm', 'mon.panel.term');
  bindSwitch('piTz', 'mon.panel.tz');
  bindSwitch('piDaylen', 'mon.panel.daylen');
  bindSwitch('piSub', 'mon.panel.sub');
  bindSwitch('piSr', 'mon.panel.sr');
  bindSwitch('piSraz', 'mon.panel.sraz');
  bindSwitch('piNoon', 'mon.panel.noon');
  bindSwitch('piYear', 'mon.panel.year');
  bindSwitch('piCurve', 'mon.panel.curve');
  // v28（需求④）：该点随地球自转的线速度 / 角速度（默认隐藏）
  bindSwitch('piSpinV', 'mon.panel.spinV');
  bindSwitch('piSpinW', 'mon.panel.spinW');
  bindSwitch('cbReadOrbV', 'read.orbV');
  // v29（需求③）：地球公转面积速度（dA/dt）读数开关 —— 显隐由天文数据面板控制
  bindSwitch('cbReadOrbArea', 'read.orbArea');
  // 天文数据读数（时间面板底部）
  bindSwitch('cbReadSub', 'read.sub');
  bindSwitch('cbReadPolar', 'read.polar');
  bindSwitch('cbReadObliq', 'read.obliq');
  bindRange('rngDayGain', 'dayGain', w100, 'outDayGain', (v) => v.toFixed(2));
  bindRange('rngNightGain', 'nightGain', w100, 'outNightGain', pct);
  bindRange('rngSoft', 'soft', w100, 'outSoft', (v) => v.toFixed(2));
  bindRange('rngSpec', 'spec', w100, 'outSpec', pct);

  // 晨昏线：晨线 / 昏线
  bindSwitch('cbTerm', 'term');
  bindSwitch('cbDawn', 'dawn.on');
  bindRange('rngDawnW', 'style.ln.dawn.w', lwRel, 'outDawnW', null, syncStyleUI);
  bindColor('clrDawn', 'style.ln.dawn.color', 'hexDawn', syncStyleUI);
  bindSelect('selDawnDash', 'style.ln.dawn.dash');
  bindRange('rngDawnN', 'style.ln.dawn.n', int1, 'outDawnN', (v) => String(Math.round(v)), syncStyleUI);
  bindRange('rngDawnRatio', 'style.ln.dawn.ratio', lin01, 'outDawnRatio', pct, syncStyleUI);

  // v20.0：极昼 / 极夜描边各加一个「显示描边」复选框 —— 描边菜单一律可用复选框控制显隐
  bindSwitch('cbPdStroke', 'style.fill.pd.stroke.on');
  bindSwitch('cbPnStroke', 'style.fill.pn.stroke.on');
  // v20.0：赤道 / 本初子午线补上「类型」（实线 / 虚线）选择器
  bindSelect('selEqDash', 'style.ln.eq.dash', syncStyleUI);
  bindSelect('selPmDash', 'style.ln.pm.dash', syncStyleUI);

  bindSwitch('cbDusk', 'dusk.on');
  bindRange('rngDuskW', 'style.ln.dusk.w', lwRel, 'outDuskW', null, syncStyleUI);
  bindColor('clrDusk', 'style.ln.dusk.color', 'hexDusk', syncStyleUI);
  bindSelect('selDuskDash', 'style.ln.dusk.dash');
  bindRange('rngDuskN', 'style.ln.dusk.n', int1, 'outDuskN', (v) => String(Math.round(v)), syncStyleUI);
  bindRange('rngDuskRatio', 'style.ln.dusk.ratio', lin01, 'outDuskRatio', pct, syncStyleUI);

  // 虚线参数（虚线密度 / 实虚比）只在线型为「虚线」时可用，实线状态置灰并禁用
  const DASH_SELS = [['dawn', 'selDawnDash'], ['dusk', 'selDuskDash'],
                     ['ray', 'selRayDash'], ['tzstroke', 'selTzStrokeDash'],
                     // v15.0：地轴 / 经线 / 纬线 / 公转轨道 / 极昼极夜描边
                     ['axis', 'selAxisDash'], ['mer', 'selMerDash'], ['par', 'selParDash'],
                     ['orbit', 'selOrbOrbitDash'], ['pdstroke', 'selPdStrokeDash'], ['pnstroke', 'selPnStrokeDash'],
                     // v20.0：赤道 / 本初子午线（只有南北回归线、南北极圈固定虚线，其余都可切换）
                     ['eq', 'selEqDash'], ['pm', 'selPmDash'],
                     // v23.0：原「温度带分界线描边」项（zonestroke）随五带描边一并删除
                     // v21.0：纬线圈昼夜弧（昼弧 / 夜弧）
                     ['monDay', 'selMonDayDash'], ['monNight', 'selMonNightDash'],
                     // v23.17（需求②）：太阳直射点轨迹（线型可为实线 / 虚线）
                     ['subTrail', 'selSubTrailDash'],
                     // v25.1（需求⑦）：时差演示的三处线型（中时区描边 / 日期变更线 / 0 时经线）
                     ['tzdiffstroke', 'selTzdiffStrokeDash'], ['tzdiffidl', 'selTzdiffIdlDash'],
                     ['tzdiffzero', 'selTzdiffZeroDash'],
                     // v25.1（需求⑧）：球面最短距离的两条线（完整大圆环 / 劣弧）
                     ['gcdring', 'selGcdRingDash'], ['gcdarc', 'selGcdArcDash'],
                     // v28（需求③）：单位时间扫过面积的扇形边界线（实线 / 虚线）
                     ['spd', 'selSpdLineDash']];
  function syncDashRows() {
    DASH_SELS.forEach(function (pair) {
      const sel = $(pair[1]); if (!sel) return;
      const isDash = sel.value === 'dash';
      document.querySelectorAll('.row.dash-only[data-dash="' + pair[0] + '"]').forEach(function (r) {
        r.classList.toggle('locked', !isDash);
        const inp = r.querySelector('input'); if (inp) inp.disabled = !isDash;
      });
    });
  }
  DASH_SELS.forEach(function (pair) { const el = $(pair[1]); if (el) el.addEventListener('change', syncDashRows); });
  syncDashRows();
  binders.push(syncDashRows);
  // 时区「相邻面交替填充」未开启时，交替面颜色 / 透明度两行置灰禁用
  function syncTzStripeRows() {
    const on = !!state.style.fill.tz.stripe;
    document.querySelectorAll('.row[data-tzstripe]').forEach(function (r) {
      r.classList.toggle('locked', !on);
      const inp = r.querySelector('input'); if (inp) inp.disabled = !on;
    });
  }
  binders.push(syncTzStripeRows);

  // 极昼区 / 极夜区：总开关之外各自独立开关
  bindSwitch('cbPd', 'pd.on');
  bindSwitch('cbPn', 'pn.on');

  // 重要纬线
  bindSwitch('cbEq', 'eq.on');
  bindColor('clrEq', 'style.ln.eq.color', 'hexEq', syncStyleUI);
  bindRange('rngEqW', 'style.ln.eq.w', lwRel, 'outEqW', null, syncStyleUI);
  bindRange('rngEqOp', 'style.ln.eq.op', lin01, 'outEqOp', pct, syncStyleUI);

  bindSwitch('cbTr', 'tr.on');
  bindColor('clrTr', 'style.ln.tr.color', 'hexTr', syncStyleUI);
  bindRange('rngTrW', 'style.ln.tr.w', lwRel, 'outTrW', null, syncStyleUI);
  bindRange('rngTrOp', 'style.ln.tr.op', lin01, 'outTrOp', pct, syncStyleUI);
  bindRange('rngTrN', 'style.ln.tr.n', int1, 'outTrN', (v) => String(Math.round(v)), syncStyleUI);
  bindRange('rngTrRatio', 'style.ln.tr.ratio', lin01, 'outTrRatio', pct, syncStyleUI);

  bindSwitch('cbAr', 'ar.on');
  bindColor('clrAr', 'style.ln.ar.color', 'hexAr', syncStyleUI);
  bindRange('rngArW', 'style.ln.ar.w', lwRel, 'outArW', null, syncStyleUI);
  bindRange('rngArOp', 'style.ln.ar.op', lin01, 'outArOp', pct, syncStyleUI);
  bindRange('rngArN', 'style.ln.ar.n', int1, 'outArN', (v) => String(Math.round(v)), syncStyleUI);
  bindRange('rngArRatio', 'style.ln.ar.ratio', lin01, 'outArRatio', pct, syncStyleUI);

  // 本初子午线（特殊经线）：始终实线、单独控制（类比特殊纬线）
  bindSwitch('cbPm', 'pm.on');
  bindColor('clrPm', 'style.ln.pm.color', 'hexPm', syncStyleUI);
  bindRange('rngPmW', 'style.ln.pm.w', lwRel, 'outPmW', null, syncStyleUI);
  bindRange('rngPmOp', 'style.ln.pm.op', lin01, 'outPmOp', pct, syncStyleUI);
  // 经纬网：经线 / 纬线分别显隐、间隔分别可调
  bindSwitch('cbGratMer', 'grat.mer');
  bindSwitch('cbGratPar', 'grat.par');
  /* v33（面板规格）：经线 / 纬线「显示间隔」由下拉单选改为 6 个复选框（可多选）。
     勾选变化会改变网格顶点集合 ⇒ 必须触发重建（bindMenuLeaf 的 applyAll 已覆盖）。 */
  [[10, '10'], [15, '15'], [20, '20'], [30, '30'], [45, '45'], [60, '60']].forEach(function (s) {
    bindSwitch('cbGratMerStep' + s[0], 'grat.merSteps.' + s[0]);
    bindSwitch('cbGratParStep' + s[0], 'grat.parSteps.' + s[0]);
  });

  bindSwitch('cbSub', 'sub');
  // v23.17（需求②）：太阳直射点轨迹记录（默认关闭）+ 「清除轨迹并重新记录」
  bindSwitch('cbSubTrail', 'subTrail');
  (function () {
    const btn = $('btnSubTrailClear'); if (!btn) return;
    btn.addEventListener('click', function () { clearSubTrail(); });
  })();
  bindRange('rngSubSize', 'style.pt.sub.size', { toSlider: (v) => Math.round(v * 1000), fromSlider: (v) => v / 1000 }, 'outSubSize', (v) => v.toFixed(3), syncStyleUI);
  bindColor('clrSub', 'style.pt.sub.color', 'hexSub', syncStyleUI);

  bindSwitch('cbAxis', 'axis');
  bindRange('rngAxisWidth', 'style.ln.axis.w', lwRel, 'outAxisWidth', null, syncStyleUI);
  bindRange('rngAxisLen', 'axisLen', { toSlider: (v) => Math.round(v * 10), fromSlider: (v) => v / 10 }, 'outAxisLen', (v) => v.toFixed(1) + '×', applyAxisStyle);
  bindColor('clrAxis', 'style.ln.axis.color', 'hexAxis', syncStyleUI);

  bindSwitch('cbPolar', 'polar');

  bindColor('clrPdFill', 'style.fill.pd.fill', 'hexPdFill', syncStyleUI);
  bindRange('rngPdOpacity', 'style.fill.pd.op', lin01, 'outPdOpacity', (v) => Math.round(v * 100) + '%', syncStyleUI);
  bindColor('clrPdStroke', 'style.fill.pd.stroke.color', 'hexPdStroke', syncStyleUI);
  bindRange('rngPdStrokeW', 'style.fill.pd.stroke.w', lwRel, 'outPdStrokeW', null, syncStyleUI);
  bindRange('rngPdStrokeOp', 'style.fill.pd.stroke.op', lin01, 'outPdStrokeOp', (v) => Math.round(v * 100) + '%', syncStyleUI);

  bindColor('clrPnFill', 'style.fill.pn.fill', 'hexPnFill', syncStyleUI);
  bindRange('rngPnOpacity', 'style.fill.pn.op', lin01, 'outPnOpacity', (v) => Math.round(v * 100) + '%', syncStyleUI);
  bindColor('clrPnStroke', 'style.fill.pn.stroke.color', 'hexPnStroke', syncStyleUI);
  bindRange('rngPnStrokeW', 'style.fill.pn.stroke.w', lwRel, 'outPnStrokeW', null, syncStyleUI);
  bindRange('rngPnStrokeOp', 'style.fill.pn.stroke.op', lin01, 'outPnStrokeOp', (v) => Math.round(v * 100) + '%', syncStyleUI);

  bindSwitch('cbGrat', 'graticule');
  /* v26.1（需求⑥）：「显示真实地球」是本组的总开关 —— 关掉它（切成白色球，只留太阳光照
     形成的明暗）时，夜间城市灯光 / 云层 / 大气光晕 / 极光 一并关闭；「昼夜对比」那一组
     是白色球模式下不再生效的明暗调节，界面上由 gate 置灰即可（它是滑块组、没有开关可关）。
     重新打开总开关时**不自动**把子开关恢复 —— 由用户自己决定要哪几项，避免「一开全开」。 */
  bindSwitch('cbRealEarth', 'realTex', function () {
    if (state.realTex) return;
    state.night = false; state.clouds = false; state.atmo = false; state.aurora = false;
    binders.forEach(function (f) { f(); });     // 把四个子开关的勾选框拉回一致（syncMenuGates 也在 binders 里）
  });
  bindSwitch('cbNight', 'night');
  bindSwitch('cbClouds', 'clouds');
  bindSwitch('cbAtmo', 'atmo');
  bindSwitch('cbAurora', 'aurora');
  bindRange('rngAuroraBright', 'auroraBright', w100, 'outAuroraBright', pct);

  $('btnCollapse').addEventListener('click', function () {
    const card = $('optsCard');
    /* ★ v44（需求 2）：折叠 / 展开统一走 __panelFit.setFolded ——
       折叠时清掉拉伸留下的 inline height（否则「内容没了、面板还占着原高度」），
       并带上 max-height / 圆角过渡。 */
    __panelFit.setFolded(card, !card.classList.contains('collapsed'));
    this.textContent = card.classList.contains('collapsed') ? '展开' : '收起';
    if (window.closeOptFly) window.closeOptFly();   // 收起面板时一并收起右侧浮层
    relayout();
  });

  /* ---- 重置全部设置 ---- */
  /* ★ 本次修复：「重置」语义统一 —— 底部控制条「重置所有设置」(#btnResetAll) 与设置菜单
     「重置所有设置」(#preReset) 此前各自为政（前者只重置 style / note，后者全量），
     现抽出单一入口 resetAllSettings()，两者都调用它。
     口径沿用 #preReset 原语义：时间、视图与布局保持不变；另外清空浮层尺寸记忆。
     ★ 本次收敛：resetAllSettings(opts) 支持 opts.full ——
       · 不传 / opts.full 为假（#preReset，以及 window.__APP.resetAll 之外的直接调用）：
         保持原语义，播放状态 / 速度 / 视图 / 分屏 / 综合布局 / 参考系全部保留；
       · opts.full 为真（底部控制条 #btnResetAll，即原 v37 处理器的语义）：只保留「模块与
         视图」（mode / view），其余一并回默认，并额外把仿真时间跳回「此刻」、复位自转 /
         公转相机、复位卡片位置、展开底部控制条。v37 那条重复注册已删除，其独有动作并入此处。 */
  function resetAllSettings(opts) {
    const full = !!(opts && opts.full);
    // full：只保留模块与视图（等价于 v37 的 `state.mode = mode; state.view = view;`）
    // 默认：时间、视图与布局保持不变（#preReset 原语义）
    const keep = full
      ? { mode: state.mode, view: state.view }
      : {
        playing: state.playing, speed: state.speed, mode: state.mode, view: state.view,
        splitX: state.splitX, splitY: state.splitY, cmb: JSON.parse(JSON.stringify(state.cmb)), lockAxis: state.lockAxis,
      };
    Object.assign(state, JSON.parse(JSON.stringify(DEFAULTS)));
    Object.assign(state, keep);
    /* ★ 本次修复（缺陷 B）：重置把 state.note 整体换成 DEFAULTS 的深拷贝 —— 必须在
       applyPanelFont（其尾部会调 __svSyncBinders → 全体 sunview 绑定器读 state.note.cats.sv*）
       之前补齐全部分类，否则 sv* 分类缺失 → 绑定器读 undefined 的 .font/.color/.op/.weight 抛
       TypeError。幂等：只在缺失时补齐，不改变「重置回默认值」的语义（重置仍回到完整默认值）。 */
    ensureNoteCats();
    applyPanelFont();                    // 面板文字样式一并回到默认
    applyUiTheme();                      // v31：UI 色系与毛玻璃一并回到默认（原色系）
    applySunTex();                       // v31（需求九）：太阳贴图一并回到默认（真实贴图）
    /* ★ v39（需求四·1）：面板拉伸尺寸 / 位置一并复位（清除内联宽高与定位） */
    ['optsCard', 'timeCard', 'geoInfo'].forEach(function (pid) {
      const c = document.getElementById(pid); if (!c) return;
      c.style.width = ''; c.style.height = ''; c.style.left = ''; c.style.top = '';
      c.style.right = ''; c.style.bottom = ''; delete c.dataset.dragInit;
    });
    /* ★ 本次：清空二级菜单浮层的尺寸记忆（state.ui.pmSize）与内联尺寸 ——
       原地清空键值而非替换对象引用（menu.js 构建浮层时缓存了 window.__pmSize 的引用）。 */
    const pm = state.ui.pmSize || (state.ui.pmSize = {});
    Object.keys(pm).forEach(function (k) { delete pm[k]; });
    window.__pmSize = pm;
    document.querySelectorAll('.opt-fly').forEach(function (f) {
      f.style.width = ''; f.style.height = ''; f.style.maxHeight = '';
    });
    clickState = null; clickMarker.visible = clickMarkerOrb.visible = false;
    $('geoInfo').classList.remove('on');
    document.querySelectorAll('[data-mon]').forEach(function (x) { x.classList.remove('on'); });
    /* ★ 收敛：full（原 v37 处理器）独有动作 —— 与 v37 原子句一一对应：
       setViewButtons() / simMs = Date.now() / syncYear(true) / applyView(VIEW_DEFAULT) /
       camNZoom = 1 / camSZoom = 1 / resetOrbCam。置于下方重算之前，与 v37 原顺序一致。 */
    if (full) {
      setViewButtons();
      simMs = Date.now(); syncYear(true);
      applyView(VIEW_DEFAULT); camNZoom = 1; camSZoom = 1; resetOrbCam();
    }
    binders.forEach(function (f) { f(); });
    applyAll(); updateSliderUI(); syncSliders(); updateScene(); updateUI(true); resize();
    /* ★ 收敛：full 的其余 v37 独有动作（原 v37 中也排在重算之后） */
    if (full) {
      if (window.resetCardPos) window.resetCardPos();
      setCbMin(false);
    }
    // v23.2：重置（含面板字体 / 全局文字注释字号）后必须落盘，否则刷新页面会被旧存档还原，
    //   导致「重置设置的字体大小」与「首次显示默认字体大小」刷新后不一致。本次起走 persistNow()。
    persistNow();
  }
  /* ★ v62（需求 2）：地球侧设置菜单里的「重置所有设置」(#preReset) 已移除 ——
     该入口统一由右上角「全局设置」浮层里的「重置所有设置」承担，它经
     window.SUN_BRIDGE.resetAllSettings()（下方导出）走到这里。
     语义不变：不传 opts ⇒ 非全量重置（保留播放状态 / 速度 / 视图 / 分屏 / 综合布局）。 */

  /* ---- 底部控制条 ---- */
  $('btnPlay').addEventListener('click', function () {
    state.playing = !state.playing;
    updateUI(true);
  });
  bindRange('rngSpeed', 'speed', thousand, 'outSpeed', fmtSpeed);
  // 「重置所有设置」（底部控制条）：走 resetAllSettings 的**全量**口径（opts.full）。
  (function () {
    const btn = $('btnResetAll'); if (!btn) return;
    /* ★ 收敛：底栏 = 全量重置（含时间跳回「此刻」+ 自转 / 公转相机复位 + 卡片复位 +
       控制条展开），即原 v37 处理器语义；原先叠加的第二个注册（v37）已删除，
       避免点击一次连续跑两遍全量重置（两次 applyAll / updateScene）。 */
    btn.addEventListener('click', function () { resetAllSettings({ full: true }); });
  })();

  // 控制条折叠 / 展开
  const cbBar = $('controlBar'), cbToggle = $('cbToggle');
  function setCbMin(min) {
    cbBar.classList.toggle('min', min);
    cbToggle.querySelector('.txt').textContent = min ? '展开' : '收起';
    resize();
  }
  cbToggle.addEventListener('click', function () { setCbMin(!cbBar.classList.contains('min')); });

  /* ============ v19.0-③：沉浸模式 ============
     进入：标题栏「自转演示」左侧的按钮（#btnImmersive）。
     效果：body.immersive → 所有面板 / 标题栏 / 控制条 / 窗格表头全部隐藏，
           3D 画面铺满整窗（TITLE_H / COMBO_HEAD_H 归零，见 syncMetrics）。
     退出：右上角按钮（#btnExitImm，默认隐形，鼠标靠近右上角淡入）+ Esc 键。 */
  let immHot = false;
  function setImmHot(on) {
    on = !!on;
    if (on === immHot) return;
    immHot = on;
    document.body.classList.toggle('imm-hot', on);
  }
  function setImmersive(on) {
    on = !!on;
    if (on === IMMERSIVE) return;
    IMMERSIVE = on;
    document.body.classList.toggle('immersive', on);
    if (!on) setImmHot(false);
    const btn = $('btnImmersive');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const exit = $('btnExitImm');
    if (exit) exit.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) showImmToast();
    // 元素显隐会改变标题栏实测高度 / 窗格表头位置 → 等样式生效后重新量测并重排
    requestAnimationFrame(function () { resize(); });
  }
  function showImmToast() {
    const old = document.querySelector('.imm-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'imm-toast';
    el.textContent = '已进入沉浸模式 · 鼠标移到右上角或按 Esc 退出';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3600);
  }
  (function () {
    const enter = $('btnImmersive'), exit = $('btnExitImm');
    if (enter) enter.addEventListener('click', function () { setImmersive(true); });
    if (exit) exit.addEventListener('click', function () { setImmersive(false); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && IMMERSIVE) { e.preventDefault(); setImmersive(false); }
    });
    /* ★ v39（需求四·2）：空格键切换「时间暂停 / 播放」（所有视图通用）。
       注意：输入框（自定义时间 / 观测点经纬度 / 文本框）聚焦时不拦截，
       否则用户无法键入空格。 */
    window.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      /* ★ 本次：空格已被更靠内的组件（一级菜单项 .opt-row.lv1 / 三级分组标题 .nd-h 的
         keydown 委托）当作「激活」键消费（已 preventDefault）时，不再触发全局暂停 / 播放。 */
      if (e.defaultPrevented) return;
      var t = e.target, tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
          (t && t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      state.playing = !state.playing;
      updateUI(true);
      var sb = $('svBtnPlay'); if (sb) sb.textContent = state.playing ? '暂停' : '播放';
    });
    // 鼠标靠近右上角 → 淡入退出按钮（热区按界面缩放系数等比放大，触摸屏也适用）
    function nearCorner(e) {
      const s = uiScale();
      return e.clientX > window.innerWidth - 200 * s && e.clientY < 120 * s;
    }
    window.addEventListener('mousemove', function (e) {
      setImmHot(IMMERSIVE && nearCorner(e));
    }, { passive: true });
    window.addEventListener('touchstart', function (e) {
      const t = e.touches && e.touches[0];
      if (IMMERSIVE && t) setImmHot(nearCorner(t));
    }, { passive: true });
    // 沉浸模式下鼠标移出窗口 / 窗口失焦也收起按钮
    document.addEventListener('mouseleave', function () { setImmHot(false); });
    window.addEventListener('blur', function () { setImmHot(false); });
  })();

  // v23.17：「默认视角」同时复位自转相机与公转相机（公转当前是哪种镜头就复位哪种）
  $('btnViewDefault').addEventListener('click', function () { applyView(VIEW_DEFAULT); resetOrbCam(); });
  $('btnViewEquator').addEventListener('click', function () { applyView(VIEW_EQUATOR); });
  // v19.0-②：「重置视角」按钮已移除（默认视角 / 赤道上空 已覆盖该用途）
  /* ★ 本次收敛：原 v37 在此对 #btnResetAll 的**第二个** click 处理器（全量重置 + 时间跳回
     「此刻」+ 自转 / 公转相机复位 + 卡片复位 + 控制条展开）已删除 —— 它的每一条动作都已并入
     resetAllSettings({ full: true })（见「重置全部设置」段），由上方唯一注册调用。
     此前两个处理器叠加 = 点击一次连跑两遍全量重置（含两次 applyAll / updateScene），
     且 resetAllSettings 的「保留视图」被这里的 applyView(VIEW_DEFAULT) 立刻覆盖，自相矛盾。 */

  // 参考系切换：地轴固定（太阳光线绕转） / 光线固定（地球自转）
  const frameWrap = $('segFrame');
  frameWrap.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.lockAxis = b.dataset.frame === 'earth';
      setFrameButtons(); updateScene(); updateUI(true);
    });
  });
  function setFrameButtons() {
    frameWrap.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.frame === 'earth') === !!state.lockAxis);
    });
  }

  function updateSliderUI() {
    binders.forEach(function (f) { f(); });
    setModeButtons();
    setFrameButtons();
    setOrbCamButtons();
    setComboModeButtons();
  }

  const modeWrap = $('segMode');
  modeWrap.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { state.mode = b.dataset.mode; setModeButtons(); resize(); });
  });
  function setModeButtons() {
    modeWrap.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === state.mode);
    });
    /* ★ v40（需求六）：同步新的二级菜单下拉（#dropMode）勾选态 */
    const dm = $('dropMode');
    if (dm) dm.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === state.mode);
    });
    // v27.0（需求三.2）：单窗 / 三窗切换 → 同步 body[data-rmode]，
    // 驱动「一致 / 简洁」开关（segComboMode）在自转三窗下的显隐
    document.body.dataset.rmode = state.mode;
  }

  // v23.17：公转镜头切换（全局视角 / 地球特写）——分布与「单窗 / 三窗」一致
  const orbCamWrap = $('segOrbCam');
  orbCamWrap.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.orbCam = b.dataset.orbcam; setOrbCamButtons();
      if (state.orbCam === 'close') resetOrbCam();   // 切到特写先回到默认机位，避免沿用全局视角的角度
      resize();
    });
  });
  function setOrbCamButtons() {
    orbCamWrap.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.orbcam === state.orbCam);
    });
    /* ★ v40（需求六）：同步新的二级菜单下拉（#dropOrbCam）勾选态 */
    const dc = $('dropOrbCam');
    if (dc) dc.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.orbcam === state.orbCam);
    });
    syncOrbPaneTitle();
  }

  /* v23.18（需求③）：公转视图的窗口标题条。
     全景 / 特写共用同一条表头，切换镜头时**只换文字、不重排布局** ——
     标题行的高度与位置由 CSS 固定，故「首行标题平稳过渡、无跳动」。
     同时让公转视图也有标题条，浮窗停靠高度（--dock-top）与自转 / 综合视图一致，
     切换视图时浮窗不再上下跳。 */
  function syncOrbPaneTitle() {
    const t = $('orbPaneTitle'), h = $('orbPaneHint');
    if (!t) return;
    const close = state.orbCam === 'close';
    const txt = close ? '地球公转 · 特写' : '地球公转 · 全景';
    if (t.textContent !== txt) t.textContent = txt;
    if (h) {
      const hint = close ? '拖动环绕 · 滚轮/双指缩放 · 默认视角在直射点西北侧'
        : '拖动旋转 · 滚轮/双指缩放 · 默认视角看整条轨道';
      if (h.textContent !== hint) h.textContent = hint;
    }
  }

  // v23.18（需求④）：综合视图显示规则切换（一致 / 简洁）
  const comboModeWrap = $('segComboMode');
  if (comboModeWrap) {
    comboModeWrap.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.comboMode = b.dataset.combomode; setComboModeButtons(); resize();
      });
    });
  }
  function setComboModeButtons() {
    if (comboModeWrap) comboModeWrap.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.combomode === state.comboMode);
    });
    /* ★ v40（需求六）：同步新的二级菜单下拉（#dropComboMode）勾选态 */
    const dcm = $('dropComboMode');
    if (dcm) dcm.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.combomode === state.comboMode);
    });
  }

  // 顶层视图切换（自转 / 公转 / 综合 / 太阳视运动）
  /* ★ 本批次（需求二）：一级按钮留在 #segView 内，而**二级视图组已整体搬到
     #tbm2Lv2Host**（「沉浸模式」左侧），故这里同时取两个容器，
     否则 querySelectorAll('.tbm2-lv2grp') / ('.tbm2-lv2') 会一个都找不到，
     导致二级组永远不高亮、也点不出来。 */
  const viewWrap = $('segView');
  const lv2Host = $('tbm2Lv2Host') || viewWrap;
  const q = function (sel) { return Array.prototype.slice.call(viewWrap.querySelectorAll(sel))
    .concat(Array.prototype.slice.call(lv2Host.querySelectorAll(sel))); };
  function setViewButtons() {
    /* ★ v40（需求六）：两行总菜单 ——
       第一行（一级）高亮当前模块（地球运动 / 太阳视运动）；
       第二行（二级）只显示当前模块对应的视图项，并高亮当前视图。 */
    var isSun = (state.view === 'sun');
    q('.tbm2-lv1').forEach(function (b) {
      b.classList.toggle('on', (b.dataset.lv1 === 'sun') === isSun);
    });
    q('.tbm2-lv2grp').forEach(function (g) {
      g.classList.toggle('on', (g.dataset.lv2grp === 'sun') === isSun);
    });
    // 二级视图项高亮（太阳侧由 SUNVIEW 状态决定）
    var sunSub = (typeof window.SUNVIEW !== 'undefined' && window.SUNVIEW.state) ? window.SUNVIEW.state().view : 'ground';
    q('.tbm2-lv2').forEach(function (item) {
      var grp = item.closest('.tbm2-lv2grp');
      var isSunItem = grp && grp.dataset.lv2grp === 'sun';
      var on = isSunItem ? (isSun && item.dataset.lv2 === sunSub)
                         : (!isSun && item.dataset.lv2 === state.view);
      item.classList.toggle('on', on);
      /* ★ v40：视图按钮本身也加 .on —— 统一「按钮 / 行」两级高亮，
         便于外部（探针 / 样式）直接按按钮判断当前视图。 */
      var btn = item.querySelector('.tbm2-lv2btn');
      if (btn) btn.classList.toggle('on', on);
    });
    document.body.dataset.view = state.view;   // 控制"单窗/三窗"按钮仅在自转视图显示
    // v27.0（需求三.2）：三窗的「一致 / 简洁」与综合视角共用 segComboMode 开关 ——
    //   自转视图 + 三窗时也显示该开关（CSS 由 body[data-rmode] 驱动）
    document.body.dataset.rmode = state.mode;
    // v23.17：公转镜头按钮仅在公转视图显示（由 body[data-view] 驱动，这里顺带同步高亮态）
    setOrbCamButtons();
    // v20.0：左侧徽标改为地球图片 → 视图信息改由提示 + 高亮态表达（不再写文字）
    const badge = $('badgeView');
    if (badge) {
      // v23.18（需求⑦）：视图名称统一为「自转视图 / 公转视图 / 综合视图」
      const nm = state.view === 'revolve' ? '公转视图'
        : state.view === 'combo' ? '综合视图'
        : state.view === 'sun' ? '太阳视运动' : '自转视图';
      badge.title = '当前视图：' + nm;
      badge.dataset.view = state.view;
    }
    syncOrbPaneTitle();   // v23.18（需求③）：公转窗口标题随视图 / 镜头同步
  }
  /* ★ v40（需求六）：暴露给 sunview —— 太阳模块内部切换地面/天球视图后，
     需要重算两行总菜单的二级高亮（否则二级项仍停在旧视图）。 */
  window.__setViewButtons = setViewButtons;
  /* ★ v40（需求六）：两行总菜单交互 ——
     点击一级按钮切模块（高亮 + 显示对应二级行）；
     点击二级视图按钮切视图；点击二级行末「▾」开合窗口选项下拉（单窗/三窗、全景/特写、一致/简洁）；
     点击空白处收起所有下拉。 */
  (function () {
    if (!viewWrap) return;
    function closeAllDrops(except) {
      q('.tbm2-lv2').forEach(function (it) {
        if (it !== except) it.classList.remove('open');
      });
    }
    q('.tbm2-lv1').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        /* 一级按钮只切模块：地球运动 → 保持/回到其当前视图；太阳视运动 → 进入太阳视图。
           真正的视图切换由二级按钮完成，这里仅做“切换模块 + 默认视图”。 */
        if (b.dataset.lv1 === 'sun') {
          if (typeof window.SUNVIEW !== 'undefined' && window.SUNVIEW.enter) window.SUNVIEW.enter();
          else { state.view = 'sun'; setViewButtons(); resize(); }
        } else {
          if (state.view === 'sun' && typeof window.SUNVIEW !== 'undefined' && window.SUNVIEW.exit) {
            window.SUNVIEW.exit();
          } else {
            setViewButtons();
          }
        }
      });
    });
    // 二级行末「▾」按钮：开合该行的窗口选项下拉
    q('.tbm2-more').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var item = btn.closest('.tbm2-lv2');
        var willOpen = !item.classList.contains('open');
        closeAllDrops(item);
        item.classList.toggle('open', willOpen);
      });
    });
    // 点击下拉内的选项（单窗/全景/一致…）：收起下拉（实际切换由各自 binder 处理）
    q('.tbm2-drop button').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); closeAllDrops(null); });
    });
    /* ★ v41（需求三.2）：新下拉（#dropMode/#dropOrbCam/#dropComboMode）的选项按钮
       此前只被 setXxxButtons() 同步勾选态、**没有绑定点击**，导致点它无法切换视角模式。
       这里补齐点击 → 写状态 + 同步按钮 + 重排布局。 */
    var dm2 = $('dropMode');
    if (dm2) dm2.querySelectorAll('button[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { state.mode = b.dataset.mode; setModeButtons(); resize(); });
    });
    var dc2 = $('dropOrbCam');
    if (dc2) dc2.querySelectorAll('button[data-orbcam]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.orbCam = b.dataset.orbcam; setOrbCamButtons();
        if (state.orbCam === 'close') resetOrbCam();
        resize();
      });
    });
    var dcm2 = $('dropComboMode');
    if (dcm2) dcm2.querySelectorAll('button[data-combomode]').forEach(function (b) {
      b.addEventListener('click', function () { state.comboMode = b.dataset.combomode; setComboModeButtons(); resize(); });
    });
    document.addEventListener('click', function () { closeAllDrops(null); });
  })();
  q('button[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.dataset.view; setViewButtons();
      $('geoInfo').classList.remove('on'); clickMarker.visible = false; clickState = null;
      resize();
    });
  });

  /* ★ v53：URL 参数预置 —— index.html?module=earth|sun&view=...
     为什么加这个：桌面启动器（gis3d-desktop）用它来「直接打开某个模块的某个视图」，
     但此前**全工程没有任何一处读取 location.search**，
     于是启动器的每一条链接都只能进默认的自转视图 —— 链接形同虚设。
     现在按参数预置：
       ?module=earth&view=rotate|revolve|combo  → 地球运动对应视图
       ?module=sun&view=ground|sky|combo        → 太阳视运动对应视图
     无参数或参数非法时保持出厂默认，不影响常规打开。

     ★ 时机：必须在**全部模块初始化完成之后**才执行。
       早前就地立即调用会撞上 const/let 的 TDZ —— resize() 依赖后面才声明的
       IMMERSIVE / TITLE_H 等，报「Cannot access 'IMMERSIVE' before initialization」
       而整段初始化中断（画布停在 300×150 默认尺寸、桥接接口都没挂上）。
       故改为：算出参数 → 存到 _urlPreset → 在 boot 末尾（setTimeout 0，等所有
       同步初始化跑完）再执行。 */
  var _urlPreset = (function () {
    var sp;
    try { sp = new URLSearchParams(location.search); } catch (e) { return null; }
    var mod = String(sp.get('module') || '').toLowerCase();
    var vw = String(sp.get('view') || '').toLowerCase();
    if (!mod && !vw) return null;
    return { mod: mod, view: vw };
  })();
  function applyUrlPreset() {
    if (!_urlPreset) return;
    var mod = _urlPreset.mod, vw = _urlPreset.view;
    var EARTH_VIEWS = ['rotate', 'revolve', 'combo'];
    if (mod === 'earth' || (!mod && EARTH_VIEWS.indexOf(vw) >= 0)) {
      if (EARTH_VIEWS.indexOf(vw) >= 0) { state.view = vw; setViewButtons(); resize(); }
      return;
    }
    if (mod === 'sun' || vw === 'ground' || vw === 'sky' || vw === 'combo') {
      if (window.SUNVIEW && SUNVIEW.enter) SUNVIEW.enter();
      var sel = (vw === 'ground' || vw === 'sky' || vw === 'combo') ? vw : 'ground';
      var btn = document.querySelector('button[data-sunview="' + sel + '"]');
      if (btn) btn.click();
    }
  }

  /* ============ 布局 & 渲染 ============ */
  // 界面缩放系数（与 style.css 的 --ui 保持一致）；标题栏高度、综合视图表头与间隙随其等比缩放
  function uiScale() {
    // 根字号 = 13px × --ui，浏览器会先把 calc 求值再返回，因此这里读到的是最终数值
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return (fs && fs > 0) ? fs / 13 : 1;
  }
  let TITLE_H = 58, COMBO_HEAD_H = 30, COMBO_PAD = 8, COMBO_GAP = 6;
  /* v19.0-③：沉浸模式开关（由「沉浸模式」按钮 / Esc 切换）。
     开启后所有面板与标题栏隐藏，3D 画面铺满整窗 —— 布局上等价于：
     标题栏高度归零、综合视图表头与内边距归零。 */
  let IMMERSIVE = false;
  function syncMetrics() {
    const tb = $('titleBar');
    if (IMMERSIVE) TITLE_H = 0;
    else if (tb && tb.offsetHeight) TITLE_H = tb.offsetHeight;   // 直接量取，避免与 CSS 不同步
    const ui = uiScale();
    COMBO_HEAD_H = IMMERSIVE ? 0 : Math.round(30 * ui);
    COMBO_PAD = IMMERSIVE ? 0 : Math.round(8 * ui);
    COMBO_GAP = Math.round(6 * ui);
    /* ★ 本批次（需求一）：把地球侧窗格顶边口径暴露出去，供太阳视运动单视图标题栏
       定位使用 —— 两边共用同一个「标题栏高 + 间隙」算法，任何缩放 / 沉浸切换都严格对齐
       （此前太阳侧自己按 PF.uiScale() 换算，间隙与地球侧差 2px）。 */
    window.__earthPaneTop = function () { return TITLE_H + COMBO_PAD; };
  }
  /* 浮窗默认停靠高度（--dock-top）：
     自转（单窗/三窗）与综合视图顶部都有一行"窗格标题条"，浮窗若与它齐平就会把标题压住。
     因此这些视图下把浮窗整体下移到标题条之下；公转视图没有标题条，仍紧贴标题栏下方。
     这里直接量取标题条的真实下沿（比按 COMBO_HEAD_H 推算更准，CSS 边框/内边距会有 1~2px 误差）。 */
  let dockTop = 70;
  function syncDockTop() {
    const ui = uiScale();
    let base = Math.round(TITLE_H + 12 * ui);
    /* v23.18（需求③）：公转视图现在也有窗口标题条 —— 三个视图统一量取「标题条下沿」，
       浮窗停靠高度在各视图之间保持一致，切换视图时不再上下跳动。 */
    const sel = (state.view === 'combo') ? '#comboUI .ccell-h' : '#panes .pane.on .pane-h';
    let bottom = 0;
    document.querySelectorAll(sel).forEach(function (h) {
      const b = h.getBoundingClientRect();
      if (b.width > 0 && b.top < TITLE_H + 64) bottom = Math.max(bottom, b.bottom);
    });
    if (bottom) base = Math.round(Math.max(base, bottom + 8 * ui));
    dockTop = base;
    document.documentElement.style.setProperty('--dock-top', base + 'px');
  }
  /* ★ v40（需求四 + 需求一）：面板**自动拉伸完整显示**，禁止裁剪 / 折叠。
     旧实现给面板写 --cap + 内联 max-height → 内容超高就被裁掉（需内部滚动）。
     用户要求「时间面板自动拉伸以完整显示全部内容，禁止出现折叠」。
     新实现：去掉一切高度上限；若面板自然高度超出「视口可用高度」（或综合视图下会被
     下方窗格标题遮挡），则**整体等比缩小**（zoom，写 --timecard-fit），
     仍完整显示全部内容，绝不裁剪。
     说明：zoom 会同步缩放文字与间距，读起来依旧是「完整一屏」，比滚动条更符合诉求。 */
  function syncPanelCap() {
    let spans = null;
    if (state.view === 'combo') {
      spans = [];
      document.querySelectorAll('#comboUI .ccell-h').forEach(function (h) {
        const sp = h.querySelector('span') || h;
        const b = sp.getBoundingClientRect();
        if (b.width >= 4 && b.height >= 4) spans.push(b);
      });
    }
    // 需要「完整显示」的面板（时间面板必须；其余面板保留自适应缩放）
    /* ★ v44（需求二）：观测点数据面板 (#geoInfo) 也纳入「整体等比缩小以完整显示」——
       该面板已按需求去掉一切滚动条，内容超高时只能靠 zoom 收进视口，否则会顶到窗口下沿外。 */
    const FIT_IDS = ['timeCard', 'geoInfo'];
    ['optsCard', 'timeCard', 'geoInfo'].forEach(function (id) {
      const el = $(id); if (!el) return;
      const cur = el.style.getPropertyValue('--cap');
      // v40：彻底移除旧的高度上限（内联 max-height 由旧版本写入过，需清掉）
      if (el.style.maxHeight) el.style.maxHeight = '';
      if (cur) el.style.removeProperty('--cap');
      const prev = el.style.getPropertyValue('--timecard-fit');   // 必须在早退之前取（★ v41 折叠分支要用）
      if (FIT_IDS.indexOf(id) < 0) return;   // 仅时间面板做「自动拉伸缩放」
      /* ★ v41（需求二·1）：折叠态只剩表头一行，不存在「内容超高」，
         清掉整体缩放补偿，展开时再由下面的自然高度测量重新写入。 */
      if (el.classList.contains('min')) {
        if (prev) el.style.removeProperty('--timecard-fit');
        return;
      }

      /* 计算可用高度：视口下沿 - 面板顶部 - 余量；综合视图下再夹到「下方窗格标题」之上。 */
      const r = el.getBoundingClientRect();
      let avail = Math.round(window.innerHeight - r.top - 10);
      if (spans) {
        for (let i = 0; i < spans.length; i++) {
          const b = spans[i];
          if (b.top <= dockTop + 6) continue;
          if (b.right < r.left + 2 || b.left > r.right - 2) continue;
          avail = Math.min(avail, Math.round(b.top - r.top - 8));
        }
      }
      avail = Math.max(160, avail);
      /* 先复位缩放，量出自然高度，再据比例写入 fit（下限 0.62，避免小到不可读）。 */
      if (prev) el.style.removeProperty('--timecard-fit');
      const natural = el.scrollHeight || el.getBoundingClientRect().height;
      let fit = 1;
      if (natural > avail && natural > 0) fit = Math.max(0.62, avail / natural);
      const fitStr = fit.toFixed(3);
      if (prev !== fitStr) el.style.setProperty('--timecard-fit', fitStr);
    });
  }
  /* 浮窗尺寸/显隐变化后重排窗格布局（综合视图需要重算子窗；三窗已铺满全屏，
     重排只为同步分隔条与浮窗停靠高度，无害） */
  function relayout() {
    if (state.view === 'combo' || (state.view === 'rotate' && state.mode === 'triple')) resize();
  }
  function resize() {
    syncMetrics();
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
    const inOrb = state.view === 'revolve';

    const pad = IMMERSIVE ? 0 : 8;
    if (state.view === 'rotate' && state.mode === 'triple') {
      // 三窗布局仅属于自转视图；公转/综合视图一律全屏，不显示分隔条
      // 右列铺满：顶部到标题栏下方，底部到控制条上方（沉浸模式下两者都消失 → 铺满全窗）
      const cbT = IMMERSIVE ? h : $('controlBar').getBoundingClientRect().top;
      let top = TITLE_H + pad;
      let bottom = IMMERSIVE ? h : Math.min(h - pad, cbT - 10);
      if (bottom - top < 240) bottom = h - pad;
      // v4.4 三窗铺满全屏：左右不再给浮窗让出竖带，窗格占满整屏宽度，
      // 显示设置 / 时间 / 观测点面板直接悬浮在窗格上方
      const x0 = 0, x1 = w;
      const availW = x1 - x0;
      const totalW = Math.max(280, availW - pad);
      const leftW = Math.round(clamp(totalW * state.splitX, 160, Math.max(160, totalW - 160)));
      const rx = x0 + leftW + pad, rw = Math.max(140, availW - pad - leftW);
      const totalH = bottom - top - pad;
      const nh = Math.round(clamp(totalH * state.splitY, 110, Math.max(110, totalH - 110)));
      layout.main = { x: x0, y: top, w: leftW, h: h - pad - top };
      layout.north = { x: rx, y: top, w: rw, h: nh };
      layout.south = { x: rx, y: top + nh + pad, w: rw, h: totalH - nh };
    } else {
      // v26.1（需求⑪）：与三窗 / 公转视图统一留出 pad 的顶隙（此前单窗直接贴着标题栏）
      layout.main = { x: 0, y: TITLE_H + pad, w: w, h: h - TITLE_H - pad };
      layout.north = null; layout.south = null;
    }
    positionPane('paneMain', inOrb ? null : layout.main, true);
    positionPane('paneNorth', inOrb ? null : layout.north, false);
    positionPane('paneSouth', inOrb ? null : layout.south, false);
    // v23.18（需求③）：公转视图的窗口标题条（全景 / 特写共用，切换只换文字）
    positionPane('paneOrb', inOrb ? orbitViewRect() : null, false);
    $('paneNorth').classList.toggle('on', !!layout.north);
    $('paneSouth').classList.toggle('on', !!layout.south);
    positionSplitters();

    // 顶层视图切换：综合视图需要计算子窗口；自转 / 公转视图显示各自的窗格边框与窗口名
    const cv = $('comboUI'), pn = $('panes');
    if (state.view === 'combo') { buildComboUI(); computeCombo(); cv.classList.add('on'); pn.style.display = 'none'; }
    else {
      cv.classList.remove('on');
      pn.style.display = '';   // v23.18：公转视图也有窗口标题条了（此前全屏无边框）
      syncOrbPaneTitle();
    }
    syncDockTop();   // 在窗格/子窗排版完成后量取表头下沿，再决定浮窗的停靠高度
    syncPanelCap();  // 再据"下方标题条最上沿"限制浮窗高度，确保铺满全窗时标题也不被压住
  }

  function positionSplitters() {
    const spV = $('spVert'), spH = $('spHorz');
    if (state.mode !== 'triple' || !layout.north) {
      spV.classList.remove('on'); spH.classList.remove('on'); return;
    }
    const pad = 8;
    spV.classList.add('on'); spH.classList.add('on');
    spV.style.left = (layout.main.x + layout.main.w) + 'px';
    spV.style.top = layout.main.y + 'px';
    spV.style.width = pad + 'px';
    spV.style.height = layout.main.h + 'px';
    spH.classList.add('on');
    spH.style.left = layout.north.x + 'px';
    spH.style.top = (layout.north.y + layout.north.h) + 'px';
    spH.style.width = layout.north.w + 'px';
    spH.style.height = pad + 'px';
  }

  /* ---------- 浮窗：时间面板 / 显示设置 可拖动 ---------- */
  // v3.9 修复：此前面板内任意非控件区域按下都会立即抢占指针（setPointerCapture +
  // preventDefault）并启动拖动 —— 在可滚动面板主体上滑动会被"拖窗"劫持，
  // 触摸无法滚动、鼠标轻微拖动就带动整窗，表现为"面板卡顿 / 无法滑动 / 下方内容看不到"。
  // 现改为：仅允许从表头（.card-head，带抓手光标）发起拖动，面板主体完整保留滚动。
  function makeDraggable(card) {
    const SKIP = 'input, select, button, label, output, a, .ticks, .term-note, .sb, .link';
    let st = null;
    card.dataset.dragInit = '';
    card.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest(SKIP)) return;
      // 只有表头才能发起拖动；主体区域交给原生滚动 / 文本选择
      if (!e.target.closest || !e.target.closest('.card-head')) return;
      const r = card.getBoundingClientRect();
      if (!card.dataset.dragInit) {
        card.style.left = r.left + 'px';
        card.style.top = r.top + 'px';
        card.style.right = 'auto'; card.style.bottom = 'auto';
        card.dataset.dragInit = '1';
      }
      st = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      card.classList.add('grabbing');
      if (card.setPointerCapture) card.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    card.addEventListener('pointermove', function (e) {
      if (!st) return;
      const r = card.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      const tbB = $('titleBar').getBoundingClientRect().bottom;
      const x = clamp(e.clientX - st.dx, 6, Math.max(6, W - r.width - 6));
      const y = clamp(e.clientY - st.dy, tbB + 6, Math.max(tbB + 6, H - r.height - 6));
      card.style.left = x + 'px'; card.style.top = y + 'px';
    });
    function end() {
      if (!st) return;
      st = null; card.classList.remove('grabbing');
      /* ★ v44（需求三）：松手后把面板夹回可见区域，并消解与其它面板的重叠 */
      try { __panelFit.clampPos(card); __panelFit.resolve(card, mainPanelNodes()); } catch (er) { }
      syncPanelCap();   // 浮窗换了位置 → 重新按它下方的窗格标题算高度上限
    }
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('lostpointercapture', end);
  }
  /* ★ v44（需求三）：主模块参与「边界夹取 / 重叠消解」的面板（+ 综合视图的 6 个演示悬浮窗） */
  function mainPanelNodes() {
    const list = [$('optsCard'), $('timeCard'), $('geoInfo')];
    if (window.MV_PANELS) {
      /* 演示悬浮窗由 app.js 注册（.mvwin），同样纳入重叠消解 */
      document.querySelectorAll('.mvwin').forEach(function (n) { list.push(n); });
    }
    return list.filter(Boolean);
  }
  const dragCards = [$('timeCard'), $('optsCard')];
  dragCards.forEach(makeDraggable);

  /* ★ v39（需求四·1）：主模块面板（设置 / 时间 / 观测点信息）支持 8 向适度拉伸 ——
     与太阳侧浮窗（makeFloatPanel）同一套抓手行为；内容随高度自适应（正文区滚动）。
     尺寸 / 位置记忆在 state.pmSize[id]，随其它设置一并持久化。 */
  function makeResizable(card, opts) {
    if (!card || card.dataset.rsInit) return;
    card.dataset.rsInit = '1';
    opts = opts || {};
    const id = card.id || 'pm';
    /* 尺寸 / 位置记忆在 state.ui.pmSize[id]（随 LS_UI 一并持久化）。 */
    state.ui.pmSize = state.ui.pmSize || {};
    const lay = state.ui.pmSize[id] || (state.ui.pmSize[id] = {});
    if (lay.w) card.style.width = lay.w + 'px';
    if (lay.h) card.style.height = lay.h + 'px';
    const minW = opts.minW || 220, minH = opts.minH || 120;
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (d) {
      const gp = document.createElement('div');
      gp.className = 'pm-grip ' + d;
      card.appendChild(gp);
      let rs = false, sx = 0, sy = 0, sw = 0, sh = 0, sl = 0, st = 0;
      gp.addEventListener('pointerdown', function (e) {
        e.stopPropagation(); e.preventDefault();
        const r = card.getBoundingClientRect();
        card.style.left = r.left + 'px'; card.style.top = r.top + 'px';
        card.style.right = 'auto'; card.style.bottom = 'auto';
        if (card.dataset.dragInit) { /* 已由拖动初始化过定位 */ } else card.dataset.dragInit = '1';
        rs = true; sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top;
        card.classList.add('pm-resizing');
        if (gp.setPointerCapture) { try { gp.setPointerCapture(e.pointerId); } catch (er) { } }
      });
      gp.addEventListener('pointermove', function (e) {
        if (!rs) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        const tbB = $('titleBar').getBoundingClientRect().bottom;
        let nw = sw, nh = sh, nl = sl, nt = st;
        /* ★ v44（需求三）：下限取「按实测内容算出的 --pm-min-w/h」（内容不被裁剪），
           再夹进本类面板的宽高比区间；位置一律留在可见区域内。 */
        let limW = minW, limH = minH;
        try { const mm = __panelFit.minOf(card, opts.fit); limW = Math.max(limW, mm.minW); limH = Math.max(limH, mm.minH); } catch (er) { }
        if (d.indexOf('e') >= 0) nw = Math.max(limW, sw + dx);
        if (d.indexOf('s') >= 0) nh = Math.max(limH, sh + dy);
        if (d.indexOf('w') >= 0) { nw = Math.max(limW, sw - dx); nl = sl + (sw - nw); }
        if (d.indexOf('n') >= 0) { nh = Math.max(limH, sh - dy); nt = st + (sh - nh); }
        let fitd;
        try { fitd = __panelFit.clampRect(card, nw, nh, opts.fit); } catch (er) { fitd = { w: nw, h: nh }; }
        nw = fitd.w; nh = fitd.h;
        if (d.indexOf('w') >= 0) nl = sl + (sw - nw);
        if (d.indexOf('n') >= 0) nt = st + (sh - nh);
        nl = clamp(nl, 2, Math.max(2, window.innerWidth - nw - 2));
        nt = clamp(nt, tbB + 2, Math.max(tbB + 2, window.innerHeight - nh - 2));
        card.style.width = nw + 'px'; card.style.height = nh + 'px';
        card.style.left = nl + 'px'; card.style.top = nt + 'px';
      });
      const rstop = function () {
        if (!rs) return; rs = false; card.classList.remove('pm-resizing');
        try {
          const s = __panelFit.clampRect(card, card.offsetWidth, card.offsetHeight, opts.fit);
          card.style.width = s.w + 'px'; card.style.height = s.h + 'px';
          __panelFit.clampPos(card);
          __panelFit.resolve(card, mainPanelNodes());
        } catch (er) { }
        lay.w = card.offsetWidth; lay.h = card.offsetHeight;
        lay.x = parseFloat(card.style.left); lay.y = parseFloat(card.style.top);
        persist();
      };
      gp.addEventListener('pointerup', rstop);
      gp.addEventListener('pointercancel', rstop);
      gp.addEventListener('lostpointercapture', rstop);
    });
  }
  /* ★ v44（需求三）：`fit` = 该面板的「内容特征档」（最小宽高 + 宽高比区间）；
     applyMin 会用离屏克隆实测内容自然尺寸，算出「不被裁剪」的最小宽高写进 --pm-min-w/h。 */
  [['optsCard', { minW: 252, minH: 140, fit: 'menu' }],
   ['timeCard', { minW: 260, minH: 130, fit: 'time' }],
   ['geoInfo', { minW: 220, minH: 110, fit: 'info' }]]
    .forEach(function (p) {
      const n = $(p[0]); if (!n) return;
      makeResizable(n, p[1]);
      try { __panelFit.applyMin(n, p[1].fit); } catch (e) { }
    });
  /* ★ v32（需求十一）：底部控制条改成「可拖动」——
     默认仍居中停底；一旦通过抓手拖过，就用 left/top 定位并记住位置，
     双击抓手复位回默认（居中停底）。与浮窗拖动互不影响。 */
  (function () {
    const bar = $('controlBar'), grip = $('cbGrip');
    if (!bar || !grip) return;
    let st = null;
    /* ★ v32：双击复位不能只靠 `dblclick` 事件 —— 下面的 pointerdown 里调了
       `e.preventDefault()`（防止拖动时选中文字），Chrome 会因此**不再合成
       mousedown/mouseup，也就不会派发 click / dblclick**，于是「双击抓手复位」
       在真实浏览器里同样失灵。改为在 pointerdown 里自己按「时间 + 位移」判定双击。 */
    let lastTap = 0, lastX = 0, lastY = 0;
    const reset = function () {
      delete bar.dataset.barDrag;
      bar.style.left = ''; bar.style.top = ''; bar.style.bottom = ''; bar.style.transform = '';
    };
    grip.addEventListener('dblclick', reset);
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      const now = Date.now();
      if (now - lastTap < 350 && Math.abs(e.clientX - lastX) < 6 && Math.abs(e.clientY - lastY) < 6) {
        lastTap = 0; st = null;
        bar.classList.remove('grabbing');
        reset();
        e.preventDefault();
        return;
      }
      lastTap = now; lastX = e.clientX; lastY = e.clientY;
      const r = bar.getBoundingClientRect();
      if (!bar.dataset.barDrag) {
        bar.style.left = r.left + 'px'; bar.style.top = r.top + 'px';
        bar.style.bottom = 'auto'; bar.style.transform = 'none';
        bar.dataset.barDrag = '1';
      }
      st = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.classList.add('grabbing');
      if (grip.setPointerCapture) grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!st) return;
      const r = bar.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      const x = clamp(e.clientX - st.dx, 6, Math.max(6, W - r.width - 6));
      const y = clamp(e.clientY - st.dy, 6, Math.max(6, H - r.height - 6));
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
    });
    const end = function () { if (!st) return; st = null; bar.classList.remove('grabbing'); };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
  })();
  window.addEventListener('resize', function () {
    dragCards.forEach(function (c) {
      if (!c.dataset.dragInit) return;
      const r = c.getBoundingClientRect();
      const tbB = $('titleBar').getBoundingClientRect().bottom;
      const x = clamp(r.left, 6, Math.max(6, window.innerWidth - r.width - 6));
      const y = clamp(r.top, tbB + 6, Math.max(tbB + 6, window.innerHeight - r.height - 6));
      c.style.left = x + 'px'; c.style.top = y + 'px';
    });
    syncPanelCap();   // 视口变化 → 重新夹取面板高度上限
  });
  /* 面板滚轮兜底（v3.9.2）：部分内核 / 嵌入环境下，原生滚轮对 overflow 滚动容器
     没有响应（面板内容超高却滚不动）。这里接管三个浮窗内的滚轮事件：
     从事件目标向外层找"还能朝滚动方向滚动"的容器（最内层优先，滚到边界自动
     接力到外层，如 .pt-list → .card-body），手动滚动。仅在确实滚动了内容时
     preventDefault，因此无内容可滚时行为与原来一致；地球缩放的 wheel 监听
     绑在 canvas 上，与面板互不干扰。 */
  [$('optsCard'), $('timeCard'), $('geoInfo')].forEach(function (el) {
    if (!el) return;
    el.addEventListener('wheel', function (e) {
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;   // 行模式换算为像素
      let t = e.target, scroller = null;
      while (t && t !== el.parentElement) {
        if (t.nodeType === 1 && t.scrollHeight > t.clientHeight + 1) {
          const canDown = d > 0 && t.scrollTop + t.clientHeight < t.scrollHeight - 1;
          const canUp = d < 0 && t.scrollTop > 1;
          if (canDown || canUp) { scroller = t; break; }
        }
        t = t.parentElement;
      }
      if (!scroller) return;
      e.preventDefault();
      scroller.scrollTop += d;
    }, { passive: false, capture: true });
  });
  /* ★ v41（需求二·1）：地球运动视图时间面板**恢复表头 + 折叠按钮**。
     v40 曾为「自动拉伸完整显示」把 #btnTcCollapse 连同父节点一起 display:none 并禁用折叠；
     现撤销该限制：表头常驻（🕐 时间 + 摘要 #tMini），右侧「折叠 / 展开」按钮可点，
     折叠后面板收成胶囊（只留表头一行 + 摘要读数），自动拉伸（--timecard-fit）逻辑保留。 */
  (function () {
    const tc = $('timeCard'), tcBtn = $('btnTcCollapse');
    if (!tc || !tcBtn) return;
    function applyTcMin(on) {
      /* ★ v44（需求 2）：折叠时清掉拉伸留下的 inline height（旧实现只把正文藏起来，
         卡片仍占原高度）；展开时恢复。圆角 / 过渡由 style.css 的折叠块承担。 */
      if (on) {
        if (tc.style.height) { tc.dataset.preH = tc.style.height; tc.style.height = ''; }
      } else if (tc.dataset.preH) { tc.style.height = tc.dataset.preH; delete tc.dataset.preH; }
      if (!on) tc.style.removeProperty('--timecard-fit');
      tc.classList.toggle('min', on);
      tcBtn.textContent = on ? '展开' : '折叠';
      tcBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
      tcBtn.title = on ? '展开时间面板' : '折叠为胶囊（只留标题与摘要读数）';
      syncPanelCap();      // 折叠 / 展开都会改变自然高度 → 重算是否还需要整体缩放
      relayout();
    }
    tcBtn.addEventListener('click', function (e) {
      e.stopPropagation();                       // 别触发表头拖拽
      applyTcMin(!tc.classList.contains('min'));
    });
    window.__tcToggle = applyTcMin;              // 供重置 / 探针调用
    /* 折叠状态只影响观感，不进存档（避免老存档 / 探针误判「面板被永久收起」） */
    applyTcMin(false);
  })();
  window.resetCardPos = function () {
    dragCards.forEach(function (c) {
      c.style.left = ''; c.style.top = ''; c.style.right = ''; c.style.bottom = '';
      c.dataset.dragInit = '';
    });
    const gi = $('geoInfo');
    if (gi) {
      gi.style.left = ''; gi.style.top = ''; gi.style.right = ''; gi.style.bottom = '';
      gi.dataset.dragInit = '';
      gi.classList.remove('gi-min');
      const gb = $('btnGiCollapse'); if (gb) gb.textContent = '折叠';
      if (gi.classList.contains('on')) placeGeoInfo();
    }
    $('timeCard').classList.remove('min'); $('btnTcCollapse').textContent = '折叠';
    relayout();
  };

  // 鼠标进入北极窗时，右上角时间面板自动淡出，避免遮挡俯视图
  window.addEventListener('pointermove', function (e) {
    const tc = $('timeCard');
    if (state.mode !== 'triple' || !layout.north) { tc.classList.remove('fade'); return; }
    const r = tc.getBoundingClientRect();
    const overCard = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const n = layout.north;
    const inNorth = e.clientX >= n.x && e.clientX <= n.x + n.w && e.clientY >= n.y && e.clientY <= n.y + n.h;
    tc.classList.toggle('fade', inNorth && !overCard);
  });

  /* 分隔条拖动 */
  (function () {
    const pad = 8;
    let sp = null;
    function start(e, el, kind) {
      sp = { el: el, kind: kind, id: e.pointerId };
      el.classList.add('drag'); document.body.classList.add('resizing');
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    }
    $('spVert').addEventListener('pointerdown', function (e) { start(e, this, 'x'); });
    $('spHorz').addEventListener('pointerdown', function (e) { start(e, this, 'y'); });
    window.addEventListener('pointermove', function (e) {
      if (!sp) return;
      const w = window.innerWidth, h = window.innerHeight;
      if (sp.kind === 'x') {
        const totalW = w - pad * 3;
        state.splitX = clamp((e.clientX - pad * 1.5) / totalW, 0.22, 0.82);
      } else {
        const cbT = Math.min(h - pad, $('controlBar').getBoundingClientRect().top - 10);
        const totalH = cbT - TITLE_H - pad - pad;
        state.splitY = clamp((e.clientY - TITLE_H - pad - pad / 2) / totalH, 0.18, 0.82);
      }
      resize();
    });
    function end() {
      if (!sp) return;
      sp.el.classList.remove('drag'); document.body.classList.remove('resizing');
      sp = null;
    }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // 双击复位
    $('spVert').addEventListener('dblclick', function () { state.splitX = DEFAULTS.splitX; resize(); });
    $('spHorz').addEventListener('dblclick', function () { state.splitY = DEFAULTS.splitY; resize(); });
  })();
  function positionPane(id, r, always) {
    const el = $(id);
    if (!r) { el.classList.remove('on'); return; }
    el.classList.add('on');
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
    el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
  }
  window.addEventListener('resize', resize);

  function renderView(cam, r, hideList, feat) { renderSceneView(scene, cam, r, hideList, feat); }

  /* ===== v23.18（需求④ / ⑥）：窗口级「显示规则」=====
     · 画面一致（consistent）—— 五个窗口的地球表面显示内容**完全统一**：窗内显示什么完全由
       左侧菜单的各项开关决定，与「在哪个窗口」无关（同步显示 / 同步隐藏）；
     · 画面简洁（simple）—— 五个窗口各司其职：都保留「基础共性内容」（地球本体与地表效果、
       地轴与南北极、经纬网与特殊经纬线、监测点、标注点及其文字注释），各自再重点显示本职要素：
         · 北 / 南极俯视 —— 极昼极夜 + 晨昏线；
         · 直射点回归运动 —— 太阳直射点 + 直射点轨迹；
         · 公转示意 —— 轨道位置 / 二分二至 / 日地相对位置 / 太阳直射光线 / 地轴与两极。
       与本职无关的「额外要素」在该窗口内暂时隐藏（不改变全局开关，仅影响这一格画面）。 */
  /* v25.1（需求③）：位掩码新增 zones（温度带） / hour（地方时刻） / tzdiff（时差）
     —— 简洁模式下「北极 / 南极 / 公转演示 / 直射点回归」四个窗口都不显示
     「温度带、区时、地方时刻、时差」，只保留各窗口本职要素；
     地球侧视（main）作为主窗口保留全部内容。
     v25.1（需求⑥）：再新增 fig（小人模型）—— 只在地球侧视 / 公转示意里显示，
     直射点回归运动与南北极俯视两个窗口隐藏（与「标注点」同属地表演示物，不抢主题）。 */
  /* v26.1（需求⑩）：裁剪项扩到「面要素」—— 北极 / 南极 / 公转演示 / 直射点回归 这四个
     窗口在简洁模式下不再显示 温度带、海陆分布、七大洲、东西半球、南北半球、低中高纬度、
     区时、地方时刻、时差、地壳板块、黄道面 / 赤道面（黄赤交角）。
     这些面一铺就糊住整个球面，而上述窗口各有本职要展示的东西（极昼极夜 / 昼夜长短 /
     直射点回归 / 公转位置），留着只会互相干扰。 */
  const SIMPLE_FOCUS = {
    //      极昼极夜 晨昏线 直射点 轨迹  光线  区时  温度带 地方时刻 时差  小人  海陆大洲 东西南北半球 低中高纬 黄道赤道面 直射点纬线与经线
    orbit: { polar: 1, term: 1, sub: 1, trail: 1, rays: 1, tz: 0, zones: 0, hour: 0, tzdiff: 0, fig: 1, geo: 0, hemi: 0, belt: 0, planes: 0, subCircle: 0 },
    main:  { polar: 1, term: 1, sub: 1, trail: 1, rays: 1, tz: 1, zones: 1, hour: 1, tzdiff: 1, fig: 1, geo: 1, hemi: 1, belt: 1, planes: 1, subCircle: 1 },
    sub:   { polar: 0, term: 0, sub: 1, trail: 1, rays: 0, tz: 0, zones: 0, hour: 0, tzdiff: 0, fig: 0, geo: 0, hemi: 0, belt: 0, planes: 0, subCircle: 1 },
    north: { polar: 1, term: 1, sub: 0, trail: 0, rays: 0, tz: 0, zones: 0, hour: 0, tzdiff: 0, fig: 0, geo: 0, hemi: 0, belt: 0, planes: 0, subCircle: 0 },
    south: { polar: 1, term: 1, sub: 0, trail: 0, rays: 0, tz: 0, zones: 0, hour: 0, tzdiff: 0, fig: 0, geo: 0, hemi: 0, belt: 0, planes: 0, subCircle: 0 },
  };
  /* 该窗口的要素裁剪方案：
     · 综合视图「一致」模式 → null（不做任何裁剪）
     · 综合视图「简洁」模式 → 按 SIMPLE_FOCUS[key]
     v27.0（需求三.2）：自转「三窗」不再把南北极窗**固定**在简洁模式，而是与综合视角
     一样提供「一致 / 简洁」两种模式，并**直接受综合视角对应模式（state.comboMode）控制**：
     一致 → 南北极窗显示全部内容（不再裁剪）；简洁 → 按 SIMPLE_FOCUS 裁剪（同 v23.18 行为）。 */
  function paneFeat(key, isOrb) {
    let focus = null;
    if (state.comboMode === 'simple') {
      if (state.view === 'combo') focus = SIMPLE_FOCUS[key] || SIMPLE_FOCUS.main;
      else if (state.view === 'rotate' && state.mode === 'triple' && (key === 'north' || key === 'south')) focus = SIMPLE_FOCUS[key];
    }
    return featOfFocus(focus, key, isOrb);
  }
  /* 方案 → 该窗口的要素裁剪描述。paneFeat（综合 / 三窗）与 mvPaneFeat（悬浮窗）共用，
     保证两处「同一个窗格 → 同一套裁剪」永远一致。 */
  function featOfFocus(focus, key, isOrb) {
    if (!focus) return null;
    return {
      isOrb: !!isOrb, key: key,
      hid: {
        polar: !focus.polar, term: !focus.term, sub: !focus.sub,
        trail: !focus.trail, rays: !focus.rays, tz: !focus.tz,
        zones: !focus.zones, hour: !focus.hour, tzdiff: !focus.tzdiff,
        fig: !focus.fig,
        // v26.1（需求⑩）：面要素裁剪
        geo: !focus.geo, hemi: !focus.hemi, belt: !focus.belt,
        planes: !focus.planes,
        // v27.4：直射点所在纬线与经线
        subCircle: !focus.subCircle,
      },
    };
  }
  // 五带填充面 / 五带名称注释（自转与公转各一套实例）
  const ZONE_MESH_KEYS = ['tropic', 'tempN', 'tempS', 'coldN', 'coldS'];
  function zoneObjs(z, noteGrp) {
    const L = [];
    ZONE_MESH_KEYS.forEach(function (k) { if (z[k]) L.push(z[k]); });
    if (noteGrp) ZONE_MESH_KEYS.forEach(function (k) { if (noteGrp[k]) L.push(noteGrp[k]); });
    return L;
  }
  // 地方时刻：四个主时刻 + 其余二十个整点，各自「点组」与「标注组」一并隐藏
  function hourObjs(rig) {
    const L = [];
    ['main', 'rest'].forEach(function (k) {
      const g = rig && rig.userData[k];
      if (!g) return;
      L.push(g);
      if (g.userData.labels) L.push.apply(L, g.userData.labels);
    });
    return L;
  }
  /* v26.1（需求⑩）：「区域」面要素按类取出要临时隐藏的对象。
     区域面 / 分界线都在 regionX 的 grp 之下，但每类各占一部分，
     所以要按类分别列出（不能整组隐藏，否则关掉「半球」会连「纬度带」一起消失）。 */
  const REGION_NOTE_CATS = { hemi: ['hemiEW', 'hemiNS'], belt: ['latBelt'] };
  function regionObjs(R, L, which) {
    const out = [], g = R && R.g, ln = L && L;
    if (!g || !ln) return out;
    if (which === 'hemi') {
      out.push(g.ewEast, g.ewWest, g.nsNorth, g.nsSouth);
      ln.lines.ew.forEach(function (m) { out.push(m); });
      ln.lines.ns.forEach(function (m) { out.push(m); });
    } else if (which === 'belt') {
      ['low', 'mid', 'high'].forEach(function (k) { (g.belt[k] || []).forEach(function (m) { out.push(m); }); });
      // v27.0（需求二.3）：纬度带轮廓线已整组取消，无需再隐藏对应线对象
    }
    return out.filter(Boolean);
  }
  // 区域文字注释按「注释分类」筛出（geoSite.cat —— 见 buildGeoNotes）
  function regionNotes(arr, cats) {
    return (arr || []).filter(function (sp) {
      const s = sp && sp.userData && sp.userData.geoSite;
      return !!s && cats.indexOf(s.cat) >= 0;
    });
  }
  // 要素 → 该窗口内需要临时隐藏的场景对象（自转 / 公转各一套）
  function featObjects(f) {
    const L = [];
    if (!f) return L;
    const h = f.hid;
    if (f.isOrb) {
      if (h.sub) L.push(subOrbGroup);
      if (h.subCircle) L.push(subCircleOrbGroup);   // v27.4：直射点纬线与经线
      if (h.trail) L.push(trailSetO.grp);
      if (h.rays) L.push(orbRayGroup, orbRayField, volShaftO.grp);
      if (h.tz) { L.push(tzO.grp); L.push.apply(L, tzO.labels); }
      if (h.zones) L.push.apply(L, zoneObjs(zO, surfO));
      if (h.hour) L.push.apply(L, hourObjs(hourRigOrb));
      if (h.tzdiff) L.push.apply(L, tzdiffObjs(tzdiffO));
      if (h.fig) L.push(figGroupO);
      // v26.1（需求⑩）：公转演示窗口 —— 面要素与黄道 / 赤道面一律不显示
      if (h.geo) { L.push(geoMeshO); L.push.apply(L, regionNotes(geoNotesO, ['sea', 'cont'])); }
      if (h.hemi) { L.push.apply(L, regionObjs(regionO, regionLO, 'hemi')); L.push.apply(L, regionNotes(geoNotesO, REGION_NOTE_CATS.hemi)); }
      if (h.belt) { L.push.apply(L, regionObjs(regionO, regionLO, 'belt')); L.push.apply(L, regionNotes(geoNotesO, REGION_NOTE_CATS.belt)); }
      if (h.planes) L.push(planeEcl, planeEqu, eclLabel, equLabel);
    } else {
      if (h.polar) L.push(capDay, capNight, strokeDay, strokeNight, pdLabel, pnLabel);
      if (h.sub) L.push(subGroup);
      if (h.subCircle) L.push(subCircleGroup);      // v27.4：直射点纬线与经线
      if (h.trail) L.push(trailSetR.grp);
      if (h.rays) L.push(raysGroup, volShaftR.grp);
      if (h.tz) { L.push(tzR.grp); L.push.apply(L, tzR.labels); }
      if (h.zones) L.push.apply(L, zoneObjs(zR, surfR));
      if (h.hour) L.push.apply(L, hourObjs(hourRig));
      if (h.tzdiff) L.push.apply(L, tzdiffObjs(tzdiffR));
      if (h.fig) L.push(figGroupR);
      // v26.1（需求⑩）：北极 / 南极 / 直射点回归窗口 —— 面要素一律不显示
      if (h.geo) { L.push(geoMeshR); L.push.apply(L, regionNotes(geoNotesR, ['sea', 'cont'])); }
      if (h.hemi) { L.push.apply(L, regionObjs(regionR, regionLR, 'hemi')); L.push.apply(L, regionNotes(geoNotesR, REGION_NOTE_CATS.hemi)); }
      if (h.belt) { L.push.apply(L, regionObjs(regionR, regionLR, 'belt')); L.push.apply(L, regionNotes(geoNotesR, REGION_NOTE_CATS.belt)); }
      if (h.planes) L.push(planeEcl, planeEqu, eclLabel, equLabel);
    }
    return L;
  }
  function renderSceneView(scn, cam, r, hideList, feat) {
    const h = window.innerHeight;
    const x = r.x, y = h - (r.y + r.h), w = r.w, hh = r.h;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, hh);
    renderer.setViewport(x, y, w, hh);
    const aspect = w / hh;
    if (cam.isOrthographicCamera) {
      syncOrthoFrustum(cam, aspect);
    } else if (aspect !== cam.aspect) {
      cam.aspect = aspect; cam.updateProjectionMatrix();
    }
    const isOrb = (scn === orbitScene);
    // v23.17（需求③）：用「即将渲染的这台相机」重算贴地注释的摆位与背面剔除
    earthNotesPass(cam, isOrb);
    /* v23.18（需求④）：按该窗口的显示规则临时隐藏要素。
       必须放在 earthNotesPass **之后** —— 注释的可见性由它逐帧重算，放在前面会被覆盖。 */
    const restore = [];
    (hideList || []).forEach(function (o) { if (o) { restore.push([o, o.visible]); o.visible = false; } });
    featObjects(feat).forEach(function (o) { if (o) { restore.push([o, o.visible]); o.visible = false; } });
    // 晨昏线是地球材质里的着色器（不是独立对象），单独临时关掉
    const em = isOrb ? earthMatOrb : earthMat;
    let termSave = null;
    if (feat && feat.hid.term) { termSave = em.uniforms.uTermOn.value; em.uniforms.uTermOn.value = 0; }
    renderer.render(scn, cam);
    if (termSave !== null) em.uniforms.uTermOn.value = termSave;
    restore.forEach(function (p) { p[0].visible = p[1]; });
  }
  function syncSubCam(cam) {
    cam.userData.half = SUB_HALF / subZoom;                 // v21.0：取景随 subZoom 等比缩放
    const c = sunDir; // 直射点世界坐标 = sunDir（地球在原点、半径 1）
    cam.position.copy(c).multiplyScalar(2.0);
    cam.up.copy(_axis); cam.lookAt(c.x, c.y, c.z);
  }

  let last = performance.now();
  /* 自适应渲染分辨率：帧时间偏长时逐级降低像素比，回到流畅区间后再逐级升回。
     三窗 / 综合视图要多次渲染同一批场景，在高分屏上很容易掉帧，这个机制能让交互始终保持跟手。 */
  const DPR_STEPS = [1, 0.84, 0.70, 0.58];
  let dprLevel = 0, tuneAcc = 0, tuneN = 0, goodStreak = 0;
  function tuneResolution(dt) {
    tuneAcc += dt; tuneN++;
    if (tuneN < 40) return;                       // 约 0.7 秒采样一次，避免抖动
    const avg = tuneAcc / tuneN; tuneAcc = 0; tuneN = 0;
    const maxLv = DPR_STEPS.length - 1;
    if (avg > 0.0275 && dprLevel < maxLv) {
      dprLevel++; goodStreak = -4;                // 降档后短时间内不再尝试升档
    } else if (avg < 0.0195 && dprLevel > 0) {
      if (++goodStreak >= 3) { dprLevel--; goodStreak = 0; }
    } else if (goodStreak < 0) {
      goodStreak++;
    }
    const pr = Math.max(1, DPR_CAP * DPR_STEPS[dprLevel]);
    if (Math.abs(renderer.getPixelRatio() - pr) > 0.01) renderer.setPixelRatio(pr);
  }
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.12);
    last = now;
    _notePassFrame++;   // ★ 本次性能修复：推进渲染帧号（earthNotesPass 同帧同相机去重用）

    if (state.playing) {
      simMs += dt * 1000 * state.speed;   // 时间持续向前推进，跨年后年份自动延续（2027、2028 …）
      syncYear();                         // 跨年时重建二分二至卡片、时间轴刻度与滑块范围
    }
    updateScene();
    updateOrbit();
    trailTick();      // v23.17：太阳直射点轨迹采样（须在 updateScene / updateOrbit 之后，用当帧太阳方向）
    auroraTick(dt);   // 极光幕帘飘动（真实时间驱动，暂停时依然缓慢流动）
    updateMonitor();   // 监听点纬线圈：昼/夜弧每帧按当前太阳方向与自转相位实时重算
    updateHourMarks(); // 赤道时刻标注：每帧对准直射点经线（12 时贴太阳，0/6/18 依时角排布）
    // v23.17（需求③）：贴地注释的「摆位 + 背面剔除」已移到渲染循环里 —— 每个子窗口渲染前
    //   用「该窗口自己的相机」重算一次，见 earthNotesPass()。这里不再统一剔一遍。
    updateCamera();
    updateOrbCam();
    // v23.17（需求③）：点标注文字也随「当前渲染的相机」在渲染前重算，见 earthNotesPass()

    uiAccum += dt;
    if (uiAccum > 0.08) { uiAccum = 0; updateUI(false); }
    tuneResolution(dt);
    /* v31（需求八）：主视图演示悬浮窗 —— 全球昼夜 / 北极 / 南极 / 公转示意 / 直射点回归
       （Canvas 2D，自带节流；进入太阳视运动时整组隐藏，tick 里立即返回） */
    mvTick(dt);

    const w = window.innerWidth, h = window.innerHeight;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.clear();   // 整块画布只清这一次（autoClear 已关闭）

    if (state.view === 'sun') {
      /* v30：太阳视运动视图 —— 3D 画面完全由 sunview.js 用独立画布 #svCanvas 接管，
         主模块这里只维持时间推进与 UI 刷新，不再向 #gl 渲染（#gl 此时已被 CSS 隐藏）。 */
    } else if (state.view === 'revolve') {
      // 公转视角：自由相机（可拖动/缩放），地轴指向固定
      renderSceneView(orbitScene, orbitCam, orbitViewRect(), []);
    } else if (state.view === 'combo') {
      renderCombo();
    } else {
      // 自转视图：主视角 + （三窗）南北极俯视
      renderView(camera, layout.main, [], null);
      if (state.mode === 'triple' && layout.north && layout.south) {
        /* v23.18（需求⑥）→ v27.0（需求三.2）：三窗里北极 / 南极窗的显示内容跟随
           「综合视角」的一致 / 简洁模式（state.comboMode）—— 一致时全量显示，
           简洁时与综合视图简洁模式下的同名窗口完全一致（都由 SIMPLE_FOCUS 决定）。 */
        renderView(camNorth, layout.north, [], paneFeat('north', false));
        renderView(camSouth, layout.south, [], paneFeat('south', false));
      }
    }
    /* v33：主视图渲染完毕后再出「3D 演示悬浮窗」的缩略图。
       必须放在最后 —— 它复用主画布，把「各窗画布自身遮住」的那块矩形当视口再渲染一遍，
       随后立即 drawImage 搬进窗口画布（同一帧内完成，用户看不到中间态）。 */
    mvRender3DThumbs(dt);
  }

  /* ============ 综合视图布局 / 渲染 / 折叠拖拽 ============ */
  // COMBO_HEAD_H / COMBO_PAD / COMBO_GAP 在上面的 syncMetrics() 中按界面缩放实时更新
  const cmbLayout = {};            // 各子窗口的渲染矩形（不含表头）
  const cmbCell = {};              // DOM 单元格引用
  // 子窗口定义：scene 指向渲染场景，cam 指向相机角色
  const COMBO_DEFS = [
    { key: 'orbit', title: '地球公转示意', scn: 'orbit', cam: 'orbit' },
    { key: 'main', title: '地球侧视', scn: 'scene', cam: 'main' },
    { key: 'sub', title: '直射点回归运动', scn: 'scene', cam: 'sub', zoom: true },
    { key: 'north', title: '北极俯视', scn: 'scene', cam: 'north' },
    { key: 'south', title: '南极俯视', scn: 'scene', cam: 'south' },
  ];
  const cmbFold = { orbit: false, main: false, sub: false, north: false, south: false };
  function buildComboUI() {
    const wrap = $('comboUI');
    if (!wrap || wrap.dataset.built) return;
    wrap.dataset.built = '1';
    COMBO_DEFS.forEach(function (d) {
      const cell = document.createElement('div'); cell.className = 'ccell'; cell.dataset.key = d.key;
      const head = document.createElement('div'); head.className = 'ccell-h';
      head.innerHTML = '<span>' + d.title + '</span><button class="ccell-x" title="折叠/展开">—</button>';
      // v21.0（需求①）：标注「可缩放」的窗口给出操作提示（悬停标题条即见）
      if (d.zoom) head.title = d.title + '：在该窗口内滚动鼠标滚轮（触摸屏用双指捏合）可缩放内容';
      cell.appendChild(head);
      wrap.appendChild(cell);
      cmbCell[d.key] = cell;
      head.querySelector('.ccell-x').addEventListener('click', function (e) {
        e.stopPropagation();
        cmbFold[d.key] = !cmbFold[d.key];
        cell.classList.toggle('folded', cmbFold[d.key]);
        resize();
      });
    });
    // 分隔条：spV 左列|中列，spV2 中列|右列，spL1 左列上下，spR1 右列上下
    ['spL1', 'spR1', 'spV', 'spV2'].forEach(function (id) {
      const d = document.createElement('div'); d.className = 'cdiv'; d.id = id; wrap.appendChild(d);
    });
    bindComboDividers();
  }
  function computeCombo() {
    const w = window.innerWidth, h = window.innerHeight, pad = COMBO_PAD;
    const top = TITLE_H + pad, bottom = h - pad, totalH = Math.max(120, bottom - top);
    // v3.8：综合视图"铺满全窗"——三列自窗口左内边距一直排到右内边距，
    // 显示设置 / 时间浮窗只在上层悬浮（停靠高度已让开标题条，故标题不会被压住）。
    const x0 = pad, x1 = Math.max(pad + 240, w - pad);
    const innerW = x1 - x0;
    // 三列：左列（公转示意 / 直射点回归运动）| 中列（地球侧视，最大）| 右列（南北极俯视）
    let leftW = Math.round(clamp(innerW * state.cmb.splitX, 130, innerW * 0.42));
    let rightW = Math.round(clamp(innerW * state.cmb.splitZ, 130, innerW * 0.42));
    // 空间不足时按比例压缩左右两列，优先保证中列有可用宽度
    if (innerW - leftW - rightW - pad * 2 < 180) {
      const avail = Math.max(150, innerW - 180 - pad * 2);
      const s = avail / Math.max(1, leftW + rightW);
      leftW = Math.max(100, Math.round(leftW * s));
      rightW = Math.max(100, Math.round(rightW * s));
    }
    const cx = x0 + leftW + pad;
    const centerW = Math.max(80, innerW - leftW - rightW - pad * 2);
    const rx = cx + centerW + pad;   // rx + rightW === x1 → 右缘与窗口内边距齐平

    const norm = function (o) {
      let s = 0; Object.keys(o).forEach(function (k) { if (!cmbFold[k]) s += o[k]; });
      Object.keys(o).forEach(function (k) { if (!cmbFold[k]) o[k] = o[k] / (s || 1); });
    };
    const lw = { orbit: state.cmb.splitY, sub: 1 - state.cmb.splitY };
    const rw2 = { north: state.cmb.splitR, south: 1 - state.cmb.splitR };
    norm(lw); norm(rw2);

    const place = function (keys, weights, x, ww) {
      // 可分配的内容高度 = 总高 − 每个未折叠窗口的表头 − 窗口之间的间隙，
      // 最后一个未折叠窗口吸收全部取整余量 → 每列都刚好铺到窗口下内边距（无底部空隙）
      const open = keys.filter(function (k) { return !cmbFold[k]; });
      const bodyTotal = Math.max(80, totalH - open.length * COMBO_HEAD_H - Math.max(0, open.length - 1) * COMBO_GAP);
      const lastKey = open.length ? open[open.length - 1] : null;
      let y = top;
      keys.forEach(function (k) {
        let H;
        if (cmbFold[k]) H = 0;
        else if (k === lastKey) H = Math.max(80, bottom - y - COMBO_HEAD_H);   // 收尾：精确铺到底
        else H = Math.round(weights[k] * bodyTotal);
        cmbLayout[k] = { x: x, y: y, w: ww, h: H, head: COMBO_HEAD_H };
        y += (cmbFold[k] ? COMBO_HEAD_H : H + COMBO_HEAD_H) + COMBO_GAP;
      });
    };
    place(['orbit', 'sub'], lw, x0, leftW);
    place(['main'], { main: 1 }, cx, centerW);
    place(['north', 'south'], rw2, rx, rightW);
    // DOM 单元格定位（含表头，折叠时只剩表头一行）
    COMBO_DEFS.forEach(function (d) {
      const cell = cmbCell[d.key], r = cmbLayout[d.key];
      const hH = cmbFold[d.key] ? COMBO_HEAD_H : r.h + COMBO_HEAD_H;
      cell.style.left = r.x + 'px'; cell.style.top = r.y + 'px';
      cell.style.width = r.w + 'px'; cell.style.height = hH + 'px';
    });
    // 分隔条位置
    positionComboDividers(x0, leftW, rightW, cx, centerW, rx);
  }
  function positionComboDividers(x0, leftW, rightW, cx, centerW, rx) {
    const w = window.innerWidth, h = window.innerHeight, pad = COMBO_PAD;
    const top = TITLE_H + pad, bottom = h - pad;
    const yL = cmbLayout.orbit.y + (cmbFold.orbit ? COMBO_HEAD_H : cmbLayout.orbit.h + COMBO_HEAD_H) + COMBO_GAP / 2;
    const yR = cmbLayout.north.y + (cmbFold.north ? COMBO_HEAD_H : cmbLayout.north.h + COMBO_HEAD_H) + COMBO_GAP / 2;
    const dL1 = $('spL1'), dR1 = $('spR1'), dV = $('spV'), dV2 = $('spV2');
    if (dL1) { dL1.style.display = cmbFold.orbit || cmbFold.sub ? 'none' : 'block'; dL1.style.left = x0 + 'px'; dL1.style.top = yL + 'px'; dL1.style.width = leftW + 'px'; dL1.style.height = ''; }
    if (dR1) { dR1.style.display = cmbFold.north || cmbFold.south ? 'none' : 'block'; dR1.style.left = rx + 'px'; dR1.style.top = yR + 'px'; dR1.style.width = rightW + 'px'; dR1.style.height = ''; }
    if (dV) { dV.style.display = 'block'; dV.style.left = (x0 + leftW + pad / 2) + 'px'; dV.style.top = top + 'px'; dV.style.height = (bottom - top) + 'px'; dV.style.width = ''; }
    if (dV2) { dV2.style.display = 'block'; dV2.style.left = (cx + centerW + pad / 2) + 'px'; dV2.style.top = top + 'px'; dV2.style.height = (bottom - top) + 'px'; dV2.style.width = ''; }
  }
  function bindComboDividers() {
    function start(e, kind) {
      e.preventDefault(); e.stopPropagation();
      const move = function (ev) {
        const w = window.innerWidth, h = window.innerHeight, pad = COMBO_PAD;
        const top = TITLE_H + pad, bottom = h - pad, totalH = bottom - top;
        // 与 computeCombo 一致：铺满全窗（不做浮窗竖带让位）
        const x0 = pad, x1 = Math.max(pad + 240, w - pad);
        const innerW = Math.max(240, x1 - x0);
        if (kind === 'v') {
          state.cmb.splitX = clamp((ev.clientX - x0) / innerW, 0.06, 0.42);
        } else if (kind === 'v2') {
          state.cmb.splitZ = clamp((x1 - ev.clientX) / innerW, 0.06, 0.42);
        } else if (kind === 'l1') {
          const yy = cmbLayout.orbit.y;
          const colH = (cmbLayout.sub.y + cmbLayout.sub.h + COMBO_HEAD_H - yy) || totalH;
          state.cmb.splitY = clamp((ev.clientY - yy) / colH, 0.15, 0.85);
        } else if (kind === 'r1') {
          const yy = cmbLayout.north.y;
          const colH = (cmbLayout.south.y + cmbLayout.south.h + COMBO_HEAD_H - yy) || totalH;
          state.cmb.splitR = clamp((ev.clientY - yy) / colH, 0.15, 0.85);
        }
        resize();
      };
      const up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    $('spL1').addEventListener('pointerdown', function (e) { start(e, 'l1'); });
    $('spR1').addEventListener('pointerdown', function (e) { start(e, 'r1'); });
    $('spV').addEventListener('pointerdown', function (e) { start(e, 'v'); });
    $('spV2').addEventListener('pointerdown', function (e) { start(e, 'v2'); });
  }
  function renderCombo() {
    /* v23.18（需求④）：五个窗口的显示内容由 paneFeat() 决定 ——
       「一致」模式下五格完全相同（hideList 一律为空，窗内内容只由菜单开关决定）；
       「简洁」模式下各格按 SIMPLE_FOCUS 裁剪掉与本职无关的额外要素。 */
    const draw = function (key) {
      const r = cmbLayout[key]; if (!r || r.h <= 0) return;
      const rr = { x: r.x, y: r.y + r.head, w: r.w, h: r.h - r.head };
      const isOrb = (key === 'orbit');
      const feat = paneFeat(key, isOrb);
      if (isOrb) { renderSceneView(orbitScene, orbitCam, rr, [], feat); }
      else if (key === 'sub') { syncSubCam(subCam); renderSceneView(scene, subCam, rr, [], feat); }
      else if (key === 'north') { renderSceneView(scene, camNorth, rr, [], feat); }
      else if (key === 'south') { renderSceneView(scene, camSouth, rr, [], feat); }
      else { renderSceneView(scene, camera, rr, [], feat); }
    };
    draw('orbit'); draw('main'); draw('sub'); draw('north'); draw('south');
  }

  /* ============ 点击查询 / 监听点（经度 / 纬度 / 昼长 · 随时间实时刷新） ============ */
  const raycaster = new THREE.Raycaster();
  const clickMarker = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff2d2d }));
  clickMarker.visible = false; spin.add(clickMarker);
  const clickMarkerOrb = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff2d2d }));
  clickMarkerOrb.visible = false; spinOrb.add(clickMarkerOrb);
  // 给定地理经纬度，求其在某自转 rig（local 系）中的位置：局部经度 = 地理经度 + 自转相位
  // 地理经纬度 → spin 局部坐标。球面 UV 约定（SphereGeometry + 等距圆柱贴图）下，
  // 局部方位角 a 与地理经度关系为 λ = −a，与自转相位无关（地理位置固定于地球纹理）。
  function markerLocal(lat, lon, out) {
    const a = -lon * D, cl = Math.cos(lat * D);
    const v = out || new THREE.Vector3();       // 传入复用向量可避免每帧分配新对象
    return v.set(cl * Math.cos(a), Math.sin(lat * D), cl * Math.sin(a));
  }
  /* ============ 点标注（添加点模式） ============ */
  // 点是"地表固定点"：挂在 spin / spinOrb（随地球自转），自转与公转视图自动一致。
  const ptsGroup = new THREE.Group(); spin.add(ptsGroup);
  const ptsGroupOrb = new THREE.Group(); spinOrb.add(ptsGroupOrb);
  let _ptsSig = null, _ptSprites = [];
  function ptLabel(n) { return String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : ''); }
  function addPointAt(lat, lon) {
    const p = state.points;
    if (p.snap && state.graticule) {           // 吸附：按当前经纬网间隔，±3° 内吸到线上
      const ms = gratSnapStep('mer'), ps = gratSnapStep('par');   // v33：多选间隔取最细的一套做吸附
      const q = function (v, step) { return Math.round(v / step) * step; };
      if (Math.abs(lat - q(lat, ps)) <= 3) lat = clamp(q(lat, ps), -90, 90);
      if (Math.abs(lon - q(lon, ms)) <= 3) lon = wrap180(q(lon, ms));
    }
    p.items.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), label: ptLabel(p.items.length) });
    syncPoints(); renderPtList();
  }
  function removePoint(i) { state.points.items.splice(i, 1); syncPoints(); renderPtList(); }
  function syncPoints() {
    const p = state.points;
    const sig = JSON.stringify([p.items, state.style.pt.ptLabel.size, state.style.pt.ptLabel.color, state.style.pt.ptLabel.op, p.show]);
    if (sig === _ptsSig) return;
    _ptsSig = sig;
    // 清掉旧点（并从全局文字精灵注册表移除，避免泄漏）
    _ptSprites.forEach(function (sp) {
      const k = textSprites.indexOf(sp); if (k >= 0) textSprites.splice(k, 1);
      if (sp.material.map) sp.material.map.dispose();
      sp.material.dispose();
    });
    _ptSprites = [];
    while (ptsGroup.children.length) ptsGroup.remove(ptsGroup.children[0]);
    while (ptsGroupOrb.children.length) ptsGroupOrb.remove(ptsGroupOrb.children[0]);
    /* ★ v53（需求一·2）：二级菜单「标记点」关闭时，**整组隐藏**（圆点 + 文字标签）。
       旧写法只把 A/B/C 文字包在 if (p.show) 里、圆点 mesh 无条件加入场景，
       于是关掉开关后地上仍留着一堆彩色圆点（用户截图里的红/黄/橙点）。 */
    ptsGroup.visible = ptsGroupOrb.visible = !!p.show;
    p.items.forEach(function (it) {
      [ptsGroup, ptsGroupOrb].forEach(function (grp) {
        const mk = new THREE.Mesh(new THREE.SphereGeometry(0.020, 14, 10),
          new THREE.MeshBasicMaterial({ color: state.style.pt.ptLabel.color, transparent: true, opacity: state.style.pt.ptLabel.op }));
        mk.position.copy(markerLocal(it.lat, it.lon, new THREE.Vector3())).normalize().multiplyScalar(1.004);
        mk.scale.setScalar(state.style.pt.ptLabel.size);
        mk.renderOrder = 30;   // v23.12：点要素统一 30（高于线 20 / 面 2~12）
        grp.add(mk);
        if (p.show) {
          // 注释文字：与其他文字注释一样注册进 textSprites，
          // 大小 / 颜色 / 透明度由「全局文字注释样式」统一控制（不再独立设置，
          // 也修复了此前未按 baseW/baseH 设置缩放导致 4:1 贴图被拉成方形、字体严重变形的问题）
          /* v23.11：渲染层级 / 锚点 / 避让全面修正（详见 updatePointLabels 上方的说明）。
             此前：位置抬到 1.08 R，但标签中心仍与圆点重合，而圆点不透明且更靠近相机 ——
             标签正中那块被圆点挡掉，就是用户看到的「缺口」（探针实测两者 ndc 差 < 0.002）。 */
          const sp = makeTextSprite(it.label, 0.24, true, 'pts', 'pts.' + it.label);
          const anchorPos = mk.position.clone();               // 要素位置（球面 1.004 R，即圆点处）
          sp.userData.ptsLabel = true;
          sp.userData.ptsView = (grp === ptsGroup) ? 'spin' : 'orb';
          sp.userData.ptsAnchor = anchorPos.clone();           // 每帧布局以它为基准（避让在其上叠加）
          sp.material.depthTest = false;                       // 不被任何地理要素遮挡（背面另行剔除）
          sp.material.depthWrite = false;
          sp.renderOrder = PTS_LABEL_RO;                       // 绘制层级：高于全部要素与其它注释
          sp.center.set(0.5, -PTS_LABEL_LIFT);                 // 锚点在底边中点下方 → 标签在要素顶部之上、水平居中
          sp.position.copy(anchorPos);
          // applyAll 中精灵样式循环在本函数之前已执行，新精灵需立即套用一次「点标注注释」分类样式
          const pst = noteStyleFor('pts');
          /* ★ v52（E5）：此前这里漏了 `unifyBaseK(sp)` —— 与 applyAll 的通用循环不一致，
             导致「删除某个标记点 → syncPoints 全量重建 → 剩余标签按未归一的基准缩放」，
             字号凭空缩小约 2.6 倍（看起来像「被重置成默认值」）；门控也应走 spriteNoteGate，
             与通用循环保持同一口径。 */
          sp.userData.noteGate = pst.show && spriteNoteGate(sp);
          spriteDPI(sp, noteDPI(pst.size));                    // 立即按字号确定贴图分辨率（避免先糊后清）
          // v18.0：公转视图的点标注同样按相机后退倍数补偿（自转视图不补偿）
          const _psm = pst.size * (isOrbitSprite(sp) ? orbAnnMul() : 1);
          const _puk = unifyBaseK(sp);
          setNoteScale(sp, sp.userData.baseW * _puk * _psm, sp.userData.baseH * _puk * _psm);
          sp.material.color.set(pst.color);
          sp.userData.baseOp = pst.op;
          sp.material.opacity = pst.op;
          _ptSprites.push(sp); grp.add(sp);
        }
      });
    });
    renderPtList();
  }
  function renderPtList() {
    // v25.1（需求⑧）：标记点增删后，「从标记点选取」的两个下拉要跟着刷新
    if (state.gcd && $('selGcdA')) renderGcdPanel();
    const box = document.getElementById('ptList'); if (!box) return;
    const p = state.points;
    box.innerHTML = p.items.length ? '' : '<div class="pt-empty">暂无标注点 — 开启模式后点击地球表面添加</div>';
    p.items.forEach(function (it, i) {
      const row = document.createElement('div'); row.className = 'pt-row';
      const dot = document.createElement('span'); dot.className = 'pt-dot'; dot.style.background = state.style.pt.ptLabel.color;
      const txt = document.createElement('span'); txt.className = 'pt-txt';
      txt.textContent = it.label + ' · ' + fmtLat(it.lat) + ' ' + fmtLon(it.lon);
      const del = document.createElement('button'); del.className = 'btn xs pt-del'; del.textContent = '删除'; del.dataset.i = i;
      row.appendChild(dot); row.appendChild(txt); row.appendChild(del);
      box.appendChild(row);
    });
  }
  /* ================= v25.1（需求⑥）：小人模型演示 =================
     做三件事：
       ① 小人 —— 一个 6 个基本体拼出的「人形」（腿 / 躯干 / 双臂 / 脖子 / 头），
          身高 = 1、脚在原点、+Y 朝上；放置时按球面法线立起来（脚踩地表、头顶朝外），
          并挂到 spin / spinOrb 上 —— 于是随地球自转 / 公转一起运动（与标注点同一套机制）。
       ② 影子 —— 每帧按太阳方向**实际解算**：影子方向 = 太阳方向的球面水平分量反向；
          长度由「过小人的平行光线与球面的交点」解出（太阳越低影子越长），
          太阳落到地平线以下（夜晚）时不画影子，日出日落附近影子被晨昏线截断。
          影子画成一条贴球的软边条带（本影 + 半影），不是贴图、不是固定形状。
       ③ 拖放 —— 菜单面板里的「小人」卡片可直接按住拖到地球表面，落点即经纬度
          （可选吸附到经纬网），松开即放置。 */
  const FIG_TOP = 0.958;                 // 小人的实际「头顶」高度（单位身高）
  const FIG_W = 0.150;                   // 小人身宽（单位身高）——影子宽度按它换算
  const FIG_SURF = 1.009;                // 影子贴地半径：高于海陆(1.0018) / 时区面(1.006)，低于温度带面(1.012)
  const FIG_SEG = 28;                    // 影子条带沿长度方向的分段数
  const FIG_SHADOW_RO = 18;              // 绘制层级：高于全部面要素(2~13)与海陆，低于线(20) / 点(30)
  const FIG_BODY_RO = 28;                // 小人本体：高于线(20)与影子，低于标注点(30)
  const FIG_VS = `
    varying vec3 vN;
    void main(){
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  // 小人本体：按太阳方向做朗伯明暗 —— 向阳面亮、背阳面暗，与地球昼夜同一套光照
  const FIG_FS = `
    uniform vec3 uColor, uSunDir; uniform float uOpacity;
    varying vec3 vN;
    ${SRGB_FN}
    void main(){
      float d = max(0.0, dot(normalize(vN), normalize(uSunDir)));
      gl_FragColor = vec4(toSRGB(uColor * (0.30 + 0.70 * d)), uOpacity);
    }
  `;
  // 影子条带：vT = 沿影子方向（0 脚底 → 1 影尖），vS = 横向（−1..1）
  //   本影（中部）不透明，向两侧与影尖渐隐；uSoft 越大边缘越柔。
  const FIG_SHADOW_VS = `
    attribute float aT; attribute float aS;
    varying float vT, vS;
    void main(){
      vT = aT; vS = aS;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const FIG_SHADOW_FS = `
    uniform vec3 uColor; uniform float uOpacity, uSoft;
    varying float vT, vS;
    ${SRGB_FN}
    void main(){
      float soft = clamp(uSoft, 0.0, 1.0);
      float wA = mix(0.96, 0.42, soft);          // 横向开始衰减的位置
      float wB = mix(1.00, 0.92, soft);
      float tA = mix(0.999, 0.42, soft);         // 影尖开始衰减的位置
      float tB = 1.00;
      float a = uOpacity
              * (1.0 - smoothstep(wA, wB, abs(vS)))
              * (1.0 - smoothstep(tA, tB, vT));
      if (a < 0.004) discard;
      gl_FragColor = vec4(toSRGB(uColor), a);
    }
  `;
  function makeFigureMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(state.style.pt.figure.color) },
                  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
                  uOpacity: { value: 1 } },
      vertexShader: FIG_VS, fragmentShader: FIG_FS,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
  }
  /* 一个人形（本地：脚在原点、总高 ≈ FIG_TOP、+Y 朝上、面朝 +Z） */
  const FIG_GEOS = {
    leg: new THREE.CylinderGeometry(0.036, 0.046, 0.44, 10),
    torso: new THREE.CylinderGeometry(0.088, 0.118, 0.40, 14),
    arm: new THREE.CylinderGeometry(0.029, 0.031, 0.36, 8),
    neck: new THREE.CylinderGeometry(0.034, 0.040, 0.07, 8),
    head: new THREE.SphereGeometry(0.098, 16, 12),
  };
  function makeFigureNode(mat) {
    const g = new THREE.Group();
    const add = function (geo, x, y, z, rz) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); if (rz) m.rotation.z = rz;
      m.renderOrder = FIG_BODY_RO; g.add(m); return m;
    };
    add(FIG_GEOS.leg, -0.058, 0.22, 0); add(FIG_GEOS.leg, 0.058, 0.22, 0);
    add(FIG_GEOS.torso, 0, 0.64, 0);
    add(FIG_GEOS.arm, -0.126, 0.63, 0, 0.15); add(FIG_GEOS.arm, 0.126, 0.63, 0, -0.15);
    add(FIG_GEOS.neck, 0, 0.80, 0);
    add(FIG_GEOS.head, 0, 0.86, 0);
    return g;
  }
  /* 一条影子条带：FIG_SEG 段 × 2 顶点，逐帧只改 position（不重建几何，避免每帧分配） */
  function makeShadowRibbon() {
    const n = (FIG_SEG + 1) * 2;
    const pos = new Float32Array(n * 3), aT = new Float32Array(n), aS = new Float32Array(n);
    for (let i = 0; i <= FIG_SEG; i++) {
      const t = i / FIG_SEG, a = i * 2;
      aT[a] = aT[a + 1] = t; aS[a] = -1; aS[a + 1] = 1;
    }
    const idx = [];
    for (let i = 0; i < FIG_SEG; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(state.style.ln.figShadow.color) },
                  uOpacity: { value: 0.6 }, uSoft: { value: 0.75 } },
      vertexShader: FIG_SHADOW_VS, fragmentShader: FIG_SHADOW_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = FIG_SHADOW_RO;
    return m;
  }
  /* ============ v27.3（需求）：小人脚下的「东南西北」方位箭头 ============
     在小人脚下铺一圈「罗盘玫瑰」：四个箭头自脚底向外指，方向严格取自**当地地理方位**
     （正东 / 正南 / 正西 / 正北），随小人落点变化，与经纬网一一对应 ——
     不是屏幕方向，也不是画面上的固定贴图。

     为什么这样建几何：
       · 小人的摆放基（holder）此时已按「脚踩地表、局部 +Y = 球面法线、局部 +Z = 正北」
         建立（见 syncFigure），于是本地向量 (0,0,1)=正北、(0,0,-1)=正南、
         (−1,0,0)=正东、(1,0,0)=正西（基向量 x = up × 北向 = 正西）；
       · 箭头是**贴着球面**的一条带子：顶点逐一取「绕球心转 α 角」后的球面点
         （半径恒为 FIG_SURF+off），横向加宽方向取与球面法线正交的水平向 ——
         于是无论小人放在哪里、镜头怎么转，箭头都紧贴地表，不会像切平面图形那样悬空；
       · 四个箭头依次抬高 off（0.0004 递增），避免共面相互穿插；
       · 箭头文字是精灵（始终朝向相机），落在各自箭尖外侧，与箭头一一对应。 */
  const FIG_DIR_RO = 26;                 // 方位箭头：高于影子(18)与全部面要素，低于小人本体(28)
  const FIG_DIR_TEXT_RO = 29;            // 方位文字：高于小人本体(28)，低于标注点(30)
  const FIG_DIR_SHAFT_SEG = 16;          // 箭杆沿弧长的分段数
  const FIG_DIR_HEAD_SEG = 6;            // 箭头（三角）沿弧长的分段数
  const FIG_DIR_HEAD_SPREAD = 2.6;       // 箭头三角底部半宽 ÷ 箭杆半宽
  // 本地水平方向：(dx, 0, dz)；off = 该箭头相对地表的抬高（越大越靠上，用于避免共面）
  const FIG_DIR_DEF = [
    { k: 'N', dx: 0, dz: 1, off: 0.0004 },     // 正北 = 本地 +Z
    { k: 'E', dx: -1, dz: 0, off: 0.0008 },    // 正东 = 本地 −X
    { k: 'S', dx: 0, dz: -1, off: 0.0012 },    // 正南 = 本地 −Z
    { k: 'W', dx: 1, dz: 0, off: 0.0016 },     // 正西 = 本地 +X
  ];
  /* 一支方位箭头：沿大圆铺开的带状几何（顶点全部落在半径 S = FIG_SURF + off 的球面上）。
     宽度剖面：箭杆等宽 → 末端「肩膀」处突然张开成三角 → 收到尖端。
     （「肩膀」用两个同 t 的站点做出垂直断面，箭尖才不至于被拉成水滴形。） */
  function makeFigDirArrowGeom(dx, dz, len, halfW, headRatio, off) {
    const S = FIG_SURF + off, aTot = Math.max(1e-4, len / S);
    const tHead = clamp(1 - (headRatio || 0.32), 0.15, 0.95);
    const wHead = halfW * FIG_DIR_HEAD_SPREAD;
    const st = [];
    for (let i = 0; i <= FIG_DIR_SHAFT_SEG; i++) st.push([tHead * i / FIG_DIR_SHAFT_SEG, halfW]);
    st.push([tHead, wHead]);
    for (let i = 0; i <= FIG_DIR_HEAD_SEG; i++) {
      const s = i / FIG_DIR_HEAD_SEG;
      st.push([tHead + (1 - tHead) * s, wHead * (1 - s)]);
    }
    const n = st.length;
    const pos = new Float32Array(n * 2 * 3);
    const lx = -dz, lz = dx;               // 水平面内与箭头方向垂直（与球面法线恒正交）
    st.forEach(function (s, i) {
      const a = aTot * s[0], sa = Math.sin(a), ca = Math.cos(a);
      const px = S * sa * dx, py = off + S * (ca - 1), pz = S * sa * dz;
      const w = s[1], a2 = i * 2;
      pos[a2 * 3] = px + lx * w; pos[a2 * 3 + 1] = py; pos[a2 * 3 + 2] = pz + lz * w;
      pos[a2 * 3 + 3] = px - lx * w; pos[a2 * 3 + 4] = py; pos[a2 * 3 + 5] = pz - lz * w;
    });
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIG_SURF + off + len);
    return g;
  }
  /* 方位字体（与全项目同一套 NOTE_FONTS 选项；此处不依赖 note.cats，故单独解析） */
  function figDirFontCss(id) {
    for (let i = 0; i < NOTE_FONTS.length; i++) if (NOTE_FONTS[i][0] === id) return NOTE_FONTS[i][2];
    return CANVAS_FALLBACK_FONT;
  }
  /* 方位文字精灵：单个大写字母。画布 2:1（「W」这类宽字母也放得下），
     并登记「墨迹高 ÷ 画布高」= inkRatio —— 于是「字号」（字母墨迹高度）↔ 精灵世界尺寸
     之间的换算精确可逆，任何字体 / 字重下字母都被画成同一视觉高度。 */
  function makeFigDirSprite(letter, T) {
    const CW = 512, CH = 256, FPX = 176;
    const c = document.createElement('canvas'); c.width = CW; c.height = CH;
    const g = c.getContext('2d');
    g.font = (T.weight || '700') + ' ' + FPX + 'px ' + figDirFontCss(T.font);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#FFFFFF';                       // 贴图白字，颜色一律由 material.color 染色（与全项目一致）
    const m = g.measureText(letter);
    const asc = (m && m.actualBoundingBoxAscent != null) ? m.actualBoundingBoxAscent : FPX * 0.72;
    const desc = (m && m.actualBoundingBoxDescent != null) ? m.actualBoundingBoxDescent : 0;
    g.fillText(letter, CW / 2, CH / 2);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace; else tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: true,
      color: new THREE.Color(T.color), opacity: T.op,
    }));
    sp.renderOrder = FIG_DIR_TEXT_RO;
    sp.userData.figDirLetter = letter;
    sp.userData.inkRatio = Math.max(1, asc + desc) / CH;         // 墨迹高 ÷ 画布高
    return sp;
  }
  const figGroupR = new THREE.Group(); spin.add(figGroupR);
  const figGroupO = new THREE.Group(); spinOrb.add(figGroupO);
  // 求解结果缓存（供探针 / 界面读数：影子方位角与长度）
  const figInfo = { R: [], O: [] };
  /* _figNodes：每个「小人」一条记录
       reg     'R'（自转场景）/ 'O'（公转场景）
       holder  小人本体（挂在 figGroup* 下，位置 = 球面点、局部 +Y = 球面法线）
       shadow  影子条带网格 —— **直接挂在 figGroup\*（原点层）**，顶点用球面（spin）坐标表示，
               这样它的「脚底」就是球面上的真实落点，不需要再做一层父子坐标换算
       up      该点在球面系中的单位法线
  */
  let _figSig = null, _figNodes = [];
  function syncFigure() {
    const F = state.figure, FD = state.style.pt.figDir;
    // v26.1（需求④）：签名里带上每个小人自己的颜色 —— 改了某一个人的颜色要能触发重建
    // v27.3（需求）：方位箭头的**几何与文字贴图**相关项也入签名（长度 / 杆宽 / 箭头占比 /
    //   字号 / 字体 / 字重）—— 颜色与透明度只改材质，不必重建（见 applyFigure）。
    const sig = JSON.stringify([F.items, F.on, state.style.pt.figure.size, state.style.pt.figure.color,
                                state.style.pt.figure.op, state.style.ln.figShadow.color,
                                state.style.ln.figShadow.op, state.style.ln.figShadow.w,
                                state.style.ln.figShadow.soft, state.style.ln.figShadow.on,
                                FD.len, FD.w, FD.head, FD.text.size, FD.text.font, FD.text.weight]);
    if (sig === _figSig) return;
    _figSig = sig;
    _figNodes.forEach(function (o) {
      [figGroupR, figGroupO].forEach(function (g) {
        if (o.holder.parent === g) g.remove(o.holder);
        if (o.shadow.parent === g) g.remove(o.shadow);
        if (o.dir && o.dir.grp.parent === g) g.remove(o.dir.grp);
      });
      o.bodyMat.dispose(); o.shadowMat.dispose();
      if (o.dir) {                      // v27.3：方位箭头 / 文字的几何与贴图一并释放，避免反复调样式时泄漏
        o.dir.arrows.forEach(function (m) { m.geometry.dispose(); m.material.dispose(); });
        o.dir.labels.forEach(function (sp) {
          if (sp.material.map) sp.material.map.dispose();
          sp.material.dispose();
        });
      }
    });
    _figNodes = [];
    const size = state.style.pt.figure.size;
    /* v27.3：方位箭头 / 文字的世界尺寸 —— 全部以「小人身高」为基准，
       于是调身高时箭头与文字等比跟随，观感比例不变（1 格 = 0.01 / 0.01 / 0.001）。 */
    const dirLenW = clamp(+FD.len || 0, 0.05, 8) * FIG_TOP * size;        // 箭头长度（世界单位）
    const dirHalfW = clamp(+FD.w || 0, 0.005, 1) * FIG_TOP * size * 0.5;  // 箭杆半宽
    const dirTxtH = clamp(+(FD.text && FD.text.size) || 0, 0.02, 8) * FIG_TOP * size;   // 字母墨迹高
    F.items.forEach(function (it) {
      [['R', figGroupR], ['O', figGroupO]].forEach(function (pair) {
        const reg = pair[0], grp = pair[1];
        const bodyMat = makeFigureMat();
        const holder = new THREE.Group();
        holder.add(makeFigureNode(bodyMat));
        const shadow = makeShadowRibbon();
        // 立到地表：脚在球面、局部 +Y 沿球面法线、面朝正北
        const up = markerLocal(it.lat, it.lon, new THREE.Vector3());
        const north = YAX.clone();
        const fwd = north.clone().addScaledVector(up, -north.dot(up));
        if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0).addScaledVector(up, -up.x);   // 极点：改用 +X 定朝向
        fwd.normalize();
        // 基必须右手系（det = +1），否则 setFromRotationMatrix 会解出错误旋转：
        // 列 c0 = c1×c2 = up×fwd（= 西向），c1 = up（法线），c2 = fwd（正北）
        const xAxis = new THREE.Vector3().crossVectors(up, fwd).normalize();
        holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, up, fwd));
        holder.position.copy(up).multiplyScalar(FIG_SURF);   // 脚底贴在表层半径上（与影子同基准）
        // ★ 本体必须以 size 为比例缩放：几何是以「单位身高 = 1」建的，
        //   不缩放就会变成与地球同高的巨人（影子却按 size*FIG_TOP 算，两者对不上）
        holder.scale.setScalar(size);
        grp.add(holder); grp.add(shadow);
        /* v27.3：方位箭头组 —— 位置 / 朝向与小人本体一致，但**不继承 size 缩放**
           （几何直接以球面单位构建，长度由「身高 × 倍率」换算成世界单位）。
           本地坐标约定：+Y = 球面法线、+Z = 正北、+X = 正西（与 holder 同一套基）。 */
        const dirGrp = new THREE.Group();
        dirGrp.userData.figDir = true;         // 供探针 / 外部区分（子级带 geometry，但不是影子）
        dirGrp.position.copy(holder.position);
        dirGrp.quaternion.copy(holder.quaternion);
        grp.add(dirGrp);
        const dirArrows = [], dirLabels = [];
        FIG_DIR_DEF.forEach(function (dd) {
          const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(FD.color), transparent: true,
                                                    opacity: FD.op, side: THREE.DoubleSide, depthWrite: false });
          const mesh = new THREE.Mesh(makeFigDirArrowGeom(dd.dx, dd.dz, dirLenW, dirHalfW, FD.head, dd.off), mat);
          mesh.renderOrder = FIG_DIR_RO;
          mesh.userData.figDirAxis = dd.k;
          dirGrp.add(mesh); dirArrows.push(mesh);
          // 文字：落在箭尖外侧一点点，并略微抬离地表，避免与箭头 / 球面互相穿插
          const S = FIG_SURF + dd.off, aLab = (dirLenW + dirTxtH * 0.62) / S;
          const sp = makeFigDirSprite(dd.k, FD.text);
          sp.position.set(S * Math.sin(aLab) * dd.dx,
                          dd.off + S * (Math.cos(aLab) - 1) + dirTxtH * 0.22,
                          S * Math.sin(aLab) * dd.dz);
          const sc = dirTxtH / (sp.userData.inkRatio || 0.7);   // 令字母墨迹高恰好 = dirTxtH
          sp.scale.set(sc * 2, sc, 1);                          // 画布 2:1（宽 : 高）
          sp.userData.figDirAxis = dd.k;
          dirGrp.add(sp); dirLabels.push(sp);
        });
        _figNodes.push({ reg: reg, holder: holder, shadow: shadow, up: up.clone(),
                         lat: it.lat, lon: it.lon, item: it,
                         bodyMat: bodyMat, shadowMat: shadow.material,
                         dir: { grp: dirGrp, arrows: dirArrows, labels: dirLabels } });
      });
    });
    applyFigure();
    renderFigList();
  }
  // 样式 / 显隐（由 applyAll 调用）
  function applyFigure() {
    const F = state.figure, P = state.style.pt.figure, S = state.style.ln.figShadow;
    const FD = state.style.pt.figDir, D = F.dir || {};
    const on = !!F.on, dirOn = on && !!D.on, dirTxt = dirOn && !!D.text;
    figGroupR.visible = on; figGroupO.visible = on;
    _figNodes.forEach(function (o) {
      o.holder.visible = on;
      // v26.1（需求④）：每个小人用自己的颜色；没单独设过的跟随「小人样式 › 颜色」
      o.bodyMat.uniforms.uColor.value.set(figColorOf(o.item));
      o.bodyMat.uniforms.uOpacity.value = P.op;
      o.shadowMat.uniforms.uColor.value.set(S.color);
      o.shadowMat.uniforms.uOpacity.value = S.op;
      o.shadowMat.uniforms.uSoft.value = S.soft;
      o.shadow.visible = on && !!S.on;
      // v27.3：方位箭头 / 文字 —— 箭头受「显示方位箭头」控制，文字另有自己的开关
      if (o.dir) {
        o.dir.grp.visible = dirOn;
        o.dir.arrows.forEach(function (m) {
          m.material.color.set(FD.color); m.material.opacity = FD.op;
        });
        o.dir.labels.forEach(function (sp) {
          sp.visible = dirTxt;
          sp.material.color.set(FD.text.color); sp.material.opacity = FD.text.op;
        });
      }
    });
  }
  /* 每帧解算影子：sunW = 该场景的**世界**太阳方向；rig = spin / spinOrb（本体系基准）；tag = 'R' | 'O' */
  const _fsQ4 = new THREE.Quaternion(), _fsSun = new THREE.Vector3(), _fsUp = new THREE.Vector3();
  const _fsW = new THREE.Vector3(), _fsX = new THREE.Vector3(), _fsTan = new THREE.Vector3();
  const _fsLat = new THREE.Vector3(), _fsR = new THREE.Vector3();
  function updateFigureShadows(sunW, rig, tag) {
    if (!state.figure.on || !state.figure.items.length) return;
    // 世界太阳方向 → 本体系方向：用「世界四元数求逆」换算（自动处理自转 / 倾斜 / 统一缩放）
    rig.updateWorldMatrix(true, false);
    rig.getWorldQuaternion(_fsQ4);
    _fsSun.copy(sunW).applyQuaternion(_fsQ4.invert()).normalize();
    const size = state.style.pt.figure.size;
    const out = figInfo[tag]; if (out) out.length = 0;
    _figNodes.forEach(function (o) {
      if (o.reg !== tag) return;
      const sh = o.shadow, pos = sh.geometry.attributes.position;
      const up = _fsUp.copy(o.up).normalize();
      const sunUp = clamp(_fsSun.dot(up), -1, 1);      // = sin(太阳高度角)
      if (sunUp <= 0.0008) {                            // 太阳在地平线以下（当地夜晚）→ 不画影子
        sh.visible = false;
        if (out) out.push({ lat: o.lat, lon: o.lon, elev: +(Math.asin(sunUp) * R).toFixed(2), ang: null, len: null });
        return;
      }
      sh.visible = !!state.style.ln.figShadow.on;
      // 太阳方向在「切平面」上的水平分量；影子沿其反方向（背离太阳）延伸
      _fsW.copy(_fsSun).addScaledVector(up, -sunUp);
      const hw = _fsW.length();
      if (hw < 1e-6) { sh.visible = false; return; }    // 太阳正顶头 → 影子缩成一个点
      _fsW.multiplyScalar(1 / hw);
      const h = size * FIG_TOP;
      /* 影尖 = 过「头顶」的平行光线与单位球面的交点：|up·(1+h) − sun·t| = 1
         解出 cos(s − e) = (1+h)·cos e（s = 影长弧、e = 太阳高度角），取受照侧的根
             s = e − acos((1+h)·cos e)
         仅当 (1+h)·cos e ≤ 1（即 e ≥ acos(1/(1+h))）时才有解；
         无解时说明光线整个掠过球面，影子一路铺到晨昏线为止 ——
         ★ 晨昏线距脚底正好是 **e**（不是 90°−e）：两支在临界处都等于 e，因此影长连续、不会跳变。
         旧实现误用 90°−e，会把低太阳高度角的影长放大约 8 倍。 */
      const O = 1 + h, b = O * sunUp;
      const disc = b * b - (O * O - 1);
      let ang;
      if (disc >= 0) {
        const s = b - Math.sqrt(disc);                  // 取靠近的那一个交点
        _fsX.copy(up).multiplyScalar(O).addScaledVector(_fsSun, -s).normalize();
        ang = Math.acos(clamp(_fsX.dot(up), -1, 1));
      } else {
        ang = Math.asin(clamp(sunUp, -1, 1)) * 0.995;   // 铺到晨昏线（略收一点，别压到明暗界上）
      }
      if (!(ang > 1e-4)) { sh.visible = false; return; }
      const halfW = FIG_W * size * state.style.ln.figShadow.w * 0.5;
      const rad = FIG_SURF;
      for (let i = 0; i <= FIG_SEG; i++) {
        const a = ang * i / FIG_SEG, ca = Math.cos(a), sa = Math.sin(a);
        _fsR.copy(up).multiplyScalar(ca).addScaledVector(_fsW, -sa).normalize();   // 沿大圆的半径方向
        _fsTan.copy(up).multiplyScalar(-sa).addScaledVector(_fsW, -ca).normalize(); // 行进切向
        _fsLat.crossVectors(_fsR, _fsTan).normalize();                              // 横向
        const a2 = i * 2;
        pos.setXYZ(a2, _fsR.x * rad + _fsLat.x * halfW, _fsR.y * rad + _fsLat.y * halfW, _fsR.z * rad + _fsLat.z * halfW);
        pos.setXYZ(a2 + 1, _fsR.x * rad - _fsLat.x * halfW, _fsR.y * rad - _fsLat.y * halfW, _fsR.z * rad - _fsLat.z * halfW);
      }
      pos.needsUpdate = true;
      if (out) {
        out.push({ lat: o.lat, lon: o.lon, elev: +(Math.asin(sunUp) * R).toFixed(2),
                   ang: +(ang * R).toFixed(2), len: +(ang * size * FIG_TOP).toFixed(4) });
      }
    });
  }
  function renderFigList() {
    const box = document.getElementById('figList'); if (!box) return;
    const F = state.figure;
    box.innerHTML = F.items.length ? ''
      : '<div class="pt-empty">暂无小人 — 把上面的小人拖到地球表面放置</div>';
    F.items.forEach(function (it, i) {
      const row = document.createElement('div'); row.className = 'pt-row';
      /* v26.1（需求④）：逐人改色 —— 列表里每人一个取色框，改完立即重画，
         并写进 state.figure.items[i].color（随存档一起保存）。 */
      const pick = document.createElement('input');
      pick.type = 'color'; pick.className = 'pt-clr'; pick.value = figColorOf(it);
      pick.title = '小人' + (i + 1) + ' 的颜色';
      pick.dataset.figclr = i;
      const txt = document.createElement('span'); txt.className = 'pt-txt';
      txt.textContent = '小人' + (i + 1) + ' · ' + fmtLat(it.lat) + ' ' + fmtLon(it.lon);
      const del = document.createElement('button'); del.className = 'btn xs pt-del';
      del.textContent = '删除'; del.dataset.fig = i;
      row.appendChild(pick); row.appendChild(txt); row.appendChild(del);
      box.appendChild(row);
    });
  }
  /* v26.1（需求④）：列表里改某个小人的颜色（事件委托，列表每次重绘都不会重复挂载） */
  document.addEventListener('input', function (e) {
    const t = e.target; if (!t || !t.dataset || t.dataset.figclr == null) return;
    const i = +t.dataset.figclr, it = state.figure.items[i];
    if (!it) return;
    it.color = t.value;
    _figSig = null; syncFigure(); applyAll(); persist();
  });
  /* v26.1（需求④）：每个小人一条记录，颜色**逐人可单独设置** —— 列表里逐个改色会写入
     state.figure.items[i].color（随存档一起保存）。未单独设过色的（含新放置的）跟随全局
     「小人样式 › 颜色」。★ v52（E8）：新放置的小人默认不写 color，故全局改色对新旧小人
     一律立即生效；此前「新放置按调色板轮着取色」的 FIG_COLORS / nextFigColor 已随根因
     一并移除（它无条件覆盖全局样式，正是 E8 的成因）。 */
  function figColorOf(it) {
    return (it && typeof it.color === 'string' && it.color) ? it.color : state.style.pt.figure.color;
  }
  function addFigureAt(lat, lon) {
    const F = state.figure;
    if (F.snap && state.graticule) {              // 吸附：按当前经纬网间隔，±3° 内吸到线上
      const ms = gratSnapStep('mer'), ps = gratSnapStep('par');   // v33：多选间隔取最细的一套做吸附
      const q = function (v, step) { return Math.round(v / step) * step; };
      if (Math.abs(lat - q(lat, ps)) <= 3) lat = clamp(q(lat, ps), -90, 90);
      if (Math.abs(lon - q(lon, ms)) <= 3) lon = wrap180(q(lon, ms));
    }
    F.on = true;                                   // 放置即自动打开显示
    /* ★ v52（E8）：新放置的小人**不再**写入调色板色 —— 此前 addFigureAt 无条件写
       `color: nextFigColor(...)`，于是「小人样式 › 颜色」对已放置 / 新放置的小人都失效
       （figColorOf 优先取 it.color，永远命中那条调色板色）。现在改为不写 color，落到
       figColorOf 的回落分支 = 全局「小人样式 › 颜色」：改样式 → 已放置小人立即更新；
       改样式 → 新放置小人用新颜色。仍可在「已放置的小人」列表里逐人改色（会写入 it.color，
       作为显式覆盖，优先于全局样式）。 */
    F.items.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    const el = $('cbFigure'); if (el) el.checked = true;
    _figSig = null;
    binders.forEach(function (fn) { fn(); });       // 同步勾选框 / 上级置灰状态
    syncFigure(); applyAll(); persist();
  }
  /* 【拖放】菜单面板里的「小人」卡片 → 拖到地球表面放置
     用 pointer 事件（而不是 HTML5 drag&drop）：触摸屏 / 触控板都可用，
     且能实时把「落点预览圈」画到地球上。 */
  const FIG_SVG = '<svg viewBox="0 0 26 40" width="26" height="40" aria-hidden="true">'
    + '<circle cx="13" cy="7" r="5.4" fill="currentColor"/>'
    + '<rect x="10.6" y="12.6" width="4.8" height="3.4" rx="1.6" fill="currentColor"/>'
    + '<path d="M8.4 16.6h9.2a3 3 0 0 1 3 3.1l-.7 10.2a2 2 0 0 1-2 1.9h-9.8a2 2 0 0 1-2-1.9l-.7-10.2a3 3 0 0 1 3-3.1z" fill="currentColor"/>'
    + '<rect x="3.6" y="17.4" width="4" height="14" rx="2" fill="currentColor" transform="rotate(9 5.6 24.4)"/>'
    + '<rect x="18.4" y="17.4" width="4" height="14" rx="2" fill="currentColor" transform="rotate(-9 20.4 24.4)"/>'
    + '<rect x="8.2" y="30.6" width="4.2" height="9" rx="2" fill="currentColor"/>'
    + '<rect x="13.6" y="30.6" width="4.2" height="9" rx="2" fill="currentColor"/></svg>';
  (function () {
    const grab = $('figDrag'); if (!grab) return;
    const ico = grab.querySelector('.fig-ico'); if (ico) ico.innerHTML = FIG_SVG;
    let ghost = null, ringMesh = null, dragOver = null;
    // 落点预览圈（挂在 spin 下，跟着地球转）
    const ringGeo = new THREE.RingGeometry(0.012, 0.019, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
    });
    ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.renderOrder = 29; ringMesh.visible = false; spin.add(ringMesh);
    const ringMeshO = new THREE.Mesh(ringGeo, ringMat.clone());
    ringMeshO.renderOrder = 29; ringMeshO.visible = false; spinOrb.add(ringMeshO);
    function placeRing(hit, useOrb) {
      if (!hit) { ringMesh.visible = false; ringMeshO.visible = false; return null; }
      const spinRef = useOrb ? spinOrb : spin;
      spinRef.updateWorldMatrix(true, false);
      const local = spinRef.worldToLocal(hit.point.clone());
      const lat = Math.asin(clamp(local.y, -1, 1)) * R;
      const lon = wrap180(-Math.atan2(local.z, local.x) * R);
      const m = useOrb ? ringMeshO : ringMesh;
      const other = useOrb ? ringMesh : ringMeshO;
      other.visible = false;
      m.position.copy(markerLocal(lat, lon, new THREE.Vector3())).normalize().multiplyScalar(1.005);
      const up = m.position.clone().normalize();
      const north = YAX.clone();
      const fwd = north.addScaledVector(up, -north.dot(up));
      if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0);
      fwd.normalize();
      const east = new THREE.Vector3().crossVectors(fwd, up).normalize();   // east = north × up
      // RingGeometry 的法线是局部 +Z → 要让它平铺在切平面上，基须为 (east, north, up)
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, fwd, up));
      m.visible = true;
      return { lat: lat, lon: lon, useOrb: useOrb };
    }
    function moveGhost(x, y) {
      if (!ghost) return;
      ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
    }
    function onMove(e) {
      moveGhost(e.clientX, e.clientY);
      const ctx = hitCtx(e);
      if (!ctx) { placeRing(null, false); return; }
      const ndc = ndcOf(e, ctx.r);
      raycaster.setFromCamera(ndc, ctx.orb ? orbitCam : camera);
      const hit = raycaster.intersectObject(ctx.orb ? earthOrb : earth, false)[0];
      dragOver = placeRing(hit || null, ctx.orb);
    }
    function onUp(e) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      ringMesh.visible = false; ringMeshO.visible = false;
      syncCanvasCursor();          // 回到「当前模式该有的」光标（拖拽结束后别把十字光标抹掉）
      state.figure.dragging = false;
      const ctx = hitCtx(e);
      if (!ctx) return;
      const ndc = ndcOf(e, ctx.r);
      raycaster.setFromCamera(ndc, ctx.orb ? orbitCam : camera);
      const hit = raycaster.intersectObject(ctx.orb ? earthOrb : earth, false)[0];
      if (!hit) return;
      const spinRef = ctx.orb ? spinOrb : spin;
      spinRef.updateWorldMatrix(true, false);
      const local = spinRef.worldToLocal(hit.point.clone());
      const lat = Math.asin(clamp(local.y, -1, 1)) * R;
      const lon = wrap180(-Math.atan2(local.z, local.x) * R);
      addFigureAt(lat, lon);
    }
    grab.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      state.figure.dragging = true;
      ghost = document.createElement('div');
      ghost.className = 'fig-ghost';
      ghost.innerHTML = FIG_SVG;
      document.body.appendChild(ghost);
      moveGhost(e.clientX, e.clientY);
      canvas.style.cursor = 'copy';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // 列表删除 + 清空
    document.addEventListener('click', function (e) {
      const t = e.target; if (!t || !t.dataset) return;
      if (t.dataset.fig != null) { state.figure.items.splice(+t.dataset.fig, 1); _figSig = null; syncFigure(); applyAll(); persist(); }
    });
    const cb = $('btnFigClear');
    if (cb) cb.addEventListener('click', function () {
      state.figure.items.length = 0; _figSig = null; syncFigure(); applyAll(); persist();
    });
  })();

  /* ================= v27.0（需求一）：标记文本 =================
     在地球表面放置可编辑的「文字注释框」：随球旋转 / 缩放、保持相对位置与朝向（锚定球面，非广告牌）。
       · 拖拽卡片 → 地球表面放置（可选吸附经纬网），未落表面不创建；
       · 框体（尺寸 / 填充色与透明度 / 描边色与宽 / 圆角）有默认并支持整组与逐条自定义；
       · 文字默认继承「全局文字注释样式」（字体 / 字号 / 颜色 / 字重 / 对齐），仅显式覆盖时保留自定义值；
       · 点击文本框编辑文字，失焦 / 确认保存，空文本删除；按内容自适应高度；
       · 视作文本注释对象（note 分类 markText）纳入统一体系，支持增删改查 / 选中 / 显隐 / 持久化。 */
  var mtSel = null;                       // 当前在「已放置的文本」列表中选中的条目 id（null = 编辑共享默认）
  const MT_R = 1.005;                     // 文本框贴地半径（高于海陆 1.0018，低于标注点精灵）
  /* ★ v52（F1）：绘制层级契约 —— 「标记文本框」背景板（本 Mesh）必须**永远绘制在文字注释精灵之下**。
     文本框是半透明 PlaneGeometry（depthWrite 关、depthTest 开），与注释精灵同处 three.js 的
     透明绘制队列：同队列内按 renderOrder 排序后再绘制，故若某条注释精灵未显式设 renderOrder
     （默认 0）就会先于本板绘制而被其半透明底盖住（即用户看到的「竖长条透明方块挡字」）。
     本板保持 26（高于线 20、低于标注点 30）；applyAll 里对所有注释精灵统一兜底抬到 MT_RO+1
     以上（见该处 ★ v52（F1）guard），二者合起来保证「精灵永远在文本框之上」。 */
  const MT_RO = 26;                       // 绘制层级（高于线 20，低于标注点 30）
  const MT_PX = 1400;                     // 画布分辨率（px / 世界单位）★ v52（E6b）：800 → 1400，文字更清晰
  const MT_CV_MIN = 96, MT_CV_MAX = 1600; // ★ v52（E6b）：画布像素下限 / 上限 —— 下限保证窄框不再 32px 糊成一团，上限约束显存占用
  const mtGroupR = new THREE.Group(); spin.add(mtGroupR);
  const mtGroupO = new THREE.Group(); spinOrb.add(mtGroupO);
  let _mtSig = null, _mtNodes = [];
  /* 选中某条后：菜单里「框体样式」与「文字样式」的控件改指该条（单独自定义）；
     通过 getPath / setPath 的 redirectMarkText() 实现路径重定向，无需改动通用绑定器。 */
  function redirectMarkText(path) {
    const sel = (mtSel != null) ? state.markText.items.filter(function (x) { return x.id === mtSel; })[0] : null;
    if (/^markText\.box\./.test(path)) {
      const key = path.slice('markText.box.'.length);
      const tgt = sel ? sel.box : state.markText.box;
      return { get: function () { return tgt[key]; }, set: function (v) { tgt[key] = v; onMtChanged(); } };
    }
    if (/^note\.cats\.markText\./.test(path)) {
      const key = path.slice('note.cats.markText.'.length);
      if (key === 'on') return null;       // 分类总开关始终控制「分类」本身，不重定向到逐条
      if (sel) {
        if (!sel.ov) sel.ov = {};
        return { get: function () { return sel.ov[key]; }, set: function (v) { sel.ov[key] = v; onMtChanged(); } };
      }
      if (!state.note.cats.markText) state.note.cats.markText = { on: false, size: null, color: null, op: null, weight: null, align: null, font: null };
      const tgt = state.note.cats.markText;
      return { get: function () { return tgt[key]; }, set: function (v) { tgt[key] = v; onMtChanged(); } };
    }
    return null;
  }
  function onMtChanged() { _mtSig = null; syncMarkText(); applyAll(); persist(); }
  /* 文字样式解析：先取「全局 / 分类」统一结果，再叠加逐条 ov 覆盖（仅显式设置者生效） */
  function mtTextStyle(it) {
    const base = noteStyleFor('markText');
    const ov = it && it.ov;
    return {
      size: (ov && ov.size != null) ? ov.size : base.size,
      color: (ov && ov.color != null) ? ov.color : base.color,
      op: (ov && ov.op != null) ? ov.op : base.op,
      weight: (ov && ov.weight != null) ? ov.weight : base.weight,
      align: (ov && ov.align != null) ? ov.align : base.align,
      font: (ov && ov.font != null) ? ov.font : base.font,
    };
  }
  function roundRectPath(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  /* 把一条标记文本画到画布：填充 + 描边 + 文字；文字过长时按内容自适应（抬高框高）。
     返回实际使用的世界尺寸 { w, h } —— 供 makeMarkTextMesh 生成同宽高比的平面几何。
     ★ v52（E6a）：框高改为**双向**自适应（此前只增不减、且把结果写回 b.h 变成永久粘性）：
     但仍把用户设的 b.h 当作「最小高度」保底，故手动加高不会被自动缩回。不再改写 b.h。
     ★ v52（E6b）：画布像素数加下限/上限，窄框不再落到 32px 发糊，超大框也不至于吃爆显存。
     ★ v52（E6c）：文字一律**满不透明**绘制（不再把 t.op 折进字色 alpha，否则半透明字叠在
     不透明的框底色上会被冲淡）；整体透明度改由材质 opacity 统一控制（见 makeMarkTextMesh）。 */
  function drawMTCanvas(it, cv) {
    const b = it.box;
    const t = mtTextStyle(it);
    const wWorld = Math.max(0.05, b.w);
    const cw = Math.round(clamp(wWorld * MT_PX, MT_CV_MIN, MT_CV_MAX));
    const sizeFac = ((t.size != null ? t.size : 0.55) / 0.55);   // 以默认字号倍率 0.55 为基准（=1）
    // 字号由「框宽」决定（与框高解耦）—— 否则「字号∝框高」会与「按内容加高」形成正反馈，框高会被反复放大
    const fontPx = clamp(Math.max(14, cw * 0.16) * sizeFac, 10, 260);
    const fam = fontCss(t.font || 'default');
    const pad = Math.max(4, Math.round(cw * 0.06));
    const ctx0 = cv.getContext('2d');
    ctx0.font = t.weight + ' ' + fontPx + 'px ' + fam;
    // 按字符换行（中文逐字、英文按词感不强，逐字即可保证不溢出）
    const lines = [];
    String(it.text || '').split('\n').forEach(function (para) {
      let cur = '';
      for (let i = 0; i < para.length; i++) {
        const test = cur + para[i];
        if (cur && ctx0.measureText(test).width > cw - pad * 2) { lines.push(cur); cur = para[i]; }
        else cur = test;
      }
      lines.push(cur);
    });
    if (!lines.length) lines.push('');
    const lineH = fontPx * 1.25;
    const textH = lines.length * lineH;
    // 需要的高度（世界单位）；以用户设的 b.h 为下限，保证「自动适配」不会把手动加高缩回去
    const needH = (textH + pad * 2) / MT_PX;
    const hWorld = Math.max(0.03, b.h, needH);
    const ch = Math.round(clamp(hWorld * MT_PX, MT_CV_MIN, MT_CV_MAX));
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cw, ch);
    const rr = Math.min((b.radius != null ? b.radius : 0) * MT_PX, cw / 2, ch / 2);
    roundRectPath(g, 1, 1, cw - 2, ch - 2, Math.max(0, rr));
    if ((b.fillOp || 0) > 0) { g.save(); g.globalAlpha = clamp(b.fillOp, 0, 1); g.fillStyle = b.fill; g.fill(); g.restore(); }
    if ((b.strokeW || 0) > 0 && b.stroke) { g.lineWidth = Math.max(1, b.strokeW * MT_PX); g.strokeStyle = b.stroke; g.stroke(); }
    g.font = t.weight + ' ' + fontPx + 'px ' + fam;
    g.fillStyle = t.color || '#1F2937';            // ★ E6c：满不透明字色
    g.textAlign = t.align === 'left' ? 'left' : (t.align === 'right' ? 'right' : 'center');
    g.textBaseline = 'middle';
    const tx = t.align === 'left' ? pad : (t.align === 'right' ? cw - pad : cw / 2);
    const totalH = lines.length * lineH;
    const startY = (ch - totalH) / 2 + lineH / 2;
    lines.forEach(function (ln, i) { g.fillText(ln, tx, startY + i * lineH); });
    return { w: wWorld, h: hWorld };
  }
  function makeMarkTextMesh(it) {
    const cv = document.createElement('canvas');
    const dim = drawMTCanvas(it, cv);          // ★ E6a：拿到按内容/样式自适应的实际宽高
    const tex = new THREE.CanvasTexture(cv);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace; else tex.encoding = THREE.sRGBEncoding;
    const geo = new THREE.PlaneGeometry(dim.w, dim.h);   // ★ E6a：几何尺寸与画布等比，样式改后立即生效
    // ★ E6c：整体透明度交给材质统一控制（画布内文字为满不透明，故文字始终比框底更清晰、不被冲淡）
    const _mts = mtTextStyle(it);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: clamp(_mts.op != null ? _mts.op : 1, 0, 1), depthWrite: false, depthTest: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = MT_RO;
    mesh.userData.itemId = it.id;
    return mesh;
  }
  /* 签名增量重建：框体 / 文字 / 全局文字样式 / 分类样式任一变化才重建（避免每帧分配） */
  function syncMarkText() {
    const M = state.markText;
    const cat = state.note.cats.markText || {};
    const sig = JSON.stringify([
      M.items, M.on, M.box,
      state.note.master.on, state.note.master.size, state.note.master.color, state.note.master.op,
      state.note.master.weight, state.note.master.align, state.note.master.font,
      state.note.unifyAttrs, { on: cat.on, size: cat.size, color: cat.color, op: cat.op, weight: cat.weight, align: cat.align, font: cat.font },
    ]);
    if (sig === _mtSig) return;
    _mtSig = sig;
    _mtNodes.forEach(function (o) {
      [mtGroupR, mtGroupO].forEach(function (g) { if (o.mesh.parent === g) g.remove(o.mesh); });
      if (o.mesh.material.map) o.mesh.material.map.dispose();
      o.mesh.material.dispose();
    });
    _mtNodes = [];
    M.items.forEach(function (it) {
      [['R', mtGroupR], ['O', mtGroupO]].forEach(function (pair) {
        const reg = pair[0], grp = pair[1];
        const mesh = makeMarkTextMesh(it);
        const up = markerLocal(it.lat, it.lon, new THREE.Vector3());
        // 局部基：+X = 东、+Y = 北（正上）、+Z = 球面法线（朝外）—— 文本框平铺于切平面、文字竖直朝向北极
        const north = YAX.clone();
        const fwd = north.addScaledVector(up, -north.dot(up));
        if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0);
        fwd.normalize();
        const east = new THREE.Vector3().crossVectors(fwd, up).normalize();
        mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, fwd, up));
        mesh.position.copy(up).multiplyScalar(MT_R);
        grp.add(mesh);
        _mtNodes.push({ reg: reg, mesh: mesh, item: it, lat: it.lat, lon: it.lon });
      });
    });
    applyMarkText();
    renderMtList();
  }
  function applyMarkText() {
    const M = state.markText, on = !!M.on;
    mtGroupR.visible = on; mtGroupO.visible = on;
    _mtNodes.forEach(function (o) { o.mesh.visible = on && (o.item.show !== false); });
  }
  function deleteMtItem(id) {
    const i = state.markText.items.findIndex(function (x) { return x.id === id; });
    if (i < 0) return;
    if (mtSel === id) mtSel = null;
    state.markText.items.splice(i, 1);
    _mtSig = null; syncMarkText(); applyAll(); persist();
    binders.forEach(function (s) { if (s) s(); });   // 选中态清零后，控件回归编辑共享默认
  }
  function addMarkTextAt(lat, lon) {
    const M = state.markText;
    mtSel = null;                              // 新放置不继承上一条的选中态：上方控件回到编辑共享默认
    if (M.snap && state.graticule) {           // 吸附：按当前经纬网间隔，±3° 内吸到线上
      const ms = gratSnapStep('mer'), ps = gratSnapStep('par');   // v33：多选间隔取最细的一套做吸附
      const q = function (v, step) { return Math.round(v / step) * step; };
      if (Math.abs(lat - q(lat, ps)) <= 3) lat = clamp(q(lat, ps), -90, 90);
      if (Math.abs(lon - q(lon, ms)) <= 3) lon = wrap180(q(lon, ms));
    }
    const id = 'mt' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const d = M.box;
    const item = {
      id: id, lat: +lat.toFixed(4), lon: +lon.toFixed(4), text: '',
      box: { w: d.w, h: d.h, fill: d.fill, fillOp: d.fillOp, stroke: d.stroke, strokeW: d.strokeW, radius: d.radius },
      ov: null, show: true,
    };
    M.on = true;                                // 放置即自动打开显示（= 进入文本标记模式）
    M.items.push(item);
    const el = $('cbMarkText'); if (el) el.checked = true;
    _mtSig = null;
    binders.forEach(function (s) { if (s) s(); });
    syncMarkText(); applyAll(); persist();
    openMtEditor(item, null);                   // 落点即进入编辑（提示「输入后确认保存，留空删除」）
  }
  /* ---- 编辑器（浮层）：编辑选中文本框的文字 ---- */
  let mtEditing = null;
  function openMtEditor(item, at) {
    mtEditing = item;
    let box = $('mtEditor');
    if (!box) {
      box = document.createElement('div'); box.id = 'mtEditor'; box.className = 'mt-editor';
      box.innerHTML = '<textarea id="mtEditorTa" class="mt-editor-ta" placeholder="输入文字…"></textarea>'
        + '<div class="mt-editor-btns"><button class="btn xs" id="mtEditorOk">确认</button>'
        + '<button class="btn xs" id="mtEditorCancel">取消</button></div>'
        + '<div class="mt-editor-tip">输入后点「确认」保存；留空则删除该文本框</div>';
      document.body.appendChild(box);
      $('mtEditorOk').addEventListener('click', commitMtEditor);
      $('mtEditorCancel').addEventListener('click', function () { closeMtEditor(); });
      $('mtEditorTa').addEventListener('blur', commitMtEditor);
    }
    const ta = $('mtEditorTa'); ta.value = item.text || '';
    if (at) { box.style.left = Math.min(at.x + 14, window.innerWidth - 300) + 'px'; box.style.top = Math.min(at.y + 14, window.innerHeight - 170) + 'px'; box.style.transform = 'none'; }
    else { box.style.left = '50%'; box.style.top = '38%'; box.style.transform = 'translate(-50%,-50%)'; }
    box.classList.add('on');
    setTimeout(function () { ta.focus(); ta.select(); }, 30);
    mtToast('正在编辑标记文本（输入后点「确认」保存，留空删除）');
  }
  function commitMtEditor() {
    const item = mtEditing; if (!item) return;
    const ta = $('mtEditorTa'); if (!ta) return;
    const txt = ta.value;
    if (!txt || !txt.trim()) deleteMtItem(item.id);
    else { item.text = txt; _mtSig = null; syncMarkText(); applyAll(); persist(); }
    closeMtEditor();
  }
  function closeMtEditor() { mtEditing = null; const e = $('mtEditor'); if (e) e.classList.remove('on'); }
  /* ---- 轻提示 ---- */
  let _mtToast = null, _mtToastT = null;
  function mtToast(msg) {
    if (!_mtToast) { _mtToast = document.createElement('div'); _mtToast.className = 'mt-toast'; document.body.appendChild(_mtToast); }
    _mtToast.textContent = msg; _mtToast.classList.add('on');
    clearTimeout(_mtToastT); _mtToastT = setTimeout(function () { _mtToast.classList.remove('on'); }, 2200);
  }
  /* 点击拾取：命中某条文本框 → 打开编辑；未命中（且处于标记文本模式）则忽略（不创建、不查询） */
  function pickMarkTextAt(e, ctx0) {
    const useOrb = ctx0.orb;
    const meshes = _mtNodes.filter(function (o) { return o.reg === (useOrb ? 'O' : 'R') && o.mesh.visible; }).map(function (o) { return o.mesh; });
    if (!meshes.length) return null;
    const ndc = ndcOf(e, ctx0.r);
    raycaster.setFromCamera(ndc, useOrb ? orbitCam : camera);
    const earthHit = raycaster.intersectObject(useOrb ? earthOrb : earth, false)[0];
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    if (earthHit && hit.distance > earthHit.distance + 0.01) return null;   // 被地球遮挡（背面）→ 忽略
    const node = _mtNodes.filter(function (o) { return o.mesh === hit.object; })[0];
    return node ? node.item : null;
  }
  function renderMtList() {
    const box = document.getElementById('mtList'); if (!box) return;
    const M = state.markText;
    box.innerHTML = M.items.length ? '' : '<div class="pt-empty">暂无标记文本 — 开启「标记文本」后，把上面的文本框拖到地球表面放置</div>';
    M.items.forEach(function (it, i) {
      const row = document.createElement('div'); row.className = 'pt-row' + (mtSel === it.id ? ' on' : '');
      const dot = document.createElement('span'); dot.className = 'pt-dot'; dot.style.background = it.box.fill;
      const vis = document.createElement('input'); vis.type = 'checkbox'; vis.className = 'pt-show'; vis.checked = it.show !== false; vis.dataset.mtshow = i; vis.title = '显隐';
      const txt = document.createElement('span'); txt.className = 'pt-txt';
      txt.textContent = (it.text && it.text.trim()) ? it.text.replace(/\n/g, ' ') : '（空文本）';
      txt.title = fmtLat(it.lat) + ' ' + fmtLon(it.lon) + ' —— 点击选中后可单独自定义样式';
      const del = document.createElement('button'); del.className = 'btn xs pt-del'; del.textContent = '删除'; del.dataset.mt = i;
      row.appendChild(vis); row.appendChild(dot); row.appendChild(txt); row.appendChild(del);
      box.appendChild(row);
    });
  }
  (function bindMarkTextUI() {
    const SVG = '<svg viewBox="0 0 40 26" width="40" height="26" aria-hidden="true">'
      + '<rect x="1.5" y="1.5" width="37" height="23" rx="5" fill="currentColor" opacity="0.18"/>'
      + '<rect x="1.5" y="1.5" width="37" height="23" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
      + '<line x1="7" y1="9" x2="33" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<line x1="7" y1="14" x2="27" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<line x1="7" y1="19" x2="21" y2="19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    const grab = $('mtDrag'); if (!grab) return;
    const ico = grab.querySelector('.mt-ico'); if (ico) ico.innerHTML = SVG;
    let ghost = null, ringMesh = null, ringMeshO = null;
    const ringGeo = new THREE.RingGeometry(0.016, 0.024, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xC9A227, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    ringMesh = new THREE.Mesh(ringGeo, ringMat); ringMesh.renderOrder = 29; ringMesh.visible = false; spin.add(ringMesh);
    ringMeshO = new THREE.Mesh(ringGeo, ringMat.clone()); ringMeshO.renderOrder = 29; ringMeshO.visible = false; spinOrb.add(ringMeshO);
    function placeRing(hit, useOrb) {
      if (!hit) { ringMesh.visible = false; ringMeshO.visible = false; return null; }
      const spinRef = useOrb ? spinOrb : spin;
      spinRef.updateWorldMatrix(true, false);
      const local = spinRef.worldToLocal(hit.point.clone());
      const lat = Math.asin(clamp(local.y, -1, 1)) * R;
      const lon = wrap180(-Math.atan2(local.z, local.x) * R);
      const m = useOrb ? ringMeshO : ringMesh, other = useOrb ? ringMesh : ringMeshO;
      other.visible = false;
      m.position.copy(markerLocal(lat, lon, new THREE.Vector3())).normalize().multiplyScalar(MT_R);
      const up = m.position.clone().normalize();
      const north = YAX.clone();
      const fwd = north.addScaledVector(up, -north.dot(up));
      if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0);
      fwd.normalize();
      const east = new THREE.Vector3().crossVectors(fwd, up).normalize();
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, fwd, up));
      m.visible = true;
      return { lat: lat, lon: lon, useOrb: useOrb };
    }
    function moveGhost(x, y) { if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; } }
    function onMove(e) {
      moveGhost(e.clientX, e.clientY);
      if (!state.markText.on) { ringMesh.visible = false; ringMeshO.visible = false; return; }
      const ctx = hitCtx(e); if (!ctx) { placeRing(null, false); return; }
      const ndc = ndcOf(e, ctx.r);
      raycaster.setFromCamera(ndc, ctx.orb ? orbitCam : camera);
      const hit = raycaster.intersectObject(ctx.orb ? earthOrb : earth, false)[0];
      placeRing(hit || null, ctx.orb);
    }
    function onUp(e) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      ringMesh.visible = false; ringMeshO.visible = false;
      syncCanvasCursor();
      if (!state.markText.on) { mtToast('请先开启「标记文本」开关'); return; }   // 关闭 → 不响应新增
      const ctx = hitCtx(e); if (!ctx) return;
      const ndc = ndcOf(e, ctx.r);
      raycaster.setFromCamera(ndc, ctx.orb ? orbitCam : camera);
      const hit = raycaster.intersectObject(ctx.orb ? earthOrb : earth, false)[0];
      if (!hit) return;                                // 未落表面 → 不创建
      const spinRef = ctx.orb ? spinOrb : spin;
      spinRef.updateWorldMatrix(true, false);
      const local = spinRef.worldToLocal(hit.point.clone());
      const lat = Math.asin(clamp(local.y, -1, 1)) * R;
      const lon = wrap180(-Math.atan2(local.z, local.x) * R);
      addMarkTextAt(lat, lon);
    }
    grab.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      ghost = document.createElement('div'); ghost.className = 'fig-ghost mt-ghost'; ghost.innerHTML = SVG;
      document.body.appendChild(ghost); moveGhost(e.clientX, e.clientY);
      canvas.style.cursor = 'copy';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // 列表：删除 / 显隐 / 选中（选中后上方控件改编辑该条）
    document.addEventListener('click', function (e) {
      const t = e.target; if (!t || !t.dataset) return;
      const list = document.getElementById('mtList');
      if (t.dataset.mt != null) { const it = state.markText.items[+t.dataset.mt]; if (it) deleteMtItem(it.id); return; }
      if (t.dataset.mtshow != null) { const it = state.markText.items[+t.dataset.mtshow]; if (it) { it.show = !it.show; _mtSig = null; syncMarkText(); applyAll(); persist(); } return; }
      if (t.classList && t.classList.contains('pt-txt') && list && t.closest('#mtList')) {
        const rows = Array.prototype.slice.call(list.children);
        const idx = rows.indexOf(t.closest('.pt-row'));
        const it = state.markText.items[idx]; if (!it) return;
        mtSel = (mtSel === it.id) ? null : it.id;     // 再次点击取消选中
        binders.forEach(function (s) { if (s) s(); });
        renderMtList();
        mtToast(mtSel ? ('已选中第 ' + (idx + 1) + ' 条 —— 上方「框体样式 / 文字样式」改为编辑该条（单独自定义）')
                      : '已取消选中 —— 上方控件恢复编辑共享默认样式');
      }
    });
    const clr = $('btnMtClear');
    if (clr) clr.addEventListener('click', function () {
      state.markText.items.length = 0; mtSel = null; _mtSig = null; syncMarkText(); applyAll(); persist();
    });
  })();

  /* ================= v25.1（需求⑧）：球面最短距离 —— 面板交互 =================
     三块「取点方式」面板 + 状态行 + 结果读数；按钮 / 下拉 / 输入框都在这一个块里接线。
     关于「关闭时清理事件监听」：本功能**不新增任何常驻之外的监听** ——
       · 取点用的是 canvas 上那个统一的 pointerup（既有监听，靠 gcd.on 门控，见该处分支）；
       · 面板里所有监听都挂在 renderMenu() 生成的固定 DOM 上，随面板生死，从不重复挂载。
     因此「关闭」= 不再有任何监听生效 + 实体与标签全部撤除（见 gcd 的 on 分支）。 */
  const GCD_MODE_HINT = {
    click: '在地球上依次点击两点：第一次点击设 A 点，第二次点击设 B 点。',
    marker: '从已有标记点里选两点，然后点「用所选标记点测量」。',
    input: '直接输入两点的经纬度，然后点「用输入的经纬度测量」。',
  };
  function syncCanvasCursor() {
    const pick = !!(state.gcd.on && state.gcd.mode === 'click');
    canvas.style.cursor = (state.points.mode || pick) ? 'crosshair' : '';
  }
  /* 点击取点：A 未定 → 设 A；A 已定且 B 已定（上一轮完成）→ 开始新一轮设 A。
     取到的经纬度与「点击查询」同口径（rad→deg，经度已 wrap180）。 */
  function gcdPick(lat, lon) {
    const G = state.gcd;
    const pt = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    if (!G.a || G.b) { G.a = pt; G.b = null; } else { G.b = pt; }
    applyAll(); persist(); renderGcdPanel();
  }
  // 重新测量：清空两端点，回到「等待取点」，保留当前取点方式与样式设置
  function gcdRematch() {
    const G = state.gcd;
    G.a = null; G.b = null;
    applyAll(); persist(); renderGcdPanel();
  }
  // 清除结果：连「标记点索引 / 手动输入的经纬度」一起复位（比「重新测量」更彻底）
  function gcdClear() {
    const G = state.gcd;
    G.a = null; G.b = null; G.mkA = 0; G.mkB = 1;
    G.inp = { aLat: 39.9, aLon: 116.4, bLat: 35.68, bLon: 139.69 };
    applyAll(); persist(); renderGcdPanel();
  }
  const GCD_DEF_INP = { aLat: 39.9, aLon: 116.4, bLat: 35.68, bLon: 139.69 };
  function gcdResultHtml(st) {
    const G = state.gcd;
    if (!G.a || !G.b) return '<div class="gcd-empty">尚未确定两点 —— 结果将在这里显示。</div>';
    const ang = st.sol ? st.sol.ang : 0;
    const warn = st.kind === 'same' ? '　（两点重合）' : st.kind === 'anti' ? '　（对跖：大圆不唯一）' : '';
    const row = function (k, v, big) {
      return '<div class="gcd-r' + (big ? ' big' : '') + '"><span>' + k + '</span><b>' + v + '</b></div>';
    };
    return row('A 点', fmtLat(G.a.lat) + ' ' + fmtLon(G.a.lon)) +
      row('B 点', fmtLat(G.b.lat) + ' ' + fmtLon(G.b.lon)) +
      row('圆心角', (ang * R).toFixed(2) + '°' + warn) +
      row('球面最短距离', fmtGcdDist(ang), true);
  }
  function renderGcdMarkers() {
    const G = state.gcd, its = state.points.items || [];
    const selA = $('selGcdA'), selB = $('selGcdB');
    if (!selA || !selB) return;
    const sig = JSON.stringify(its);
    if (selA.dataset.gcdSig !== sig) {          // 标记点变了才重建（避免打断用户正在展开的下拉）
      selA.dataset.gcdSig = sig;
      [selA, selB].forEach(function (s) { s.innerHTML = ''; });
      its.forEach(function (it, i) {
        const t = it.label + ' · ' + fmtLat(it.lat) + ' ' + fmtLon(it.lon);
        [selA, selB].forEach(function (s) {
          const o = document.createElement('option'); o.value = String(i); o.textContent = t; s.appendChild(o);
        });
      });
      if (its.length < 2) {
        [selA, selB].forEach(function (s) {
          const o = document.createElement('option'); o.textContent = '暂无标记点'; s.appendChild(o);
        });
      }
    }
    const n = its.length;
    selA.disabled = selB.disabled = n < 2;
    if (n >= 2) {
      G.mkA = clamp(+G.mkA || 0, 0, n - 1);
      G.mkB = clamp(+G.mkB || 0, 0, n - 1);
      selA.value = String(G.mkA); selB.value = String(G.mkB);
    }
  }
  function syncGcdInputs() {
    const I = state.gcd.inp || GCD_DEF_INP;
    [['inGcdALat', 'aLat'], ['inGcdALon', 'aLon'], ['inGcdBLat', 'bLat'], ['inGcdBLon', 'bLon']]
      .forEach(function (p) {
        const el = $(p[0]); if (!el || el === document.activeElement) return;   // 正在输入就不回写
        el.value = String(I[p[1]]);
      });
  }
  /* ===== v26.1（需求⑦）：选点模式提示条 =====
     进入需要「在地球上取点」的模式后，屏幕顶部常驻一条提示，写明处于选点模式以及
     具体选哪一种点。观测点定位不算 —— 它是「点一下查数据」的查询行为，不是放置要素，
     按用户要求不出现提示条。
     v26.1（需求⑤）：球面最短距离在**选点过程中**实时显示已经选中的点（A / B 的经纬度），
     不必等到两点都确定才看得到 —— 与面板里的状态行同源，永远一致。 */
  function pickModeInfo() {
    const G = state.gcd;
    if (G && G.on) {
      const ll = function (p) { return p ? (fmtLat(p.lat, 1) + ' ' + fmtLon(p.lon, 1)) : '未选'; };
      const modeName = { click: '点击地球取点', marker: '从标记点选取', input: '输入经纬度' }[G.mode] || '点击地球取点';
      let detail;
      if (G.mode === 'click') {
        detail = !G.a ? '请点击地球取 A 点（第一点）'
          : !G.b ? ('已选 A：' + ll(G.a) + ' —— 请点击地球取 B 点（第二点）')
            : ('已选 A：' + ll(G.a) + '｜B：' + ll(G.b) + ' —— 再点一次即开始新一轮');
      } else {
        detail = '已选 A：' + ll(G.a) + '｜B：' + ll(G.b) + '（' + modeName + '）';
      }
      return { kind: 'gcd', title: '标记模式 · 球面最短距离（' + modeName + '）', detail: detail };
    }
    if (state.points && state.points.mode) {
      const n = (state.points.items || []).length;
      return {
        kind: 'pts', title: '标记模式 · 标记点（点击地球添加）',
        detail: '点击地球即在落点处添加一个标记点' + (n ? ('（已有 ' + n + ' 个）') : '') + '。',
      };
    }
    if (state.markText && state.markText.on) {
      const n = (state.markText.items || []).length;
      return {
        kind: 'markText', title: '标记文本（点击文本框编辑）',
        detail: '点击已放置的文本框即可编辑文字；留空则删除' + (n ? ('（已有 ' + n + ' 个）') : '') + '。',
      };
    }
    return null;
  }
  function updatePickTip() {
    const box = $('pickTip'); if (!box) return;
    const info = pickModeInfo();
    if (!info) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.kind = info.kind;
    const t = box.querySelector('.pt-t');
    if (t) t.textContent = info.title + ' —— ' + info.detail;
    const ico = box.querySelector('.pt-ico');
    if (ico) ico.textContent = info.kind === 'gcd' ? '📏' : (info.kind === 'markText' ? '🏷️' : '📍');
  }
  (function bindPickTip() {
    const btn = $('btnPickTipExit');
    if (btn) btn.addEventListener('click', function () {
      const info = pickModeInfo();
      if (!info) return;
      if (info.kind === 'gcd') {
        const el = $('cbGCD'); if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
      } else if (info.kind === 'markText') {
        const el = $('cbMarkText'); if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
      } else {
        const el = $('cbAddMode'); if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
      }
    });
  })();

  function renderGcdPanel() {
    const G = state.gcd, st = gcdStatus();
    updatePickTip();      // v26.1（需求⑤⑦）：面板刷新时同步顶部「已选中的点」
    const bx = { click: $('gcdBoxClick'), marker: $('gcdBoxMarker'), input: $('gcdBoxInput') };
    Object.keys(bx).forEach(function (k) { if (bx[k]) bx[k].style.display = (G.mode === k) ? '' : 'none'; });
    renderGcdMarkers();
    syncGcdInputs();
    const msg = $('gcdMsg');
    let m = '', cls = '';
    if (!G.on) { m = '未开启 —— 勾选「显示球面最短距离」即进入测量状态。'; }
    else if (st.kind === 'ok') { m = '✓ 测量完成 —— 地球上的洋红弧线就是两点间的球面最短路径（大圆劣弧）。'; cls = 'ok'; }
    else if (st.kind === 'same') { m = '⚠ 两点重合（球面距离 ≈ 0 米）：过重合点的大圆不唯一，已停止绘制 —— 请让两点分开一些。'; cls = 'warn'; }
    else if (st.kind === 'anti') { m = '⚠ 两点互为对跖点（圆心角 180°，球面距离约 20,015 千米）：过这两点的大圆有无穷多条，图中绘制的是其中任意一条。'; cls = 'warn'; }
    else if (G.a) { m = '已取 A 点 ' + fmtLat(G.a.lat) + ' ' + fmtLon(G.a.lon) + ' —— 请再确定 B 点。'; }
    else { m = '等待取点：' + (GCD_MODE_HINT[G.mode] || ''); }
    if (msg) { msg.textContent = m; msg.className = 'gcd-msg' + (cls ? ' ' + cls : ''); }
    const box = $('gcdResult');
    if (box) box.innerHTML = gcdResultHtml(st);
  }
  (function bindGcdUI() {
    // 总开关：关闭即清理（端点 / 提示 / 地球上的实体与标签，见 applyGcd 的 grp.visible）
    bindSwitch('cbGCD', 'gcd.on', function () {
      const G = state.gcd;
      if (!G.on) { G.a = null; G.b = null; G.msg = ''; }
      syncCanvasCursor(); renderGcdPanel();
    });
    bindSelect('selGcdMode', 'gcd.mode', function () { syncCanvasCursor(); renderGcdPanel(); });
    ['selGcdA', 'selGcdB'].forEach(function (id) {
      const el = $(id); if (!el) return;
      el.addEventListener('change', function () {
        state.gcd.mkA = +($('selGcdA') || {}).value || 0;
        state.gcd.mkB = +($('selGcdB') || {}).value || 0;
      });
    });
    const mkApply = $('btnGcdMkApply');
    if (mkApply) mkApply.addEventListener('click', function () {
      const G = state.gcd, its = state.points.items || [];
      if (its.length < 2) { G.a = null; G.b = null; renderGcdPanel(); return; }   // 面板里已给出「暂无标记点」
      const i = clamp(+($('selGcdA') || {}).value || 0, 0, its.length - 1);
      const j = clamp(+($('selGcdB') || {}).value || 0, 0, its.length - 1);
      G.mkA = i; G.mkB = j;
      G.a = { lat: its[i].lat, lon: its[i].lon };
      G.b = { lat: its[j].lat, lon: its[j].lon };
      applyAll(); persist(); renderGcdPanel();
    });
    const inApply = $('btnGcdInApply');
    if (inApply) inApply.addEventListener('click', function () {
      const G = state.gcd, cur = G.inp || GCD_DEF_INP;
      const rd = function (id, lo, hi, dflt) {
        const el = $(id); const v = el ? parseFloat(el.value) : NaN;
        return clamp(isFinite(v) ? v : dflt, lo, hi);
      };
      G.inp = { aLat: rd('inGcdALat', -90, 90, cur.aLat), aLon: rd('inGcdALon', -180, 180, cur.aLon),
                bLat: rd('inGcdBLat', -90, 90, cur.bLat), bLon: rd('inGcdBLon', -180, 180, cur.bLon) };
      G.a = { lat: G.inp.aLat, lon: G.inp.aLon };
      G.b = { lat: G.inp.bLat, lon: G.inp.bLon };
      applyAll(); persist(); renderGcdPanel();
    });
    const rm = $('btnGcdRematch'); if (rm) rm.addEventListener('click', gcdRematch);
    const cl = $('btnGcdClear');   if (cl) cl.addEventListener('click', gcdClear);
    syncCanvasCursor();
    renderGcdPanel();
  })();

  /* ===== v23.11：点标注（地图文字注释）的渲染层级 · 锚点 · 避让 =====
     用户反馈：地图上的 A / B / C… 注释文字「显示不完整、出现缺口或被截断」，并且希望文字
     位于对应要素「顶部之上、水平居中」、层级高于所有地理要素、多个注释之间能互相避让。
     实测根因（无头浏览器探针）：标签精灵与它自己的「点圆点」屏幕中心几乎完全重合
     （ndc 差 < 0.002），而圆点是不透明球体（depthTest / depthWrite 均开）且更靠近相机 ——
     标签正中那一块被圆点挡掉，于是形成「缺口 / 被截断」的观感。
     对应处理：
       ① 完整渲染：PTS_LABEL_RO 最高绘制层级 + 关闭深度测试 —— 圆点 / 经纬网 / 云层 / 光线 /
          五带填充等任何要素都不会再切掉标签；地球背面的标签改由「球面法线是否朝向相机」
          逐帧剔除（见下），所以关掉深度测试也不会把背面的文字透出来。
       ② 位置：sprite.center = (0.5, -PTS_LABEL_LIFT) —— 锚点落在标签「底边中点」下方，
          标签于是「垂直方向位于要素顶部之上、水平居中对齐」；该间距是标签自身高度的比例，
          与字号解耦，任何字号下都不会再压住圆点。
       ③ 层级：renderOrder = PTS_LABEL_RO（900），高于全部地理要素（≤ 30）与其它注释。
       ④ 避让：每帧在屏幕等比坐标里算标签矩形，重叠者沿相机「上」方向依次错开；
          同时把标签夹在视口内，保证整条文字始终完整可见。
     自转（spin + camera）与公转（spinOrb + orbitCam）两个视图各按自己的相机分别计算。 */
  const PTS_LABEL_RO = 900;        // 绘制层级：高于所有地理要素与其它注释
  const PTS_LABEL_LIFT = 0.22;     // 标签底边相对要素顶部的间距（= 标签自身高度的倍数）
  const PTS_LABEL_GAP = 0.014;     // 标签之间的最小竖直间隙（屏幕归一高度）
  const PTS_LABEL_PADX = 0.008;    // 标签之间的最小水平间隙（屏幕归一高度）
  const PTS_LIFT_MAX = 0.32;       // 避让位移上限，避免标签飞离要素
  const PTS_EDGE_PAD = 0.006;      // 与视口边缘的安全距离
  const PTS_SPREAD_MAX = 0.12;     // ★ v52（E4）：竖直预算耗尽时的水平让开上限（屏幕等比宽度）
  const _plA = new THREE.Vector3(), _plB = new THREE.Vector3(), _plN = new THREE.Vector3();
  const _plR = new THREE.Vector3(), _plU = new THREE.Vector3(), _plC = new THREE.Vector3();
  const _plS = new THREE.Vector3(), _plM = new THREE.Matrix4();
  const _plList = [], _plPlaced = [];   // 每帧复用的候选表 / 已落位矩形池（逐帧零分配）
  /* v23.17（需求③）：点标注文字同样改成「按正在渲染的相机 + 该视图的 rig」重算 ——
     原来固定用 camera / orbitCam，综合视图的直射点回归运动子窗（正交相机、朝太阳方向）
     会沿用主相机的摆位与背面判据，出现「正面该显示的不显示、背面该挡住的不挡住」。 */
  function updatePointLabels(cam, rig, viewKey) {
    if (!_ptSprites.length) return;
    const list = [];
    for (let i = 0; i < _ptSprites.length; i++) if (_ptSprites[i].userData.ptsView === viewKey) list.push(_ptSprites[i]);
    if (!list.length) return;
    {
      const G = { view: viewKey, rig: rig, cam: cam };
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      const e = cam.matrixWorld.elements;
      _plR.set(e[0], e[1], e[2]);                        // 相机右方向（世界）
      _plU.set(e[4], e[5], e[6]);                        // 相机上方向（世界）
      G.rig.updateWorldMatrix(true, false);
      G.rig.getWorldPosition(_plC);                      // 地心（世界）：背面剔除的球心
      const aspect = cam.aspect || 1;
      const rec = _plList; rec.length = 0;
      for (let i = 0; i < list.length; i++) {
        const sp = list[i];
        sp.visible = false;
        if (sp.userData.noteGate === false) continue;    // 门控关闭的标签不参与布局，也不影响可见标签
        const anchor = sp.userData.ptsAnchor;
        if (!anchor) continue;
        sp.parent.updateWorldMatrix(true, false);
        _plA.copy(anchor).applyMatrix4(sp.parent.matrixWorld);         // 锚点世界坐标
        _plN.copy(_plA).sub(_plC).normalize();                          // 球面法线
        if (_plN.dot(_plB.copy(cam.position).sub(_plA)) <= 0) continue; // 背面 → 剔除（不会透出）
        _plB.copy(_plA).project(cam);
        if (!isFinite(_plB.x) || !isFinite(_plB.y) || _plB.z >= 1) continue;
        // 每世界单位在「屏幕等比坐标」（x 已按 aspect 归一）上的变化率
        _plN.copy(_plA).add(_plR).project(cam);
        const ddx = (_plN.x - _plB.x) * aspect;
        _plN.copy(_plA).add(_plU).project(cam);
        const ddy = _plN.y - _plB.y;
        const ws = sp.getWorldScale(_plS);
        const hw = Math.abs(0.5 * ws.x * ddx), h = Math.abs(ws.y * ddy);
        if (!(hw > 0) || !(h > 0)) continue;
        const r = sp.userData.ptsPl || (sp.userData.ptsPl = {
          sp: sp, cx: 0, cy: 0, hw: 0, h: 0, ddx: 0, ddy: 0, dy: 0, dx: 0, world: new THREE.Vector3(),
        });
        r.cx = _plB.x * aspect; r.cy = _plB.y; r.hw = hw; r.h = h; r.ddx = ddx; r.ddy = ddy; r.dy = 0; r.dx = 0;
        r.world.copy(_plA);
        rec.push(r);
      }
      // ④ 重叠避让：屏幕上方的标签优先落位，后放的重叠时沿「上」方向错开（可迭代，避免连环压住）
      //    ★ v52（E4）：① 排序增补稳定次级键（cx）—— 同高度标签的落位次序不再随帧抖动，
      //    消除「互相排挤」的跳动感；② 竖直预算（liftMax）耗尽仍重叠时，再沿水平方向让开。
      rec.sort(function (a, b) { return (b.cy - a.cy) || (a.cx - b.cx); });
      const placed = _plPlaced; let pn = 0;
      for (let i = 0; i < rec.length; i++) {
        const r = rec[i];
        /* 单个标签的避让上限：至少要能让开「一个标签高度 + 间隙」，同时顶边不得越出画面。
           两者取小 —— 于是极端字号（标签本身已高于画面）时上限为 0，标签保持原位不下移，
           「注释位于要素上方」的语义在任何字号下都成立。 */
        const liftMax = Math.max(0, Math.min(
          Math.max(PTS_LIFT_MAX, r.h + PTS_LABEL_GAP),
          1 - PTS_EDGE_PAD - r.h - r.cy
        ));
        for (let it = 0; it < 8; it++) {
          let need = null;
          for (let j = 0; j < pn; j++) {
            const q = placed[j];
            if (Math.abs(q.cx - r.cx) >= q.hw + r.hw + PTS_LABEL_PADX) continue;   // 水平无交集
            const y0 = r.cy + r.dy, y1 = y0 + r.h;
            if (y0 >= q.y1 + PTS_LABEL_GAP || y1 <= q.y0 - PTS_LABEL_GAP) continue; // 竖直无交集
            const d = q.y1 + PTS_LABEL_GAP - y0;
            if (need === null || d > need) need = d;
          }
          if (need === null) break;
          r.dy = Math.min(r.dy + need, liftMax);
          if (r.dy >= liftMax) break;
        }
        /* ★ v52（E4）：竖直让不开（liftMax 已到顶，或标签本身高于画面）时，改水平让开 ——
           往「远离对方」的一侧平移恰好错开的距离；逐次迭代收敛，位移夹在 PTS_SPREAD_MAX 内。
           仅当仍有竖直交集时才平移，故不会干扰本已分层的标签。 n 很小（标记点数量级），
           复杂度与既有竖直避让同为 O(n²)，不增加每帧负担。 */
        for (let it = 0; it < 6; it++) {
          let best = 0;
          const cx = r.cx + r.dx;
          const y0 = r.cy + r.dy, y1 = y0 + r.h;
          for (let j = 0; j < pn; j++) {
            const q = placed[j];
            if (y0 >= q.y1 + PTS_LABEL_GAP || y1 <= q.y0 - PTS_LABEL_GAP) continue;
            const ovx = q.hw + r.hw + PTS_LABEL_PADX - Math.abs(q.cx - cx);
            if (ovx <= 0) continue;
            const d = (cx >= q.cx ? 1 : -1) * ovx;             // 远离对方方向
            if (Math.abs(d) > Math.abs(best)) best = d;
          }
          if (best === 0) break;
          r.dx = clamp(r.dx + best, -PTS_SPREAD_MAX, PTS_SPREAD_MAX);
          if (Math.abs(r.dx) >= PTS_SPREAD_MAX) break;
        }
        let q = placed[pn];
        if (!q) { q = { cx: 0, hw: 0, y0: 0, y1: 0 }; placed[pn] = q; }
        q.cx = r.cx + r.dx; q.hw = r.hw; q.y0 = r.cy + r.dy; q.y1 = r.cy + r.dy + r.h; pn++;
      }
      // 落位：把屏幕偏移换算回世界（沿相机上 / 右方向），再转成精灵父级的局部坐标
      for (let i = 0; i < rec.length; i++) {
        const r = rec[i];
        const dx = (Math.abs(r.ddx) > 1e-6)
          ? clamp(r.cx + r.dx, -aspect + r.hw + PTS_EDGE_PAD, aspect - r.hw - PTS_EDGE_PAD) - r.cx : 0;
        const dy = (Math.abs(r.ddy) > 1e-6) ? r.dy / r.ddy : 0;
        _plA.copy(r.world);
        if (Math.abs(dx) > 1e-6) _plA.addScaledVector(_plR, dx / r.ddx);
        if (Math.abs(dy) > 1e-6) _plA.addScaledVector(_plU, dy);
        _plM.copy(r.sp.parent.matrixWorld).invert();
        r.sp.position.copy(_plA).applyMatrix4(_plM);
        r.sp.material.depthTest = false;                    // 每帧重申：不被任何地理要素遮挡
        r.sp.renderOrder = PTS_LABEL_RO;
        r.sp.visible = true;                                // 能进入 rec 的都是门控打开且正面朝向的标签
      }
    }
  }

  // 绑定（样式变化 → applyAll → syncPoints 按签名增量重建）
  // v26.1（需求⑦）：进入 / 退出「添加点」选点模式 → 顶部提示条同步
  bindSwitch('cbAddMode', 'points.mode', function () { updatePickTip(); });
  bindSwitch('cbPtsSnap', 'points.snap');
  bindSwitch('cbPtsShow', 'points.show');
  bindRange('rngPtSize', 'style.pt.ptLabel.size', w100, 'outPtSize', function (v) { return v.toFixed(2) + '×'; }, syncStyleUI);
  bindColor('clrPtColor', 'style.pt.ptLabel.color', 'hexPtColor', syncStyleUI);
  $('btnPtsClear').addEventListener('click', function () {
    state.points.items.length = 0; syncPoints(); renderPtList();
  });
  document.getElementById('ptList').addEventListener('click', function (e) {
    const b = e.target.closest('.pt-del'); if (b) removePoint(+b.dataset.i);
  });

  // 设置监听点：更新经纬度记录、在主/公转两个地球上都放置标记，并刷新数据卡
  function setMonitor(lat, lon, atScreen) {
    clickState = { lat: lat, lon: lon };
    clickMarker.position.copy(markerLocal(lat, lon)).normalize(); clickMarker.visible = true;
    clickMarkerOrb.position.copy(markerLocal(lat, lon)).normalize(); clickMarkerOrb.visible = true;
    if (atScreen) geoInfo.classList.add('on');
    // 先填内容 / 让曲线按真实宽度绘制（此时面板已显示、有 clientWidth），
    // 再用"已撑开的真实高度"选址 —— 否则量到的是空面板的高度，选址会算错。
    renderGeoInfo();
    if (atScreen) {
      placeGeoInfo();   // 默认位置：时间面板左侧（仅在用户尚未拖动过时定位）
      relayout();       // 面板占位变了 → 窗格重新避让 / 高度上限重算
    }
  }
  const geoInfo = $('geoInfo');
  // 点击查询状态：记录被点击的经纬度，数据面板随模拟时间实时刷新
  let clickState = null;
  /* ======== 观测点数据面板（v2.9 ②）：结构化行 DOM 只建一次，每帧仅刷新文本 ======== */
  const PANEL_ROWS = [
    ['pos', '位置'], ['lst', '地方时'], ['term', '节气'], ['daylen', '当日昼长'], ['tz', '时区'],
    ['sr', '日出 / 日落'], ['sraz', '日出日落方位'], ['noon', '正午太阳高度'],
    ['sub', '太阳直射点'], ['year', '全年昼长'],
    /* v28（需求④）：该点随地球自转的线速度 / 角速度 ——
       线速度 v = Ω·R_eq·cos φ（随纬度余弦衰减，赤道最大 465.1 m/s，两极 0）；
       角速度与纬度无关，恒为 15.0411 °/h（= 2π / 恒星日），即教材所说的「处处 15°/小时」。 */
    ['spinV', '自转线速度'], ['spinW', '自转角速度'],
    ['curve', ''],
  ];
  const panelRows = {}, panelVals = {};
  let panelBig = null, panelCap = null, giBody = null;
  (function buildPanel() {
    // 标题行：与时间面板同款（标题 + 摘要 + 折叠按钮）
    const head = document.createElement('div');
    head.className = 'card-head gi-head';
    const t = document.createElement('h2');
    t.innerHTML = '<i class="hd-ico">📍</i>观测点数据'; head.appendChild(t);
    const mini = document.createElement('output'); mini.className = 'dim'; mini.id = 'giMini'; mini.textContent = '—'; head.appendChild(mini);
    const btn = document.createElement('button'); btn.className = 'link'; btn.id = 'btnGiCollapse'; btn.textContent = '折叠'; head.appendChild(btn);
    geoInfo.appendChild(head);
    // 面板主体（可折叠）
    giBody = document.createElement('div'); giBody.className = 'gi-body';
    geoInfo.appendChild(giBody);
    PANEL_ROWS.forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'pi pi-' + r[0] + (r[0] === 'daylen' ? ' hero' : '');
      if (r[1]) { const k = document.createElement('span'); k.className = 'pi-k'; k.textContent = r[1]; row.appendChild(k); }
      if (r[0] === 'daylen') {
        panelBig = document.createElement('span'); panelBig.className = 'pi-big';
        panelCap = document.createElement('span'); panelCap.className = 'pi-cap';
        row.appendChild(panelBig); row.appendChild(panelCap);
      } else if (r[0] === 'curve') {
        const cv = document.createElement('canvas');
        cv.id = 'cvYearCurve';   // 尺寸由 drawYearCurve 按实际显示尺寸 × DPR 自适应设定
        row.appendChild(cv);
      } else {
        const v = document.createElement('span'); v.className = 'pi-v';
        row.appendChild(v); panelVals[r[0]] = v;
      }
      giBody.appendChild(row);
      panelRows[r[0]] = row;
    });
  })();
  // 面板行显隐（applyAll 调用；设置面板「数据面板内容」开关切换后立即生效）
  function applyPanelRows() {
    PANEL_ROWS.forEach(function (r) {
      panelRows[r[0]].style.display = state.mon.panel[r[0]] ? '' : 'none';
    });
  }
  function fmtClock(h) {
    const t = ((h % 24) + 24) % 24;
    let hh = Math.floor(t), mm = Math.round((t - hh) * 60);
    if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
    return pad2(hh) + ':' + pad2(mm);
  }
  const AZ8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  function azName(a) { return AZ8[Math.round((((a % 360) + 360) % 360) / 45) % 8]; }
  // 某纬度全年逐日昼长（按 纬度+年份 缓存；用于极值行与昼长曲线）
  let yearLenCache = null;
  function yearDayLens(lat, year) {
    const key = lat.toFixed(2) + '|' + year;
    if (yearLenCache && yearLenCache.key === key) return yearLenCache;
    const N = daysInYear(year), start = yearStartUTCms(year);
    const tanL = Math.tan(lat * D), lens = new Array(N);
    let mx = -1, mn = 25;
    for (let i = 0; i < N; i++) {
      const cosH = -tanL * Math.tan(solarInfo(start + (i + 0.5) * 86400000).decl);
      const L = cosH >= 1 ? 0 : cosH <= -1 ? 24 : 24 * Math.acos(cosH) / Math.PI;
      lens[i] = L; if (L > mx) mx = L; if (L < mn) mn = L;
    }
    yearLenCache = { key: key, lens: lens, max: mx, min: mn };
    return yearLenCache;
  }
  // 全年昼长曲线：12h 参考线 + 二分二至竖线 + 今日标记
  // v3.7：画布按「实际显示尺寸 × devicePixelRatio」重建（此前固定 464×156 内部尺寸被 CSS 拉伸，
  // 宽高比不一致 → 文字被纵向压扁）；并在输入未变化时跳过重绘（此前每 80ms 重画一次）。
  let curveKey = '';
  function drawYearCurve(lat, year, doyNow, force) {
    const cv = $('cvYearCurve'); if (!cv) return;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;                                  // 折叠 / 未显示时不绘制
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    const key = lat.toFixed(3) + '|' + year + '|' + Math.round(doyNow) + '|' + pw + 'x' + ph;
    if (!force && key === curveKey) return;                  // 输入与尺寸都没变 → 跳过重绘
    curveKey = key;
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);                    // 之后一律用 CSS 像素坐标绘制
    g.clearRect(0, 0, cw, ch);

    const yl = yearDayLens(lat, year), N = yl.lens.length;
    const padL = 30, padR = 10, padT = 10, padB = 20;
    const iw = cw - padL - padR, ih = ch - padT - padB;
    if (iw < 24 || ih < 20) return;
    const xOf = function (i) { return padL + (i / (N - 1)) * iw; };
    const yOf = function (h) { return padT + (1 - h / 24) * ih; };
    const FONT = '"Segoe UI", "PingFang SC", sans-serif';

    // 纵坐标：0/6/12/18/24 小时刻度线 + 标签（right / middle 对齐）
    g.font = '10px ' + FONT;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    [0, 6, 12, 18, 24].forEach(function (h) {
      const y = Math.round(yOf(h)) + 0.5;
      g.strokeStyle = (h === 12) ? 'rgba(15,23,42,0.22)' : 'rgba(15,23,42,0.09)';
      g.lineWidth = 1; g.setLineDash((h === 12) ? [4, 4] : []);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(cw - padR, y); g.stroke();
      g.fillStyle = 'rgba(30,41,59,0.62)'; g.fillText(h + 'h', padL - 5, y);
    });
    g.setLineDash([]);

    // 二分二至竖线 + 底部标签
    g.textAlign = 'center'; g.textBaseline = 'top';
    [['VE', '春分'], ['SS', '夏至'], ['AE', '秋分'], ['WS', '冬至']].forEach(function (kv) {
      const x = Math.round(xOf(clamp(Math.floor((terms[kv[0]] - yearStartUTCms(year)) / 86400000), 0, N - 1))) + 0.5;
      g.strokeStyle = 'rgba(15,23,42,0.13)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, ch - padB + 1); g.stroke();
      g.fillStyle = 'rgba(30,41,59,0.60)';
      g.fillText(kv[1], clamp(x, padL + 12, cw - padR - 12), ch - padB + 3);
    });

    // 曲线下方渐变填充：让走势更易读，且不遮挡网格
    const grad = g.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, 'rgba(245,158,11,0.26)');
    grad.addColorStop(1, 'rgba(245,158,11,0.02)');
    g.beginPath();
    g.moveTo(xOf(0), yOf(yl.lens[0]));
    for (let i = 1; i < N; i++) g.lineTo(xOf(i), yOf(yl.lens[i]));
    g.lineTo(cw - padR, padT + ih); g.lineTo(padL, padT + ih); g.closePath();
    g.fillStyle = grad; g.fill();

    // 昼长曲线
    g.beginPath();
    for (let i = 0; i < N; i++) { const x = xOf(i), y = yOf(yl.lens[i]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.strokeStyle = '#F59E0B'; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.stroke();

    // 今日竖线 + 定位点（带白色描边，落在曲线上）
    const dNow = clamp(Math.round(doyNow), 0, N - 1), xN = xOf(dNow), yN = yOf(yl.lens[dNow]);
    g.strokeStyle = 'rgba(15,23,42,0.42)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(xN) + 0.5, padT); g.lineTo(Math.round(xN) + 0.5, ch - padB + 1); g.stroke();
    g.fillStyle = '#FF5D5D';
    g.beginPath(); g.arc(xN, yN, 3.6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#FFFFFF'; g.lineWidth = 1.5; g.stroke();
  }
  function renderGeoInfo() {
    if (!clickState) return;
    const info = currentInfo || solarInfo(simMs);
    const decl = info.decl, lat = clickState.lat, lon = clickState.lon;
    const cosH = -Math.tan(lat * D) * Math.tan(decl);
    let dayLen;
    if (cosH >= 1) dayLen = 0; else if (cosH <= -1) dayLen = 24;
    else dayLen = 24 * Math.acos(cosH) / Math.PI;
    const t24 = currentTerm24(info.lam);
    const tp = localParts(t24.ms);
    const alt = monitorSunAlt();                        // 实时太阳高度角（度）
    const dayNow = alt > 0;
    const lamDeg = subsolarLonRad(simMs, info.eot) * R; // 太阳直射点经度（度，东经为正）
    setText(panelVals.pos, fmtLat(lat) + '，' + fmtLon(lon));
    setText($('giMini'), fmtLat(lat) + ' ' + fmtLon(lon));   // 折叠态表头摘要
    // 真太阳时：直射点经线 12:00，向东每 15° +1 小时 —— 与赤道时刻标注同一套几何
    setText(panelVals.lst, fmtClock(12 + (lon - lamDeg) / 15));
    setText(panelVals.term, t24.name + '（' + tp.mo + '月' + tp.day + '日）');
    // 时区：按经度取整到 15° 的倍数为理论时区号，区时 = UTC 时刻 + 时区号
    const zoff = clamp(Math.round(lon / 15), -12, 12);
    setText(panelVals.tz, tzName(zoff) + ' · ' + tzUtc(zoff) + ' · 区时 ' + fmtClock(utcHoursOf(simMs) + zoff));
    setText(panelBig, dayLen >= 24 ? '极昼' : dayLen <= 0 ? '极夜' : fmtHm(dayLen));
    setText(panelCap, '此刻 ' + (dayNow ? '白昼' : '黑夜') + ' · 太阳高度 '
      + (alt < 0 ? '−' : '') + Math.abs(alt).toFixed(1) + '°');
    if (dayLen >= 24 || dayLen <= 0) {
      setText(panelVals.sr, dayLen >= 24 ? '极昼 · 无日出日落' : '极夜 · 无日出日落');
      setText(panelVals.sraz, '—');
    } else {
      const rise = 12 - dayLen / 2, set = 12 + dayLen / 2;
      const cs = Math.cos(lat * D);
      const A = 90 - Math.asin(clamp(cs > 1e-6 ? Math.sin(decl) / cs : 0, -1, 1)) * R; // 日出方位（自北顺时针）
      setText(panelVals.sr, '日出 ' + fmtClock(rise) + ' ' + azName(A)
        + ' · 日落 ' + fmtClock(set) + ' ' + azName(360 - A));
      setText(panelVals.sraz, A.toFixed(1) + '° / ' + (360 - A).toFixed(1) + '°（自北顺时针）');
    }
    setText(panelVals.noon, (90 - Math.abs(lat - decl * R)).toFixed(1) + '°');
    setText(panelVals.sub, fmtLat(decl * R) + '，' + fmtLon(lamDeg));
    /* v28（需求④）：所选监测点的自转线速度 / 角速度。
       线速度 = Ω·R_eq·cos φ（真实物理：赤道 465.1 m/s，60° 纬度减半，极点 0）；
       角速度 = 2π / 恒星日 = 15.0411 °/h，与纬度无关 —— 正因如此「线速度随纬度变、角速度不变」。 */
    setText(panelVals.spinV, (spinSpeedMS(lat)).toFixed(1) + ' m/s（' + (spinSpeedMS(lat) * 3.6).toFixed(0) + ' km/h）');
    setText(panelVals.spinW, spinOmegaDegHour().toFixed(4) + ' °/h · 7.2921×10⁻⁵ rad/s');
    const yl = yearDayLens(lat, displayYear);
    setText(panelVals.year, '最长 ' + fmtHmTight(yl.max) + ' · 最短 ' + fmtHmTight(yl.min));
    if (state.mon.panel.curve) drawYearCurve(lat, displayYear, localParts(simMs).doy);
  }
  // 观测点数据面板：默认位于时间面板左侧；与时间/设置面板共用同一套拖动逻辑（可自由拖动）
  // 三窗视图已铺满全屏，观测点面板与显示设置 / 时间一样作为悬浮层压在窗格上方：
  // 默认停显示设置面板下方（左侧），放不下才退回右侧（时间面板左侧）。
  function railView() {
    return state.view === 'rotate' && state.mode === 'triple';
  }
  // 综合视图里所有窗格"标题文字"的横向区间（用于让浮窗自动避开，避免压住标题）
  function panelTitleBands() {
    const out = [];
    if (state.view !== 'combo') return out;
    document.querySelectorAll('#comboUI .ccell-h').forEach(function (h) {
      const sp = h.querySelector('span') || h;
      const b = sp.getBoundingClientRect();
      if (b.width >= 4 && b.height >= 4) out.push({ l: b.left, r: b.right, t: b.top, b2: b.bottom });
    });
    return out;
  }
  function placeGeoInfo() {
    if (geoInfo.dataset.dragInit) return;     // 用户已拖动过 → 保持其位置
    const ui = uiScale(), gap = Math.round(10 * ui);
    const W = window.innerWidth, H = window.innerHeight;
    const oc = $('optsCard').getBoundingClientRect();
    const tc = $('timeCard').getBoundingClientRect();
    const w = geoInfo.offsetWidth || 320;
    const hh = Math.max(geoInfo.offsetHeight || 260, geoInfo.scrollHeight || 0);
    const maxL = Math.max(8, W - w - 8), maxT = Math.max(TITLE_H + 8, H - hh - 8);
    let left, top;
    // 三窗视图（已铺满全屏）/ 综合视图：观测点面板优先停显示设置面板下方（左侧悬浮），
    // 放不下才退回右侧（时间面板左侧）。
    if (railView() && oc.bottom + gap + hh <= H - 8) {
      left = oc.left; top = oc.bottom + gap;
    } else if (railView() && oc.right + gap + w <= W * 0.52) {
      left = oc.right + gap; top = oc.top;
    } else {
      // 标准停靠：时间面板左侧。综合视图铺满全窗后，窗格标题必然落在浮窗下方，
      // 于是先在若干"候选横向位置"里挑一个既不压住标题文字、也不压住其它浮窗的位置；
      // 实在避不开才退回首选位置（此时由 syncPanelCap 截高度、面板内部滚动）。
      top = tc.top;
      const pref = tc.left - Math.round(12 * ui) - w;
      const bands = panelTitleBands().filter(function (b) {
        return (top + hh > b.t) && (top < b.b2);               // 只考虑纵向会冲突的标题文字
      });
      // 禁区 = 冲突标题文字 + 另外两块浮窗（面板之间不该互相叠住）
      const forbid = bands.slice();
      if (tc.width > 4) forbid.push({ l: tc.left, r: tc.right, t: tc.top, b2: tc.bottom });
      if (oc.width > 4) forbid.push({ l: oc.left, r: oc.right, t: oc.top, b2: oc.bottom });
      const hit = function (x) {
        for (let i = 0; i < forbid.length; i++) {
          const b = forbid[i];
          if (!(top + hh > b.t && top < b.b2)) continue;
          if (x < b.r + 2 && x + w > b.l - 2) return true;
        }
        return false;
      };
      if (!hit(pref)) {
        left = pref;
      } else {
        // 候选：最左端 + 每条冲突标题文字的左侧 / 右侧，取离首选位置最近且无冲突者
        const cands = [8];
        bands.forEach(function (b) { cands.push(b.l - gap - w); cands.push(b.r + gap); });
        let best = null;
        cands.forEach(function (x) {
          if (x < 8 || x > maxL || hit(x)) return;
          if (best === null || Math.abs(x - pref) < Math.abs(best - pref)) best = x;
        });
        left = (best === null) ? pref : best;
      }
    }
    geoInfo.style.left = clamp(left, 8, maxL) + 'px';
    geoInfo.style.top = clamp(top, TITLE_H + 8, maxT) + 'px';
    geoInfo.style.right = 'auto'; geoInfo.style.bottom = 'auto';
  }
  makeDraggable(geoInfo);       // 与其它浮窗一致的拖动（标题栏抓取，按钮等交互元素不触发拖动）
  $('btnGiCollapse').addEventListener('click', function () {
    /* ★ v44（需求 2）：折叠时清掉拉伸留下的 inline height，整体收成胶囊（只留标题行） */
    const min = !geoInfo.classList.contains('gi-min');
    if (min) {
      if (geoInfo.style.height) { geoInfo.dataset.preH = geoInfo.style.height; geoInfo.style.height = ''; }
    } else if (geoInfo.dataset.preH) { geoInfo.style.height = geoInfo.dataset.preH; delete geoInfo.dataset.preH; }
    geoInfo.classList.toggle('gi-min', min);
    this.textContent = min ? '展开' : '折叠';
    relayout();                       // 折叠后宽度变化 → 让窗格重新避让
  });
  window.addEventListener('resize', function () {
    if (geoInfo.classList.contains('on')) { placeGeoInfo(); syncPanelCap(); }
  });
  let downPt = null;
  /* ---- 命中上下文：判定指针落在哪个窗口、用哪台相机、是不是公转场景 ----
     由「点击查询」与「时区面 hover / click」共用，保证两套拾取完全一致的判定。 */
  function hitCtx(e) {
    let r = null, useOrb = false;
    if (state.view === 'combo') {
      const p = comboPaneAt(e.clientX, e.clientY);
      if (p === 'main') { const m = cmbLayout.main; r = { x: m.x, y: m.y + COMBO_HEAD_H, w: m.w, h: m.h - COMBO_HEAD_H }; }
      else if (p === 'orbit') { const m = cmbLayout.orbit; r = { x: m.x, y: m.y + COMBO_HEAD_H, w: m.w, h: m.h - COMBO_HEAD_H }; useOrb = true; }
    } else if (state.view === 'revolve') {
      r = orbitViewRect(); useOrb = true;
    } else if (state.view === 'rotate' && layout.main && inRect(e.clientX, e.clientY, layout.main)) r = layout.main;
    if (!r) return null;
    return { r: r, orb: useOrb, cam: useOrb ? orbitCam : camera };
  }
  // 屏幕坐标 → 该窗口内的归一化设备坐标
  function ndcOf(e, r) {
    const h = window.innerHeight;
    return { x: ((e.clientX - r.x) / r.w) * 2 - 1, y: (((h - e.clientY) - (h - (r.y + r.h))) / r.h) * 2 - 1 };
  }
  canvas.addEventListener('pointerdown', function (e) { downPt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', function (e) {
    if (!downPt) return;
    const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
    const quick = performance.now() - downPt.t < 400;
    downPt = null;
    if (moved > 6 || !quick) return;            // 拖动旋转，忽略
    // 判定点击落在哪个窗口，并选择对应相机 / 地球
    const ctx0 = hitCtx(e); if (!ctx0) return;
    const r = ctx0.r, useOrb = ctx0.orb;
    const ndc = ndcOf(e, r);
    raycaster.setFromCamera(ndc, useOrb ? orbitCam : camera);
    const hit = raycaster.intersectObject(useOrb ? earthOrb : earth, false)[0];
    if (!hit) { geoInfo.classList.remove('on'); clickMarker.visible = false; clickState = null; return; }
    const spinRef = useOrb ? spinOrb : spin;
    const local = spinRef.worldToLocal(hit.point.clone());
    const lat = Math.asin(clamp(local.y, -1, 1)) * R;
    // 球面 UV 约定：地理经度 = −局部方位角（与贴图一致，不含自转相位）
    const lon = wrap180(-Math.atan2(local.z, local.x) * R);
    // v25.1（需求⑧）：球面最短距离处于「点击拾取」状态时，点击即取点（优先级高于添加标注点）
    if (state.gcd.on && state.gcd.mode === 'click') { gcdPick(lat, lon); return; }
    if (state.points.mode) { addPointAt(lat, lon); return; }   // 添加点模式：点击即加标注点
    if (state.markText.on) {                                    // v27.0（需求一）：文本标记模式
      const mi = pickMarkTextAt(e, ctx0);
      if (mi) { openMtEditor(mi, { x: e.clientX, y: e.clientY }); return; }   // 命中文本框 → 编辑
      return;                                                   // 空白处点击：不创建、不查询
    }
    setMonitor(lat, lon, { x: e.clientX + 12, y: e.clientY + 12 });
    document.querySelectorAll('[data-mon]').forEach(function (x) { x.classList.remove('on'); });
  });
  function fmtHm(hours) {
    let hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
    if (mm === 60) { mm = 0; hh += 1; }
    return hh + ' 时 ' + (mm < 10 ? '0' : '') + mm + ' 分';
  }
  // 紧凑时刻（无空格）：面板密集行（全年昼长等）专用，避免换行
  function fmtHmTight(hours) {
    let hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
    if (mm === 60) { mm = 0; hh += 1; }
    return hh + '时' + (mm < 10 ? '0' : '') + mm + '分';
  }

  /* ============ 启动 ============ */
  // v14.0 菜单层级（对齐《面板菜单框架》）：
  //  面板整体默认展开；一级菜单默认展开，点击可各自独立收起 / 展开，互不干扰；
  //  二级菜单点击 → 对应的内容窗口在面板右侧弹出（全局互斥：同一时间仅一个内容窗口）；
  //  三级标题点击 → 控制项在其下方向下展开（不互斥：可同时展开多项，逐项独立开合）。
  //  内容窗口中「点 / 线 / 面 / 文字注释」的样式设置项默认折叠，显示开关始终直接可见。
  // （v16.0 起）二级内容窗口不再随鼠标移出自动隐藏 —— 旧版「鼠标移出菜单范围 450ms 后
  //  自动收起」的行为已移除，改为右上角 × 按钮 / Esc / 收起面板时统一清空。
    /* v15.0：把 MENU 里新增的控件（带 path 且未被显式绑定）统一接上状态 */
  /* ★ 本次修复（缺陷 A）：绑定前再幂等补齐一次分类 —— 确保 note.cats.markText 一定存在，
     菜单叶子控件 ncMarkTextOn（path = note.cats.markText.on）的通用绑定器在
     getPath(state, 'note.cats.markText.on') 时才不会落到 undefined 上取 .on 而抛错
     （否则被 catch 吞成 console.warn '[menu] 绑定失败'）。 */
  ensureNoteCats();
  if (window.MENU) bindMenuTree(window.MENU);
  /* ★ v36（需求五）：从菜单树自动推导级联规则（标题前开关 → 浮层内全部下级），
     追加到手写规则之后（去重）。 */
  if (window.MENU) buildCascadeRules(window.MENU, CASCADE_RULES);
  /* ★ v36 修正：启动时**不跑**级联归一化循环（v36 初版在此无条件 forEach 一遍，实测是回归
     —— DEF 里大量组开关默认关闭（zones.on / traj.term4 / volShaft.on …）而其子级默认开，
     这是「待命」语义：组开关一打开，子级全部就绪。启动归一化会把它们当成「父关子开矛盾态」
     全部强制关掉，用户打开组开关后看到的是一排全灰的子开关。
     级联只在**运行期**用户切换开关时生效（bindSwitch change → applyCascadeRules）；
     旧存档遗留的矛盾态保留，由 gate 置灰 + 运行期级联自然收敛。 */

  /* ===== v27.0（需求三.1）：二级菜单标题前开关与窗口顶部开关共存 → 取消窗口顶部总开关 =====
     v26.1（需求⑫）曾把同一个总开关做成两处入口：弹窗标题行一个（id = node.sw，主）+
     左侧菜单标题前一个（id = node.sw + '__m'，镜像），由这里的 bindMirrorSwitches 双向同步。
     v27.0 起**只保留菜单标题前那个**：menu.js 里它直接以 id = node.sw 渲染（成为主开关，
     走 bindSwitch / bindMenuTree 的通用绑定链），弹窗顶部不再画开关 ——
     本同步函数与 __m 镜像一并删除。 */

  (function () {
    const card = $('optsCard');
    function closeAll() {
      // 只收起右侧二级内容窗口；一级菜单的展开状态由用户自己决定，不再被自动收起
      card.querySelectorAll('.opt-fly.on').forEach(function (f) { f.classList.remove('on'); });
      card.querySelectorAll('.lv2-row.on').forEach(function (r) { r.classList.remove('on'); });
    }
    window.closeOptFly = closeAll;
    /* v25.1（需求⑥）：常驻窗口 —— 「标记点」与「小人模型」两个二级窗口可与其它窗口长期共存
       （小人模型必须常驻：从面板里拖小人到地球的过程中，面板一旦被自动收起就没法拖了）。
       v26.1（需求②）：再并入「观测点定位」与「球面最短距离」—— 这两个窗口同样需要
       一边看着地球一边操作（选点 / 读数），被别的窗口顶掉就没法用了。
       常驻窗口一律可自由拖动、彼此可以同屏共存。 */
    const PIN_FLYS = ['pPtsAdd', 'pFigure', 'pMonLoc', 'pGCD', 'pMarkText'];
    function isPinnedFly(f) { return !!f && PIN_FLYS.indexOf(f.id) >= 0; }
    function isPinnedRow(r) { return !!r && PIN_FLYS.indexOf(r.dataset.fly) >= 0; }
    // 一级：展开 / 收起下方的二级菜单（各一级之间互不干扰）
    //   v18.0：切换一级菜单时只收起「非常驻」的窗口 —— 常驻窗口可与其它窗口长期共存。
    /* ★ 本次：一级菜单的展开 / 收起逻辑抽成单一函数 toggleLv1Menu()，点击与键盘激活共用。
       menu.js 已将一级菜单项由 <button class="opt-row lv1"> 改为
       <div class="opt-row lv1" role="button" tabindex="0" aria-expanded="false">，
       div 不象 button 那样在 Enter/Space 时自动触发 click，故需在此补齐键盘激活。 */
    function toggleLv1Menu(btn, e) {
      /* ★ 本次：一级菜单标题前的开关（sec.sw）—— 点它只切开关，不展开 / 收起二级菜单。
         与二级处理器（.lv2-row > .sw）同法在处理器最前面拦截，避免点击冒泡到一级行。 */
      if (e && e.target && e.target.closest && e.target.closest('.opt-row > .sw')) return;
      const sec = btn.parentElement;
      const was = sec.classList.contains('open');
      card.querySelectorAll('.opt-fly.on').forEach(function (f) { if (!isPinnedFly(f)) f.classList.remove('on'); });
      card.querySelectorAll('.lv2-row.on').forEach(function (r) { if (!isPinnedRow(r)) r.classList.remove('on'); });
      sec.classList.toggle('open', !was);
      btn.classList.toggle('on', !was);
      syncLv1Expanded();
    }
    /* ★ 本次可访问性：把每个一级菜单项的 aria-expanded 同步为其所在 .opt-sec 的展开态。
       逐个按其自身状态写 —— 展开的为 true，收起（含被其它操作收起）的为 false。 */
    function syncLv1Expanded() {
      card.querySelectorAll('.opt-sec > .lv1[role="button"]').forEach(function (b) {
        const s = b.parentElement;
        b.setAttribute('aria-expanded', String(!!s && s.classList.contains('open')));
      });
    }
    card.querySelectorAll('.opt-sec > .lv1').forEach(function (btn) {
      btn.addEventListener('click', function (e) { toggleLv1Menu(btn, e); });
    });
    /* ★ 本次可访问性：一级菜单键盘激活（事件委托到 #optsCard）—— Enter / 空格 触发与点击
       完全相同的展开 / 收起逻辑（复用 toggleLv1Menu）。仅命中 .opt-row.lv1[role="button"]；
       焦点落在标题内嵌开关上时不拦截，交给开关自身处理。
       与既有 .nd-h 的 keydown 委托互不干扰（后者要求 target 恰为 .nd-h[role="button"]）。 */
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = e.target;
      if (!t || !t.closest) return;
      const lv1 = t.closest('.opt-row.lv1[role="button"]');
      if (!lv1 || !card.contains(lv1)) return;
      if (t.closest('.opt-row > .sw')) return;     // 焦点在标题里的开关：不触发折叠
      e.preventDefault();
      toggleLv1Menu(lv1, null);
    });
    // 二级：打开右侧三级浮层
    //   v18.0：「添加点」窗口可与其它二级窗口共存（并且可以拖动摆放）；
    //          其余二级窗口之间仍然全局互斥 —— 打开时只关掉「非常驻」的窗口。
    card.querySelectorAll('.lv2-row').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        /* v26.1（需求⑫）：二级菜单标题前的开关 —— 点它只切开关，不展开 / 收起弹窗。
           开关是 <label> 嵌在 <button> 里，点击会冒泡到这一层，必须在这里拦掉。 */
        if (e && e.target && e.target.closest && e.target.closest('.lv2-row > .sw')) return;
        const fly = $(btn.dataset.fly);
        if (!fly) return;
        const was = fly.classList.contains('on');
        if (!isPinnedFly(fly)) {
          card.querySelectorAll('.opt-fly.on').forEach(function (f) { if (f !== fly && !isPinnedFly(f)) f.classList.remove('on'); });
          card.querySelectorAll('.lv2-row.on').forEach(function (r) { if (r !== btn && !isPinnedRow(r)) r.classList.remove('on'); });
        }
        if (was) { fly.classList.remove('on'); btn.classList.remove('on'); return; }
        fly.classList.add('on'); btn.classList.add('on');
        fly.dispatchEvent(new CustomEvent('flyopen', { bubbles: true }));   // ★ v35：浮层打开通知（面板开关页刷新用）
        /* ★ v36：CustomEvent 默认不冒泡，而监听在 document 冒泡阶段 ⇒ 此前 flyopen 永远
           传不到监听，「面板与悬浮窗」容器一直是空的。加 bubbles: true 修复。 */
        // 菜单被拖到右半屏 → 浮层向左展开（已被手动摆放过的窗口保持原位不改向）
        if (!fly.classList.contains('fly-moved')) {
          const r = card.getBoundingClientRect();
          card.classList.toggle('fly-left', r.left + r.width / 2 > window.innerWidth / 2);
        }
      });
    });
    /* ---- 三级手风琴（事件委托）----
       v20.0：原先这里还有一段针对旧版 .lv3-h / .sub-grp > .sub-title 的折叠分支 ——
       那两个类名随 v16.0「统一样式」面板一起被移除，菜单里再没有任何节点带它们，
       该分支永远不会命中，属死代码，已删除。三级及更深的分组统一走下面的 .nd 分支。 */
    card.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.nd-h .sw')) return;                 // 点分组标题里的开关：只切开关，不折叠
      // v15.0：三级及更深的分组（.nd）—— 只有存在子级的节点才会渲染出 .nd-h + 箭头
      const nh = t.closest('.nd-h');
      if (nh && card.contains(nh)) toggleNdGroup(nh, t);
    });
    /* ★ 本次可访问性：三级分组标题（.nd-h，menu.js 已写 role="button" / tabindex="0"）——
       · 折叠切换后同步 aria-expanded；
       · 新增 keydown 委托：Enter / 空格 触发与点击相同的折叠切换（复用同一函数，不重复绑定）。 */
    function toggleNdGroup(nh, t) {
      if (t && t.closest && t.closest('select, input, button')) return;   // 标题行内嵌控件（如「类型」下拉）不触发折叠
      const g2 = nh.parentElement;
      if (!g2 || !g2.classList.contains('nd')) return;
      g2.classList.toggle('open');
      nh.setAttribute('aria-expanded', String(g2.classList.contains('open')));
    }
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = e.target;
      if (!t || !t.closest || t !== t.closest('.nd-h[role="button"]')) return;   // 仅标题本身（内嵌控件冒泡不算）
      const nh = t;
      if (!card.contains(nh)) return;
      e.preventDefault();
      toggleNdGroup(nh, null);
    });
    /* v15.0：分组标题里的 ☑️ 开关 —— 关闭时子级整体收起并置灰（未勾选 -> 不纳入菜单） */
    function syncNdOff() {
      document.querySelectorAll('#optsCard .nd > .nd-h input[type=checkbox]').forEach(function (cb) {
        const g = cb.closest('.nd');
        if (g) g.classList.toggle('off', !cb.checked);
      });
    }
    /* ===== v21.0（需求②③）：注释开关的「三级层级」在界面上的落实 =====
       层级：全局文字注释总开关 → 地理事物开关 → 该注释分类 / 单项开关。
       被上级压住的开关置灰（并用 title 说明「需先开启 …」），一眼就能看出先后顺序；
       但不会「点了没反应」——点击时会自动把缺的上级开关一并打开（顺序始终是上级先、本级后）。 */
    function gatePaths(el) {
      const n = el && el.closest ? el.closest('[data-gate]') : null;
      return (n && n.dataset.gate ? n.dataset.gate : '')
        .split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    function gateOff(paths) {
      return paths.some(function (p2) { const v = getPath(state, p2); return v !== true; });
    }
    function syncMenuGates() {
      document.querySelectorAll('#optsCard [data-gate]').forEach(function (el) {
        const paths = gatePaths(el);
        const off = gateOff(paths);
        el.classList.toggle('gated', off);
        if (off) el.title = '需先开启：' + paths.join(' + ');
        else if (el.getAttribute('title') && el.getAttribute('title').indexOf('需先开启') === 0) el.removeAttribute('title');
      });
    }
    binders.push(syncMenuGates);
    syncMenuGates();
    card.addEventListener('change', function (e) {
      const cb = e.target;
      if (!cb || cb.type !== 'checkbox' || !cb.closest) return;
      // 置灰状态下点选：先把缺的上级开关打开，再让本次勾选生效（保证「上级先、本级后」）
      const gp = gatePaths(cb);
      if (cb.checked && gateOff(gp)) {
        gp.forEach(function (p2) { if (getPath(state, p2) !== true) setPath(state, p2, true); });
        binders.forEach(function (f) { f(); });
        applyAll(); persist();
      }
      const g = cb.closest('.nd');
      if (g && cb.closest('.nd-h')) g.classList.toggle('off', !cb.checked);
      syncMenuGates();
    });
    binders.push(syncNdOff);
    syncNdOff();            // 启动时按各开关的当前值收起对应的子级
    // v16.0：二级内容窗口不再随鼠标移出自动隐藏；提供右上角 × 按钮和 Esc 手动隐藏
    card.querySelectorAll('.fly-close').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const fly = btn.closest('.opt-fly'); if (!fly) return;
        const row = card.querySelector('.lv2-row[data-fly="' + fly.id + '"]');
        fly.classList.remove('on'); if (row) row.classList.remove('on');
      });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

    /* v18.0：「添加点」窗口可自由拖动 —— 按住标题栏拖到任意位置摆放，
       便于与「点样式 / 标注列表」等窗口并排查看。其余窗口位置固定，避免误拖后找不到。
       v26.1（需求②）：推广到 **所有常驻窗口**（PIN_FLYS）—— 观测点定位 / 标记点 /
       小人模型 / 球面最短距离 四个窗口都能各自拖动、同屏共存。
       注意：.card 上的 backdrop-filter 会让 position:fixed 也相对它定位，
       所以这里统一用 offsetLeft / offsetTop（相对定位原点 #optsCard）计算，
       不改成 fixed，也不做 viewport 与卡片坐标系的来回换算。 */
    PIN_FLYS.forEach(function (fid) {
      const pin = $(fid);
      if (!pin) return;
      const head = pin.querySelector('.fly-head');
      if (!head) return;
      pin.classList.add('fly-drag');
      let dragging = false, px = 0, py = 0, ox = 0, oy = 0, orgX = 0, orgY = 0;
      function pickOrigin() {                                       // 定位原点相对视口的偏移 = 视口矩形 - 定位偏移
        const r = pin.getBoundingClientRect();
        orgX = r.left - pin.offsetLeft; orgY = r.top - pin.offsetTop;
      }
      function place(left, top) {
        const w = pin.offsetWidth, h = pin.offsetHeight;
        const minX = 4 - orgX, maxX = window.innerWidth - 4 - orgX - w;
        const minY = 4 - orgY, maxY = window.innerHeight - 4 - orgY - h;
        pin.style.left = Math.min(Math.max(minX, left), Math.max(minX, maxX)) + 'px';
        pin.style.top = Math.min(Math.max(minY, top), Math.max(minY, maxY)) + 'px';
      }
      head.addEventListener('pointerdown', function (e) {
        if (e.button) return;                                       // 仅左键 / 触摸
        if (e.target.closest && (e.target.closest('.fly-close') || e.target.closest('.sw'))) return;
        pickOrigin();
        pin.classList.add('fly-moved');                             // 已手动摆放：不再受 fly-left 改向影响
        pin.style.right = 'auto'; pin.style.bottom = 'auto';
        ox = pin.offsetLeft; oy = pin.offsetTop;
        dragging = true; px = e.clientX; py = e.clientY;
        pin.classList.add('dragging');
        if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (err) {} }
        e.preventDefault();
      });
      head.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        place(ox + (e.clientX - px), oy + (e.clientY - py));
      });
      function stopDrag() { if (!dragging) return; dragging = false; pin.classList.remove('dragging'); }
      head.addEventListener('pointerup', stopDrag);
      head.addEventListener('pointercancel', stopDrag);
      head.addEventListener('lostpointercapture', stopDrag);
      // 窗口尺寸变化后把已摆放的窗口重新夹回可视区域
      window.addEventListener('resize', function () {
        if (!pin.classList.contains('fly-moved')) return;
        pickOrigin(); place(pin.offsetLeft, pin.offsetTop);
      });
    });
  })();
  applyPanelFont();
  applyUiTheme();      // v31（需求十七）：UI 色系 / 毛玻璃（必须在首帧前写入主题变量）
  applySunTex();       // v31（需求九）：按复原后的 state.sun.tex 应用太阳真实贴图


  applyAll();
  buildTermChips();
  buildTicks();
  setModeButtons();
  setFrameButtons();
  setViewButtons();
  setOrbCamButtons();
  resize();
  updateScene();
  updateUI(true);

  // 调试/分享参数：#view=term 昼夜半球视角；#pause 暂停；
  // #date=6-21&hour=12:00 指定本演示年内的时刻；#date=2028-6-21 直接跳到指定年份
  // #hourmark=main|rest|all 赤道时刻标注；#panel=all 数据面板全部行；#mon=纬度,经度 监听点
  (function () {
    const hsh = (location.hash || '').toLowerCase();
    const mdY = hsh.match(/date=(\d{4})-(\d{1,2})-(\d{1,2})/);      // date=2028-6-21
    const md = mdY || hsh.match(/date=(\d{1,2})-(\d{1,2})/);        // date=6-21
    const mh = hsh.match(/hour=(\d{1,2}):(\d{1,2})/);
    if (md) {
      const y = mdY ? parseInt(mdY[1], 10) : displayYear;
      const mo = parseInt(mdY ? mdY[2] : md[1], 10);
      const dy = parseInt(mdY ? mdY[3] : md[2], 10);
      const doy = Math.floor((Date.UTC(y, mo - 1, dy) - Date.UTC(y, 0, 1)) / 86400000) + 1;
      const p0 = localParts(simMs);
      simMs = msFromLocal(y, clamp(doy, 1, daysInYear(y)),
        mh ? parseInt(mh[1], 10) * 60 + parseInt(mh[2], 10) : p0.minutes);
      syncYear(true);                                              // 指定了年份 → 二分二至卡片与时间轴一并切换
      simMs = clampToYear(simMs);
    } else if (mh) {
      const p0 = localParts(simMs);
      simMs = msFromLocal(displayYear, p0.doy, parseInt(mh[1], 10) * 60 + parseInt(mh[2], 10));
      simMs = clampToYear(simMs);
    }
    let viewChanged = false;
    if (hsh.indexOf('view=equator') >= 0) applyView(VIEW_EQUATOR);
    if (hsh.indexOf('mode=single') >= 0) state.mode = 'single';
    if (hsh.indexOf('mode=triple') >= 0) state.mode = 'triple';
    if (hsh.indexOf('frame=earth') >= 0) { state.lockAxis = true; setFrameButtons(); }
    if (hsh.indexOf('view=revolve') >= 0) { state.view = 'revolve'; setViewButtons(); viewChanged = true; }
    if (hsh.indexOf('view=combo') >= 0) { state.view = 'combo'; setViewButtons(); viewChanged = true; }
    if (hsh.indexOf('pause') >= 0) { state.playing = false; }
    // 公转动画：太阳大小 / 地球大小 / 日地距离比例（#sunscale= / #earthscale= / #distscale=）
    const mSunS = hsh.match(/sunscale=([\d.]+)/);
    if (mSunS) state.orb.sunScale = clamp(parseFloat(mSunS[1]), 0.2, 3);
    const mErS = hsh.match(/earthscale=([\d.]+)/);
    if (mErS) state.orb.earthScale = clamp(parseFloat(mErS[1]), 0.3, 3);
    const mDiS = hsh.match(/distscale=([\d.]+)/);
    if (mDiS) state.orb.distScale = clamp(parseFloat(mDiS[1]), 0.3, 4);
    if (mSunS || mErS || mDiS) { binders.forEach(function (f) { f(); }); applyAll(); }
    // #opts 打开「显示设置」卡片；#openall 展开面板中所有分组（截图 / 投影讲解用）
    if (hsh.indexOf('opts') >= 0) { $('optsCard').classList.remove('collapsed'); $('btnCollapse').textContent = '收起'; }
    if (hsh.indexOf('openall') >= 0) {
      // v4.3：面板改为三级菜单结构，#openall 展开所有一级分区的二级容器与所有三级控制项
      // （截图 / 投影讲解用）；右侧三级浮层同一时间仅显示一个，仍需点击二级菜单打开
      document.querySelectorAll('#optsCard .opt-sec').forEach(function (s) { s.classList.add('open'); });
      document.querySelectorAll('#optsCard .lv3').forEach(function (l) { l.classList.add('open'); });
    }
    // 速度分享参数：#speed=200000（模拟倍率，取值范围 100 ~ 5000000）
    const msp = hsh.match(/speed=([\d.]+)/);
    if (msp) state.speed = clamp(parseFloat(msp[1]), SPEED_MIN, SPEED_MAX);
    // v21.0：分享参数要同时打开「总开关 → 地理事物 → 注释」三级，否则注释依旧不显示
    if (hsh.indexOf('t24') >= 0) {
      state.note.master.on = true; state.orb.terms24.on = true; state.note.cats.terms24.on = true;
      binders.forEach(function (f) { f(); }); applyAll();
    }
    // 赤道时刻标注分享参数：#hourmark=main / rest / all（两组开关，默认隐藏）
    if (hsh.indexOf('hourmark=') >= 0) {
      state.note.master.on = true; state.style.pt.hourMain.on = true; state.style.pt.hourRest.on = true;
      state.note.cats.hourMain.on = true; state.note.cats.hourRest.on = true;
      if (hsh.indexOf('hourmark=main') >= 0 && hsh.indexOf('hourmark=all') < 0) {
        state.style.pt.hourRest.on = false; state.note.cats.hourRest.on = false;
      }
      if (hsh.indexOf('hourmark=rest') >= 0 && hsh.indexOf('hourmark=all') < 0) {
        state.style.pt.hourMain.on = false; state.note.cats.hourMain.on = false;
      }
      binders.forEach(function (f) { f(); }); applyAll();
    }
    // 极光分享参数：#aurora=0 隐藏 / #aurora=1 显示（默认显示）
    const maur = hsh.match(/aurora=(0|1)/);
    if (maur) { state.aurora = maur[1] === '1'; binders.forEach(function (f) { f(); }); applyAll(); }
    // 数据面板行分享参数：#panel=all 显示全部数据行
    if (hsh.indexOf('panel=all') >= 0) {
      Object.keys(state.mon.panel).forEach(function (k) { state.mon.panel[k] = true; });
      binders.forEach(function (f) { f(); }); applyAll();
    }
    // 监听点分享参数：#mon=纬度,经度（例 #mon=39.9,116.4）
    const mmon = hsh.match(/mon=(-?[\d.]+),(-?[\d.]+)/);
    if (mmon) {
      state.mon.circle = true;
      setTimeout(function () {
        // 无点击坐标时把数据卡放到画面左中部（之后可自由拖动）
        setMonitor(parseFloat(mmon[1]), parseFloat(mmon[2]),
          { x: Math.round(window.innerWidth * 0.3), y: TITLE_H + 170 });
      }, 100);
    }
    // 三窗比例：#splitx=0.7&splity=0.35
    const msx = hsh.match(/splitx=([\d.]+)/), msy = hsh.match(/splity=([\d.]+)/);
    if (msx) state.splitX = clamp(parseFloat(msx[1]), 0.22, 0.82);
    if (msy) state.splitY = clamp(parseFloat(msy[1]), 0.18, 0.82);
    if (md || mh || msp || hsh.indexOf('pause') >= 0 || hsh.indexOf('mode=') >= 0 || msx || msy || viewChanged
      || hsh.indexOf('hourmark=') >= 0 || hsh.indexOf('panel=all') >= 0) {
      setModeButtons(); updateSliderUI(); resize(); updateScene(); updateUI(true);
    }
  })();

  requestAnimationFrame(tick);

  // 贴图异步装载
  const T = window.EARTH_TEXTURES || {};
  Promise.all([
    T.day ? loadTex(T.day, true) : Promise.resolve(null),
    T.night ? loadTex(T.night, true) : Promise.resolve(null),
    T.clouds ? loadTex(T.clouds, false) : Promise.resolve(null),
    T.water ? loadTex(T.water, false) : Promise.resolve(null),
    /* v25.1（需求⑤）：海陆 / 大洲掩膜
       · geo-land 是纯掩膜数据（填充 / 距离场），绝不能被当作颜色做 sRGB 转换 → srgb = false；
       · geo-cont 存的是大洲填充色，要与**线性**调色板贴图做「就近匹配」解码，
         故按 sRGB 载入（GPU 取样时自动转线性），两侧色彩空间一致。
       v26.1（需求③）：**优先用内嵌的 Data URI**（assets-geo.js → window.EARTH_GEO）——
         此前这两张图是外链文件，加载失败时这里会静默退回「全黑掩膜」，
         于是菜单里勾了「显示海陆分布 / 显示七大洲」但地球上什么都不出现，且毫无提示。
         现在改为：内嵌数据优先、外链路径兜底；两条路都失败时把失败状态报到面板上。 */
    loadTex(GEO_URI('reg', 'assets/geo-reg.png'), false),
  ]).then(function (r) {
    let day = r[0], night = r[1], cl = r[2], wa = r[3];
    if (!day) day = loadTex(fallbackDay(), true);
    if (!night) night = loadTex(fallbackNight(), true);
    if (!cl) cl = loadTex(fallbackGray(0.02), false);
    if (!wa) wa = loadTex(fallbackGray(0.5), false);
    return Promise.all([day, night, cl, wa, r[4], r[5]]);
  }).then(function (r) {
    earthMat.uniforms.uDay.value = r[0];
    earthMat.uniforms.uNight.value = r[1];
    earthMat.uniforms.uClouds.value = r[2];
    cloudMat.uniforms.uClouds.value = r[2];
    earthMat.uniforms.uWater.value = r[3];
    // 公转场景中的地球使用同一套贴图
    earthMatOrb.uniforms.uDay.value = r[0];
    earthMatOrb.uniforms.uNight.value = r[1];
    earthMatOrb.uniforms.uClouds.value = r[2];
    earthMatOrb.uniforms.uWater.value = r[3];
    cloudMatOrb.uniforms.uClouds.value = r[2];
    /* v25.1（需求⑤）：海陆 / 大洲掩膜
       v26.1（需求③）：缺图时仍用全黑底图兜底（不影响其余功能），但**不再静默** ——
         geoDataState 会同步到「海陆分布 / 七大洲」两个面板顶部的一行状态提示上。
       ★ v53：r[4] 已是上游 Promise.all 解析后的**贴图对象**（不再是 Promise），
         所以只能走 Promise.resolve 归一，不能直接 .then —— 直接调会抛
         「gReg.then is not a function」并让整段掩膜绑定不执行（掩膜永远绑不上）。 */
    Promise.resolve(r[4] || loadTex(fallbackGray(0), false)).then(function (g) {
      /* ★ v56（问题①）修复：掩膜是「编码数据」而非颜色 —— R=大洲索引、G/B=距离场。
         此前沿用 loadTex 的默认过滤（minFilter=LinearMipmapLinearFilter + anisotropy=MAX），
         GPU 会生成 mip 链并把相邻纹素逐级平均：
           · R 被平均 → 洲界 / 海岸带出现介于两洲之间的非法索引 → 填色在洲缘镶出
             「别的洲的颜色带」（视觉上即「七大洲填色时错误画出其他大洲的轮廓描边」）；
           · G/B 被平均 → 距离场低值向外扩散 → 一旦开海岸线 / 洲界开关，线糊成粗带。
         改为最近邻采样 + 关 mipmap + 关各向异性，与调色板 geoPalTex 同策略：
         索引 / 距离场逐纹素精确还原，填色只渲染填充区域。 */
      if (g) {
        g.magFilter = THREE.NearestFilter;
        g.minFilter = THREE.NearestFilter;
        g.generateMipmaps = false;
        g.anisotropy = 1;
        g.needsUpdate = true;
      }
      [geoMatR, geoMatO].forEach(function (m) { m.uniforms.uReg.value = g; });
      geoDataState = r[4] ? 'ok' : 'missing';
      if (g && g.image) geoMaskW = g.image.width;
      applyGeo();                                   // 拿到真实掩膜宽度后重算「度→像素」换算
      syncGeoStat();
    });
    $('loading').classList.add('hide');
    setTimeout(function () { $('loading').style.display = 'none'; }, 500);
    /* ★ v53：贴图与初始布局都就绪后再执行 URL 参数预置（见 applyUrlPreset 处的说明） */
    setTimeout(function () { try { applyUrlPreset(); } catch (e) { console.warn('[url-preset]', e); } }, 0);
  }).catch(function (err) {
    console.error('贴图装载失败', err);
    $('loading').textContent = '贴图装载失败，已启用降级贴图';
  });

  /* v20.0 清理：此处原有「极光调试」用的全局调试钩子 + 每 2.8s 往 body 里塞一个调试 div 的
     临时脚手架（调试极光 shader 时留下的）。它不影响功能，但属于无用代码，已整块删除。 */

  /* v21.0 清理：本轮自动化验证期间曾在本文件末尾临时挂过一个诊断钩子
     （向无头浏览器暴露内部 state / apply / 门控判定 / 统一字号系数 / 精灵表等，供断言读取）。
     验证全部通过后已整块删除 —— 仅保留必要的只读调试/桥接入口，全局只保留必要的业务绑定。 */

  /* v21.1 清理：标定「时区注释密集遮挡」判定阈值期间，曾在本文件末尾临时挂过一个诊断钩子
     （向无头浏览器暴露 state / 相机距离 / 逐条时区标注的 NDC 位置与墨迹宽度，供阈值标定脚本读取）。
     阈值定稿后已整块删除 —— 仅保留必要的只读调试/桥接入口，全局只保留必要的业务绑定。 */

  /* v22.1 清理：本轮核查「注释首次显示默认样式」期间，曾在本文件末尾临时挂过一个诊断钩子
     （向无头浏览器暴露 state / 相机参数 / 逐条可见注释的屏幕字高与颜色，供阈值与样式断言读取）。
     验证全部通过后已整块删除 —— 仅保留必要的只读调试/桥接入口，全局只保留必要的业务绑定。 */

  /* v23.0 清理：本轮验证「五带描边取消 / 层级门控 / 时区注释完整显示 / 字号滑块统一」期间，
     曾在本文件末尾临时挂过一个诊断钩子（向无头浏览器暴露 state / 逐条注释的屏幕字高 /
     时区注释可见数 / 特殊经纬线显隐，供运行期断言读取）。
     23 项断言全部通过后已整块删除 —— 仅保留必要的只读调试/桥接入口，全局只保留必要的业务绑定。 */

  /* =========================================================================
     v30：太阳视运动模块（sunview.js）的对外桥接
     -------------------------------------------------------------------------
     太阳视运动与地球自转 / 公转是**同一套模拟时间、同一个观测点、同一套天文算法**：
       · 时间：模拟时间 simMs 由主模块持续推进（含跨年），本模块只读不写；
       · 观测点：与「地球运动观测 › 观测点定位」双向同步（setObs 会同步主模块的监听点）；
       · 天文：太阳视位置（视赤纬 / 时差 / 视黄经）、黄赤交角、二十四节气时刻全部复用主模块实现，
               避免两套算法各算各的、读数对不上。
     这里只暴露这几个必要入口；仅保留必要的只读调试/桥接入口。
     ====================================================================== */
  /* ==========================================================================
     v31（需求八 / 需求二十二）→ v33：主视图演示悬浮窗（自转 / 公转 / 综合视图通用）

     ① 全球昼夜实时变化：**2D 画布**墨卡托投影。BASE 直接铺开「地球昼面贴图」（同一张 uDay），
        再按太阳高度角判据把夜侧压暗 —— 判据与地球着色器 **逐字同源**：

              cosZ = dot(N, uSunDir) = sinφ·sinδ + cosφ·cosδ·cos H

        其中 H = 经度 − 直射点经度（都取东经为正）。所以窗口里的晨昏线与球面上的晨昏线
        **严格是同一条**（不是另画一条近似曲线），随自转实时西移。

     ② 地球公转示意图 / 地球侧视图 / 太阳直射点回归运动 / 北极视图 / 南极视图：
        **v33 起全部改为真正的三维缩略视图**，与「综合视图」里对应窗格一一对应 ——
        同一场景、同一台相机的位姿模型、同一套要素取舍（state.comboMode 的
        一致 / 简洁规则，取简洁时按 SIMPLE_FOCUS 逐窗裁剪），因此窗内所见即综合视图
        对应窗格所见；并且 **窗内可直接拖动旋转、滚轮缩放、双击复位**（每窗一台独立相机，
        互不干扰，也不影响主视图）。

        不新增 WebGL 上下文：复用主画布 —— 把「该窗画布自身正好遮住」的那块屏幕矩形
        当作视口渲染一遍，渲染完立即把这块像素 drawImage 搬进窗口自己的 2D 画布。
        同步执行，无闪烁、无残留，显存零增量。

     窗口行为：标题栏拖动 / 八向抓手拉伸 / 折叠 / 关闭；画布用 flex 撑满 card-body，
     每帧校验客户区尺寸并同步 backing store ⇒ **拉伸窗口时内容自动填满**（需求二十二）；
     尺寸有下限（见 MV_DEFS.minW / minH 与 .mvwin 的 CSS 下限），
     标题超长省略号截断、表头不换行 ⇒ **内容永不越出窗口边界**。
     显隐走 设置›界面与主题›【面板与悬浮窗】二级菜单（window.MV_PANELS 注册项，
     由 sunview.js 的 fillPanelFlags 渲染进 #mPanelFlags 容器）。
  ========================================================================== */
  var MV_DEFS = [
    { k: 'map', id: 'mvWinMap', cv: 'mvCvMap', w: 300, h: 202, minW: 268, minH: 170, kind: '2d' },
    /* 五个 3D 缩略窗：kind='3d' + scn（场景）+ key（综合视图窗格名，决定相机与要素取舍） */
    { k: 'orbit', id: 'mvWinOrbit', cv: 'mvCvOrbit', w: 262, h: 244, minW: 210, minH: 152, kind: '3d', scn: 'orbit', key: 'orbit' },
    { k: 'side', id: 'mvWinSide', cv: 'mvCvSide', w: 262, h: 244, minW: 210, minH: 152, kind: '3d', scn: 'scene', key: 'main' },
    { k: 'sub', id: 'mvWinSub', cv: 'mvCvSub', w: 262, h: 244, minW: 210, minH: 152, kind: '3d', scn: 'scene', key: 'sub' },
    { k: 'north', id: 'mvWinNorth', cv: 'mvCvNorth', w: 262, h: 244, minW: 210, minH: 152, kind: '3d', scn: 'scene', key: 'north' },
    { k: 'south', id: 'mvWinSouth', cv: 'mvCvSouth', w: 262, h: 244, minW: 210, minH: 152, kind: '3d', scn: 'scene', key: 'south' },
  ];
  var mvWins = {};

  /* ---- 墨卡托投影辅助（v33 起仅「全球昼夜实时变化」这一个 2D 窗仍用 2D 画布绘制；
          其余四个窗口已改为真正的三维缩略视图，见下方 mvRender3DThumbs） ---- */
  // 墨卡托：纬度 → 归一化纵坐标 m ∈ [−1, 1]。
  // ★ v33：截断纬度由 ±84° 改为标准墨卡托的 **±85.0511°** —— 后者恰好使 m=±1（Y=0 / H），
  //   于是贴图条带采样（mvMercLat(1)=85.05°）与纵坐标映射同界，极区不再留出约 3% 的空白带；
  //   高纬的网格 / 晨昏线也不会被压在 Y(±84) 的那条线上。
  function mvMercY(latDeg) {
    var L = clamp(latDeg, -85.0511, 85.0511) * D;
    return Math.log(Math.tan(Math.PI / 4 + L / 2)) / Math.PI;
  }
  // 墨卡托反解：归一化纵坐标 → 纬度
  function mvMercLat(m) {
    return (2 * Math.atan(Math.exp(Math.PI * m)) - Math.PI / 2) * R;
  }
  function mvDayImage() {
    try {
      const t = earthMat && earthMat.uniforms && earthMat.uniforms.uDay && earthMat.uniforms.uDay.value;
      const im = t && t.image;
      if (im && im.width > 8 && im.height > 4) return im;
    } catch (e) { /* 贴图尚未就绪 —— 退化为纯色地表 */ }
    return null;
  }
  /* ★ v53：世界地图窗的海岸线不再读 assets/coast-vectors.js 的矢量环 ——
     改为**直接复用 3D 球面那张 geo-reg 掩膜**：把 R 通道（0=海洋 / >0=陆地）
     在离屏 canvas 上按目标宽高重采样一次，缓存成 ImageData；之后每帧只做一次
     「像素级陆海差异」描边（4 邻域）， coastline 因此与球面上的海岸线**逐像素同源**，
     不再存在「平面图一套岸线、球面另一套岸线」的错位。
     洲界线同理：用 B 通道（到洲界的距离场）阈值化后叠加，得到平面图上的大洲界线。 */
  function mvRegImage() {
    try {
      const t = geoMatR && geoMatR.uniforms && geoMatR.uniforms.uReg && geoMatR.uniforms.uReg.value;
      const im = t && t.image;
      if (im && im.width > 8 && im.height > 4) return im;
    } catch (e) { /* 贴图尚未就绪 */ }
    return null;
  }
  function mvRegBands(W, H) {
    const key = 'reg|' + W + 'x' + H;
    if (_mvReg && _mvReg.key === key) return _mvReg;
    const src = mvRegImage();
    if (!src) return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, W | 0); cv.height = Math.max(2, H | 0);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    try { cx.drawImage(src, 0, 0, cv.width, cv.height); } catch (e) { return null; }
    let dat;
    try { dat = cx.getImageData(0, 0, cv.width, cv.height); } catch (e) { return null; }
    const a = dat.data, w = cv.width, h = cv.height;
    // 陆海掩膜（Uint8，1=陆地）
    const land = new Uint8Array(w * h);
    for (let i = 0, n = w * h; i < n; i++) land[i] = (a[i * 4] > 110) ? 1 : 0;
    // 洲界距离场（Uint8，量化到 0..255，量程 GEO_SPREAD px）
    const cb = new Uint8Array(w * h);
    for (let i = 0, n = w * h; i < n; i++) cb[i] = a[i * 4 + 2];
    _mvReg = { key: key, land: land, cb: cb, w: w, h: h };
    return _mvReg;
  }
  let _mvReg = null;
  /* 在 ctx 上叠加陆海轮廓线；bCont 为真时同时叠加洲界线 */
  function mvStrokeRegions(ctx, W, H, dpr, bCont) {
    const R = mvRegBands(W, H);
    if (!R) return;
    const w = R.w, h = R.h, land = R.land, cb = R.cb;
    const lw = Math.max(0.6, 0.75 * dpr);
    /* 陆海差异 → 海岸线 */
    ctx.save();
    ctx.strokeStyle = 'rgba(226,240,252,.42)';
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const v = land[row + x];
        const xm = x > 0 ? land[row + x - 1] : land[row + ((w - 1) % w)];
        const xp = x < w - 1 ? land[row + x + 1] : land[row + ((x + 1) % w)];
        const ym = y > 0 ? land[row - w + x] : land[row + x];
        const yp = y < h - 1 ? land[row + w + x] : land[row + x];
        if (v !== xm || v !== xp || v !== ym || v !== yp) {
          ctx.moveTo(x + 0.5, y + 0.5);
          ctx.lineTo(x + 1.5, y + 0.5);
          ctx.moveTo(x + 0.5, y + 0.5);
          ctx.lineTo(x + 0.5, y + 1.5);
        }
      }
    }
    ctx.stroke();
    /* 洲界：距离场低于阈值的像素即为洲界（B 通道 0 = 正好在洲界上） */
    if (bCont) {
      const th = 26;
      ctx.strokeStyle = 'rgba(58,42,18,.55)';
      ctx.lineWidth = Math.max(0.5, 0.6 * dpr);
      ctx.beginPath();
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (land[row + x] && cb[row + x] < th) {
            ctx.moveTo(x + 0.5, y + 0.5);
            ctx.lineTo(x + 1.5, y + 0.5);
          }
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ============================ ① 全球昼夜实时变化（墨卡托） ============================ */
  function mvDrawMap(ctx, W, H, dpr, info, lonSub, o) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#050912';
    ctx.fillRect(0, 0, W, H);
    const X = function (lonDeg) { return (wrap180(lonDeg) + 180) / 360 * W; };
    const Y = function (latDeg) { return (1 - (mvMercY(latDeg) + 1) / 2) * H; };

    /* --- 地表底图：把等距圆柱（等经纬）昼面贴图按墨卡托逐条带拉伸铺开 --- */
    const im = mvDayImage();
    if (im) {
      const steps = Math.max(24, Math.min(200, Math.round(H / 2)));
      const st = H / steps;
      try {
        for (let i = 0; i < steps; i++) {
          const dy0 = i * st, dy1 = Math.min(H, (i + 1) * st);
          const lat0 = mvMercLat(1 - 2 * dy0 / H);          // 上边（较高纬）
          const lat1 = mvMercLat(1 - 2 * dy1 / H);
          let sy0 = (90 - lat0) / 180 * im.height;
          let sy1 = (90 - lat1) / 180 * im.height;
          if (sy1 < sy0) { const t = sy0; sy0 = sy1; sy1 = t; }
          const sh = Math.max(0.7, sy1 - sy0);
          ctx.drawImage(im, 0, sy0, im.width, sh, 0, dy0, W, Math.ceil(dy1 - dy0) + 1);
        }
      } catch (e) { /* 个别浏览器对条带 drawImage 有尺寸下限限制 —— 退化为一次整图 */ ctx.drawImage(im, 0, 0, W, H); }
    } else {
      const g0 = ctx.createLinearGradient(0, 0, 0, H);
      g0.addColorStop(0, '#7fa8c9'); g0.addColorStop(0.5, '#a8c6dc'); g0.addColorStop(1, '#7fa8c9');
      ctx.fillStyle = g0; ctx.fillRect(0, 0, W, H);
    }

    /* --- 海岸线 + 大洲界线（与 3D 球面同源：同一张 geo-reg 掩膜）--- */
    try { mvStrokeRegions(ctx, W, H, dpr, false); } catch (e) { /* 掩膜未就绪 —— 不画 */ }

    /* --- 昼夜分布：按经度逐列求「昼区纬度区间」，用一条闭合「昼带」多边形 + evenodd 取夜侧补集。
       ★ v33：旧写法把晨昏线当成「单值曲线 φ(lon)」并夹到 ±84°。二分日附近（|δ|→0）晨昏线退化为
       两条经线、φ 在 ±90 之间来回跳变 ⇒ 画出一只「胶囊」外加图顶 / 图底的水平假直线，顶部还漏出
       一条亮色缺口。新写法逐列解 cosZ = sinδ·sinφ + cosδ·cosH·cosφ > 0 的昼区上下界 [lo,hi]：
         · |sinδ| 极小（二分日）⇒ 该经度整列昼（cosH>0）或整列夜（cosH<0）；
         · 否则昼区 = φ>φ0（δ>0）或 φ<φ0（δ<0），φ0 为该列唯一零点。
       昼带 = { (lon,φ) : φ∈[lo,hi] }（底边界 lo 自左向右、顶边界 hi 自右向左闭合），
       夜 = 全图 − 昼带（evenodd）。任何赤纬下都不会自交、也不产生假直线。 */
    const N = 240;
    const Xp = function (lonDeg) { return (lonDeg + 180) / 360 * W; };   // 不 wrap，便于首尾恰落 0 / W
    const A0 = Math.sin(info.decl), Bc0 = Math.cos(info.decl);
    const tY = function (latDeg) { return clamp(Y(clamp(latDeg, -85.05, 85.05)), -4, H + 4); };
    const loArr = [], hiArr = [], term = [];
    for (let i = 0; i <= N; i++) {
      const lonDeg = -180 + 360 * i / N;
      const Hh = (lonDeg - lonSub * R) * D;          // 时角（弧度）
      const B = Bc0 * Math.cos(Hh);
      let lo, hi, p0 = null;
      if (Math.abs(A0) < 1e-6) {                     // 二分日：整列昼 / 整列夜
        if (B > 0) { lo = -90; hi = 90; } else { lo = 0; hi = 0; }
      } else {
        p0 = -Math.atan2(B, A0) * R;                 // 唯一零点 φ0（deg）
        while (p0 <= -90) p0 += 180;                 // 折到 (−90, 90]
        while (p0 > 90) p0 -= 180;
        if (A0 > 0) { lo = p0; hi = 90; } else { lo = -90; hi = p0; }
      }
      loArr.push(tY(lo)); hiArr.push(tY(hi));
      term.push([Xp(lonDeg), (p0 == null || Math.abs(p0) >= 84.5) ? null : tY(p0)]);
    }
    /* 昼带路径：底边界 lo 左→右、顶边界 hi 右→左，闭合 */
    function bandPath(c) {
      c.beginPath();
      c.moveTo(0, loArr[0]);
      for (let i = 1; i <= N; i++) c.lineTo(Xp(-180 + 360 * i / N), loArr[i]);
      for (let i = N; i >= 0; i--) c.lineTo(Xp(-180 + 360 * i / N), hiArr[i]);
      c.closePath();
    }
    /* 夜侧：全图 rect + 昼带 ⇒ evenodd 取补集，压暗 */
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.moveTo(0, loArr[0]);
    for (let i = 1; i <= N; i++) ctx.lineTo(Xp(-180 + 360 * i / N), loArr[i]);
    for (let i = N; i >= 0; i--) ctx.lineTo(Xp(-180 + 360 * i / N), hiArr[i]);
    ctx.closePath();
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(4,10,24,.845)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    /* 昼侧轻微提亮 + 直射点高光（模拟太阳直射处的强反照） */
    ctx.save();
    bandPath(ctx); ctx.clip();
    const sx = X(lonSub * R), sy = Y(info.decl * R);
    const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(W, H) * 0.62);
    rg.addColorStop(0, 'rgba(255,253,240,.46)');
    rg.addColorStop(0.42, 'rgba(255,248,225,.16)');
    rg.addColorStop(1, 'rgba(255,248,225,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    /* --- 经纬网：每 30° 一条；赤道 / 回归线 / 极圈加粗 --- */
    ctx.save();
    ctx.lineWidth = Math.max(1, 0.6 * dpr);
    ctx.strokeStyle = 'rgba(190,214,238,.20)';
    for (let lo = -150; lo <= 150; lo += 30) {
      ctx.beginPath(); ctx.moveTo(X(lo), 0); ctx.lineTo(X(lo), H); ctx.stroke();
    }
    for (let la = -60; la <= 60; la += 30) {
      if (la === 0) continue;
      ctx.beginPath(); ctx.moveTo(0, Y(la)); ctx.lineTo(W, Y(la)); ctx.stroke();
    }
    const epsDeg = (typeof state.obliquity === 'number') ? state.obliquity : 23.44;
    ctx.strokeStyle = 'rgba(255,214,102,.55)';
    ctx.lineWidth = Math.max(1, 0.85 * dpr);
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    [epsDeg, -epsDeg, 90 - epsDeg, epsDeg - 90].forEach(function (la) {
      ctx.beginPath(); ctx.moveTo(0, Y(la)); ctx.lineTo(W, Y(la)); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(226,240,255,.62)';
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
    ctx.restore();

    /* --- 晨昏线发光带：宽度随 state.soft（与球面上曙暮光带同一参数）---
       term[] 的第 3 项为 null 表示该处晨昏线落在极点圈外（或二分日退化）—— 断开笔，
       避免沿图顶 / 图底拖出水平假直线（旧写法在二分日附近即产生这只「胶囊 + 横线」）。 */
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const soft = clamp(state.soft, 0.01, 0.6);
    const wpx = [10, 6.4, 3.4], alp = [0.12, 0.18, 0.26];
    for (let s = 0; s < 3; s++) {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= N; i++) {
        if (term[i][1] == null) { pen = false; continue; }
        if (!pen) { ctx.moveTo(term[i][0], term[i][1]); pen = true; }
        else ctx.lineTo(term[i][0], term[i][1]);
      }
      ctx.strokeStyle = 'rgba(255,158,74,' + alp[s] + ')';
      ctx.lineWidth = (wpx[s] * (0.55 + soft * 3.2)) * dpr;
      ctx.stroke();
    }
    ctx.restore();

    /* --- 直射点标记 --- */
    ctx.save();
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 7 * dpr);
    sg.addColorStop(0, 'rgba(255,255,240,1)');
    sg.addColorStop(0.4, 'rgba(255,214,102,.9)');
    sg.addColorStop(1, 'rgba(255,180,60,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(sx, sy, 7 * dpr, 0, TWO_PI); ctx.fill();
    ctx.restore();

    /* 标题右侧读数 */
    const out = $('mvMapInfo');
    if (out) {
      const laD = info.decl * R, loD = wrap180(lonSub * R);
      out.textContent = '直射 ' + Math.abs(laD).toFixed(1) + '°' + (laD >= 0 ? 'N' : 'S') +
        ' ' + Math.abs(loD).toFixed(1) + '°' + (loD >= 0 ? 'E' : 'W');
    }
  }

  /* ======================= v33：3D 缩略窗引擎 =======================
     · 每窗一台**独立**相机（克隆默认位姿），窗内拖动 / 滚轮只改它自己，主视图不受影响；
     · 取景复用主画布：把「该窗画布自身正好遮住」的那块屏幕矩形当视口渲染一遍，
       渲染完立即 drawImage 把这批像素搬进窗口自己的 2D 画布 ——
       同步执行（无闪烁、无残留），且**不新增 WebGL 上下文、不复制任何几何 / 贴图**；
     · 要素取舍与综合视图同一套（state.comboMode：简洁 → 按 SIMPLE_FOCUS 逐窗裁剪，
       一致 → 全量）⇒ 窗内所见即综合视图对应窗格所见。
     ================================================================= */
  /* 侧视窗默认相机位姿 = 自转主视角的默认位姿（VIEW_DEFAULT），
     即「综合视图 › 地球侧视」窗打开时所见；公转窗取 orbView 的默认值。 */
  var MV_MAIN0 = (function () {
    const v = VIEW_DEFAULT, len = Math.max(1e-6, v.length());
    return { th: Math.atan2(v.z, v.x), ph: Math.acos(clamp(v.y / len, -1, 1)), d: MAIN_BASE_D };
  })();
  var MV_ORB0 = { th: Math.PI / 2, ph: 0.52, d: ORB_BASE_D };
  var MV_SUB_HALF = 1.16;              // 与主视图 subCam 同口径（SUB_HALF）
  var MV_POLAR_HALF = 1.26;            // 与主视图 camNorth / camSouth 同口径
  var mvCams3 = {};
  const _mvU = new THREE.Vector3(), _mvE1 = new THREE.Vector3(),
        _mvE2 = new THREE.Vector3(), _mvD = new THREE.Vector3();
  function mvInitCams3() {
    if (mvCams3.side) return;
    mvCams3.side = {
      mode: 'main', cam: new THREE.PerspectiveCamera(camera.fov, 1, 0.05, 2000),
      th: MV_MAIN0.th, ph: MV_MAIN0.ph, d: MV_MAIN0.d,
      tTh: MV_MAIN0.th, tPh: MV_MAIN0.ph, tD: MV_MAIN0.d, d0: MV_MAIN0,
    };
    mvCams3.orbit = {
      mode: 'orbit', cam: new THREE.PerspectiveCamera(orbitCam.fov, 1, 0.05, 2000),
      th: MV_ORB0.th, ph: MV_ORB0.ph, d: MV_ORB0.d,
      tTh: MV_ORB0.th, tPh: MV_ORB0.ph, tD: MV_ORB0.d, d0: MV_ORB0,
    };
    /* 直射点窗：以「地心 → 直射点」为基准轴的球面环绕 —— 默认正对直射点 */
    mvCams3.sub = {
      mode: 'sub', cam: new THREE.OrthographicCamera(-MV_SUB_HALF, MV_SUB_HALF, MV_SUB_HALF, -MV_SUB_HALF, 0.01, 40),
      yaw: 0, pitch: 0, zoom: 1, tYaw: 0, tPitch: 0, tZoom: 1,
      d0: { yaw: 0, pitch: 0, zoom: 1 },
    };
    [['north', false], ['south', true]].forEach(function (p) {
      mvCams3[p[0]] = {
        mode: 'polar', south: p[1],
        cam: new THREE.OrthographicCamera(-MV_POLAR_HALF, MV_POLAR_HALF, MV_POLAR_HALF, -MV_POLAR_HALF, 0.01, 40),
        yaw: 0, zoom: 1, tYaw: 0, tZoom: 1, d0: { yaw: 0, zoom: 1 },
      };
    });
  }
  /* 逐帧把相机摆到当前轨道参数对应的位姿（带阻尼，和主视图同一种跟随手感） */
  function mvSync3Cam(c, w, h) {
    const cam = c.cam;
    if (c.mode === 'main' || c.mode === 'orbit') {
      c.th = lerp(c.th, c.tTh, 0.2); c.ph = lerp(c.ph, c.tPh, 0.2); c.d = lerp(c.d, c.tD, 0.18);
      const sp = Math.sin(c.ph);
      if (c.mode === 'main') {
        const d = c.d * perspFitMul(MAIN_BASE_D, FIT_R_MAIN, w, h, cam.fov, 1);
        cam.position.set(d * sp * Math.cos(c.th), d * Math.cos(c.ph), d * sp * Math.sin(c.th));
        cam.lookAt(0, 0, 0);
      } else {
        const oR = orbRFar * 1.13 + ORB_E * ((state.orb && state.orb.earthScale) || 1) * 0.6 + 0.5;
        const d = c.d * perspFitMul(ORB_BASE_D, oR, w, h, cam.fov, Math.max(0.3, Math.cos(c.ph)));
        cam.position.set(
          _orbTarget.x + d * sp * Math.cos(c.th),
          _orbTarget.y + d * Math.cos(c.ph),
          _orbTarget.z + d * sp * Math.sin(c.th)
        );
        cam.lookAt(_orbTarget);
      }
      return;
    }
    if (c.mode === 'sub') {
      c.yaw = lerp(c.yaw, c.tYaw, 0.2); c.pitch = lerp(c.pitch, c.tPitch, 0.2); c.zoom = lerp(c.zoom, c.tZoom, 0.2);
      const U = _mvU.copy(sunDir).normalize();                       // 基准轴：地心 → 直射点
      const E1 = _mvE1.copy(_axis).addScaledVector(U, -_axis.dot(U));  // ⊥U 的「北」
      if (E1.lengthSq() < 1e-10) E1.set(0, 1, 0).addScaledVector(U, -U.y);
      if (E1.lengthSq() < 1e-10) E1.set(1, 0, 0);
      E1.normalize();
      const E2 = _mvE2.crossVectors(U, E1).normalize();
      const cp = Math.cos(c.pitch);
      const dir = _mvD.copy(U).multiplyScalar(cp * Math.cos(c.yaw))
        .addScaledVector(E2, cp * Math.sin(c.yaw)).addScaledVector(E1, Math.sin(c.pitch));
      cam.position.copy(dir).multiplyScalar(2.0);
      cam.up.copy(E1);
      cam.lookAt(U.x, U.y, U.z);                                     // 注视直射点，默认它就在画面正中
      cam.userData.half = MV_SUB_HALF / c.zoom;
      syncOrthoFrustum(cam, (w > 4 && h > 4) ? w / h : 1);
      return;
    }
    /* 南北极：沿地轴俯视，yaw = 绕地轴自转画面（等价于把地球转过来） */
    c.yaw = lerp(c.yaw, c.tYaw, 0.2); c.zoom = lerp(c.zoom, c.tZoom, 0.2);
    cam.position.copy(_axis).multiplyScalar(c.south ? -12 : 12);
    cam.up.copy(_up).applyAxisAngle(_axis, c.yaw);
    cam.lookAt(0, 0, 0);
    cam.userData.half = MV_POLAR_HALF / c.zoom;
    syncOrthoFrustum(cam, (w > 4 && h > 4) ? w / h : 1);
  }
  /* 该窗的要素取舍方案：与综合视图同源（一致 → null；简洁 → SIMPLE_FOCUS[key]） */
  function mvPaneFeat(key, isOrb) {
    return featOfFocus((state.comboMode === 'simple') ? (SIMPLE_FOCUS[key] || SIMPLE_FOCUS.main) : null, key, isOrb);
  }
  var mvAcc3 = 0, mvForce3 = 0;
  function mvRender3DThumbs(dt) {
    if (state.view === 'sun') return;
    let any = false;
    MV_DEFS.forEach(function (d) { if (d.kind === '3d' && state.mvWin[d.k]) any = true; });
    if (!any) return;
    mvAcc3 += dt;
    /* 3D 缩略窗节流到约 18fps（它们是辅助视图）；窗内交互时连续若干帧放开限制，保证跟手 */
    if (mvAcc3 < 0.055 && mvForce3 <= 0) return;
    mvAcc3 = 0; if (mvForce3 > 0) mvForce3--;
    const pr = renderer.getPixelRatio();
    const vw = window.innerWidth, vh = window.innerHeight;
    const glCv = renderer.domElement;
    MV_DEFS.forEach(function (d) {
      if (d.kind !== '3d' || !state.mvWin[d.k]) return;
      const o = mvWins[d.k];
      if (!o || !o.cv || !o.cam3 || !o.ctx) return;
      if (o.node.classList.contains('collapsed')) return;
      if (!mvSyncCanvas(o)) return;
      const r = o.cv.getBoundingClientRect();
      if (!(r.width > 6 && r.height > 6)) return;
      const ix0 = Math.max(0, r.left), iy0 = Math.max(0, r.top);
      const ix1 = Math.min(vw, r.left + r.width), iy1 = Math.min(vh, r.top + r.height);
      if (!(ix1 > ix0 + 2 && iy1 > iy0 + 2)) return;
      mvSync3Cam(o.cam3, r.width, r.height);
      const scn = (d.scn === 'orbit') ? orbitScene : scene;
      /* 渲染进「本窗画布自身遮住」的那块屏幕矩形 —— 随后立刻被本窗不透明画布覆盖 */
      renderSceneView(scn, o.cam3.cam, { x: r.left, y: r.top, w: r.width, h: r.height }, [],
        mvPaneFeat(d.key, d.scn === 'orbit'));
      const kx = o.cw / r.width, ky = o.ch / r.height;
      o.ctx.setTransform(1, 0, 0, 1, 0, 0);
      o.ctx.fillStyle = '#050912'; o.ctx.fillRect(0, 0, o.cw, o.ch);
      try {
        o.ctx.drawImage(glCv,
          Math.round(ix0 * pr), Math.round(iy0 * pr),
          Math.max(1, Math.round((ix1 - ix0) * pr)), Math.max(1, Math.round((iy1 - iy0) * pr)),
          (ix0 - r.left) * kx, (iy0 - r.top) * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky);
      } catch (e) { /* 个别环境禁止从主画布读回像素 → 该窗保留底色，不影响其它窗口 */ }
    });
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, vw, vh);
  }
  /* 窗内交互（拖动旋转 / 滚轮缩放 / 双击复位）立即刷新若干帧 */
  function mvForceRender() { mvForce3 = 6; mvDirty = true; }

  /* ============================ 窗口外壳：拖动 / 拉伸 / 折叠 / 关闭 ============================ */
  var mvZ = 20;
  function mvInitWindow(def) {
    const node = document.getElementById(def.id);
    if (!node) return;
    const cv = document.getElementById(def.cv);
    const o = {
      k: def.k, node: node, cv: cv, def: def,
      ctx: cv ? cv.getContext('2d') : null,
      cw: 0, ch: 0, dpr: 1, lay: null,
      cam3: mvCams3[def.k] || null,
    };
    mvWins[def.k] = o;
    if (def.kind === '3d') node.classList.add('mvwin-3d');
    const lay = state.ui.mvLayout[def.id] || (state.ui.mvLayout[def.id] = {});
    o.lay = lay;

    /* ★ 内容可交互：
         · 3D 缩略窗（v33）—— 拖动 = 绕目标旋转、滚轮 = 缩放、双击 = 复位（每窗独立相机）；
         · 全球昼夜图（2D）—— 拖动 = 平移、滚轮 = 缩放画布、双击 = 复位。 */
    if (cv) {
      cv.style.cursor = 'grab'; cv.style.touchAction = 'none';
      if (def.kind === '3d') {
        const c = o.cam3;
        let dg = false, sx = 0, sy = 0;
        const apply = function (dx, dy) {
          if (!c) return;
          if (c.mode === 'main' || c.mode === 'orbit') {
            c.tTh -= dx * 0.0075;
            c.tPh = clamp(c.tPh - dy * 0.0065, 0.10, Math.PI - 0.10);
          } else if (c.mode === 'sub') {
            c.tYaw -= dx * 0.0075;
            c.tPitch = clamp(c.tPitch + dy * 0.0065, -1.45, 1.45);
          } else {
            c.tYaw -= dx * 0.010;                     // 南北极：绕地轴转画面
          }
          mvForceRender();
        };
        cv.addEventListener('pointerdown', function (e) {
          if (e.button) return;
          dg = true; sx = e.clientX; sy = e.clientY;
          cv.style.cursor = 'grabbing'; node.classList.add('mv-dragging');
          if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) { } }
          e.stopPropagation(); e.preventDefault();
        });
        cv.addEventListener('pointermove', function (e) {
          if (!dg) return;
          apply(e.clientX - sx, e.clientY - sy); sx = e.clientX; sy = e.clientY;
        });
        const stop = function () {
          if (!dg) return; dg = false;
          cv.style.cursor = 'grab'; node.classList.remove('mv-dragging');
        };
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { cv.addEventListener(ev, stop); });
        cv.addEventListener('wheel', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (!c) return;
          const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
          if (c.mode === 'main') c.tD = clamp(c.tD * k, MAIN_BASE_D * 0.30, MAIN_BASE_D * 3.2);
          else if (c.mode === 'orbit') c.tD = clamp(c.tD * k, 3.2, Math.max(40, orbRFar * 4));
          else if (c.mode === 'sub') c.tZoom = clamp(c.tZoom / k, 0.25, 8);
          else c.tZoom = clamp(c.tZoom / k, 0.40, 6);
          mvForceRender();
        }, { passive: false });
        cv.addEventListener('dblclick', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (!c) return;
          if (c.mode === 'main') { c.tTh = c.d0.th; c.tPh = c.d0.ph; c.tD = c.d0.d; }
          else if (c.mode === 'orbit') { c.tTh = c.d0.th; c.tPh = c.d0.ph; c.tD = c.d0.d; }
          else if (c.mode === 'sub') { c.tYaw = 0; c.tPitch = 0; c.tZoom = 1; }
          else { c.tYaw = 0; c.tZoom = 1; }
          mvForceRender();
        });
      } else {
        o.z = 1; o.px = 0; o.py = 0;
        let pdg = false, psx = 0, psy = 0, pbx = 0, pby = 0;
        cv.addEventListener('pointerdown', function (e) {
          if (e.button) return;
          pdg = true; psx = e.clientX; psy = e.clientY; pbx = o.px; pby = o.py;
          cv.style.cursor = 'grabbing'; node.classList.add('sv-active');
          if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) { } }
          e.stopPropagation(); e.preventDefault();
        });
        cv.addEventListener('pointermove', function (e) {
          if (!pdg) return;
          o.px = pbx + (e.clientX - psx); o.py = pby + (e.clientY - psy);
          mvDirty = true;
        });
        const pst = function () {
          if (!pdg) return; pdg = false;
          cv.style.cursor = 'grab'; node.classList.remove('sv-active');
        };
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { cv.addEventListener(ev, pst); });
        cv.addEventListener('wheel', function (e) {
          e.preventDefault(); e.stopPropagation();
          o.z = clamp((o.z || 1) * (e.deltaY > 0 ? 0.90 : 1.11), 0.5, 6);
          mvDirty = true;
        }, { passive: false });
        cv.addEventListener('dblclick', function (e) {
          e.preventDefault(); e.stopPropagation();
          o.z = 1; o.px = 0; o.py = 0; mvDirty = true;
        });
      }
    }

    /* 折叠 / 关闭 */
    const bc = node.querySelector('.mv-win-collapse');
    if (bc) bc.addEventListener('click', function (e) {
      e.stopPropagation();
      const c = node.classList.toggle('collapsed');
      bc.textContent = c ? '展开' : '折叠';
      lay.collapsed = c; persist();
    });
    const bx = node.querySelector('.mv-win-close');
    if (bx) bx.addEventListener('click', function (e) {
      e.stopPropagation();
      state.mvWin[def.k] = false;
      mvApplyVisibility(); persist();
    });

    /* 拖动（标题栏） */
    const head = node.querySelector('.card-head');
    if (head) {
      head.style.cursor = 'move';
      let dr = false, ox = 0, oy = 0, px0 = 0, py0 = 0;
      head.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        const r = node.getBoundingClientRect();
        node.classList.add('sv-active');
        ox = r.left; oy = r.top; px0 = e.clientX; py0 = e.clientY; dr = true;
        if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (er) { } }
        e.preventDefault();
      });
      head.addEventListener('pointermove', function (e) {
        if (!dr) return;
        const nx = clamp(ox + (e.clientX - px0), 8 - node.offsetWidth + 70, window.innerWidth - 70);
        const ny = clamp(oy + (e.clientY - py0), 4, window.innerHeight - 30);
        node.style.left = nx + 'px'; node.style.top = ny + 'px';
        node.style.right = 'auto'; node.style.bottom = 'auto';
      });
      const stop = function () {
        if (!dr) return; dr = false;
        node.classList.remove('sv-active');
        lay.x = parseFloat(node.style.left); lay.y = parseFloat(node.style.top); persist();
      };
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) {
        head.addEventListener(ev, stop);
      });
    }

    /* 八向抓手拉伸 */
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (d) {
      const gp = document.createElement('div');
      gp.className = 'mv-grip ' + d;
      node.appendChild(gp);
      let rs = false, sx0 = 0, sy0 = 0, sw0 = 0, sh0 = 0, sl0 = 0, st0 = 0;
      gp.addEventListener('pointerdown', function (e) {
        e.stopPropagation(); e.preventDefault();
        const r = node.getBoundingClientRect();
        rs = true; sx0 = e.clientX; sy0 = e.clientY; sw0 = r.width; sh0 = r.height; sl0 = r.left; st0 = r.top;
        node.style.left = r.left + 'px'; node.style.top = r.top + 'px';
        node.style.right = 'auto'; node.style.bottom = 'auto';
        node.classList.add('sv-resizing');
        if (gp.setPointerCapture) { try { gp.setPointerCapture(e.pointerId); } catch (er) { } }
      });
      gp.addEventListener('pointermove', function (e) {
        if (!rs) return;
        const dx = e.clientX - sx0, dy = e.clientY - sy0;
        let nw = sw0, nh = sh0, nl = sl0, nt = st0;
        /* ★ v33：尺寸下限按窗口规格给（不再是全窗统一的 150×92）——
           下限保证「标题 + 折叠/关闭胶囊 + 内容」都放得下，内容永不越出窗口边界。 */
        const minW = def.minW || 190, minH = def.minH || 108;
        const maxW = Math.max(minW, window.innerWidth - 8), maxH = Math.max(minH, window.innerHeight - 8);
        if (d.indexOf('e') >= 0) nw = clamp(sw0 + dx, minW, maxW);
        if (d.indexOf('s') >= 0) nh = clamp(sh0 + dy, minH, maxH);
        if (d.indexOf('w') >= 0) { nw = clamp(sw0 - dx, minW, maxW); nl = sl0 + (sw0 - nw); }
        if (d.indexOf('n') >= 0) { nh = clamp(sh0 - dy, minH, maxH); nt = st0 + (sh0 - nh); }
        node.style.width = nw + 'px'; node.style.height = nh + 'px';
        node.style.left = nl + 'px'; node.style.top = nt + 'px';
      });
      const stp = function () {
        if (!rs) return; rs = false;
        node.classList.remove('sv-resizing');
        lay.x = parseFloat(node.style.left); lay.y = parseFloat(node.style.top);
        lay.w = parseFloat(node.style.width); lay.h = parseFloat(node.style.height);
        persist();
      };
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { gp.addEventListener(ev, stp); });
    });

    node.addEventListener('pointerdown', function () { node.style.zIndex = String(++mvZ); }, true);

    /* 初始几何：有记忆用记忆，否则按序号层叠落在右下 / 左下，避免彼此完全重叠。
       ★ v33：记忆里的尺寸也按本窗下限收口 —— 老存档（旧版下限 150×92）里存下的过小尺寸
       会让表头按钮挤出卡片外，这里统一夹回来。 */
    if (lay.collapsed) node.classList.add('collapsed');
    const wMin = def.minW || 190, hMin = def.minH || 108;
    if (+lay.w > 0) node.style.width = clamp(+lay.w, wMin, Math.max(wMin, window.innerWidth - 8)) + 'px';
    if (+lay.h > 0) node.style.height = clamp(+lay.h, hMin, Math.max(hMin, window.innerHeight - 8)) + 'px';
    if (lay.x != null && lay.y != null) {
      node.style.left = lay.x + 'px'; node.style.top = lay.y + 'px';
    } else {
      mvDockDefault(o, MV_DEFS.indexOf(def));
    }
  }
  function mvDockDefault(o, idx) {
    const n = o.node;
    const tbH = (TITLE_H || 58) + 10;
    const d0 = o.def;
    const w = d0.w, h = d0.h;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x, y;
    if (o.k === 'map') { x = 14; y = vh - h - 96; }
    else {
      /* 其余 5 个落在右下角、向左上呈层叠错位（避开右上「时间」面板与底部控制条） */
      const i = Math.max(0, idx - 1);
      x = vw - w - 18 - i * 30;
      y = vh - h - 104 - i * 30;
    }
    n.style.width = w + 'px'; n.style.height = h + 'px';
    n.style.left = clamp(x, 8, Math.max(8, vw - w - 8)) + 'px';
    n.style.top = clamp(y, tbH, Math.max(tbH, vh - Math.min(h, vh - tbH - 8) - 8)) + 'px';
    n.style.right = 'auto'; n.style.bottom = 'auto';
  }
  /* 视口变化（缩放浏览器 / 转屏）后把跑出画面的窗口拉回可视区 */
  function mvClampIntoView() {
    Object.keys(mvWins).forEach(function (k) {
      const n = mvWins[k].node;
      if (!n || !n.classList.contains('on')) return;
      const tbH = (TITLE_H || 58) + 6;
      const r = n.getBoundingClientRect();
      let nx = r.left, ny = r.top;
      if (r.right < 70) nx = 70 - r.width;
      if (r.left > window.innerWidth - 70) nx = window.innerWidth - 70;
      if (ny < tbH) ny = tbH;
      if (ny > window.innerHeight - 30) ny = window.innerHeight - 30;
      if (nx !== r.left || ny !== r.top) {
        n.style.left = nx + 'px'; n.style.top = ny + 'px';
        const lay = state.ui.mvLayout[n.id] || (state.ui.mvLayout[n.id] = {});
        lay.x = nx; lay.y = ny;
      }
    });
  }

  /* ============================ 刷新调度 ============================ */
  var mvAcc = 0, mvDirty = true;
  function mvSyncCanvas(o) {
    const cv = o.cv;
    if (!cv) return false;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (bw !== o.cw || bh !== o.ch) {           // 拉伸窗口 ⇒ backing store 跟着变 ⇒ 内容自动填满
      cv.width = bw; cv.height = bh; o.cw = bw; o.ch = bh; o.dpr = dpr;
      return true;
    }
    o.dpr = dpr;
    return true;
  }
  function mvTick(dt) {
    mvAcc += dt;
    const inSun = state.view === 'sun';
    Object.keys(mvWins).forEach(function (k) {
      const o = mvWins[k];
      const on = !!state.mvWin[k] && !inSun;
      if (o.node) o.node.classList.toggle('on', on);
    });
    if (inSun) return;
    if (mvAcc < 0.08 && !mvDirty) return;
    mvAcc = 0; mvDirty = false;
    const info = currentInfo || solarInfo(simMs);
    const lonSub = subsolarLonRad(simMs, info.eot);
    Object.keys(mvWins).forEach(function (k) {
      const o = mvWins[k];
      if (!state.mvWin[k] || !o.ctx) return;
      if (o.def && o.def.kind === '3d') return;      // v33：3D 缩略窗在主画布渲染后统一出图
      if (o.node && o.node.classList.contains('collapsed')) return;
      if (!mvSyncCanvas(o)) return;
      const W = o.cw, H = o.ch;
      try {
        o.ctx.__dpr = o.dpr;
        /* v32（需求三）：画布变换 —— 缩放 / 平移由用户交互写入 o.z / o.px / o.py */
        const z = o.z || 1, ox = (o.px || 0) * o.dpr, oy = (o.py || 0) * o.dpr;
        o.ctx.setTransform(1, 0, 0, 1, 0, 0);
        o.ctx.fillStyle = '#050912'; o.ctx.fillRect(0, 0, W, H);
        o.ctx.setTransform(z, 0, 0, z, ox, oy);
        if (k === 'map') mvDrawMap(o.ctx, W, H, o.dpr, info, lonSub, o);
        o.ctx.setTransform(1, 0, 0, 1, 0, 0);
      } catch (e) {
        o.ctx.setTransform(1, 0, 0, 1, 0, 0);
        o.ctx.clearRect(0, 0, W, H);           // 单窗出错不应拖垮整帧
      }
    });
  }
  function mvApplyVisibility() {
    Object.keys(mvWins).forEach(function (k) {
      const o = mvWins[k];
      if (o.node) o.node.classList.toggle('on', !!state.mvWin[k] && state.view !== 'sun');
    });
    mvDirty = true; mvForce3 = 3;    // 刚打开 / 关闭时立刻刷一帧
  }
  // v31（需求八）/ v33：顶层【面板】菜单里的条目 —— sunview.js 的 buildPanelMenu() 会读它
  window.MV_PANELS = MV_DEFS.map(function (d) {
    return {
      id: d.id,
      label: ({
        map: '全球昼夜实时变化（墨卡托）',
        orbit: '地球公转示意图', side: '地球侧视图',
        sub: '太阳直射点回归运动',
        north: '北极视图', south: '南极视图',
      })[d.k],
      get: function () { return !!state.mvWin[d.k]; },
      set: function (v) { state.mvWin[d.k] = !!v; mvApplyVisibility(); persist(); },
    };
  });
  /* app.js 的 <script> 位于 #mvWins 之前 —— 解析到这里时那些 <section> 还不存在。
     因此初始化推迟到 DOMContentLoaded（readyState 已过则立即执行）。 */
  function mvBoot() {
    mvInitCams3();
    MV_DEFS.forEach(mvInitWindow);
    mvApplyVisibility();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mvBoot, { once: true });
  else mvBoot();
  window.addEventListener('resize', function () { mvClampIntoView(); mvDirty = true; });

  /* ★ v41（需求二·2）：只读调试钩子 —— 与 window.SUN_BRIDGE / window.SUNVIEW 同系列，
     供自动化探针核对「文字注释」类要素的显隐门控结果（不写状态、不影响交互）。 */
  window.EARTH_NOTE = {
    all: function () { return textSprites; },
    gate: function (cat) {
      const arr = textSprites || [];
      for (let i = 0; i < arr.length; i++) if (arr[i].userData.cat === cat) return spriteNoteGate(arr[i]);
      return null;
    }
  };

  /* ★ v53：自动化探针用的**只读**调试接口（不写状态、不触发交互）。
     用途：核对「七大洲填色与区域是否一一对应」「标记点显隐」
     「文字注释优先级链」这三类只能从渲染结果反推的诉求。 */
  window.EARTH_V53 = {
    geo: function () {
      return {
        dataState: geoDataState, maskW: geoMaskW, spread: GEO_SPREAD,
        contOn: !!state.geo.cont.on, landSeaOn: !!state.geo.landSea.on,
        list: Object.assign({}, state.geo.cont.list),
        colors: Object.assign({}, state.style.fill.cont.colors),
        coastOn: !!(state.geo.landSea.coast && state.style.fill.coast.on),
        contLineOn: !!(state.geo.cont.line && state.style.fill.contLine.on),
        geoVisible: !!geoMeshR.visible,
        regBound: !!(geoMatR.uniforms.uReg.value),
        hasCoastVectors: !!window.GEO_COAST,
        /* 掩膜采样参数（只读）。掩膜是**编码数据**（R=洲索引），必须最近邻、
           关 mipmap：否则 mip / 线性会把 R 平均成「别的洲」的索引，在非目标洲
           海岸镶出同色细线（问题①）。这里暴露**实际生效值**供自动化核对。 */
        texFilter: (function () {
          const t = geoMatR.uniforms.uReg.value;
          return t ? { mag: t.magFilter, min: t.minFilter, mip: !!t.generateMipmaps, aniso: t.anisotropy } : null;
        })(),
      };
    },
    points: function () {
      return {
        show: !!state.points.show, n: state.points.items.length,
        groupVisible: ptsGroup.visible, groupVisibleOrb: ptsGroupOrb.visible,
        childCount: ptsGroup.children.length, childCountOrb: ptsGroupOrb.children.length,
        labelCount: _ptSprites.length,
        labelsVisible: _ptSprites.filter(function (s) { return s.visible; }).length,
      };
    },
    noteGate: function (cat) {
      const m = state.note.master;
      const c = state.note.cats[cat] || {};
      return {
        L1_master: !!m.on,
        L2_heading: !catGateOff(cat),
        L3_thing: !!thingGateOn(cat, null),
        L4_self: (c.on !== false),
        resolved: (function () {
          const st = noteStyleFor(cat, null);
          return !!(st.show && noteGateLevel2(cat, null));
        })(),
      };
    },
  };

  window.SUN_BRIDGE = {
    version: 'v32',
    /* ---- 时间 ---- */
    getSimMs: function () { return simMs; },
    /* 拖动下方时间滑块 / 节气按钮时使用：把模拟时间设到「本演示年内」的指定时刻 */
    setSimMs: function (ms) { simMs = clampToYear(ms); syncYear(false); updateScene(); updateUI(true); },
    getYear: function () { return displayYear; },
    localParts: function (ms) { return localParts(ms); },
    isPlaying: function () { return !!state.playing; },
    /* v39：暴露 UI 状态（面板拉伸尺寸 state.ui.pmSize 等），供探针 / 太阳侧核对持久化 */
    uiState: function () { return state.ui; },
    setPlaying: function (b) { state.playing = !!b; updateUI(true); },
    getSpeed: function () { return state.speed; },
    setSpeed: function (v) { state.speed = clamp(+v || SPEED_MIN, SPEED_MIN, SPEED_MAX); updateUI(true); },
    /* ---- 观测点（与「地球运动观测」双向同步） ---- */
    getObs: function () {
      const lat = (clickState && typeof clickState.lat === 'number') ? clickState.lat : state.mon.custom.lat;
      const lon = (clickState && typeof clickState.lon === 'number') ? clickState.lon : state.mon.custom.lon;
      return { lat: lat, lon: lon, preset: state.mon.preset };
    },
    setObs: function (lat, lon, preset) {
      lat = clamp(+lat || 0, -90, 90);
      lon = clamp(+lon || 0, -180, 180);
      state.mon.preset = preset || 'custom';
      state.mon.custom.lat = lat; state.mon.custom.lon = lon;
      setMonitor(lat, lon, { x: window.innerWidth * 0.5, y: TITLE_H + 70 });
      updateUI(true);
    },
    /* ---- 天文算法（复用主模块，两模块读数严格一致） ---- */
    getObliquity: function () { return state.obliquity; },
    solarInfo: function (ms) { return solarInfo(ms); },
    solarTerms: function (y) { return solarTerms(y); },
    solarTerms24: function (y) { return solarTerms24(y); },
    currentTerm24: function (lamRad) { return currentTerm24(lamRad); },
    fmtSpeed: function (m) { return fmtSpeed(m); },
    getSpeedRange: function () { return [SPEED_MIN, SPEED_MAX]; },
    /* ★ v32（需求二）：太阳视运动的「观测点数据面板」与主模块「地球运动观测」面板
       共用同一套数值格式化口径 —— 昼长（时/分）、时刻（HH:MM）、经纬度（度数在前 + 方位字母），
       避免同一物理量在两个视图里出现两种写法。 */
    fmtHm: function (h) { return fmtHm(h); },
    fmtHmTight: function (h) { return fmtHmTight(h); },
    fmtClock: function (h) { return fmtClock(h); },
    fmtLat: function (d, dp) { return fmtLat(d, dp); },
    fmtLon: function (d, dp) { return fmtLon(d, dp); },
    azName: function (a) { return azName(a); },
    /* ★ v32（需求二）：太阳视运动右上「时间」卡与主视图时间卡**逐字同源** ——
       直接复用主模块的 localParts / WEEK / tzMinutes 产出四段文案，杜绝两处各写一套。
       （旧实现把「北京时间 UTC+8」硬编码在 sunview 侧，在非 +8 时区的机器上与主视图不一致。） */
    timeCard: function (ms) {
      const p = localParts(ms);
      return {
        date: p.mo + '月' + p.day + '日',
        clock: pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss),
        meta: p.y + '年 星期' + WEEK[p.week] + ' · UTC' + (tzMinutes >= 0 ? '+' : '') + (tzMinutes / 60),
        mini: p.mo + '月' + p.day + '日 ' + pad2(p.hh) + ':' + pad2(p.mm),
        parts: p,
      };
    },
    /* ★ v35（需求十六）：右上时间窗补齐主模块的 日期 / 时刻 滑块与自定义时间 ——
       把主模块的年内定位 / 跨年应用能力直接暴露给太阳侧，两处行为逐字一致。 */
    daysInYear: function (y) { return daysInYear(y); },
    msFromLocal: function (year, doy, minutes) { return msFromLocal(year, doy, minutes); },
    applyCustomTime: function (y, mo, d, hh, mi, ss) {
      simMs = Date.UTC(y, mo - 1, d, hh, mi, ss) - tzMinutes * 60000;
      displayYear = localParts(simMs).y;
      simMs = clampToYear(simMs);
      syncYear(true);                  // 重建二分二至 / 刻度 / 日期滑块范围（跨年输入也生效）
      updateScene(); updateUI(true);
    },
    /* ★ v38（需求三）：太阳视运动右上「时间数据面板」补齐主模块 #timeCard 的**天文数据读数**
       （.facts 区块）—— 主模块此前只在自转 / 公转 / 综合视图的时间面板有这一块，
       太阳侧缺失。这里把主模块 updateUI 里那段读数的**完全同源**版本暴露出去：
       直射点纬度 / 经度 · 极昼极夜纬度范围 · 黄赤交角 / 地轴倾角 · 公转面积速度 ·
       公转瞬时线/角速度 · 所处时段；同时返回各项的显隐（state.read.*）。
       太阳侧只负责把返回的文本塞进 DOM，不再各算一套。 */
    factPanel: function (ms) {
      const info = solarInfo(ms);
      const p = localParts(ms);
      const declDeg = (info.declEff !== undefined ? info.declEff : info.decl) * R;
      const lonDeg = wrap180(subsolarLonRad(ms, info.eot) * R);
      const absDecl = Math.abs(declDeg);
      let polarDay = '无（直射赤道）', polarNight = '无（直射赤道）';
      if (absDecl >= 0.05) {
        const b = 90 - absDecl;
        const northDay = declDeg > 0;
        polarDay = fmtLat(northDay ? b : -b, 1) + '–' + (northDay ? '90°N' : '90°S');
        polarNight = fmtLat(northDay ? -b : b, 1) + '–' + (northDay ? '90°S' : '90°N');
      }
      /* 节气进度：上一个已过的二分二至 → 下一个（跨年自动取上一年的冬至 / 下一年的春分） */
      const yr = p.y, tCur = solarTerms(yr);
      let prevK = 'WS', nextK = 'VE', nextMs = tCur.VE;
      const seq = [['VE', tCur.VE], ['SS', tCur.SS], ['AE', tCur.AE], ['WS', tCur.WS]];
      for (let i = 0; i < seq.length; i++) {
        if (seq[i][1] <= ms) { prevK = seq[i][0]; }
        else { nextK = seq[i][0]; nextMs = seq[i][1]; break; }
      }
      if (nextMs <= (prevK === 'WS' ? solarTerms(yr - 1).WS : 0)) nextK = 'VE';
      return {
        decl: fmtLat(declDeg, 2),
        subLon: fmtLon(lonDeg, 1),
        polarDay: polarDay,
        polarNight: polarNight,
        obliq: fmtDM(state.obliquity),
        tilt: fmtDM(90 - (+state.obliquity)),
        orbArea: orbArealRateKm2Day(orbEccNow).toExponential(3).replace('e', '×10^') + ' km²/日（等面积速率）',
        orbV1: orbKin.vKmS.toFixed(3) + ' km/s（线速度）',
        orbV2: orbKin.omegaDegDay.toFixed(4) + ' °/日 · 日地距 ' + orbKin.rAU.toFixed(5) + ' AU（角速度）',
        season: TERM_NAME[prevK] + ' — ' + TERM_NAME[nextK],
        /* 显隐（与主模块「光照系统 › 时间面板数据」逐项同名）：太阳侧直接照搬 */
        show: {
          sub: !!state.read.sub, polar: !!state.read.polar,
          obliq: !!state.read.obliq, orbV: !!state.read.orbV, orbArea: !!state.read.orbArea,
        },
      };
    },
    /* ★ v38（需求三）：太阳侧「时间面板数据」子开关直接读写主模块 state.read.*，
       与自转 / 公转 / 综合视图的时间面板读数开关**完全同源**（改一处两边同步）。 */
    readGet: function (p) { return getPath(state.read, p); },
    readSet: function (p, v) {
      setPath(state.read, p, v);
      updateUI(true); persist();
    },
    /* ---- 贴图（悬浮窗里的地球缩略图直接复用日面贴图，避免再打一份资源） ---- */
    getEarthDayTexture: function () { return earthMat.uniforms.uDay.value; },
    /* ---- v31（需求三）：太阳视运动里的「全局文字样式」直接读写主模块的 state.note /
            state.ui.panel —— 自转 / 公转 / 综合 / 太阳视运动四个视图共用同一份设置，改一处四处同步。
            路径前缀 '@note.' → state.note.*，'@ui.' → state.ui.*（见 sunview.js 的 bindOne）。 ---- */
    noteGet: function (p) { return getPath(state.note, p); },
    /* ★ v33（需求：四视图「全局文字设置」统一）：太阳视运动侧的全局文字控件改的是同一份
       state.note，但此前只做了**渲染同步**，主模块【全局文字样式】菜单里的控件值 / 置灰态
       不会跟着刷新 ⇒ 两边显示不一致。这里补齐：
         · `unifyAttrs.*` 变更 → onUnifyAttrChanged（固化分类独立值 / 刷新统一态）；
         · refreshNoteCtlState() 重跑全部绑定器 ⇒ 主菜单控件即时同步；
         · invalidateNoteSprites() 让字体 / 字重 / 对齐变更后重烘焙贴图。 */
    noteSet: function (p, v) {
      /* ★ v52（F2/F4）：路径修正 —— 右上角「全局设置 › 全局文字样式 › 显示全部文字注释」
         此前把总开关写到 state.note.on，而渲染侧只认 state.note.master.on（noteStyleFor /
         earthNotesPass / applyHourStyle 全部读 master.on），于是总开关「打了没用」、
         连带「全局统一值 / 分类单独值」都看不到效果。这里把 'on' 归一到总开关三级语义。 */
      if (p === 'on' || p === 'note.on') { try { setNoteMasterAll(!!v); } catch (e0) { } return; }
      setPath(state.note, p, v);
      if (/^unifyAttrs\./.test(String(p))) { try { onUnifyAttrChanged(String(p).split('.')[2]); } catch (e) { } }
      /* ★ 本批次（需求四）**全局文字统一总开关**：note.unify 开启 ⇒ 六个分开关
         （字号/字体/颜色/透明度/字重/对齐）**全部打开**，所有注释一律按全局设置统一；
         关闭 ⇒ 六个分开关全部收回，之后各属性是否统一由**子开关单独决定**。
         渲染侧只读 unifyAttrs.*，所以这里必须把总开关摊平到分开关上（与左侧菜单
         原 cbNoteUnify 的行为一致），并逐个走 onUnifyAttrChanged 以固化分类独立值。 */
      if (p === 'unify' || p === 'note.unify') {
        var on = !!v;
        ['size', 'font', 'color', 'op', 'weight', 'align'].forEach(function (k) {
          state.note.unifyAttrs[k] = on;
          try { onUnifyAttrChanged(k); } catch (e2) { }
        });
      }
      /* ★ v52（F5）：卡顿修复 —— 只有「会改变贴图烘焙内容」的属性（字体 / 字重 / 对齐 /
         统一开关）才重建文字贴图；字号 / 颜色 / 透明度是**廉价属性**（分别走 sprite.scale /
         material.color / material.opacity），拖动滑块期间不再每次 input 都 invalidateNoteSprites
         ＋重绘全部贴图。applyAll 内 spriteDPI 仅在 dpi 档位真正跨越时才重绘 ⇒ 松手后仍即时生效。 */
      const _rebake = /^(master\.(font|weight|align)|unify|unifyAttrs\.)/.test(String(p));
      refreshNoteCtlState();
      if (_rebake) invalidateNoteSprites();
      applyAll(); persist(); notifyNoteChange();
    },
    /* ★ v32（需求六）：太阳视运动的每条文字注释都按「分类」解析样式 ——
       复用主模块的 noteStyleFor（内含「统一 ××」逐项开关 + 分类自定义值 + 分类本色），
       于是「单独设置属性」与「全局统一管理」天然一致。 */
    noteStyleFor: function (cat) { return noteStyleFor(cat); },
    panelGet: function (p) { return getPath(state.ui, p); },
    /* ★ v35（需求十七）：太阳侧改 @ui.panel.* 后 runAllBinders() —— 主模块
       「面板文字样式设置」的滑块 / 下拉读数立即跟随（双向同步的另一半）。 */
    panelSet: function (p, v) {
      setPath(state.ui, p, v);
      /* ★ 本批次（需求五）修复：theme.* 这一族（明暗模式 / 色系 / 面板底色 / 文字色 /
         不透明度 / 模糊）必须走 **applyUiTheme** 才会真正落到 CSS 变量上
         （body[data-mode]、--panel-rgb、--ink、--glass-* 全在它里面写）。
         旧实现只调 applyPanelFont（只管 --ui-font/--ui-fs/--ink），于是从右上角
         「全局设置」里改这几项 —— 状态变了、界面却毫无反应。
         左侧设置菜单靠 bindOne 的 after 钩子补了这一次调用（见 ui.theme. 分支），
         桥接这条路没有钩子，所以只有它坏。ui.panel.* 仍由 applyPanelFont 负责。 */
      if (/^theme\./.test(p)) applyUiTheme();
      else applyPanelFont();
      persist(); runAllBinders();
      if (window.SUNVIEW && window.SUNVIEW._refreshNotes) { try { window.SUNVIEW._refreshNotes(); } catch (e) { }
        if (/^theme\./.test(p) || /^panel\./.test(p)) { try { window.__svSyncBinders && window.__svSyncBinders(); } catch (e2) { } } }
    },
    /* v31（需求十七）：太阳视运动设置面板里改「UI 风格 / 毛玻璃」时，让全局主题立刻生效 */
    applyUiTheme: function () { applyUiTheme(); },
    /* ★ 本批次（需求五）：把「重置所有设置」入口移到右上角统一全局设置区 ——
       太阳侧浮层里的按钮直接复用本模块的重置逻辑（与 #btnResetAll 同一段代码），
       不再依赖设置面板里那个按钮的 DOM 仍在场。 */
    resetAll: function () { const b = $('btnResetAll'); if (b) b.click(); },
    /* ★ v62（需求 2）：地球侧设置菜单里的 #preReset 已移除 ⇒ 这里把**非全量**重置
       （保留播放状态 / 速度 / 视图 / 分屏 / 综合布局）直接暴露出去，
       供 sunview.js 的 svResetAll（右上角「全局设置 › 重置所有设置」）调用；
       旧实现是 `document.getElementById('preReset').click()`，按钮一删即失效。 */
    resetAllSettings: function (opts) { resetAllSettings(opts); },
    /* 供右上角统一设置区读取 / 回填当前值（单一数据源：state.ui / state.note） */
    uiSnapshot: function () {
      return {
        mode: state.ui.theme.mode, scheme: state.ui.theme.scheme,
        lightPanel: state.ui.theme.lightPanel, lightInk: state.ui.theme.lightInk,
        darkPanel: state.ui.theme.darkPanel, darkInk: state.ui.theme.darkInk,
        glass: state.ui.theme.glass, blur: state.ui.theme.blur,
        panel: { font: state.ui.panel.font, size: state.ui.panel.size,
                 color: state.ui.panel.color, op: state.ui.panel.op, weight: state.ui.panel.weight },
        note: {
          /* ★ v52（F2/F4）：总开关回填改为读 master.on —— 与渲染门控同源（此前读 state.note.on
             恒为 undefined，导致面板「显示全部文字注释」开关状态与真实门控脱节）。 */
          on: !!state.note.master.on, unify: !!state.note.unify,
          unifySize: !!(state.note.unifyAttrs && state.note.unifyAttrs.size),
          unifyFont: !!(state.note.unifyAttrs && state.note.unifyAttrs.font),
          unifyColor: !!(state.note.unifyAttrs && state.note.unifyAttrs.color),
          unifyOp: !!(state.note.unifyAttrs && state.note.unifyAttrs.op),
          unifyWeight: !!(state.note.unifyAttrs && state.note.unifyAttrs.weight),
          unifyAlign: !!(state.note.unifyAttrs && state.note.unifyAttrs.align),
          size: state.note.master.size, font: state.note.master.font,
          color: state.note.master.color, op: state.note.master.op,
          weight: state.note.master.weight, align: state.note.master.align,
        },
      };
    },
    /* ---- 视图 ---- */
    getView: function () { return state.view; },
    setView: function (v) { state.view = v; setViewButtons(); resize(); },
    /* ★ v39（需求三）：太阳视运动综合视图 —— 主模块把地球场景 / 相机暴露出去，
       太阳侧用自己的小 renderer 把「地球自转视图 / 地球公转视图」画进各自的窗格画布。
       这样无需依赖主画布 #gl（在太阳视图下它是 display:none，尺寸为 0）。
         kind: 'rotate' | 'revolve'。返回 { scn, cam }。相机宽高比由调用方设置。 */
    earthScene: function (kind) {
      if (kind === 'revolve') return { scn: orbitScene, cam: orbitCam, orbit: true };
      return { scn: scene, cam: camera, orbit: false };
    },
    /* ★ v41（需求一·7）：太阳视运动「综合视图」里的地球 / 公转窗格要能**拖拽旋转 + 滚轮缩放**。
       主模块的相机每帧由 view.*（自转）/ orbView.*（公转）的球坐标重算，故这里只把
       拖拽 / 滚轮折算成**目标球坐标的增量**并立即同步当前值 + 重算一次相机
       （太阳视图下主模块自己的渲染循环不跑，否则改了也要等回地球视图才看得到）。
       符号与主模块 `canvas` 上的拖拽 / 滚轮处理完全一致：
         tTheta += dx·k，tPhi = clamp(tPhi − dy·k)，tDist ×= k */
    earthOrbit: function (kind, dTheta, dPhi, kZoom) {
      if (kind === 'revolve') {
        orbView.tTheta += dTheta;
        orbView.tPhi = clamp(orbView.tPhi - dPhi, 0.05, Math.PI - 0.05);
        orbView.tDist = clamp(orbView.tDist * (kZoom || 1), 3.2, Math.max(40, orbRFar * 4));
        orbView.theta = orbView.tTheta; orbView.phi = orbView.tPhi; orbView.dist = orbView.tDist;
        updateOrbCam();
        return { theta: orbView.tTheta, phi: orbView.tPhi, dist: orbView.tDist };
      }
      view.tTheta += dTheta;
      view.tPhi = clamp(view.tPhi - dPhi, 0.06, Math.PI - 0.06);
      view.tDist = clamp(view.tDist * (kZoom || 1), 1.6, 16);
      view.theta = view.tTheta; view.phi = view.tPhi; view.dist = view.tDist;
      updateCamera();
      return { theta: view.tTheta, phi: view.tPhi, dist: view.tDist };
    },
    /* 供太阳侧在渲染地球窗格前调用：按窗格尺寸设置相机宽高比 / 正交视锥 */
    fitCam: function (cam, aspect) {
      if (!cam) return;
      if (cam.isOrthographicCamera) syncOrthoFrustum(cam, aspect);
      else if (Math.abs(cam.aspect - aspect) > 1e-4) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
    },
  };
})();
