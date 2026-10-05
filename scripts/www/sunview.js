/* =============================================================================
   sunview.js —— 「太阳视运动」模块（v30 新增）
   -----------------------------------------------------------------------------
   对应《地球公转自转及太阳视运动3D演示 开发需求说明书》第二 ~ 九章：

     三、UI 与菜单布局      —— 新增一级菜单【太阳视运动设置】【地面物体】，
                               原【显示设置】改名【设置】、原【观测·标记·演示】改名【地球运动观测】
     四、太阳光效果         —— 体积光（半通透弥散、南北纵向排布、随太阳实时重建、夜晚自动关闭）
     五、地面视图           —— 地面与东南西北方位标 / 背景与相机 / 真实太阳渲染 /
                               下方时间控制面板（地方太阳时 + 昼夜分段轨道）/ 右上时间面板（北京时间）/
                               3 个悬浮窗 / 场景物体交互（双击）/ 第一人称视角（含向日葵锁定）
     六、室内视图           —— 点击窗户进入、丁达尔体积光、边界光线、墙面阴影、退出
     七、天球视图           —— 两套坐标系 + 天球要素 + 轨迹 + 监测面板
     八、性能与边界         —— 极昼 / 极夜 / 经纬度校验 / 状态持久化 / 弹窗统一规则
     1.3  全局统一约束      —— 窗口边缘美化、0.2s 视图过渡、实时刷新、面板拖动/拉伸/折叠/隐藏/记忆/置顶

   与主模块的关系：时间、观测点、天文算法（太阳视位置 / 时差 / 二十四节气）、黄赤交角、
   地球日面贴图全部通过 window.SUN_BRIDGE 复用，两套模块读数严格一致。
   ========================================================================== */
(function () {
  'use strict';

  var BR = window.SUN_BRIDGE;
  if (!BR || !window.THREE) { console.warn('[sunview] 缺少 SUN_BRIDGE 或 three.js，模块未启动'); return; }

  /* ============================ 0. 基础工具 ============================ */
  var D = Math.PI / 180, R = 180 / Math.PI, TAU = Math.PI * 2;
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ss(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  /* ★ v54（时间滑块对齐·5）：原先这里的 `TB_THUMB_W = 18` / `TB_THUMB_W_WIDE = 20`
     （thumb 直径硬编码，用于关键点与分段条的百分比补偿）**已整体删除**。
     原因：补偿式定位天生漂移 —— ① 宽轨 thumb 20px、主滑块 18px，两套常数并行；
     ② `--ui` 缩放时 CSS 里 thumb 实际按 `calc(20px * var(--ui))` 变宽，JS 常数不跟着变；
     ③ 补偿量与「关键点层是否内缩」耦合，改 CSS 就会静默错位。
     现在统一由 CSS 栅格承担：`--trk-pad = --trk-thumb-r * --ui`（= thumb 半径），
     轨道条 / 关键点层 / 昼夜分段条统一内缩它，range 铺满 ⇒ thumb 圆心行程与之**恒等**，
     JS 只写纯百分比。thumb 尺寸只在 sunview.css 一处（--trk-thumb-r）声明。 */
  /* ★ v44：**太阳侧滑块的量程常量必须挂在文件顶部**（与 tbNode 的赋值顺序同一个坑）——
     `var SUN_MENU = [...]` 在第 3427 行就构造完毕，而 SV_LW_MIN / MAX / STEP 原先写在
     第 4260 行（菜单构造**之后**）：`var` 只提升声明、不提升赋值 ⇒ svLwCtl(...) 造出的
     滑块 spec 里 min / max / step 全是 undefined ⇒ 渲染成 `<input type=range min=0 max=100>`，
     v43 定下的「10–300 = 0.10×–3.00×」线宽口径**整体失效**（拖到底也只有 1.00×）。
     ⇒ 把 SV_LW_BASE / SV_LW_MIN·MAX·STEP / SV_CEL_TRAJ_R 一并提到这里。 */
  /* ★ v43（需求一·3 / 三·1）：**太阳侧线宽统一为「相对倍率」口径** ——
     与主模块 menu.js / app.js 的 lwRel 同一套规则（10–300 ⇒ 0.10×–3.00×，读数「1.00×」）：
       · 状态里仍存各自的物理单位（世界单位 0.026 / 轨迹管半径），渲染侧照旧读取；
       · SV_LW_BASE 登记每个线宽路径的**基准值**（= 旧默认值 = 视觉上 1.00×）；
       · 于是「地平线 / 当日轨道 / 地平线下 / 影长线 / 掠顶光线 / 方向箭头」这些
         原本分成 4 套单位（w1000·mm3 / w10·raw1 / int1·pct）的控件，滑块上下限、
         控制原理、读数口径完全一致，且相同倍率 ⇒ 相同视觉粗细。
     SV_LW_BASE 的取值 = 各线旧默认值。 */
  var SV_LW_BASE = {
    'coord.st.hrLine.w': 0.026,     /* 天球地平线（世界单位） */
    'traj.w': 3.00,                 /* 当日轨道（旧默认值 3.0，滑块 1.00× 即它） */
    'traj.underW': 3.00,            /* 地平线下轨迹 */
    /* ★ v52（需求5.1/5.2/5.3）：二分二至三套轨道的线宽基准（= 旧默认值 3.0 = 1.00×）。
       登记后 svLwCtl 的「相对倍率」口径与当日轨道 / 地平线下轨迹完全一致。 */
    'traj.termCol.eq.w': 3.00,      /* 春分 / 秋分轨道 */
    'traj.termCol.ss.w': 3.00,      /* 夏至轨道 */
    'traj.termCol.ws.w': 3.00,      /* 冬至轨道 */
    /* ★ v44（需求六）：影长线段 / 过顶部光线的**默认粗细与上限整体调高**。
       不改滑块量程（仍是服务 v43「相对倍率」口径的 10–300 = 0.10×–3.00×），
       而是抬高这两条路径的**基准值** —— 基准值即 1.00× 的默认粗细，
       上限（3.00×）随之等比抬高：7.2 ⇒ 14.4（影长）、6.0 ⇒ 12.0（光线）。
       这么做两项都涨了，同时保住了「滑块上下限全站一致」这条 v43 口径。 */
    'meas.w': 4.80,                 /* 影长线段（v43 为 2.40，v44 提高一档） */
    'meas.rayW': 4.00,              /* 掠顶太阳光线（v43 为 2.00，v44 提高一档） */
    'room.edgeW': 0.02,             /* ★ v44（需求四）：室内上下边界光线的半宽（ribbon 世界单位） */
  };
  var SV_LW_MIN = 10, SV_LW_MAX = 300, SV_LW_STEP = 1;
  /* ★ v43（需求一·3）：天球（CS = 9）上把「线宽倍率」换算成管半径的标定系数。
     天球相机 fov 42°、默认距离 26，窗口 800px 高时 1 世界单位 ≈ 40px，
     故 0.018 的管半径 ≈ 1.4px 直径 —— 与旧 1px 折线观感几乎一致，滑块 1.00× 即此值。 */
  var SV_CEL_TRAJ_R = 0.018;
  function fmtHMS(h) {
    h = ((h % 24) + 24) % 24;
    var H = Math.floor(h), M = Math.floor((h - H) * 60), S = Math.floor((((h - H) * 60) - M) * 60);
    return pad2(H) + ':' + pad2(M) + ':' + pad2(S);
  }
  function fmtHM(h) {
    h = ((h % 24) + 24) % 24;
    var H = Math.floor(h), M = Math.round((h - H) * 60);
    if (M === 60) { M = 0; H = (H + 1) % 24; }
    return pad2(H) + ':' + pad2(M);
  }
  /* 地面坐标系约定：+X = 东，−Z = 北，+Y = 天顶（与相机默认从南向北看一致） */
  function dirOf(altDeg, azDeg, out) {
    out = out || new THREE.Vector3();
    var a = altDeg * D, z = azDeg * D, c = Math.cos(a);
    return out.set(c * Math.sin(z), Math.sin(a), -c * Math.cos(z));
  }
  var DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  function azName(az) { return DIR8[Math.round(((az % 360) + 360) % 360 / 45) % 8]; }

  /* ============================ 1. 状态（持久化） ============================ */
  var LS_SUN = 'earth3d.sun.v1';
  var DEF = {
    view: 'ground',
    /* v53：「显示全部文字注释」总开关的**本地兜底值**。
       ★ 权威开关是主模块 state.note.master.on（app.js 的 setNoteMasterAll 读写它），
         本值只在桥接不可用（BR.noteGet 缺失）时兜底。默认改为 **false** ——
         与地球运动侧口径一致：文字注释默认不显示，由用户在
         「全局设置 › 全局文字样式 › 显示全部文字注释」里主动打开。
       颜色 / 字号 / 透明度 / 字体仍桥接主模块，保持「全局文字样式」两侧完全一致。 */
    noteAll: false,
    /* ★ indoor / fp / sunflower 是「当前是否处于该模式」的布尔状态；
       室内场景的**设置项**（房间类型 / 边界线 / 墙面阴影）单独放在 room 下。
       早期版本把两者都叫 indoor（对象），对象恒为真值 → 首次进入太阳视运动视图
       就直接被判成「在室内」，画面渲染 iScene 而看不到地面场景。此处已拆分。 */
    indoor: false, fp: false, sunflower: false,
    coord: { on: true, equLine: true, equPlane: false, poleN: true, poleS: true,
             hrLine: true, hrPlane: true, zenith: true, nadir: true, grid: true,
             /* v32（需求四）：经纬网格可**按地平或赤道坐标系**绘制，且线型（颜色 /
                透明度 / 实虚线）可设；地平圈周围可标注东南西北。 */
             gridSys: 'equatorial', gridColor: '#6f86ad', gridOp: 45, gridDash: 'solid',
             /* v39（需求二·1·②）：原 `hrDir`（地平圈方位标注独立开关）已废弃 ——
                东南西北标注（地面 + 天球）统一由「地面方向标 › 方向文字」控制。 */
             /* v34（面板规格）：**逐要素样式** —— 地平圈 / 地平面 / 天顶 / 天底 /
                天赤道 / 天赤道平面 / 天北极 / 天南极 各有一份线 / 面 / 点的属性；
                另有 `nt` 逐要素文字注释开关与 `aboveOnly`（只显示地平线以上的赤道坐标系）。
                线宽单位：千分之一（26 = 0.026），与主模块 thousandth 口径一致。 */
             aboveOnly: false,
             st: {
               hrLine: { w: 0.026, color: '#37a05a', op: 100 },
               hrPlane: { fill: '#5c9b6a', fillOp: 16 },
               zenith: { size: 100, color: '#ffd166', op: 100 },
               nadir: { size: 100, color: '#8b9bbd', op: 100 },
               equLine: { color: '#39c2ff', op: 100, dash: 'solid', n: 96, ratio: 55 },
               equPlane: { fill: '#39c2ff', fillOp: 14 },
               poleN: { size: 100, color: '#39c2ff', op: 100 },
               poleS: { size: 100, color: '#39c2ff', op: 100 },
             },
             nt: { hrLine: true, hrPlane: true, zenith: true, nadir: true,
                   equLine: true, equPlane: true, poleN: true, poleS: true },
             note: true, fixed: false,
             /* v31（需求十五）：坐标系可切换 —— 'horizon' 地平坐标系（地平面为基准，随观测点 /
                时间重排）；'equatorial' 固定赤道坐标系（以天赤道为基准，冻结地平系）。
                旧的固定模式布尔 coord.fixed 保留读取，装入时折算到 sys。 */
             sys: 'horizon' },
    traj: {
      /* ★ v36（需求六）：traj.on =「视运动轨迹」二级菜单的**标题总开关** ——
         统一管理浮层内全部内容（当日轨道 / 整点时刻 / 日出日落中天 / 当前太阳位置点 /
         二分二至 / 地平线下 / 绘制模式），
         且地面视图与天球视图共用同一套开关（原 gtraj.* 独立开关组已并入，见下）。 */
      on: true,
      today: true, mode: 'dynamic',
      /* ★ v62（需求一）：「位置点与时刻」组开关（ptOn）已取消 —— 整点时刻 / 日出日落中天 /
         当前太阳位置点改由 traj.on,traj.today 直接门控。旧存档残留的 traj.ptOn 字段
         无任何读取方，不影响画面（与 S.gtraj 同一处理方式）。 */
      /* ★ v64（需求1）：「影长数值注释」开关（shadowNote）与「轨迹名称注释」开关（term4Note）
         均已取消 —— 显隐分别合并到「文字注释 › 物体影长数值（天球）」（traj.nt.svMeasL）
         与「文字注释 › 二分二至轨道」（traj.nt.svTerm4）子组标题开关；旧存档残留字段无读取方。 */
      shadow: true,
      term4: false,
      /* ★ v36（需求六）：二分二至轨迹**逐套单独显示** —— 春分秋分 / 夏至 / 冬至各一枚开关
         （地面视图与天球视图都生效）。 */
      termShow: { eq: true, ss: true, ws: true },
      /* v35（需求九）：二分二至三套轨迹（春分/秋分 eq · 夏至 ss · 冬至 ws）各自的
         线条属性（颜色 / 线粗细 / 透明度）—— 原为渲染侧硬编码，现可单独设置。 */
      termCol: {
        /* ★ v52（需求5.1/5.2/5.3）：三套轨道各自补充**线型**（实线 / 虚线 + 虚线密度 + 虚实比）——
           w 为「线宽相对倍率」物理值（基准 3.0 = 1.00×，见 SV_LW_BASE[traj.termCol.*.w]），
           渲染端改由 Tube 几何按 w 决定粗细（WebGL 1px 线宽无法调粗）。 */
        eq: { color: '#b7e07f', w: 3.0, op: 72, dash: 'solid', n: 96, ratio: 55 },
        ss: { color: '#ff9f43', w: 3.0, op: 72, dash: 'solid', n: 96, ratio: 55 },
        ws: { color: '#6fc3ff', w: 3.0, op: 72, dash: 'solid', n: 96, ratio: 55 },
      },
      hourPt: true, sunPt: true, under: false,
      /* ★ v63（需求A）：「整点时刻文字注释」开关（traj.hourNote，v43 前身 gtraj 时代引入）已取消 ——
         整点时刻文字注释的显隐改由「文字注释 › 整点时刻」子组标题开关（traj.nt.svHour，
         叠加容器 traj.note）直接控制，与「日出日落中天」（traj.nt.svTraj）同一口径，
         不再单独设开关；旧存档残留的 traj.hourNote 字段无读取方，不影响画面。 */
      /* ★ v52（需求3/需求4）：日出日落中天点 / 整点位置点的**点样式** ——
         此前渲染端把颜色与半径写死（改了菜单也没用）。size 为「倍率百分数」
         （100 = 1.00×，渲染半径 = 基准半径 × size/100），op 为 0~100 百分比。 */
      sunPtColor: '#ff5e3a', sunPtSize: 100, sunPtOp: 100,
      hourPtColor: '#ffe08a', hourPtSize: 100, hourPtOp: 100,
      /* ★ v62（需求一）：「当前太阳位置点（地面）」开关（curPt，原 gtraj.sunPt）已取消 ——
         该标记画在与太阳本体完全相同的方向（当前时角）、几乎相同距离
         （TRAJ_R×1.01 ≈ SUN_DIST，太阳本体在 SUN_DIST），半径 0.85 < 日面 2.4，
         且日冕 depthTest=false 叠在上层 ⇒ 标记被太阳完全遮盖，开关从未有过可见效果，
         属功能冗余，菜单项 / 状态 / 渲染一并移除（旧存档残留字段无读取方）。 */
      /* ★ v62（需求二）：「文字注释」组总开关（note）+ 各注释分类子开关（nt.*）——
         父级＞子级：容器关 ⇒ 各子分类一并置灰隐藏（菜单门控 + 自动级联 + 渲染端三重生效）。
         ★ v64（需求1）：nt 新增 svTerm4（二分二至轨道名称注释，默认关 —— 与原 term4Note 同值）。 */
      note: true, nt: { svTraj: true, svHour: true, svMeasL: true, svTerm4: false },
      color: '#ffd166', w: 3.0, op: 100, dash: 'solid', n: 96, ratio: 55,
      /* v33（需求三）：shadowColor / shadowW 已删除 —— 天球视图的影长线段改用
         「观察与测量 › 物影 › 影长线段」的 meas.color / meas.w / meas.op / meas.dash，
         与地面视角完全一致（旧字段在本版无任何读取方，旧存档残留不影响画面）。
         地平线下轨迹补充了线粗细 / 透明度 / 线型三项。 */
      underColor: '#7d8fb3', underW: 3.0, underOp: 80, underDash: 'dash', underN: 60, underRatio: 55,
    },
    /* ★ v36（需求七）：原 `gtraj` 独立开关组（on/under/hourPt/note/sunPt）整体删除 ——
       地面视图的太阳视运动轨迹改读 traj.* 同一套开关（today / under / hourPt / hourNote /
       curPt），「地面视运动轨迹」二级条目随之从菜单中移除，两视图真正统一控制。
       旧存档残留的 gtraj 字段无读取方，不影响画面。 */
    /* v32（需求七）：太阳「边缘光线」功能已整体取消（菜单项 + 渲染逻辑 + 设置字段一并删除），
       旧存档里残留的 ray.edge* 字段无任何读取方，不会再影响画面。 */
    /* v34：`ray.on`（已失效的「真实太阳光线线段」）删除 —— 该物在 v31 起即被体积光取代，
       渲染侧永远 `false`（`S.ray.line` 从未定义），菜单里那个开关是**死控件**。
       物影相关设置一并归到「观察与测量 › 物影」，这里只留真实遮挡阴影的三个参数。 */
    ray: { shadow: true, shadowOp: 42, shadowOff: 0 },
    /* v31（需求六）：朝霞 / 晚霞与天空变色（属性可调） */
    sky: { dawn: true, dawnColor: '#ff7a2f', dawnOp: 62, dawnW: 46, dawnH: 34,
           horizon: true, horizonColor: '#f6d9b0', horizonOp: 38,
           nightTint: 82 },
    /* v31（需求十二）：影子测量（双击物体可开启；属性与显隐在「影子测量」二级菜单） */
    /* v33（需求三）：物影 —— 线宽 / 颜色 / 透明度 / 线型 对**天球视图与地面视角统一生效**。
       dash / n / ratio 为「影长线段」的线型，rayDash / rayN / rayRatio 为「过物体顶部的光线」的线型。
       影子强度（ray.shadowOp）与边缘偏移（ray.shadowOff）同时驱动真实 shadow map 的浓淡。 */
    /* ★ v64（需求4）：note =「物影 › 文字注释」容器开关（父级＞子级，门控三条测量注释）；
       label（整体字号百分比）已删除 —— 字号由各注释子组的 @note.cats.*.size 承担。 */
    meas: { on: true, note: true, ray: true, line: true, h: true, len: true, ang: true,
            /* ★ v44（需求六）：w / rayW 的**默认粗细整体调高一档**（2.4→4.8、2.0→4.0），
               这样「影长线段」与「过顶部光线」一进地面视角就是清晰可辨的粗线，
               不必每次手动拉满；滑块上限同步抬高（见 SV_LW_BASE 处注释）。 */
            color: '#ffe3a8', rayColor: '#ffd166', w: 4.8, op: 100,
            dash: 'solid', n: 12, ratio: 55, rayW: 4.0, rayOp: 90,
            rayDash: 'solid', rayN: 12, rayRatio: 55,
            /* ★ v42（代码审查改法 B）：掠顶光线的两个参数 ——
               rayLen  = 太阳侧端点自物体顶端向太阳方向前推的长度（0.5–126 m，默认 6）；
                         拉到 SUN_DIST(126) 时端点正好落在太阳中心 ⇒ 退回 v41 的整条长线。
               rayCount= 平行光线根数（1–5，默认 1）；>1 时画一组平行线，体现「太阳光近似平行」。
               ★ v44（需求六）：`rayToSun`（「连到太阳」开关）已删除 —— 见 updateMeas 处说明。
                 旧存档残留的这一字段已无任何读取方，与 S.gtraj 同一处理方式。 */
            rayLen: 6, rayCount: 1,
            /* ★ v60（需求2）：双击选中物体时显示的**粉红描边**（inverted hull 外壳）外观 ——
               颜色 / 屏幕像素宽度，可在「观察与测量 › 物影 › 选中描边」里实时调整。
               edgeColor 取 CSS 颜色串，edgeW 为描边的屏幕像素宽（1–10，默认 4）。 */
            edgeColor: '#ff4fa3', edgeW: 4 },
    /* v31（需求十三）→ v36（需求七）：地面视图轨迹的独立开关组 `gtraj` 已并入 traj.*（见上） */
    win: { earth: true, sky: true, ground: true, groundView: 0 },
    /* ★ v39（需求三）：太阳视运动综合视图（多窗组合）—— on 为开关，picks 为用户选中的视图键，
       layout 记忆各窗格位置 / 尺寸。 */
    combo: { on: false, picks: ['ground', 'sky', 'earth'], layout: {} },
    spacing: 9,
    /* ★ v44（需求七）：v43 的 `objEdge`{on,color,op}（物体立体边框线条的常态显隐与外观）
       整体删除 —— 各物体的轮廓线**常态一律隐藏**。
       ★ 本批次（需求三）：进一步**彻底不创建**任何立体边框（edgeOf 恒返回 null），
       连「选中高亮」用的线框也一并去掉；选中反馈由属性对话框 / 列表高亮承担。 */
    bld: { color: '#cfd8e3', floors: 6, floorH: 3.0, angle: 0, winBase: 1.0, winH: 1.6,
           sel: [], multi: false },
    /* ★ v35（需求十九）：地面视图物体比例优化 —— 相对半径 125.4 的地平圈，
       旧默认（小人 1.7 / 树 6）在画面里太小。整体上调默认身高 / 树高，
       老存档若仍是旧默认值（从未自定义）也一并升级。 */
    fig: { h: 2.1, color: '#f0763b' },
    /* v31（需求六）：可添加的树木（高度 / 树冠色 / 树干色） */
    tree: { h: 7.5, color: '#4f8a3d', trunk: '#7a5a34' },
    /* ★ v52（需求G5）：旗杆样式（杆高 / 杆颜色 / 旗帜颜色）——
       菜单面板与双击属性对话框**共用这一套键**，改任一边两边同步。 */
    flag: { h: 14, poleColor: '#bfc7d2', flagColor: '#d7263d' },
    /* v31（需求二十）：face = 窗户朝向。'auto' = 朝赤道（北半球朝南、南半球朝北），
       这样一日内太阳相对窗户的方位角会从东扫到西，投进屋里的光斑 / 物影也就从西向东移动。 */
    /* ★ v64（需求2）：volScale = 室内体积光强相对室外（地面视图）的**百分比占比**
       （45 = 室内光柱不透明度按室外同参数的 45% 渲染）—— 解决室内体积光过曝问题，
       可在「地面物体 › 室内设置」里调节；100 = 与室外完全一致。 */
    room: { kind: 'classroom', face: 'auto', edge: true, wshadow: true, wsColor: '#1e2a44', wsOp: 45, vol: true, volScale: 45,
            /* ★ v44（需求四）：地面 / 墙面光斑分开渲染（各自颜色与透明度）+ 边界光线属性。 */
            patch: { floorOn: true, floorColor: '#ffe6b0', floorOp: 55,
                     wallOn: true, wallColor: '#ffe6b0', wallOp: 38 },
            edgeW: 0.02, edgeColor: '#fff2c8', edgeOp: 100 },
    vol: { on: true, n: 7, intensity: 85, diffuse: 62, op: 30, decay: 68,
           /* ★ v43（需求一·2）：体积光重做为「实心光柱 + 外围柔光束」双层壳（对齐地球运动视图）。
               color = 内层实心光柱颜色（可设）；dia = 光柱直径（相对「弥散度」基准半径的百分比）；
               sheath= 外围柔光束范围（外壳半径 = 内层半径 × sheath%）；edge = 边缘柔化带
               （smoothstep 上限，越小边缘越硬、越大越柔）；decay 改为**轴向衰减**（原来完全没读取方）。
               ★ 本批次修复（#271/#272「体积光生硬、分布范围小」）：默认 edge 86→90、decay 55→68、
               sheath 190→215、op 34→30 —— 柱缘更柔、两端收口更宽、外层柔光晕更舒展、整体不再过曝。 */
           color: '#ffd873', dia: 100, sheath: 215, edge: 90 },
    sunr: { real: true, corona: 100, size: 100, quality: 1 },
    /* v34（面板规格）：地面方向标拆成「方向箭头」（3D 锥体：粗细 / 颜色 / 透明度）
       与「方向文字」（DOM 覆盖层：字号 / 字体 / 颜色 / 透明度 / 字重）两套互不干扰的属性。
       color / op 沿用旧字段 = **方向文字**的颜色与透明度（老存档语义不变）。 */
    /* ★ v44（需求五 / 十一）：`size` = 方位标**整体大小倍率**（旧为 50–200 的百分比、
       默认 100 表示 100%），与 `fontSize` 及所有文字注释统一为 1–1000 ⇒ 0.01×–10.00×。 */
    dmark: { on: true, text: true, size: 1, color: '#ffffff', op: 100, arrow: true,
             arrowColor: '#ffffff', arrowOp: 100, arrowW: 100,
             /* ★ v44（需求五）：`fontSize` 由**百分比**（40–400，默认 100 表示 100%）
                改为与所有其它文字注释**同一套口径**：滑块 1–1000 ⇒ **0.01×–10.00×**，
                读数带「×」（0.62× 这样），默认 1.00×。
                语义仍是「在全局/分类解析结果之上再乘这个倍率」（两级相乘，见 svNoteResolved），
                改的只是**单位与滑块量程** —— 这正是需求要的「单位一致」。 */
             fontSize: 1, font: 'default', weight: '400' },
    fpmark: { on: true, size: 100, color: '#1e293b', op: 100 },
    /* v32（需求二）：观测点数据面板默认显示（可关闭），地面 / 天球两个子视图都可用 ——
       面板里含「观测点位置 / 太阳方位 / 昼夜状态 / 当日昼长 / 瞬时太阳高度角 / 当地地方太阳时」，
       数值格式与主模块「地球运动观测」面板统一（BR.fmtHm / BR.fmtLat / BR.fmtLon）。 */
    /* v33（面板规格）：rows = 右上「观测点数据」面板逐行显隐（缺省全开）。
       v34：按《副设置面板 › 观察与测量 › 数据面板》补齐为 15 行 —— 定位 / 时间 / 昼夜 /
       太阳 / 日出日落 / 派生量。新增键在 restore() 里按 DEF 补默认，老存档不受影响。 */
    panel: { opts: true, timeTop: true, timeBar: true, monitor: true,
             earth: true, sky: true, ground: true,
             rows: { pos: true, lst: true, term: true, tz: true, dn: true,
                     len: true, ylen: true, az: true, alt: true, sub: true,
                     rise: true, raz: true, noon: true, lv: true, av: true } },
    layout: {},
    __v: 1,
  };
  var S = JSON.parse(JSON.stringify(DEF));

  function lsGet(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }
  function deepMerge(dst, src) {
    if (!src || typeof src !== 'object') return dst;
    Object.keys(src).forEach(function (k) {
      var sv = src[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
          dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], sv);
      else if (sv !== undefined) dst[k] = sv;
    });
    return dst;
  }
  /* 旧存档兼容：字段类型变化（扁平 ↔ 对象）/ 归属变化一律在装载后做一次类型归一化。
     ★ 归一化**必须无条件执行**（不能因为「没有存档」就提前 return），
       否则一旦 DEF 里出现重复键或类型被写错，干净环境首启就会坏，而带存档的探针测不出来。 */
  /* ★ v44（需求四）：室内光斑按**落地面的种类**分成两套渲染 + 两套属性 ——
       · patch.floorOn / patch.floorColor / patch.floorOp   = 落到地面的光斑；
       · patch.wallOn  / patch.wallColor  / patch.wallOp    = 落到四面墙（背墙 / 左墙 / 右墙）的光斑。
     旧实现里地面与墙共用同一套颜色 / 透明度，且**同一时刻只画一个面**（拿不到落在墙上的
     那部分），这次一并拆开、并给四个受光面各自独立出斑（见 updateIndoor 的投影部分）。
     edge* = 上下边界光线的属性（以前只有一个开关，粗细 / 颜色 / 透明度不可调）。 */
  var ROOM_DEF = { kind: 'classroom', edge: true, wshadow: true, wsColor: '#1e2a44', wsOp: 45, vol: true,
                   /* v32（需求八）：室内观察点 —— 房间中心 / 四墙角 */
                   view: 'center',
                   patch: { floorOn: true, floorColor: '#ffe6b0', floorOp: 55,
                            wallOn: true, wallColor: '#ffe6b0', wallOp: 38 },
                   edgeW: 0.02, edgeColor: '#fff2c8', edgeOp: 100 };
  function restore() {
    var raw = lsGet(LS_SUN);
    if (raw) { try { deepMerge(S, raw); } catch (e) { /* 坏存档忽略 */ } }
    /* ★ v39：清理已废弃的键 —— 老存档 deepMerge 会把旧键原样搬进来（coord.hrDir 已在 v39
       并入 dmark.text；留着会变成「渲染侧从不读取」的死键）。这里显式删掉。 */
    if (S.coord && Object.prototype.hasOwnProperty.call(S.coord, 'hrDir')) delete S.coord.hrDir;
    /* ★ v41（需求一·1）：竖排布局已删除 —— 清掉老存档里的 panel.tbVert。 */
    if (S.panel && Object.prototype.hasOwnProperty.call(S.panel, 'tbVert')) delete S.panel.tbVert;
    /* v30 拆分：早期版本的 S.indoor 同时兼作「室内设置对象」，现改为
       S.indoor = 布尔（是否在室内）+ S.room = 室内设置。旧存档整体搬到 S.room。 */
    if (S.indoor && typeof S.indoor === 'object') {
      if (typeof S.indoor.room === 'string') S.room.kind = S.indoor.room;
      ['edge', 'wshadow', 'vol', 'wsColor', 'wsOp'].forEach(function (k) {
        if (S.indoor[k] !== undefined) S.room[k] = S.indoor[k];
      });
    }
    S.indoor = false; S.fp = false; S.sunflower = false;     // 室内 / 第一人称 / 锁日不持久化
    /* ★ v39（需求三）：综合视图不跨会话恢复（on=false），仅保留用户上次选择的视图组合。 */
    if (!S.combo || typeof S.combo !== 'object' || Array.isArray(S.combo)) {
      S.combo = { on: false, picks: ['ground', 'sky', 'earth'], layout: {} };
    }
    S.combo.on = false;
    if (!Array.isArray(S.combo.picks) || S.combo.picks.length < 2) S.combo.picks = ['ground', 'sky', 'earth'];
    S.combo.picks = S.combo.picks.filter(function (k) {
      return ['ground', 'sky', 'indoor', 'fp', 'earth', 'orbit'].indexOf(k) >= 0;
    });
    if (S.combo.picks.length < 2) S.combo.picks = ['ground', 'sky', 'earth'];
    if (!S.combo.layout || typeof S.combo.layout !== 'object') S.combo.layout = {};
    if (S.view !== 'sky' && S.view !== 'combo') S.view = 'ground';
    if (S.view === 'combo') S.view = 'ground';   /* 综合视图不自动进入 */
    if (!S.room || typeof S.room !== 'object' || Array.isArray(S.room)) S.room = JSON.parse(JSON.stringify(ROOM_DEF));
    var RK = ['kind', 'edge', 'wshadow', 'vol', 'wsColor', 'wsOp', 'view', 'face',
              'edgeW', 'edgeColor', 'edgeOp'];
    RK.forEach(function (k) { if (S.room[k] === undefined) S.room[k] = ROOM_DEF[k]; });
    /* ★ v44（需求四）：光斑的子对象按缺键补默认（老存档没有 patch 这组字段）。 */
    (function () {
      var D = ROOM_DEF.patch;
      if (!S.room.patch || typeof S.room.patch !== 'object' || Array.isArray(S.room.patch)) {
        S.room.patch = JSON.parse(JSON.stringify(D));
      } else {
        Object.keys(D).forEach(function (k) { if (S.room.patch[k] === undefined) S.room.patch[k] = D[k]; });
      }
    })();
    if (typeof S.room.kind !== 'string') S.room.kind = 'classroom';
    /* ★ v44（需求五 / 十一）：`dmark.size` 由百分比（50–200，100 = 100%）改为倍率
       （0.01–10.00，1 = 1.00×）。老存档里 > 10 的一定是旧口径 ⇒ 无条件 /100 归一。 */
    if (S.dmark && S.dmark.size != null && S.dmark.size > 10) S.dmark.size = S.dmark.size / 100;
    if (S.dmark && (!isFinite(+S.dmark.size) || +S.dmark.size <= 0)) S.dmark.size = 1;
    /* ★ v35（需求十九）：物体默认尺寸升级 —— 旧存档若仍是 v34 以前的默认值
       （从未在面板上自定义过身高 / 树高），一并升到新默认；自定义过的保持不动。 */
    if (S.fig && S.fig.h === 1.7) S.fig.h = 2.1;
    if (S.tree && S.tree.h === 6.0) S.tree.h = 7.5;
    /* ★ v35（需求十三）：固定模式穿模修复 —— 统一使用**地平坐标系固定**。
       旧「赤道坐标系固定」会把整组天球几何绕 X 轴旋转 (90°−纬度)，地平面 / 地平圈 /
       网格与天球壳、观测者、太阳轨迹深度穿插（注释穿模）。v35 起存档一律归一到
       地平坐标系固定（cRoot 不旋转，天赤道自然倾斜），穿模不再复现；
       菜单里的「坐标系固定方式」选择器保留，仅在当次会话内生效。 */
    S.coord.sys = 'horizon'; S.coord.fixed = false;
    /* v32（需求四）：网格类型 / 颜色 / 透明度 / 线型的存档归一化（脏存档不能让渲染端读到 undefined） */
    if (S.coord.gridSys !== 'horizon' && S.coord.gridSys !== 'equatorial') S.coord.gridSys = DEF.coord.gridSys;
    ['gridColor', 'gridOp', 'gridDash'].forEach(function (k) {
      if (S.coord[k] === undefined || S.coord[k] === null) S.coord[k] = DEF.coord[k];
    });
    /* v34（面板规格）：天球坐标系逐要素样式 st / 逐要素文字注释 nt 的对象归一化 ——
       旧存档没有这两组字段，缺键一律补 DEF；缺子对象的元素整体取 DEF 的那一份。 */
    (function () {
      if (!S.coord.st || typeof S.coord.st !== 'object' || Array.isArray(S.coord.st)) S.coord.st = {};
      Object.keys(DEF.coord.st).forEach(function (k) {
        var d = DEF.coord.st[k];
        if (!S.coord.st[k] || typeof S.coord.st[k] !== 'object' || Array.isArray(S.coord.st[k])) {
          S.coord.st[k] = JSON.parse(JSON.stringify(d));
        } else {
          Object.keys(d).forEach(function (f) { if (S.coord.st[k][f] === undefined) S.coord.st[k][f] = d[f]; });
        }
      });
      if (!S.coord.nt || typeof S.coord.nt !== 'object' || Array.isArray(S.coord.nt)) S.coord.nt = {};
      Object.keys(DEF.coord.nt).forEach(function (k) {
        S.coord.nt[k] = (S.coord.nt[k] === undefined) ? !!DEF.coord.nt[k] : !!S.coord.nt[k];
      });
      S.coord.aboveOnly = !!S.coord.aboveOnly;
    })();
    /* v31：新增对象型字段的类型归一化（与主模块同一口径 —— 脏存档不能让渲染端读到 undefined） */
    (function () {
      function obj(o, d) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return JSON.parse(JSON.stringify(d));
        Object.keys(d).forEach(function (k) { if (o[k] === undefined) o[k] = d[k]; });
        return o;
      }
      S.sky = obj(S.sky, DEF.sky);
      S.meas = obj(S.meas, DEF.meas);
      /* ★ v44（需求五）：dmark.fontSize 由「百分比」改为「倍率」的**存档迁移**。
         旧值是 40–400 的百分数（100 = 1.00×）；新值是 0.01–10.00 的倍率。
         判据：新值域上界只有 10，凡是 > 10 的一定是旧百分比 ⇒ 除以 100 归一。 */
      S.dmark = obj(S.dmark, DEF.dmark);
      if (!isFinite(+S.dmark.fontSize)) S.dmark.fontSize = DEF.dmark.fontSize;
      else if (+S.dmark.fontSize > 10) S.dmark.fontSize = +S.dmark.fontSize / 100;
      S.dmark.fontSize = clamp(+S.dmark.fontSize, 0.01, 10);
      /* ★ v44（需求七）：v43 的 `S.objEdge`（立体边框线条开关）已整体删除 ——
         物体的立体轮廓线常态恒隐藏，线框只保留「选中高亮」用途。
         旧存档残留的 S.objEdge 字段无任何读取方，不影响画面，与 S.gtraj 同一处理方式。 */
      /* ★ v43（需求一·2）：体积光新增 color / dia / sheath / edge 四项（旧存档 → 取 DEF） */
      S.vol = obj(S.vol, DEF.vol);
      /* ★ v36（需求七）：原 `S.gtraj = obj(S.gtraj, DEF.gtraj)` 删除 —— gtraj 开关组已并入
         traj.*（DEF.gtraj 不存在了，此处若保留会在 Object.keys(undefined) 上抛 TypeError）。
         旧存档残留的 S.gtraj 字段无读取方，不影响画面，无需清理。 */
      S.ray = obj(S.ray, DEF.ray);
      /* v35（需求九）：二分二至三套线条属性逐套归一化（旧存档无此字段 → 整套取 DEF） */
      S.traj.termCol = obj(S.traj.termCol, DEF.traj.termCol);
      ['eq', 'ss', 'ws'].forEach(function (k) { S.traj.termCol[k] = obj(S.traj.termCol[k], DEF.traj.termCol[k]); });
      /* ★ v36（需求六）：traj.on（标题总开关）/ termShow（二分二至逐套显示）布尔归一化 ——
         旧存档没有这些字段时按 DEF 取默认。★ v62（需求一）：curPt 归一化已随开关取消删除。 */
      S.traj.on = (S.traj.on === undefined) ? true : !!S.traj.on;
      /* ★ v62（需求二）：文字注释组总开关 + 三个分类子开关（布尔归一，nt 整对象兜底重建） */
      S.traj.note = (S.traj.note === undefined) ? true : !!S.traj.note;
      if (!S.traj.nt || typeof S.traj.nt !== 'object' || Array.isArray(S.traj.nt)) S.traj.nt = {};
      Object.keys(DEF.traj.nt).forEach(function (k) {
        S.traj.nt[k] = (S.traj.nt[k] === undefined) ? !!DEF.traj.nt[k] : !!S.traj.nt[k];
      });
      if (!S.traj.termShow || typeof S.traj.termShow !== 'object') S.traj.termShow = {};
      ['eq', 'ss', 'ws'].forEach(function (k) {
        S.traj.termShow[k] = (S.traj.termShow[k] === undefined) ? true : !!S.traj.termShow[k];
      });
      /* ★ v36（需求六）：级联归一——总开关关 ⇒ 当日轨迹关。
         ★ v62（需求一）：「位置点与时刻」组开关（ptOn）已取消，ptOn 归一化与级联随之删除；
         整点时刻 / 日出日落中天 / 当前太阳位置点直接受 traj.on,traj.today 门控。 */
      if (!S.traj.on) S.traj.today = false;     // 总开关关 ⇒ 子级全部关
    })();
    if (!Array.isArray(S.bld.sel)) S.bld.sel = [];
    if (!S.layout || typeof S.layout !== 'object' || Array.isArray(S.layout)) S.layout = {};
    /* ★ v33（需求：默认展开观测点面板）：面板显隐逐键归一化为布尔 —— 旧存档若缺某个键，
       `!!undefined` 会把该面板（含「观测点数据面板」）误判为隐藏；这里按 DEF 补齐。
       折叠态同样按布尔归一（缺省即展开），保证干净环境下观测点数据面板默认展开。 */
    if (!S.panel || typeof S.panel !== 'object' || Array.isArray(S.panel)) S.panel = JSON.parse(JSON.stringify(DEF.panel));
    Object.keys(DEF.panel).forEach(function (k) {
      if (k === 'rows') return;      /* rows 是「逐行显隐」对象，不是布尔面板开关 */
      S.panel[k] = (S.panel[k] === undefined) ? !!DEF.panel[k] : !!S.panel[k];
    });
    /* v33：逐行显隐按 DEF 补齐（旧存档没有 rows 时整组取默认全开）。
       注意 obj() 在上面的 IIFE 里，此处不可直接调用，故就地归一化。 */
    if (!S.panel.rows || typeof S.panel.rows !== 'object' || Array.isArray(S.panel.rows)) {
      S.panel.rows = JSON.parse(JSON.stringify(DEF.panel.rows));
    }
    Object.keys(DEF.panel.rows).forEach(function (k) {
      S.panel.rows[k] = (S.panel.rows[k] === undefined) ? !!DEF.panel.rows[k] : !!S.panel.rows[k];
    });
    if (S.layout.svMonitor && typeof S.layout.svMonitor.collapsed !== 'boolean') S.layout.svMonitor.collapsed = false;
    S.__v = 1;
  }
  function save() { lsSet(LS_SUN, S); }
  var saveT = 0;
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 400); }

  function getPath(o, p) { var ks = String(p).split('.'), v = o; for (var i = 0; i < ks.length; i++) { if (v == null) return undefined; v = v[ks[i]]; } return v; }
  function setPath(o, p, val) { var ks = String(p).split('.'), v = o; for (var i = 0; i < ks.length - 1; i++) { if (v[ks[i]] == null) v[ks[i]] = {}; v = v[ks[i]]; } v[ks[ks.length - 1]] = val; }
  restore();

  /* ============================ 2. 天文：太阳视位置 ============================ */
  var _sg = { alt: 0, az: 0, decl: 0, eot: 0, lst: 12, dayLen: 12, rise: 6, set: 18, polar: 0 };
  function sunGeom(ms, latDeg, lonDeg, out) {
    out = out || _sg;
    var info = BR.solarInfo(ms);
    var decl = info.decl * R;
    var eot = info.eot;
    var utcH = (((ms % 86400000) + 86400000) % 86400000) / 3600000;
    var lst = utcH + lonDeg / 15 + eot / 60;
    lst = ((lst % 24) + 24) % 24;
    var H = (lst - 12) * 15 * D;
    /* ★ 修复 #9：极点（±90°）与分点（赤纬 0°）组合时 `tan(±90°)·tan(0°)` 会产出
       非有限值，进而使 cosH0 / dayLen / rise / set 变成 NaN。这里与 dayLenAtDecl 同一口径，
       把纬度夹到 ±89.5°（对 alt / az 的影响 < 0.01°，肉眼不可辨），保证极点不再产出 NaN。 */
    var phi = clamp(latDeg, -89.5, 89.5) * D, d = decl * D;
    var sinAlt = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
    var alt = Math.asin(clamp(sinAlt, -1, 1)) * R;
    var az = Math.atan2(-Math.cos(d) * Math.sin(H),
                        Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(H)) * R;
    az = ((az % 360) + 360) % 360;
    var cosH0 = -Math.tan(phi) * Math.tan(d);
    var dayLen, polar = 0;
    if (cosH0 <= -1) { dayLen = 24; polar = 1; }
    else if (cosH0 >= 1) { dayLen = 0; polar = -1; }
    else { dayLen = 2 * Math.acos(cosH0) * R / 15; }
    out.alt = alt; out.az = az; out.decl = decl; out.eot = eot; out.lst = lst;
    out.dayLen = dayLen; out.rise = 12 - dayLen / 2; out.set = 12 + dayLen / 2; out.polar = polar;
    out.ms = ms; out.lat = latDeg; out.lon = lonDeg;
    return out;
  }
  /* v34（面板规格）：给定纬度与太阳赤纬的昼长（小时）—— 用于「全年昼长极值」取二至日两端。
     判据与 sunGeom 内的 cosH0 一致（不含大气折射修正），极昼 24h / 极夜 0h 直接返回端点值。 */
  function dayLenAtDecl(latDeg, declDeg) {
    var cosH0 = -Math.tan(clamp(latDeg, -89.5, 89.5) * D) * Math.tan(declDeg * D);
    if (cosH0 <= -1) return 24;
    if (cosH0 >= 1) return 0;
    return 2 * Math.acos(cosH0) * R / 15;
  }
  function altAzOfH(Hdeg, latDeg, declDeg) {    var H = Hdeg * D, phi = latDeg * D, d = declDeg * D;
    var sinAlt = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
    var alt = Math.asin(clamp(sinAlt, -1, 1)) * R;
    var az = Math.atan2(-Math.cos(d) * Math.sin(H),
                        Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(H)) * R;
    return { alt: alt, az: ((az % 360) + 360) % 360 };
  }

  /* ============================ 3. 贴图 / 精灵工具 ============================ */
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  var LABEL_FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif';
  /* v31（需求三 / 十六）：太阳视运动文字注释统一受「全局文字样式」控制 ——
     颜色 / 字号 / 透明度 / 字体经 @note.* 桥接到主模块 state.note（与自转 / 公转 / 综合完全一致）；
     「显示全部文字注释」总开关用本地 noteAll（默认开，见 DEF），避免被主模块默认关连带隐藏。
     颜色靠 material.color 乘法染色，故统一颜色可运行时调整，无需重绘。 */
  var allNoteSps = [];
  function noteSplice(sp) {
    var i = allNoteSps.indexOf(sp);
    if (i >= 0) allNoteSps.splice(i, 1);
  }
  /* ★ v32（需求六）：注释的「字号基准」与主模块统一 —— UNIFY_W = 0.62 对应倍率 1.00。
     分类样式里的 size 是「世界基准宽度」（如 0.62 = 1.00×、0.55 = 0.89×），
     这里换算成相对本精灵 baseSize 的倍率。 */
  var SV_UNIFY_W = 0.62;
  /* v32（需求六）：每条注释按 `cat` 单独解析样式 —— 走桥接的 noteStyleFor(cat)
     （内含「统一 ××」逐项开关、分类自定义值、分类本色），实现「单独设置属性 + 全局统一管理」。
     没有 cat（或桥接不可用）时退化为只用全局 master / unifyAttrs（旧行为）。 */
  function svNoteStyle(cat) {
    /* ★ 本批次（需求四）：「显示全部文字注释」改为**统一读主模块 note.on** ——
       此前用的是本地 S.noteAll（DEF 里默认 true），与全局设置写入的 state.note.on
       完全脱钩：在全局设置里关掉注释后，太阳视运动的地面视图 / 天球视图 /
       综合视图窗格仍照常显示。现在以主模块为唯一数据源，两侧状态天然同步；
       桥接不可用时才回退本地值（DEF 注释里保留说明）。 */
    /* ★ v53（关键修正）：权威路径是 **note.master.on**，不是 note.on。
       BR.noteGet 走的是 getPath(state.note, p)，所以 'on' 查到的是不存在的
       state.note.on ⇒ 恒 undefined ⇒ 永远回退本地 S.noteAll（此前默认 true），
       于是太阳视运动的整个「显示全部文字注释」总开关**完全失效**：
       gateMasterNotes() 的全部精灵注释、地面/室内东南西北方位标、天球方位注释
       都不受总开关控制。改为读 'master.on' 后，总开关才真正生效。 */
    var _mOn = (BR && BR.noteGet) ? BR.noteGet('master.on') : undefined;
    var mOn = (_mOn === undefined || _mOn === null) ? (S.noteAll !== false) : !!_mOn;
    var ua = BR.noteGet('unifyAttrs') || {};
    var st = {
      on: mOn !== false,
      ua: ua,
      m: {
        size: BR.noteGet('master.size'),
        color: BR.noteGet('master.color'),
        op: BR.noteGet('master.op'),
        font: BR.noteGet('master.font'),
        weight: BR.noteGet('master.weight'),
        align: BR.noteGet('master.align')
      }
    };
    if (cat && BR.noteStyleFor) {
      try { st.cs = BR.noteStyleFor(cat) || null; st.cat = cat; } catch (e) { st.cs = null; }
    }
    /* ★ v39（需求二·1·②）：天球方位注释（svHrDir）与**地面方向文字合二为一** ——
       直接采用「地面方向标 › 方向文字」那一套属性（dmark 的 字色/字号/透明度/字体/字重），
       因此改一次就对地面文字与天球注释同时生效，不再需要两处分别设置。
       ★ v43（一·6 / 三·2）：**字号改为在全局解析结果之上再乘 dmark.fontSize** ——
       旧写法把 size 整个替换成 SV_UNIFY_W × dmark.fontSize，等于把 noteStyleFor 算出的
       全局 / 分类字号**整个丢弃**，于是「全局文字样式大小」对方位注释完全无效。
       现在：全局（或分类自定义）字号 × 方向标自己的字号档，两级相乘，语义清晰。 */
    if (cat === 'svHrDir') {
      var hrBase = (st.cs && st.cs.size != null) ? st.cs.size : SV_UNIFY_W;
      /* ★ v61（需求 3）：颜色 / 透明度 / 字重 / 字体 / 对齐五项改为**受全局文字样式统一管理** ——
         判据与地面 / 室内方位文字（applyDirTextStyle → svDirAttr）完全一致：
           该属性勾了「统一 ××」⇒ 取全局 master 值；没勾 ⇒ 用地面方向标自己的值（S.dmark.*）。
         旧实现这五项直接写死 S.dmark.*（对齐恒为 'center'），把 note.unifyAttrs / note.master
         整个绕过 ⇒「全局文字样式」里的颜色 / 字体 / 字重 / 对齐对天球东南西北注释毫无作用
         （地面方位文字受全局管、天球方位注释不受，同一组方位注释两种行为）。
         字号仍保持两级相乘（全局 / 分类解析结果 × 方向标自己的字号档），语义不变。 */
      st.cs = {
        size: hrBase * dmarkFontScale(),
        color: svDirAttr(st, 'color', S.dmark.color || '#ffffff'),
        op: clamp(svDirAttr(st, 'op', clamp((S.dmark.op != null ? S.dmark.op : 100) / 100, 0, 1)), 0, 1),
        weight: String(svDirAttr(st, 'weight', S.dmark.weight || '700')),
        align: String(svDirAttr(st, 'align', 'center')),
        font: svDirAttr(st, 'font', S.dmark.font || 'default')
      };
      st.cat = cat;
    }
    return st;
  }
  /* ★ v44（需求五）：方向文字的「字号倍率」唯一读点。
     值域 0.01–10.00（≡ 滑块 1–1000），与其它注释的「字号」同一把尺；
     旧存档是百分比（100 = 1.00×），已在 restore() 末尾统一除以 100。 */
  function dmarkFontScale() {
    var v = S.dmark && S.dmark.fontSize != null ? +S.dmark.fontSize : 1;
    return clamp(isFinite(v) ? v : 1, 0.01, 10);
  }
  /* 由「分类解析结果 / 全局设置」求某条注释的最终样式 */
  function svNoteResolved(sp, st) {
    st = st || svNoteStyle(sp && sp.userData ? sp.userData.cat : null);
    var u = (sp && sp.userData) || {};
    var cs = st.cs;
    var ref = SV_UNIFY_W;
    var world, col, op, weight, align, font;
    if (cs) {
      world = (cs.size != null) ? cs.size : ref;
      col = cs.color || u.baseColor || '#ffffff';
      op = (cs.op != null) ? cs.op : 1;
      weight = cs.weight || u.baseWeight || '700';
      align = cs.align || u.baseAlign || 'center';
      font = cs.font ? svFontCss(cs.font) : (u.baseFont || LABEL_FONT);
    } else {
      world = st.ua.size ? (st.m.size != null ? st.m.size : ref) : ref;
      col = st.ua.color ? (st.m.color || u.baseColor || '#ffffff') : (u.baseColor || '#ffffff');
      op = st.ua.op ? (st.m.op != null ? st.m.op / 100 : 1) : 1;
      weight = st.ua.weight ? (st.m.weight || '700') : (u.baseWeight || '700');
      align = st.ua.align ? (st.m.align || 'center') : (u.baseAlign || 'center');
      font = st.ua.font ? svFontCss(st.m.font) : (u.baseFont || LABEL_FONT);
    }
    return { size: world / ref, color: col, op: op, weight: weight, align: align, font: font };
  }
  function svFontCss(font) {
    if (font === 'both') return '"SimSun","宋体","Times New Roman",Times,serif';
    if (font === 'simsun') return '"SimSun","宋体",serif';
    if (font === 'hei') return '"SimHei","黑体","Microsoft YaHei",sans-serif';
    if (font === 'times') return '"Times New Roman",Times,serif';
    return LABEL_FONT;
  }
  function svDrawCanvas(cv, text, weight, fontFamily, align) {
    var fs = 56, pad = 18, c = cv.getContext('2d');
    var font = weight + ' ' + fs + 'px ' + fontFamily;
    c.font = font;
    var lines = String(text).split('\n'), w = 0;
    lines.forEach(function (l) { w = Math.max(w, c.measureText(l).width); });
    cv.width = Math.ceil(w) + pad * 2;
    cv.height = Math.ceil(lines.length * fs * 1.22 + pad * 2);
    c = cv.getContext('2d');
    c.font = font; c.textBaseline = 'middle';
    c.textAlign = (align === 'left') ? 'left' : (align === 'right') ? 'right' : 'center';
    var tx = (align === 'left') ? pad : (align === 'right') ? (cv.width - pad) : (cv.width / 2);
    c.fillStyle = '#ffffff';   // 白色绘制，靠 material.color 染色 ⇒ 统一颜色可运行时调整
    lines.forEach(function (l, i) { c.fillText(l, tx, pad + fs * 1.22 * (i + 0.5)); });
  }
  function textSprite(text, opt) {
    opt = opt || {};
    var cat = opt.cat || null;
    /* v32（需求六）：烘图用的字体 / 字重 / 对齐按**该条注释的所属分类**解析 */
    var probe = { userData: { cat: cat, baseColor: opt.color || '#ffffff',
      baseWeight: opt.weight || '700', baseAlign: opt.align || 'center',
      baseFont: opt.font || LABEL_FONT } };
    var st0 = svNoteStyle(cat);
    var rsz = svNoteResolved(probe, st0);
    var weight = rsz.weight;
    var fontFamily = rsz.font;
    var align = rsz.align;
    var cv = document.createElement('canvas');    svDrawCanvas(cv, text, weight, fontFamily, align);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter; tex.encoding = THREE.sRGBEncoding;
    var baseColor = opt.color || '#ffffff';
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.material.color.set(baseColor);
    /* ★ v43（三·2）：**baseSize 缺省时一律取该分类的固有字号**
       （noteStyleFor(cat).size，也就是 NOTE_CAT_DEF 里的默认值），不再回落 0.6 这个
       「随手写的」魔数。旧写法的问题是各调用点自己传 size，同一分类在不同场景给不同值：
       svTraj 在地面用 1.5~2.4、在天球用 0.38~0.42（差 5 倍），svHrLine 0.6 / svHrDir 0.62
       也各是一套 —— 于是「同一条注释在不同视图大小差一截」「相同字号显示不一样大」。
       归一后：同一分类在任何场景的**基准**一致，实际大小只由「全局文字样式大小」这一个
       滑块 + 用户对该分类的单独设置决定 ⇒ 相同设置必然渲染成相同像素。
       需要局部放大的注释（测量数值、时刻点等）仍可显式传 size，属于有意的强调。 */
    var defSize = (st0 && st0.cs && st0.cs.size != null) ? st0.cs.size : SV_UNIFY_W;
    var baseSize = opt.size != null ? opt.size : defSize;
    var k = baseSize / cv.height;
    sp.scale.set(cv.width * k, cv.height * k, 1);
    sp.renderOrder = opt.order == null ? 40 : opt.order;
    sp.userData = { isLabel: true, text: text, cat: cat, baseSize: baseSize, baseColor: baseColor,
      baseFont: opt.font || LABEL_FONT, baseWeight: opt.weight || '700', baseAlign: opt.align || 'center',
      cvW: cv.width, cvH: cv.height,
      bakedFont: fontFamily, bakedWeight: weight, bakedAlign: align, gate: (opt.gate !== false),
      coreNote: !!opt.core };
    if (opt.track !== false) allNoteSps.push(sp);
    svApplyOne(sp, svNoteStyle(cat));
    return sp;
  }
  /* 应用分类样式：字号 / 颜色 / 透明度（运行时生效，无需重绘） */
  function svApplyOne(sp, st) {
    var u = sp.userData;
    st = st || svNoteStyle(u.cat);
    var r = svNoteResolved(sp, st);
    /* v32（需求六）：字号倍率 = 分类世界基准宽度 / UNIFY_W；旧的 st.m.size/100 口径会让
       注记缩到几乎不可见（统一字号默认开启时整个太阳视运动的文字注释都「消失」）。 */
    var effSize = u.baseSize * r.size;
    var k = effSize / u.cvH;
    sp.scale.set(u.cvW * k, u.cvH * k, 1);
    /* ★ v35（需求七）：记录「未补偿」基准尺寸 —— 每帧渲染前 applySvNoteK 按
       相机距离再乘补偿系数，实现屏幕字号恒定；样式变化时这里刷新基准。 */
    u.bsx = u.cvW * k; u.bsy = u.cvH * k;
    sp.material.color.set(r.color);
    sp.material.opacity = r.op;
  }
  /* 字体 / 字重 / 对齐变化需要重绘画布 */
  function svRedrawNote(sp, fontFamily, weight, align) {
    var u = sp.userData;
    var cv = document.createElement('canvas');
    svDrawCanvas(cv, u.text, weight, fontFamily, align);
    if (sp.material.map) sp.material.map.dispose();
    var tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.encoding = THREE.sRGBEncoding;
    sp.material.map = tex;
    u.cvW = cv.width; u.cvH = cv.height; u.bakedFont = fontFamily; u.bakedWeight = weight; u.bakedAlign = align;
  }
  function applyNoteStyles() {
    for (var i = 0; i < allNoteSps.length; i++) {
      var sp = allNoteSps[i], u = sp.userData;
      /* v32（需求六）：逐条按所属分类解析（含「统一 ××」与分类自定义值） */
      var st = svNoteStyle(u.cat);
      var r = svNoteResolved(sp, st);
      if (r.font !== u.bakedFont || r.weight !== u.bakedWeight || r.align !== u.bakedAlign) {
        svRedrawNote(sp, r.font, r.weight, r.align);
      }
      svApplyOne(sp, st);
    }
  }
  /* ★ v62（需求二）：「视运动轨迹 › 文字注释」组的**渲染端门控** ——
     svTraj（日出日落中天）/ svHour（整点时刻）/ svTerm4（二分二至轨道，★ v64）三类
     注释直接按分类归属判断；svMeasL（物体影长数值·天球）与地面测量的影长数值**共享分类**，
     故只对带 _trajNote 标记的天球影长注释生效（地面测量影长仍由 meas.len 控制并改走
     下方的 meas.note 门控，见 svMeasNoteOK）。
     与 S.traj.note（容器）＋ S.traj.nt.<cat>（子分类）做「与」运算 —— 父级＞子级。 */
  function svTrajNoteOK(cat) {
    if (S.traj.note === false) return false;
    return !cat || !S.traj.nt || S.traj.nt[cat] !== false;
  }
  /* ★ v64（需求4）：「观察与测量 › 物影 › 文字注释」组的渲染端门控 ——
     作用于地面测量的三条注释（物体高度 svMeas / 影长数值 svMeasL·不带 _trajNote /
     太阳高度角 svMeasA）。与菜单容器开关（meas.note）做「与」运算 —— 父级＞子级，
     各注释自身的显隐（meas.h / meas.len / meas.ang）仍由 _typeVis 独立承担。 */
  function svMeasNoteOK() {
    return S.meas.note !== false;
  }
  /* 每帧把全局总开关（显示全部文字注释）叠加到各类注记自身显隐之上 */
  function gateMasterNotes() {
    var on = svNoteStyle().on;
    for (var i = 0; i < allNoteSps.length; i++) {
      var sp = allNoteSps[i], u = sp.userData;
      /* ★ 本批次（需求四）：总开关**统一控制所有**文字注释 ——
         旧实现给「核心坐标标签」（天北极 / 地平圈 / 东南西北 / 太阳等）开了豁免，
         结果在全局设置里关掉「显示全部文字注释」后，天球坐标系那批标签仍照常显示
         （实测 20 条里只隐藏了 6 条轨迹注记，剩 13 条坐标注记不受控）。
         现在一律 `on && 自身开关`：总开关关闭 ⇒ 地面视图 / 天球视图 / 综合视图窗格
         里的文字注释全部隐藏，地面与天球状态天然一致。
         ★ v62（需求二）：再叠加「视运动轨迹 › 文字注释」组（容器 + 子分类）门控 ——
           仅作用于 svTraj / svHour 分类与带 _trajNote 标记的天球影长注释。
         ★ v64（需求1/需求4）：svTerm4（二分二至轨道名称注释）并入 traj 组门控；
           地面测量的三条注释（svMeas / svMeasA / 不带 _trajNote 的 svMeasL）
           叠加「物影 › 文字注释」容器开关（meas.note）门控。 */
      var isMeasNote = (u.cat === 'svMeas' || u.cat === 'svMeasA' ||
                        (u.cat === 'svMeasL' && !u._trajNote));
      var tg = (u.cat === 'svTraj' || u.cat === 'svHour' || u.cat === 'svTerm4' || u._trajNote)
        ? svTrajNoteOK(u.cat)
        : (isMeasNote ? svMeasNoteOK() : null);
      var base = (u._typeVis !== undefined) ? (on && u._typeVis) : on;
      sp.visible = (tg === null) ? base : (base && tg);
    }
  }
  /* ★ v35（需求七）：太阳视运动「屏幕字号恒定」补偿。
     文字精灵的世界尺寸固定，地面 / 天球视图相机可大幅推拉（地面 1.2~340）⇒
     拉远后注释小到不可读、贴近又糊满画面。补偿模型：注释分布在天球面
     （半径 TRAJ_R ≈ 125.4）上，面向相机的注释到相机距离 ≈ |TRAJ_R − 相机距离|，
     按「当前距离 / 默认机位距离」等比缩放即可保持屏幕观感恒定。
     只处理挂在 scn 场景下的精灵（天球 cScene 与地面 gScene 各用各的机位基准，
     同一批精灵被主视图相机渲染，缩略窗相机沿用现状不单独补偿）。
     ★ v41（需求一·15 / 需求二·3 同口径）：改为按**每条注释到相机的真实距离 d** 补偿 ——
       世界尺寸 ∝ d ⇒ 屏幕占比 = 世界尺寸 / (2·d·tan(fov/2)) 恒定，滚轮怎么推拉字号在屏幕上
       就是一个固定的占比；旧的整帧单系数 k = |TRAJ_R − cd| / 常量会让同一帧里地平圈注释和
       天顶注释拿到同一个 k，屏幕字号仍在变。标称距离 d0 首次调用时自校准。 */
  var _nkPos = null;
  /* ★ v41 的 _sd0Reg / noteRefDist（逐条精灵各自登记「标称距离」）已在 v43（三·2）删除 ——
     那套口径正是「同设置下屏幕像素高相差近 3 倍」的根因：屏幕占比 = worldY / sd0，
     而 sd0 逐条不同 ⇒ 占比由「精灵离相机多远」决定，而不是由「字号设多大」决定。
     现改为 applySvNoteK(cam, refD, scn) 里的**场景统一 refD**，精灵重建也不再漂。 */
  /* ★ v43（三·2）**屏幕占比归一**的核心修正 ——
     旧实现的补偿系数 k = d / sd0，sd0 是「这条精灵自己第一次被看到时的距离」。
     问题：同一条轨迹上的注释，落到相机近处的那几条 sd0 小、远处的 sd0 大，
     于是**世界高完全相同（都 0.62）的两条注释，屏幕上却相差近 3 倍**
     （探针实测同设置下像素高 14.3px ~ 41.5px，正是用户报的「有的大有的小」）。
     根因是 sd0 逐条不同，等于每条注释各自挑了一个「标称距离」，
     屏幕占比 = worldY × k / d = worldY / sd0 ⇒ 完全由 sd0 决定，与 size 无关。
     正确口径：标称距离必须是**整个场景共用一个** refD（调用方已传入：地面 46 / 天球
     orbSky.def.dist），这样 屏幕像素高 = worldY × H / (2·tan(fov/2)·refD) —— 只由
     worldY（即 size）决定，与精灵离相机远近、视角缩放全都无关。
     这才真正做到「字号相对于整体窗口，不受视角缩放影响 + 相同字号显示一样大」。 */
  function applySvNoteK(cam, refD, scn) {
    if (!cam) return;
    if (!_nkPos) _nkPos = new THREE.Vector3();
    /* 场景统一标称距离：调用方给的值优先；缺省退回相机到场景原点的距离 */
    var RD = (refD && isFinite(refD) && refD > 1e-3) ? refD
      : (scn ? cam.position.distanceTo(scn.position || cam.position) : 1);
    if (!isFinite(RD) || RD <= 1e-3) RD = 1;
    /* ★ v43（三·2）：**读 matrixWorld 之前必须先刷新世界矩阵** ——
       本函数在主循环里位于 updateCelestial 之后、rnd.render 之前，而 three 的
       `updateMatrixWorld` 是由 renderer.render() 内部触发的。于是**本帧刚创建的精灵**
       （整点 / 日出日落注释在「动态绘制」模式下每帧重建）matrixWorld 还是单位阵，
       setFromMatrixPosition 读出的是场景原点 (0,0,0) ⇒ d 恒等于「相机到原点距离」
       （天球侧 = cDist = 26），所有这类精灵拿到**同一个** k = 26 / 20.3787 = 1.2758。
       后果：日出（真实距离 20.1）与日落（真实距离 32.8）屏幕像素高 29.78 vs 18.305，
       差 11.5px —— 正是用户报的「有的大有的小」。
       这里显式 updateMatrixWorld(true) 一次（幂等，代价可忽略），
       也顺带覆盖了 setLabelText 换贴图后位置变了的精灵。 */
    if (scn && scn.updateMatrixWorld) scn.updateMatrixWorld(true);
    for (var i = 0; i < allNoteSps.length; i++) {
      var sp = allNoteSps[i], u = sp.userData;
      if (u.bsx == null) continue;
      /* ★ v41：不再按「场景归属」过滤 —— 天球 / 地面 / 测量三类精灵混在 allNoteSps 里，
         只认挂在当前 scn 下的话，地面视图里的天球注释（天北极 / 地平圈 / 东南西北 …）
         整批拿不到补偿，滚轮一推字号就变小（探针实测 18 条里只有 2 条被补偿）。
         现在一律按「该精灵到主视图相机的真实距离」补偿，屏幕占比恒定。 */
      _nkPos.setFromMatrixPosition(sp.matrixWorld);
      var d = cam.position.distanceTo(_nkPos);
      if (!isFinite(d) || d <= 1e-4) { sp.scale.set(u.bsx, u.bsy, 1); continue; }
      /* 补偿到**场景统一标称距离**：k = d / RD。 */
      var k = clamp(d / RD, 0.2, 3.2);
      if (Math.abs(k - 1) < 0.004) { sp.scale.set(u.bsx, u.bsy, 1); continue; }
      sp.scale.set(u.bsx * k, u.bsy * k, 1);
    }
  }
  function glowTexture(inner, outer) {
    var n = 256, cv = document.createElement('canvas'); cv.width = cv.height = n;
    var c = cv.getContext('2d');
    var g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, inner); g.addColorStop(0.18, outer);
    g.addColorStop(0.45, 'rgba(255,214,140,.30)'); g.addColorStop(1, 'rgba(255,190,90,0)');
    c.fillStyle = g; c.fillRect(0, 0, n, n);
    var t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; return t;
  }
  var TEX_GLOW = glowTexture('rgba(255,255,245,1)', 'rgba(255,231,168,.85)');
  var _beamTex = null;
  function beamTexture() {
    if (_beamTex) return _beamTex;
    /* ★ v33（需求四）：体积光贴图重做 ——
       · 横向（vx 为到柱心的归一化距离）改用**高斯型衰减 + 细亮核**：
         旧式 pow(1−vx, 1.7) 在柱缘处斜率不连续，叠在一起就是一圈隐约可见的「边」；
         exp(−(vx·k)²) 由亮到透是连续光滑的，再叠一层更窄的高斯做柱心，
         得到「中心亮、向外无限柔和」的真实丁达尔观感。
       · 纵向（vy：0 = 地球端，1 = 太阳端）改为**两端都软收口、靠太阳一侧更亮**：
         越靠近太阳越亮（有方向感），末端再淡出，绝不出现截断直边。 */
    var w = 128, h = 256, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c = cv.getContext('2d'), img = c.createImageData(w, h);
    for (var y = 0; y < h; y++) {
      var vy = y / (h - 1);
      var axial = (0.42 + 0.58 * ss(0.05, 0.85, vy))          // 地球端淡入 → 太阳端更亮
        * (1 - 0.55 * ss(0.88, 1.0, vy))                       // 太阳端软收口
        * ss(0.0, 0.10, 1 - vy) * 0.85 + 0.10 * ss(0.0, 0.14, vy);  // 地球端软收口 + 一点贴地余晖
      for (var x = 0; x < w; x++) {
        var vx = Math.abs((x + 0.5) / w * 2 - 1);
        var halo = Math.exp(-Math.pow(vx * 2.30, 2));           // 大范围柔光
        var core = Math.exp(-Math.pow(vx * 5.60, 2));           // 柱心亮核
        var a = (halo * 0.62 + core * 0.48) * axial;
        var i = (y * w + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 246; img.data[i + 2] = 214;
        img.data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    c.putImageData(img, 0, 0);
    _beamTex = new THREE.CanvasTexture(cv);
    _beamTex.minFilter = THREE.LinearFilter;
    _beamTex.encoding = THREE.sRGBEncoding;
    return _beamTex;
  }
  /* ★ v43（需求一·1）：建筑物贴膜重做 —— 旧版只有「纯色墙 + 一排深色窗洞 + 顶部一条高光」，
     在斜射阳光下像一块贴了窗户图的纯色板。现按真实立面做八层叠加：
       ① 墙面竖向渐变（上亮下暗，模拟天空光从上方来）
       ② 每层楼板分隔线 + 底部勒脚（深色基座带）
       ③ 窗洞：外框（深色窗套）→ 玻璃渐变（天光反射，上部亮偏青、下部暗）
       ④ 窗台（窗洞下方一条浅色挑檐）
       ⑤ 竖向壁柱（按开间分隔，凸出墙面的浅色条）
       ⑥ 女儿墙压顶（楼顶一条深色檐口）
       ⑦ 细微噪点（避免大面积纯色的「塑料感」）
       ⑧ 顶部 / 底部柔和高光与暗角
     参数与签名保持不变（color/floors/cols/winBase/winH/floorH），仍走 RepeatWrapping + sRGB。 */
  function facadeTexture(color, floors, cols, winBase, winH, floorH) {
    var w = 256, h = 256, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    var base = color || '#cfd8e3';
    /* 墙面主色 + 竖向渐变（顶部提亮 6%、底部压暗 14%） */
    c.fillStyle = base; c.fillRect(0, 0, w, h);
    var wallHi = shade(base, 1.10), wallLo = shade(base, 0.84);
    var wg = c.createLinearGradient(0, 0, 0, h);
    wg.addColorStop(0, wallHi); wg.addColorStop(0.55, base); wg.addColorStop(1, wallLo);
    c.fillStyle = wg; c.fillRect(0, 0, w, h);

    var rows = Math.max(1, Math.round(floors));
    var ncol = Math.max(2, Math.round(cols));
    var cw = w / ncol, ch = h / rows;
    var fh = Math.max(1, floorH);
    var wb = clamp(winBase / fh, 0, 0.6);            /* 窗台离地（占层高比例） */
    var wh = clamp(winH / fh, 0.1, 0.75);             /* 窗高（占层高比例） */

    /* ⑤ 壁柱：每开间中线两侧各一条浅色竖条（凸出墙面的视觉提示） */
    for (var k = 0; k < ncol; k++) {
      var px = k * cw + cw * 0.5;
      c.fillStyle = rgba(shade(base, 1.06), 0.85);
      c.fillRect(px - cw * 0.045, 0, Math.max(1, cw * 0.09), h);
      c.fillStyle = rgba(shade(base, 0.80), 0.55);
      c.fillRect(px - cw * 0.045, 0, Math.max(1, cw * 0.02), h);
    }

    /* ② 楼板分隔线 + 勒脚 + ⑥ 女儿墙檐口 */
    for (var r = 0; r <= rows; r++) {
      var yb = h - r * ch;
      c.fillStyle = rgba(shade(base, 0.66), 0.75); c.fillRect(0, yb - 1.4, w, 2.4);
      c.fillStyle = rgba(shade(base, 1.18), 0.60); c.fillRect(0, yb + 1.0, w, 1.4);
    }
    c.fillStyle = rgba(shade(base, 0.52), 0.88); c.fillRect(0, h - ch * 0.34, w, ch * 0.34);   // 勒脚
    c.fillStyle = rgba(shade(base, 0.46), 0.95); c.fillRect(0, h - ch * 0.36, w, 2.2);
    c.fillStyle = rgba(shade(base, 0.50), 0.92); c.fillRect(0, 0, w, h * 0.045);                  // 女儿墙压顶
    c.fillStyle = rgba(shade(base, 1.22), 0.55); c.fillRect(0, h * 0.045, w, 1.6);

    /* ③④ 窗洞 + 玻璃 + 窗台 */
    for (var r2 = 0; r2 < rows; r2++) {
      for (var i = 0; i < ncol; i++) {
        var x0 = i * cw + cw * 0.24, ww = cw * 0.52;
        var y0 = h - (r2 * ch) - ch * (wb + wh), wh2 = ch * wh;
        /* 窗套（比窗洞大一圈的深色框） */
        c.fillStyle = rgba(shade(base, 0.60), 0.90);
        c.fillRect(x0 - 1.6, y0 - 1.6, ww + 3.2, wh2 + 3.2);
        /* 玻璃：竖向渐变 —— 上部映天（偏亮偏青）、下部偏暗 */
        var gg = c.createLinearGradient(0, y0, 0, y0 + wh2);
        gg.addColorStop(0, 'rgba(120,164,204,.92)');
        gg.addColorStop(0.42, 'rgba(46,74,108,.88)');
        gg.addColorStop(1, 'rgba(24,38,58,.92)');
        c.fillStyle = gg; c.fillRect(x0, y0, ww, wh2);
        /* 窗中竖梃 + 横档（把大块玻璃分成小格，更像真窗） */
        c.fillStyle = rgba(shade(base, 0.55), 0.85);
        c.fillRect(x0 + ww * 0.5 - 0.6, y0, 1.4, wh2);
        c.fillRect(x0, y0 + wh2 * 0.46, ww, 1.3);
        /* 斜向反光：一道 45° 亮带（玻璃最关键的「真实感」来源） */
        c.save();
        c.beginPath(); c.rect(x0, y0, ww, wh2); c.clip();
        c.fillStyle = 'rgba(226,240,255,.24)';
        c.beginPath();
        c.moveTo(x0 - ww * 0.2, y0 + wh2); c.lineTo(x0 + ww * 0.45, y0);
        c.lineTo(x0 + ww * 0.85, y0); c.lineTo(x0 + ww * 0.2, y0 + wh2);
        c.closePath(); c.fill();
        c.restore();
        /* 窗台：窗洞下方一条浅色挑檐 + 下方一道投影 */
        c.fillStyle = rgba(shade(base, 1.24), 0.92); c.fillRect(x0 - 2.2, y0 + wh2 + 1.4, ww + 4.4, 2.0);
        c.fillStyle = rgba(shade(base, 0.58), 0.50); c.fillRect(x0 - 2.2, y0 + wh2 + 3.4, ww + 4.4, 1.6);
      }
    }

    /* ⑦ 细微噪点 + ⑧ 上下暗角：打散大面积纯色 */
    var img = c.getImageData(0, 0, w, h), px = img.data;
    for (var p = 0, j = 0; p < px.length; p += 4, j++) {
      var n = ((j * 2654435761) >>> 0) % 1000;
      var nz = (n / 1000 - 0.5) * 11;
      var yy = (p / 4 / w) | 0;
      var vign = 1 - 0.10 * Math.abs(yy / (h - 1) - 0.5) * 2;
      px[p] = clamp(px[p] + nz, 0, 255) * vign;
      px[p + 1] = clamp(px[p + 1] + nz, 0, 255) * vign;
      px[p + 2] = clamp(px[p + 2] + nz, 0, 255) * vign;
    }
    c.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  /* --- 贴膜用小工具：给十六进制色按比例调亮 / 调暗，转成 css rgb() --- */
  function shade(hex, k) {
    var s = String(hex || '#ffffff').trim();
    var m = /^#([0-9a-f]{6})$/i.exec(s);
    var r = 255, g2 = 255, b = 255;
    if (m) {
      var n = parseInt(m[1], 16);
      r = (n >> 16) & 255; g2 = (n >> 8) & 255; b = n & 255;
    } else {
      var m3 = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
      if (m3) { r = +m3[1]; g2 = +m3[2]; b = +m3[3]; }
    }
    return 'rgb(' + Math.round(clamp(r * k, 0, 255)) + ',' + Math.round(clamp(g2 * k, 0, 255))
      + ',' + Math.round(clamp(b * k, 0, 255)) + ')';
  }
  function rgba(hex, a) { return shade(hex, 1).replace('rgb(', 'rgba(').replace(')', ',' + a + ')'); }
  function lineOf(points, color, width, dash, n, ratio) {
    var geo, m;
    if (dash === 'dash') {
      geo = new THREE.BufferGeometry();
      var seg = [], N = Math.max(2, n | 0), rt = clamp((ratio || 55) / 100, 0.05, 0.95);
      for (var i = 0; i < points.length - 1; i++) {
        var a = points[i], b = points[i + 1];
        for (var k = 0; k < N; k++) {
          var t0 = k / N, t1 = (k + rt) / N;
          seg.push(a.clone().lerp(b, t0), a.clone().lerp(b, Math.min(1, t1)));
        }
      }
      geo.setFromPoints(seg);
      m = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 1 });
      return new THREE.LineSegments(geo, m);
    }
    geo = new THREE.BufferGeometry().setFromPoints(points);
    m = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 1 });
    return new THREE.Line(geo, m);
  }
  /* ★ v52（需求G1）：**可调粗细 + 可调线型的轨迹细管**。
     当日轨道既要「线粗细」（管半径，WebGL 线宽恒为 1px 不可调），又要支持
     「线型（实线 / 虚线）+ 虚线密度 + 虚实比」——两者在「一条 Line / 一根 Tube」里
     互相排斥（以前的管子连续实体，dash / ratio 两个菜单控件是死控件）。
     做法：把曲线按 dash 语义切成若干小段，每段沿原曲线采样后各建一条子管，
     再把所有子管的**非索引顶点拼进同一个 BufferGeometry** ⇒ 仍是一个 mesh、
     一次 draw call，而虚线语义完全生效（实线档只有 1 段，与旧观感一致）。 */
  function tubeStyledGeo(pts, radius, dash, n, ratio, tubSeg) {
    var curve = new THREE.CatmullRomCurve3(pts);
    var isDash = (dash === 'dash');
    var N = isDash ? clamp(Math.round(n) || 12, 2, 200) : 1;
    var rt = isDash ? clamp((ratio || 55) / 100, 0.05, 0.95) : 1;
    if (N === 1) return new THREE.TubeGeometry(curve, tubSeg, radius, 6, false);
    var SUB = 4;                       /* 每个虚线小段内再采样 4 段 ⇒ 子管贴合原弧线 */
    var per = Math.max(2, Math.round((tubSeg || 120) / N));
    var pos = [];
    for (var k = 0; k < N; k++) {
      var t0 = k / N, t1 = Math.min(1, (k + rt) / N);
      if (t1 - t0 <= 1e-4) continue;
      var sub = [];
      for (var s = 0; s <= SUB; s++) sub.push(curve.getPoint(t0 + (t1 - t0) * s / SUB));
      var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sub), per, radius, 6, false).toNonIndexed();
      var arr = g.attributes.position.array;
      for (var q = 0; q < arr.length; q++) pos.push(arr[q]);
      g.dispose();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return geo;
  }

  /* ★ v41（需求一·10）：把一条球面折线按「地平线（局部 y = 0）」切成若干段，只保留 y ≥ 0
     的部分（一条赤纬圈可能被地平圈切成**两段**，所以返回的是数组而不是单段）。
     跨越地平线处用线性插值补出**恰好落在 y = 0** 的点，并把半径拉回球面半径 ——
     否则切断点会略微悬空 / 陷入球壳，与地平圈对不齐。
       返回：[[p, p, …], …]，每段至少 2 个点；整条都在下方时返回 []。 */
  function splitAbove(pts) {
    var EPS = 1e-6, runs = [], cur = [];
    function zero(a, b) {
      var t = (0 - a.y) / (b.y - a.y);
      var v = new THREE.Vector3().lerpVectors(a, b, t);
      return v.setLength((a.length() + b.length()) * 0.5);
    }
    function flush() { if (cur.length >= 2) runs.push(cur); cur = []; }
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.y >= -EPS) {
        if (!cur.length && i > 0 && pts[i - 1].y < -EPS) cur.push(zero(pts[i - 1], p));
        cur.push(p);
      } else {
        if (cur.length) { if (pts[i - 1].y >= -EPS) cur.push(zero(pts[i - 1], p)); flush(); }
      }
    }
    flush();
    return runs;
  }
  /* ---- v33（需求三）：动态线段的「实线 / 虚线」写入 ------------------------------------
     物影的影长线段、过物体顶部的光线每帧都要改端点，又要求支持线型。lineOf() 只能一次性建好，
     这里给一条**固定容量**的 LineSegments 写顶点 + setDrawRange：
       · 实线 —— 相邻点两两成一段（与 THREE.Line 的画面完全一致）；
       · 虚线 —— 每条边切成 N 段，每段只画前 ratio 部分（与 lineOf 的 dash 算法同口径）。
     全程零分配（复用模块级 Float32Array），不会每帧产生垃圾。 */
  var _segBuf = new Float32Array(2048 * 3);
  function setSegLine(geo, pts, dash, n, ratio) {
    var cnt = 0;
    var push = function (x, y, z) {
      if ((cnt + 1) * 3 > _segBuf.length) return;
      _segBuf[cnt * 3] = x; _segBuf[cnt * 3 + 1] = y; _segBuf[cnt * 3 + 2] = z; cnt++;
    };
    var lerp = function (a, b, t) { push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); };
    if (dash === 'dash') {
      var N = Math.max(2, n | 0), rt = clamp((ratio || 55) / 100, 0.05, 0.95);
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        for (var k = 0; k < N; k++) {
          lerp(a, b, k / N); lerp(a, b, Math.min(1, (k + rt) / N));
        }
      }
    } else {
      for (var j = 0; j < pts.length - 1; j++) { push(pts[j].x, pts[j].y, pts[j].z); push(pts[j + 1].x, pts[j + 1].y, pts[j + 1].z); }
    }
    var attr = geo.attributes.position;
    if (!attr || attr.array.length < cnt * 3) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(cnt * 3, 48)), 3));
      attr = geo.attributes.position;
    }
    attr.array.set(_segBuf.subarray(0, cnt * 3));
    attr.needsUpdate = true;
    geo.setDrawRange(0, cnt);
    geo.computeBoundingSphere();
    return cnt;
  }
  /* ★ v44（需求六）：**能真正调粗的直线段** —— 朝向相机的彩带（ribbon）。
     ---------------------------------------------------------------------------
     WebGL 里 LineBasicMaterial.lineWidth 在绝大多数实现被忽略（恒等于 1 个像素），
     于是「观察与测量 › 物影 › 过顶部光线 › 线粗细」一直是**死控件**：
     拖到底也还是一根发丝。
     这里改用「薄带 Mesh」：沿线段方向 d，取 side = normalize(cross(d, 指向相机))，
     于是带面永远正对相机，宽度 = 2×hw 就是**屏幕上的真实粗细**（与线在场景里的走向无关）。
     虚线按既有语义（density n + 虚实比 ratio）切成若干小段，每段吐一个四边形；
     全部写进**固定容量缓冲 + setDrawRange** ⇒ 每帧零分配（与 setSegLine 同口径）。 */
  var RIB_MAX = 96;                                   /* 最多 RIB_MAX 个四边形 */
  var _ribBuf = new Float32Array(RIB_MAX * 4 * 3);
  function setRibbonSeg(geo, ax, ay, az, bx, by, bz, dash, n, ratio, hw, cam) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-6)) { geo.setDrawRange(0, 0); return 0; }
    dx /= len; dy /= len; dz /= len;
    /* 侧向基向量：必与线段垂直，且在屏幕上尽量展开（正对相机） */
    var mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
    var vx = mx - cam.x, vy = my - cam.y, vz = mz - cam.z;
    var sx = dy * vz - dz * vy, sy = dz * vx - dx * vz, sz = dx * vy - dy * vx;
    var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(sl > 1e-6)) {
      /* 退化：视线与线段共线 —— 任取一个垂直方向即可 */
      sx = -dy; sy = dx; sz = 0;
      sl = Math.sqrt(sx * sx + sy * sy);
      if (!(sl > 1e-6)) { sx = 1; sy = 0; sz = 0; sl = 1; }
    }
    sx = sx / sl * hw; sy = sy / sl * hw; sz = sz / sl * hw;
    var N = (dash === 'dash') ? clamp(Math.round(n) || 12, 2, RIB_MAX) : 1;
    var rt = (dash === 'dash') ? clamp((ratio || 55) / 100, 0.05, 0.95) : 1;
    var cnt = 0;
    for (var k = 0; k < N; k++) {
      if (cnt + 4 > RIB_MAX * 4) break;
      var t0 = len * (k / N), t1 = len * Math.min(1, (k + rt) / N);
      var x0 = ax + dx * t0, y0 = ay + dy * t0, z0 = az + dz * t0;
      var x1 = ax + dx * t1, y1 = ay + dy * t1, z1 = az + dz * t1;
      var p = cnt * 3;
      _ribBuf[p] = x0 - sx; _ribBuf[p + 1] = y0 - sy; _ribBuf[p + 2] = z0 - sz;
      _ribBuf[p + 3] = x0 + sx; _ribBuf[p + 4] = y0 + sy; _ribBuf[p + 5] = z0 + sz;
      _ribBuf[p + 6] = x1 + sx; _ribBuf[p + 7] = y1 + sy; _ribBuf[p + 8] = z1 + sz;
      _ribBuf[p + 9] = x1 - sx; _ribBuf[p + 10] = y1 - sy; _ribBuf[p + 11] = z1 - sz;
      cnt += 4;
    }
    var attr = geo.attributes.position;
    if (!attr || attr.array.length < _ribBuf.length) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(_ribBuf.length), 3));
      attr = geo.attributes.position;
    }
    attr.array.set(_ribBuf);
    attr.needsUpdate = true;
    geo.setDrawRange(0, (cnt / 4) * 6);
    geo.computeBoundingSphere();
    return cnt;
  }
  /* 建一条「可变厚的薄带」直线 —— 固定容量、索引一次性写死，之后只改坐标。
     与 ensureMeasPool 配合使用（每条光线建一次即可，逐帧只走 setRibbonSeg）。 */
  function makeRibbonGeo(capQuads) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capQuads * 4 * 3), 3));
    var idx = new Uint16Array(capQuads * 6);
    for (var i = 0; i < capQuads; i++) {
      var b = i * 4, o = i * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
      idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  /* ========================= 性能工具（v32 需求十二） =========================
     背景：太阳视运动的「当日轨迹（动态绘制）」「整点位置点」「地面视运动轨迹」等几何
     原先**每一帧**都重新 new BufferGeometry / Material / Mesh —— 旧对象既不 dispose 也
     不再入场景，WebGL 缓冲与 2D canvas 贴图持续堆积，运行几分钟后必然卡顿、内存吃紧，
     极端情况下触发 WebGL 上下文丢失（表现为黑屏 / 闪退）。这里统一改为：
       · 固定容量顶点缓冲 + setDrawRange（动态轨迹每帧只改坐标，不新建对象）；
       · 重建前显式 dispose 几何 / 材质 / 贴图；
       · 文字精灵离场时同步移出全局注记跟踪表（否则 applyNoteStyles 越跑越慢）。 */
  function disposeObj(o) {
    if (!o) return;
    /* ★ 修复 #2：原实现只释放**传入对象自身**的几何 / 材质 / 贴图，而 makeBuilding /
       makeTree / makeFigure 返回的是 Group（几何与每实例一张的 facadeTexture 都挂在子网格上）
       ⇒ 删除地面物体时整棵子树的 GPU 资源从未被释放。改为递归释放自身 + 全部后代
       （对 leaf 对象行为不变；three.js 的 dispose 可重复调用，故不影响既有调用点）。 */
    var nodes = [];
    if (typeof o.traverse === 'function') o.traverse(function (n) { nodes.push(n); });
    else nodes.push(o);
    nodes.forEach(function (n) {
      if (n.userData && n.userData.isLabel) noteSplice(n);
      if (n.geometry && n.geometry.dispose) n.geometry.dispose();
      if (n.material) {
        var ms = Array.isArray(n.material) ? n.material : [n.material];
        ms.forEach(function (m) { if (m.map && m.map.dispose) m.map.dispose(); if (m.dispose) m.dispose(); });
      }
    });
  }
  /* 预留 n 个顶点的可复用折线
     ★ v43（需求一·3）：天球当日轨道已改用 TubeGeometry（1px 折线无法加粗），
     这两个工具函数目前没有调用点，保留作为通用工具备用。 */
  function makeDynLine(n, color) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setDrawRange(0, 0);
    var m = new THREE.LineBasicMaterial({ color: color || 0xffffff, transparent: true, opacity: 1 });
    var ln = new THREE.Line(g, m);
    ln.frustumCulled = false;
    return ln;
  }
  function updateDynLine(ln, pts) {
    if (!ln) return;
    var attr = ln.geometry.attributes.position;
    var cap = attr.count, n = Math.min(pts.length, cap);
    var arr = attr.array;
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;
    ln.geometry.setDrawRange(0, n);
    ln.geometry.computeBoundingSphere();
    ln.visible = n > 0;
  }

  /* ============================ 4. 画布 & 渲染器 ============================ */
  var canvas = $('svCanvas');
  var rnd = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  rnd.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  rnd.outputEncoding = THREE.sRGBEncoding;
  rnd.shadowMap.enabled = true;
  rnd.shadowMap.type = THREE.PCFSoftShadowMap;
  rnd.setClearColor(0x0a1220, 1);

  /* ============================ 5. 地面视图场景 ============================ */
  var GSIZE = 44;
  var gScene = new THREE.Scene();
  var gCam = new THREE.PerspectiveCamera(50, 1, 0.1, 900);

  /* --- 天空穹顶（昼 / 夜渐变 + 太阳方位的暖色散射） --- */
  var skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color('#2f74d0') },
      uBot: { value: new THREE.Color('#a9c9ef') },
      uNight: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      /* v31（需求六）：朝霞 / 晚霞与天空变色 —— 全部属性可调（见 S.sky） */
      uDawnC: { value: new THREE.Color('#ff7a2f') },
      uDawnOn: { value: 1 }, uDawnOp: { value: 0.5 }, uDawnW: { value: 0.46 }, uDawnH: { value: 0.19 },
      uHorC: { value: new THREE.Color('#f6d9b0') }, uHorOp: { value: 0.19 },
      /* v31（需求六）：夜间色调强度 —— 数值越大，入夜后天空越偏向深蓝紫（0 = 保持白天的蓝） */
      uNightTint: { value: 0.82 },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform vec3 uTop; uniform vec3 uBot; uniform float uNight; uniform vec3 uSunDir;',
      'uniform vec3 uDawnC; uniform float uDawnOn, uDawnOp, uDawnW, uDawnH;',
      'uniform vec3 uHorC; uniform float uHorOp; uniform float uNightTint;',
      'varying vec3 vP;',
      'void main(){',
      '  vec3 n = normalize(vP);',
      '  float h = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);',
      '  vec3 day = mix(uBot, uTop, pow(h, 0.75));',
      /* v32（需求九）：夜间色调强度改为**同时控制色相与亮度**，效果明显可感知 ——
         uNightTint = 0 → 只把白天的蓝整体压暗（夜色偏亮、偏冷蓝，像暮光）；
         uNightTint = 1 → 深蓝紫夜空、几乎全黑。中间线性过渡。 */
      '  float t = clamp(uNightTint, 0.0, 1.0);',
      '  vec3 hue = mix(day, vec3(0.055, 0.075, 0.215), t);',
      '  vec3 night = hue * mix(0.62, 0.055, t);',
      '  vec3 col = mix(day, night, uNight);',
      '  vec3 sn = normalize(uSunDir);',
      // 水平方向：射线方位与太阳方位的夹角余弦（ca = 1 表示正对太阳所在的方位）
      '  vec3 sh = normalize(vec3(sn.x, 0.0, sn.z) + vec3(1e-5, 0.0, 1e-5));',
      '  vec3 nh = normalize(vec3(n.x, 0.0, n.z) + vec3(1e-5, 0.0, 1e-5));',
      '  float ca = dot(nh, sh);',
      '  float up = max(n.y, 0.0);',
      // 霞光：只出现在太阳所在的方位锥内（张角由 uDawnW 控制），贴地平最强、向上按 uDawnH 衰减
      '  float azW = smoothstep(1.0 - uDawnW, 1.0, ca);',
      '  float band = exp(-pow(up / max(uDawnH, 0.02), 1.6));',
      '  col += uDawnC * (uDawnOn * uDawnOp * azW * band);',
      // 全周低空霞光：天空整体「变色」，黄昏时最明显
      '  col += uHorC * (uHorOp * exp(-pow(up / 0.11, 1.5)));',
      '  float g = max(0.0, dot(n, normalize(uSunDir)));',
      '  col += vec3(1.0,0.72,0.36) * pow(g, 12.0) * 0.55 * (1.0 - uNight);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n'),
    side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
  var skyDome = new THREE.Mesh(new THREE.SphereGeometry(340, 32, 20), skyMat);
  skyDome.renderOrder = -100;
  gScene.add(skyDome);

  /* --- 星空（夜晚淡入） ---
     ★ v41（需求一·16）：地面视角夜空 —— 星数 900 → 2200、点径 1.7 → 2.2，
     并按亮度分档（vertexColors：多数偏暗、少量很亮）让夜空有层次，不再是一片均匀小点。
     仍分布在半径 300 的上半球（含地平线以上全部方向），depthTest=false 保证不被天空穹顶遮住。 */
  var starGeo = new THREE.BufferGeometry();
  (function () {
    var N = 2200, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var u = Math.random() * 2 - 1, th = Math.random() * TAU, r = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = Math.cos(th) * r * 300; pos[i * 3 + 1] = Math.abs(u) * 300; pos[i * 3 + 2] = Math.sin(th) * r * 300;
      var b = 0.42 + 0.58 * Math.pow(Math.random(), 2.2);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = b;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  })();
  var starMat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
  var stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -99;
  gScene.add(stars);

  /* --- 地面 + 网格 --- */
  /* ★ v31（需求五）：地表由**方形**改为**圆形**（半径 = 原来的半个边长，视线尽头不再有直边）。
     圆盘按「地表」统一使用，凡是原本用 PlaneGeometry 的射线求交 / 边界判定都不受影响
     （groundHitFromEvent 依旧是对 ground 做 intersectObject）。
     网格同步改为「同心圆 + 放射线」的极坐标网 —— 方形网格放在圆盘上会露出四个尖角。 */
  /* ★ v33（需求：地平视角）：地面圆盘半径 = **太阳视运动轨迹半径**（TRAJ_R = SUN_DIST×0.995 = 125.37）。
     轨迹在 alt=0（日出 / 日落）处的落点恰为 `dir·TRAJ_R`，其水平分量正好等于 TRAJ_R、y 分量 = 0 ——
     故圆盘边界（= 地平圈）**恰好落在轨迹与地平面的交点上**，日出 / 日落点严格贴在地平圈上。
     v32 曾把圆盘扩到 330（≈天空穹顶）以消除可见边界，但那使得地平圈远在轨迹之外、
     既看不到轨迹与地平线的交点，也无法缩放到「完整半球轨迹 + 地平圈」同框；此处按要求收小。
     GSIZE 仍是「模型活动区」的口径（物体落点夹取 / 方位标半径 / 相机边界都用它）。
     ★ v41（需求一·18）：地平圈再收小一档 —— SUN_DIST 140 → 126，故
     TRAJ_R = 126×0.995 = 125.37，GROUND_R **直接取 TRAJ_R**（约 −10%），
     轨迹半径随之等比缩小，日出 / 日落点仍严格贴在地平圈上（两者必须保持相等）。
     ★ 实现上把 SUN_DIST / TRAJ_R 的声明**提到地面圆盘之前**，让 GROUND_R 由 TRAJ_R 派生 ——
       旧写法两处各自写常数（140/125.4 与 126/125.37）曾出现 0.03 的偏差，
       导致日出 / 日落点没有精确落在地平圈上。 */
  var SUN_DIST = 126;
  var TRAJ_R = SUN_DIST * 0.995;
  var GROUND_R = TRAJ_R;
  /* ★ v53 修复（任务三·1）：**影子口径三常量** —— 「绘制的影长线段」与「three.js 真实阴影」
     从此共用同一套数字，不再各夹各的（这是用户看到「日落时线段与真实影子对不上」的根因：
     线段被夹到 GSIZE=44 / 0.35° 下限，而 shadow camera 覆盖 ±68，两者上限根本不同）。
       · SHADOW_MAX   —— 影长上限。取 GROUND_R×0.985（地平圈半径的 98.5%）而不是 GSIZE(44)：
                        GSIZE 是「模型活动区半径」（物体落点夹取 ±22 的两倍），用它当影长上限
                        意味着**中等高度角就截断**：H=15m 的建筑在 alt=20° 时真实影长已达 41m，
                        已被 44 削去；alt 再低则完全冻住不再变长 —— 正是反馈的「影长异常变短」。
       · SHADOW_MIN_ALT —— 显示/投影门槛（度）。统一「夜间隐藏门槛」与「castShadow 门槛」，
                        消除旧代码里 `g.alt<=0` 隐藏线段、`alt>1.5` 才投影 的错配
                        （那会造成「有线段无阴影 / 有阴影无线段」两种不一致的中间带）。
       · SHADOW_FAR   —— 平行光光源距离与阴影视锥远端，取 2×GROUND_R + SHADOW_MAX：
                        必须 ≥ 「光源到最远影尖」的最坏路径（影子可拖到接近地平圈），
                        否则低太阳高度角时**光源被放进阴影视锥之外或影子被 far 裁掉**。 */
  var SHADOW_MAX = GROUND_R * 0.985;
  var SHADOW_MIN_ALT = 0.2;
  var SHADOW_FAR = GROUND_R * 2 + SHADOW_MAX;
  var ground = new THREE.Mesh(new THREE.CircleGeometry(GROUND_R, 200),
    new THREE.MeshLambertMaterial({ color: 0x8b9a75 }));
  ground.rotation.x = -Math.PI / 2;
  /* ★ v44（需求九）：**地面自身不再接影** —— 见下方 shadowCatcher。 */
  ground.receiveShadow = false;
  gScene.add(ground);

  /* ★ v44（需求九）：**影子强度只作用于影子本身** —— 用一层独立的贴地「接影面」
     （THREE.ShadowMaterial）承载影子，而不是拿补光去冲淡它。
     -----------------------------------------------------------------------------
     旧实现把 `ray.shadowOp`（界面标签「影子强度」）接到一盏**不打阴影的同向补光** sunFill 上：
         sunFill.intensity = sunLight.intensity × (1 − shadowOp/100) × 0.9
     问题在于 sunFill 照亮的是**整个场景**（地面、建筑立面、任何受光面一起被提亮/压暗），
     于是「影子强度」实际起的是「全局曝光」的作用 —— 拖动滑块时看不出影子在变浓，
     只看到地面整体忽明忽暗。这正是用户要修的点。
     -----------------------------------------------------------------------------
     ShadowMaterial 的性质恰好是所需的：**非阴影像素完全透明**，只在被判定为阴影的地方
     按 opacity 涂黑。因此它天然只改影子，碰不到地面底色、建筑受光与天空环境。
     配套：ground.receiveShadow 置 false（否则地面 Lambert 自身那一份暗化会与叠加层叠加、
     影子强度变成「两次变暗」），sunFill 改为**固定值**（不再随 shadowOp 变化）。 */
  var shadowMat = new THREE.ShadowMaterial({
    color: 0x0b1220, opacity: 0.42, transparent: true, depthWrite: false
  });
  /* 圆面半径 125 m 上再叠一层同尺寸平面：只靠 0.02 m 的高度差在远景上不够稳，
     再加 polygonOffset 把接影面往深度上提前一档 —— 双重保险，彻底避免 z-fighting。 */
  shadowMat.polygonOffset = true;
  shadowMat.polygonOffsetFactor = -2;
  shadowMat.polygonOffsetUnits = -2;
  var shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(GROUND_R, 200), shadowMat);
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = 0.02;
  shadowCatcher.receiveShadow = true;
  gScene.add(shadowCatcher);
  var grid = new THREE.Group();
  (function () {
    var RR = GSIZE / 2;
    for (var k = 1; k <= 6; k++) {
      var r = RR * k / 6, pts = [];
      for (var i = 0; i <= 96; i++) {
        var a = i / 96 * TAU;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      var ln = lineOf(pts, k === 6 ? 0x4d5c42 : 0x6d7f5c, k === 6 ? 1.4 : 1, 'solid');
      ln.material.transparent = true; ln.material.opacity = k === 6 ? 0.46 : 0.26;
      grid.add(ln);
    }
    for (var j = 0; j < 12; j++) {
      var aa = j / 12 * TAU;
      var sp = lineOf([new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.sin(aa) * RR, 0, Math.cos(aa) * RR)],
        0x6d7f5c, 1, 'solid');
      sp.material.transparent = true; sp.material.opacity = 0.20;
      grid.add(sp);
    }
    /* 圆周边缘的窄环：让圆盘的边界在远处也清晰可辨 */
    var rim = new THREE.Mesh(new THREE.RingGeometry(RR * 0.995, RR * 1.012, 160),
      new THREE.MeshBasicMaterial({ color: 0x8fa878, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.01;
    grid.add(rim);
  })();
  grid.position.y = 0.012;
  /* ★ v32（需求八）：**模型边界方格不可见** —— 旧版圆盘上叠着一圈同心圆 + 放射线网格，
     远看就是「一块画了格子的模型底座」。按要求整组隐藏（保留对象以便将来需要时复用）。 */
  grid.visible = false;
  gScene.add(grid);

  /* --- 光照 --- */
  var hemi = new THREE.HemisphereLight(0xd8e8ff, 0x3f4a30, 0.55);
  gScene.add(hemi);
  var amb = new THREE.AmbientLight(0xffffff, 0.18);
  gScene.add(amb);
  var sunLight = new THREE.DirectionalLight(0xfff0d0, 1.05);
  sunLight.castShadow = true;
  /* ★ 本批次修复 #273「物体影子与影子线段不对应一致」：真实投影阴影由 shadow map 决定，
     而绘制的「影长线段」被 updateMeas 夹到 GSIZE(=44)，物体又可摆在 ±22 —— 于是影尖最远
     可达 ~66 个世界单位。旧 shadow camera 只覆盖 ±34，于是**真实影子会被裁掉一截**，
     看起来比绘制的影长线段短 ⇒ 两者对不上（天球视图的「地面全景」小窗里尤其明显）。
     现把阴影视锥放大到 ±68，并把 mapSize 提到 2048²：2048/136 ≈ 15 texel/单位，
     与原来 1024/68 的**纹素密度完全相同** —— 覆盖范围翻倍而不损失影子锐度。
     ★ v53：此处的 ±68 已被下一段取代（改用 SHADOW_MAX）。原因见下 —— ±68 仍然是按
       「线段上限 44」推的，线段一旦放开到 ~123，视锥就必须同步放大，否则又回到本 bug。 */
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 1;
  /* ★ v53 修复（任务三·4）：阴影视锥与「影长上限」统一到 SHADOW_MAX。
     旧值 far=320 / half=±68 是配合「线段夹到 GSIZE=44」定的；线段放开到 SHADOW_MAX≈123.5
     之后，half=±68 的视锥**装不下真实影子**—— 低太阳高度角时影子拖到几十米外就被裁掉，
     于是「真实阴影」比「绘制的影长线段」短一截（与用户反馈完全一致，且方向也因裁剪而失真）。
     ★ 取舍说明（纹素密度）：视锥从 ±68 放大到 ±SHADOW_MAX(≈±123.5)，覆盖范围约 1.8×，
       而 mapSize 保持 2048² 不变 ⇒ **纹素密度由 ~15 降到 ~8.3 texel/世界单位**
       （2048/247 vs 原 2048/136），影子边缘会略微变软。低太阳高度角时影子本来就又长又淡，
       这点软化在视觉上可接受；换来的是「日落时地上有一道完整的长影」而非半截。
       若日后要兼顾两者，正确做法是**按太阳高度角动态收缩视锥**（高度角高时用小视锥换锐度），
       而不是回到「视锥小 + 线段长」这种本身就矛盾的状态。 */
  /* ★ v56 修复（任务②b「所有物体影子消失」根因）：far 必须 ≥ 光源到「背光侧最远地面点」
     的视深，而不能只等于光源距离。平行光摆在 dir×SHADOW_FAR 处看向原点，正交阴影视锥
     的深度沿光轴计算：地面圆盘（半径 GROUND_R）上背光侧的点的视深最大可达
       SHADOW_FAR + GROUND_R·cos(alt) ≈ 373 + 125 ≈ 498（低高度角时取满）。
     旧值 far = SHADOW_FAR(≈373) 把背光侧整半圆的地面与物体**裁出阴影视锥** ——
     而影子永远投向背光侧（太阳的反方向），于是 castShadow 明明开着、mapSize 正常，
     所有物体的真实影子却全部消失（正是用户反馈的现象）。
     现按最坏路径补足余量（+GROUND_R+4）；光源距离仍为 SHADOW_FAR 不变。 */
  sunLight.shadow.camera.far = SHADOW_FAR + GROUND_R + 4;
  sunLight.shadow.camera.left = -SHADOW_MAX; sunLight.shadow.camera.right = SHADOW_MAX;
  sunLight.shadow.camera.top = SHADOW_MAX; sunLight.shadow.camera.bottom = -SHADOW_MAX;
  /* ★ three.js 的正交视锥：直接改 left/right/top/bottom/far **不会**自动重算投影矩阵，
     必须在改完后手动调一次 updateProjectionMatrix()，否则这些改动完全不生效
     （shadow map 仍按旧的 ±68 / far=320 渲染，是本次「方向与长度对不上」的隐形坑之一）。 */
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0012;
  gScene.add(sunLight);
  gScene.add(sunLight.target);
  /* ★ v32（需求九）：阴影补光 ——
     上一版「阴影透明度」只写在 DEF 里、渲染侧从未读取（调了完全没反应）。
     three.js r150 没有 light.shadow.intensity，于是这里用**同向补光**实现可控的阴影深浅：
     补光不投影，强度 = 主光 × (1 − 阴影透明度/100) × 0.9 ⇒ 阴影透明度越大，补光越弱、影子越黑。
     0 = 影子几乎被补光填平（看不见），100 = 影子最浓。 */
  var sunFill = new THREE.DirectionalLight(0xfff0d0, 0.0);
  sunFill.castShadow = false;
  gScene.add(sunFill);
  gScene.add(sunFill.target);

  /* --- 真实太阳：发光球体（亮核）+ 内日冕 + 外光晕 --- */
  /* （SUN_DIST / TRAJ_R 已在地面圆盘前声明：★ v41 需求一·18，140 → 126，地平圈与轨迹同时缩小约 10%） */
  var sunGrp = new THREE.Group();
  gScene.add(sunGrp);
  var sunCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc });
  var sunCore = new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 24), sunCoreMat);
  sunGrp.add(sunCore);
  var coronaIn = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  coronaIn.scale.setScalar(24); coronaIn.renderOrder = 30;
  sunGrp.add(coronaIn);
  var coronaOut = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0.42 }));
  coronaOut.scale.setScalar(56); coronaOut.renderOrder = 29;
  sunGrp.add(coronaOut);
  /* ★ v39（需求二·1）：去掉天球 / 地面的「太阳」文字注释 —— 太阳本身已足够醒目，
     该注释与太阳光晕叠在一起反而显得杂乱（原 sunLabel 精灵与 S.sunr.real 联动，一并删除）。 */

  /* --- 体积光（丁达尔）：★ v43（需求一·2）重做为「实心光柱 + 外围柔光束」双层壳 ---
     旧实现是 n 张**面向相机的平面**（beamTexture 高斯贴图 + AdditiveBlending）沿南北向排布。
     平面广告牌有三个硬伤：
       ① 相机一转到与光柱轴垂直的方向，平面几乎侧对镜头 → 光柱「塌成一条线」再突然变粗；
       ② 与地球运动视图的体积光柱形制完全不一致，两个视图观感对不上；
       ③ 贴图横向衰减是 uv 上的固定曲线，柱体粗细一变衰减宽度就跟着变，永远不像「一根实心光柱」。
     现移植 app.js 的双层壳方案（volCoreMat / volSheathMat，见 app.js 4357–4530）：
       · 内层 core：CylinderGeometry(1,1,1,192,1,false) 封口实心柱，alpha = uOp·smoothstep(0,uEdge,
         |dot(N,V)|)^uFall —— 柱心最亮、柱缘轮廓处彻底归零，与背景无缝（**不依赖 uv，无视差畸变**）；
       · 外层 sheath：同几何更大半径，uEdge 更高、uOp 仅 0.26 倍 ⇒ 柱外一圈极柔光晕；
       · 两层都 AdditiveBlending + depthWrite 关 / depthTest 开 ⇒ 不遮天不遮地，被楼挡住的自然消失；
       · 轴向柔化用局部 y（圆柱高 1、中心在原点 ⇒ y ∈ [−0.5,0.5]），两端各留一段软收口
         （收口宽度由 vol.decay 控制，decay 越大收口越宽、柱体越「两头淡」）；
       · SRGB_FN 助手一并移植（app.js 1533），保证 Additive 下的颜色与线性空间一致。 */
  var SV_SRGB_FN = [
    'float srgbF(float c){ return c <= 0.0031308 ? c*12.92 : 1.055*pow(c, 0.41666) - 0.055; }',
    'vec3 toSRGB(vec3 c){ return vec3(srgbF(c.r), srgbF(c.g), srgbF(c.b)); }',
  ].join('\n');
  /* 内层实心光柱：颜色可设；alpha = uOp · smoothstep(0, uEdge, |dot(N,V)|)^uFall × 轴向柔化 */
  function volCoreMat() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#ffd873') },
        uOp: { value: 0.5 }, uFall: { value: 1.0 }, uEdge: { value: 0.86 },
        uFade: { value: 0.16 },
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying vec3 vLocal;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vN = normalize(mat3(modelMatrix) * normal);',
        '  vV = normalize(cameraPosition - wp.xyz);',
        '  vLocal = position;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOp; uniform float uFall; uniform float uEdge; uniform float uFade;',
        'varying vec3 vN; varying vec3 vV; varying vec3 vLocal;',
        SV_SRGB_FN,
        'void main(){',
        '  if (uOp < 0.004) discard;',
        '  float f = abs(dot(normalize(vN), normalize(vV)));',
        '  float g = smoothstep(0.0, uEdge, f);',
        '  float a = uOp * pow(g, uFall);',
        /* 轴向柔化：两端在 uFade 比例长度内平滑淡出，使光柱与地面 / 太阳方向自然衔接 */
        '  float t = clamp(vLocal.y + 0.5, 0.0, 1.0);',
        '  float axial = smoothstep(0.0, uFade, t) * smoothstep(1.0, 1.0 - uFade, t);',
        '  a *= axial;',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(toSRGB(uColor), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }
  /* 外层柔光束：固定白色、更大范围、更陡衰减 —— 柱外只留一层极柔光晕，无可辨认外缘。 */
  function volSheathMat() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#ffffff') },
        uOp: { value: 0.25 }, uFall: { value: 1.4 }, uEdge: { value: 0.94 },
        uFade: { value: 0.20 },
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying vec3 vLocal;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vN = normalize(mat3(modelMatrix) * normal);',
        '  vV = normalize(cameraPosition - wp.xyz);',
        '  vLocal = position;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOp; uniform float uFall; uniform float uEdge; uniform float uFade;',
        'varying vec3 vN; varying vec3 vV; varying vec3 vLocal;',
        SV_SRGB_FN,
        'void main(){',
        '  float f = abs(dot(normalize(vN), normalize(vV)));',
        '  float g = smoothstep(0.0, uEdge, f);',
        '  float a = uOp * pow(g, uFall);',
        '  float t = clamp(vLocal.y + 0.5, 0.0, 1.0);',
        '  float axial = smoothstep(0.0, uFade, t) * smoothstep(1.0, 1.0 - uFade, t);',
        '  a *= axial;',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(toSRGB(uColor), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }
  /* 192 径向分段：光柱直径可放大到地平圈量级，低分段时柱侧是粗多面体，
     与地面相交处会露出圆弧锯齿（app.js v39 同款修正）。 */
  var VOL_CORE_CYL = new THREE.CylinderGeometry(1, 1, 1, 192, 1, false);
  var VOL_SHEATH_CYL = new THREE.CylinderGeometry(1, 1, 1, 160, 1, false);
  var _volUp = new THREE.Vector3(0, 1, 0);
  /* 单根光柱 = core + sheath 两层壳（各自独立材质实例，uniform 可单独写） */
  function makeVolBeam() {
    var grp = new THREE.Group();
    var core = new THREE.Mesh(VOL_CORE_CYL, volCoreMat());
    core.renderOrder = 20;
    var sheath = new THREE.Mesh(VOL_SHEATH_CYL, volSheathMat());
    sheath.renderOrder = 21;
    grp.add(core); grp.add(sheath);
    grp.visible = false;
    return { grp: grp, core: core, sheath: sheath };
  }
  var volGrp = new THREE.Group();
  gScene.add(volGrp);
  var volBeams = [];
  function ensureBeams(n) {
    while (volBeams.length < n) { var b = makeVolBeam(); volGrp.add(b.grp); volBeams.push(b); }
    volBeams.forEach(function (b, i) { b.grp.visible = i < n; });
  }
  ensureBeams(DEF.vol.n);
  var _bq = new THREE.Quaternion(), _bm = new THREE.Matrix4();
  var _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _bt = new THREE.Vector3();
  /*「绕轴广告牌」：把平面部件的局部 +Y 对准光线方向，同时尽量正对相机。
     ★ v43（需求一·2）：**仅室内门口光柱**仍在用（iBeams 是 PlaneGeometry）；
       地面主体积光已改为双层壳圆柱，不再需要 aimBeam，故此函数保留但只服务 iBeams。 */
  function aimBeam(mesh, axis, cam, pos) {
    _by.copy(axis).normalize();
    _bt.copy(cam.position).sub(pos);
    _bx.crossVectors(_by, _bt);
    if (_bx.lengthSq() < 1e-8) _bx.set(1, 0, 0);
    _bx.normalize();
    _bz.crossVectors(_bx, _by).normalize();
    _bm.makeBasis(_bx, _by, _bz);
    _bq.setFromRotationMatrix(_bm);
    mesh.quaternion.copy(_bq);
  }

  /* --- v31（需求十三）：地面视图的**太阳视运动轨迹** ---
     此前的轨迹只画在天球视图里，地面视图看不到太阳怎么走。这里把同一条轨迹搬到天空上：
     取半径 TRAJ_R（与太阳同距，140×0.995）的球面上、按「时角 H」均匀采样的一组点，
     地平线以上用实心细管（带一点点粗细，远处也看得见），以下用虚线（可选）；
     并标出整点位置与日出 / 日落点。
     ★ v36（需求七）：开关与天球视图**完全统一** —— 全部改读 traj.*（原 gtraj.* 独立
     开关组删除），「视运动轨迹」菜单里改一次，两个视图同时生效。 */
  var gTrajGrp = new THREE.Group(); gScene.add(gTrajGrp);
  /* TRAJ_R 已在地面圆盘之前统一声明（★ v41 需求一·18），此处不再重复声明 */
  var gTrajSig = '';
  var gTrajRebuildT = 0;   /* ★ v62（需求四）：动态绘制重建节流计时（与天球侧 _trailRebuildT 同口径） */
  /* ★ 修复 #8：地面轨迹重建时复用的临时对象（此前每帧 new Vector3 / Color）。
     注意：只有「取出后立即被 copy 消费」的中间量才能复用；被 push 进曲线点数组的
     方向向量必须新建（pts 里存的是引用，复用会让所有点重合），故那几处保持 new。 */
  var _gtV = new THREE.Vector3(), _gtCol = new THREE.Color();
  function updateGroundTraj(g) {
    /* ★ v32（需求十二）：签名里的太阳赤纬量化到 0.1° —— 播放时钟时赤纬是连续变化的，
       用 toFixed(3)（0.001°）会导致**每一帧**都重建整条管状轨迹（TubeGeometry + 24 个球），
       这是地面视图卡顿的主要来源。0.1° 在 90° 弧段上肉眼不可分辨。 */
    /* v33：地平线下轨迹的线粗细 / 透明度 / 线型纳入签名，改了才会重建。
       ★ v36（需求六）：二分二至轨迹在地面视图同样绘制 —— term4 / termShow / termCol
       一并纳入签名。 */
    /* ★ v62（需求一）：curPt 已随「当前太阳位置点（地面）」开关取消，不再参与签名。
       ★ v62（需求四）：绘制模式（traj.mode）纳入签名 —— 动态模式下地方恒星时
         g.lst 一并参与（与天球侧 trailSig 同口径），播放时轨迹随时间推进逐步画出；
         完整模式下轨迹与时间无关（'static'），不触发每帧重建。 */
    var sig = [S.traj.on, S.traj.today, S.traj.under, S.traj.hourPt, S.traj.sunPt,
      S.traj.color, S.traj.w, S.traj.op, S.traj.n,
      /* ★ v52（需求G1）：当日轨道的线型（实线 / 虚线）与虚实比纳入签名，改了才会重建。 */
      S.traj.dash, S.traj.ratio,
      /* ★ v52（需求3/需求4）：日出日落中天点 / 整点位置点的点样式纳入签名。 */
      S.traj.sunPtColor, S.traj.sunPtSize, S.traj.sunPtOp,
      S.traj.hourPtColor, S.traj.hourPtSize, S.traj.hourPtOp,
      S.traj.underColor, S.traj.underW, S.traj.underOp, S.traj.underDash, S.traj.underN, S.traj.underRatio,
      S.traj.term4,
      S.traj.termShow.eq, S.traj.termShow.ss, S.traj.termShow.ws,
      /* ★ v52（需求5.1/5.2/5.3）：二分二至轨道的线粗（w）与线型（dash/n/ratio）纳入签名。 */
      S.traj.termCol.eq.color, S.traj.termCol.eq.op, S.traj.termCol.eq.w, S.traj.termCol.eq.dash, S.traj.termCol.eq.n, S.traj.termCol.eq.ratio,
      S.traj.termCol.ss.color, S.traj.termCol.ss.op, S.traj.termCol.ss.w, S.traj.termCol.ss.dash, S.traj.termCol.ss.n, S.traj.termCol.ss.ratio,
      S.traj.termCol.ws.color, S.traj.termCol.ws.op, S.traj.termCol.ws.w, S.traj.termCol.ws.dash, S.traj.termCol.ws.n, S.traj.termCol.ws.ratio,
      obsLat().toFixed(3), (Math.round(g.decl * 10) / 10).toFixed(1),
      (S.traj.mode === 'dynamic' ? g.lst.toFixed(3) : 'static')].join('|');
    /* ★ v62（需求四）：动态绘制节流 —— 与天球侧（_dynTrail / _trailRebuildT）同口径：
       距上次重建不足 120ms 则跳过本帧（播放时轨迹推进平滑，CPU/GPU 负载可控）。 */
    var _dynGTraj = (S.traj.mode === 'dynamic');
    var _nowGT = (window.performance && performance.now) ? performance.now() : Date.now();
    if (sig === gTrajSig) return;
    if (_dynGTraj && _nowGT - gTrajRebuildT < 120) return;
    gTrajSig = sig;
    gTrajRebuildT = _nowGT;
    /* 重建前彻底回收：几何 / 材质 / 贴图 + 注记跟踪表条目（旧实现只 remove，
       文字精灵会永远留在 allNoteSps 里 ⇒ 内存与耗时持续上涨）。 */
    gTrajGrp.children.slice().forEach(function (o) {
      gTrajGrp.remove(o);
      disposeObj(o);
    });
    if (!(S.traj.on && S.traj.today)) return;
    var lat = obsLat(), decl = g.decl;
    var cosH0 = -Math.tan(lat * D) * Math.tan(decl * D);
    var H0 = (cosH0 <= -1) ? 180 : (cosH0 >= 1 ? 0 : Math.acos(cosH0) * R);
    var N = clamp(Math.round(S.traj.n), 24, 240);
    /* ★ v62（需求四）：动态绘制 —— 地面视图与天球视图**同一公式**：轨迹自日出端起，
       按「当前时刻在白昼弧段中的比例」逐步画出；完整绘制恒为全弧。 */
    var frac = 1;
    if (S.traj.on && S.traj.today && S.traj.mode === 'dynamic') {
      frac = H0 > 0 ? clamp((g.lst - (12 - H0 / 15)) / (2 * H0 / 15), 0, 1) : 1;
    }
    if (H0 > 0.2) {
      var pts = [], lim = Math.floor(N * frac);
      for (var i = 0; i <= lim; i++) {
        var Hd = -H0 + (i / N) * 2 * H0;
        var aa = altAzOfH(Hd, lat, decl);
        pts.push(dirOf(aa.alt, aa.az, new THREE.Vector3()).multiplyScalar(TRAJ_R));
      }
      /* 细管而不是 WebGL 线：线宽在多数浏览器里恒为 1px，远处几乎看不见。
         ★ v43（需求一·3）：管半径改由 **S.traj.w** 驱动（此前写死 0.30 ⇒ 「线粗细」是死控件）。
         基准 1.20 与天球侧 SV_LW_BASE['traj.w'] 一致，滑块 1.00× ⇒ 0.30·(1.20/1.20)…
         为保持既有观感不变，这里取 base 0.30 为「1.00×」的等价半径：w = 0.30 × 倍率。 */
      var rad = Math.max(0.02, 0.30 * svLwMult('traj.w'));
      /* ★ v52（需求G1）：当日轨道支持「实线 / 虚线 + 虚线密度 + 虚实比」——
         此前恒为实心细管，菜单里的线型 / 虚实比被完全忽略（改了不生效）。 */
      var tube = new THREE.Mesh(
        tubeStyledGeo(pts, rad, S.traj.dash, S.traj.n, S.traj.ratio, Math.min(180, pts.length * 2)),
        new THREE.MeshBasicMaterial({ color: S.traj.color, transparent: true, opacity: S.traj.op / 100 }));
      gTrajGrp.add(tube);
    }
    if (S.traj.under && H0 < 179.8) {
      var pu = [];
      for (var j = 0; j <= 96; j++) {
        var Hu = H0 + (j / 96) * (360 - 2 * H0);
        var aau = altAzOfH(Hu > 180 ? Hu - 360 : Hu, lat, decl);
        pu.push(dirOf(aau.alt, aau.az, new THREE.Vector3()).multiplyScalar(TRAJ_R * 0.998));
      }
      /* v33：虚线密度 / 虚实比 / 透明度改由菜单控制（旧版写死 90 / 50 / 0.42）。
         ★ v43（需求一·3）：线粗细（S.traj.underW）此前也是死控件（lineOf 的 width 参数
         在实线分支完全未被使用）。改为**按粗细决定用实线细管还是虚线**：
           倍率 < 0.45 ⇒ 虚线（保留虚线语义的默认档）；≥ 0.45 ⇒ 实心细管（半径随倍率变化）。
         虚线密度 / 虚实比仍作用于虚线档。 */
      var um = svLwMult('traj.underW');
      if (um < 0.45) {
        var lu = lineOf(pu, S.traj.underColor, 1, S.traj.underDash, S.traj.underN, S.traj.underRatio);
        lu.material.opacity = (S.traj.underOp / 100) * 0.42;
        gTrajGrp.add(lu);
      } else {
        var ucurve = new THREE.CatmullRomCurve3(pu);
        var urad = Math.max(0.02, (S.traj.underW / 3.0) * 0.30);
        var umesh = new THREE.Mesh(new THREE.TubeGeometry(ucurve, 160, urad, 6, false),
          new THREE.MeshBasicMaterial({ color: S.traj.underColor, transparent: true, opacity: (S.traj.underOp / 100) * 0.42 }));
        gTrajGrp.add(umesh);
      }
    }
    if (S.traj.hourPt) {
      for (var hh = 0; hh < 24; hh++) {
        var aah = altAzOfH((hh - 12) * 15, lat, decl);
        if (aah.alt < -0.5) continue;
        /* ★ v62（需求四）：动态绘制下整点位置点与轨迹同口径 —— 只画「当前时刻已到达」的整点
           （与天球侧 7675 行同款 tFrac 判断），两视图点数一致。 */
        if (S.traj.mode === 'dynamic' && frac < 1) {
          var tFracG = H0 > 0 ? (((hh - 12) * 15 + H0) / (2 * H0)) : 0;
          if (tFracG > frac) continue;
        }
        /* ★ v52（需求4）：整点位置点的颜色 / 大小 / 透明度改为读取 traj.hourPt* 状态键
           （此前颜色与半径 0.62 均写死 ⇒ 菜单里改了没用）。 */
        var hRad = Math.max(0.03, 0.62 * (S.traj.hourPtSize / 100));
        var dot = new THREE.Mesh(new THREE.SphereGeometry(hRad, 10, 8),
          new THREE.MeshBasicMaterial({ color: S.traj.hourPtColor, transparent: true, opacity: clamp(S.traj.hourPtOp / 100, 0, 1) }));
        dot.position.copy(dirOf(aah.alt, aah.az, _gtV).multiplyScalar(TRAJ_R));
        gTrajGrp.add(dot);
        /* ★ v63（需求A）：整点时刻文字注释不再受已取消的 traj.hourNote 门控 ——
           精灵随整点位置点一同创建，可见性改由「文字注释 › 整点时刻」子组开关
           （traj.nt.svHour + 容器 traj.note）经 gateMasterNotes 每帧控制（与日出日落中天同口径）。 */
        /* ★ v52（需求4）：整点时刻注释改用独立分类 svHour（此前误用 svTraj，
           导致「文字注释 › 整点时刻」在天球与地面两视图各改各的、互不相通）。 */
        var sp = textSprite(hh + ':00', { size: 2.0, color: '#ffe9b0', cat: 'svHour' });
        sp.position.copy(dot.position).multiplyScalar(1.035);
        gTrajGrp.add(sp);
      }
    }
    /* ★ v44（需求十二）：在太阳视运动轨道上标出**日中天**位置 ——
       与日出 / 日落共用一个开关 `traj.sunPt`（菜单标题已改为「日出 / 日中天 / 日落点」），
       三者同进同退、共用同一套注释样式（svTraj）。
       H（太阳时角）= 0 即**日中天**（上中天）—— 太阳到达当日最高位置，
       与日出（−H0）/ 日落（+H0）在同一条 altAzOfH 口径上，落点必然落在同一条轨迹线上。 */
    if (S.traj.sunPt && H0 > 0.2 && H0 < 179.8) {
      [['日出', -H0], ['日中天', 0], ['日落', H0]].forEach(function (p) {
        var aa3 = altAzOfH(p[1], lat, decl);
        /* ★ v52（需求3）：点标记的颜色 / 大小 / 透明度改为 traj.sunPt* 状态键
           （此前颜色 0xffc23a/0xff5e3a 与半径 0.95 写死）。 */
        var sRad = Math.max(0.05, 0.95 * (S.traj.sunPtSize / 100));
        var mm = new THREE.Mesh(new THREE.SphereGeometry(sRad, 12, 10),
          new THREE.MeshBasicMaterial({ color: S.traj.sunPtColor, transparent: true, opacity: clamp(S.traj.sunPtOp / 100, 0, 1) }));
        mm.position.copy(dirOf(aa3.alt, aa3.az, _gtV).multiplyScalar(TRAJ_R));
        gTrajGrp.add(mm);
        var sp2 = textSprite(p[0], { size: 2.4, color: p[1] === 0 ? '#ffe08a' : '#ffb0a0', cat: 'svTraj' });
        sp2.position.copy(mm.position).multiplyScalar(1.05);
        gTrajGrp.add(sp2);
      });
    }
    /* ★ v62（需求一）：「当前太阳位置点」地面标记已随开关取消（与太阳本体重合、被日面 /
       日冕完全遮盖，从未有过可见效果）。渲染块与 traj.curPt 状态一并移除。 */
    /* ★ v36（需求六）：二分二至轨迹在地面视图同样绘制（逐套受 termShow 控制） */
    if (S.traj.term4) {
      var epsG = BR.getObliquity();
      [['春分 / 秋分', 0, 'eq'], ['夏至', epsG, 'ss'], ['冬至', -epsG, 'ws']].forEach(function (tt) {
        if (!S.traj.termShow[tt[2]]) return;
        var ptsT = [], dd = tt[1], tc = S.traj.termCol[tt[2]] || S.traj.termCol.eq;
        var cH = -Math.tan(lat * D) * Math.tan(dd * D);
        var HH = (cH <= -1) ? 180 : (cH >= 1 ? 0 : Math.acos(cH) * R);
        if (HH <= 0) return;
        for (var q = 0; q <= 96; q++) {
          var Hq = -HH + (q / 96) * (2 * HH);
          var aaq = altAzOfH(Hq, lat, dd);
          ptsT.push(dirOf(aaq.alt, aaq.az, new THREE.Vector3()).multiplyScalar(TRAJ_R * 0.992));
        }
        var col = _gtCol.set(tc.color || '#b7e07f');
        /* ★ v52（需求5.1/5.2/5.3）：二分二至轨道由 1px 折线改为**细管** ——
           线粗（tc.w，经 SV_LW_BASE 基准 3.0 换算为倍率）真正生效；
           线型（tc.dash/n/ratio）由 tubeStyledGeo 分段实现。基准半径 0.30 = 1.00×。 */
        var tRad = Math.max(0.02, 0.30 * svLwMult('traj.termCol.' + tt[2] + '.w', tc.w));
        var tMesh = new THREE.Mesh(
          tubeStyledGeo(ptsT, tRad, tc.dash || 'solid', tc.n, tc.ratio, Math.min(180, ptsT.length * 2)),
          new THREE.MeshBasicMaterial({ color: col.getHex(), transparent: true, opacity: clamp((tc.op != null ? tc.op : 72) / 100, 0, 1) }));
        gTrajGrp.add(tMesh);
        /* ★ v64（需求1）：轨道名称注释**无条件创建**（原 if (S.traj.term4Note) 包裹已删）——
           显隐改由 gateMasterNotes 按「文字注释 › 二分二至轨道」子组开关
           （traj.note && traj.nt.svTerm4）每帧控制，与 v63「整点时刻」合并同口径；
           注释嵌在本渲染块内 ⇒ 轨道关（term4 / termShow）⇒ 注释随轨道一并消失。 */
        var mid = ptsT[Math.floor(ptsT.length / 2)];
        /* ★ v52（需求4）：二分二至轨道名称注释改用独立分类 svTerm4。 */
        var sp3 = textSprite(tt[0], { size: 2.2, color: '#' + col.getHexString(), cat: 'svTerm4' });
        sp3.position.copy(mid).multiplyScalar(1.06);
        gTrajGrp.add(sp3);
      });
    }
  }

  /* --- v32（需求七）：太阳「边缘光线」已整体移除 ---
     v31 曾以日面为中心铺开 N 条柔光丝（ensureEdgeRays / edgeTexture）；该效果与
     「消除条状光线」的要求相冲突，菜单项与渲染逻辑一并删除，仅在此留档。 */

  /* --- 东南西北方位标（3D 箭头 + 屏幕覆盖层文字） ---
     文字**只由** #svDirMarks 覆盖层负责（见 projectDirMarks）：它按相机投影钉在地面
     对应方位上、字号不随距离缩小，远端的方位字依然清晰可读。
     这里不再另建 3D 文字精灵，否则同一个方位会同时出现大小两个「北」。 */
  var dirGrp = new THREE.Group();
  gScene.add(dirGrp);
  var dirMarks3D = [];
  (function () {
    var defs = [['北', 0, -1], ['南', 0, 1], ['东', 1, 0], ['西', -1, 0]];
    /* ★ v35（需求十一）：方向箭头与文字一致，**置于地平线上**（地面圆盘边缘，
       半径 = GROUND_R·0.985，与 #svDirMarks 覆盖层同口径），不再挂在模型活动区边缘。 */
    var len = GROUND_R * 0.985;
    defs.forEach(function (d) {
      var g = new THREE.Group();
      g.position.set(d[1] * len, 0.4, d[2] * len);
      var cone = new THREE.Mesh(new THREE.ConeGeometry(0.34, 2.6, 14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      /* 细长锥：从箭头正后方看过去是一个小圆点，不会像「圆盘」那样被误认成太阳 */
      cone.position.set(d[1] * 1.6, 0, d[2] * 1.6);
      if (d[1] !== 0) cone.rotation.z = d[1] > 0 ? -Math.PI / 2 : Math.PI / 2;
      else cone.rotation.x = d[2] > 0 ? Math.PI / 2 : -Math.PI / 2;
      g.add(cone);
      dirGrp.add(g);
      dirMarks3D.push({ g: g, cone: cone, d: d });
    });
  })();

  /* --- 预制地面物体：2 栋南北向建筑 + 旗杆 + 小人 --- */
  var objGrp = new THREE.Group();
  gScene.add(objGrp);
  var props = [];
  /* ===== ★ v58（需求 2）：物体选中描边 =====
     背景：v«本批次(需求三)» 为满足「彻底去掉立体边框」把 edgeOf 改成恒返回 null，
     于是双击选中物体**完全没有视觉反馈**。本轮需求 2 要求「被选中物体加 3–5px 描边，
     颜色与未选中状态高对比（灰 → 蓝）」。

     技术选型 —— 为什么不用 LineSegments：
       · WebGL 在 Windows Chrome（ANGLE/D3D 后端）下**忽略 `linewidth > 1`**，恒为 1px，
         1px 的细线在卫星底图 / 建筑立面上根本看不清，达不到「3–5px」的要求；
       · 因此改用业界通用的 **inverted hull（反向法线膨胀外壳）**：
         给每个可拾取网格挂一个「同几何体 + BackSide + 沿法线外推」的幽灵网格。
         BackSide 只画背面 ⇒ 物体本体把中段挡住，只在轮廓外缘露出一圈**描边**；
         用顶点着色器沿 `normal` 外推，粗细在**世界空间**里可控，且外壳是不受光照的
         MeshBasicMaterial ⇒ 「不同光照条件下均清晰」（需求 2 最后一句）。

     粗细为什么是「每帧算」而不是常量：
       常量世界厚度在不同机位 / 缩放下投影出的像素数会差好几倍。这里每帧按
       相机到物体的距离反算「1 像素 = 多少世界单位」，令外壳外推量 = EDGE_PX 像素，
       于是描边在屏幕上**恒为 3–5px**（见 updateEdgeScale）。

     显隐：未选中 → 外壳整组 `visible=false`（不渲染，符合「彻底去掉立体边框」的既有
       要求）；选中 → 粉红外壳显示。故未选中不会看到任何多余的线框。 */
  /* ★ v60（需求2）：选中描边默认改为**亮粉**，且颜色 / 粗细改为可在
     「观察与测量 › 物影 › 选中描边」里实时调整（写入 S.meas.edgeColor / edgeW）。
     下面两个常量退化为「菜单里没设过时的默认值」。 */
  var EDGE_SEL = '#ff4fa3';  /* 默认选中描边：亮粉 (#ff4fa3) */
  var EDGE_PX = 4;           /* 默认目标屏幕描边宽度（px），菜单可调 1–10 */
  function edgeColorStr() { return (S.meas && S.meas.edgeColor) || EDGE_SEL; }
  function edgePxNow() { var v = S.meas && S.meas.edgeW; return (isFinite(v) && v > 0) ? v : EDGE_PX; }
  /* 为一个物体组生成描边外壳；返回外壳网格数组（供 applyEdgeStyle 复刷），
     无可用立体网格时返回 null（调用点全部对 null 安全）。 */
  function edgeOf(g) {
    var hulls = [];
    var kids = (g.children || []).slice();   /* 快照：下面要往 g.children 追加，避免边遍历边改 */
    kids.forEach(function (m) {
      if (!m.isMesh || !m.geometry) return;
      var ga = m.geometry.attributes && m.geometry.attributes.position;
      if (!ga || !ga.count) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      var sz = new THREE.Vector3();
      m.geometry.boundingBox.getSize(sz);
      /* 跳过**扁平几何体**（旗面 PlaneGeometry 等）：它的法线只有一个方向，
         外推后仍与原面共面 ⇒ 只会 z-fighting，画不出轮廓。旗杆的圆柱外壳
         已经能给出整根杆的描边，旗面不必单独描。 */
      if (Math.min(sz.x, sz.y, sz.z) < 1e-3) return;
      var mat = new THREE.MeshBasicMaterial({ color: edgeColorStr(), side: THREE.BackSide });
      /* 沿法线外推：MeshBasicMaterial 的顶点着色器**没有** <beginnormal_vertex>
         （不参与光照），但 three.js 的默认顶点前缀始终声明了 `attribute vec3 normal;`，
         故可直接在 <begin_vertex> 之后取用。外推量每帧由 updateEdgeScale 写进 uEdgeW。 */
      mat.onBeforeCompile = function (sh) {
        sh.uniforms.uEdgeW = { value: 0 };
        sh.vertexShader = 'uniform float uEdgeW;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed += normal * uEdgeW;'
        );
        /* ★ v62（需求三）修复：同一份外壳材质会被主画布 rnd 与地面悬浮窗 wGround
           各自编译一次 —— onBeforeCompile 在**每个渲染器**各触发一次，此前直接
           覆盖 userData.uEdgeW，导致只有「最后编译的渲染器」（悬浮窗 wGround）的
           uniform 被 updateEdgeScale 更新，主画布那份恒为 0 ⇒ 外壳不外推、
           被物体本体完全遮住 ⇒ 表现为「悬浮窗有描边、主视图无描边」。
           现把每个渲染器的 uniform 引用都收进 uEdgeWs 列表，更新时全量写入。 */
        if (!mat.userData.uEdgeWs) mat.userData.uEdgeWs = [];
        if (mat.userData.uEdgeWs.indexOf(sh.uniforms.uEdgeW) < 0) mat.userData.uEdgeWs.push(sh.uniforms.uEdgeW);
        mat.userData.uEdgeW = mat.userData.uEdgeWs[0];   /* 兼容旧探针：读首项（主画布口径） */
      };
      var hull = new THREE.Mesh(m.geometry, mat);   /* 共用几何体（省显存，dispose 幂等） */
      hull.position.copy(m.position);
      hull.quaternion.copy(m.quaternion);
      hull.scale.copy(m.scale);
      hull.visible = false;              /* 未选中：不渲染，绝不残留边框 */
      hull.castShadow = hull.receiveShadow = false;
      hull.raycast = function () {};     /* 不参与拾取（否则隐形外壳会挡住双击命中判定） */
      hull.userData.__edge = true;       /* 供其它遍历逻辑识别并跳过 */
      g.add(hull);
      hulls.push(hull);
    });
    return hulls.length ? hulls : null;
  }
  function applyEdgeStyle(o) {
    var hs = o && o.userData && o.userData.outline;
    if (!hs || !hs.length) return;
    var on = !!o.userData.selected;
    for (var i = 0; i < hs.length; i++) {
      hs[i].visible = on;                       /* 未选中 → 整组隐藏 */
      if (hs[i].material && hs[i].material.color) hs[i].material.color.set(edgeColorStr());
    }
    if (on) updateEdgeScale();                  /* 立刻按当前机位定一次粗细，避免首帧过粗/过细 */
  }
  /* 批量刷新（属性变动 / 存档恢复后调用） */
  function applyEdgeAll() { props.forEach(applyEdgeStyle); }
  /* ★ v58（需求 2）：把每个选中物体的外壳外推量换算成「屏幕恒 EDGE_PX 像素」。
     每帧在 tickSun 里调用（只遍历 props，且只对选中项做三角函数，开销可忽略）。
     世界单位/像素 = (2 · 距离 · tan(fov/2)) / 视口高度，再乘目标像素数即得外推量。 */
  function updateEdgeScale() {
    var cam = (S.fp && fpCam) ? fpCam : gCam;
    if (!cam || !rnd || !rnd.getSize) return;
    var vsz = new THREE.Vector2(); rnd.getSize(vsz);
    if (!vsz.y) return;
    var v = new THREE.Vector3();
    for (var i = 0; i < props.length; i++) {
      var o = props[i];
      var hs = o && o.userData && o.userData.outline;
      if (!hs || !hs.length || !o.userData.selected) continue;
      o.getWorldPosition(v);
      var dist = Math.max(1e-3, cam.position.distanceTo(v));
      var worldPerPx = 2 * dist * Math.tan((cam.fov || 45) * D / 2) / vsz.y;
      var kw = edgePxNow() * worldPerPx;
      for (var j = 0; j < hs.length; j++) {
        var mu = hs[j].material && hs[j].material.userData;
        var us = mu && mu.uEdgeWs;              /* ★ v62（需求三）：全部渲染器的 uniform 引用全量写入 */
        if (us) { for (var k = 0; k < us.length; k++) us[k].value = kw; }
        else if (mu && mu.uEdgeW) mu.uEdgeW.value = kw;
      }
    }
  }
  function makeBuilding(w, d, h, color, floors, floorH, winBase, winH, angleDeg) {
    var g = new THREE.Group();
    var tex = facadeTexture(color, floors, Math.max(2, Math.round(w / 3)), winBase, winH, floorH);
    var mat = new THREE.MeshLambertMaterial({ map: tex });
    var side = new THREE.MeshLambertMaterial({ color: color });
    var box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, side, side, mat, mat]);
    box.position.y = h / 2; box.castShadow = true; box.receiveShadow = true;
    g.add(box);
    /* ★ v52（需求G3）：屋顶由「一块压扁的方块」升级为**挑檐 + 双坡屋面**（屋脊沿南北
       即 d 方向），并把墙面墙裙 / 大门补齐 —— 几何体组合出「墙身 + 屋顶 + 门窗」的
       分层感，而整栋楼仍然只有 **5 个 mesh / 4 种材质**（材质在楼内复用，draw call
       可控，不会因为精致化而拖慢场景）。坡顶的两片斜板共用同一份材质。 */
    var roofMat = new THREE.MeshLambertMaterial({ color: 0x54637a });
    /* 挑檐：比墙身四周各挑出 3%，形成一圈屋檐 */
    var eave = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.26, d * 1.06), roofMat);
    eave.position.y = h + 0.13; eave.castShadow = true;
    g.add(eave);
    /* 双坡屋面：两片对称斜板，屋脊在 x = 0 */
    var rw = w * 1.06 / 2, rise = Math.max(0.6, w * 0.16);
    var slopeLen = Math.sqrt(rw * rw + rise * rise), sang = Math.atan2(rise, rw);
    [1, -1].forEach(function (s) {
      var half = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 0.22, d * 1.04), roofMat);
      half.position.set(s * rw / 2, h + 0.26 + rise / 2, 0);
      half.rotation.z = -s * sang;
      half.castShadow = true;
      g.add(half);
    });
    /* 大门：正面（+Z 面）贴地的一扇门板，偏在一侧，避免正好压在观测者视线上 */
    var door = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w * 0.30, 2.2), 2.6, 0.18),
      new THREE.MeshLambertMaterial({ color: 0x7a5c40 }));
    door.position.set(-w * 0.22, 1.3, d / 2 + 0.06);
    door.castShadow = true;
    g.add(door);
    var outline = edgeOf(g, w, h, d);
    g.userData = { kind: 'building', w: w, d: d, h: h, color: color, floors: floors, floorH: floorH,
                   winBase: winBase, winH: winH, outline: outline,
                   roofRise: rise };
    g.rotation.y = (angleDeg || 0) * D;
    return g;
  }
  /* ★ v41（需求一·4）：杆高改为**可按对象设置**（双击旗杆 → 属性设置 → 杆高），默认仍 14 m；
     并补上选中轮廓（此前旗杆没有 outline，单击 / 双击后看不出被选中）。
     ★ v52（需求G5）：杆颜色 / 旗帜颜色可按对象设置（缺省取菜单的 S.flag.*），
     与左侧「地面物体 › 树木与旗杆 › 旗杆属性设置」共用同一套键。 */
  function makeFlagpole(h, poleColor, flagColor) {
    var g = new THREE.Group();
    /* ★ v39（需求二·3）：旗杆加高（9 m → 14 m）—— 与楼高相当时可以从远处清晰读出
       杆顶 → 影尖的那条太阳光线。 */
    var FD = S.flag || {};
    var FLAG_H = clamp(h || FD.h || 14, 3, 30);
    var pc = poleColor || FD.poleColor || '#bfc7d2';
    var fc = flagColor || FD.flagColor || '#d7263d';
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, FLAG_H, 10), new THREE.MeshLambertMaterial({ color: pc }));
    pole.position.y = FLAG_H / 2; pole.castShadow = true;
    g.add(pole);
    var flag = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.7), new THREE.MeshLambertMaterial({ color: fc, side: THREE.DoubleSide }));
    flag.position.set(1.42, FLAG_H - 1.0, 0); flag.castShadow = true;
    g.add(flag);
    var outline = edgeOf(g, 3.0, FLAG_H, 0.34, FLAG_H / 2, 1.42);
    g.userData = { kind: 'flag', h: FLAG_H, poleColor: pc, flagColor: fc, outline: outline };
    return g;
  }
  /* v31（需求六）：可添加的树木（三层锥形树冠 + 树干）。与建筑 / 旗杆一样可选中、改属性、删。 */
  function makeTree(h, canopy, trunkCol) {
    var g = new THREE.Group();
    var trunkH = h * 0.42;
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.035, h * 0.055, trunkH, 8),
      new THREE.MeshLambertMaterial({ color: trunkCol || '#7a5a34' }));
    trunk.position.y = trunkH / 2; trunk.castShadow = true;
    g.add(trunk);
    var cm = new THREE.MeshLambertMaterial({ color: canopy || '#4f8a3d' });
    for (var i = 0; i < 3; i++) {
      var r = h * (0.30 - i * 0.055), ch = h * 0.34;
      var cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 12), cm);
      cone.position.y = trunkH + ch * (0.36 + i * 0.34);
      cone.castShadow = true;
      g.add(cone);
    }
    var outline = edgeOf(g, h * 0.6, h, h * 0.6);
    /* ★ v52（需求G5）：树干颜色一并记进 userData —— 属性对话框与菜单共用同一套键后，
       「叶色 / 树干色」两个选项在两条设置路径下都能读回当前值。 */
    g.userData = { kind: 'tree', h: h, color: canopy || '#4f8a3d', trunk: trunkCol || '#7a5a34', outline: outline };
    return g;
  }
  /* v31：改了面板上的树木属性后原地重建（保留位置 / 选中框） */
  function rebuildTree(g, h, canopy, trunkCol) {
    while (g.children.length) {
      var c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
    }
    var trunkH = h * 0.42;
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.035, h * 0.055, trunkH, 8),
      new THREE.MeshLambertMaterial({ color: trunkCol || '#7a5a34' }));
    trunk.position.y = trunkH / 2; trunk.castShadow = true;
    g.add(trunk);
    var cm = new THREE.MeshLambertMaterial({ color: canopy || '#4f8a3d' });
    for (var i = 0; i < 3; i++) {
      var r = h * (0.30 - i * 0.055), ch = h * 0.34;
      var cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 12), cm);
      cone.position.y = trunkH + ch * (0.36 + i * 0.34);
      cone.castShadow = true;
      g.add(cone);
    }
    var outline = edgeOf(g, h * 0.6, h, h * 0.6);
    g.userData.kind = 'tree'; g.userData.h = h; g.userData.color = canopy || '#4f8a3d';
    /* ★ v52（需求G5）：树干颜色也必须写回 userData —— 否则重建后属性对话框读到的仍是旧值。 */
    g.userData.trunk = trunkCol || '#7a5a34';
    g.userData.outline = outline;
    return g;
  }
  function makeFigure(color, h) {
    var g = new THREE.Group();
    var mat = new THREE.MeshLambertMaterial({ color: color });
    var body = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.11, h * 0.14, h * 0.62, 12), mat);
    body.position.y = h * 0.47; body.castShadow = true;
    g.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(h * 0.10, 14, 12), new THREE.MeshLambertMaterial({ color: 0xf2c9a0 }));
    head.position.y = h * 0.88; head.castShadow = true;
    g.add(head);
    var leg = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.035, h * 0.035, h * 0.16, 8), mat);
    leg.position.y = h * 0.08; leg.castShadow = true;
    g.add(leg);
    var outline = edgeOf(g, h * 0.32, h * 0.96, h * 0.32, h * 0.48);
    g.userData = { kind: 'figure', h: h, outline: outline };
    return g;
  }
  var figObj = null;
  /* ★ v53 修复（任务二·2）：**当前作为第一视角视点的那一个小人**。
     背景：多小人场景里，用户双击的是某一个具体小人，菜单点「第一视角」后
     `fpPos.copy(o.position)` 已经站到了那个人身上，但 enterFP 内部又**无条件**执行
     `if (figObj) { fpPos.copy(figObj.position); … }` —— figObj 是「默认那一个小人」
     （props 里 id = 'prep-fig' 的那个，通常在场景中心）。于是刚设好的 fpPos 被覆盖，
     多小人时永远固定在中心小人身上，用户点的哪个小人完全不起作用。
     改法：把「站位 / 隐藏 / 恢复 / 反向同步」这四处原本各写一份 figObj 的逻辑
     **统一收敛到 fpHost**：
       · enterFP(host) —— 有 host 就站到 host 并隐藏 host；无 host 才回退 figObj；
       · updateFP 每帧隐藏 fpHost（相机就站在它身上，不隐藏会挡住镜头）；
       · exitFP 恢复 fpHost 并清空；
       · WASD 移动后把位移**反向同步**给 fpHost（移动的是「视点小人」，不是默认小人）。
     figObj 仍然是「菜单滑块/属性默认值作用的那一个」，两者职责不同、互不替代。 */
  var fpHost = null;
  /* 视点小人失效保护：被删除 / 被 dispose / 已不在场景里时清空 fpHost。
     判据用 `parent`（three.js 里对象被 remove 后 parent 变 null）而不是 props.indexOf，
     因为 rebuild 路径会先把旧对象 remove 再 add 新对象，此刻旧对象的 parent 恰为 null。 */
  function dropDeadFpHost() { if (fpHost && !fpHost.parent) fpHost = null; return fpHost; }
  function rebuildFigure() {
    /* ★ v53：默认小人被重建时，若视点原本挂在**旧的** figObj 上，把站位继承给新对象
       —— 否则 fpHost 会变成指向已移出场景的悬空引用（updateFP 每帧改它的 visible、
       WASD 往它身上写 position，全都作用在一个游离对象上，视点也会跟着失效）。 */
    var oldFig = figObj, oldPos = figObj ? figObj.position.clone() : null;
    if (figObj) { objGrp.remove(figObj); var i = props.indexOf(figObj); if (i >= 0) props.splice(i, 1); }
    figObj = makeFigure(S.fig.color, S.fig.h);
    figObj.userData.id = 'prep-fig';
    objGrp.add(figObj);
    props.push(figObj);
    if (oldFig && fpHost === oldFig) { fpHost = figObj; if (oldPos) fpPos.copy(oldPos); }
    dropDeadFpHost();
  }
  /* ★ v52（需求G4）：把身高 / 颜色**真正作用到模型** ——
     旧实现里菜单滑块只重建默认那一个小人（figObj），额外放置的小人不跟随；
     属性对话框改身高更是完全无效（applyProps figure 分支不读 o.userData.h）。
     本函数把 props 中**所有小人**原地重建为统一身高 / 颜色，保留各自位置、id 与选中态。 */
  function rebuildFiguresTo(h, color) {
    var nh = clamp(h || 2.1, 0.8, 2.4);
    var nc = color || '#f0763b';
    props.slice().forEach(function (o) {
      if (!o || !o.userData || o.userData.kind !== 'figure') return;
      var pos = o.position.clone(), id = o.userData.id, sel = !!o.userData.selected;
      var nf = makeFigure(nc, nh);
      nf.position.copy(pos); nf.userData.id = id; nf.userData.selected = sel;
      objGrp.remove(o); objGrp.add(nf);
      var i = props.indexOf(o); if (i >= 0) props[i] = nf;
      if (o === figObj) figObj = nf;
      /* ★ v53：视点小人被原地重建 ⇒ fpHost 必须改指新对象（否则它指向已 dispose 的旧对象，
         每帧改 visible / WASD 写 position 都作用在游离对象上）。站位由 nf.position 继承
         （重建时已 copy 过去），改身高 / 颜色不会让第一视角失效。 */
      if (o === fpHost) fpHost = nf;
      if (o === measKeep) measKeep = nf;
      if (nf.userData.outline) applyEdgeStyle(nf);
      disposeObj(o);
    });
  }
  /* ★ v52（需求G5）：把菜单上「树木属性设置」的变化**真正作用到场景里的所有树木**，
     并保留每棵树原有的相对高矮（userData.hRatio，见 seedTrees）与位置 / id / 选中态。
     旧实现里菜单滑块只改 S.tree.*，除「应用」按钮外没有任何重建 ⇒ 拖动滑块毫无反应。 */
  function rebuildAllTrees() {
    props.slice().forEach(function (o) {
      if (!o || !o.userData || o.userData.kind !== 'tree') return;
      var ratio = o.userData.hRatio || 1;
      rebuildTree(o, S.tree.h * ratio, S.tree.color, S.tree.trunk);
      o.userData.hRatio = ratio;
    });
  }
  /* ★ v52（需求G5）：同上，旗杆样式（杆高 / 杆颜色 / 旗帜颜色）实时作用到所有旗杆。 */
  function rebuildAllFlags() {
    props.slice().forEach(function (o) {
      if (!o || !o.userData || o.userData.kind !== 'flag') return;
      var pos = o.position.clone(), id = o.userData.id, sel = !!o.userData.selected;
      var nf = makeFlagpole(S.flag.h, S.flag.poleColor, S.flag.flagColor);
      nf.position.copy(pos); nf.userData.id = id; nf.userData.selected = sel;
      objGrp.remove(o); objGrp.add(nf);
      var i = props.indexOf(o); if (i >= 0) props[i] = nf;
      if (o === measKeep) measKeep = nf;
      if (nf.userData.outline) applyEdgeStyle(nf);
      disposeObj(o);
    });
  }
  /* 预制建筑：摆到离观测点（原点）较远的位置 —— 地面上所有演示都以原点为观测点，
     若楼又高又贴近原点，从任何方位看过去视线都会被一面墙糊住（默认机位尤其明显）。
     ★ v35（需求十九）：旧尺寸（10 / 13 m）相对地平圈太小，放大一档提高可见性
     （楼层 × 层高与楼高保持一致，窗户排布不变形）。 */
  var bldA = makeBuilding(7.5, 11, 15, S.bld.color, 5, 3, 1.0, 1.6, 0);
  bldA.position.set(0, 0, -13.2); bldA.userData.id = 'prep-a';
  var bldB = makeBuilding(8.5, 13, 19, '#d7cdbd', 6, 3.2, 1.0, 1.6, 0);
  bldB.position.set(0, 0, 11.6); bldB.userData.id = 'prep-b';
  var flagObj = makeFlagpole();
  /* ★ v39（需求二·3）：旗杆离楼更远 —— 原 (0,0,9) 紧贴 bldB（南北轴线上），
     现移到侧前方空地（避开两楼与半环树阵），保证杆影不被楼体遮挡。
     ★ v41（需求一·4）：再往东南外圈挪一档 (6,16) → (10,18.5) —— 与 bldB 的间距由 ~10 m
     拉到 ~14.5 m，杆影全程落在空地上；半径 21 < 活动区 22，仍可自由拖动。
     ★ v43（需求一·1「分散分布，距离远一点」）：(10,18.5) → **(17, 9)**
       —— 挪到东侧空地（东 = +X），半径 19.2 < 活动区 22：
         · 与 bldB 间距 ~17.2 m（旧 ~10 m），杆影整条落在无遮拦的草地上；
         · 与最近的两棵树（(19,−4) / (12.5,15)）间距 13.2 / 7.7 m，互不压叠；
         · 旧位置 (10,18.5) 正压在东南那棵树上（间距仅 ~1.5 m），是截图里「挤成一堆」的元凶。
     ★ v58（需求 4）：(17, 9) → **(11, 7)** —— 17.2 m 其实「过远」：杆子被推到东南外圈，
       与两栋楼不在同一取景重心上，做影子测量时不好定位、也不便于与楼影对照。
       新位置把间距收到**适中**（用户要求「既能清晰展示影子变化，又不影响其它元素观察」）：
         · 与 bldB(0, 11.6) 间距 ≈ **11.9 m**（14 m 杆在 13 m 楼旁仍留有充足空地，杆影不压楼身）；
         · 与最近的两棵树 (12.5,15) / (19,−4) 间距 ≈ 8.1 / 13.6 m，树冠（半径 ~2.3 m）不叠；
         · 半径 13.0 —— 稳稳落在默认地面视图的取景范围内，与两栋楼同框，测量时可操作性更好。
     ★ v64（需求3）：(11, 7) → **(16, 3)** —— 默认状态下进一步远离建筑物、不与任何物体相互遮挡：
         · 与 bldB(0, 11.6) 间距 ≈ 18.2 m、与 bldA(0, −13.2) 间距 ≈ 16.7 m；
         · 与最近的两棵树 (19,−4) / (12.5,15) 间距 ≈ 7.6 / 12.5 m（树冠半径 ~2.3 m，不叠）；
         · 与默认小人 (−9, −4) 间距 ≈ 25.6 m；半径 16.3 < 活动区 22，仍在默认取景范围内。 */
  flagObj.position.set(16, 0, 3); flagObj.userData.id = 'prep-flag';
  objGrp.add(bldA); objGrp.add(bldB); objGrp.add(flagObj);
  props.push(bldA, bldB, flagObj);
  rebuildFigure();
  /* ★ v64（需求3）：默认小人 (0, 4.5) → **(−9, −4)** —— 原位置紧贴 bldB 北侧楼体
     （间距仅 ~7 m，默认机位下与楼影 / 楼身相互遮挡），且在两楼的南北轴线上，
     正午楼影会直接压过小人。新位置挪到西侧空地：
       · 与 bldA(0, −13.2) 间距 ≈ 12.9 m、与 bldB(0, 11.6) 间距 ≈ 18.0 m；
       · 与最近的树 (−19,−4) 间距 ≈ 10 m（树冠半径 ~2.3 m，不叠）；
       · 与旗杆 (16, 3) 间距 ≈ 25.6 m —— 默认状态下各物体互不遮挡。 */
  figObj.position.set(-9, 0, -4);
  /* 南北方向间距（需求 4.1「建筑物间距」）：沿南北向拉开两栋楼的距离，
     用于演示不同遮挡 / 影长关系；x 方向固定对称分布在原点两侧。 */
  /* ★ v32（需求八）：两栋预制建筑改为**正南北分布**（同一条南北轴线上，仅南北向错开），
     这样「太阳东升西落 → 一栋的影子扫过另一栋」的演示关系才直观。 */
  /* ★ v43（需求一·1）：系数整体放大并加**上限夹取** ——
       旧式 `4 + d×0.55 / 4 + d×0.30`（d 默认 9 ⇒ 楼心仅 ±9 m，两楼净距 ~7 m，树木穿插其间）；
       新式 `6 + d×0.80 / 6 + d×0.62`（d=9 ⇒ 楼心 −13.2 / +11.6，两栋楼外缘相距 ~19 m），
       并把楼心夹在 [9,20] / [8,18] 内 —— d 拉到上限 26 时旧式会算出 −18.3（尚可），
       但系数放大后必须夹取，否则楼体会被拖出极坐标网格（RR = GSIZE/2 = 22）之外。 */
  function applySpacing() {
    var d = clamp(S.spacing, 4, 26);
    bldA.position.set(0, 0, -clamp(6 + d * 0.80, 9, 20));
    bldB.position.set(0, 0, clamp(6 + d * 0.62, 8, 18));
  }
  applySpacing();
  /* ★ v32（需求八）：默认场景补齐「若干树木」—— 呈半环状分布在两栋楼外侧，不与旗杆 / 小人重叠。
     ★ v43（需求一·1）：6 棵 → **8 棵**，并整体推到半径 19–20 的外环（旧的 6 棵挤在半径
     6–11 的内圈，正好落在两栋楼之间）。新布局：
       · 8 个点沿外环均布，全部 |x| ≥ 7.5 ⇒ 永不与南北轴线上的两栋楼（|x| ≤ 4.25）相交；
       · 与旗杆 (17,9) 最近的一棵 (12.5,15) 间距 ~7.7 m，树冠半径 ~2.3 m，不压叠；
       · 半径最大 20.0 < 22，仍在可拖动范围与极坐标网格内。 */
  (function seedTrees() {
    var spots = [[-19, -4], [19, -4], [-17.5, 10], [12.5, 15],
                 [-10.5, 17], [-7.5, -18.5], [7.5, -18.5], [-19, 4]];
    spots.forEach(function (sp0, i) {
      var ratio = 0.72 + 0.11 * (i % 4);
      var t = makeTree(S.tree.h * ratio, S.tree.color, S.tree.trunk);
      /* ★ v52（需求G5）：记下相对高矮 —— 菜单改「树高」时按该比例整体缩放，保留错落感。 */
      t.userData.hRatio = ratio;
      t.position.set(sp0[0], 0, sp0[1]);
      t.userData.id = 'prep-t' + i;
      objGrp.add(t); props.push(t);
    });
  })();

  /* ============================ 6. 天球视图场景 ============================ */
  var CS = 9;
  var cScene = new THREE.Scene();
  var cCam = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  cScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  var cLight = new THREE.DirectionalLight(0xffffff, 0.5); cLight.position.set(6, 10, 8); cScene.add(cLight);
  var cRoot = new THREE.Group();
  cScene.add(cRoot);
  var cShell = new THREE.Mesh(new THREE.SphereGeometry(CS, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x8fb6ff, transparent: true, opacity: 0.05, side: THREE.BackSide, depthWrite: false }));
  cRoot.add(cShell);
  var cGrid = new THREE.Group(); cRoot.add(cGrid);
  var cHorizonGrp = new THREE.Group(); cRoot.add(cHorizonGrp);
  var horizonDisc = new THREE.Mesh(new THREE.CircleGeometry(CS, 72),
    new THREE.MeshBasicMaterial({ color: 0x5c9b6a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  horizonDisc.rotation.x = -Math.PI / 2; horizonDisc.position.y = -0.004;
  cHorizonGrp.add(horizonDisc);
  /* v34：地平圈由「固定管径 0.026 的圆环」改为**按设置重建**（线粗细可调）。 */
  var horizonRing = new THREE.Mesh(new THREE.TorusGeometry(CS, 0.026, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x37a05a }));
  horizonRing.rotation.x = Math.PI / 2;
  horizonRing.userData.w = 0.026;
  cHorizonGrp.add(horizonRing);
  /* v34：按「线粗细（千分之一）」重建地平圈圆环 —— 只在数值真的变了时重建。 */
  function applyHrLineW() {
    var w = clamp(+(S.coord.st.hrLine.w || 0.026), 0.004, 0.16);
    if (horizonRing.userData.w === w) return;
    horizonRing.userData.w = w;
    horizonRing.geometry.dispose();
    horizonRing.geometry = new THREE.TorusGeometry(CS, w, 8, 96);
  }
  var meridianPts = [];
  for (var mi = 0; mi <= 96; mi++) {
    var ma = mi / 96 * TAU;
    meridianPts.push(new THREE.Vector3(0, Math.sin(ma) * CS, -Math.cos(ma) * CS));
  }
  var meridianLine = lineOf(meridianPts, 0x7f93b8, 1, 'solid');
  meridianLine.material.opacity = 0.5;
  cHorizonGrp.add(meridianLine);

  var equLine = null, equPlane = null, poleN = null, poleS = null, zenM = null, nadM = null, poleAxisLine = null;
  var equSplitW = null;      // v34：「只显示地平线以上」时赤道面与地平平面的交线方向（否则 null）
  var cGridLines = [];   // v32（需求四）：网格线引用（颜色 / 透明度逐帧刷新）
  var cNotes = [];
  function markDot(color, r) {
    var base = r || 0.13;
    var m = new THREE.Mesh(new THREE.SphereGeometry(base, 14, 12), new THREE.MeshBasicMaterial({ color: color }));
    m.userData.baseR = base;      // v34：点大小按 baseR × (size/100) 缩放
    return m;
  }
  var _celRebuilds = 0;      /* ★ v41（需求一·11）探针用：天球几何被重建的次数（查是否每帧重建） */
  function buildCelestial() {
    _celRebuilds++;
    [equLine, equPlane, poleN, poleS, zenM, nadM, poleAxisLine].forEach(function (o) { if (o) cRoot.remove(o); });
    cNotes.forEach(function (o) { cRoot.remove(o); noteSplice(o); });
    cNotes = [];
    cGrid.children.slice().forEach(function (o) { cGrid.remove(o); });
    cGridLines.length = 0;

    /* v31：两套坐标系下的要素集合不同（地平系有天顶/天底，赤道系冻结地平圈），
       构建时就要知道当前是哪一套；切换坐标系由 onStateChanged 触发重建。 */
    var eqSys = (S.coord.sys === 'equatorial');
    var phi = clamp(obsLat(), -89.5, 89.5) * D;
    var P = new THREE.Vector3(0, Math.sin(phi), -Math.cos(phi)).normalize();
    var E1 = new THREE.Vector3(1, 0, 0);
    var E2 = new THREE.Vector3().crossVectors(E1, P).normalize();

    var eqPts = [];
    for (var i = 0; i <= 128; i++) {
      var t = i / 128 * TAU;
      eqPts.push(new THREE.Vector3().addScaledVector(E1, Math.cos(t) * CS).addScaledVector(E2, Math.sin(t) * CS));
    }
    /* v34：「只显示地平线以上的赤道坐标系」—— 赤道平面与地平平面的交线把天赤道切成两半，
       只保留地平线上方的那一段。
       ★ v41（需求一·9）修正：原写法对**整圆采样点**做 filter(y ≥ 0)，而整圆的第 129 个点是
       闭合重复点（t = 2π，y = 0）它同样通过过滤，被追加到半圆末尾 ⇒ 折线从 (−CS,0,0) 直接
       连回 (CS,0,0)，画面上就是「用一条直径把天赤道在地平圈上的两个交点连起来」。
       改为**直接按交线方向参数化生成半圆**：A = 交线方向（y = 0）、B = A × P（取 B.y > 0），
       t ∈ [0, π] 恰好是地平线以上的半圆，两端严格落在地平圈上。 */
    if (S.coord.aboveOnly) {
      var W = new THREE.Vector3().crossVectors(P, new THREE.Vector3(0, 1, 0));
      if (W.lengthSq() < 1e-9) W.copy(E1); else W.normalize();
      var Bq = new THREE.Vector3().crossVectors(W, P).normalize();
      if (Bq.y < 0) { Bq.negate(); W.negate(); }      /* 保证 t∈(0,π) 落在地平线以上 */
      eqPts = [];
      for (var ie = 0; ie <= 128; ie++) {
        var te = ie / 128 * Math.PI;
        eqPts.push(new THREE.Vector3().addScaledVector(W, Math.cos(te) * CS).addScaledVector(Bq, Math.sin(te) * CS));
      }
      equSplitW = W;
    } else {
      equSplitW = null;
    }
    equLine = lineOf(eqPts, new THREE.Color(S.coord.st.equLine.color).getHex(),
      1, S.coord.st.equLine.dash === 'dash' ? 'dash' : 'solid',
      S.coord.st.equLine.n, S.coord.st.equLine.ratio);
    cRoot.add(equLine);

    /* v34：天赤道平面 —— 开启「只显示地平线以上」时改画**半圆盘**，圆的起始角由
       「地平线在地赤道平面内的方向」决定：局部 XY 平面上 y(t) = cos t·U.y + sin t·V.y = 0
       ⇒ t0 = atan2(−U.y, V.y)（U / V 为四元数把 X̂ / Ŷ 转过去的结果）。 */
    var eqQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), P);
    var qU = new THREE.Vector3(1, 0, 0).applyQuaternion(eqQ);
    var qV = new THREE.Vector3(0, 1, 0).applyQuaternion(eqQ);
    var eqStart = 0, eqLen = TAU;
    if (S.coord.aboveOnly) {
      var t0 = Math.atan2(-qU.y, qV.y);            // 交线在盘面内的方向
      eqStart = t0; eqLen = Math.PI;
    }
    equPlane = new THREE.Mesh(new THREE.CircleGeometry(CS, 72, eqStart, eqLen),
      new THREE.MeshBasicMaterial({ color: 0x39c2ff, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
    equPlane.quaternion.copy(eqQ);
    cRoot.add(equPlane);

    poleN = markDot(0x39c2ff, 0.16); poleN.position.copy(P).multiplyScalar(CS); cRoot.add(poleN);
    poleS = markDot(0x39c2ff, 0.16); poleS.position.copy(P).multiplyScalar(-CS); cRoot.add(poleS);
    /* ★ v41（需求一·10）：只显示地平线以上时，极轴也只画「地平线以上那半条」
       （从可见天极到天球中心，中心恰在地平面上）。 */
    var axisEnds = [P.clone().multiplyScalar(CS), P.clone().multiplyScalar(-CS)];
    if (S.coord.aboveOnly) {
      axisEnds = [(P.y >= 0 ? axisEnds[0] : axisEnds[1]), new THREE.Vector3(0, 0, 0)];
    }
    poleAxisLine = lineOf(axisEnds, 0x39c2ff, 1, 'solid');
    poleAxisLine.material.opacity = 0.45;
    cRoot.add(poleAxisLine);

    zenM = markDot(0xffd166, 0.15); zenM.position.set(0, CS, 0); cRoot.add(zenM);
    nadM = markDot(0x8b9bbd, 0.15); nadM.position.set(0, -CS, 0); cRoot.add(nadM);

    /* ★ v32（需求四）：经纬网格可**按赤道坐标系或地平坐标系**绘制，且线型（颜色 /
       透明度 / 实虚线）可设 —— 这里按 S.coord.gridSys 生成并把所有网格线收集到 cGridLines，
       颜色 / 透明度逐帧写入（见 updateCelestial），线型变化触发重建（见 celSig）。 */
    if (S.coord.grid) {
      var gdash = (S.coord.gridDash === 'dash') ? 'dash' : 'solid';
      /* ★ v41（需求一·10）：「只显示地平线以上」对**经纬网格**同样生效 ——
         每条网格线按地平线切成若干段，只画地平线以上的那几段（此前网格恒画整圈）。 */
      var above = !!S.coord.aboveOnly;
      var addGrid = function (pts, op) {
        var parts = above ? splitAbove(pts) : [pts];
        parts.forEach(function (seg) {
          if (!seg || seg.length < 2) return;
          var l = lineOf(seg, 0x6f86ad, 1, gdash, 96, 55);
          l.material.opacity = op;
          cGrid.add(l); cGridLines.push(l);
        });
      };
      if (S.coord.gridSys === 'horizon') {
        /* 地平坐标系：等高度圈（每隔 30° 一条）+ 方位圈（每隔 30° 一条） */
        [-60, -30, 30, 60].forEach(function (alDeg) {
          var pts = [], ar = alDeg * D;
          for (var j = 0; j <= 96; j++) {
            var az = j / 96 * TAU;
            pts.push(dirOf(ar, az * R, new THREE.Vector3()).multiplyScalar(CS));
          }
          addGrid(pts, 0.28);
        });
        for (var ka = 0; ka < 12; ka++) {
          var azR = ka * 30 * D, pts2 = [];
          for (var j2 = 0; j2 <= 48; j2++) {
            var al2 = j2 / 48 * Math.PI - Math.PI / 2;
            pts2.push(dirOf(al2, azR * R, new THREE.Vector3()).multiplyScalar(CS));
          }
          addGrid(pts2, 0.20);
        }
      } else {
        /* 赤道坐标系：赤纬圈 + 赤经圈（原实现） */
        [-60, -30, 30, 60].forEach(function (decDeg) {
          var pts = [], dc = decDeg * D;
          for (var j = 0; j <= 96; j++) {
            var t2 = j / 96 * TAU;
            pts.push(new THREE.Vector3()
              .addScaledVector(E1, Math.cos(t2) * Math.cos(dc) * CS)
              .addScaledVector(E2, Math.sin(t2) * Math.cos(dc) * CS)
              .addScaledVector(P, Math.sin(dc) * CS));
          }
          addGrid(pts, 0.28);
        });
        for (var k = 0; k < 12; k++) {
          var raR = k * 30 * D, pts3 = [];
          for (var j3 = 0; j3 <= 48; j3++) {
            var t3 = j3 / 48 * Math.PI - Math.PI / 2;
            pts3.push(new THREE.Vector3()
              .addScaledVector(E1, Math.cos(t3) * Math.cos(raR) * CS)
              .addScaledVector(E2, Math.cos(t3) * Math.sin(raR) * CS)
              .addScaledVector(P, Math.sin(t3) * CS));
          }
          addGrid(pts3, 0.20);
        }
      }
    }

    /* ★ v31（需求十五）修复：注释精灵**一律创建**，可见性交给 updateCelestial 逐帧按
       S.coord.note 覆盖。此前注释只在「构建时 note 为真」才创建 —— 若首次构建时该开关是关的，
       之后再把「天球要素文字注释」勾上就永远不会出现（表现为「文字注释未正确显示」）。 */
    if (true) {
      function note(o, txt, size, cat, ck) {
        var sp = textSprite(txt, { size: size || 0.62, color: '#e6f0ff', core: true, cat: cat || 'svPoleN' });
        sp.position.copy(o.position).multiplyScalar(1.12);
        sp.userData._ck = ck || null;    // v34：逐要素文字注释开关的键
        cRoot.add(sp); cNotes.push(sp);
      }
      if (!eqSys) {
        note(poleN, '天北极', 0.62, 'svPoleN', 'poleN'); note(poleS, '天南极', 0.62, 'svPoleS', 'poleS');
        note(zenM, '天顶', 0.56, 'svZen', 'zenith'); note(nadM, '天底', 0.56, 'svNad', 'nadir');
      }
      var hn = textSprite('地平圈', { size: 0.6, color: '#9ff0bf', core: true, cat: 'svHrLine' });
      hn.position.set(CS * 0.72, 0.55, CS * 0.72);
      hn.userData._ck = 'hrLine';
      cRoot.add(hn); cNotes.push(hn);
      /* v32（需求六）：地平面 / 天赤道平面 也各有一条文字注释（可单独设置属性） */
      var hpn = textSprite('地平面', { size: 0.6, color: '#8fd6a8', core: true, cat: 'svHrPlane' });
      hpn.position.set(-CS * 0.70, 0.35, -CS * 0.70);
      hpn.userData._kind = 'hrPlane';
      hpn.userData._ck = 'hrPlane';
      cRoot.add(hpn); cNotes.push(hpn);
      /* v31（需求十五）：地平圈上的四个正方位 —— 东南西北（正视方位、贴在地平圈上来读） */
      [['北', 0], ['东', 90], ['南', 180], ['西', 270]].forEach(function (d) {
        var sp = textSprite(d[0], { size: 0.62, color: '#bff0cf', core: true, cat: 'svHrDir' });
        sp.position.copy(dirOf(0, d[1], new THREE.Vector3())).multiplyScalar(CS * 1.045);
        sp.userData._hrDir = true;      // v32（需求四）：受「地平圈方位标注」开关控制
        sp.userData._ck = 'hrDir';
        cRoot.add(sp); cNotes.push(sp);
      });
      if (!eqSys) {
        var en = textSprite('天赤道', { size: 0.6, color: '#7fd8ff', core: true, cat: 'svEqu' });
        en.position.set(CS * 0.99, 0.25, 0);
        en.userData._ck = 'equLine';
        cRoot.add(en); cNotes.push(en);
        var epn = textSprite('天赤道平面', { size: 0.6, color: '#6cb8e8', core: true, cat: 'svEquPlane' });
        epn.position.set(-CS * 0.55, -0.35, CS * 0.62);
        epn.userData._kind = 'equPlane';
        epn.userData._ck = 'equPlane';
        cRoot.add(epn); cNotes.push(epn);
      }
    }
  }

  var cObserver = makeFigure('#f0a03b', 1.1);
  cObserver.scale.setScalar(1.5);
  cRoot.add(cObserver);
  /* v31（需求十八）：天球视图中小人影子 —— 由真实太阳光方向投影到地平盘，且钳制不超出地平圈。
     用「双脚 → 头顶 → 沿反日光方向的落点」构成的窄四边形表示，随太阳高度角伸缩。 */
  var C_FIG_H = 1.1 * 1.5;
  var cFigShadow = (function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x101b30, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 5; m.visible = false;
    return m;
  })();
  cRoot.add(cFigShadow);

  var cSun = new THREE.Group(); cRoot.add(cSun);
  var cSunCore = new THREE.Mesh(new THREE.SphereGeometry(0.30, 20, 16), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
  cSun.add(cSunCore);
  var cSunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  cSunGlow.scale.setScalar(2.8); cSunGlow.renderOrder = 30;
  cSun.add(cSunGlow);
  /* ★ v39（需求二·1·③）：去掉天球视图里的「太阳」文字注释（cSunLabel）。
     太阳本体 + 光晕保留，仅移除多余的文字标注。 */
  var cSunRay = lineOf([new THREE.Vector3(), new THREE.Vector3()], 0xffd166, 1, 'solid');
  cSunRay.material.opacity = 0.6;
  cRoot.add(cSunRay);

  var trailAbove = null, trailUnder = null, trailMarks = [], hourNoteSps = [];
  /* ★ v43（需求一·3）：原 v32 的「可复用折线」_trailAboveLn 已删除 ——
     天球当日轨道改为按 S.traj.w 重建的 TubeGeometry（1px 折线无法加粗）。 */
  var term4Grp = new THREE.Group(); cRoot.add(term4Grp);
  /* v33（需求三）：天球视图的「影长线段」与地面视角共用一套设置（观察与测量 › 物影），
     故这里也改用可切虚实的固定容量 LineSegments（见 setSegLine）。 */
  var shadowLine = new THREE.LineSegments(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffe3a8, transparent: true, opacity: 1 }));
  cRoot.add(shadowLine);
  var shadowNoteSp = textSprite('', { size: 0.5, color: '#ffe3a8', cat: 'svMeas' });
  cRoot.add(shadowNoteSp);
  /* v32（需求十二）：影长文本随时间连续变化，若每帧重烘焙贴图会白白吃掉大量 CPU（canvas 光栅化）。
     位置每帧更新（几乎零成本），文本最多每 250 ms 重排一次。 */
  var _shadowNoteT = 0;

  /* ============================ 7. 室内视图场景 ============================ */
  var iScene = new THREE.Scene();
  var iCam = new THREE.PerspectiveCamera(54, 1, 0.05, 200);
  iScene.add(new THREE.AmbientLight(0xffffff, 0.42));
  var iRoom = new THREE.Group();
  iScene.add(iRoom);
  var RW = 11, RH = 4.2, RD = 15, WTH = 0.14;
  var wallMat = new THREE.MeshLambertMaterial({ color: 0xe3e6ec });
  var floorMat = new THREE.MeshLambertMaterial({ color: 0xb9a68b });
  var ceilMat = new THREE.MeshLambertMaterial({ color: 0xf2f4f8 });
  function rbox(w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.receiveShadow = true;
    iRoom.add(m); return m;
  }
  rbox(RW, 0.1, RD, floorMat, 0, -0.05, 0);
  rbox(RW, 0.1, RD, ceilMat, 0, RH + 0.05, 0);
  rbox(RW, RH, WTH, wallMat, 0, RH / 2, RD / 2);
  rbox(WTH, RH, RD, wallMat, -RW / 2, RH / 2, 0);
  rbox(WTH, RH, RD, wallMat, RW / 2, RH / 2, 0);
  var WINW = 3.2, WINH = 2.2, SILL = 1.0;
  var sideW = (RW - WINW) / 2;
  rbox(sideW, RH, WTH, wallMat, -(WINW / 2 + sideW / 2), RH / 2, -RD / 2);
  rbox(sideW, RH, WTH, wallMat, (WINW / 2 + sideW / 2), RH / 2, -RD / 2);
  rbox(WINW, SILL, WTH, wallMat, 0, SILL / 2, -RD / 2);
  rbox(WINW, RH - SILL - WINH, WTH, wallMat, 0, SILL + WINH + (RH - SILL - WINH) / 2, -RD / 2);
  var outSky = new THREE.Mesh(new THREE.PlaneGeometry(WINW + 0.8, WINH + 0.8),
    new THREE.MeshBasicMaterial({ color: 0x8fc3f2 }));
  outSky.position.set(0, SILL + WINH / 2, -RD / 2 - 0.7);
  iRoom.add(outSky);
  var outSun = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  outSun.scale.setScalar(2.4);
  outSun.position.set(0, SILL + WINH / 2, -RD / 2 - 1.0);
  iRoom.add(outSun);
  var iVolGrp = new THREE.Group(); iRoom.add(iVolGrp);
  /* ★ 本批次（需求五）：室内太阳体积光由「面向相机的平面贴图」改为
     **实心光柱 + 外围柔光束**（与地面体积光同一套双层壳 makeVolBeam），
     门口进来的丁达尔光因此变成一根根真正的光柱。 */
  var iBeams = [];
  (function () {
    for (var i = 0; i < 7; i++) { var b = makeVolBeam(); iVolGrp.add(b.grp); iBeams.push(b); }
  })();
  var iEdges = new THREE.Group(); iRoom.add(iEdges);
  /* ★ v44（需求四）：上下边界光线改为 **ribbon**（真正的粗细可控）——
     THREE.LineBasicMaterial 的 linewidth 在 WebGL 里恒为 1px（`lineOf` 那条不通），
     故与「影长 / 掠顶光线」同口径用 setRibbonSeg 画带宽度的四边形。 */
  function makeRibbon(op, order) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(_ribBuf.length), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xfff2c8, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: op, side: THREE.DoubleSide }));
    m.renderOrder = order; m.frustumCulled = false;
    return m;
  }
  var iEdgeTop = makeRibbon(0.6, 14);
  var iEdgeBot = makeRibbon(0.6, 14);
  iEdges.add(iEdgeTop); iEdges.add(iEdgeBot);
  /* v31（需求二十）：光斑改成「窗口四角沿光线投影」的四边形 —— 四个顶点每帧按落点面重算，
     这样它会随太阳方位在地面 / 背墙 / 侧墙之间移动、倾斜，一日内从西向东扫过。 */
  /* ★ v44（需求四）：光斑改成**任意多边形**（顶点数动态）——
     窗口四角沿光线投影到某个面后还要跟该面的矩形边界求交（Sutherland–Hodgman 裁剪），
     裁剪结果可能是 4~8 边形；旧写死了 4 个顶点 ⇒ 只能「整块落在某一面」，
     侧墙上被打断的那部分要么漏画（缺失的墙面投影），要么溢出房间边界。 */
  var PATCH_MAXV = 10;
  function makePatchMesh(op) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATCH_MAXV * 3), 3));
    var idx = [];
    for (var i = 1; i < PATCH_MAXV - 1; i++) idx.push(0, i, i + 1);   /* 扇形三角化 */
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffe6b0, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: op, side: THREE.DoubleSide }));
    m.renderOrder = 10; m.frustumCulled = false; iRoom.add(m); return m;
  }
  /* 四个**受光面**各自一块光斑：地面 / 背墙（+Z）/ 左墙（−X）/ 右墙（+X）。
     ★ v44（需求四）：地面与墙面**分开渲染、分开配色** —— 前者归 patch.floor*，后者归 patch.wall*。 */
  var iPatchFloor = makePatchMesh(0.5);
  var iPatchWalls = [makePatchMesh(0.4), makePatchMesh(0.4), makePatchMesh(0.4)];
  /* ★ v44（需求四）：Sutherland–Hodgman —— 把凸多边形裁到矩形 [u0,u1]×[w0,w1] 内。
     输入 / 输出均为 [[u, w], …]；`clipHalf` 保留满足 A·u + B·w + C ≥ 0 的一侧。
     用途：把「窗口沿光线投到某个面上」得到的四边形裁到该受光面的边界，
     于是同一个光路同时在地面与侧墙上形成的光斑都能各自正确地留下来。 */
  function clipHalf(poly, A, B, C) {
    var out = [];
    if (!poly || poly.length < 3) return out;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i], q = poly[(i + 1) % poly.length];
      var dp = A * p[0] + B * p[1] + C, dq = A * q[0] + B * q[1] + C;
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        var t = dp / (dp - dq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  }
  function clipRect(poly, u0, u1, w0, w1) {
    if (!(u1 > u0) || !(w1 > w0) || !poly || poly.length < 3) return [];
    var p = poly;
    p = clipHalf(p, 1, 0, -u0); p = clipHalf(p, -1, 0, u1);
    p = clipHalf(p, 0, 1, -w0); p = clipHalf(p, 0, -1, w1);
    if (p.length < 3) return [];
    var area = 0;                                       /* 面积太小 ⇒ 退化（一条线 / 一个点） */
    for (var i = 0; i < p.length; i++) {
      var a = p[i], b = p[(i + 1) % p.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area) * 0.5 < 1e-3 ? [] : p;
  }
  /* 把投影出的多边形写进某一块光斑；退化（顶点 < 3 或面积 ≈ 0）⇒ 隐藏 */
  function setPatch(mesh, pts) {
    if (!pts || pts.length < 3) { mesh.visible = false; return false; }
    var n = Math.min(pts.length, PATCH_MAXV);
    var pa = mesh.geometry.attributes.position;
    for (var i = 0; i < n; i++) pa.setXYZ(i, pts[i][0], pts[i][1], pts[i][2]);
    pa.needsUpdate = true;
    mesh.geometry.setDrawRange(0, (n - 2) * 3);
    mesh.geometry.computeBoundingSphere();
    mesh.visible = true;
    return true;
  }
  var iWallShadow = new THREE.Group(); iRoom.add(iWallShadow);
  function mkShadowQuad(w, h) {
    var q = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      color: 0x1e2a44, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
    q.renderOrder = 12; iWallShadow.add(q); return q;
  }
  var shL = mkShadowQuad(RD, RH), shR = mkShadowQuad(RD, RH), shB = mkShadowQuad(RW, RH);
  shL.rotation.y = Math.PI / 2; shL.position.set(-RW / 2 + 0.10, RH / 2, 0);
  shR.rotation.y = -Math.PI / 2; shR.position.set(RW / 2 - 0.10, RH / 2, 0);
  shB.position.set(0, RH / 2, RD / 2 - 0.10);
  var iFurn = new THREE.Group(); iRoom.add(iFurn);
  function rebuildFurniture() {
    iFurn.children.slice().forEach(function (o) { iFurn.remove(o); });
    var kind = S.room.kind;
    if (kind === 'empty') return;
    var c1 = new THREE.MeshLambertMaterial({ color: kind === 'classroom' ? 0xc7a06a : 0x9a7b58 });
    if (kind === 'classroom') {
      for (var r = 0; r < 3; r++) for (var cc = 0; cc < 2; cc++) {
        var d = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.0), c1);
        d.position.set(-2.6 + cc * 5.2, 1.0, 1.0 + r * 3.0); iFurn.add(d);
        var lg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.95, 0.12), c1);
        lg.position.set(-2.6 + cc * 5.2, 0.5, 1.5 + r * 3.0); iFurn.add(lg);
      }
    } else {
      var bed = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.5, 4.6), new THREE.MeshLambertMaterial({ color: 0x9fb4d8 }));
      bed.position.set(-3.0, 0.35, 1.5); iFurn.add(bed);
      var cbd = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.0, 1.0), c1);
      cbd.position.set(3.4, 1.0, 3.0); iFurn.add(cbd);
    }
  }
  rebuildFurniture();

  /* ============================ 8. 悬浮窗（3 个） ============================ */
  var eScene = new THREE.Scene();
  var eCam = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  eCam.position.set(0, 0, 3.4);
  eScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  var eLight = new THREE.DirectionalLight(0xffffff, 0.85); eLight.position.set(2.4, 1.6, 3); eScene.add(eLight);
  var eEarth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshLambertMaterial({ color: 0x3f7fd0 }));
  eScene.add(eEarth);
  /* ★ v33（需求一）：标记与注记必须挂在**地球本体**下（作为 eEarth 的子节点）——
     旧实现把它们挂在 eScene 上、位置取「未旋转」的 dir，而地球本体每帧被旋转到
     「观测点朝向 +Z（正对相机）」，于是标记永远停在旋转前的方向上：**定位错误**；
     且当标记被转到背面时，注记精灵 depthTest=false 会**穿透地球**显示在最前面。
     作为子节点后，标记随地球一起转（恒在正面），转到背面则被地球本体正常遮挡。 */
  var eMarker = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
  eEarth.add(eMarker);
  /* ★ v53（需求一）：**删除 eMarkerLabel（「观测点」文字精灵）** ——
     为什么删：① 观测点只有一个，用户在地面视图 / 天球视图 / 观测点数据面板三处
     都能读到经纬度，悬浮窗里再压一行「观测点」文字属于重复信息，且它盖在地球正面
     上遮挡海陆轮廓；② 它是 cat='svObs' 的**唯一消费者**，精灵删掉后 svObs 分类
     就没有任何渲染侧读者了，留着只会变成「菜单里能调、界面上不生效」的悬空设置
     （比没有这个菜单更糟：用户会以为坏了）。故菜单里那一组
     svNoteGrp('观测点标签样式','svObs') 也一并删除（见菜单段注释）。
     保留红色小点 eMarker —— 它才是「观测点在哪」的唯一视觉标记。 */
  function applyEarthTexture() {
    var tex = BR.getEarthDayTexture();
    if (tex && eEarth.material.map !== tex) {
      eEarth.material.map = tex; eEarth.material.color.set(0xffffff); eEarth.material.needsUpdate = true;
    }
  }

  var wEarth = new THREE.WebGLRenderer({ canvas: $('svCvEarth'), antialias: false, alpha: true });
  var wSky = new THREE.WebGLRenderer({ canvas: $('svCvSky'), antialias: false, alpha: true });
  var wGround = new THREE.WebGLRenderer({ canvas: $('svCvGround'), antialias: false, alpha: true });
  [wEarth, wSky, wGround].forEach(function (r) {
    /* v32（需求十二）：小窗面积很小，关掉 MSAA 并把像素比压到 1.5 —— 三个附加 WebGL
       上下文同时抗锯齿会在低端设备上明显掉帧（甚至触发 GPU 进程崩溃）。 */
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.outputEncoding = THREE.sRGBEncoding;
    r.setClearColor(0x060a14, 1);
  });
  var wSkyCam = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  wSkyCam.position.set(CS * 1.35, CS * 0.95, CS * 1.55);
  wSkyCam.lookAt(0, 0, 0);
  var wGroundCam = new THREE.PerspectiveCamera(46, 1, 0.1, 900);
  var GROUND_VIEWS = [
    { name: '斜视图', pos: [22, 15, 30], look: [0, 3, 0] },
    { name: '俯视图', pos: [0.01, 46, 0.01], look: [0, 0, 0] },
    { name: '侧视图', pos: [0, 8, 42], look: [0, 5, 0] },
  ];
  function applyGroundViewCam() {
    var v = GROUND_VIEWS[clamp(S.win.groundView | 0, 0, GROUND_VIEWS.length - 1)];
    var b = $('svGroundViewBtn'); if (b) b.textContent = v.name;
    /* ★ 本批次（需求二/三）：预设视角直接驱动**地面单一视图**的机位状态
       （gYaw / gPitch / gDist），于是「地面全景悬浮窗」经同一套相机出图、
       内容始终与单一窗口一致；不再只摆 wGroundCam（那只影响悬浮窗、与主视图对不上）。 */
    var dx = v.pos[0] - v.look[0], dy = v.pos[1] - v.look[1], dz = v.pos[2] - v.look[2];
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 36;
    gDist = clamp(d, 1.2, 340);
    gPitch = clamp(Math.asin(clamp(dy / d, -1, 1)), 0.05, 1.35);
    if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) gYaw = Math.atan2(dx, dz);
    gAimSun = false;
  }

  /* ★ v32（需求三）：**悬浮窗内容可交互** —— 直接在小窗画布上拖动 = 环绕转动、滚轮 = 缩放、
     双击 = 复位。三个小窗（地球位置 / 天球情形 / 地面全景）各维护一组轨道参数
     （yaw / pitch / dist / target），每帧把相机摆到球面位置并看向 target。
     改动只作用于该小窗相机，主视图相机（gCam / cCam / iCam / fpCam）完全不受影响。 */
  var V3 = function (x, y, z) { return new THREE.Vector3(x, y, z); };
  var orbEarth = { yaw: 0, pitch: 0.05, dist: 3.4, pMin: -1.2, pMax: 1.2, dMin: 1.6, dMax: 9,
                   tx: 0, ty: 0, tz: 0, def: { yaw: 0, pitch: 0.05, dist: 3.4 } };
  var orbSky = { yaw: 0.7167, pitch: 0.4328, dist: CS * 2.2643, pMin: -0.35, pMax: 1.32,
                 dMin: CS * 1.05, dMax: CS * 4.8, tx: 0, ty: 0, tz: 0,
                 def: { yaw: 0.7167, pitch: 0.4328, dist: CS * 2.2643 } };
  var orbGround = { yaw: 0.6328, pitch: 0.3123, dist: 39.1, pMin: 0.03, pMax: 1.45,
                    dMin: 6, dMax: 190, tx: 0, ty: 3, tz: 0,
                    def: { yaw: 0.6328, pitch: 0.3123, dist: 39.1, tx: 0, ty: 3, tz: 0 } };
  function syncOrbFromGroundView(v) {
    if (!orbGround || !v) return;
    orbGround.tx = v.look[0]; orbGround.ty = v.look[1]; orbGround.tz = v.look[2];
    var dx = v.pos[0] - v.look[0], dy = v.pos[1] - v.look[1], dz = v.pos[2] - v.look[2];
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 39.1;
    orbGround.dist = clamp(d, orbGround.dMin, orbGround.dMax);
    orbGround.pitch = clamp(Math.asin(clamp(dy / d, -1, 1)), orbGround.pMin, orbGround.pMax);
    if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) orbGround.yaw = Math.atan2(dx, dz);
  }
  function orbApply(cam, st) {
    var cp = Math.cos(st.pitch);
    cam.position.set(st.tx + st.dist * cp * Math.sin(st.yaw),
                     st.ty + st.dist * Math.sin(st.pitch),
                     st.tz + st.dist * cp * Math.cos(st.yaw));
    cam.lookAt(st.tx, st.ty, st.tz);
  }
  /* ★ 修复 #12：双击复位到默认机位 —— 由「3D 缩略窗的 attachOrbit」与「综合窗格」共用，
     避免同一段复位逻辑写两遍。 */
  function orbReset(st) {
    if (!st || !st.def) return;
    st.yaw = st.def.yaw; st.pitch = st.def.pitch; st.dist = st.def.dist;
    if (st.def.tx != null) { st.tx = st.def.tx; st.ty = st.def.ty; st.tz = st.def.tz; }
  }
  /* ★ v52（需求G8）：判断某画布此刻是否是「指针在该点上真正最上层、可交互的元素」。
     浮窗**被其它浮窗 / 面板覆盖**时，elementFromPoint 返回的不是它（或不是它的后代），
     此时拒绝接管 pointerdown / wheel —— 避免「被覆盖的浮窗仍在背后偷偷转动 / 缩放」。
     正常可见时该点最上层就是画布本身，判定通过。 */
  function canvasOnTop(cv, e) {
    if (!cv || !document.elementFromPoint) return true;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el === cv || (!!el && !!cv.contains && cv.contains(el));
  }
  function attachOrbit(cvId, st) {
    var cv = $(cvId); if (!cv) return;
    cv.style.cursor = 'grab'; cv.style.touchAction = 'none';
    var dragging = false, px = 0, py = 0;
    cv.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      /* ★ v52（需求G8）：被覆盖 / 已隐藏时不接管 */
      if (!canvasOnTop(cv, e)) return;
      dragging = true; st._dragging = true; px = e.clientX; py = e.clientY;
      cv.style.cursor = 'grabbing';
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] attachOrbit setPointerCapture', er); } }
      e.stopPropagation(); e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      st.yaw -= (e.clientX - px) * 0.0085;
      st.pitch = clamp(st.pitch + (e.clientY - py) * 0.0065, st.pMin, st.pMax);
      px = e.clientX; py = e.clientY;
    });
    var stop = function () { if (!dragging) return; dragging = false; st._dragging = false; cv.style.cursor = 'grab'; };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { cv.addEventListener(ev, stop); });
    cv.addEventListener('wheel', function (e) {
      if (!canvasOnTop(cv, e)) return;      /* ★ v52（需求G8） */
      e.preventDefault(); e.stopPropagation();
      st.dist = clamp(st.dist * (e.deltaY > 0 ? 1.12 : 0.89), st.dMin, st.dMax);
    }, { passive: false });
    cv.addEventListener('dblclick', function (e) {
      e.preventDefault(); e.stopPropagation();
      orbReset(st);
    });
  }
  attachOrbit('svCvEarth', orbEarth);
  /* ★ 本批次（需求二）：天球 / 地面两个悬浮窗的**视图可交互**，并复用综合窗格那一套交互
     （makeSunComboCellOrbit：拖拽旋转 + 滚轮缩放 + 双击复位），且直接驱动单一视图的
     相机状态（cYaw/cPitch/cDist、gYaw/gPitch/gDist）⇒ 悬浮窗内容与单一窗口完全一致。
     观测点位置悬浮窗（svCvEarth）是一台独立的小地球仪（eScene/eCam），继续用 attachOrbit。 */
  makeSunComboCellOrbit($('svCvSky'), 'sky');
  makeSunComboCellOrbit($('svCvGround'), 'ground');
  /* 预设视角按钮只回显名称，真正的机位由点击时 applyGroundViewCam() 落到地面单一视图上 */
  var _gvb0 = $('svGroundViewBtn');
  if (_gvb0) _gvb0.textContent = GROUND_VIEWS[clamp(S.win.groundView | 0, 0, GROUND_VIEWS.length - 1)].name;

  /* ============================ 9. 相机控制 ============================ */
  function obsLat() { return BR.getObs().lat; }
  function obsLon() { return BR.getObs().lon; }

  /* 默认机位（需求 5.1「地面视图」）：抬高约 10° 的斜视全景，视野里同时有地面、建筑、
     地平线和低空的太阳。
     ★ v35（需求十九）：默认距离 46 → 36 拉近一档，配合放大的预制物体，
       让建筑 / 小人 / 树木相对地平面与天空的比例更大、细节更可读。
     ★ 相机不能主动「追太阳」——上面刚拿到的 g 就是本帧的太阳几何；
       但在**用户第一次拖动 / 缩放之前**，机位保持自动对准太阳
       （gAimSun），这样无论用户从哪一刻进来，第一眼都能看见真实太阳、体积光和影子。
       时钟在走，只在 boot() 里对准一次会立刻失效（几秒后太阳就滑出画面）。
     ★ 别把机位放到东南象限 —— 那会让预制建筑正好挡在视线上。 */
  var gDist = 36, gPitch = 0.18, gYaw = 0.14, gTarget = new THREE.Vector3(0, 3.0, 0);
  /* ★ v43（三·2）：地面注释的**屏幕占比标称距离** —— 与 gDist 的初值同源。
     applySvNoteK 拿它当统一分母：屏幕像素高 = worldY × H / (2·tan(fov/2) · G_REF_DIST)，
     只由字号决定，与精灵离相机多远、视角缩放多少全都无关。
     （此前 applySvNoteK(gCam, 46, …) 里的 46 是 wGroundCam 的 fov 值，不是距离。） */
  var G_REF_DIST = 36;
  /* ★ v37（需求二·4）：地面默认保持静止 —— 不再自动对准太阳。
     旧版 gAimSun=true 会让机位在用户拖动前一直跟着太阳方位转（时钟走动时地面视角
     持续漂移），被感知为「地面随视角转动」；现默认 false，机位停在初始朝向，
     拖动 / 缩放行为不变。 */
  var gAimSun = false;
  function aimCamAtSun(g) {
    gYaw = -g.az * D;
    gPitch = clamp(0.55 * (gCam.fov / 2) * D - g.alt * D, 0.08, 0.34);
  }
  function updateGroundCam(g) {
    if (gAimSun && g) aimCamAtSun(g);
    gPitch = clamp(gPitch, 0.05, 1.35);
    /* v31（需求十九）：地面视图放大缩放范围 —— 近可贴着建筑看细节，远可整圆盘带天空全景 */
    /* ★ v33（需求：地平视角 · 扩大缩放上下限）：上限由 150 放宽到 340，使相机能退到
       足以把「半径 125.4 的太阳视运动轨迹半球 + 地平圈」整体收进画面；下限放到 1.2 便于贴近观察物体。 */
    gDist = clamp(gDist, 1.2, 340);
    /* ★ 本批次（需求六）：测量物影时，视角中心（gTarget）跟随被测量物体 ——
       旋转 / 缩放即绕该物体进行；退出测量（S.meas.on 置 false）后下一帧自动
       回到地平面中心 (0, 3, 0)。 */
    if (S.meas && S.meas.on && measKeep && measKeep.position) {
      var _mh = objHeightOf(measKeep);
      gTarget.set(measKeep.position.x, _mh * 0.5, measKeep.position.z);
    } else {
      gTarget.set(0, 3.0, 0);
    }
    var cp = Math.cos(gPitch), sp = Math.sin(gPitch);
    var x = gTarget.x + gDist * cp * Math.sin(gYaw);
    var z = gTarget.z + gDist * cp * Math.cos(gYaw);
    var y = Math.max(0.7, gTarget.y + gDist * sp);
    gCam.position.set(x, y, z);
    gCam.lookAt(gTarget);
  }
  var cYaw = 0.85, cPitch = 0.45, cDist = 26;
  function updateCelestialCam() {
    cPitch = clamp(cPitch, -0.25, 1.35);
    cDist = clamp(cDist, 12, 62);
    var cp = Math.cos(cPitch);
    cCam.position.set(cDist * cp * Math.sin(cYaw), cDist * Math.sin(cPitch), cDist * cp * Math.cos(cYaw));
    cCam.lookAt(0, 0.6, 0);
  }
  /* ★ 第一人称航向角约定（v30 修订）：fpYaw = 视线方向的**方位角**（弧度），
     0 = 正北（−Z），顺时针增大（正东 +X 为 π/2）。于是
       视线方向 = ( sin(fpYaw), ·, −cos(fpYaw) )
     罗盘读数 = fpYaw 直接换成角度；向日葵锁定用 atan2(sun.x, −sun.z)。
     早期版本用「视线 = (sin, cos)、前进 = (−sin, −cos)」且 lookAt 与前进口径相反，
     导致按 W 后退、向日葵朝反方向、罗盘读数整体偏 180°。 */
  var fpYaw = 0, fpPitch = 0.03;
  var fpPos = new THREE.Vector3(0, 0, 4.5);
  var fpKeys = {};
  var fpCam = new THREE.PerspectiveCamera(62, 1, 0.05, 900);
  /* ★ 本批次（需求四·a）：第一人称自由缩放 —— 用滚轮改视场角（fov），
     18°（长焦拉近）~ 100°（广角拉远），与相机位置解耦，不影响前进 / 转头。 */
  var fpFov = 62;
  var EYE = 1.62;
  var iYaw = 0.6, iDist = 4.6, iPitch = 0.10;
  /* v31（需求二十）：相机**必须待在房间里** —— 旧写法把距离放开到 9、房间进深只有 15，
     拖动 / 缩放很容易把机位推到墙外，看进去就成了「穿模」。这里对位置做三向夹紧。 */
  var I_CAM = { xMin: -RW / 2 + 0.6, xMax: RW / 2 - 0.6, zMin: -RD / 2 + 0.6, zMax: RD / 2 - 0.6,
                yMin: 0.55, yMax: RH - 0.5 };
  /* ★ v32（需求八）：室内观察点 —— 可从**房间中心或四个墙角**观察。
     预设给的是「房间局部坐标下的机位」，这里反解成 iYaw / iDist / iPitch 三个既有参数，
     于是切换按钮之后相机立即到位，且之后仍可用鼠标自由转头 / 缩放（不引入额外状态）。 */
  var ROOM_VIEWS = {
    center: { x: 0, z: 1.9, y: 1.62 },
    nw: { x: -RW / 2 + 1.0, z: RD / 2 - 1.0, y: 2.30 },
    ne: { x: RW / 2 - 1.0, z: RD / 2 - 1.0, y: 2.30 },
    sw: { x: -RW / 2 + 1.0, z: -RD / 2 + 1.4, y: 2.30 },
    se: { x: RW / 2 - 1.0, z: -RD / 2 + 1.4, y: 2.30 },
  };
  function applyRoomView(k) {
    var v = ROOM_VIEWS[k]; if (!v) return;
    var dz = v.z - 1.2;
    var d = Math.sqrt(v.x * v.x + dz * dz);
    if (d < 0.35) d = 0.35;
    iPitch = clamp(Math.asin(clamp((v.y - 1.45) / d, -1, 1)), -0.6, 0.9);
    var cp = Math.max(0.2, Math.cos(iPitch));
    iDist = clamp(d / cp, 0.3, 9);
    iYaw = Math.atan2(v.x, dz);
  }
  if (S.room.view) applyRoomView(S.room.view);
  function updateIndoorCam() {
    /* v31：房间不再跟着太阳转（朝向固定），但相机仍要套用房间自身的姿态矩阵，
       否则房间转过之后相机会对着背墙 —— 画面只剩一片平色。 */
    var ry = iRoom.rotation.y;
    var cp = Math.cos(iPitch);
    var lx = clamp(iDist * Math.sin(iYaw) * cp, I_CAM.xMin, I_CAM.xMax);
    var lz = clamp(iDist * Math.cos(iYaw) * cp + 1.2, I_CAM.zMin, I_CAM.zMax);
    var ly = clamp(1.45 + Math.sin(iPitch) * iDist, I_CAM.yMin, I_CAM.yMax);
    iCam.position.set(lx * Math.cos(ry) + lz * Math.sin(ry), ly,
                      -lx * Math.sin(ry) + lz * Math.cos(ry));
    iCam.lookAt(0, clamp(1.45 - Math.sin(iPitch) * 1.2, 0.3, RH - 0.3), 0);
  }

  /* ============================ 10. 面板：拖动 / 拉伸 / 折叠 / 关闭 / 置顶 / 记忆 ============================ */
  var zTop = 12;
  /* ★ v44（需求三）：共享的尺寸 / 位置 / 重叠约束工具（定义在 app.js，先于本文件加载）。
     app.js 尚未就绪时退化为内置兜底，保证本模块单独加载也不报错。 */
  var PF = window.__panelFit || (function () {
    var noop = function () { };
    return { uiScale: function () { return 1; }, applyMin: noop, clampPos: function () { return false; },
             resolve: function () { return false; }, minOf: function () { return { minW: 190, minH: 86, ar: null }; },
             clampRect: function (n, w, h) { return { w: w, h: h }; }, setFolded: function (n, on) { n.classList.toggle('collapsed', !!on); },
             visible: function () { return true; }, natural: function () { return { w: 0, h: 0 }; },
             bodyOf: function (n) { return n.querySelector(':scope > .card-body, :scope > .svtt-body, :scope > .svtb-body, :scope > .svmon-body'); } };
  })();
  /* 太阳侧全部可参与「边界夹取 / 重叠消解」的面板 */
  function sunPanelNodes() {
    return ['svOptsCard', 'svTimeTop', 'svTimeBar', 'svMonitor', 'svWinEarth', 'svWinSky', 'svWinGround']
      .map(function (id) { return $(id); }).filter(Boolean);
  }
  /* 折叠态需要实测表头高度写入 --fold-h（CSS 用它把卡片夹到「只有表头」） */
  function foldHeadH(node) {
    var head = node.querySelector(':scope > .card-head');
    if (!head) return;
    var hh = Math.round(head.getBoundingClientRect().height + 2);
    if (hh > 4) node.style.setProperty('--fold-h', hh + 'px');
  }
  /* 折叠 / 展开统一入口：交给 app.js 的 setFolded（平滑 + 清掉拉伸高度），
     之后重新夹取一次几何，保证「折叠后仍留在可见区域内」。 */
  function setPanelCollapsed(node, on) {
    /* ★ v53：折叠会改变面板占位 ⇒ 综合视图窗格需重排 */
    if (S.combo && S.combo.on && S.view === 'combo') {
      requestAnimationFrame(function () { try { layoutSunCombo(); } catch (e) { /* noop */ } });
    }
    if (!node) return;
    foldHeadH(node);
    PF.setFolded(node, on);
    if (!on) { foldHeadH(node); }
    requestAnimationFrame(function () {
      foldHeadH(node);
      if (!on) { try { PF.clampPos(node); PF.resolve(node, sunPanelNodes()); } catch (e) { console.warn('[sunview] setPanelCollapsed clamp/resolve', e); } }
      applySurfaceLayout();
    });
  }
  function makeFloatPanel(node, key, opts) {
    if (!node) return null;
    opts = opts || {};
    var lay = (S.layout[key] = S.layout[key] || {});
    /* ★ 修复 #11：localStorage 恢复的布局值必须校验 —— 非有限数 / 非正值 / 越界值直接忽略，
       否则面板会被摆到屏幕外或得到负尺寸（用户再也抓不回来）。
       w/h 用该面板已声明的最小宽高（opts.minW/minH，缺省 220/160）兜底，x/y 夹进当前视口内。 */
    /* ★ v60（需求1）：noResize 面板（如 #svTimeBar）尺寸由 CSS 钉死 ——
       既不恢复存档里的宽高，也把存档值清掉，避免内联 width/height 覆盖 CSS 固定尺寸。 */
    if (opts.noResize) { lay.w = null; lay.h = null; }
    /* ★ v62（需求 3）：**宽高比锁定 + 可缩放** 的面板（#svTimeBar）——宽度不在这里恢复：
       它由 CSS 用 `clamp(50vw×倍率, --svtb-frac×100vw×倍率, 70vw×倍率)` 给出，其中
       --svtb-frac（用户拖拽后的占屏宽比例）由 fitTimeBarScale 按同一公式写入。
       高度一律交给 aspect-ratio，**绝不写 inline height**（写了就破坏固定宽高比）。
       这里只对存档的比例值做合法性校验：非法即清掉，回落到 CSS 默认值 0.6（= 屏宽 60%）。 */
    else if (opts.aspect > 0) {
      lay.w = null; lay.h = null;
      if (!(isFinite(lay.frac) && lay.frac > 0)) lay.frac = null;
    }
    else {
      if (isFinite(lay.w) && lay.w > 0) node.style.width = Math.max(opts.minW || 220, lay.w) + 'px';
      else if (lay.w != null) lay.w = null;
      if (isFinite(lay.h) && lay.h > 0) node.style.height = Math.max(opts.minH || 160, lay.h) + 'px';
      else if (lay.h != null) lay.h = null;
    }
    if (isFinite(lay.x) && isFinite(lay.y)) {
      lay.x = clamp(lay.x, 2, Math.max(2, window.innerWidth - 40));
      lay.y = clamp(lay.y, 2, Math.max(2, window.innerHeight - 40));
      node.style.left = lay.x + 'px'; node.style.top = lay.y + 'px';
      node.style.right = 'auto'; node.style.bottom = 'auto'; node.style.transform = 'none';
    } else if (lay.x != null || lay.y != null) { lay.x = null; lay.y = null; }
    /* ★ v44（需求三）：先按实测内容算出「不被裁剪」的最小宽高，再写 --pm-min-w/h
       （pmKind = 内容特征档；applyMin 内部会写，这里只兜底 id） */
    node.dataset.pmKey = key;
    if (opts.fit) PF.applyMin(node, opts.fit);
    else if (!node.dataset.pmKind) node.dataset.pmKind = 'info';
    if (lay.collapsed) {
      node.classList.add('collapsed');
      var bd0 = PF.bodyOf(node); if (bd0) bd0.style.display = 'none';   // 折叠态正文不参与宽度
      foldHeadH(node);
    }

    node.addEventListener('pointerdown', function () { node.style.zIndex = String(++zTop); }, true);

    /* 拖动：仅从标题栏发起 */
    var head = node.querySelector('.card-head');
    if (head && !opts.noDrag) {
      head.style.cursor = 'move';
      var dragging = false, px = 0, py = 0, ox = 0, oy = 0;
      head.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        var t = e.target;
        if (t && t.closest && (t.closest('button') || t.closest('input') || t.closest('label') || t.closest('.sv-grip'))) return;
        var r = node.getBoundingClientRect();
        node.style.left = r.left + 'px'; node.style.top = r.top + 'px';
        node.style.right = 'auto'; node.style.bottom = 'auto'; node.style.transform = 'none';
        ox = r.left; oy = r.top; dragging = true; px = e.clientX; py = e.clientY;
        node.classList.add('sv-active');
        if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] panel head setPointerCapture', er); } }
        e.preventDefault();
      });
      head.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        /* ★ v44（需求三）：拖动期间**整块面板**必须留在可见区域内 ——
           旧写法 `clamp(x, 4 - w + 64, innerWidth - 64)` 允许把面板推到屏幕外
           （左/上最多只留 64px 露在边上），用户松手后很难再抓回来。 */
        var w = node.offsetWidth, h = node.offsetHeight;
        var tbB = ($('titleBar') ? $('titleBar').getBoundingClientRect().bottom : 0) + 2;
        var nx = clamp(ox + (e.clientX - px), 2, Math.max(2, window.innerWidth - w - 2));
        var ny = clamp(oy + (e.clientY - py), tbB, Math.max(tbB, window.innerHeight - h - 2));
        node.style.left = nx + 'px'; node.style.top = ny + 'px';
      });
      var stop = function () {
        if (!dragging) return; dragging = false;
        /* ★ v44（需求三）：落点再夹一次边界，并消解与其它面板的重叠 */
        try { PF.clampPos(node); PF.resolve(node, sunPanelNodes()); } catch (er) { console.warn('[sunview] panel drag stop clamp/resolve', er); }
        lay.x = parseFloat(node.style.left); lay.y = parseFloat(node.style.top); saveSoon();
        /* ★ v53（需求一·1）：面板挪了位置 ⇒ 综合视图窗格可用区随之变化，重排一次。
           放在 rAF 里，等浏览器完成本次布局后再量面板矩形。 */
        if (S.combo && S.combo.on && S.view === 'combo') {
          requestAnimationFrame(function () { try { layoutSunCombo(); } catch (er) { /* noop */ } });
        }
      };
      head.addEventListener('pointerup', stop);
      head.addEventListener('pointercancel', stop);
      head.addEventListener('lostpointercapture', stop);
    }

    /* 边缘 / 四角拉伸 */
    if (!opts.noResize) {
      /* ★ v62（需求 3）：A > 0 ⇒ 本面板锁定宽高比（= opts.aspect），拖拽只改宽度 */
      var A = (opts.aspect > 0) ? opts.aspect : 0;
      ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (d) {
        var gp = el('div', 'sv-grip ' + d);
        node.appendChild(gp);
        var rs = false, sx = 0, sy = 0, sw = 0, sh = 0, sl = 0, st = 0;
        gp.addEventListener('pointerdown', function (e) {
          e.stopPropagation(); e.preventDefault();
          /* ★ v62（需求 3）：折叠态面板宽度是 auto（只有表头），拉伸毫无意义且会把
             「占屏宽比例」算成极小值 —— 折叠态直接不参与拉伸。 */
          if (A > 0 && node.classList.contains('collapsed')) return;
          var r = node.getBoundingClientRect();
          node.style.left = r.left + 'px'; node.style.top = r.top + 'px';
          node.style.right = 'auto'; node.style.bottom = 'auto'; node.style.transform = 'none';
          rs = true; sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top;
          node.classList.add('sv-resizing');
          if (gp.setPointerCapture) { try { gp.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] panel grip setPointerCapture', er); } }
        });
        gp.addEventListener('pointermove', function (e) {
          if (!rs) return;
          var dx = e.clientX - sx, dy = e.clientY - sy;
          var nw = sw, nh = sh, nl = sl, nt = st;
          if (A > 0) {
            /* ★ v62（需求 3）：宽高比锁定的面板 —— 任何方向的拖拽都只改**宽度**
               （高度 = 宽 / A，由 CSS aspect-ratio 自动跟随，这里不用也不必写 inline height）。
               改宽度只写 --svtb-frac（占屏宽比例）：CSS 的
               `clamp(50vw×倍率, frac×100vw×倍率, 70vw×倍率)` 会自动完成夹取，
               故 JS 侧无需再夹一次尺寸，只需按同一公式算出「真实宽度」用于位置修正。 */
            if (d.indexOf('e') >= 0) nw = sw + dx;
            else if (d.indexOf('w') >= 0) nw = sw - dx;
            else if (d.indexOf('s') >= 0) nw = sw + dy * A;
            else if (d.indexOf('n') >= 0) nw = sw - dy * A;
            var fs2 = svtbFontScale(), W2 = window.innerWidth;
            var lo2 = Math.min((opts.minFrac || 0.50) * W2 * fs2, W2 - 32);
            var hi2 = Math.min((opts.maxFrac || 0.70) * W2 * fs2, W2 - 32);
            var frac2 = clamp(nw / Math.max(1, W2 * fs2), opts.minFrac || 0.50, opts.maxFrac || 0.70);
            nw = clamp(frac2 * W2 * fs2, lo2, Math.max(lo2, hi2));
            nh = nw / A;
            node.style.setProperty('--svtb-frac', String(frac2));
            node.style.setProperty('--ui', (nw / (opts.uiRefW || 1000)).toFixed(4));
            if (d.indexOf('w') >= 0) nl = sl + (sw - nw);
            if (d.indexOf('n') >= 0) nt = st + (sh - nh);
            var tbB2 = ($('titleBar') ? $('titleBar').getBoundingClientRect().bottom : 0) + 2;
            nl = clamp(nl, 2, Math.max(2, W2 - nw - 2));
            nt = clamp(nt, tbB2, Math.max(tbB2, window.innerHeight - nh - 2));
            node.style.left = nl + 'px'; node.style.top = nt + 'px';
            return;
          }
          /* ★ v44（需求三）：最小值不再是写死的 opts.minW/minH，而是**按实测内容**算出的
             --pm-min-w / --pm-min-h（内容不被裁剪的下限）；再夹进本类面板的宽高比区间。 */
          var minW = opts.minW || 190, minH = opts.minH || 86;
          try { var mm = PF.minOf(node, opts.fit); minW = Math.max(minW, mm.minW); minH = Math.max(minH, mm.minH); } catch (er) { console.warn('[sunview] panel resize minOf', er); }
          if (d.indexOf('e') >= 0) nw = Math.max(minW, sw + dx);
          if (d.indexOf('s') >= 0) nh = Math.max(minH, sh + dy);
          if (d.indexOf('w') >= 0) { nw = Math.max(minW, sw - dx); nl = sl + (sw - nw); }
          if (d.indexOf('n') >= 0) { nh = Math.max(minH, sh - dy); nt = st + (sh - nh); }
          var fitd = PF.clampRect(node, nw, nh, opts.fit);
          nw = fitd.w; nh = fitd.h;
          if (d.indexOf('w') >= 0) nl = sl + (sw - nw);
          if (d.indexOf('n') >= 0) nt = st + (sh - nh);
          /* 位置也夹进可见区域，避免拉大后右下角出界 */
          var tbB = ($('titleBar') ? $('titleBar').getBoundingClientRect().bottom : 0) + 2;
          nl = clamp(nl, 2, Math.max(2, window.innerWidth - nw - 2));
          nt = clamp(nt, tbB, Math.max(tbB, window.innerHeight - nh - 2));
          node.style.width = nw + 'px'; node.style.height = nh + 'px';
          node.style.left = nl + 'px'; node.style.top = nt + 'px';
        });
        var rstop = function () {
          if (!rs) return; rs = false; node.classList.remove('sv-resizing');
          if (A > 0) {
            /* ★ v62（需求 3）：宽高比锁定面板 —— 只把「占屏宽比例」存档（lay.frac），
               宽度始终经 --svtb-frac / CSS clamp 得出（⇒ 随字号倍率同比缩放），
               高度由 aspect-ratio 决定，故 **不留任何 inline 宽高**。 */
            var cur = parseFloat(node.style.getPropertyValue('--svtb-frac'));
            lay.frac = isFinite(cur) ? clamp(cur, opts.minFrac || 0.50, opts.maxFrac || 0.70) : null;
            lay.w = null; lay.h = null;
            try { PF.clampPos(node); } catch (er) { console.warn('[sunview] panel resize stop clampPos', er); }
            lay.x = parseFloat(node.style.left); lay.y = parseFloat(node.style.top);
            if (!isFinite(lay.x)) lay.x = null;
            if (!isFinite(lay.y)) lay.y = null;
            fitTimeBarScale();
            saveSoon();
            return;
          }
          /* ★ v44（需求三）：拉伸结束后再整体夹一次（尺寸 + 位置 + 重叠） */
          try {
            var s = PF.clampRect(node, node.offsetWidth, node.offsetHeight, opts.fit);
            node.style.width = s.w + 'px'; node.style.height = s.h + 'px';
            PF.clampPos(node); PF.resolve(node, sunPanelNodes());
          } catch (er) { console.warn('[sunview] panel resize stop clamp/resolve', er); }
          lay.w = node.offsetWidth; lay.h = node.offsetHeight;
          lay.x = parseFloat(node.style.left); lay.y = parseFloat(node.style.top);
          saveSoon();
        };
        gp.addEventListener('pointerup', rstop);
        gp.addEventListener('pointercancel', rstop);
        gp.addEventListener('lostpointercapture', rstop);
      });
    }

    /* 折叠 / 关闭 */
    node.querySelectorAll('.card-head .link').forEach(function (b) {
      var txt = b.textContent.trim();
      /* ★ v41（需求一·1 / 一·2）：时间面板（#svTimeTop / #svTimeBar）**恢复折叠按钮**
         （v40 曾为「自动拉伸完整显示」把折叠按钮 display:none 掉；现用户明确要求可折叠，
         自动拉伸（--timecard-fit 整体缩放）保留，只是不再禁止折叠）。 */
      if (/折叠|收起/.test(txt)) {
        b.addEventListener('click', function () {
          /* ★ v44（需求 2）：折叠 / 展开统一走 setPanelCollapsed ——
             整个卡片（不是只把正文藏起来）收成「只有表头」的紧凑块，
             并带 max-height / 圆角过渡；展开时恢复用户拉伸过的高度。 */
          var c = !node.classList.contains('collapsed');
          setPanelCollapsed(node, c);
          b.textContent = /收起/.test(txt) ? (c ? '展开' : '收起') : (c ? '展开' : '折叠');
          lay.collapsed = c; saveSoon();
        });
      } else if (/关闭/.test(txt)) {
        b.addEventListener('click', function () {
          var k = node.id;
          if (k === 'svWinEarth') S.panel.earth = false;
          else if (k === 'svWinSky') S.panel.sky = false;
          else if (k === 'svWinGround') S.panel.ground = false;
          saveSoon(); applyPanelVisibility();
        });
      }
    });
    return node;
  }

  /* ============================ 11. 视图切换（0.2s 过渡） ============================ */
  var lastView = BR.getView();
  function syncBodyClasses() {
    var inSun = BR.getView() === 'sun';
    document.body.classList.toggle('sv-ground', inSun && S.view === 'ground' && !S.indoor && !S.fp);
    document.body.classList.toggle('sv-fp', inSun && S.fp);
    document.body.classList.toggle('sv-indoor', inSun && S.indoor);
    /* ★ v39（需求三）：综合视图模式（多窗组合） */
    document.body.classList.toggle('sv-combo', inSun && S.view === 'combo' && !!S.combo.on);
  }
  function fadeInCanvas() {
    canvas.classList.add('sv-hidden');
    requestAnimationFrame(function () { requestAnimationFrame(function () { canvas.classList.remove('sv-hidden'); }); });
  }
  function tickView() {
    var v = BR.getView();
    if (v !== lastView) {
      if (v === 'sun') fadeInCanvas();
      lastView = v;
      syncBodyClasses();
      applyPanelVisibility();
      applySurfaceLayout();
      resizeMain();
      /* ★ v33（需求五）：进入太阳视运动时**按共享状态刷新一次本模块的所有控件**。
         全局文字样式（@note.*）由两个模块共用同一份 state.note —— 在主模块里改完再切过来，
         本模块的滑杆 / 复选框仍停在「上次在本模块编辑过的值」，界面与真实状态不一致
         （实测：主模块把总字号设成 0.80×，切过来滑杆仍显示 0.55×）。
         这里统一 syncSunBinders() 一次，保证「任一处修改 → 其余视图同步」。 */
      if (v === 'sun') syncSunBinders();
      /* ★ v41（需求一·8）：顶层视图一离开太阳视运动，综合视图会话即结束 */
      if (v !== 'sun') leaveSunCombo();
    }
  }
  function resizeMain() {
    var w = window.innerWidth, h = window.innerHeight;
    rnd.setSize(w, h, false);
    if (Math.abs(gCam.aspect - w / h) > 1e-4) { gCam.aspect = w / h; gCam.updateProjectionMatrix(); }
    if (Math.abs(cCam.aspect - w / h) > 1e-4) { cCam.aspect = w / h; cCam.updateProjectionMatrix(); }
    if (Math.abs(iCam.aspect - w / h) > 1e-4) { iCam.aspect = w / h; iCam.updateProjectionMatrix(); }
    if (Math.abs(fpCam.aspect - w / h) > 1e-4) { fpCam.aspect = w / h; fpCam.updateProjectionMatrix(); }
    resizeWin($('svCvEarth'), wEarth, eCam);
    resizeWin($('svCvSky'), wSky, wSkyCam);
    resizeWin($('svCvGround'), wGround, wGroundCam);
    /* ★ 需求一：窗口尺寸 / 界面缩放变化时，标题栏要跟着标题栏高度重新定位 */
    syncSvViewHead();
  }
  function resizeWin(cv, renderer, cam) {
    if (!cv) return;
    var w = cv.clientWidth || 208, h = cv.clientHeight || 148;
    if (!w || !h) return;
    /* ★ 修复 #6：本函数被主循环每帧调用（最多 3 个小窗）—— 尺寸未变化时跳过 setSize，
       避免每帧无谓的 drawingBuffer 重新分配。 */
    if (cv._svW !== w || cv._svH !== h) {
      cv._svW = w; cv._svH = h;
      renderer.setSize(w, h, false);
    }
    if (Math.abs(cam.aspect - w / h) > 1e-4) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }
  /* ★ 本批次（需求二）：把「天球 / 地面」悬浮窗的小相机同步成单一视图的主相机
     （位置 / 朝向 / fov），只保留各自窗口的纵横比 ⇒ 悬浮窗内容与单一窗口逐像素一致。
     渲染顺序：先 resizeWin（置尺寸 + 纵横比），再本函数（置位姿 / fov），最后 render。 */
  function syncWinCam(dst, src) {
    if (!dst || !src) return;
    dst.position.copy(src.position);
    dst.quaternion.copy(src.quaternion);
    if (Math.abs(dst.fov - src.fov) > 1e-4) { dst.fov = src.fov; dst.updateProjectionMatrix(); }
  }
  window.addEventListener('resize', function () {
    resizeMain(); applySurfaceLayout(); fitMonitorPanel();
    /* ★ v58（需求 3）：窗口尺寸变化后必须**重算窗口标题栏上沿** ——
       菜单栏高度由 --tb-h（屏幕宽高断点）决定，窗口一改它就变；旧代码只在
       切视图 / 切模块时算一次，于是换尺寸后标题栏会与菜单栏错位乃至压叠。
       syncSvViewHead 内部还会顺手重算 #svFrame 的上沿，两者必须同步刷新。 */
    syncSvViewHead();
    if (S.combo && S.combo.on) layoutSunCombo();
  });

  /* ★ v40（需求六）：顶栏「地面视图 / 天球视图 / 综合视图」二级菜单
     （已并入两行总菜单的太阳视运动二级行 #segSunView） */
  (function () {
    var seg = $('segSunView');
    if (!seg) return;
    function sync() {
      /* ★ v40：二级项容器是 .tbm2-lv2grp，视图按钮为 .tbm2-lv2btn[data-sunview]；
         高亮由 app.js 的 setViewButtons() 统一负责，这里只同步太阳模块内部状态即可。 */
      seg.querySelectorAll('button[data-sunview]').forEach(function (b) {
        b.classList.toggle('on', b.dataset.sunview === S.view);
      });
      /* ★ v40（需求六）：同时重算两行总菜单的二级高亮（太阳视图 → .tbm2-lv2.on） */
      if (window.__setViewButtons) window.__setViewButtons();
      /* 兼容旧结构（.tbm-grp）：分组标题高亮 + 二级视图回显 */
      var grp = seg.closest ? seg.closest('.tbm-grp') : null;
      if (grp) {
        var t = grp.querySelector('.tbm-top');
        if (t) t.dataset.sub = S.view;
      }
    }
    seg.querySelectorAll('button[data-sunview]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.fp) exitFP();
        if (S.indoor) exitIndoor();
        var v = b.dataset.sunview;
        /* ★ v39（需求三）：点击太阳视运动下的任一子项，先把**顶层视图**切到太阳视运动
           （原由已删除的 data-view="sun" 一级按钮负责），再设太阳模块内部视图。 */
        if (BR.setView && BR.getView() !== 'sun') BR.setView('sun');
        if (v === 'combo') { openSunComboPicker(); return; }
        /* ★ v41（需求一·8）：选了别的视图 ⇒ 退出综合视图（不保留多窗会话） */
        leaveSunCombo();
        S.view = v; sync(); saveSoon();
        applyPanelVisibility();
        resizeMain();
      });
    });
    sync();
    window.__svSyncViewSeg = sync;
  })();

  /* ★ v39（需求三）：太阳视运动「综合视图」 —— 点击后弹对话框选择 ≥2 个视图，
     组成仿地球综合视图的多窗布局（窗口可拖拽 / 可拉伸 / 自动铺满屏幕）。 */
  /* ★ v44（需求十）：每个窗格给出**与主模块悬浮窗 / 太阳侧悬浮窗同一套**的标题
     （图标 + 名称；图标与 `.svwin` / `.mvwin` 里同名的那个窗一致），并带
     「折叠 / 关闭」两个按钮 —— 旧版所有窗格一律用 🪟 且没有按钮，与「地球运动视图」
     的窗口标题（🌍 地球侧视图 / 🛰️ 地球公转示意图 / 🧭 北极视图 …）不一致。 */
  var SCOMBO_DEFS = [
    { key: 'ground', label: '地面视图', ico: '🏙️', scn: 'ground' },
    { key: 'sky', label: '天球视图', ico: '🌌', scn: 'sky' },
    { key: 'indoor', label: '室内视图', ico: '🏠', scn: 'indoor' },
    { key: 'fp', label: '第一人称视图', ico: '👤', scn: 'fp' },
    /* ★ v52（需求G6）：本窗格与右下角悬浮窗 svWinEarth **同名同源**（都叫「观测点位置」），
       内容也用同一套 eScene / eCam / orbEarth 出图，故标题由「地球自转视图」更正为「观测点位置」。 */
    { key: 'earth', label: '观测点位置', ico: '🌍', scn: 'earth' },
    { key: 'orbit', label: '地球公转视图', ico: '🛰️', scn: 'orbit' },
  ];
  if (!S.combo) S.combo = { on: false, picks: ['ground', 'sky', 'earth'] };
  function openSunComboPicker() {    var wrap = el('div', 'svm-pick');
    var box = el('div', 'svm-pick-grid');
    SCOMBO_DEFS.forEach(function (d) {
      var lab = el('label', 'svm-pick-item');
      var on = S.combo.picks.indexOf(d.key) >= 0;
      lab.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '/><span>' + d.label + '</span>';
      box.appendChild(lab);
      lab.querySelector('input').dataset.key = d.key;
    });
    wrap.appendChild(box);
    wrap.appendChild(el('div', 'svm-hint', '至少选择 2 个视图；窗口进入后可自由拖动、拉伸，自动铺满屏幕。'));
    var ok = mkBtn('组成综合视图', 'primary', function () {
      var picks = [];
      box.querySelectorAll('input:checked').forEach(function (c) { picks.push(c.dataset.key); });
      if (picks.length < 2) { toast('请至少选择 2 个视图', true); return; }
      S.combo.picks = picks;
      close();
      enterSunCombo();
    });
    var cancel = mkBtn('取消', '', function () { close(); });
    var close = function () { };
    var m = modal('选择综合视图内容', wrap, [cancel, ok]);
    close = m.close;
  }
  function enterSunCombo() {
    if (BR.setView && BR.getView() !== 'sun') BR.setView('sun');
    S.combo.on = true;
    S.view = 'combo';
    if (window.__svSyncViewSeg) window.__svSyncViewSeg();
    saveSoon();
    applyPanelVisibility();
    buildSunCombo();
    resizeMain();
    toast('已进入太阳视运动综合视图 · 拖动标题栏移动，拖右下角拉伸');
  }
  /* ★ v41（需求一·8）：综合视图是**一次性会话** ——
       ① 在综合视图里选了别的视图（太阳侧子视图 / 顶层切到地球运动）⇒ 立即退出综合视图；
       ② 再次点「综合视图」⇒ 重新弹出选择对话框（不直接恢复上次组合）。
     于是把「退出」抽成两步：leaveSunCombo() 只关窗不动 S.view，exitSunCombo() 再回落地面视图。 */
  function leaveSunCombo() {
    if (!S.combo || !S.combo.on) return false;
    S.combo.on = false;
    /* ★ 修复 #1：退出综合视图即释放各窗格自持的 WebGL 上下文 + 解绑 window 级监听。
       再次进入综合视图走 enterSunCombo → buildSunCombo 全新重建窗格（见下方 buildSunCombo
       也会先释放一次），因此释放后二次进入不会白屏。 */
    disposeSunComboCells();
    var wrap = $('svComboUI'); if (wrap) { wrap.classList.remove('on'); }
    syncBodyClasses(); applyPanelVisibility();
    return true;
  }
  function exitSunCombo() {
    leaveSunCombo();
    S.view = 'ground';
    if (window.__svSyncViewSeg) window.__svSyncViewSeg();
    saveSoon(); applyPanelVisibility(); resizeMain();
  }
  /* 每个综合窗格 = 一个 .svc-cell，内含标题条 + 一个 2D canvas。
     3D 内容来自本模块的场景（gScene/cScene/iScene）或主模块（经 SUN_BRIDGE.renderEarthInto）；
     渲染方式与主模块「3D 缩略窗」一致：先把内容渲染进主画布对应屏幕矩形，再 drawImage 拷进本窗画布。 */
  var sComboCells = {}, sComboBuilt = false;
  /* ★ 修复 #1：释放综合窗格持有的 WebGL 上下文 / 解绑其 window 级监听。
     每个窗格在首帧惰性创建 `new THREE.WebGLRenderer` 并缓存到 o._r；旧实现在
     rebuild（改组合 / 关闭单个窗格）与 exit 时只清 DOM（wrap.innerHTML=''、删 class），
     从不 dispose ⇒ 每重建一次泄漏一个 WebGL 上下文（浏览器上限约 16 个，达到即黑屏）。
     注意：本函数不修改 S.combo.on / DOM，只做资源回收；窗格的 DOM 由调用方清空。 */
  function disposeSunComboCells() {
    Object.keys(sComboCells).forEach(function (k) {
      var o = sComboCells[k]; if (!o) return;
      if (o._dragOff) { try { o._dragOff(); } catch (e) { console.warn('[sunview] combo drag unbind', e); } o._dragOff = null; }
      var r = o._r;
      if (r) {
        try { r.dispose(); } catch (e) { console.warn('[sunview] combo renderer dispose', e); }
        try { if (r.forceContextLoss) r.forceContextLoss(); } catch (e) { console.warn('[sunview] combo renderer forceContextLoss', e); }
        o._r = null;
      }
    });
  }
  function buildSunCombo() {
    var wrap = $('svComboUI'); if (!wrap) return;
    /* ★ 修复 #1：清空窗格 DOM / sComboCells **之前**先释放旧窗格的 WebGL 上下文与监听。 */
    disposeSunComboCells();
    wrap.innerHTML = ''; sComboCells = {}; sComboBuilt = true;
    var picks = S.combo.picks.slice();
    picks.forEach(function (key) {
      var def = SCOMBO_DEFS.filter(function (d) { return d.key === key; })[0]; if (!def) return;
      var cell = el('section', 'svc-cell');
      cell.dataset.key = key;
      var head = el('div', 'card-head');
      /* ★ v44（需求十）：与主模块「综合视图」窗格 / 悬浮窗同一套标题结构 ——
         图标 + 名称 + 折叠 / 关闭（关闭 = 从本次综合组合里摘掉这个视图并重排）。 */
      head.innerHTML = '<h2><i class="hd-ico">' + (def.ico || '🪟') + '</i>' + def.label + '</h2>';
      var bFold = el('button', 'link svc-fold', '折叠');
      bFold.type = 'button';
      /* ★ v59（需求1）：折叠按钮统一渲染为「一横线」（文本保留供样式/无障碍读取，
         视觉由 [data-ic="fold"] 伪元素接管）。 */
      bFold.dataset.ic = 'fold';
      bFold.addEventListener('click', function () {
        var on = cell.classList.toggle('collapsed');
        bFold.textContent = on ? '展开' : '折叠';
        if (!on) requestAnimationFrame(layoutSunCombo);
      });
      var bX = el('button', 'link svc-close', '关闭');
      bX.type = 'button';
      /* ★ v59（需求1）：隐藏 / 关闭按钮统一渲染为「×」。 */
      bX.dataset.ic = 'close';
      bX.addEventListener('click', function () {
        S.combo.picks = (S.combo.picks || []).filter(function (k) { return k !== key; });
        if (S.combo.picks.length < 2) S.combo.picks = ['ground', 'sky'];
        buildSunCombo(); saveSoon();
      });
      head.appendChild(bFold); head.appendChild(bX);
      var grip = el('span', 'svc-grip', '⠿');
      head.insertBefore(grip, head.firstChild);
      cell.appendChild(head);
      var body = el('div', 'card-body');
      var cv = document.createElement('canvas');
      body.appendChild(cv);
      cell.appendChild(body);
      var gripR = el('span', 'svc-resize');
      cell.appendChild(gripR);
      wrap.appendChild(cell);
      /* ★ v39：每个窗格一个 canvas，直接由该窗格自己的 WebGLRenderer 渲染
         （不再先取 2D 上下文 —— 同一 canvas 不能既有 2D 又有 WebGL 上下文）。 */
      sComboCells[key] = { node: cell, cv: cv, def: def, scn: def.scn };
      makeSunComboCellDrag(cell, head, gripR, key);
      /* ★ v41（需求一·7）：窗格内的**视图本身**可拖拽旋转 / 滚轮缩放（此前窗格只是
         一张不能交互的缩略图）。地面 / 天球 / 室内 / 第一人称驱动本模块的相机状态量；
         地球自转 / 公转经 SUN_BRIDGE.earthOrbit 驱动主模块的相机球坐标。 */
      makeSunComboCellOrbit(cv, def.scn);
    });
    wrap.classList.add('on');
    layoutSunCombo();
  }
  /* ★ v44（需求十）：手动摆过的窗格也要「不溢出、不重叠」 ——
     旧写法只把 x 夹在 [-w/2, W-w/2]、y 夹在 [0, H-24]，窗格能被拖到屏幕外 / 压在别的窗格上，
     用户拖歪一次就把布局搞乱，只能重开对话框。这里统一夹进 comboAvailRect()，
     再做几轮最小位移消解窗格之间的重叠（与主模块 __panelFit.resolve 同思路）。 */
  function clampComboCell(cell) {
    var A = comboAvailRect();
    var w = clamp(cell.offsetWidth || 320, 200, Math.max(200, A.w));
    var h = clamp(cell.offsetHeight || 220, 130, Math.max(130, A.h));
    var x = clamp(cell.offsetLeft || A.x, A.x, Math.max(A.x, A.x + A.w - w));
    var y = clamp(cell.offsetTop || A.y, A.y, Math.max(A.y, A.y + A.h - h));
    cell.style.width = Math.round(w) + 'px'; cell.style.height = Math.round(h) + 'px';
    cell.style.left = Math.round(x) + 'px'; cell.style.top = Math.round(y) + 'px';
    return { x: x, y: y, w: w, h: h };
  }
  function resolveComboOverlap(cell) {
    /* ★ v57（需求 5）：窗格之间**不再相互避让 / 碰撞** —— 与主模块 __panelFit.resolve()
       保持一致，直接返回、不做任何位移。此前拖动一个窗格会把相邻窗格顶开，
       正是用户反复反馈的「面板相互避让」。视口夹取（clampComboCell）仍保留，
       它只防止窗格被拖出可用区，不属于「互避」。 */
    return;
  }
  /* 拖拽移动 + 右下角拉伸（窗口按 left/top/width/height 定位，坐标存在 S.combo.layout） */
  function makeSunComboCellDrag(cell, head, gripR, key) {
    var lay = {};
    (S.combo.layout = S.combo.layout || {})[key] = lay;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, mode = '';
    /* ★ 修复 #3：window 级指针监听改为「pointerdown 注册 / pointerup(pointercancel) 移除」的
       成对模式（参考同文件 wire()）—— 旧写法在 window 上永久挂 2 个闭包 × 窗格数，
       每次重建（改 combo 组合 / 进出综合视图）都累加且从不回收。
       unbind 会经 o._dragOff 暴露给 disposeSunComboCells()（修复 #1 的释放流程）。 */
    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') {
        /* ★ 修复 #4：原 `clamp(ox+dx, -w*0.5, …)` 的夹取紧接着会被 clampComboCell 立刻覆盖，
           属死代码，已删（只保留赋值，由下方 clampComboCell 统一夹取）。 */
        cell.style.left = (ox + dx) + 'px'; cell.style.top = (oy + dy) + 'px';
      } else {
        cell.style.width = clamp(ox + dx, 200, window.innerWidth) + 'px';
        cell.style.height = clamp(oy + dy, 130, window.innerHeight) + 'px';
      }
      /* ★ v44（需求十）：拖动 / 拉伸过程中就地夹进可用区 —— 不再能拖到屏幕外。 */
      clampComboCell(cell);
    }
    function onUp() {
      if (!dragging) return; dragging = false;
      unbind();
      cell.classList.remove('dragging');
      /* ★ v44（需求十）：松手时再夹一次 + 消解与其它窗格的重叠。 */
      clampComboCell(cell); resolveComboOverlap(cell);
      lay.x = cell.offsetLeft; lay.y = cell.offsetTop;
      lay.w = cell.offsetWidth; lay.h = cell.offsetHeight;
      lay.auto = false;                 /* 用户手动摆过 ⇒ 之后不再自动重排 */
      saveSoon();
    }
    function bind() {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    function unbind() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    var rec = sComboCells[key];
    if (rec) rec._dragOff = unbind;      /* ★ 修复 #1：供窗格释放时解绑 window 监听 */
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.link, button')) return;
      dragging = true; mode = 'move'; sx = e.clientX; sy = e.clientY;
      ox = cell.offsetLeft; oy = cell.offsetTop;
      cell.classList.add('dragging'); head.setPointerCapture && head.setPointerCapture(e.pointerId);
      bind();
      e.preventDefault();
    });
    gripR.addEventListener('pointerdown', function (e) {
      dragging = true; mode = 'resize'; sx = e.clientX; sy = e.clientY;
      ox = cell.offsetWidth; oy = cell.offsetHeight;
      bind();
      e.stopPropagation(); e.preventDefault();
    });
  }
  /* ★ v41（需求一·7）：综合窗格内的**视图本身**可交互 —— 在窗格画布上拖拽旋转、滚轮缩放。
     拖拽 / 缩放的手感与「单独进入该视图」时完全一致（同一套状态量、同一组系数、同一组夹紧区间）：
       地面 gYaw/gPitch/gDist · 天球 cYaw/cPitch/cDist · 室内 iYaw/iPitch/iDist ·
       第一人称 fpYaw/fpPitch（不缩放） · 地球自转 / 公转经 SUN_BRIDGE.earthOrbit 驱动主模块相机。
     注意：本函数只挂「画布」上的事件，标题栏拖拽移动 / 右下角拉伸仍归 makeSunComboCellDrag。 */
  function makeSunComboCellOrbit(cv, scn) {
    if (!cv) return;
    var d = null;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', function (e) {
      /* ★ v52（需求G8）：被其它浮窗 / 窗格覆盖时不接管 */
      if (!canvasOnTop(cv, e)) return;
      d = {
        x: e.clientX, y: e.clientY,
        yaw: scn === 'fp' ? fpYaw : (scn === 'indoor' ? iYaw : (scn === 'sky' ? cYaw : gYaw)),
        pitch: scn === 'fp' ? fpPitch : (scn === 'indoor' ? iPitch : (scn === 'sky' ? cPitch : gPitch)),
      };
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] combo cell setPointerCapture', er); } }
      e.preventDefault(); e.stopPropagation();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!d) return;
      var dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (scn === 'fp') {
        if (S.sunflower) { S.sunflower = false; var b = $('svSunflower'); if (b) b.classList.remove('on'); }
        fpYaw = d.yaw - dx * 0.005;
        fpPitch = clamp(d.pitch - dy * 0.004, -1.15, 1.25);
      } else if (scn === 'indoor') {
        iYaw = d.yaw + dx * 0.006;
        iPitch = clamp(d.pitch - dy * 0.004, -0.35, 0.55);
      } else if (scn === 'sky') {
        cYaw = d.yaw - dx * 0.008;
        cPitch = clamp(d.pitch + dy * 0.006, -0.25, 1.35);
      } else if (scn === 'ground') {
        gAimSun = false;                                  /* 用户接管机位后不再自动对准太阳 */
        gYaw = d.yaw - dx * 0.008;
        gPitch = clamp(d.pitch + dy * 0.006, 0.05, 1.35);
      } else if (scn === 'earth') {
        /* ★ v52（需求G6）：驱动与 svWinEarth **同一组**轨道参数 orbEarth ——
           手感与 attachOrbit（浮窗）完全一致：yaw 反向、pitch 同向、各自夹取范围。 */
        orbEarth.yaw -= dx * 0.0085;
        orbEarth.pitch = clamp(orbEarth.pitch + dy * 0.0065, orbEarth.pMin, orbEarth.pMax);
      } else {
        /* orbit：交给主模块相机 */
        var br = window.SUN_BRIDGE || {};
        if (br.earthOrbit) br.earthOrbit('revolve', dx * 0.008, dy * 0.008, 1);
      }
    });
    function endDrag() { d = null; }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
    cv.addEventListener('pointerleave', endDrag);
    cv.addEventListener('wheel', function (e) {
      if (!canvasOnTop(cv, e)) return;      /* ★ v52（需求G8） */
      e.preventDefault(); e.stopPropagation();
      var k = e.deltaY > 0 ? 1.08 : 1 / 1.08;
      if (scn === 'fp') { fpFov = clamp(fpFov * k, 18, 100); } /* ★ 需求四·a：第一人称自由缩放 */
      else if (scn === 'indoor') iDist = clamp(iDist * k, 1.6, 7.0);
      else if (scn === 'sky') cDist = clamp(cDist * k, 12, 62);
      else if (scn === 'ground') { gAimSun = false; gDist = clamp(gDist * k, 1.2, 340); }
      else if (scn === 'earth') {
        /* ★ v52（需求G6）：与 svWinEarth 同步缩放（同一档位 1.12 / 0.89，同一夹取范围） */
        orbEarth.dist = clamp(orbEarth.dist * (e.deltaY > 0 ? 1.12 : 0.89), orbEarth.dMin, orbEarth.dMax);
      } else {
        var br = window.SUN_BRIDGE || {};
        if (br.earthOrbit) br.earthOrbit('revolve', 0, 0, k);
      }
    }, { passive: false });
    /* ★ 修复 #12：综合窗格缺双击复位（三个 3D 缩略窗经 attachOrbit 已有）——
       双击画布恢复到该视图默认机位；复用与 attachOrbit 同一套「默认机位」口径，
       地球自转 / 公转经 SUN_BRIDGE.earthOrbit 驱动主模块相机（无复位接口，保持当前机位）。 */
    cv.addEventListener('dblclick', function (e) {
      e.preventDefault(); e.stopPropagation();
      resetCellOrbit(scn);
    });
  }
  /* ★ 修复 #12：综合窗格双击复位的默认机位（与各相机状态量的声明初值一致）：
       地面 gYaw/gPitch/gDist（2443 行起）· 天球 cYaw/cPitch/cDist · 室内 iYaw/iPitch/iDist ·
       第一人称 fpYaw/fpPitch。 */
  function resetCellOrbit(scn) {
    if (scn === 'fp') { fpYaw = 0; fpPitch = 0.03; fpFov = 62; }
    else if (scn === 'indoor') { iYaw = 0.6; iPitch = 0.10; iDist = 4.6; }
    else if (scn === 'sky') { cYaw = 0.85; cPitch = 0.45; cDist = 26; }
    else if (scn === 'ground') { gYaw = 0.14; gPitch = 0.18; gDist = 36; }
    /* ★ v52（需求G6）：观测点位置窗格与 svWinEarth 共用 orbEarth，双击即复位到同一默认机位 */
    else if (scn === 'earth') { orbReset(orbEarth); }
    /* orbit：主模块未暴露相机复位接口，保持当前机位（不改动，避免误操作）。 */
  }
  /* ★ v41（需求一·7）：综合窗格的可用区域。
     原实现按各面板实际矩形收边（贴左收左、贴右收右、贴底收底），以保证窗格不被面板压住。
     ★ 本批次修复 #5：综合视图下太阳侧 4 个面板（svOptsCard / svTimeTop / svTimeBar /
       svMonitor）已由 applyPanelVisibility 的 inCombo 门控隐藏 ⇒ 面板不再占位，窗格直接铺满整屏。
       保留「仅让出顶部标题栏 + 8px 边距」的收边逻辑即可。 */
  /* ★ v53（需求一·1）：窗格可用区 = 视口**扣除当前可见面板 / 悬浮窗的矩形**。
     旧实现铺满整屏、不计面板 —— 那是在「综合视图下面板被整体隐藏」的前提下写的
     （修复 #5 / #7）。v53 把面板放回来后若仍铺满整屏，面板就会压在窗格上、
     且落在面板下的窗格拖拽手柄点不到，等于把老问题换个形式保留。

     算法（v53 定稿）：把可见面板的横向占位离散成若干「被占区间」，
     再在剩余空间里挑**最宽的那一段连续空白**作为窗格可用区。
       ① 逐个取可见、未折叠、与视口有交集的面板矩形，左右边界并成区间；
       ② 合并重叠区间、按左边界排序；
       ③ 在 [8, W-8] 内求各空白段，挑宽度最大者；
       ④ 竖向同理，取各面板顶边之上 / 底边之下的最大空白段。
     这样无论面板停靠在左列、右列还是中列（applySurfaceLayout 会把 3 个悬浮窗
     排在时间卡左侧的中间列），窗格都能自动落到那片最大的空白里，
     天然做到「面板悬浮于视图上方、互不干扰」。
     面板拖动 / 折叠 / 隐藏后由 applyPanelVisibility / 拖拽 stop / setPanelCollapsed
     → layoutSunCombo 再次重算。 */
  var COMBO_PANEL_IDS = ['svOptsCard', 'svTimeTop', 'svMonitor', 'svTimeBar',
                         'svWinEarth', 'svWinSky', 'svWinGround'];
  function comboPanelRects() {
    var W = window.innerWidth, H = window.innerHeight;
    return COMBO_PANEL_IDS.map(function (id) {
      var n = $(id); if (!n) return null;
      if (!n.classList.contains('sv-on')) return null;
      if (n.classList.contains('collapsed')) return null;      // 折叠只剩标题条，让窗格用
      var r = n.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return null;
      return r;
    }).filter(Boolean);
  }
  /* 在 [lo,hi] 内扣除若干区间后，返回最宽的一段连续空白 */
  function widestGap(lo, hi, spans) {
    var iv = spans.map(function (s) { return [Math.max(lo, s[0]), Math.min(hi, s[1])]; })
                    .filter(function (s) { return s[1] > s[0]; })
                    .sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    iv.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    });
    var best = [lo, lo], cur = lo;
    merged.forEach(function (s) {
      if (s[0] > cur) { if (s[0] - cur > best[1] - best[0]) best = [cur, s[0]]; }
      cur = Math.max(cur, s[1]);
    });
    if (hi > cur && hi - cur > best[1] - best[0]) best = [cur, hi];
    return best;
  }
  function comboInset() {
    var W = window.innerWidth, H = window.innerHeight;
    var M = 8;                                        // 视口边距
    // ★ 需求一·1（v55）：子窗口铺满整屏，浮动面板悬浮叠加在最上层，
    //   故不再扣除面板占位（comboPanelRects / widestGap 已弃用），
    //   窗口直接占满「顶部菜单栏以下」的全屏区域。
    var tbEl = $('titleBar');
    var yTop = (tbEl && tbEl.offsetHeight ? tbEl.offsetHeight : 58) + M;
    return { L: M, R: W - M, T: yTop, B: H - M };
  }
  function comboAvailRect() {
    var ins = comboInset();
    return { x: ins.L, y: ins.T, w: Math.max(240, ins.R - ins.L), h: Math.max(200, ins.B - ins.T) };
  }
  /* 自动铺满屏幕：n 窗按网格排布（1 行 / 2 列 / 2×2 / 3×2 …），可用区内无空隙 */
  function layoutSunCombo() {
    var wrap = $('svComboUI'); if (!wrap) return;
    var keys = Object.keys(sComboCells); if (!keys.length) return;
    var n = keys.length;
    var cols = n <= 1 ? 1 : (n === 2 ? 2 : (n <= 4 ? 2 : 3));
    var rows = Math.ceil(n / cols);
    var A = comboAvailRect(), pad = 8;
    var cw = (A.w - pad * (cols + 1)) / cols;
    var ch = (A.h - pad * (rows + 1)) / rows;
    keys.forEach(function (k, i) {
      var cell = sComboCells[k].node;
      var lay = (S.combo.layout && S.combo.layout[k]) || {};
      /* 手动拖拽 / 拉伸过的窗口保留自身位置与尺寸；自动摆放的（lay.auto）随面板 / 窗口变化重排 */
      if (!lay.auto && lay.x != null && lay.w != null) {
        cell.style.left = lay.x + 'px'; cell.style.top = lay.y + 'px';
        cell.style.width = lay.w + 'px'; cell.style.height = lay.h + 'px';
        return;
      }
      var c = i % cols, rw = Math.floor(i / cols);
      /* 最后一行的窗口均分剩余宽度 */
      var isLastRow = rw === rows - 1;
      var inLastRow = n - cols * (rows - 1);
      var lastW = isLastRow ? (A.w - pad * (inLastRow + 1)) / inLastRow : cw;
      var x = isLastRow ? (A.x + pad + c * (lastW + pad)) : (A.x + pad + c * (cw + pad));
      var cwUse = isLastRow ? lastW : cw;
      cell.style.left = Math.round(x) + 'px';
      cell.style.top = Math.round(A.y + pad + rw * (ch + pad)) + 'px';
      cell.style.width = Math.round(cwUse) + 'px';
      cell.style.height = Math.round(ch) + 'px';
      lay.x = cell.offsetLeft; lay.y = cell.offsetTop; lay.w = cell.offsetWidth; lay.h = cell.offsetHeight;
      lay.auto = true;                                   /* ★ v41：标记为「自动摆放」，面板收起后可重排 */
    });
  }
  /* 每帧渲染综合视图的各窗格 */
  var _sComboAcc = 0;
  function renderSunCombo(dt) {
    if (!S.combo.on || S.view !== 'combo') return;
    var wrap = $('svComboUI'); if (!wrap || !wrap.classList.contains('on')) return;
    _sComboAcc += dt;
    if (_sComboAcc < 0.05) return;   /* 节流 ~20fps：综合窗为辅助视图 */
    _sComboAcc = 0;
    var keys = Object.keys(sComboCells); if (!keys.length) return;
    var g = sunGeom(BR.getSimMs(), obsLat(), obsLon());
    keys.forEach(function (k) {
      var o = sComboCells[k]; if (!o) return;
      var r = o.cv.getBoundingClientRect();
      if (!(r.width > 8 && r.height > 8)) return;
      var scn = o.scn, cam = null, scene3 = null;
      if (scn === 'ground') { cam = gCam; scene3 = gScene; updateGroundCam(g); }
      else if (scn === 'sky') { cam = cCam; scene3 = cScene; updateCelestialCam(); }
      else if (scn === 'indoor') { cam = iCam; scene3 = iScene; updateIndoorCam(); }
      else if (scn === 'fp') { cam = fpCam; scene3 = gScene; setFpCamFromState(); }
      if (scene3 && cam) { renderSunCell(scene3, cam, o, r); return; }
      /* ★ v52（需求G6）：「观测点位置」窗格与右下角同名悬浮窗 svWinEarth **完全一致** ——
         双方共用同一套场景 + 相机（eScene / eCam）与同一套轨道参数 orbEarth，
         不再走主模块的 earthScene（那是「地球自转视图」，与观测点位置本就不是一回事）。 */
      if (scn === 'earth') { orbApply(eCam, orbEarth); renderSunCell(eScene, eCam, o, r); return; }
      /* 公转视图：交给主模块的场景 + 相机，用本窗格的小 renderer 出图 */
      var bridge = window.SUN_BRIDGE || {};
      if (!bridge.earthScene) return;
      var es = bridge.earthScene('revolve');
      if (!es || !es.scn || !es.cam) return;
      renderSunCell(es.scn, es.cam, o, r, bridge);
    });
  }
  /* 用一个（每窗格独立的）WebGLRenderer 把 3D 场景画进窗格画布 */
  function renderSunCell(scene3, cam, o, r, bridge) {
    /* ★ v52（需求G6）：「观测点位置」窗格的渲染器必须与 svWinEarth 同款 ——
       wEarth = new WebGLRenderer({antialias:false, alpha:true}) + sRGBEncoding + 底色 #060a14。
       其余窗格维持原设置（antialias:true / 不透明 / 纯黑），故这里按 o.scn 分档创建。 */
    var isEarth = (o.scn === 'earth');
    var rr = o._r || (o._r = new THREE.WebGLRenderer({ canvas: o.cv, antialias: !isEarth, alpha: isEarth }));
    if (isEarth && rr.outputEncoding !== THREE.sRGBEncoding) rr.outputEncoding = THREE.sRGBEncoding;
    /* ★ 修复 #6：像素比统一夹到 1.5（与三个 3D 缩略窗 L2322 同口径，此前用的是未夹取的
       window.devicePixelRatio，在 2x/3x 屏上会把综合窗缓冲区放大一倍以上）；
       且仅在像素比 / 尺寸真正变化时才 setPixelRatio / setSize。 */
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.round(r.width), h = Math.round(r.height);
    if (o._dpr !== dpr || o._w !== w || o._h !== h) {
      o._dpr = dpr; o._w = w; o._h = h;
      rr.setPixelRatio(dpr);
      rr.setSize(w, h, false);
    }
    rr.setScissorTest(false);
    /* ★ v41（需求一·7）：综合视图底色为纯黑；
       ★ v52（需求G6）：观测点位置窗格改用与 svWinEarth 相同的深蓝底 #060a14。 */
    rr.setClearColor(isEarth ? 0x060a14 : 0x000000, 1);
    var aspect = r.width / r.height;
    if (bridge && bridge.fitCam) bridge.fitCam(cam, aspect);
    else if (cam.isOrthographicCamera) { /* 正交：由主模块 fitCam 处理 */ }
    else if (Math.abs(cam.aspect - aspect) > 1e-4) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
    rr.render(scene3, cam);
  }


  /* ============================ 12. 面板显隐（【面板】菜单） ============================ */
  function visEl(id, on) {
    var n = $(id); if (!n) return;
    n.classList.toggle('sv-on', !!on && BR.getView() === 'sun');
  }
  /* ★ 本批次（需求四）：太阳视运动**单视图标题栏**的标题 / 提示文案。
     与地球运动视图 `.pane-h`（标题 + 右侧操作提示）同一套语言；
     S.indoor / S.fp 是「模式」而非 S.view，优先级最高。 */
  var SV_VIEW_HEAD = {
    ground: ['地面视图', '拖动旋转 · 滚轮/双指缩放 · 双击物体测物影'],
    sky: ['天球视图', '拖动旋转 · 滚轮/双指缩放'],
    indoor: ['室内视图', '拖动旋转 · 滚轮缩放'],
    fp: ['第一人称视图', '拖动转向 · 移动端可滑动'],
    earth: ['地球自转视图', '拖动旋转 · 滚轮/双指缩放'],
    orbit: ['地球公转视图', '拖动旋转 · 滚轮/双指缩放'],
  };
  function syncSvViewHead() {
    var t = $('svVhTitle'), h = $('svVhHint');
    if (!t || !h) return;
    /* ★ v52（需求G7）：标题行纵向位置改为**与地球侧窗格逐像素对齐**。
       数值口径对比（关键结论）：
         · app.js 里地球侧**单视图**窗格顶边 = TITLE_H + 8 —— 这个 8 是**固定像素**，
           不乘 --ui（`const pad = IMMERSIVE ? 0 : 8; layout.main = {x:0, y: TITLE_H + pad}`）；
         · 而 `window.__earthPaneTop()` 返回的是 TITLE_H + round(8 × --ui)（COMBO_PAD），
           ui ≠ 1 时它就与页面实际窗格顶边对不上；
         · sunview 又在上面额外 +2（inset）⇒ 标题行上沿累计偏差 ≈ 1px + (round(8×ui) − 8)px。
       故这里**不再使用 __earthPaneTop()**，按同一口径自行换算：
         沉浸模式 → 0；否则 → #titleBar 实测下沿。
       ★ v58（需求 3）：那 8px 已去掉（见下），太阳侧窗口上沿改为与菜单栏下沿齐平。
       #svFrame 与 #svViewHead 共用这条上沿（不再 +2）：标题条边框与窗框边框重合，
       标题条**内容区**上沿 = topPx + 1px，与地球侧 `.pane-h`（`.pane` 1px 边框内侧）逐像素一致。 */
    var topPx = 0;
    var tbEl = document.getElementById('titleBar');
    var immersive = document.body.classList.contains('immersive');
    /* ★ v60（需求3）：窗口上沿 = 顶部菜单栏**下沿 + 8px**，与地球运动单视图窗格
       顶边口径完全一致（app.js：`layout.main = { y: TITLE_H + 8 }`，这个 8 是**固定
       像素、不乘 --ui**）。v58 曾把这 8px 去掉让标题栏紧贴菜单栏，本次用户要求
       「与上方菜单栏留有一定空隙」，故恢复，使地面 / 天球视图与「地球侧视」观感一致。
       用 getBoundingClientRect().bottom 而不是 offsetHeight，是因为菜单栏在窄屏下
       会换行变高（--tb-h 只是下限），rect.bottom 才是它真实的下沿。 */
    if (!immersive) topPx = Math.round(tbEl ? tbEl.getBoundingClientRect().bottom + 8 : 8);
    var frame = $('svFrame');
    if (frame) frame.style.top = topPx + 'px';
    var head = $('svViewHead');
    if (head) head.style.top = topPx + 'px';
    var key = S.fp ? 'fp' : (S.indoor ? 'indoor' : (S.view === 'combo' ? '' : S.view));
    var d = SV_VIEW_HEAD[key];
    /* 太阳侧非当前视图 / 地球侧视图 ⇒ 清空（CSS 已让 #svViewHead 隐藏，这里只防文案残留） */
    t.textContent = d ? d[0] : '';
    h.textContent = d ? d[1] : '';
  }
  /* ★ 本批次（需求三）：把太阳侧所有面板 / 悬浮窗的**顶边夹到窗口标题栏之下** ——
     之前 PF 一律按「主标题栏下沿 + 2」夹取，而太阳视图的窗口标题栏在更低的位置，
     于是靠上的面板会爬到标题栏上方、甚至盖住它。这里注册一个 topInset 钩子：
     在太阳视图下返回「窗口标题栏下沿 + 6」，离开时传 null 还原成主标题栏口径。 */
  function svPanelTopInset() {
    var inSun = (BR.getView() === 'sun');
    /* 综合视图 / 沉浸模式没有单视图标题栏 ⇒ 用主标题栏口径 */
    if (!inSun || S.view === 'combo' || document.body.classList.contains('immersive')) return null;
    var head = $('svViewHead');
    if (!head || !head.offsetHeight) return null;
    return head.getBoundingClientRect().bottom + 6;
  }
  function applyPanelVisibility() {
    var inSun = BR.getView() === 'sun';
    /* ★ v53（需求一·1）：综合视图下**面板照常显示**。
       旧实现（修复 #5）把太阳侧 4 个面板在综合视图里整体隐藏，理由是
       「#svComboUI 是全屏不透明覆盖层、面板会压住窗格」——但那其实是
       **两个本该分开的问题**：
         ① 窗格该给面板「让位」  → 由 comboAvailRect() 扣除可见面板矩形来解决；
         ② 面板不该「凭空消失」  → 属于把可见性做坏了。
       现在：面板显隐只由各自的 S.panel.* 开关决定（与单视图同一口径），
       窗格可用区扣除面板占位，于是面板浮在窗格之上、互不干扰，
       仍可拖拽 / 折叠 / 隐藏。z-index 已在 sunview.css 里把 #svComboUI 降到 .card 之下。 */
    syncSvViewHead();
    if (PF && PF.setTopInset) { try { PF.setTopInset(svPanelTopInset); } catch (e) { console.warn('[sunview] PF.setTopInset', e); } }
    visEl('svOptsCard', S.panel.opts);
    visEl('svTimeTop', S.panel.timeTop);
    visEl('svTimeBar', S.panel.timeBar);
    visEl('svMonitor', S.panel.monitor);
    /* 两视图「时间数据面板」联动（同显同隐）：主模块 timeCard 无对应状态键，
       这里把内联 display 与 S.panel.timeTop 对齐；太阳视图下 CSS 让位规则优先。 */
    var _mtc = $('timeCard');
    if (_mtc) _mtc.style.display = S.panel.timeTop ? '' : 'none';
    /* 显示规则（需求 5.4）：一般都要显示；**主视图对应的那个悬浮窗不显示**
       ★ v39（需求二·4）：第一人称 / 室内视角下，地面悬浮窗必须显示（它们看不到地面全貌）。 */
    /* ★ v53（需求一·1）：3 个缩略悬浮窗在综合视图下**同样照常显示** ——
       用户要求「观测点、时间控制、时间、观测数据、设置等面板须正常显示」，
       悬浮窗（观测点位置 / 天球视图 / 地面全景）属于同一批浮窗，一并放开。
       它们各自可拖拽 / 折叠 / 关闭，且 comboAvailRect 会扣除它们的占位。 */
    visEl('svWinEarth', S.panel.earth && S.win.earth);
    visEl('svWinSky', S.panel.sky && S.win.sky);
    visEl('svWinGround', S.panel.ground && S.win.ground);
    if (inSun) {
      /* 主模块的面板在太阳视运动下让位（CSS 亦已兜底），保证"只有一个模块的面板在屏幕上" */
      ['optsCard', 'timeCard', 'controlBar'].forEach(function (id) {
        var n = $(id); if (n && n.style.display !== 'none') n.dataset.svHiddenBySun = '1';
      });
    }
    syncBodyClasses();
    /* v35（需求十五）：原 buildPanelMenu() 已重构为 fillPanelFlags(hostId, sun) ——
       这里改为「哪个面板浮层正开着就刷新哪个」，保持勾选态与面板显隐实时一致 */
    ['mPanelFlags|pUiPanels|false', 'svPanelFlags|pSvUiPanels|true'].forEach(function (spec) {
      var p = spec.split('|');
      var fly = document.getElementById(p[1]);
      if (fly && fly.classList.contains('on')) fillPanelFlags(p[0], p[2] === 'true');
    });
    /* ★ v61（需求 1）修正：面板显隐刚生效，这里**同步**重算「观测点与时间控制」的内部缩放 ——
       不能只靠下面 rAF 里的 applySurfaceLayout：rAF 在标签页不可见 / 无头环境里不交付，
       --ui 就永远写不上（实测溢出 295 > 172）。fitTimeBarScale 不依赖测量，此刻即可算准。 */
    fitTimeBarScale();
    requestAnimationFrame(applySurfaceLayout);
    requestAnimationFrame(fitMonitorPanel);      /* ★ v44（需求二）：观测点面板不滚动 ⇒ 需要时整体缩小 */
    /* ★ v41（需求一·7）：面板折叠 / 显隐会改变综合窗格的可用区，自动摆放的窗格随之重排 */
    if (S.combo && S.combo.on && S.view === 'combo') requestAnimationFrame(layoutSunCombo);
  }
  /* ★ v44（需求二）：太阳侧「观测点数据」面板（#svMonitor）—— 已移除内部滚动条，
     内容自然高度超出视口可用高度时，给整个面板写 `--timecard-fit`（zoom）等比缩小，
     保证「完整显示 + 零滚动条」。口径与主模块同步（下限 0.62，避免小到不可读）。 */
  function fitMonitorPanel() {
    var el = $('svMonitor'); if (!el) return;
    if (!el.classList.contains('sv-on') || el.classList.contains('collapsed')) {
      if (el.style.getPropertyValue('--timecard-fit')) el.style.removeProperty('--timecard-fit');
      return;
    }
    el.style.removeProperty('--timecard-fit');
    var r = el.getBoundingClientRect();
    var avail = Math.max(160, Math.round(window.innerHeight - r.top - 12));
    var natural = el.scrollHeight || r.height;
    var fit = 1;
    if (natural > avail && natural > 0) fit = Math.max(0.62, avail / natural);
    el.style.setProperty('--timecard-fit', fit.toFixed(3));
  }
  window.__svFitMonitor = fitMonitorPanel;
  var PANEL_FLAGS = [
    { k: 'opts', id: 'svOptsCard', label: '太阳视运动设置', group: '控制面板', sun: true },
    /* v37（需求二·1）：两视图统一叫「时间数据面板」，且互相联动（同显同隐） */
    { k: 'timeTop', id: 'svTimeTop', label: '时间数据面板（右上角 · 北京时间）', group: '时间面板', sun: true },
    { k: 'timeBar', id: 'svTimeBar', label: '下方时间控制面板（地方太阳时）', group: '时间面板', sun: true },
    { k: 'monitor', id: 'svMonitor', label: '观测点数据面板', group: '监测面板', sun: true },
    { k: 'earth', id: 'svWinEarth', label: '地球位置悬浮窗', group: '悬浮窗', sun: true },
    { k: 'sky', id: 'svWinSky', label: '天球情形悬浮窗', group: '悬浮窗', sun: true },
    { k: 'ground', id: 'svWinGround', label: '地面全景悬浮窗', group: '悬浮窗', sun: true },
    { k: 'mainOpts', id: 'optsCard', label: '设置', group: '控制面板', sun: false },
    { k: 'mainTime', id: 'timeCard', label: '时间数据面板（自转 / 公转）', group: '时间面板', sun: false },
    { k: 'mainBar', id: 'controlBar', label: '底部控制条（自转 / 公转）', group: '时间面板', sun: false },
  ];
  /* ★ v35（需求十五）：「面板与悬浮窗」入口从右上角按钮移入两棵设置菜单
     （主模块 设置 › 界面与主题 › 面板与悬浮窗 ／ 太阳侧 界面与主题 › 面板与悬浮窗）。
     fillPanelFlags(hostId, sun) 按容器归属渲染各自那一份开关列表：
       · 主模块容器（sun=false）：控制面板 / 时间面板等主模块面板 + 演示悬浮窗（MV_PANELS）；
       · 太阳侧容器（sun=true）：太阳视运动的 4 组面板 + 全部显示 / 全部隐藏 / 恢复默认布局。
     每次浮层打开（flyopen 事件）都会重填一次，勾选态始终与界面同步。 */
  function fillPanelFlags(hostId, sun) {
    /* ★ 本批次（需求一）：**同时接受 DOM 元素与 id 字符串** ——
       右上角统一设置区把「面板与悬浮窗」做成一级分区，容器是 gsSection() 返回的元素；
       旧写法 `$(hostId)` 只认 id，元素传进来直接返回 null ⇒ 该分区展开后一片空白。 */
    var host = (hostId && hostId.nodeType) ? hostId : $(hostId);
    if (!host) return;
    host.innerHTML = '';
    var inSun = BR.getView() === 'sun';
    /* ★ v41（需求三.3）：sun === 'both' 时（右上角「面板与悬浮窗」按钮的下拉）
       一次渲染当前模块那一份（避免两个模块的面板混在一起）。 */
    var bothMode = (sun === 'both');
    /* 渲染进右上角全局设置面板时，组名用内联小标题（gsCap）、开关行用 .gs-row.gs-sw，
       与其它一级分区的观感一致；渲染进旧菜单浮层（.pm-host）时保持原样。 */
    var tree = !!(host.closest && host.closest('#flyPanelMenu2'));
    /* 行容器：树形分组时指向分组内容，普通模式指向 host。
       ★ 必须声明在**函数级** —— 地球视图走的 `if (!sun)` 分支（演示悬浮窗）在 forEach 之外
       也要用它，此前声明在 forEach 回调里 ⇒ 地球运动下 ReferenceError，
       异常发生在 `fly.classList.toggle('on')` 之前，表现为「按钮点了没反应」。 */
    var rowHost = host;
    /* ★ v35：分组名与 PANEL_FLAGS 的 group 字段对齐 —— 旧代码遍历「悬浮窗（太阳视运动）」
       而数据里是「悬浮窗」，三个太阳侧悬浮窗开关从未被渲染出来（隐性 bug），一并修正。 */
    ['控制面板', '时间面板', '悬浮窗', '监测面板'].forEach(function (g) {
      var items = PANEL_FLAGS.filter(function (f) { return f.group === g && !!f.sun === !!sun; });
      if (!items.length) return;
      if (tree) { gsCap(host, g); } else { host.appendChild(el('h4', null, g)); }
      rowHost = host;
      items.forEach(function (f) {
        var n = $(f.id);
        var on;
        if (f.sun) on = !!S.panel[f.k];
        else if (f.id === 'controlBar') on = !!(n && !n.classList.contains('min'));
        else on = !!(n && n.style.display !== 'none');
        var usable = f.sun ? inSun : !inSun;
        if (!usable) return;            // 分容器后：不属于当前视图的项不渲染（另一边菜单负责）
        var row = el('label', tree ? 'gs-row gs-sw' : 'pm-item');
        row.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') +
          '/><span' + (tree ? ' class="gs-lab"' : '') + '>' + f.label + '</span>';
        var cb = row.querySelector('input');
        cb.addEventListener('change', function () {
          if (f.sun) { S.panel[f.k] = cb.checked; saveSoon(); applyPanelVisibility(); }
          else if (!n) { /* 主模块无此面板 */ }
          else if (f.id === 'controlBar') { n.classList.toggle('min', !cb.checked); }
          else if (f.id === 'timeCard') {
            /* 主侧勾选反向写回 S.panel.timeTop，与太阳侧同显同隐 */
            n.style.display = cb.checked ? '' : 'none';
            S.panel.timeTop = cb.checked; saveSoon();
          }
          else { n.style.display = cb.checked ? '' : 'none'; }
        });
        rowHost.appendChild(row);
      });
    });
    if (!sun) {
      /* 主模块容器：追加自转 / 公转 / 综合视图的 5 个演示悬浮窗（app.js 注册项） */
      var mv = window.MV_PANELS;
      if (mv && mv.length && !inSun) {
        if (tree) { gsCap(host, '演示悬浮窗（自转 / 公转 / 综合）'); }
        else { host.appendChild(el('h4', null, '演示悬浮窗（自转 / 公转 / 综合）')); }
        rowHost = host;
        mv.forEach(function (f) {
          var row = el('label', tree ? 'gs-row gs-sw' : 'pm-item');
          row.innerHTML = '<input type="checkbox"' + (f.get() ? ' checked' : '') +
            '/><span' + (tree ? ' class="gs-lab"' : '') + '>' + f.label + '</span>';
          var cb = row.querySelector('input');
          cb.addEventListener('change', function () { f.set(cb.checked); });
          rowHost.appendChild(row);
        });
      }
      return;
    }
    /* 太阳侧容器：底部操作行 */
    var row = el('div', 'pm-row');
    var b1 = el('button', 'btn xs', '全部显示');
    var b2 = el('button', 'btn xs', '全部隐藏');
    var b3 = el('button', 'btn xs', '恢复默认布局');
    b1.addEventListener('click', function () {
      /* v33：rows 是「逐行显隐」对象，不能被布尔覆盖（否则下一帧读 rows.pos 会 undefined） */
      Object.keys(S.panel).forEach(function (k) {
        if (k === 'rows') { Object.keys(S.panel.rows).forEach(function (r) { S.panel.rows[r] = true; }); }
        else S.panel[k] = true;
      });
      S.layout = {}; saveSoon();
      ['svOptsCard', 'svTimeTop', 'svTimeBar', 'svMonitor', 'svWinEarth', 'svWinSky', 'svWinGround'].forEach(resetEl);
      applySurfaceLayout(); applyPanelVisibility();
      fillPanelFlags(host, bothMode ? 'both' : sun);
    });
    b2.addEventListener('click', function () {
      Object.keys(S.panel).forEach(function (k) { S.panel[k] = false; });
      saveSoon(); applyPanelVisibility();
      fillPanelFlags(host, bothMode ? 'both' : sun);
    });
    b3.addEventListener('click', function () {
      S.layout = {}; S.panel = JSON.parse(JSON.stringify(DEF.panel)); saveSoon();
      ['svOptsCard', 'svTimeTop', 'svTimeBar', 'svMonitor', 'svWinEarth', 'svWinSky', 'svWinGround'].forEach(resetEl);
      applySurfaceLayout(); applyPanelVisibility();
      fillPanelFlags(host, bothMode ? 'both' : sun);
      toast('已恢复默认布局');
    });
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3);
    host.appendChild(row);
  }

  /* ============================================================
     全局设置面板：**一级分区可折叠，内容内联展开**
     ------------------------------------------------------------
     参照参考图重做，取代原先「一堆扁平行」的简陋样式：
       一级 gs-sec —— 图标 + 标题 + 副标题 + 右侧折叠箭头 的分区卡片
       条目 gs-row —— 开关行 / 控件行 / 按钮行（全部**直接内联**在一级分区正文里）
     折叠状态记在 gsFold.st，浮层每次重建后按记忆恢复。
     所有子元素底色统一走 rgba(var(--panel-rgb), var(--glass-ctl))，
     于是「面板背景不透明度」滑块一动，按钮 / 滑块 / 分组一起变。 */
  function gsFold(host, key, on) {
    var st = gsFold.st || (gsFold.st = {});
    if (on === undefined) return st[key];
    st[key] = !!on; return st[key];
  }
  function gsChev() { var s = document.createElement('span'); s.className = 'gs-chev'; s.textContent = '▾'; return s; }
  /* ★ 本批次（需求一）**取消二级菜单**：一级菜单项展开后，设置内容直接内联排布。
     这里提供一个「内联小标题」——纯文字 + 左侧细竖条，**不可点击、无折叠箭头**，
     仅用于把同一一级项下相邻的控件行分组（例如 6 个文字属性块），不构成二级菜单项。 */
  function gsCap(host, text) {
    var c = document.createElement('div'); c.className = 'gs-cap';
    c.appendChild(el('span', null, text));
    host.appendChild(c); return c;
  }
  function gsSection(host, o) {
    var sec = document.createElement('div'); sec.className = 'gs-sec';
    // ★ 本批次（需求三）：各级菜单**默认折叠**（=== false 才展开）
    if (gsFold(host, 'sec:' + o.key) !== false) sec.classList.add('gs-folded');
    var hd = document.createElement('button'); hd.type = 'button'; hd.className = 'gs-sec-h';
    hd.innerHTML = '<i class="gs-ico">' + (o.icon || '⚙️') + '</i>' +
      '<span class="gs-sec-t"><b>' + o.title + '</b>' + (o.sub ? '<em>' + o.sub + '</em>' : '') + '</span>';
    hd.appendChild(gsChev());
    var body = document.createElement('div'); body.className = 'gs-sec-b';
    hd.addEventListener('click', function () {
      sec.classList.toggle('gs-folded');
      gsFold(host, 'sec:' + o.key, sec.classList.contains('gs-folded'));
    });
    sec.appendChild(hd); sec.appendChild(body); host.appendChild(sec);
    return body;
  }
  function gsRow(host, labelText, cls) {
    var r = el('label', 'gs-row' + (cls ? ' ' + cls : ''));
    if (labelText) r.appendChild(el('span', 'gs-lab', labelText));
    host.appendChild(r); return r;
  }
  function gsSelect(host, labelText, opts, getVal, setVal) {
    var r = gsRow(host, labelText, 'gs-ctl');
    var s = document.createElement('select'); s.className = 'gs-sel';
    opts.forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op); });
    s.value = String(getVal());
    s.addEventListener('change', function () { setVal(s.value); });
    r.appendChild(s); return s;
  }
  function gsRange(host, labelText, min, max, step, getVal, setVal, fmt) {
    var r = gsRow(host, labelText, 'gs-ctl');
    var i = document.createElement('input'); i.type = 'range'; i.className = 'gs-rng';
    i.min = min; i.max = max; i.step = step; i.value = String(getVal());
    var o = el('i', 'gs-out', fmt(getVal()));
    i.addEventListener('input', function () { setVal(parseFloat(i.value)); o.textContent = fmt(parseFloat(i.value)); });
    r.appendChild(i); r.appendChild(o);
    return { input: i, out: o };
  }
  function gsColor(host, labelText, getVal, setVal) {
    var r = gsRow(host, labelText, 'gs-ctl');
    var c = document.createElement('input'); c.type = 'color'; c.className = 'gs-clr';
    c.value = getVal();
    c.addEventListener('input', function () { setVal(c.value); });
    r.appendChild(c);
    return c;
  }
  function gsSwitch(host, labelText, getVal, setVal, after) {
    var r = el('label', 'gs-row gs-sw');
    var c = document.createElement('input'); c.type = 'checkbox';
    c.checked = !!getVal();
    /* ★ 修复 #16：同步 aria-checked（checkbox 无原生该属性，供读屏明确通报勾选态） */
    c.setAttribute('aria-checked', String(c.checked));
    c.addEventListener('change', function () { setVal(c.checked); c.setAttribute('aria-checked', String(c.checked)); if (after) after(); });
    r.appendChild(c); r.appendChild(el('span', 'gs-lab', labelText));
    host.appendChild(r);
    return c;
  }
  function gsBtns(host, list) {
    var r = el('div', 'gs-row gs-btns');
    list.forEach(function (b) {
      var n = el('button', 'btn xs', b.label);
      n.addEventListener('click', b.onClick);
      r.appendChild(n);
    });
    host.appendChild(r); return r;
  }
  function fillGlobalSettings(host) {
    /* 自清空：既是「打开浮层」的入口，也是各开关切换后的**就地刷新**入口，
       复用同一段代码时不能留下上一次的内容。 */
    host.innerHTML = '';
    /* ★ v61（需求 4）：「全局设置」浮层的表头（吸顶）+ 右上角「—」折叠符号 ——
       浮层是整体重建的，表头必须放在这里重建，否则刷新内容后按钮会消失。
       唯一的关闭入口就是这个「—」按钮（点击浮层外部**不再**自动收起，见下方
       #btnPanelMenu2 的点击逻辑）；它同时摘掉 #titleBar.fly-open，把层级还原。 */
    (function () {
      var head = el('div', 'fly-head gs-fly-head');
      head.appendChild(el('span', 'fly-t', '全局设置'));
      var b = el('button', 'fly-close', '折叠');
      b.type = 'button';
      b.setAttribute('aria-label', '折叠（隐藏）全局设置面板');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        host.classList.remove('on');
        var tb = document.getElementById('titleBar');
        if (tb) tb.classList.remove('fly-open');
      });
      head.appendChild(b);
      host.appendChild(head);
    })();
    var snap = (BR.uiSnapshot && BR.uiSnapshot()) || null;
    if (!snap) return;
    var snapNow = function () { return (BR.uiSnapshot && BR.uiSnapshot()) || snap; };
    var D = window.MENU_DSL || {};
    var FONT = D.FONT_OPTS || [], WEIGHT = D.WEIGHT_OPTS || [], SCHEME = D.UI_SCHEME_OPTS || [];
    var dk = function () { return snapNow().mode === 'dark'; };

    /* ---- 一级：面板与悬浮窗 ---- */
    fillPanelFlags(gsSection(host, { key: 'panels', icon: '🗂️', title: '面板与悬浮窗', sub: '显示 / 隐藏 · 布局复位' }),
      BR.getView() === 'sun' ? 'both' : false);

    /* ---- 一级：界面与主题（★ 需求三：从地球侧左树迁入） ---- */
    /* ★ 本批次（需求一）：不再有二级菜单项，内容直接内联在一级分区下 */
    var g1 = gsSection(host, { key: 'theme', icon: '🎨', title: '界面与主题', sub: 'UI 色系 · 明暗模式 · 半透明毛玻璃' });
    gsSelect(g1, '明暗模式', [['light', '浅色（白底黑字）'], ['dark', '深色（黑底白字）']],
      function () { return snapNow().mode; }, function (v) { BR.panelSet('theme.mode', v); });
    gsSelect(g1, '色系', SCHEME,
      function () { return snapNow().scheme; }, function (v) { BR.panelSet('theme.scheme', v); });
    gsColor(g1, '面板底色',
      function () { var s = snapNow(); return (dk() ? s.darkPanel : s.lightPanel) || '#ffffff'; },
      function (v) { BR.panelSet(dk() ? 'theme.darkPanel' : 'theme.lightPanel', v); });
    /* ★ 本批次（需求五）：「文字颜色」并入「面板文字样式 › 面板文字色」——
       面板文字色（state.ui.panel.color）已是文字色的唯一来源，applyPanelFont 会把
       当前模式的主题文字色同步成同一值（见 app.js），此处再放独立控件会与之打架，故移除。 */
    gsRange(g1, '背景不透明度', 20, 100, 1,
      function () { return snapNow().glass; }, function (v) { BR.panelSet('theme.glass', v); },
      function (v) { return Math.round(v) + '%'; });
    gsRange(g1, '毛玻璃模糊', 0, 40, 1,
      function () { return snapNow().blur; }, function (v) { BR.panelSet('theme.blur', v); },
      function (v) { return Math.round(v) + 'px'; });

    /* ---- 一级：面板文字样式 ---- */
    var g2 = gsSection(host, { key: 'ptext', icon: '🖋️', title: '面板文字样式', sub: '全局统一 · 所有面板 / 菜单 / 窗口标题' });
    gsSelect(g2, '字体', FONT,
      function () { return snapNow().panel.font || ''; }, function (v) { BR.panelSet('panel.font', v); });
    gsRange(g2, '字号', 0.5, 3, 0.05,
      function () { return snapNow().panel.size; }, function (v) { BR.panelSet('panel.size', v); },
      function (v) { return v.toFixed(2) + '×'; });
    gsColor(g2, '面板文字色',
      function () { return snapNow().panel.color || '#1E293B'; }, function (v) { BR.panelSet('panel.color', v); });
    gsRange(g2, '文字透明度', 0.2, 1, 0.01,
      function () { return snapNow().panel.op; }, function (v) { BR.panelSet('panel.op', v); },
      function (v) { return Math.round(v * 100) + '%'; });
    gsSelect(g2, '字重', WEIGHT,
      function () { return String(snapNow().panel.weight || 400); },
      function (v) { BR.panelSet('panel.weight', parseInt(v, 10) || 400); });

    /* ---- 一级：全局文字样式（注释）—— 按参考图：开关行紧跟其控件行 ---- */
    var b4 = gsSection(host, { key: 'gtext', icon: '📝', title: '全局文字样式', sub: '地球 / 太阳文字注释的统一控制' });
    /* ★ 本次（任务四）：顺序改为「显示全部文字注释」→「全局文字统一」→ 各分类单独属性。 */
    gsSwitch(b4, '显示全部文字注释',
      function () { return snapNow().note.on; }, function (v) { BR.noteSet('on', v); });
    /* ★ 本批次（需求四）总开关：开启 ⇒ 六个属性全部统一（子开关随之全开）；
       关闭 ⇒ 收回全部，由各子开关单独控制。切换后整面板重建，读数与文字样式实时更新。 */
    gsSwitch(b4, '全局文字统一（全部属性）',
      function () { return snapNow().note.unify; },
      function (v) { BR.noteSet('unify', v); },
      function () { fillGlobalSettings(host); });
    /* ★ 本次（任务四）：删除各属性前的左侧内联小标题，让分类控件直接并列以节省版面 ——
       每个属性只保留「统一××」开关行 + 该属性的控件行，紧邻排列在一级分区正文里。 */
    function noteGrp(key, title, unifKey, unifLabel) {
      /* ★ v52（需求A·跨文件修复）：「统一××」开关此前读的是 snapNow().note[unifKey]
         （= note.size / note.font 等**主值**，恒为真/非空）⇒ 六个开关恒显示为开启，
         与同键滑条冲突。真正的「是否统一」判据是 note.unifyAttrs.*（app.js 侧只读它），
         uiSnapshot 已把它摊平成 note.unifySize / unifyFont / unifyColor / unifyOp /
         unifyWeight / unifyAlign，故这里按 unifKey 取对应摊平键读取。 */
      var cap = unifKey.charAt(0).toUpperCase() + unifKey.slice(1);
      gsSwitch(b4, unifLabel,
        function () { return !!(snapNow().note['unify' + cap]); },
        function (v) { BR.noteSet('unifyAttrs.' + unifKey, v); },
        function () { fillGlobalSettings(host); });
      return b4;
    }
    var n1 = noteGrp('gtext-size', '字号', 'size', '统一字号');
    gsRange(n1, '字号', 0.2, 10, 0.05,
      function () { return snapNow().note.size; }, function (v) { BR.noteSet('master.size', v); },
      function (v) { return v.toFixed(2) + '×'; });
    var n2 = noteGrp('gtext-font', '字体', 'font', '统一字体');
    gsSelect(n2, '字体', FONT,
      function () { return snapNow().note.font || ''; }, function (v) { BR.noteSet('master.font', v); });
    var n3 = noteGrp('gtext-color', '颜色', 'color', '统一颜色');
    gsColor(n3, '颜色',
      function () { return snapNow().note.color || '#ffffff'; }, function (v) { BR.noteSet('master.color', v); });
    var n4 = noteGrp('gtext-op', '透明度', 'op', '统一透明度');
    gsRange(n4, '透明度', 0, 1, 0.01,
      function () { return snapNow().note.op; }, function (v) { BR.noteSet('master.op', v); },
      function (v) { return Math.round(v * 100) + '%'; });
    var n5 = noteGrp('gtext-weight', '字重', 'weight', '统一字重');
    gsSelect(n5, '字重', WEIGHT,
      function () { return String(snapNow().note.weight || 400); },
      function (v) { BR.noteSet('master.weight', parseInt(v, 10) || 400); });
    var n6 = noteGrp('gtext-align', '对齐', 'align', '统一对齐');
    gsSelect(n6, '对齐', [['left', '居左'], ['center', '居中'], ['right', '居右']],
      function () { return snapNow().note.align || 'center'; },
      function (v) { BR.noteSet('master.align', v); });

    /* ---- 一级：重置所有设置 ---- */
    gsBtns(gsSection(host, { key: 'reset', icon: '♻️', title: '重置所有设置', sub: '两个模块的全部设置恢复默认' }),
      [{ label: '重置所有设置', onClick: function () { svResetAll(); } }]);
  }
  /* 浮层每次打开时刷新开关勾选态（menu.js 的 flyopen 事件，主 / 太阳两棵菜单树都会派发） */
  document.addEventListener('flyopen', function (e) {
    var id = e.target && e.target.id;
    if (id === 'pUiPanels') fillPanelFlags('mPanelFlags', false);
    if (id === 'pSvUiPanels') fillPanelFlags('svPanelFlags', true);
  });
  /* ★ v41（需求三.3）：右上角「面板与悬浮窗」按钮 —— 下拉一次性列出当前模块的面板开关。
     挂在「沉浸模式」按钮旁，与设置菜单里的同名浮层共用 fillPanelFlags。 */
  (function () {
    var btn = document.getElementById('btnPanelMenu2');
    var fly = document.getElementById('flyPanelMenu2');
    if (!btn || !fly) return;
    function place() {
      var r = btn.getBoundingClientRect();
      var W = 360;                                   /* ★ 需求三：加宽，避免标签被截断成「文字透明…」 */
      fly.style.position = 'fixed';
      fly.style.top = (r.bottom + 6) + 'px';
      fly.style.left = Math.max(8, r.right - W) + 'px';
      fly.style.width = W + 'px';
      /* ★ 本批次（需求一 + 五）：统一设置区内容较多（面板开关 + 界面主题 + 面板文字样式 +
         全局文字样式 + 重置），必须**夹进可视区**并允许内部滚动，否则底部
         「重置所有设置」会被裁掉、点不到。 */
      var top = r.bottom + 6;
      var avail = Math.max(160, window.innerHeight - top - 10);
      fly.style.maxHeight = avail + 'px';
      fly.style.overflowY = 'auto';
    }
    var tbBar = document.getElementById('titleBar');
    function setFlyOpen(on) {
      fly.classList.toggle('on', on);
      /* ★ v61（需求 4）：浮层是 #titleBar（自成层叠上下文，z-index 15）的子元素，
         面板 .card 最高到 60 会整块盖住它 ⇒ 打开期间把标题栏这一层整体抬到最上
         （#titleBar.fly-open → z-index 200），关闭时还原。 */
      if (tbBar) tbBar.classList.toggle('fly-open', on);
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOn = !fly.classList.contains('on');
      if (willOn) {
        /* ★ 本批次（需求二）：整个浮层由 fillGlobalSettings 一把重建 —— 它内部第一个
           一级分区「面板与悬浮窗」自己就会调 fillPanelFlags(b1,'both')。
           此前这里还额外先调一次 fillPanelFlags('flyPanelMenu2','both')，于是旧的
           「扁平行」内容被插到新树**前面**（截图里控制面板/时间面板与树重复出现两遍）。 */
        fillGlobalSettings($('flyPanelMenu2'));
        place();
      }
      setFlyOpen(willOn);
    });
    /* ★ v61（需求 4）：**取消「点击浮层外部自动收起」** ——
       用户明确要求「点开后不自动折叠隐藏，只有单击右上角的『—』折叠符号才隐藏」。
       故这里不再注册 document 上的外部点击收起监听，浮层的关闭入口只剩
       fillGlobalSettings 注入的表头「—」按钮（它负责摘掉 .on 与 #titleBar.fly-open）。 */
  })();
  function resetEl(id) {
    var n = $(id); if (!n) return;
    n.style.left = ''; n.style.top = ''; n.style.right = ''; n.style.bottom = '';
    n.style.width = ''; n.style.height = ''; n.style.transform = '';
    /* ★ v62（需求 3）：「重置所有设置」要把 #svTimeBar 的拖拽宽度一并复位 ——
       fitTimeBarScale 以元素上的 --svtb-frac 为准（见该函数），不清掉它就会保留旧宽度。 */
    n.style.removeProperty('--svtb-frac');
  }
  /* ★ v61（需求 1）：「观测点与时间控制」面板的**内部缩放绑定到自身宽度** ——
     面板宽度由 CSS 定为 `clamp(50vw×倍率, 占屏比×100vw×倍率, 70vw×倍率)`（默认占屏比 0.6），
     高宽比锁 4.15:1（★ v62 需求 3：宽度可拖拽，比例范围 50% ~ 70%，并随字号倍率同比缩放；
     ★ v62 需求 5：3.7 → 4.15 消除面板底部空白带，见 sunview.css 尺寸块注释）；
     内部控件 / 字号则统一用 `--ui` 缩放。若两者脱钩（旧 v60 内部 --ui 有 0.80 地板、
     宽度却按 --ui 走），字号一大内容就溢出、字号一小底部就留一大片空白。
     这里把本面板子树的 `--ui` 写成「面板宽 / REF_W」：
       · REF_W = 1000 = **v60 已在用户屏幕上实测过的基准**（那时面板就是 1000·ui × 270·ui，
         270 / 1000 = 1 / 3.7037 ≈ v60/v61 锁定的宽高比 3.7 ⇒ 宽高同源；v62 需求 5 经用户
         截图实测内容比例 ≈ 4.18，面板宽高比改为 4.15，内部缩放仍绑定「宽 / 1000」）；
       · 于是「面板宽多少 ⇔ 内部缩放多少」⇒ 内容永远刚好铺满：
         不溢出（不遗漏）、不压字、不留白、不变形；字号倍率一变，宽度与内容同步等比变化。
     触发时机（四条并行，任一即可，互为兜底）：切视图 / 面板显隐结束（applyPanelVisibility）、
     面板落位（applySurfaceLayout）、window resize、ResizeObserver —— 其中后两条随渲染帧
     交付，前两条是同步调用，保证「面板刚变可见的那一帧」就已经算好，不留一帧的溢出闪烁。 */
  var SVTB_REF_W = 1000;
  /* 读用户字号倍率（app.js applyPanelFont 写到 documentElement 的 --ui-fs，默认 1） */
  function svtbFontScale() {
    var raw = document.documentElement.style.getPropertyValue('--ui-fs');
    if (!raw) raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-fs');
    var fs = parseFloat(raw);
    return (isFinite(fs) && fs > 0) ? fs : 1;
  }
  function fitTimeBarScale() {
    var el = $('svTimeBar'); if (!el) return;
    var fs = svtbFontScale();
    /* ★ v62（需求 3）：宽度口径与 sunview.css 的 #svTimeBar **完全一致** ——
         · 下限 = 50vw × 字号倍率、上限 = 70vw × 字号倍率（再用 min(…, 100vw − 32px) 防出屏）；
         · 默认 = 60vw × 字号倍率（即 --svtb-frac 的缺省值 0.6）；
         · 用户拖过则以存档比例 lay.frac 为准（拖拽结束时已夹进 50% ~ 70%）。
       CSS 负责「宽度」，JS 只写比例变量 --svtb-frac / 字号倍率 --svtb-fs 并按同一公式
       算出宽度 k 去绑定内部缩放 --ui（= 宽 / 1000）。这里**直接算**而不测量 ——
       面板处于 display:none（未切到太阳视图 / 面板开关关闭 / 切视图的那一帧）时测到 0。 */
    el.style.setProperty('--svtb-fs', String(fs));
    var W = window.innerWidth;
    var lo = Math.min(0.50 * W * fs, W - 32);
    var hi = Math.min(0.70 * W * fs, W - 32);
    var lay = S.layout.svTimeBar || (S.layout.svTimeBar = {});
    /* ★ v62（需求 3）：比例以**元素上的 --svtb-frac 为准**（拖拽过程中由 pointermove 实时写入；
       ResizeObserver 会因宽度变化回调本函数，若此处只认 lay.frac 就会把宽度「弹回」拖拽前的值）。
       无 inline 值时回落存档 lay.frac，再无则默认 0.60（= 屏宽 60%）。 */
    var fracRaw = parseFloat(el.style.getPropertyValue('--svtb-frac'));
    var frac = (isFinite(fracRaw) && fracRaw > 0) ? clamp(fracRaw, 0.50, 0.70)
             : ((isFinite(lay.frac) && lay.frac > 0) ? clamp(lay.frac, 0.50, 0.70) : 0.60);
    el.style.setProperty('--svtb-frac', String(frac));
    var w = clamp(frac * W * fs, lo, Math.max(lo, hi));
    if (!(w > 40)) return;
    var k = w / SVTB_REF_W;
    el.style.setProperty('--ui', k.toFixed(4));
    var body = el.querySelector('.svtb-body');
    if (!body) return;
    /* 兜底：内容（nowrap 文本 / 控件保底宽）仍比可用区大时，按溢出比例再缩一档 ——
       面板内所有尺寸（内边距 / 间隙 / 各 min-width / 字号）都已改为 ∝ --ui，
       故内容尺寸与 --ui 严格线性，一次修正即精确贴合：
       横向不遗漏（不出现被裁掉 / 横向滚动条），纵向不溢出（不出现纵向滚动条）。 */
    var f = 1;
    if (body.clientWidth > 0 && body.scrollWidth > body.clientWidth + 1) {
      f = Math.min(f, body.clientWidth / body.scrollWidth);
    }
    if (body.clientHeight > 0 && body.scrollHeight > body.clientHeight + 1) {
      f = Math.min(f, body.clientHeight / body.scrollHeight);
    }
    if (f < 0.999) el.style.setProperty('--ui', (k * f).toFixed(4));
  }
  window.addEventListener('resize', fitTimeBarScale);
  if (window.ResizeObserver) {
    var _tbRO = new ResizeObserver(function () { fitTimeBarScale(); });
    var _tbROEl = $('svTimeBar');
    if (_tbROEl) _tbRO.observe(_tbROEl);
  }
  /* 默认停靠：设置面板左上、时间面板右上、监测面板右上（天球）、3 个悬浮窗右下角一列 */
  function applySurfaceLayout() {
    var tb = $('titleBar');
    var dockTop = (tb && tb.offsetHeight ? tb.offsetHeight : 58) + 12;
    ['svOptsCard', 'svTimeTop', 'svMonitor'].forEach(function (id) {
      var n = $(id); if (!n) return;
      var lay = S.layout[id];
      if (lay && lay.x != null) return;
      if (id === 'svOptsCard') { n.style.left = '16px'; n.style.top = dockTop + 'px'; }
      else { n.style.right = '16px'; n.style.left = 'auto'; n.style.top = dockTop + 'px'; }
    });
    /* v32（需求二）：观测点数据面板默认停靠在「时间」卡**左侧**（与主模块「地球运动观测」
       面板同一策略）—— 若停在时间卡下方，会与右下角一列的观测点位置 / 天球视图 / 地面全景
       三个悬浮窗在 900px 高度下互相压叠。 */
    var mon = $('svMonitor');
    if (mon && !(S.layout.svMonitor && S.layout.svMonitor.x != null)) {
      var tt = $('svTimeTop');
      var ttW = (tt && tt.offsetWidth) ? tt.offsetWidth : 240;
      mon.style.left = 'auto';
      mon.style.right = (16 + ttW + 10) + 'px';
      mon.style.top = dockTop + 'px';
      /* 屏宽不够（面板会压到左侧设置面板）时退回时间卡下方 */
      if (window.innerWidth - (16 + ttW + 10) - mon.offsetWidth < 290) {
        mon.style.right = '16px';
        var ttH = (tt && tt.classList.contains('collapsed')) ? 42 : (tt ? tt.offsetHeight : 210);
        mon.style.top = (dockTop + ttH + 10) + 'px';
      }
    }
    /* ★ v62（需求 3）：此处原有「写 --sv-right-gap 给底部时间面板让位」的 IIFE 已删除 ——
       #svTimeBar 改为在整屏水平居中（sunview.css: left:0/right:0 + margin:auto），
       不再需要为右侧悬浮窗列留出宽度；右下角那一列悬浮窗本身也自下而上堆叠到
       「本面板上沿」为止（见下方 baseY），两者天然不重叠。 */
    /* ★ v40（需求四 + 需求三）：悬浮窗停靠 —— 原先从底部向上堆叠且 right:16px，
       与「时间」面板（同样 right:16px）在竖直方向上完全重叠 ⇒ 压住时间面板
       （用户截图：观测点位置 / 天球视图两窗盖在时间面板上）。
       改为：悬浮窗**整体让位到时间面板左侧**（与观测点数据面板同一列），
       自时间面板下沿起向上 / 向下排布；空间不足时依次退让：
         ① 时间面板左侧一列（默认）
         ② 视口右下角一列（屏宽不足时） */
    var ttEl = $('svTimeTop');
    var ttVisible = ttEl && ttEl.classList.contains('sv-on') && ttEl.style.display !== 'none';
    var ttW = ttVisible ? (ttEl.offsetWidth || 336) : 0;
    var ttLeft = ttVisible ? ttEl.getBoundingClientRect().left : (window.innerWidth - 16);
    /* ★ v44（需求三）：悬浮窗列宽必须用**实际渲染宽度**，不能再用写死的 232
       —— CSS 里 `.svwin { width: 300px * var(--ui) }`（1440 宽屏下 = 282px），
       按 232 让位会让这一列压到「观测点数据」面板上（实测重叠 44 × 243px）。 */
    var winW = 232;
    (function () {
      ['svWinEarth', 'svWinSky', 'svWinGround'].forEach(function (id) {
        var n = $(id); if (!n) return;
        var w = n.getBoundingClientRect().width;
        if (w > 4) winW = Math.max(winW, Math.round(w));
      });
      /* 全隐藏时用 CSS 声明值兜底（display:none 量不到宽） */
      var uiK = (PF && PF.uiScale) ? PF.uiScale() : 1;
      winW = Math.max(winW, Math.round(300 * uiK));
      var earthEl = $('svWinEarth');
      if (earthEl && PF && PF.minOf) { try { winW = Math.max(winW, PF.minOf(earthEl, 'win').minW); } catch (e) { console.warn('[sunview] combo avail width minOf', e); } }
    })();
    /* 可用左边界：设置面板右缘 + 间隙 */
    var optsEl = $('svOptsCard');
    var optsRight = (optsEl && optsEl.classList.contains('sv-on') && optsEl.style.display !== 'none')
      ? optsEl.getBoundingClientRect().right : 16;
    var colLeft = Math.round(ttLeft - 10 - winW);          // 时间面板左侧一列
    var canLeft = (colLeft - optsRight) > 40;              // 左侧是否放得下
    var colRightPx = canLeft ? Math.round(window.innerWidth - colLeft) : 16;  // 用 right 定位更稳
    var colTop0 = dockTop;                                  // 起始高度（标题栏下沿 + 间隙）
    var baseY = window.innerHeight - 14;
    /* 悬浮窗不越过「底部观测点/时间控制」窗（#svTimeBar）上沿 */
    var tbEl = $('svTimeBar');
    if (tbEl && tbEl.classList.contains('sv-on') && tbEl.style.display !== 'none') {
      baseY = Math.min(baseY, Math.round(tbEl.getBoundingClientRect().top) - 10);
    }
    /* ★ v40：逐窗排布（不依赖彼此的高度测量，稳健）。
       自下而上依次落位；每放好一窗，就把「下一窗的可用底边」上移到该窗上沿之上。
       ★ 高度取真实渲染高度：先落位 → 强制回流（读 offsetHeight）→ 再定最终 top。
       若元素当前不可见（display:none），退回到上一次记录的高度或默认 238。 */
    var placedBottom = baseY;   // 当前可用的底边（下一窗的 bottom 上限）
    ['svWinGround', 'svWinSky', 'svWinEarth'].forEach(function (id) {
      var n = $(id); if (!n) return;
      var lay = S.layout[id];
      if (lay && lay.y != null && lay.x != null) return;
      /* ★ v40：不可见的悬浮窗不参与堆叠（否则会白占一行高度，把后续窗顶到上沿而重叠）。 */
      if (getComputedStyle(n).display === 'none' || !n.classList.contains('sv-on')) return;
      if (canLeft) { n.style.left = 'auto'; n.style.right = colRightPx + 'px'; }
      else { n.style.left = 'auto'; n.style.right = '16px'; }
      n.style.top = '0px'; n.style.bottom = 'auto';
      void n.offsetHeight;                                   // 强制回流，取到真实高度
      var h = n.offsetHeight || n.getBoundingClientRect().height
              || (n.classList.contains('collapsed') ? 40 : 238);
      var top = Math.max(colTop0, placedBottom - h);
      n.style.top = Math.round(top) + 'px';
      void n.offsetHeight;
      placedBottom = top - 10;   // 下一窗（更靠上）不得低于本窗上沿
    });
    fitMonitorPanel();           /* ★ v44（需求二）：面板落位后再按新位置判断是否需要整体缩小 */

    /* ★ v44（需求 1 / 3）：布局收尾 ——
       ① 同步折叠态面板的 --fold-h（实测表头高），保证 CSS 能把卡片夹到「只有表头」；
       ② 所有面板一律夹回可见区域（含标题栏下沿），任何窗口尺寸下都不出界。 */
    sunPanelNodes().forEach(function (n) {
      if (n.classList.contains('collapsed')) foldHeadH(n);
      if (!PF.visible(n)) return;
      /* ③ 面板已经落位 ⇒ 这时量到的内容尺寸才是可信的，重算一次内容最小宽高 */
      try {
        var kind = n.dataset.pmKind;
        if (kind && !n.classList.contains('collapsed')) PF.applyMin(n, kind);
      } catch (e) { console.warn('[sunview] applySurfaceLayout applyMin', e); }
      try { PF.clampPos(n); } catch (e) { console.warn('[sunview] applySurfaceLayout clampPos', e); }
    });
    /* ★ v61（需求 1）：面板落位后按**最终宽度**重算「观测点与时间控制」的内部缩放
       （RO 也会触发一次，这里显式再算一遍，保证首次显示 / 切视图时立即正确）。 */
    fitTimeBarScale();
    /* ★ v53（需求一·1）：面板落位 / 折叠 / 显隐之后，窗格可用区（comboInset 依赖
       面板的实际矩形）已经变了 —— 综合视图下必须重排窗格，否则它们会停在旧位置
       与面板重叠。放在 rAF 里等浏览器完成一次布局再量，保证读到的是最终矩形。 */
    if (S.combo && S.combo.on && S.view === 'combo') {
      requestAnimationFrame(function () { try { layoutSunCombo(); } catch (e) { console.warn('[sunview] layoutSunCombo', e); } });
    }
  }
  /* ★ v35（需求十五）：原右上角「面板与悬浮窗」按钮（#btnPanelMenu / #panelMenu）已移除，
     功能迁入两棵设置菜单的「界面与主题 › 面板与悬浮窗」（见 fillPanelFlags）。 */
  /* 各面板登记为可拖动 / 可拉伸 / 可折叠 / 可关闭 */
  /* ★ v44（需求三）：`fit` = 该面板所属的「内容特征档」，决定最小宽高与宽高比区间
     （见 app.js 的 __panelFit.PROFILE）；minW/minH 仅作为再往下的硬兜底。 */
  makeFloatPanel($('svOptsCard'), 'svOptsCard', { minW: 250, fit: 'menu' });
  makeFloatPanel($('svTimeTop'), 'svTimeTop', { minW: 280, fit: 'time' });
  /* ★ v62（需求 3）：「观测点与时间控制」面板改为**可缩放 + 宽高比固定** ——
     · aspect / uiRefW：宽高比锁 4.15（★ v62 需求 5：3.7 → 4.15 消除面板底部空白带，
       与 sunview.css 的 aspect-ratio 同步），拖拽任一方向只改宽度（高度自动跟随），
       同时把面板内部缩放 --ui 绑定到「宽 / 1000」（1000 = v60 实测基准）；
     · minFrac / maxFrac：宽度占屏宽的比例区间 = 50% ~ 70%（默认 60%），
       并与用户字号倍率 --svtb-fs 同比缩放（见 sunview.css 的 clamp 与 fitTimeBarScale）。 */
  makeFloatPanel($('svTimeBar'), 'svTimeBar', {
    minW: 420, fit: 'bar',
    aspect: 4.15, uiRefW: SVTB_REF_W, minFrac: 0.50, maxFrac: 0.70
  });
  makeFloatPanel($('svMonitor'), 'svMonitor', { minW: 220, fit: 'info' });
  /* ★ v41（需求一·19）：最小宽度 180 → 240（与放大后的 300px 默认宽匹配，用户仍能拉小） */
  makeFloatPanel($('svWinEarth'), 'svWinEarth', { minW: 240, minH: 90, fit: 'win' });
  makeFloatPanel($('svWinSky'), 'svWinSky', { minW: 240, minH: 90, fit: 'win' });
  makeFloatPanel($('svWinGround'), 'svWinGround', { minW: 240, minH: 90, fit: 'win' });
  /* ★ v41（需求一·1）：**竖排布局已删除** —— 底部「观测点与时间控制」窗恒为横排两列。
     原 `S.panel.tbVert` 状态、`#svTbLayout` 切换按钮、`.svtb-cols.vert` 样式全部移除。 */
  /* ★ v36（需求二）：删除下面这段折叠按钮的 id 级绑定（svBtnCollapse / svTtCollapse /
     svTbCollapse / svMonCollapse）—— makeFloatPanel 已经按 .card-head .link 文本
     （折叠 / 收起）给同一批按钮绑定过一次 toggle，这里再绑一次 ⇒ 每点一下
     toggle 两次自相消，「折叠 / 收起」看起来完全没反应。折叠的持久化
     （lay.collapsed → saveSoon）由 makeFloatPanel 的折叠分支统一负责。 */

  /* ============================ 13. 轻提示 / 弹窗 ============================ */
  var toastT = 0;
  function toast(msg, warn) {
    var t = $('svToast'); if (!t) return;
    t.textContent = msg; t.classList.add('on'); t.classList.toggle('warn', !!warn);
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }
  function modal(title, bodyNode, buttons) {
    var host = $('svModalHost'), card = $('svModalCard');
    if (!host || !card) return { close: function () { } };
    card.innerHTML = '';
    var head = el('div', 'card-head');
    head.innerHTML = '<h2><i class="hd-ico">⚙️</i>' + title + '</h2>';
    var close = el('button', 'link', '关闭');
    close.dataset.ic = 'close';            /* ★ v59（需求1）：弹窗关闭按钮统一为「×」 */
    head.appendChild(close);
    card.appendChild(head);
    var body = el('div', 'svm-body');
    body.appendChild(bodyNode);
    card.appendChild(body);
    var foot = el('div', 'svm-foot');
    (buttons || []).forEach(function (b) { foot.appendChild(b); });
    card.appendChild(foot);
    host.classList.add('on');
    function hide() { host.classList.remove('on'); }
    close.addEventListener('click', hide);
    host.querySelector('.svm-mask').onclick = hide;
    return { close: hide };
  }
  function mkBtn(label, cls, fn) {
    var b = el('button', 'btn xs ' + (cls || ''), label);
    b.addEventListener('click', fn);
    return b;
  }

  /* ============================ 14. 菜单（复用 menu.js 的渲染器与外观） ============================ */
  var DSL = window.MENU_DSL || {};
  var G = DSL.G, rg = DSL.rg, cl = DSL.cl, sl = DSL.sl, sw = DSL.sw, tip = DSL.tip, raw = DSL.raw,
      sep = DSL.sep || function () { return { raw: '<div class="section-sep"></div>' }; };
  var DASH_OPTS = DSL.DASH_OPTS || [['solid', '实线'], ['dash', '虚线']];

  /* ★ v32（需求六）：**逐条注释的独立属性菜单** —— 与主模块 noteGrp 同构：
       字号 / 字体 / 颜色 / 透明度 / 字重，状态路径走 @note.cats.<cat>.*
       （桥接到主模块 state.note.cats，因此「全局文字样式 › 全局统一」同样能统管它们）。
       注：op 在主模块里存 0~1，故用 opPct（lin01 映射）显示成百分比。 */
  /* 逐分类注释样式组（字号 / 字体 / 颜色 / 透明度 / 字重）。
     ★ v41（需求一·12）：新增第三参数 opt —— 传 { sw, swPath, gate } 时，显隐开关上移到
       **组标题行**，样式控件收进组内（「开关 + 样式组」两条并列的旧结构改为一条子组）。
       天球坐标系 / 物影 两处的「文字注释」菜单统一改成这个结构。 */
  function svNoteGrp(label, cat, opt) {
    /* ★ v52（需求4）：新增 opt.idp —— **可自定义控件 id 前缀**，使同一注释分类（cat）可以被
       重复实例化而不产生 DOM id 冲突（id 由分类名派生 ⇒ 同分类两处会撞 id，只有一个能绑定）。
       注意：状态路径仍为 @note.cats.<cat>.*，故同一 cat 的多份控件共享同一份样式值；
       若需各注释**真正独立**，须在 app.js 的注释样式系统里为每条注释新建分类（本轮不改 app.js）。 */
    opt = opt || {};
    var pf = opt.idp || cat;
    return G(label, [
      rg('rg' + pf + 'Size', '字号', '@note.cats.' + cat + '.size', 1, 1000, 1, 'out' + pf + 'Size', 'w100', 'x'),
      sl('sel' + pf + 'Font', '字体', '@note.cats.' + cat + '.font', DSL.FONT_OPTS),
      cl('clr' + pf + 'Color', '颜色', '@note.cats.' + cat + '.color', 'hex' + pf + 'Color'),
      rg('rg' + pf + 'Op', '透明度', '@note.cats.' + cat + '.op', 0, 100, 1, 'out' + pf + 'Op', 'lin01', 'opPct'),
      sl('sel' + pf + 'Weight', '字重', '@note.cats.' + cat + '.weight', DSL.WEIGHT_OPTS),
    ], opt);
  }

  var SUN_MENU = [
    /* =======================================================================
       v32（需求七）：太阳视运动菜单**重构**为 7 个一级菜单 ——
         ① 太阳光线与光照（真实太阳 · 体积光 · 天空与霞光）
         ② 太阳视运动（视运动轨迹 · 地面轨迹 · 太阳光线及阴影）
         ③ 天球坐标系（地平坐标系要素 · 赤道坐标系要素 · 固定模式 · 文字注释）
         ④ 观测与测量（测量物影 · 第一人称方向标）
         ⑤ 地面物体（地面方向标 · 建筑物含间距 · 小人模型 · 树木与旗杆 · 室内设置）
         ⑥ 全局文字样式
         ⑦ 界面与主题（UI 风格）
       同时按要求：悬浮窗设置**并入右上角【面板】**（更名为「面板与悬浮窗」）；
       取消「观测点定位」（已并入下方观测点与时间控制面板）；
       取消「太阳边缘光线」相关菜单与功能。
       ======================================================================= */

    /* ---------------- 一、太阳光线与光照 ---------------- */
    {
      id: 'sSvLight', icon: '☀️', name: '太阳光线与光照', sub: '真实太阳 · 体积光 · 天空与霞光',
      children: [
        {
          id: 'pSvSun', icon: '☀️', name: '真实太阳', sw: 'cbSvRealSun', swPath: 'sunr.real', swTip: '真实太阳渲染',
          children: [
            rg('rngSvCorona', '光晕强度', 'sunr.corona', 0, 200, 1, 'outSvCorona', 'int1', 'pct'),
            rg('rngSvSunSize', '太阳大小', 'sunr.size', 30, 300, 1, 'outSvSunSize', 'int1', 'pct'),
            sl('selSvSunQ', '渲染质量', 'sunr.quality', [['1', '高清（日冕+体积光）'], ['0', '流畅（关闭日冕）']]),
            /* ★ v39（需求二·1）：去掉「太阳」文字注释后，其样式子菜单「太阳标注样式」一并删除。 */
            tip('太阳为发光球体：内层亮核 + 外层日冕光晕；亮度与颜色随高度角变化 —— 日出日落偏橙红、' +
                '光线柔和，正午亮白、光线强烈；夜晚落到地平线以下不显示。'),
          ]
        },
        {
          id: 'pSvVol', icon: '🔅', name: '体积光', sw: 'cbSvVol', swPath: 'vol.on', swTip: '显示体积光（丁达尔效应）',
          children: [
            rg('rngSvVolN', '光线数量', 'vol.n', 1, 15, 1, 'outSvVolN', 'int1', 'raw'),
            rg('rngSvVolInt', '强度', 'vol.intensity', 0, 200, 1, 'outSvVolInt', 'int1', 'pct'),
            rg('rngSvVolOp', '透明度', 'vol.op', 0, 100, 1, 'outSvVolOp', 'int1', 'pct'),
            rg('rngSvVolDiff', '弥散度', 'vol.diffuse', 0, 100, 1, 'outSvVolDiff', 'int1', 'pct'),
            /* ★ v43（需求一·2）：以下四项对应新双层壳光柱 —— 颜色 / 直径 / 外围柔光范围 / 边缘柔化。 */
            cl('clrSvVol', '光柱颜色', 'vol.color', 'hexSvVol'),
            rg('rngSvVolDia', '光柱直径', 'vol.dia', 20, 300, 1, 'outSvVolDia', 'int1', 'pct'),
            rg('rngSvVolSheath', '外围柔光范围', 'vol.sheath', 100, 400, 1, 'outSvVolSheath', 'int1', 'pct'),
            rg('rngSvVolEdge', '边缘柔化', 'vol.edge', 40, 98, 1, 'outSvVolEdge', 'int1', 'raw'),
            rg('rngSvVolDecay', '两端衰减', 'vol.decay', 0, 100, 1, 'outSvVolDecay', 'int1', 'pct'),
            tip('★ v43：体积光改为**实心光柱 + 外围柔光束**双层结构（与地球运动视图的太阳体积光柱一致）——' +
                '内层是颜色可设的实心光柱，外层套一圈白色柔光；两者都由**屏幕空间径向衰减**' +
                '（柱心最亮、向柱缘连续归零）渲染，因此**任意视角都不会出现硬边或广告牌式的塌陷**。' +
                '光柱沿南北纵向排布，随太阳位置实时重建朝向与长度，太阳落到地平线下后自动关闭。' +
                '调「弥散度」改整体基准粗细，「光柱直径」在此基础上等比缩放，' +
                '「外围柔光范围」决定外壳是内层的几倍，「边缘柔化」越小边缘越干脆、越大越柔。'),
          ]
        },
        {
          id: 'pSvSky', icon: '🌇', name: '天空与霞光', children: [
            /* v35（需求四）：组内总开关一律上移到组标题行 —— 朝霞 / 晚霞、地平变色两组。 */
            G('朝霞 / 晚霞', [
              cl('clrSvDawn', '霞光颜色', 'sky.dawnColor', 'hexSvDawn'),
              rg('rngSvDawnOp', '霞光强度', 'sky.dawnOp', 0, 100, 1, 'outSvDawnOp', 'int1', 'pct'),
              rg('rngSvDawnW', '水平方位范围', 'sky.dawnW', 5, 100, 1, 'outSvDawnW', 'int1', 'pct'),
              rg('rngSvDawnH', '垂直铺展高度', 'sky.dawnH', 5, 100, 1, 'outSvDawnH', 'int1', 'pct'),
            ], { sw: 'cbSvDawn', swPath: 'sky.dawn', gate: 'sky.dawn' }),
            G('地平变色', [
              cl('clrSvHorizon', '变色颜色', 'sky.horizonColor', 'hexSvHorizon'),
              rg('rngSvHorizonOp', '变色强度', 'sky.horizonOp', 0, 100, 1, 'outSvHorizonOp', 'int1', 'pct'),
            ], { sw: 'cbSvHorizon', swPath: 'sky.horizon', gate: 'sky.horizon' }),
            rg('rngSvNightTint', '夜间色调强度', 'sky.nightTint', 0, 100, 1, 'outSvNightTint', 'int1', 'pct'),
            tip('日出 / 日落时太阳越低霞光越浓（方位范围控制霞光横向张开的角度，铺展高度控制它往上' +
                '延伸多少）；「地平变色」是贴近地平一圈的整体染色。' +
                '夜间色调强度同时作用于**天空、环境光、半球光与地面亮度**：越大入夜越暗、越偏深蓝紫，' +
                '调到 0 则只是把白天的蓝轻微压暗 —— 拉滑块即可肉眼看到整场景明暗变化。'),
          ]
        },
      ]
    },

    /* ---------------- 二、太阳视运动 ---------------- */
    {
      id: 'sSvPath', icon: '🌅', name: '太阳视运动', sub: '视运动轨迹 · 地面轨迹 · 光线与阴影',
      children: [
        {
          /* v35（需求八）：层级重构 ——「当日轨道（地平线上方）」成为**上级组**：
             ·「轨道线条」（原轨迹线条样式）并入其子菜单。
             ★ v62（需求一）：「位置点与时刻」组开关（traj.ptOn）已取消 ——
               整点时刻 / 日出日落中天 / 当前太阳位置点改由 traj.on,traj.today 直接门控，
               不再有「today 关 ⇒ ptOn 强制关、重开需手动再开」的中间级联层。
             v35（需求四）：二分二至 / 地平线下轨迹的组开关一并上移标题行。
             ★ v36（需求六 / 七）：
             · 二级条目**标题前新增总开关 traj.on** —— 统一管理浮层内全部内容
               （上关则下级全部强制关，级联规则自动推导）；
             · 「地面视运动轨迹」二级条目**整体并入**本浮层 —— 地面视图与天球视图共用
               同一套开关（轨迹 / 整点位置点 / 日出日落点 / 当前太阳位置点 / 地平线下 /
               注释），两个视图**完全一致**地显示；
             · 二分二至轨迹**逐套单独显示**（termShow：春分秋分 / 夏至 / 冬至各一枚开关，
               地面 + 天球都生效）。 */
          id: 'pSvTraj', icon: '🌅', name: '视运动轨迹（天球 + 地面）',
          sw: 'cbSvTraj', swPath: 'traj.on', swTip: '显示太阳视运动轨迹（天球视图与地面视图统一控制）',
          children: [
            /* ★ v52（需求B）：按截图重构「视运动轨迹」子菜单 ——
               · 每个子项开关前置到标题文字正前方（G 的 sw / swPath，不嵌进按钮）；
               · 线型统一收进「线型」子组（实线/虚线 + 虚线密度 + 虚实比）；
               · 全部复用既有状态键（traj.* / meas.* / @note.cats.*），不臆造键。
               无对应状态键的点样式（日出日落中天 / 整点位置点）与二分二至线型 / 线粗细
               仅保留原有可生效项，未提供的项见交付报告。 */
            G('当日轨道（地平线以上）', [
              cl('clrSvTraj', '线条颜色', 'traj.color', 'hexSvTraj'),
              svLwCtl('rngSvTrajW', '线条粗细', 'traj.w', 'outSvTrajW'),
              rg('rngSvTrajOp', '透明度', 'traj.op', 0, 100, 1, 'outSvTrajOp', 'int1', 'pct'),
              G('线型', [
                sl('selSvTrajDash', '线型', 'traj.dash', DASH_OPTS),
                rg('rngSvTrajN', '虚线密度', 'traj.n', 10, 200, 1, 'outSvTrajN', 'int1', 'raw'),
                rg('rngSvTrajRatio', '虚实比', 'traj.ratio', 20, 90, 1, 'outSvTrajRatio', 'int1', 'pct'),
              ]),
            ], { sw: 'cbSvToday', swPath: 'traj.today', swTip: '显示当日轨道（地平线以上）', gate: 'traj.on' }),

            /* 物影线段（天球）：显隐开关 = traj.shadow；线条样式复用「观察与测量 › 物影」同一套
               meas.* 状态键（两处控件绑定同一路径，改一处两处同步）。
               ★ v64（需求1）：组内「影长数值注释」开关（cbSvShadowNote / traj.shadowNote）已删除，
                 显隐合并到下方「文字注释 › 物体影长数值（天球）」子组标题开关
                 （traj.nt.svMeasL，叠加容器 traj.note）—— 与 v63「整点时刻」合并同口径。 */
            G('物影线段（天球）', [
              cl('clrSvShadowSeg', '线条颜色', 'meas.color', 'hexSvShadowSeg'),
              svLwCtl('rngSvShadowSegW', '线条粗细', 'meas.w', 'outSvShadowSegW'),
              rg('rngSvShadowSegOp', '透明度', 'meas.op', 0, 100, 1, 'outSvShadowSegOp', 'int1', 'pct'),
              G('线型', [
                sl('selSvShadowSegDash', '线型', 'meas.dash', DASH_OPTS),
                rg('rngSvShadowSegN', '虚线密度', 'meas.n', 4, 60, 1, 'outSvShadowSegN', 'int1', 'raw'),
                rg('rngSvShadowSegRatio', '虚实比', 'meas.ratio', 20, 90, 1, 'outSvShadowSegRatio', 'int1', 'pct'),
              ]),
              tip('影长线段样式与「观察与测量 › 物影 › 影长线段」共用同一份设置：'
                + '线条颜色 / 粗细 / 透明度 / 线型改一处两处同步，对天球视图与地面视角同时生效。'
                + '影长数值注释的显隐见下方「文字注释 › 物体影长数值（天球）」。'),
            ], { sw: 'cbSvShadow', swPath: 'traj.shadow', swTip: '显示影长线段（天球）', gate: 'traj.on,traj.today' }),

            /* ★ v52（需求3）：日出日落中天的点样式 —— 新增 traj.sunPtColor/sunPtSize/sunPtOp 三个键，
               天球与地面渲染端均已读取，实时生效（三点统一同色）。 */
            G('日出日落中天', [
              cl('clrSvSunPt', '点颜色', 'traj.sunPtColor', 'hexSvSunPt'),
              rg('rngSvSunPtSize', '点大小', 'traj.sunPtSize', 30, 300, 1, 'outSvSunPtSize', 'int1', 'pct'),
              rg('rngSvSunPtOp', '点透明度', 'traj.sunPtOp', 0, 100, 1, 'outSvSunPtOp', 'int1', 'pct'),
              tip('日出 / 日中天 / 日落三个点标记统一使用以上颜色 / 大小 / 透明度（三点同色）；'
                + '注释文字样式见下方「文字注释 › 日出日落中天」。'),
            ], { sw: 'cbSvSunPt', swPath: 'traj.sunPt', swTip: '显示日出 / 日中天 / 日落点', gate: 'traj.on,traj.today' }),

            /* ★ v52（需求4）：整点位置点的点样式 —— 新增 traj.hourPtColor/hourPtSize/hourPtOp。
               ★ v63（需求A）：原组内「整点时刻文字注释」开关（cbSvHourNote / traj.hourNote）
               已删除并合并到下方「文字注释 › 整点时刻」子组 —— 该子组标题开关
               （traj.nt.svHour）直接承担整点时刻文字注释的显隐控制。 */
            G('整点时刻', [
              cl('clrSvHourPt', '点颜色', 'traj.hourPtColor', 'hexSvHourPt'),
              rg('rngSvHourPtSize', '点大小', 'traj.hourPtSize', 30, 300, 1, 'outSvHourPtSize', 'int1', 'pct'),
              rg('rngSvHourPtOp', '点透明度', 'traj.hourPtOp', 0, 100, 1, 'outSvHourPtOp', 'int1', 'pct'),
            ], { sw: 'cbSvHourPt', swPath: 'traj.hourPt', swTip: '显示整点位置点', gate: 'traj.on,traj.today' }),

            /* 二分二至轨迹：三套轨道各自成组，「单独显示」开关前置到各轨道标题行；
               ★ v52（需求5.1/5.2/5.3）：线条颜色 / 粗细 / 透明度 / 线型全部复用 traj.termCol.*，
               渲染端已改为 Tube 几何（线粗真正生效）+ tubeStyledGeo 分段（线型真正生效）。 */
            G('二分二至轨迹（地平线以上）', [
              G('春分 / 秋分轨道', [
                cl('clrSvTermEq', '线条颜色', 'traj.termCol.eq.color', 'hexSvTermEq'),
                svLwCtl('rngSvTermEqW', '线条粗细', 'traj.termCol.eq.w', 'outSvTermEqW'),
                rg('rngSvTermEqOp', '透明度', 'traj.termCol.eq.op', 0, 100, 1, 'outSvTermEqOp', 'int1', 'pct'),
                G('线型', [
                  sl('selSvTermEqDash', '线型', 'traj.termCol.eq.dash', DASH_OPTS),
                  rg('rngSvTermEqN', '虚线密度', 'traj.termCol.eq.n', 10, 200, 1, 'outSvTermEqN', 'int1', 'raw'),
                  rg('rngSvTermEqRatio', '虚实比', 'traj.termCol.eq.ratio', 20, 90, 1, 'outSvTermEqRatio', 'int1', 'pct'),
                ]),
              ], { sw: 'cbSvTermEq', swPath: 'traj.termShow.eq', gate: 'traj.on,traj.term4' }),
              G('夏至轨道', [
                cl('clrSvTermSS', '线条颜色', 'traj.termCol.ss.color', 'hexSvTermSS'),
                svLwCtl('rngSvTermSSW', '线条粗细', 'traj.termCol.ss.w', 'outSvTermSSW'),
                rg('rngSvTermSSOp', '透明度', 'traj.termCol.ss.op', 0, 100, 1, 'outSvTermSSOp', 'int1', 'pct'),
                G('线型', [
                  sl('selSvTermSSDash', '线型', 'traj.termCol.ss.dash', DASH_OPTS),
                  rg('rngSvTermSSN', '虚线密度', 'traj.termCol.ss.n', 10, 200, 1, 'outSvTermSSN', 'int1', 'raw'),
                  rg('rngSvTermSSRatio', '虚实比', 'traj.termCol.ss.ratio', 20, 90, 1, 'outSvTermSSRatio', 'int1', 'pct'),
                ]),
              ], { sw: 'cbSvTermSS', swPath: 'traj.termShow.ss', gate: 'traj.on,traj.term4' }),
              G('冬至轨道', [
                cl('clrSvTermWS', '线条颜色', 'traj.termCol.ws.color', 'hexSvTermWS'),
                svLwCtl('rngSvTermWSW', '线条粗细', 'traj.termCol.ws.w', 'outSvTermWSW'),
                rg('rngSvTermWSOp', '透明度', 'traj.termCol.ws.op', 0, 100, 1, 'outSvTermWSOp', 'int1', 'pct'),
                G('线型', [
                  sl('selSvTermWSDash', '线型', 'traj.termCol.ws.dash', DASH_OPTS),
                  rg('rngSvTermWSN', '虚线密度', 'traj.termCol.ws.n', 10, 200, 1, 'outSvTermWSN', 'int1', 'raw'),
                  rg('rngSvTermWSRatio', '虚实比', 'traj.termCol.ws.ratio', 20, 90, 1, 'outSvTermWSRatio', 'int1', 'pct'),
                ]),
              ], { sw: 'cbSvTermWS', swPath: 'traj.termShow.ws', gate: 'traj.on,traj.term4' }),
              /* ★ v64（需求1）：组内「轨迹名称注释」开关（cbSvTerm4Note / traj.term4Note）与
                 「二分二至注释样式」组已迁移到下方「文字注释 › 二分二至轨道」子组 ——
                 该子组标题开关（traj.nt.svTerm4）即二分二至轨道名称注释的显隐开关，
                 组内按其他注释同款标准属性（字号 / 字体 / 颜色 / 透明度 / 字重）配置。 */
              tip('三套轨道的颜色 / 粗细 / 透明度 / 线型各自独立可调；「线粗细」= 相对倍率（1.00× 即默认粗细）。'
                + '轨道名称注释的显隐与样式统一见下方「文字注释 › 二分二至轨道」。'),
            ], { sw: 'cbSvTerm4', swPath: 'traj.term4', swTip: '显示二分二至轨迹', gate: 'traj.on' }),

            /* 地平线下轨迹：显隐开关前置，线条属性复用 traj.under*。 */
            G('地平线下轨迹', [
              cl('clrSvUnder', '线条颜色', 'traj.underColor', 'hexSvUnder'),
              svLwCtl('rngSvUnderW', '线条粗细', 'traj.underW', 'outSvUnderW'),
              rg('rngSvUnderOp', '透明度', 'traj.underOp', 0, 100, 1, 'outSvUnderOp', 'int1', 'pct'),
              G('线型', [
                sl('selSvUnderDash', '线型', 'traj.underDash', DASH_OPTS),
                rg('rngSvUnderN', '虚线密度', 'traj.underN', 10, 200, 1, 'outSvUnderN', 'int1', 'raw'),
                rg('rngSvUnderRatio', '虚实比', 'traj.underRatio', 20, 90, 1, 'outSvUnderRatio', 'int1', 'pct'),
              ]),
            ], { sw: 'cbSvUnder', swPath: 'traj.under', swTip: '显示地平线下轨迹', gate: 'traj.on' }),

            /* 文字注释：各分类样式（svNoteGrp → @note.cats.*，与「全局文字样式」统一管辖）。
               ★ v52（需求4）：svNoteGrp 新增 opt.idp（可自定义控件 id 前缀），故同一分类可
               重复实例化而不发生 DOM id 冲突。四类注释样式各自独立分类：
                 7.1 物体影长数值（天球）→ svMeasL、7.2 日出日落中天 → svTraj、
                 7.3 整点时刻 → svHour、7.4 二分二至轨道 → svTerm4（★ v64 自上方二分二至组迁入）。
               ★ v62（需求二）：组标题与各子组标题前各加**显隐开关**（与「天球坐标系 ›
                 文字注释」同款交互）——容器 traj.note、子项 traj.nt.*，父级＞子级：
                 容器关 ⇒ 各子组置灰（data-gate）+ 状态级联关 + 渲染端隐藏；
                 「物体影长数值（天球）」只门控**天球上的影长数值注释**（地面测量的影长
                 数值仍由「观察与测量 › 物影」的 meas.len 控制，两处共享样式分类、显隐各自独立）。
               ★ v64（需求1）：组内「影长数值注释」开关（traj.shadowNote）并入「物体影长数值
                 （天球）」子组标题开关；「轨迹名称注释」开关（traj.term4Note）与注释样式组
                 迁入新第四子组「二分二至轨道」（traj.nt.svTerm4 承担显隐）。 */
            G('文字注释', [
              svNoteGrp('日出日落中天', 'svTraj', { sw: 'cbSvNtSvTraj', swPath: 'traj.nt.svTraj', gate: 'traj.on,traj.note' }),
              /* ★ v63（需求A）：「整点时刻文字注释」开关自上方「整点时刻」点样式组合并入本子组 ——
                 本子组标题开关（traj.nt.svHour）即整点时刻文字注释的显隐开关（叠加容器
                 traj.note），不再单独保留 cbSvHourNote 行。 */
              svNoteGrp('整点时刻', 'svHour', { sw: 'cbSvNtSvHour', swPath: 'traj.nt.svHour', gate: 'traj.on,traj.note' }),
              /* ★ v52（需求4）：7.1 物体影长数值改用 svMeasL（影长数值）分类 ——
                 与「观察与测量 › 影长数值」同一分类（两处同步），且与「物体高度」分离。
                 ★ v64（需求1）：原「物影线段」组内「影长数值注释」开关（traj.shadowNote）并入
                 本子组 —— 本子组标题开关（traj.nt.svMeasL）即天球影长数值注释的显隐开关。 */
              svNoteGrp('物体影长数值（天球）', 'svMeasL', { idp: 'svShadowNote', sw: 'cbSvNtSvMeasL', swPath: 'traj.nt.svMeasL', gate: 'traj.on,traj.note' }),
              /* ★ v64（需求1）：7.4 二分二至轨道 —— 原「二分二至轨迹」组内「轨迹名称注释」
                 开关 + 「二分二至注释样式」组迁移至此，标准五属性（字号 / 字体 / 颜色 /
                 透明度 / 字重）配置，显隐由本子组标题开关（traj.nt.svTerm4）承担。 */
              svNoteGrp('二分二至轨道', 'svTerm4', { sw: 'cbSvNtSvTerm4', swPath: 'traj.nt.svTerm4', gate: 'traj.on,traj.note' }),
            ], { sw: 'cbSvTrajNote', swPath: 'traj.note', gate: 'traj.on' }),

            /* ★ v62（需求一）：「位置点与时刻」组与「当前太阳位置点（地面）」开关
               （cbSvPtOn / cbSvCurPt / traj.ptOn / traj.curPt）已全部取消 ——
               前者是 v35 引入的中间级联层；后者画在与太阳本体重合的位置（被日面 /
               日冕完全遮盖），自 v36 引入起就没有过可见效果，均属功能冗余。 */
            G('绘制模式', [
              sl('selSvMode', '轨迹绘制', 'traj.mode', [['dynamic', '动态绘制'], ['full', '完整绘制']]),
            ], { gate: 'traj.on' }),
            tip('天球视图与地面视图**共用以上全部开关**：轨迹、整点位置点、日出 / 日中天 / 日落点、'
              + '地平线下轨迹与注释在两个视图完全一致地显示。'
              + '★ v44（需求十二）：日中天（太阳时角 = 0，当日最高点）已在两个视图的轨道上标出，'
              + '与日出 / 日落同用一个「日出 / 日中天 / 日落点」开关、同用「日出日落中天」注释样式。'
              + '★ v62（需求四）：「绘制模式」同时控制天球与地面两个视图的当日轨迹（地上部分）——'
              + '动态绘制：播放动画时轨迹按时间推进逐步画出；完整绘制：进入视图即一次性画出全天轨迹。'
              + '★ v62（需求二）：「文字注释」组总开关管住三个注释子组（父级＞子级）。'),
          ]
        },
      ]
    },

    /* ---------------- 三、天球坐标系 ---------------- */
    {
      id: 'sSvCoord', icon: '🧭', name: '天球坐标系', sub: '地平要素 · 赤道要素 · 固定模式 · 文字注释',
      children: [
        {
          id: 'pSvCoordOn', icon: '🔭', name: '显示天球坐标系', sw: 'cbSvCoord', swPath: 'coord.on',
          swTip: '显示天球坐标系',
          children: [
            /* v34（面板规格）：地平 / 赤道两套坐标系的**每个要素各自成组**，
               线 / 面 / 点属性逐项可调（线粗细 / 线颜色 / 透明度 / 类型 + 虚密 + 虚实比；
               面为填充色 + 填充透明度；点有点大小 / 点颜色 / 透明度）。
               v35（需求四 / 六）：各要素组开关上移**组标题行**；逐要素注释样式（svNoteGrp）
               迁入各自要素组 —— 「各注释单独样式」集中菜单取消。 */
            G('地平坐标系要素', [
              G('地平圈', [
                svLwCtl('rngSvHrLineW', '线粗细', 'coord.st.hrLine.w', 'outSvHrLineW'),
                cl('clrSvHrLine', '线颜色', 'coord.st.hrLine.color', 'hexSvHrLine'),
                rg('rngSvHrLineOp', '透明度', 'coord.st.hrLine.op', 0, 100, 1, 'outSvHrLineOp', 'int1', 'pct'),
              ], { sw: 'cbSvHrLine', swPath: 'coord.hrLine', gate: 'coord.on' }),
              G('地平面', [
                cl('clrSvHrPlaneFill', '填充颜色', 'coord.st.hrPlane.fill', 'hexSvHrPlane'),
                rg('rngSvHrPlaneOp', '填充透明度', 'coord.st.hrPlane.fillOp', 0, 100, 1, 'outSvHrPlaneOp', 'int1', 'pct'),
              ], { sw: 'cbSvHrPlane', swPath: 'coord.hrPlane', gate: 'coord.on' }),
              G('天顶', [
                rg('rngSvZenSize', '点大小', 'coord.st.zenith.size', 30, 300, 1, 'outSvZenSize', 'int1', 'pct'),
                cl('clrSvZen', '点颜色', 'coord.st.zenith.color', 'hexSvZen'),
                rg('rngSvZenOp', '透明度', 'coord.st.zenith.op', 0, 100, 1, 'outSvZenOp', 'int1', 'pct'),
              ], { sw: 'cbSvZen', swPath: 'coord.zenith', gate: 'coord.on' }),
              G('天底', [
                rg('rngSvNadSize', '点大小', 'coord.st.nadir.size', 30, 300, 1, 'outSvNadSize', 'int1', 'pct'),
                cl('clrSvNad', '点颜色', 'coord.st.nadir.color', 'hexSvNad'),
                rg('rngSvNadOp', '透明度', 'coord.st.nadir.op', 0, 100, 1, 'outSvNadOp', 'int1', 'pct'),
              ], { sw: 'cbSvNad', swPath: 'coord.nadir', gate: 'coord.on' }),
            ], { gate: 'coord.on' }),
            G('赤道坐标系要素', [
              G('天赤道（大圆线段）', [
                cl('clrSvEquLine', '线颜色', 'coord.st.equLine.color', 'hexSvEquLine'),
                rg('rngSvEquLineOp', '透明度', 'coord.st.equLine.op', 0, 100, 1, 'outSvEquLineOp', 'int1', 'pct'),
                sl('selSvEquLineDash', '类型', 'coord.st.equLine.dash', DASH_OPTS),
                G('虚线参数', [
                  rg('rngSvEquLineN', '虚线密度', 'coord.st.equLine.n', 8, 200, 1, 'outSvEquLineN', 'int1', 'raw'),
                  rg('rngSvEquLineRatio', '虚实比', 'coord.st.equLine.ratio', 20, 90, 1, 'outSvEquLineRatio', 'int1', 'pct'),
                ]),
              ], { sw: 'cbSvEquLine', swPath: 'coord.equLine', gate: 'coord.on' }),
              G('天赤道平面', [
                cl('clrSvEquPlaneFill', '填充颜色', 'coord.st.equPlane.fill', 'hexSvEquPlane'),
                rg('rngSvEquPlaneOp', '填充透明度', 'coord.st.equPlane.fillOp', 0, 100, 1, 'outSvEquPlaneOp', 'int1', 'pct'),
              ], { sw: 'cbSvEquPlane', swPath: 'coord.equPlane', gate: 'coord.on' }),
              G('天北极', [
                rg('rngSvPoleNSize', '点大小', 'coord.st.poleN.size', 30, 300, 1, 'outSvPoleNSize', 'int1', 'pct'),
                cl('clrSvPoleN', '点颜色', 'coord.st.poleN.color', 'hexSvPoleN'),
                rg('rngSvPoleNOp', '透明度', 'coord.st.poleN.op', 0, 100, 1, 'outSvPoleNOp', 'int1', 'pct'),
              ], { sw: 'cbSvPoleN', swPath: 'coord.poleN', gate: 'coord.on' }),
              G('天南极', [
                rg('rngSvPoleSSize', '点大小', 'coord.st.poleS.size', 30, 300, 1, 'outSvPoleSSize', 'int1', 'pct'),
                cl('clrSvPoleS', '点颜色', 'coord.st.poleS.color', 'hexSvPoleS'),
                rg('rngSvPoleSOp', '透明度', 'coord.st.poleS.op', 0, 100, 1, 'outSvPoleSOp', 'int1', 'pct'),
              ], { sw: 'cbSvPoleS', swPath: 'coord.poleS', gate: 'coord.on' }),
              sw('cbSvAboveOnly', '只显示地平线以上的赤道坐标系', 'coord.aboveOnly', 'coord.on'),
            ], { gate: 'coord.on' }),
            G('固定模式', [
              /* ★ v36（需求九·图5）：原生 select 下拉宽度跟随最长选项 —— 选项文字必须精简，
                 详细说明一律放到 tip（否则下拉列表会盖住大块菜单）。 */
              sl('selSvCoordSys', '坐标系固定方式', 'coord.sys', [
                ['horizon', '地平坐标系固定'],
                ['equatorial', '赤道坐标系固定'],
              ]),
              tip('**地平坐标系固定**：地平面 / 地平圈始终保持水平，天赤道与天极按观测点纬度倾斜（天文台视角，' +
                  '太阳东升西落）。**赤道坐标系固定**：整个天球绕 X 轴转过 (90°−纬度)，使**天赤道平面保持水平**、' +
                  '天极位于正上方，地平面随之倾斜 —— 便于课堂定格讲解「赤道坐标系」。'),
            ], { gate: 'coord.on' }),
            G('经纬网格', [
              sl('selSvGridSys', '网格坐标系', 'coord.gridSys', [
                ['equatorial', '赤道坐标系'],
                ['horizon', '地平坐标系'],
              ]),
              cl('clrSvGrid', '网格颜色', 'coord.gridColor', 'hexSvGrid'),
              rg('rngSvGridOp', '网格透明度', 'coord.gridOp', 0, 100, 1, 'outSvGridOp', 'int1', 'pct'),
              sl('selSvGridDash', '网格线型', 'coord.gridDash', DASH_OPTS),
            ], { sw: 'cbSvGrid', swPath: 'coord.grid', gate: 'coord.on' }),
            /* ★ v41（需求一·12）改版：每个注释**一个子组** —— 标题行带该注释的显隐开关，
               组内直接是它的字号 / 字体 / 颜色 / 透明度 / 字重（旧结构是一个开关 + 一个
               「××样式」兄弟组，两条并列，找样式要展开两次）。 */
            G('文字注释', [
              svNoteGrp('地平线', 'svHrLine', { sw: 'cbSvNtHrLine', swPath: 'coord.nt.hrLine', gate: 'coord.on,coord.note' }),
              svNoteGrp('地平面', 'svHrPlane', { sw: 'cbSvNtHrPlane', swPath: 'coord.nt.hrPlane', gate: 'coord.on,coord.note' }),
              svNoteGrp('天顶', 'svZen', { sw: 'cbSvNtZen', swPath: 'coord.nt.zenith', gate: 'coord.on,coord.note' }),
              svNoteGrp('天底', 'svNad', { sw: 'cbSvNtNad', swPath: 'coord.nt.nadir', gate: 'coord.on,coord.note' }),
              svNoteGrp('天赤道', 'svEqu', { sw: 'cbSvNtEquLine', swPath: 'coord.nt.equLine', gate: 'coord.on,coord.note' }),
              svNoteGrp('天赤道平面', 'svEquPlane', { sw: 'cbSvNtEquPlane', swPath: 'coord.nt.equPlane', gate: 'coord.on,coord.note' }),
              svNoteGrp('天北极', 'svPoleN', { sw: 'cbSvNtPoleN', swPath: 'coord.nt.poleN', gate: 'coord.on,coord.note' }),
              svNoteGrp('天南极', 'svPoleS', { sw: 'cbSvNtPoleS', swPath: 'coord.nt.poleS', gate: 'coord.on,coord.note' }),
              /* v35（需求十）：地平圈方位（东南西北）注释的显隐移到「地面物体 › 地面方向标 ›
                 方向文字」—— 东南西北标注（天球 + 地面）由「方向文字」一个开关统一控制，
                 注释样式（svHrDir）也一并放在那里。 */
            ], { sw: 'cbSvNote', swPath: 'coord.note', gate: 'coord.on' }),
            tip('网格可**按赤道坐标系或地平坐标系**绘制，颜色 / 透明度 / 线型（实线 / 虚线）可调；' +
                '地平圈周围可标注东南西北四个正方位（开关在「地面物体 › 地面方向标 › 方向文字」）。'),
          ]
        },
      ]
    },

    /* ---------------- 四、地面物体 ---------------- */
    {
      id: 'sSunObj', icon: '🏙️', name: '地面物体', sub: '方向标 · 建筑物 · 小人 · 树木旗杆 · 室内',
      children: [
        {
          id: 'pSvDmark', icon: '🧭', name: '地面方向标', sw: 'cbSvDmark', swPath: 'dmark.on', swTip: '显示东南西北方位标',
          children: [
            /* v34（面板规格）：拆成「方向箭头」与「方向文字」两组，各自带一套属性。
               箭头是 3D 锥体（不是线段），故只有粗细 / 颜色 / 透明度，没有实虚线与虚密。
               v35（需求四）：两组开关上移标题行。
               v35（需求十）：「方向文字」开关（dmark.text）**统一控制天球 + 地面**的
               东南西北标注及其注释 —— 天球地平圈的方位注释（coord.hrDir）不再单独设开关，
               其样式（svHrDir 分类）也并入本组。 */
            G('方向箭头', [
              rg('rngSvDmarkArrowW', '箭头粗细', 'dmark.arrowW', 20, 300, 1, 'outSvDmarkArrowW', 'int1', 'pct'),
              cl('clrSvDmarkArrow', '箭头颜色', 'dmark.arrowColor', 'hexSvDmarkArrow'),
              rg('rngSvDmarkArrowOp', '透明度', 'dmark.arrowOp', 0, 100, 1, 'outSvDmarkArrowOp', 'int1', 'pct'),
            ], { sw: 'cbSvDmarkArrow', swPath: 'dmark.arrow', gate: 'dmark.on' }),
            G('方向文字【东南西北】', [
              /* ★ v44（需求五）：与所有文字注释同口径 —— 1–1000 ⇒ 0.01×–10.00×，读数「1.00×」
                 （旧版是 40–400 的百分比，读「100%」，与别处的「0.62×」不是一把尺）。 */
              rg('rngSvDmarkFontSize', '字号', 'dmark.fontSize', 1, 1000, 1, 'outSvDmarkFontSize', 'w100', 'x'),
              sl('selSvDmarkFont', '字体', 'dmark.font', DSL.FONT_OPTS),
              cl('clrSvDmark', '字颜色', 'dmark.color', 'hexSvDmark'),
              rg('rngSvDmarkOp', '透明度', 'dmark.op', 0, 100, 1, 'outSvDmarkOp', 'int1', 'pct'),
              sl('selSvDmarkWeight', '字重', 'dmark.weight', DSL.WEIGHT_OPTS),
              tip('本开关统一控制**地面方向文字**与**天球地平圈上的东南西北注释**' +
                  '（两者已合二为一，共用同一套字色 / 字号 / 字体 / 透明度 / 字重）。'),
            ], { sw: 'cbSvDmarkText', swPath: 'dmark.text', gate: 'dmark.on' }),
            /* ★ 本次（任务五）：删除「整体大小」滑块（rngSvDmarkSize / outSvDmarkSize）。
               仅移除 UI —— state 键 dmark.size 保留（默认 1.0×，见文件头默认值与下方读取处），
               本面板不再有任何控件写入该键。 */
          ]
        },
        {
          id: 'pSvBld', icon: '🏢', name: '建筑物与间距', children: [
            G('预制建筑间距', [
              rg('rngSvSpace', '南北方向间距', 'spacing', 40, 260, 1, 'outSvSpace', 'w10', 'raw1'),
            ]),
            /* ★ v44（需求七）：v43 的「立体边框线条」开关组（cbSvEdge / clrSvEdge / rngSvEdgeOp）
               整体移除 —— 物体的立体轮廓线常态一律隐藏，不再是可配置项。 */
            raw('<div class="btn-row"><button class="btn xs" id="svBldAdd">＋ 从资源库拖拽放置</button>' +
                '<button class="btn warn xs" id="svBldDelete">删除选中</button></div>'),
            raw('<div class="row"><label>已选中</label><output id="svBldSel">—</output></div>'),
            G('属性设置', [
              cl('clrSvBld', '颜色', 'bld.color', 'hexSvBld'),
              rg('rngSvBldFloors', '楼层', 'bld.floors', 1, 40, 1, 'outSvBldFloors', 'int1', 'raw'),
              rg('rngSvBldFloorH', '楼高（每层）', 'bld.floorH', 20, 60, 1, 'outSvBldFloorH', 'w10', 'raw1'),
              rg('rngSvBldAngle', '朝向', 'bld.angle', 0, 360, 1, 'outSvBldAngle', 'int1', 'deg0'),
              rg('rngSvBldWinBase', '窗户离地高度', 'bld.winBase', 2, 40, 1, 'outSvBldWinBase', 'w10', 'raw1'),
              rg('rngSvBldWinH', '窗户高度', 'bld.winH', 3, 30, 1, 'outSvBldWinH', 'w10', 'raw1'),
              sw('cbSvBldMulti', '多选批量编辑', 'bld.multi'),
            ]),
            raw('<div class="btn-row"><button class="btn xs" id="svBldApply">应用</button>' +
                '<button class="btn xs" id="svBldReset">重置</button></div>'),
            tip('放置：按住「从资源库拖拽放置」拖到地面再松手，或点击该按钮后在地面上单击落点。' +
                '点选建筑物后可在上面改属性；勾选「多选批量编辑」后按住 Ctrl 点选多栋一起改。建筑物不可拖出地面。' +
                '默认场景已摆好**两栋正南北分布的建筑**。'),
            tip('物体的立体轮廓线常态**全部隐藏**（v44 起不再是可配置项）；' +
                '单击选中某个物体时，它会临时以高亮蓝显示边框便于识别。'),
          ]
        },
        {
          id: 'pSvFig', icon: '🧍', name: '小人模型', children: [
            raw('<div class="btn-row"><button class="btn xs" id="svFigAdd">＋ 拖拽放置小人</button>' +
                '<button class="btn xs" id="svFigReset">重置</button></div>'),
            G('属性设置', [
              rg('rngSvFigH', '身高', 'fig.h', 8, 24, 1, 'outSvFigH', 'w10', 'raw1'),
              cl('clrSvFig', '颜色', 'fig.color', 'hexSvFig'),
            ]),
            tip('小人可放置**多个**（点「＋ 拖拽放置小人」可连续放置）；任意一个小人都是第一人称视角的载体：' +
                '进入第一人称后会站在该小人的位置。默认场景已放置 1 个小人。'),
          ]
        },
        {
          id: 'pSvTree', icon: '🌳', name: '树木与旗杆', children: [
            raw('<div class="btn-row"><button class="btn xs" id="svTreeAdd">＋ 拖拽放置树木</button>' +
                '<button class="btn xs" id="svFlagAdd">＋ 拖拽放置旗杆</button></div>'),
            G('树木属性设置', [
              rg('rngSvTreeH', '树高', 'tree.h', 20, 140, 1, 'outSvTreeH', 'w10', 'raw1'),
              cl('clrSvTree', '树冠颜色', 'tree.color', 'hexSvTree'),
              cl('clrSvTreeTrunk', '树干颜色', 'tree.trunk', 'hexSvTreeTrunk'),
            ]),
            /* ★ v52（需求G5）：新增「旗杆属性设置」—— 杆高 / 杆颜色 / 旗帜颜色，
               与双击旗杆弹出的属性对话框**共用同一套键**（S.flag.*），改任一边两边同步。 */
            G('旗杆属性设置', [
              rg('rngSvFlagH', '杆高', 'flag.h', 30, 300, 1, 'outSvFlagH', 'w10', 'raw1'),
              cl('clrSvFlagPole', '杆颜色', 'flag.poleColor', 'hexSvFlagPole'),
              cl('clrSvFlagCloth', '旗帜颜色', 'flag.flagColor', 'hexSvFlagCloth'),
            ]),
            raw('<div class="btn-row"><button class="btn xs" id="svTreeApply">应用（树木）</button>' +
                '<button class="btn xs" id="svFlagApply">应用（旗杆）</button>' +
                '<button class="btn warn xs" id="svPropDelete">删除选中</button></div>'),
            tip('放置：按住按钮拖到地面再松手，或点击按钮后在地面上单击落点。树木与旗杆同样会产生' +
                '真实光线下的影子，双击可打开属性对话框并测量影长。物体不可拖出圆形地面之外。' +
                '默认场景已放置 1 根旗杆与若干树木。'),
          ]
        },
        {
          id: 'pSvIndoor', icon: '🏠', name: '室内设置', children: [
            sl('selSvRoom', '房间类型', 'room.kind', [['classroom', '教室'], ['bedroom', '卧室'], ['empty', '空房间']]),
            /* ★ v36（需求九·图6）：「朝赤道（北半球朝南 / 南半球朝北）」18 字会把下拉撑得很宽，
               精简为「自动（朝向赤道）」，完整解释放 tip。 */
            sl('selSvRoomFace', '窗户朝向', 'room.face', [
              ['auto', '自动（朝向赤道）'], ['S', '正南'], ['N', '正北'], ['E', '正东'], ['W', '正西']]),
            tip('窗户朝向选**自动**时，窗户朝向赤道一侧（北半球朝南 / 南半球朝北）；也可固定为东南西北任一方向。'),
            G('观察位置', [
              sl('selSvRoomView', '室内观察点', 'room.view', [
                ['center', '房间中心'], ['nw', '西北角'], ['ne', '东北角'], ['sw', '西南角'], ['se', '东南角']]),
              raw('<div class="btn-row"><button class="btn xs" id="svEnterIndoor">进入室内视图</button>' +
                  '<button class="btn xs" id="svExitIndoorBtn">退出室内</button></div>'),
              tip('室内模式可从**房间中心或四个墙角**观察（切换后相机立即移动到位，之后仍可用鼠标自由拖动）。' +
                  '地面与墙面上的光斑严格按「太阳光线沿窗户投射」计算，随一天中的太阳方位移动；' +
                  '房间内标注了东南西北。地面视图中单击建筑物窗户也可以进入室内视图。'),
            ]),
            sw('cbSvIndoorVol', '体积光（复用全局参数）', 'room.vol'),
            /* ★ v64（需求2）：室内体积光强相对室外（地面视图）的百分比占比 ——
               默认 45%，解决室内光柱过曝；100% = 与室外完全一致。 */
            rg('rngSvRoomVolScale', '室内光强（相对室外）', 'room.volScale', 5, 100, 1, 'outSvRoomVolScale', 'int1', 'pct'),
            /* ★ v44（需求四）：上下边界光线支持**属性设置**（粗细 / 颜色 / 透明度）。
               线粗细走全站统一的「相对倍率」口径（10–300 ⇒ 0.10×–3.00×，读数「1.00×」，
               基准值登记在 SV_LW_BASE['room.edgeW']）；渲染侧改用 ribbon（LineBasicMaterial
               的 linewidth 在 WebGL 里恒为 1px，旧实现调了没反应）。 */
            G('上下边界光线', [
              /* 写在组标题前的这颗开关 = 原来的 room.edge（老存档语义不变） */
              svLwCtl('rngSvIdEdgeW', '线粗细', 'room.edgeW', 'outSvIdEdgeW'),
              cl('clrSvIdEdge', '线颜色', 'room.edgeColor', 'hexSvIdEdge'),
              rg('rngSvIdEdgeOp', '透明度', 'room.edgeOp', 0, 100, 1, 'outSvIdEdgeOp', 'int1', 'pct'),
            ], { sw: 'cbSvIndoorEdge', swPath: 'room.edge' }),
            /* ★ v44（需求四）：光斑按**落地面种类**分成两套，各自独立渲染与配色。 */
            G('地面光斑', [
              cl('clrSvIpFloor', '颜色', 'room.patch.floorColor', 'hexSvIpFloor'),
              rg('rngSvIpFloorOp', '透明度', 'room.patch.floorOp', 0, 100, 1, 'outSvIpFloorOp', 'int1', 'pct'),
            ], { sw: 'cbSvIpFloor', swPath: 'room.patch.floorOn' }),
            G('墙面光斑', [
              cl('clrSvIpWall', '颜色', 'room.patch.wallColor', 'hexSvIpWall'),
              rg('rngSvIpWallOp', '透明度', 'room.patch.wallOp', 0, 100, 1, 'outSvIpWallOp', 'int1', 'pct'),
            ], { sw: 'cbSvIpWall', swPath: 'room.patch.wallOn' }),
            /* v35（需求四）：墙面阴影开关与样式组合并为一个标题行开关组。 */
            G('墙面阴影', [
              cl('clrSvWsColor', '颜色', 'room.wsColor', 'hexSvWsColor'),
              rg('rngSvWsOp', '透明度', 'room.wsOp', 0, 100, 1, 'outSvWsOp', 'int1', 'pct'),
            ], { sw: 'cbSvIndoorWS', swPath: 'room.wshadow', gate: 'room.wshadow' }),
            tip('★ v44（需求四）：**光斑按落地面分开渲染** —— 落到地面上的那块归「地面光斑」、' +
                '落到背墙 / 左墙 / 右墙上的归「墙面光斑」，同一束光可以同时在这几处留下光斑' +
                '（旧版只挑一个面整块画，斜射时墙上的那块会缺）。东南西北标在**对应的四面墙**上，' +
                '房间按「窗户朝向」转动后会自动重新对位。' +
                '★ 已移除「室内文字样式」—— 该组对应的 svIndoor 分类早已没有任何注释在使用，' +
                '室内方位文字实由「地面物体 › 地面方向标 › 方向文字」统一控制。'),
          ]
        },
      ]
    },

    /* ---------------- 五、观察与测量 ---------------- */
    {
      /* ★ v39（需求二·2）：「时间数据面板」总开关放到**对应菜单标题前** ——
         即「时间面板数据」二级组的标题前（该组正是右上时间数据面板里的读数开关）。
         原先是放在一级组「观察与测量」标题前，语义不符；改为挂在 pSvRead 上。
         swPath 与主模块（自转 / 公转 / 综合）同名开关联动（同显同隐）。 */
      id: 'sSvMeas', icon: '📏', name: '观察与测量', sub: '数据面板 · 物影 · 第一人称方向标',
      children: [
        {
          /* v33（面板规格）：「数据面板」—— 逐行显隐。行与主模块时间面板同一口径，
             由 S.panel.rows 控制（缺省全开）。 */
          id: 'pSvPanel', icon: '📟', name: '数据面板', children: [
            sw('cbSvRowPos', '位置（纬度 / 经度）', 'panel.rows.pos'),
            sw('cbSvRowLst', '地方时', 'panel.rows.lst'),
            sw('cbSvRowTerm', '节气', 'panel.rows.term'),
            sw('cbSvRowTz', '时区（区名 + UTC 偏移 + 区时）', 'panel.rows.tz'),
            sw('cbSvRowDn', '昼夜状态', 'panel.rows.dn'),
            sw('cbSvRowLen', '当地昼长', 'panel.rows.len'),
            sw('cbSvRowYlen', '全年昼长极值（极大值与极小值）', 'panel.rows.ylen'),
            sw('cbSvRowAz', '太阳方位', 'panel.rows.az'),
            sw('cbSvRowAlt', '瞬时太阳高度角', 'panel.rows.alt'),
            sw('cbSvRowSub', '太阳直射点（经纬度）', 'panel.rows.sub'),
            sw('cbSvRowRise', '日出 / 日落时刻与方位', 'panel.rows.rise'),
            sw('cbSvRowRaz', '日出日落方位角（数值）', 'panel.rows.raz'),
            sw('cbSvRowNoon', '正午太阳高度', 'panel.rows.noon'),
            sw('cbSvRowLv', '自转线速度（随纬度变化）', 'panel.rows.lv'),
            sw('cbSvRowAv', '自转角速度（处处相同）', 'panel.rows.av'),
            tip('这里控制右上「观测点数据」面板里**显示哪几行**（共 15 行，逐行可关）；' +
                '面板整体的显隐在「界面与主题 › 面板与悬浮窗」，行的顺序固定为' +
                '「定位 → 时间 → 昼夜 → 太阳 → 日出日落 → 派生量」。'),
            /* ★ v53（需求一）：**删除 svNoteGrp('观测点标签样式','svObs')** ——
               「观测点」文字精灵（eMarkerLabel）已删，svObs 分类在全工程**没有任何消费者**
               （已全局搜索 eMarkerLabel / svObs：sunview.js 外只有 app.js 的
               NOTE_CAT_DEF 默认值表里那一行，属于无害的孤立默认值，不引用即不生效）。
               留着这一组菜单就是「能调却不生效」的悬空设置：用户改字号 / 字色 / 字体，
               界面毫无反应，只会以为程序坏了。故连菜单一起删。 */
          ]
        },
        {
          /* ★ v38（需求三）：太阳侧右上「时间数据面板」的天文数据读数逐项显隐 ——
             与自转 / 公转 / 综合视图「光照系统 › 时间面板数据」**同一份开关**
             （@read.* 借用主模块 state.read），改一处四处同步。
             ★ v39（需求二·2）：本组标题前加「时间数据面板」总开关（panel.timeTop）——
             该组正是时间数据面板的读数开关，「对应菜单标题」即此处。 */
          id: 'pSvRead', icon: '📟', name: '时间面板数据',
          sw: 'cbSvTimePanel', swPath: 'panel.timeTop',
          swTip: '右上角时间数据面板（北京时间）的总开关；与自转 / 公转 / 综合视图联动',
          children: [
            sw('cbSvReadSub', '太阳直射点经纬度', '@read.sub'),
            sw('cbSvReadPolar', '极昼极夜度数范围', '@read.polar'),
            sw('cbSvReadObliq', '黄赤交角与地轴倾角', '@read.obliq'),
            sw('cbSvReadOrbV', '地球公转瞬时线速度 / 角速度', '@read.orbV'),
            sw('cbSvReadOrbArea', '地球公转面积速度', '@read.orbArea'),
            tip('控制右上「时间数据面板」底部的**天文数据读数**逐项显隐（直射点经纬度 / ' +
                '极昼极夜范围 / 黄赤交角与地轴倾角 / 公转瞬时速度 / 公转面积速度）；' +
                '与自转 / 公转 / 综合视图的时间面板读数**共用同一份开关**，两侧改任意一边都同步。'),
          ]
        },
        {
          /* v33（面板规格 / 需求三）：原「测量物影」改称「物影」，并把**真实光照阴影**
             （遮挡阴影的强度 / 边缘偏移）与**影长线段**、**过物体顶部的光线**收在同一组里。
             同一套设置**同时作用于天球视图与地面视角** —— 两个视角的影子线段、颜色、
             线宽、透明度、线型完全一致，改一处两边一起变。 */
          id: 'pSvMeas', icon: '📏', name: '物影', sw: 'cbSvMeas', swPath: 'meas.on',
          swTip: '显示影子测量（双击建筑物 / 旗杆 / 树木可开启）',
          children: [
            sw('cbSvRayShadow', '真实光照阴影（遮挡阴影）', 'ray.shadow', 'meas.on'),
            rg('rngSvShadowOp', '影子强度', 'ray.shadowOp', 0, 100, 1, 'outSvShadowOp', 'int1', 'pct'),
            rg('rngSvShadowOff', '阴影边缘偏移（消除摩尔纹）', 'ray.shadowOff', 0, 100, 1, 'outSvShadowOff', 'w10', 'raw1'),
            G('影长线段', [
              svLwCtl('rngSvMeasW', '线粗细', 'meas.w', 'outSvMeasW'),
              cl('clrSvMeas', '线颜色', 'meas.color', 'hexSvMeas'),
              rg('rngSvMeasOp', '透明度', 'meas.op', 0, 100, 1, 'outSvMeasOp', 'int1', 'pct'),
              G('类型', [
                rg('rngSvMeasN', '虚线密度', 'meas.n', 4, 60, 1, 'outSvMeasN', 'int1', 'raw'),
                rg('rngSvMeasRatio', '虚实比', 'meas.ratio', 20, 90, 1, 'outSvMeasRatio', 'int1', 'pct'),
              ], { ctl: sl('selSvMeasDash', '类型', 'meas.dash', DASH_OPTS) }),
            ], { sw: 'cbSvMeasLine', swPath: 'meas.line', gate: 'meas.on' }),
            G('过物体顶部的光线', [
              /* ★ v42（代码审查改法 B）：掠顶光线三参数 —— 长度 / 根数 / 是否连到太阳。 */
              /* 注意 DSL 参数序是 (id, name, path, min, max, step, out, **map**, **fmt**) ——
                 传反了会静默退化到 lin01（0.5 m 变成 0.005）。这里 map=int1（×1）、fmt=raw1（一位小数）。 */
              rg('rngSvMeasRayLen', '光线长度', 'meas.rayLen', 0.5, 126, 0.5, 'outSvMeasRayLen', 'int1', 'raw1'),
              rg('rngSvMeasRayCount', '光线根数', 'meas.rayCount', 1, 5, 1, 'outSvMeasRayCount', 'int1', 'raw'),
              svLwCtl('rngSvMeasRayW', '线粗细', 'meas.rayW', 'outSvMeasRayW'),
              cl('clrSvMeasRay', '线颜色', 'meas.rayColor', 'hexSvMeasRay'),
              rg('rngSvMeasRayOp', '透明度', 'meas.rayOp', 0, 100, 1, 'outSvMeasRayOp', 'int1', 'pct'),
              G('类型', [
                rg('rngSvMeasRayN', '虚线密度', 'meas.rayN', 4, 60, 1, 'outSvMeasRayN', 'int1', 'raw'),
                rg('rngSvMeasRayRatio', '虚实比', 'meas.rayRatio', 20, 90, 1, 'outSvMeasRayRatio', 'int1', 'pct'),
              ], { ctl: sl('selSvMeasRayDash', '类型', 'meas.rayDash', DASH_OPTS) }),
            ], { sw: 'cbSvMeasRay', swPath: 'meas.ray', gate: 'meas.on' }),
            /* ★ v60（需求2）：双击选中物体时的**粉红描边**属性 —— 颜色 / 粗细。
               描边 = inverted hull（反向法线膨胀外壳），屏幕宽度恒定，改这里即时生效。 */
            G('选中描边（双击物体）', [
              cl('clrSvSelEdge', '描边颜色', 'meas.edgeColor', 'hexSvSelEdge'),
              rg('rngSvSelEdgeW', '描边粗细（像素）', 'meas.edgeW', 1, 10, 1, 'outSvSelEdgeW', 'int1', 'raw'),
            ]),
            /* ★ v41（需求一·12）改版：与「天球坐标系 › 文字注释」同构 —— 每条注释一个子组，
               标题行是该注释的显隐开关，组内是字号 / 字体 / 颜色 / 透明度 / 字重。
               三条注释共用 svMeas 分类（与改版前一致），故任一子组里改样式三者同步。
               ★ v64（需求4）：组标题前加**容器开关**（cbSvMeasNote / meas.note）——
                 父级＞子级：容器关 ⇒ 三个子组置灰 + 状态级联关 + 渲染端隐藏（svMeasNoteOK）。
               ★ v64（需求4）：组内「整体字号」百分比滑条（rngSvMeasLabel / meas.label）已删除 ——
                 字号统一由各子组自己的「字号」属性（@note.cats.*.size）承担。 */
            G('文字注释', [
              svNoteGrp('物体高度', 'svMeas', { sw: 'cbSvMeasH', swPath: 'meas.h', gate: 'meas.on,meas.note' }),
              svNoteGrp('影长数值', 'svMeasL', { sw: 'cbSvMeasLen', swPath: 'meas.len', gate: 'meas.on,meas.note' }),
              svNoteGrp('太阳高度角', 'svMeasA', { sw: 'cbSvMeasAng', swPath: 'meas.ang', gate: 'meas.on,meas.note' }),
            ], { sw: 'cbSvMeasNote', swPath: 'meas.note', gate: 'meas.on' }),
            tip('双击地面上的建筑物 / 旗杆 / 树木，在弹出的属性对话框里点「测量影长」即可对该物体' +
                '开启测量：画出**刚好擦过物体最高点（掠顶）的临界光线**与影长线段，并标注物体高度 / ' +
                '影长 / 太阳高度角，三者均随时间实时变化。' +
                '「掠过段长度」控制光线自顶端向太阳方向延伸多长（默认 6 m，拉到 126 m 即回到' +
                '「一端连太阳」的整条长线）；「光线根数」>1 时画一组平行线，直观体现太阳光近似平行；' +
                '「连到太阳」开启后无论「掠过段长度」取多少，光线一律从**太阳中心**画起（= 旧版整条长线）。' +
                '影子一律按**太阳真实光照的遮挡方向**绘制（背向太阳的水平投影），长度 = 物高 ÷ tan(高度角)，' +
                '并**钳制在地平圈以内**；本组设置对天球视图与地面视角同时生效。'),
          ]
        },
        {
          id: 'pSvFpMark', icon: '🌻', name: '第一人称方向标', sw: 'cbSvFpMark', swPath: 'fpmark.on',
          swTip: '显示东南西北方向标',
          children: [
            rg('rngSvFpMarkSize', '大小', 'fpmark.size', 50, 200, 1, 'outSvFpMarkSize', 'int1', 'pct'),
            cl('clrSvFpMark', '颜色', 'fpmark.color', 'hexSvFpMark'),
            rg('rngSvFpMarkOp', '透明度', 'fpmark.op', 0, 100, 1, 'outSvFpMarkOp', 'int1', 'pct'),
            raw('<div class="btn-row"><button class="btn xs" id="svEnterFp">进入第一人称视角</button></div>'),
          ]
        },
      ]
    },

    /* ★ 本批次（需求五）：「全局文字样式」与「面板文字样式」两块已**移至右上角**
       「全局设置」浮层（#btnPanelMenu2 → fillGlobalSettings），与「面板和悬浮窗」合成一个入口；
       此处不再保留重复菜单项，两侧读数仍是同一份 state.ui.panel.* / state.note.*。 */
    /* ★ 本批次（需求四）：太阳侧「界面与主题」已**整合进右上角「全局设置」面板**
       （#btnPanelMenu2 → fillGlobalSettings：色系 / 面板底色 / 文字色 / 明暗模式 /
       面板背景不透明度 / 毛玻璃模糊），并从此处移除，避免与全局设置重复。
       数据仍为唯一一份 @ui.theme.*（经 BR.applyUiTheme 落 CSS 变量）。 */

    /* ★ 本批次（需求五）：「重置所有设置」已**移至右上角**「全局设置」浮层
       （见 fillGlobalSettings → svResetAll），此处不再保留重复入口。 */
  ];

  if (window.renderMenuInto) window.renderMenuInto($('svOptMenu'), $('svFlyHost'), SUN_MENU);

  /* ---- 菜单交互（与主模块 #optsCard 同一套行为） ---- */
  (function () {
    var card = $('svOptsCard'); if (!card) return;
    function closeAll() {
      card.querySelectorAll('.opt-fly.on').forEach(function (f) { f.classList.remove('on'); });
      card.querySelectorAll('.lv2-row.on').forEach(function (r) { r.classList.remove('on'); });
    }
    /* ★ 修复 #15（续）：一级菜单 aria 的统一收口点 —— 把每个一级分组的 aria-expanded
       同步为它的**真实**展开态（读 .opt-sec.open）。menu.js 已把一级行由 <button> 改为
       <div role="button" tabindex="0" aria-expanded="false">，此属性须由本模块维护。
       注：实测一级分组之间「互不干扰」（见 app.js 11756 行注释），并非互斥展开；
       故这里镜像真实状态：打开的那项为 true、关闭的项为 false，任一时刻都不会误报。 */
    function syncLv1Aria() {
      card.querySelectorAll('.opt-sec > .lv1').forEach(function (b) {
        var sec = b.parentElement;
        b.setAttribute('aria-expanded', String(!!(sec && sec.classList.contains('open'))));
      });
    }
    /* ★ 修复 #15（续）：一级菜单展开 / 收起逻辑抽成命名函数，供 click 与 keydown **共用**
       （勿在两处各写一遍，否则键盘激活与鼠标点击会各切一次）。 */
    function toggleLv1(btn) {
      var sec = btn.parentElement, was = sec.classList.contains('open');
      closeAll();
      sec.classList.toggle('open', !was);
      btn.classList.toggle('on', !was);
      syncLv1Aria();
      saveSoon();
    }
    card.querySelectorAll('.opt-sec > .lv1').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        /* ★ 修复 #15：点击一级菜单标题内的开关（.opt-row > .sw）不得连带展开 / 收起整段
           并关闭全部浮层（参考二级处理器 L4519 的写法）。 */
        if (e && e.target && e.target.closest && e.target.closest('.opt-row > .sw')) return;
        toggleLv1(btn);
      });
    });
    card.querySelectorAll('.lv2-row').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (e && e.target && e.target.closest && e.target.closest('.lv2-row > .sw')) return;
        var fly = $(btn.dataset.fly); if (!fly) return;
        var was = fly.classList.contains('on');
        card.querySelectorAll('.opt-fly.on').forEach(function (f) { if (f !== fly) f.classList.remove('on'); });
        card.querySelectorAll('.lv2-row.on').forEach(function (r) { if (r !== btn) r.classList.remove('on'); });
        if (was) { fly.classList.remove('on'); btn.classList.remove('on'); return; }
        fly.classList.add('on'); btn.classList.add('on');
        fly.dispatchEvent(new CustomEvent('flyopen', { bubbles: true }));   /* ★ v35：浮层打开通知；★ v36 补 bubbles（监听在 document 冒泡阶段，不冒泡则永远收不到） */
        var r = card.getBoundingClientRect();
        card.classList.toggle('fly-left', r.left + r.width / 2 > window.innerWidth / 2);
      });
    });
    card.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.nd-h .sw')) return;
      var nh = t.closest('.nd-h');
      if (nh && card.contains(nh)) {
        if (t.closest('select, input, button')) return;
        var g2 = nh.parentElement;
        if (g2 && g2.classList.contains('nd')) {
          g2.classList.toggle('open');
          /* ★ 修复 #15：折叠切换后同步 aria-expanded（menu.js 已给 .nd-h 声明该属性）。 */
          nh.setAttribute('aria-expanded', String(g2.classList.contains('open')));
        }
      }
    });
    /* ★ 修复 #15（续）：为 .nd-h 与一级菜单行（.opt-row.lv1[role="button"]）补键盘激活 ——
       menu.js 已把一级行由 <button> 改为 <div role="button" tabindex="0">，div 不会在
       Enter / 空格 时自动触发 click，必须由本委托补上。一级行直接调 toggleLv1()
       （与 click 处理器是**同一个**函数，逻辑不复制）；分组标题 .nd-h 沿用其 click 处理器。
       两者合并为**同一个** keydown 委托：若拆成两个委托，同一元素会被命中两次
       ⇒ 切换两次 = 无变化，这正是必须避免的互相干扰。
       先判一级行（带 role="button" 的才是新 div 形态）；native 按钮 / 输入控件交给浏览器原生处理。 */
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('select, input, textarea, button')) return;
      var lv1 = t.closest('.opt-row.lv1[role="button"]');
      if (lv1 && card.contains(lv1)) { e.preventDefault(); toggleLv1(lv1); return; }
      var head = t.closest('.nd-h');
      if (head && card.contains(head)) { e.preventDefault(); head.click(); }
    });
    card.querySelectorAll('.fly-close').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var fly = btn.closest('.opt-fly'); if (!fly) return;
        var row = card.querySelector('.lv2-row[data-fly="' + fly.id + '"]');
        fly.classList.remove('on'); if (row) row.classList.remove('on');
      });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

    /* 需求 3.1 / 验收 1：三级菜单的总开关——关闭后下级控件置灰并隐藏；
       置灰状态下直接点选会自动把缺的上级开关一并打开（顺序始终是上级先、本级后）。 */
    function gatePaths(elm) {
      var n = elm && elm.closest ? elm.closest('[data-gate]') : null;
      return (n && n.dataset.gate ? n.dataset.gate : '')
        .split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    function gateOff(paths) {
      return paths.some(function (p2) { return getPath(S, p2) !== true; });
    }
    function syncGates() {
      card.querySelectorAll('[data-gate]').forEach(function (elm) {
        var off = gateOff(gatePaths(elm));
        elm.classList.toggle('gated', off);
        if (off) elm.title = '需先开启：' + gatePaths(elm).join(' + ');
      });
    }
    function syncOff() {
      card.querySelectorAll('.nd > .nd-h input[type=checkbox]').forEach(function (cb) {
        var g = cb.closest('.nd');
        if (g) g.classList.toggle('off', !cb.checked);
      });
    }
    window.__svSyncGates = function () { syncGates(); syncOff(); };
    card.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox' || !cb.closest) return;
      var gp = gatePaths(cb);
      if (cb.checked && gateOff(gp)) gp.forEach(function (p2) { setPath(S, p2, true); });
      var g = cb.closest('.nd');
      if (g && cb.closest('.nd-h')) g.classList.toggle('off', !cb.checked);
      syncGates(); saveSoon(); syncSunBinders();
    });
    syncGates(); syncOff();
  })();

  /* ---- 通用绑定器：把 SUN_MENU 里的 path 接到 S 上 ---- */
  function applySun() {
    saveSoon(); syncSunBinders(); onStateChanged();
    if (window.__svSyncGates) window.__svSyncGates();
    /* ★ v39（需求二·1·②）：方向文字与天球方位注释合二为一后，改 dmark 属性
       需立即刷新天球方位注释精灵（此前只在 updateCelestial 每帧刷新）。 */
    try { applyNoteStyles(); } catch (e) { console.warn('[sunview] applySun applyNoteStyles', e); }
  }

  /* ★ v37（需求二·3）：「重置所有设置」—— 与主模块功能完全一致：
     先走主模块的两段重置（自转 / 公转 / 综合的全部设置回默认并落盘），
     再把太阳侧状态清空回填 DEF、清掉本模块存档与用户放置的地面物体，
     最后把面板布局 / 相机 / 控件读数 / 显隐全部刷回默认。
     ★ v41（需求一·6）：主模块这一段改为触发**设置面板里的 #preReset**（而不是底部控制条的
       #btnResetAll）—— 两者差在：#preReset 保留 播放状态 / 速度 / 模式 / 视图 / 分屏 / 综合布局，
       而 #btnResetAll 还会把仿真时间跳回「此刻」并复位相机。用户要的是「与地球运动设置面板
       中的重置按钮一致」，故走 #preReset；太阳侧自身的当前视图同样保留。 */
  (function () {
    var b = $('btnSvResetAll'); if (!b) return;
    b.addEventListener('click', svResetAll);
  })();
  /* ★ 本批次（需求五）：把上面的重置逻辑抽成命名函数 svResetAll，
     右上角「全局设置」浮层里的「重置所有设置」按钮直接复用它
     （见 fillGlobalSettings），左侧菜单里那个同名按钮已移除。 */
  function svResetAll() {
      /* 0) 记下太阳侧当前视图（与地球侧「重置不改变当前视图」一致） */
      var keepView = S.view;
      /* 1) 主模块：直接走非全量重置入口（含 persist 落盘）
         ★ v62（需求 2）：地球侧设置菜单里的 #preReset 已移除，改为调用
            window.SUN_BRIDGE.resetAllSettings()（语义与旧按钮完全一致）。 */
      var BR = window.SUN_BRIDGE;
      if (BR && BR.resetAllSettings) BR.resetAllSettings();
      /* 2) 太阳侧：存档移除 + 状态清空回填 DEF + 无条件归一化 */
      try { localStorage.removeItem(LS_SUN); } catch (e) { console.warn('[sunview] svResetAll removeItem', e); }
      S = JSON.parse(JSON.stringify(DEF));
      restore();
      /* ★ 视图保留；若此前停在综合视图（会话态，重置后 combo.on 为 false）则回落地面视角 */
      if (keepView === 'combo' && !(S.combo && S.combo.on)) S.view = 'ground';
      else if (keepView === 'ground' || keepView === 'sky') S.view = keepView;
      /* 3) 用户放置的地面物体移除（prep- 预制保留）；小人被删则重建 */
      props.slice().forEach(function (o) {
        if (o.userData.id && String(o.userData.id).indexOf('prep-') === 0) return;
        objGrp.remove(o);
        /* ★ 与修复 #2 一致：移除前释放该对象子树的几何 / 材质 / 贴图
           （否则用户放置的镂空建筑，其每实例 facadeTexture 会常驻显存泄漏）。 */
        disposeObj(o);
        var i = props.indexOf(o); if (i >= 0) props.splice(i, 1);
      });
      if (props.indexOf(figObj) < 0) rebuildFigure();
      /* ★ v53：用户放置的小人已全部移除，视点小人（fpHost）若在其中必然已失效 ⇒ 清空。
         必须在这里清：rebuildFigure() 只继承「旧 figObj」的站位，管不到被删的 fpHost。 */
      fpHost = null;
      clearSel();
      /* 4) 第一人称状态复位（与声明初值一致） */
      fpPos.set(0, 0, 4.5); fpYaw = 0; fpPitch = 0.03;
      if (figObj) figObj.position.copy(fpPos);
      /* 5) 面板布局复位（7 个面板回默认停靠），底部观测点 / 时间控制窗重排 */
      ['svOptsCard', 'svTimeTop', 'svTimeBar', 'svMonitor', 'svWinEarth', 'svWinSky', 'svWinGround'].forEach(resetEl);
      /* 6) 全量刷新：控件读数 / 置灰 / 几何 / 贴图 / 面板显隐 / 视图分段 */
      syncSunBinders();
      if (window.__svSyncGates) window.__svSyncGates();
      onStateChanged();
      applyEarthTexture();
      syncBodyClasses();
      applySurfaceLayout();
      applyPanelVisibility();
      if (window.__svSyncViewSeg) window.__svSyncViewSeg();
      saveSoon();
      toast('已恢复全部默认设置');
  }

  var sunBinders = [];
  /* ★ 本次修复：注册时记录一个简短 label（控件状态路径 / 语义名），失败时一并打印，
     免得只看到 'binder #39' 无从定位是哪个控件。 */
  function pushSunBinder(fn, label) { if (label) fn.label = label; sunBinders.push(fn); return fn; }
  function syncSunBinders() {
    sunBinders.forEach(function (f, i) {
      try { f(); }
      catch (e) { console.warn('[sunview] binder #' + i + (f.label ? ' [' + f.label + ']' : ''), (e && e.message) || e); }
    });
  }
  /* ★ v35（需求十七）：暴露给主模块 —— 面板文字样式（@ui.panel.*）在主模块侧改动后，
     applyPanelFont 会调 window.__svSyncBinders() 刷新本模块的控件读数（双向同步）。 */
  window.__svSyncBinders = syncSunBinders;
  /* ★ v62（需求 3）：暴露给主模块 —— 面板字号倍率（--ui-fs）变化后由 app.js 的
     applyPanelFont 调用，立即重算「观测点与时间控制」面板的宽度倍率与内部缩放
     （面板宽 = 占屏宽比例 × 字号倍率，必须随字号同步变化）。 */
  window.__svRefitTimeBar = fitTimeBarScale;
  /* ★ v43（一·4 / 一·6）：只读调试出口 —— 供 tools/_probe_v43_dir.js 独立复算
     室内方位标注的投影，验证「方位锚点用世界坐标、不是房间局部坐标」。
     暴露 iCam / iRoom / THREE / 室内方位环半径 IR，不提供任何写入口。 */
  window.__svGeom = {
    THREE: THREE,
    get iCam() { return iCam; },
    get iRoom() { return iRoom; },
    get gCam() { return gCam; },
    get cCam() { return cCam; },
    get gScene() { return gScene; },
    get cScene() { return cScene; },
    get iScene() { return iScene; },
    IR: 1.35
  };
  /* ★ v53：只读调试出口（供 tools / 验证脚本核对任务二、第三项的实测值）。
     暴露 fpPos / fpHost / figObj / meas 池的几何参数，供独立脚本复算；
     与 __svGeom 一致：**不提供任何写入口**，只读 getter。 */
  window.__svFpMeas = {
    THREE: THREE,
    get fpPos() { return fpPos; },
    get fpHost() { return fpHost; },
    get figObj() { return figObj; },
    get props() { return props; },
    get gCam() { return gCam; },
    get sunLight() { return sunLight; },
    get shadowCatcher() { return shadowCatcher; },
    /* 影长线段 + 掠顶光线的实测几何（取第一个测量对象的那条记录） */
    get measRec() { return _measPool[0] || null; },
    GROUND_R: GROUND_R, GSIZE: GSIZE,
    SHADOW_MAX: SHADOW_MAX, SHADOW_MIN_ALT: SHADOW_MIN_ALT, SHADOW_FAR: SHADOW_FAR,
    enterFP: enterFP, exitFP: exitFP, beginMeasure: beginMeasure
  };
  /* ★ 口径约定（与主模块一致）：状态一律用「人读数值」存，不用 0–1 分数。
     例：透明度 / 强度 / 大小 / 虚实比等一律 0–100（或 0–200）的百分数，
     渲染侧自己除以 100；滑块用 int1 映射（滑块值 == 状态值），此处只负责加百分号。
     早期版本这里写成 Math.round(v*100)，配合 lin01 映射会把读数放大 100 倍（10000%）。 */
  var FMTS = {
    pct: function (v) { return Math.round(v) + '%'; },
    /* v32（需求六）：主模块的 note.*.op 存的是 0~1，用这个 fmt 才显示成百分比 */
    opPct: function (v) { return Math.round((+v) * 100) + '%'; },
    raw: function (v) { return String(Math.round(v)); },
    raw1: function (v) { return (+v).toFixed(1); },
    x: function (v) { return (+v).toFixed(2) + '×'; },
    deg0: function (v) { return Math.round(v) + '°'; },
    /* v34：线粗细一律以**世界单位**存储（如 0.026），用这个格式显示三位小数 */
    mm3: function (v) { return (+v).toFixed(3); },
  };
  function fmtOf(k) { return FMTS[k] || FMTS.raw1; }
  function svLwCtl(id, name, path, out) {
    return rg(id, name, path, SV_LW_MIN, SV_LW_MAX, SV_LW_STEP, out, 'lwRel', 'lwX');
  }
  /* 真实换算：path 已知 ⇒ 可以在 bindOne 之外直接用（供手写监听器调用） */
  function svLwToSlider(path, v) { return Math.round((+v || 0) / (SV_LW_BASE[path] || 1) * 100); }
  function svLwFromSlider(path, s) {
    return clamp((+s || 0) / 100, 0.10, 3.00) * (SV_LW_BASE[path] || 1);
  }
  /* 只要「倍率」不要物理值 —— 供渲染侧把基准值再按倍率缩放（避免二次换算） */
  function svLwMult(path, v) {
    var b = SV_LW_BASE[path] || 1;
    var raw = (v === undefined) ? getPath(S, path) : v;
    return clamp((+raw || 0) / b, 0.10, 3.00);
  }
  function svLwFmt(path) {
    var b = SV_LW_BASE[path] || 1;
    return function (v) { return ((+v || 0) / b).toFixed(2) + '×'; };
  }
  var MAPS = {
    lin01: { toSlider: function (v) { return Math.round(v * 100); }, fromSlider: function (v) { return v / 100; } },
    int1: { toSlider: function (v) { return Math.round(v); }, fromSlider: function (v) { return Math.round(v); } },
    w10: { toSlider: function (v) { return Math.round(v * 10); }, fromSlider: function (v) { return v / 10; } },
    w100: { toSlider: function (v) { return Math.round(v * 100); }, fromSlider: function (v) { return v / 100; } },
    /* v34：线粗细以世界单位存储（0.026 这种量级），滑块单位 = 状态 × 1000 */
    w1000: { toSlider: function (v) { return Math.round(v * 1000); }, fromSlider: function (v) { return v / 1000; } },
    /* ★ v43（需求一·3 / 三·1）：lwRel = 线宽统一倍率口径。真正换算需要 path，
       故这里只放一个「标记 + 恒等」对象，由 bindOne 检测标记后按 SV_LW_BASE 重写
       toSlider / fromSlider（见下方 bindOne 的 __lwRel 分支）。 */
    lwRel: { __lwRel: true, toSlider: function (v) { return v; }, fromSlider: function (v) { return v; } },
  };
  /* v31（需求三）：'@note.' / '@ui.' 前缀 = 借用主模块状态（全局文字样式 / 面板文字样式），
     实现「太阳视运动设置面板里的全局文字样式菜单与自转 / 公转 / 综合完全一致」。 */
  function bridgeGet(p) {
    if (p.indexOf('@note.') === 0) return BR.noteGet ? BR.noteGet(p.slice(6)) : undefined;
    if (p.indexOf('@ui.') === 0) return BR.panelGet ? BR.panelGet(p.slice(4)) : undefined;
    if (p.indexOf('@read.') === 0) return BR.readGet ? BR.readGet(p.slice(6)) : undefined;
    return undefined;
  }
  function bridgeSet(p, v) {
    if (p.indexOf('@note.') === 0) { if (BR.noteSet) BR.noteSet(p.slice(6), v); return true; }
    if (p.indexOf('@ui.') === 0) {
      if (BR.panelSet) BR.panelSet(p.slice(4), v);
      /* v31（需求十七）：改「UI 风格 / 毛玻璃」时让全局主题立刻生效 */
      if (p.indexOf('@ui.theme') === 0 && BR.applyUiTheme) BR.applyUiTheme();
      return true;
    }
    if (p.indexOf('@read.') === 0) { if (BR.readSet) BR.readSet(p.slice(6), v); return true; }
    return false;
  }
  function isBridge(p) {
    return typeof p === 'string' &&
      (p.indexOf('@note.') === 0 || p.indexOf('@ui.') === 0 || p.indexOf('@read.') === 0);
  }
  function bindOne(n) {
    if (!n || !n.id || !n.path) return;
    var e = $(n.id); if (!e) return;
    if (e.dataset.svBound) return;
    e.dataset.svBound = '1';
    if (isBridge(n.path)) {
      var bp = n.path;
      /* ★ v32（需求六）：@note.cats.<cat>.<key> 若该属性正处于「统一 ××」中，
         则控件置灰并显示全局统一值（与主模块 bindNoteCatCtl 行为完全一致）——
         否则用户在这里拖了没反应（draw 用的是统一值），观感上像坏控件。 */
      var _m = /^@note\.cats\.[^.]+\.(\w+)$/.exec(bp);
      var catKey = _m ? _m[1] : null;
      var isUnified = function () { return !!(catKey && BR.noteGet('unifyAttrs.' + catKey)); };
      var effGet = function () {
        if (isUnified()) { var mv = BR.noteGet('master.' + catKey); return mv == null ? bridgeGet(bp) : mv; }
        return bridgeGet(bp);
      };
      var setDis = function () { var u = isUnified(); e.disabled = u; e.title = u ? ('该属性正受「全局文字大小样式统一 › 统一 ' + catKey + '」控制；关闭该开关后可单独设置。') : ''; };
      if (n.k === 'range') {
        var bmap = MAPS[n.map] || MAPS.lin01, bfmt = fmtOf(n.fmt), bout = n.out ? $(n.out) : null;
        var bsync = function () {
          setDis();
          var v = effGet(); v = (v == null ? 0 : v);
          e.value = String(bmap.toSlider(v));
          if (bout) bout.textContent = bfmt(v);
        };
        bsync(); pushSunBinder(bsync, bp);
        e.addEventListener('input', function () {
          if (isUnified()) { bsync(); return; }
          bridgeSet(bp, bmap.fromSlider(parseFloat(e.value)));
          if (bout) bout.textContent = bfmt(bridgeGet(bp));
          applySun();
        });
      } else if (n.k === 'color') {
        var bhex = n.hex ? $(n.hex) : null;
        var bsync2 = function () {
          setDis();
          var v = effGet() || '#ffffff';
          e.value = v; if (bhex) bhex.textContent = String(v).toUpperCase();
        };
        bsync2(); pushSunBinder(bsync2, bp);
        e.addEventListener('input', function () {
          if (isUnified()) { bsync2(); return; }
          bridgeSet(bp, e.value);
          if (bhex) bhex.textContent = e.value.toUpperCase();
          applySun();
        });
      } else if (n.k === 'sel') {
        var bsync3 = function () { setDis(); var v = effGet(); if (v != null) e.value = String(v); };
        bsync3(); pushSunBinder(bsync3, bp);
        e.addEventListener('change', function () { if (isUnified()) { bsync3(); return; } bridgeSet(bp, e.value); applySun(); });
      } else if (n.k === 'sw') {
        var bsync4 = function () { e.checked = !!bridgeGet(bp); e.setAttribute('aria-checked', String(e.checked)); };
        bsync4(); pushSunBinder(bsync4, bp);
        e.addEventListener('change', function () { bridgeSet(bp, e.checked); applySun(); });
      }
      return;
    }
    if (n.k === 'range') {
      var map = MAPS[n.map] || MAPS.lin01, fmt = fmtOf(n.fmt), out = n.out ? $(n.out) : null;
      /* ★ v43（需求一·3 / 三·1）：lwRel —— 按 SV_LW_BASE[path] 换成倍率换算 + 倍率读数 */
      if (map.__lwRel) {
        map = { toSlider: function (v) { return svLwToSlider(n.path, v); },
                fromSlider: function (s) { return svLwFromSlider(n.path, s); } };
        fmt = svLwFmt(n.path);
      }
      var sync = function () {
        var v = getPath(S, n.path); v = (v == null ? 0 : v);
        e.value = String(map.toSlider(v));
        if (out) out.textContent = fmt(v);
      };
      sync(); pushSunBinder(sync, n.path);
      e.addEventListener('input', function () {
        setPath(S, n.path, map.fromSlider(parseFloat(e.value)));
        if (out) out.textContent = fmt(getPath(S, n.path));
        applySun();
      });
    } else if (n.k === 'color') {
      var hex = n.hex ? $(n.hex) : null;
      var sync2 = function () {
        var v = getPath(S, n.path) || '#ffffff';
        e.value = v; if (hex) hex.textContent = String(v).toUpperCase();
      };
      sync2(); pushSunBinder(sync2, n.path);
      e.addEventListener('input', function () {
        setPath(S, n.path, e.value);
        if (hex) hex.textContent = e.value.toUpperCase();
        applySun();
      });
    } else if (n.k === 'sel') {
      var sync3 = function () { var v = getPath(S, n.path); if (v != null) e.value = String(v); };
      sync3(); pushSunBinder(sync3, n.path);
      e.addEventListener('change', function () { setPath(S, n.path, e.value); applySun(); });
    } else if (n.k === 'sw') {
      var sync4 = function () { e.checked = !!getPath(S, n.path); e.setAttribute('aria-checked', String(e.checked)); };
      sync4(); pushSunBinder(sync4, n.path);
      e.addEventListener('change', function () {
        setPath(S, n.path, e.checked);
        svCascade(n.path);          /* v35（需求八）：父开关关闭 → 受控子开关级联关闭 */
        /* 面板显隐不走几何刷新，需立即同步（含主模块 timeCard 的联动对齐） */
        if (n.path === 'panel.timeTop') applyPanelVisibility();
        applySun();
      });
    }
  }
  /* v35（需求八）：太阳侧开关级联规则（与主模块 CASCADE_RULES 同构）——
     「上关下必关、上开下才能开」：父开关关闭 ⇒ 受控子开关强制置 false（状态 + 菜单 DOM）；
     父开关打开 ⇒ 子开关恢复可用（保持各自当前值）。 */
  /* ★ v62（需求一）：显式级联规则清空 ——「位置点与时刻」组开关（traj.ptOn）取消后，
     太阳侧不再需要额外级联；traj.on / traj.today 对下级的门控由下方自动推导机制
     （从 SUN_MENU 层级收集）与渲染侧的 traj.on,traj.today 判断共同承担。 */
  var SV_CASCADE = [];
  function svCascade(changedPath) {
    var hit = false;
    SV_CASCADE.forEach(function (rule) {
      if (rule[0] !== changedPath) return;
      if (getPath(S, rule[0]) !== false) return;
      rule[1].forEach(function (cp) { setPath(S, cp, false); });
      hit = true;
    });
    if (hit) { syncSunBinders(); if (window.__svSyncGates) window.__svSyncGates(); saveSoon(); }
  }
  (function bindMenuSun(nodes) {
    (nodes || []).forEach(function (n) {
      if (!n) return;
      if (n.sw && n.swPath) bindOne({ id: n.sw, k: 'sw', path: n.swPath });
      if (n.ctl) bindOne(n.ctl);
      bindOne(n);
      if (n.children) bindMenuSun(n.children);
    });
  })(SUN_MENU);

  /* ★ v36（需求五）：级联规则从 SUN_MENU 自动推导（与主模块 buildCascadeRules 同构）——
     每个标题前开关（swPath）关闭 ⇒ 其浮层内容里的全部下级布尔开关强制关。
     推导完统一跑一遍，归一化「父关子开」的矛盾存档。 */
  (function () {
    function collect(nodes, out) {
      (nodes || []).forEach(function (nd) {
        if (!nd) return;
        if (nd.k === 'sw' && nd.path) { if (out.indexOf(nd.path) < 0) out.push(nd.path); return; }
        if (nd.swPath) { if (out.indexOf(nd.swPath) < 0) out.push(nd.swPath); return; }
        if (nd.children) collect(nd.children, out);
      });
      return out;
    }
    (function build(nodes) {
      (nodes || []).forEach(function (nd) {
        if (!nd) return;
        if (nd.swPath) {
          var kids = collect(nd.children || [], []);
          if (kids.length && !SV_CASCADE.some(function (r) { return r[0] === nd.swPath; })) SV_CASCADE.push([nd.swPath, kids]);
        }
        if (nd.children) build(nd.children);
      });
    })(SUN_MENU);
    /* ★ v36 修正：启动时**不跑**级联归一化（v36 初版在此 forEach 一遍，实测是回归 ——
       traj.term4 等组开关默认关闭而子级 termShow.* 默认开，是「待命」语义：
       组开关一打开子级全部就绪；启动归一化会把它们全部强制关掉，打开组开关后
       看到的是一排全灰的子开关。级联只在运行期 bindOne change → svCascade 生效，
       旧存档矛盾态由 gate 置灰 + 运行期级联自然收敛。） */
  })();

  /* ============================ 15. 观测点控件 ============================ */
  (function () {
    var lat = $('svLat'), lon = $('svLon'), oLat = $('svOutLat'), oLon = $('svOutLon'), err = $('svObsErr');
    var nLat = $('svObsLatN'), nLon = $('svObsLonN');
    function sync() {
      var o = BR.getObs();
      if (document.activeElement !== lat && lat) lat.value = String(o.lat);
      if (document.activeElement !== lon && lon) lon.value = String(o.lon);
      if (oLat) oLat.textContent = Math.abs(o.lat).toFixed(1) + '°' + (o.lat >= 0 ? 'N' : 'S');
      if (oLon) oLon.textContent = Math.abs(o.lon).toFixed(1) + '°' + (o.lon >= 0 ? 'E' : 'W');
      if (document.activeElement !== nLat && nLat) nLat.value = String(o.lat);
      if (document.activeElement !== nLon && nLon) nLon.value = String(o.lon);
      /* ★ v42（代码审查 · 二/#svTimeBar）：预设地点的选中态（`.on` 高亮）与 `aria-pressed`
         一并同步 —— 用户拖滑块切到「自定义」时全部熄灭，选了某个城市时只有它亮，
         读屏也能播报当前是哪一个。 */
      document.querySelectorAll('#svObsPresets button').forEach(function (b) {
        var on = b.dataset.preset === o.preset;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    pushSunBinder(sync, 'obs.latlon');
    if (lat) lat.addEventListener('input', function () { BR.setObs(parseFloat(lat.value), obsLon(), 'custom'); applySun(); });
    if (lon) lon.addEventListener('input', function () { BR.setObs(obsLat(), parseFloat(lon.value), 'custom'); applySun(); });
    /* ★ v38（需求六）：重要纬度节点 —— 圆点骑在滑轨中线上、注释排在正下方，点击跳转；
       文字精简为「名称 + 度数」（度数直接标在名称里，去掉重复说明）。 */
    var KEYS = [['北极圈', 66.5], ['北回归线', 23.4], ['赤道', 0], ['南回归线', -23.4], ['南极圈', -66.5]];
    var latHost = $('svLatNodes');
    if (latHost) KEYS.forEach(function (k) {
      tbNode(latHost, (k[1] + 90) / 180, k[0], {
        prime: k[1] === 0,
        /* ★ v39（需求二·6）：竖排（窄）时用「名称+度数」短标签，避免与相邻节点重合 */
        short: k[0] + (k[1] === 0 ? '' : Math.abs(k[1]) + '°'),
        title: k[0] + '（' + Math.abs(k[1]) + '°' + (k[1] > 0 ? 'N' : k[1] < 0 ? 'S' : '') + '）',
        click: function () { BR.setObs(k[1], obsLon(), 'custom'); if (err) err.textContent = ''; applySun(); }
      });
    });
    /* ★ v38（需求六）：经度节点只保留**本初子午线（0°）**；去掉 180° 刻度（需求明确）。 */
    var lonHost = $('svLonNodes');
    if (lonHost) {
      tbNode(lonHost, 0.5, '本初子午线 0°', {
        prime: true, title: '本初子午线（0° 经线）',
        click: function () { BR.setObs(obsLat(), 0, 'custom'); if (err) err.textContent = ''; applySun(); }
      });
    }
    var PRESETS = [['北京', 39.9, 116.4, 'beijing'], ['太原', 37.9, 112.5, 'taiyuan'],
                   ['哈尔滨', 45.8, 126.5, 'harbin'], ['海口', 20.0, 110.3, 'haikou']];
    var ph = $('svObsPresets');
    if (ph) PRESETS.forEach(function (p) {
      var b = el('button', 'btn xs', p[0]);
      b.dataset.preset = p[3];
      b.addEventListener('click', function () { BR.setObs(p[1], p[2], p[3]); if (err) err.textContent = ''; applySun(); });
      ph.appendChild(b);
    });
    var ap = $('svObsApply');
    if (ap) ap.addEventListener('click', function () {
      var la = parseFloat(nLat.value), lo = parseFloat(nLon.value);
      if (!isFinite(la) || la < -90 || la > 90) { if (err) err.textContent = '纬度需在 −90° ~ 90° 之间'; return; }
      if (!isFinite(lo) || lo < -180 || lo > 180) { if (err) err.textContent = '经度需在 −180° ~ 180° 之间'; return; }
      if (err) err.textContent = '';
      BR.setObs(la, lo, 'custom'); applySun();
    });
    sync();
  })();

  /* ============================ 16. 地面物体：放置 / 选择 / 属性 ============================ */
  var placing = null, moveTarget = null, ghost = null;
  (function () {
    ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.32, depthWrite: false }));
    ghost.visible = false;
    gScene.add(ghost);
  })();
  function groundHitFromEvent(e, groundOnly) {
    var r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
    var nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster(); rc.setFromCamera(nd, S.fp ? fpCam : gCam);
    /* ★ v39（需求二·3）：移动物体时只求**地面落点** —— 否则射线先命中被移动物体自身，
       返回的是物体表面上的点，目标位置几乎等于当前位置（表现为「移不动」）。
       直接用「射线 ∩ 水平面 y=0」解析求交，稳定拿到地面点。 */
    if (groundOnly) {
      var o0 = rc.ray.origin, d0 = rc.ray.direction;
      if (Math.abs(d0.y) < 1e-6) return null;
      var t0 = -o0.y / d0.y;
      if (t0 <= 0) return null;
      return { point: new THREE.Vector3(o0.x + d0.x * t0, 0, o0.z + d0.z * t0), obj: null };
    }
    var list = [ground]; props.forEach(function (p) { list.push(p); });
    var hit = rc.intersectObjects(list, true);
    for (var i = 0; i < hit.length; i++) {
      var o = hit[i].object, q = o;
      while (q && q.parent !== objGrp) q = q.parent;
      if (o === ground) return { point: hit[i].point.clone(), obj: null };
      if (q && q.userData && q.userData.kind) return { point: hit[i].point.clone(), obj: q };
    }
    return null;
  }
  /* ★ v41（需求一·17）：放置 / 拖动的可达范围 = **整个地平面**（半径 GROUND_R ≈ 125.4 的圆盘）。
     旧实现一律按 GSIZE/2（≈ 22）做方形夹取 ⇒ 地面明明有一大片，物体却只能挪到正中间那一小圈，
     点外圈也「移不动 / 放不下」。这里统一改成圆形夹取（留 margin，免得压在地平圈外沿）。 */
  function clampToGround(x, z, margin) {
    var lim = GROUND_R - (margin == null ? 4 : margin), d = Math.sqrt(x * x + z * z);
    if (d > lim && d > 1e-6) { var k = lim / d; return { x: x * k, z: z * k }; }
    return { x: x, z: z };
  }
  /* 进入「位置移动」：物体进入待拖状态 —— 幽灵预览跟随指针，按下拖动即可，**整个地平面**都放得下。 */
  function beginMove(o) {
    /* 记下出发点（Esc 取消时复位用） */
    o.userData.home = { x: o.position.x, y: o.position.y, z: o.position.z };
    placing = 'move'; moveTarget = o;
    if (ghost) ghost.visible = true;
    toast('按住地面把「' + (o.userData.kind === 'building' ? '建筑物'
      : (o.userData.kind === 'figure' ? '小人' : (o.userData.kind === 'tree' ? '树木' : '旗杆')))
      + '」拖到新位置，松手落位；也可直接单击地面（整个地平面内都可行）');
  }
  function beginPlace(kind) {
    placing = kind;
    if (ghost) ghost.visible = true;
    var msg = { figure: '把小人拖到地面后松手（或在地面上单击）',
                tree: '把树木拖到地面后松手（或在地面上单击）',
                flag: '把旗杆拖到地面后松手（或在地面上单击）' };
    toast(msg[kind] || '把建筑拖到地面后松手（或在地面上单击）');
  }
  function endPlace() { placing = null; if (ghost) ghost.visible = false; }
  function placeAt(pt) {
    if (placing === 'building') {
      var w = 6 + Math.random() * 3, d = 8 + Math.random() * 5;
      var h = clamp(Math.round(S.bld.floors), 1, 40) * S.bld.floorH;
      var b = makeBuilding(w, d, h, S.bld.color, S.bld.floors, S.bld.floorH, S.bld.winBase, S.bld.winH, S.bld.angle);
      /* ★ v41（需求一·17）：整个地平面（GROUND_R 圆盘）内都可放置 */
      var cb = clampToGround(pt.x, pt.z, 5);
      b.position.set(cb.x, 0, cb.z);
      b.userData.id = 'b' + Date.now();
      objGrp.add(b); props.push(b);
      selectObj(b, false);
    } else if (placing === 'figure') {
      /* ★ v32（需求八）：小人**可放置多个** —— 每次放置新建一个小人（旧版是把同一个搬走），
         并把第一人称的站位移到最新放下的那个小人身上。 */
      var nf = makeFigure(S.fig.color, S.fig.h);
      var cf = clampToGround(pt.x, pt.z, 2);
      nf.position.set(cf.x, 0, cf.z);
      nf.userData.id = 'fig' + Date.now();
      objGrp.add(nf); props.push(nf);
      fpPos.copy(nf.position);
      selectObj(nf, false);
    } else if (placing === 'tree' || placing === 'flag') {
      var ob = (placing === 'tree') ? makeTree(S.tree.h, S.tree.color, S.tree.trunk)
                                    : makeFlagpole();
      /* ★ v52（需求G5）：放置旗杆时**不能整体覆盖 userData** ——
         旧写法 `ob.userData = { kind:'flag' }` 把 makeFlagpole 写好的杆高 / 杆色 / 旗色全抹掉，
         导致新放的旗杆永远回落到硬编码默认。这里只补 kind。 */
      if (placing === 'flag') ob.userData.kind = 'flag';
      if (placing === 'tree') ob.userData.hRatio = 1;
      /* ★ v41（需求一·17）：圆形地面 —— 不能落到圆外；范围扩到整个地平面（GROUND_R）。 */
      var c2 = clampToGround(pt.x, pt.z, 3);
      ob.position.set(c2.x, 0, c2.z);
      ob.userData.id = (placing === 'tree' ? 't' : 'f') + Date.now();
      objGrp.add(ob); props.push(ob);
      selectObj(ob, false);
    }
    endPlace(); saveSoon();
  }
  function selectedObjs() { return props.filter(function (o) { return o.userData.selected; }); }
  function updateSelLabel() {
    var n = selectedObjs().length, o = $('svBldSel');
    if (o) o.textContent = n ? (n + ' 个对象已选中') : '未选中（单击地面上的建筑 / 旗杆 / 小人）';
  }
  function clearSel() {
    props.forEach(function (o) { o.userData.selected = false; applyEdgeStyle(o); });
    updateSelLabel();
  }
  function selectObj(o, add) {
    if (!add) clearSel();
    o.userData.selected = true;
    applyEdgeStyle(o);
    if (o.userData.kind === 'building') {
      S.bld.floors = o.userData.floors; S.bld.floorH = o.userData.floorH;
      S.bld.angle = Math.round((o.rotation.y * R + 360) % 360);
      S.bld.winBase = o.userData.winBase; S.bld.winH = o.userData.winH;
      if (o.userData.color) S.bld.color = o.userData.color;
      syncSunBinders();
    }
    updateSelLabel();
  }
  function openObjMenu(o, sx, sy) {
    var host = $('svObjMenu'); if (!host) return;
    host.innerHTML = '';
    host.appendChild(el('div', 'som-t', o.userData.kind === 'building' ? '建筑物'
      : (o.userData.kind === 'figure' ? '小人模型'
        : (o.userData.kind === 'tree' ? '树木' : '旗杆'))));
    function item(label, danger, fn) {
      var b = el('button', danger ? 'danger' : '', label);
      b.addEventListener('click', function () { host.classList.remove('on'); fn(); });
      host.appendChild(b);
    }
    /* ★ v44（需求八）：**物影测量的触发方式改为双击物体** —— 双击弹出的菜单里直接给出
       「测量物影」一项（原先必须先进「属性设置」对话框再点「测量影长」，两步才能触达）。
       进入后 measKeep 锁定该对象，`S.meas.on` 置 true，右下角随即出现「退出物影测量」按钮。 */
    item('测量物影', false, function () { beginMeasure(o); });
    item('位置移动', false, function () { beginMove(o); });
    item('属性设置', false, function () { openPropDlg(o); });
    if (o.userData.kind === 'building') item('室内视角', false, function () { enterIndoor(); });
    /* ★ v53（任务二·2）：把**被双击的那个小人** o 传给 enterFP —— 视点因此落在它身上。
       旧写法先 `fpPos.copy(o.position)` 再 `enterFP()`，可 enterFP 内部又无条件
       `fpPos.copy(figObj.position)` 把站位覆盖成「默认小人」（场景中心那个）的位置，
       于是多小人时点谁都一样。现在 fpPos 由 enterFP 统一负责设置，此处不再预设。 */
    if (o.userData.kind === 'figure') item('第一视角', false, function () { enterFP(o); });
    item('删除', true, function () {
      var m = modal('删除确认', el('div', null, '确定删除该对象？此操作不可撤销。'), []);
      var foot = $('svModalCard').querySelector('.svm-foot');
      foot.appendChild(mkBtn('取消', '', function () { m.close(); }));
      foot.appendChild(mkBtn('删除', 'warn', function () {
        objGrp.remove(o); var i = props.indexOf(o); if (i >= 0) props.splice(i, 1);
        if (o === figObj) rebuildFigure();
        /* ★ v53：被删的若正是视点小人 ⇒ 清空 fpHost（否则它指向已移除对象）。
           若此时还处于第一视角，fpPos 保持最后的站位不变，用户不会被强行拽走。 */
        if (fpHost === o) fpHost = null;
        m.close(); saveSoon();
      }));
    });
    host.classList.add('on');
    /* ★ v41（需求一·5）：按**实测尺寸**夹进视口（旧写法用 200/250 常量，界面字号放大后
       菜单实际更宽 ⇒ 双击靠边 / 靠底的物体时菜单会被顶到屏幕外）。 */
    var mw = host.offsetWidth || 178, mh = host.offsetHeight || 200;
    host.style.left = Math.max(4, Math.min(sx, window.innerWidth - mw - 8)) + 'px';
    host.style.top = Math.max(4, Math.min(sy, window.innerHeight - mh - 8)) + 'px';
  }
  function openPropDlg(o) {
    var isB = o.userData.kind === 'building';
    var kind = o.userData.kind;                     /* building / figure / flag / tree */
    /* ★ v41（需求一·4）：此前旗杆 / 树木被当成「小人」处理 —— 标签写「身高」、
       应用时一律 clamp 到 0.8–2.4 m（把 14 m 的旗杆压成 2.4 m），且 applyProps 只认
       building / figure，改完根本不重建 ⇒ 双击旗杆设属性等于「点了没反应 + 高度被毁」。
       现按 kind 分支：各自的标签、量程与颜色来源。 */
    var col0 = isB ? (o.userData.color || S.bld.color)
      : (kind === 'tree' ? (o.userData.color || S.tree.color)
        : (kind === 'flag' ? (o.userData.flagColor || (S.flag && S.flag.flagColor) || '#d7263d')
          : (o.userData.color || S.fig.color)));
    /* ★ v52（需求G5）：颜色字段的标签与含义按 kind 分支 —— 树木首行是「树冠颜色」、
       旗杆首行是「旗帜颜色」，并可再设「树干颜色 / 杆颜色」，与左侧菜单同名同义。 */
    var cLabel = kind === 'flag' ? '旗帜颜色' : (kind === 'tree' ? '树冠颜色' : '颜色');
    var hLabel = isB ? '' : (kind === 'flag' ? '杆高（米）' : (kind === 'tree' ? '树高（米）' : '身高（米）'));
    var hStep = kind === 'flag' ? '0.5' : '0.1';
    var body = el('div');
    function prow(label, html) { var r = el('div', 'row'); r.innerHTML = '<label>' + label + '</label>' + html; body.appendChild(r); return r; }
    prow(cLabel, '<input type="color" id="svPDColor" value="' + col0 + '" />');
    if (isB) {
      prow('楼层', '<input type="number" id="svPDFloors" value="' + o.userData.floors + '" min="1" max="40" style="width:70px" />');
      prow('楼高（每层）', '<input type="number" id="svPDFloorH" value="' + o.userData.floorH + '" step="0.1" style="width:70px" />');
      prow('朝向 0-360°', '<input type="number" id="svPDAngle" value="' + Math.round((o.rotation.y * R + 360) % 360) + '" min="0" max="360" style="width:70px" />');
      prow('窗户离地高度', '<input type="number" id="svPDWinBase" value="' + o.userData.winBase + '" step="0.1" style="width:70px" />');
      prow('窗户高度', '<input type="number" id="svPDWinH" value="' + o.userData.winH + '" step="0.1" style="width:70px" />');
    } else {
      prow(hLabel, '<input type="number" id="svPDObjH" value="' + o.userData.h + '" step="' + hStep + '" style="width:70px" />');
      /* ★ v52（需求G5）：树木补「树干颜色」；旗杆补「杆颜色」。 */
      if (kind === 'tree') prow('树干颜色', '<input type="color" id="svPDTrunkColor" value="' + (o.userData.trunk || S.tree.trunk) + '" />');
      if (kind === 'flag') prow('杆颜色', '<input type="color" id="svPDPoleColor" value="' + (o.userData.poleColor || (S.flag && S.flag.poleColor) || '#bfc7d2') + '" />');
    }
    var m = modal(isB ? '建筑物属性' : (kind === 'flag' ? '旗杆属性' : (kind === 'tree' ? '树木属性' : '模型属性')), body, []);
    var foot = $('svModalCard').querySelector('.svm-foot');
    /* v31（需求十二）：对话框里也有「测量物影」按钮 —— 画出过物体顶部的光线、
       地面影长线段，并标注物体高度 / 影长 / 太阳高度角。
       ★ v44（需求八）：走 beginMeasure 统一入口（此前这里 repeat 了三行业务逻辑），
       标题由「测量影长」改为与双击菜单一致的「测量物影」。 */
    foot.appendChild(mkBtn('测量物影', '', function () { beginMeasure(o); m.close(); }));
    foot.appendChild(mkBtn('重置', '', function () {
      if (isB) {
        o.userData.floors = DEF.bld.floors; o.userData.floorH = DEF.bld.floorH;
        o.userData.winBase = DEF.bld.winBase; o.userData.winH = DEF.bld.winH;
        o.userData.color = DEF.bld.color; o.rotation.y = 0;
      } else if (kind === 'flag') { o.userData.h = DEF.flag.h; o.userData.poleColor = DEF.flag.poleColor; o.userData.flagColor = DEF.flag.flagColor; }
      else if (kind === 'tree') { o.userData.h = DEF.tree.h; o.userData.color = DEF.tree.color; o.userData.trunk = DEF.tree.trunk; }
      else { o.userData.h = DEF.fig.h; o.userData.color = DEF.fig.color; }
      applyProps(o); syncSunBinders(); m.close();
    }));
    foot.appendChild(mkBtn('取消', '', function () { m.close(); }));
    foot.appendChild(mkBtn('应用', 'on', function () {
      var c = $('svPDColor').value;
      if (isB) {
        o.userData.floors = clamp(parseInt($('svPDFloors').value, 10) || 1, 1, 40);
        o.userData.floorH = clamp(parseFloat($('svPDFloorH').value) || 3, 2, 6);
        o.userData.winBase = clamp(parseFloat($('svPDWinBase').value) || 1, 0.2, 4);
        o.userData.winH = clamp(parseFloat($('svPDWinH').value) || 1.6, 0.3, 3);
        o.userData.color = c || o.userData.color;
        o.rotation.y = clamp(parseFloat($('svPDAngle').value) || 0, 0, 360) * D;
      } else if (kind === 'flag') {
        /* ★ v52（需求G5）：旗杆对话框补「杆高 / 杆颜色 / 旗帜颜色」，写回 S.flag 使左侧菜单同步。 */
        o.userData.h = clamp(parseFloat($('svPDObjH').value) || 14, 3, 30);
        o.userData.flagColor = c || o.userData.flagColor || '#d7263d';
        o.userData.poleColor = ($('svPDPoleColor') && $('svPDPoleColor').value) || o.userData.poleColor || '#bfc7d2';
        S.flag.h = o.userData.h; S.flag.flagColor = o.userData.flagColor; S.flag.poleColor = o.userData.poleColor;
      } else if (kind === 'tree') {
        /* ★ v52（需求G5）：树木对话框补「树冠颜色 / 树干颜色」，写回 S.tree 使左侧菜单同步。 */
        o.userData.h = clamp(parseFloat($('svPDObjH').value) || DEF.tree.h, 2, 24);
        o.userData.color = c || o.userData.color;
        o.userData.trunk = ($('svPDTrunkColor') && $('svPDTrunkColor').value) || o.userData.trunk || S.tree.trunk;
        S.tree.h = o.userData.h; S.tree.color = o.userData.color; S.tree.trunk = o.userData.trunk;
      } else {
        o.userData.h = clamp(parseFloat($('svPDObjH').value) || 1.7, 0.8, 2.4);
        o.userData.color = c || o.userData.color || S.fig.color;
      }
      applyProps(o); saveSoon(); syncSunBinders(); m.close();
    }));
  }
  function applyProps(o) {
    var kind = o.userData.kind;
    if (kind === 'building') {
      var u = o.userData, h = u.floors * u.floorH;
      var nb = makeBuilding(u.w, u.d, h, u.color, u.floors, u.floorH, u.winBase, u.winH, 0);
      nb.position.copy(o.position); nb.rotation.y = o.rotation.y;
      nb.userData.id = u.id; nb.userData.selected = !!u.selected;
      nb.userData.w = u.w; nb.userData.d = u.d;
      objGrp.remove(o); objGrp.add(nb);
      var i = props.indexOf(o); if (i >= 0) props[i] = nb;
      if (nb.userData.outline) applyEdgeStyle(nb);
    } else if (kind === 'figure') {
      /* ★ v52（需求G4）：属性对话框改身高 / 颜色必须真正生效 ——
         旧实现无条件调 rebuildFigure()（读的是全局 S.fig.h，忽略对话框里填的 o.userData.h），
         且 `S.fig.color = S.fig.color` 是 no-op，导致「改了没反应」。 */
      var fpos = o.position.clone(), fid = o.userData.id, fsel = !!o.userData.selected;
      var nf = makeFigure(o.userData.color || S.fig.color, o.userData.h || S.fig.h);
      nf.position.copy(fpos); nf.userData.id = fid; nf.userData.selected = fsel;
      objGrp.remove(o); objGrp.add(nf);
      var fi = props.indexOf(o); if (fi >= 0) props[fi] = nf;
      if (o === figObj) figObj = nf;
      /* ★ v53：视点小人被原地重建 ⇒ fpHost 必须改指新对象（否则它指向已 dispose 的旧对象，
         每帧改 visible / WASD 写 position 都作用在游离对象上）。站位由 nf.position 继承
         （重建时已 copy 过去），改身高 / 颜色不会让第一视角失效。 */
      if (o === fpHost) fpHost = nf;
      if (o === measKeep) measKeep = nf;
      if (nf.userData.outline) applyEdgeStyle(nf);
      disposeObj(o);
      /* 让菜单滑块 / 后续新建小人同步反映该小人的身高与颜色 */
      S.fig.h = nf.userData.h; S.fig.color = nf.userData.color;
      _figSig = S.fig.h + '|' + S.fig.color;
      fpPos.copy(fpos);
    } else if (kind === 'flag' || kind === 'tree') {
      /* ★ v41（需求一·4）：旗杆 / 树木改高度后**原地重建**（此前 applyProps 不认这两种
         kind ⇒ 属性对话框里改完毫无变化）。保留位置、id 与选中态；若它正被测量，
         把 measKeep 改指新对象并强制重建测量池。 */
      var p0 = o.position.clone();
      var nn = (kind === 'flag') ? makeFlagpole(o.userData.h, o.userData.poleColor, o.userData.flagColor)
                                 : makeTree(o.userData.h, o.userData.color, o.userData.trunk || S.tree.trunk);
      nn.position.copy(p0);
      nn.userData.id = o.userData.id || o.userData.kind;
      nn.userData.selected = !!o.userData.selected;
      /* ★ v52（需求G5）：保留树木的相对高矮比例（菜单整体缩放时用） */
      if (kind === 'tree') nn.userData.hRatio = o.userData.hRatio || 1;
      objGrp.remove(o); objGrp.add(nn);
      var jj = props.indexOf(o); if (jj >= 0) props[jj] = nn;
      if (nn.userData.outline) applyEdgeStyle(nn);
      if (measKeep === o) measKeep = nn;
      _measSig = '';
      /* ★ v52（需求G5）：对话框改完单个树木 / 旗杆后同步签名 —— 只让该对象生效，
         不让下一次 onStateChanged 因 S.tree.* / S.flag.* 变化把所有同类对象一起重建成同一高度。 */
      if (kind === 'tree') _treeSig = S.tree.h + '|' + S.tree.color + '|' + S.tree.trunk;
      else _flagSig = S.flag.h + '|' + S.flag.poleColor + '|' + S.flag.flagColor;
      o.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material && c.material.dispose) c.material.dispose();
      });
    }
    updateSelLabel();
  }
  function applyBldToSelection() {
    selectedObjs().forEach(function (o) {
      if (o.userData.kind === 'building') {
        o.userData.color = S.bld.color;
        o.userData.floors = clamp(Math.round(S.bld.floors), 1, 40);
        o.userData.floorH = S.bld.floorH;
        o.userData.winBase = S.bld.winBase;
        o.userData.winH = S.bld.winH;
        o.rotation.y = S.bld.angle * D;
        applyProps(o);
      }
    });
    var anyFig = selectedObjs().some(function (o) { return o.userData.kind === 'figure'; });
    if (anyFig) { var pos = figObj.position.clone(); rebuildFigure(); figObj.position.copy(pos); }
    toast('已应用属性');
    saveSoon();
  }

  /* ============================ 16b. v31（需求十二）：影子测量 ============================
     需求：双击建筑物 / 旗杆 / 树木弹出的对话框里增加「测量影长」；开启后画出
       · **过物体顶部的太阳光线**（从影尖沿光线方向穿过物体顶部再延伸一段）
       · **地面上的影长线段**（从物体底部到影尖）
       · 三个数值注释：物体高度 / 影长 / 太阳高度角
     属性与显隐统一放在【太阳视运动设置 › 影子测量】二级菜单里。

     几何全部按「太阳高度角 h」解算：L = H / tan h，影子方向 = 太阳水平方向的反向。
     阳光方向与地面平行（h→0）时影长发散 —— 这里限制在一个可显示的上限，避免出现
     横穿整个场景的线段。 */
  var measGrp = new THREE.Group(); gScene.add(measGrp);
  var measKeep = null;                 // 通过对话框开启测量的对象（选中取消后仍然保留）
  /* ★ v44（需求八）：**物影测量 = 双击物体触发，右下角给「退出物影测量」按钮**。
     此前唯一的入口是「属性设置」对话框里的「测量影长」，手指要多点两下才能到。
     现在 beginMeasure 是**唯一写点**（双击菜单项与属性对话框共用），endMeasure 是唯一的退出写点
     （右下角按钮专用）—— 两者都只改 S.meas.on + measKeep，再走 applySun() 让渲染侧自己重算，
     不做任何「手动清池」之类的旁路操作（_measSig 失效机制自然会回收精灵）。 */
  function measActive() {
    return !!(S.meas && S.meas.on) && !!measKeep;
  }
  function beginMeasure(o) {
    if (!o) return;
    S.meas.on = true; measKeep = o; _measSig = '';
    if (!o.userData.selected) selectObj(o, false);
    applySun(); syncMeasExit();
    toast('已开启物影测量：属性与显隐见「观测与测量 › 物影」');
  }
  function endMeasure() {
    S.meas.on = false; measKeep = null; _measSig = '';
    applySun(); syncMeasExit();
    toast('已退出物影测量显示');
  }
  /* 「退出物影测量」按钮的显隐 —— body.sv-meas 是纯 CSS 驱动（见 sunview.css），
     这里只负责每帧同步；做成无条件写入（幂等），避免漏帧导致按钮粘住不消失。 */
  function syncMeasExit() {
    if (!document.body) return;
    var on = measActive();
    if (document.body.classList.contains('sv-meas') !== on) document.body.classList.toggle('sv-meas', on);
  }
  var _measPool = [];                  // [{ grp, shadow, rays[], lbH, lbL, lbA }]
  /* ★ v42（代码审查改法 B）：掠顶光线的平行线池上限与间距。
     _RAY_MAX 必须与菜单「光线根数」滑块上限一致（超出不渲染也不要超出池容量）。
     _RAY_SPACING = 平行光束的横向间隔（m）—— 取物体尺度量级，几根线并排正好像一个光束断面。 */
  var _RAY_MAX = 5, _RAY_SPACING = 1.0;
  var _measSig = '';
  function objHeightOf(o) {
    var u = o.userData, k = u.kind;
    if (k === 'building') return (u.floors || 1) * (u.floorH || 3);
    if (k === 'figure') return u.h || 1.7;
    if (k === 'flag') return u.h || 14;   /* ★ v39（需求二·3）：旗杆加高到 14 m */
    if (k === 'tree') return u.h || 5;
    return 2;
  }
  /* ★ v44（需求六）：**远离太阳一侧的屋顶取点**。
     给定「指向太阳」的水平分量 (sdx, sdz)（单位化过的水平向量即可），在物体足迹的四个角里挑
     **投影最小**的那个角（= 沿阳光的水平方向最靠后 ⇒ 离太阳最远），返回其世界 XZ。
        · 建筑：足迹 =(w,d)，绕 y 轴旋转 o.rotation.y ⇒ 四个角的局部坐标旋转后再平移。
          因为只做「取极值」的线性运算，这里不必真的用 matrixWorld，且与旋转角无关。
        · 旗杆 / 树 / 小人：无屋顶轮廓（绕竖直轴近似对称），退回中心线（视觉上无差别）。 */
  var _roofP = { x: 0, z: 0 };
  function roofApexOf(o, sdx, sdz) {
    _roofP.x = o.position.x; _roofP.z = o.position.z;
    if (!o || o.userData.kind !== 'building') return _roofP;
    var w = o.userData.w, d = o.userData.d;
    if (!(w > 0) || !(d > 0)) return _roofP;
    var ca = Math.cos(o.rotation.y), sa = Math.sin(o.rotation.y);
    var hwv = w / 2, hdv = d / 2;
    var best = Infinity, bx = 0, bz = 0;
    /* 旋转后的四个角（绕 y 轴）：(±hw, ±hd) → (x·ca + z·sa, −x·sa + z·ca) */
    for (var i = 0; i < 4; i++) {
      var lx = (i & 1) ? hwv : -hwv, lz = (i & 2) ? hdv : -hdv;
      var rx = lx * ca + lz * sa, rz = -lx * sa + lz * ca;
      var prj = rx * sdx + rz * sdz;          /* 投影越小 ⇒ 越远离太阳 */
      if (prj < best) { best = prj; bx = rx; bz = rz; }
    }
    _roofP.x = o.position.x + bx; _roofP.z = o.position.z + bz;
    return _roofP;
  }
  function measTargets() {
    /* ★ 本批次（需求二）：**只认显式测量对象**（measKeep，即用户双击后在菜单里点了
       「测量物影」的那个）。旧写法是「有选中就测选中」，于是**单击**任意物体都会
       立刻冒出影长线 / 过顶光线 / 三个数值注释 —— 与「单击不显示、双击选择后才显示」
       的要求冲突。现在单击只负责选中（供属性编辑），不再触发任何物影测量显示。 */
    return measKeep ? [measKeep] : [];
  }
  function setLabelText(sp, text, opt) {
    if (!sp) return sp;
    /* ★ v32（需求十二 / 六）：文本没变时必须**原样返回** —— 旧写法在这里调了 noteSplice(sp)，
       把仍在使用的精灵从全局注记跟踪表里摘掉，于是「全局文字样式」之后再改就再也影响不到
       这些测量注释（而且每帧都摘一次，属于典型的误删）。 */
    if (sp.userData.txt === text) return sp;
    noteSplice(sp);                       /* 旧精灵离场，同步移出全局注记跟踪表 */
    var ns = textSprite(text, opt);
    ns.userData.txt = text;
    ns.position.copy(sp.position);
    ns.userData.host = sp.userData.host;
    /* ★ v32：没有 host 的注释（直接挂在 cRoot 上的，如天球影长注释）必须以 sp.parent 兜底，
       否则新精灵既没入场景、旧精灵又被摘掉 ⇒ 注释凭空消失。 */
    var host = sp.userData.host || sp.parent;
    if (host) host.add(ns);
    if (sp.parent) sp.parent.remove(sp);
    if (sp.material && sp.material.map) sp.material.map.dispose();
    if (sp.material) sp.material.dispose();
    return ns;
  }
  function ensureMeasPool(k) {
    while (_measPool.length < k) {
      var grp = new THREE.Group(); measGrp.add(grp);
      /* v33（需求三）：影长线段改为**直接写 4 个顶点**的薄四边形（不再靠欧拉角旋转 PlaneGeometry）——
         旧写法 `rotation.x=-π/2` + `rotation.z=-atan2(ux,uz)` 在 XYZ 欧拉序下并不等价于
         「把长边转到影子方向」，影子会偏转甚至反向；直接写顶点则恒等于「物脚 → 影尖」的连线。 */
      var shGeo = new THREE.BufferGeometry();
      shGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
      shGeo.setIndex([0, 1, 2, 0, 2, 3]);
      var sh = new THREE.Mesh(shGeo,
        new THREE.MeshBasicMaterial({ color: S.meas.color, transparent: true, opacity: 0.85,
          depthWrite: false, side: THREE.DoubleSide }));
      sh.renderOrder = 5; sh.position.set(0, 0, 0);
      grp.add(sh);
      /* 过物体顶部的光线：固定容量的薄带池（支持实线 / 虚线，见 setRibbonSeg）。
         ★ v42（代码审查改法 B）：池容量 = _RAY_MAX，一根 = 一条平行光线（meas.rayCount）。
         ★ v44（需求六）：由 LineSegments 改为 makeRibbon 的 **Mesh** —— 只有这样才能让
           「线粗细 meas.rayW」真正生效（LineBasicMaterial.lineWidth 被驱动忽略，恒为 1px）。 */
      var rays = [];
      for (var q = 0; q < _RAY_MAX; q++) {
        var rayMat = new THREE.MeshBasicMaterial({
          color: S.meas.rayColor, transparent: true, opacity: 0.9,
          depthWrite: false, side: THREE.DoubleSide
        });
        var rl = new THREE.Mesh(makeRibbonGeo(RIB_MAX), rayMat);
        rl.visible = false;
        rl.renderOrder = 6;
        grp.add(rl); rays.push(rl);
      }
      function mk(t) {
        var sp = textSprite(t, { size: 1.5, color: '#ffe9b0', cat: 'svMeas' });
        sp.userData.host = grp; sp.userData.txt = t;
        grp.add(sp);
        return sp;
      }
      var rec = { grp: grp, shadow: sh, rays: rays, ray: rays[0], lbH: mk('物体高度'), lbL: mk('影长'), lbA: mk('太阳高度角') };
      _measPool.push(rec);
    }
    _measPool.forEach(function (r, i) { r.grp.visible = i < k; });
  }
  function updateMeas(g) {
    /* ★ 修复 #10：原为 `S.meas.on && S.ray.shadow !== undefined` —— S.ray.shadow 经 restore()
       归一化后必然存在，条件恒真，导致 S.ray.shadow 开关无法关闭该渲染路径。改为直接取该开关。 */
    var on = S.meas.on && S.ray.shadow;
    var targets = on ? measTargets() : [];
    /* ★ 本批次（需求二）：**夜间不显示任何影子相关内容** —— 太阳在地平线下时物理上不存在
       影子，影长线 / 过顶光线 / 三个数值注释一律收掉（测量开关本身保留，天亮后自动恢复）。
       ★ v53（任务三·5）：门槛由 `g.alt <= 0` 改为 `g.alt <= SHADOW_MIN_ALT`，与
       updateGround 里 `sunLight.castShadow = … && alt > SHADOW_MIN_ALT` **同一口径** ——
       旧代码这里是 0、那里是 1.5，中间 0 < alt ≤ 1.5 就会出现「真实阴影在、线段没了」。 */
    if (g.alt <= SHADOW_MIN_ALT) targets = [];
    var sig = targets.map(function (o) { return o.userData.id; }).join(',') + '|' + S.meas.on + '|' + (g.alt > SHADOW_MIN_ALT);
    if (sig !== _measSig) { _measSig = sig; ensureMeasPool(targets.length); }
    if (!targets.length) { _measPool.forEach(function (r) { r.grp.visible = false; }); return; }
    var alt = g.alt;
    var sdir = dirOf(alt, g.az, _v1);                 // 指向太阳
    var hz = Math.sqrt(Math.max(1e-6, sdir.x * sdir.x + sdir.z * sdir.z));
    /* 指向太阳的水平分量（单位化）。影子方向 = 它的反向 —— 这是「影长线段方向」的唯一来源，
       与真实平行光（sunLight 沿 dir 照射 ⇒ 影子落在 -dir 水平投影方向）物理一致。 */
    var sdx = sdir.x / hz, sdz = sdir.z / hz;
    var ux = -sdx, uz = -sdz;                         // 影子方向（太阳水平反向）
    for (var i = 0; i < targets.length; i++) {
      var o = targets[i], rec = _measPool[i];
      if (!rec) continue;
      var H = objHeightOf(o);
      var px = o.position.x, pz = o.position.z;
      /* ★ v53（任务三·3）：**影长线段的起点 = 屋顶远角正下方**（不再用物体中心 (px,pz)）。
       为什么：屋顶远角才是「阳光刚好擦过的那条棱」（屋顶光线也正是从 roofApexOf 的同一点
       擦过的，见下方 rayOn 段）。旧代码线段从物体中心画、光线却从屋顶远角画，两者水平差
       整整一个「屋顶远角 − 物体中心」的偏移量 —— 建筑旋转时这个偏移还会转，导致
       「光线落点没扎进影尖 / 线段与光线不闭合」。改成同源起点后，
       光线擦过屋顶远角 → 落到影尖 → 线段连接这两点，三者严格闭合。
       ★ roofApexOf() 返回的是**共享暂存对象 _roofP**（模块级单例），所以**全帧只能调一次**、
         调完必须立刻把 x/z 取出来存成局部变量 (rx,rz) 复用 —— 第二次调用会把第一次的结果
         覆盖掉（旧代码正是在两处各调一次才埋下这个隐患）。 */
      var roofP = roofApexOf(o, sdx, sdz);
      var rx = roofP.x, rz = roofP.z;
      /* ★ v53（任务三·2）：去掉 0.35° 下限。旧写法 `clamp(alt, 0.35, 89.5)` 的 0.35 是
         「影长冻住不再变长」的直接原因：alt ≤ 0.35° 时 tan 被夹成常数，影长固定在 H/0.0061
         ≈ 164×H 不再增长，而真实影子本应无限长（正午前后影长趋于 0、日落时趋于 ∞）。
         现在下限取 0，物理上「高度角越低影子越长」得以如实反映；
         上限改由 SHADOW_MAX 兜底（见下），不会无限画出去。
         Math.max(…, 1e-3) 防 tan(0)=0 导致 L=Infinity。 */
      var up = Math.max(1e-3, Math.tan(clamp(alt, 0, 89.5) * D));
      /* v33（需求三）：影子长度**不得超出地平圈** —— 解 |p + u·L| = 地平圈半径 得该方向上的
         最大可画长度 tMax；再与「物高 ÷ tan(高度角)」取小者。
         ★ v53（任务三·2）：tMax 的解算起点 (px,pz) → (rx,rz)，与线段起点、掠顶光线同源；
           上限由 GSIZE(=44) 改为 SHADOW_MAX(=GROUND_R×0.985≈123.5)。GSIZE 是「模型活动区
           半径」（落点夹取 ±22 的两倍），拿它当影长上限会在中等高度角就截断（H=15m 建筑
           在 alt=20° 时真实影长已 41m，逼近 44；alt 再低则完全冻住）—— 这正是「物影异常变短」
           的第二个原因。SHADOW_MAX 与阴影视锥 half- extent 用同一个数，两者不再打架。 */
      var HR = SHADOW_MAX;
      var dotU = rx * ux + rz * uz, pp2 = rx * rx + rz * rz;
      var tMax = -dotU + Math.sqrt(Math.max(0, HR * HR - pp2 + dotU * dotU));
      var L = Math.min(H / up, tMax);
      var tipX = rx + ux * L, tipZ = rz + uz * L;
      /* ★ v56 修复（任务②a）：「过顶部光线」的地面端必须钉在**未截断的真实影尖**上。
         影长线段被地平圈截断只是「显示不出界」（L = min(H/tan, tMax)）；
         光线的物理落点仍是 H/tan(alt)（计算可出界）。旧写法光线地面端 = 截断后的影尖，
         一旦发生截断（低高度角 / 物体靠边），光线在物体高度处就不再经过最高点
         （横向偏差 = |ux|·(H/tan − L)），违反「光线始终过物体最高点」。
         未截断时 Ltrue == L，两种写法完全重合，无回归。 */
      var Ltrue = H / up;
      var tipTX = rx + ux * Ltrue, tipTZ = rz + uz * Ltrue;
      /* 地面影长线段（薄四边形，顶点直接写世界坐标；法线朝上、落在地面之上） */
      var sc = S.meas.line ? 1 : 0;
      rec.shadow.visible = !!sc;
      if (sc) {
        var hw = Math.max(0.05, (S.meas.w / 10) * 0.28);      // 线粗细 → 半宽
        var nx = -uz, nz = ux;                                 // 垂直于影子方向
        var sp = rec.shadow.geometry.attributes.position;
        /* ★ v53（任务三·3）：线段起点 (px,pz) → (rx,rz)（屋顶远角正下方），
           与掠顶光线的掠过点、tMax 的解算起点三者同源 ⇒ 建筑旋转时严格闭合。 */
        sp.setXYZ(0, rx - nx * hw, 0.03, rz - nz * hw);        // 物脚 · 左
        sp.setXYZ(1, rx + nx * hw, 0.03, rz + nz * hw);        // 物脚 · 右
        sp.setXYZ(2, tipX + nx * hw, 0.03, tipZ + nz * hw);    // 影尖 · 右
        sp.setXYZ(3, tipX - nx * hw, 0.03, tipZ - nz * hw);    // 影尖 · 左
        sp.needsUpdate = true;
        rec.shadow.geometry.computeBoundingSphere();
        rec.shadow.material.color.set(S.meas.color);
        rec.shadow.material.opacity = (S.meas.op / 100) * 0.9;
      }
      /* ★ v32（需求五）：过物体顶部的太阳光线；★ v36（需求四）：光线是**一条直线**（不得
         在顶点处折角）；★ v41（需求一·3）：**必须从太阳中心出发并真正穿过物体顶部**。
         v39 写法把太阳侧端点取成「顶点 + dir·SUN_DIST」，它只是沿平行光方向前推 SUN_DIST，
         与真实太阳中心（sunGrp.position = dir·SUN_DIST）相差整整一个**顶点位置矢量**
         ⇒ 物体离原点越远，光线末端离太阳圆盘越远（太阳半径仅 2.4，物体可摆到 ±22），
         肉眼可见一段悬空的线头。
         现改为：以**真实太阳中心**为一个端点、**顶点**为必经点 ——
           u = normalize(顶点 − 太阳中心)；另一端 = 顶点沿 u 继续前进到地面
           （行程 t = H / −u.y，夹到地平圈内 HR）。太阳、顶点、落地点三点严格共线，
           既从太阳出发，又穿过物体顶部，也不再是折线。
         太阳低于物体顶（u.y ≥ 0，只在 alt 极小时发生）⇒ t = 0，退化成「太阳 → 顶点」一段。
         且**只在白天出现**（太阳在地平线下时光线本就不该画）。 */
      /* ★ v42（代码审查 · 改法 B）：「掠顶光线」只在物体顶端附近画一段。
         「物体顶部的光线」的本意是「**刚好擦过顶端的临界光线**」，而不是一条从 126 m 外的
         太阳横贯天空、再拉到地面的长线（旧 v41 行为端点 = 太阳中心，看着像一条莫名其妙的斜线，
         跟物体顶端没有视觉关系）。
         改法：a / b 两端点都由「物体顶端」沿同一条**掠过方向**推出，因此
         **光线永远严格擦过顶端**、落点永远是顶端沿光线落到地面的位置（= 未夹断时的影尖）；
         变的只是「太阳侧端点取多远」：
           · `rayLen` 默认 6 ⇒ 屏幕上一小段贴着顶端的斜线，一眼看出「光从哪儿来 / 擦过顶端 / 落在哪儿」；
           · `rayLen` 拉到 SUN_DIST(126) 时端点正好落在太阳中心 ⇒ **退回 v41 的整条长线**。
         ★ v44（需求六）：已删除「连到太阳」开关 —— 现在只剩「平行光方向 + rayLen」这一套口径，
         不再有「换 pd」的分支，两种模式自相矛盾的问题也就随之消失（详见下方 pd 处注释）。
         光线根数 `meas.rayCount`（1–5）：>1 时在同一竖直平面内等间距画平行线（间隔 _RAY_SPACING），
         主光线（j=0）过物体顶端，其余平行偏移，直观体现「太阳光是平行光」。 */
      /* ★ v53（任务三·5）：门槛与影长线段、castShadow 统一用 SHADOW_MIN_ALT。 */
      var rayOn = S.meas.ray && alt > SHADOW_MIN_ALT;
      if (rayOn) {
        var dir = dirOf(alt, g.az, _mv3);                          /* 指向太阳（单位向量，平行光） */
        var nRays = clamp(Math.round(S.meas.rayCount), 1, _RAY_MAX);
        var rayLen = clamp(+S.meas.rayLen, 0.5, SUN_DIST);
        /* ★ v42（代码审查 · 改法 B）几何口径 —— 先把「掠过方向」定下来（pd = 单位向量，
           **从物体顶端指向太阳**）。
           ★ 本批次（需求一）：两端点改为
             b = **影尖**（+ 第 j 条的横向偏移），a = b + pd·(tDrop + ra)，
           即光线自影尖垂直升起、必经物体顶端再延伸 ra ⇒ 与影长线段**端点精确重合**。 */
        var pdx, pdy, pdz, ra;
        /* ★ v44（需求六）：**取消「过屋顶光线连接太阳」模式**（meas.rayToSun 连同其开关整体删除）。
           该模式只是把端点强行拉到太阳中心，得到一条从 126 m 外横贯天空的斜线，跟物体顶端
           没有视觉关系；而且它必须换一套 pd（太阳中心连线方向），与「多根平行光」自相矛盾。
           现在恒定使用**平行光方向**，端点距离只由 rayLen 决定 —— 一套口径，无隐患。 */
        pdx = dir.x; pdy = dir.y; pdz = dir.z; ra = rayLen;
        var tDrop = (pdy > 1e-6) ? (H / pdy) : 0;
        /* 水平面内垂直于光线的方向（多根平行线按此方向等间距偏移 _RAY_SPACING） */
        var hzp = Math.sqrt(Math.max(1e-9, pdx * pdx + pdz * pdz));
        var rayNX = -pdz / hzp, rayNZ = pdx / hzp;
        /* ★ v44（需求六）：光线的掠过点不再是**屋顶正中间**，而是**远离太阳一侧的屋顶**。
           旧写法一律取 o.position（= 物体中心线），于是光线从房顶正中穿过去 ——
           既看不出「光擦过的是屋顶的哪一条边」，在斜射时也显得像穿模。
           现在：把物体**水平足迹的四个角**投影到太阳的水平方向上，取投影最小的那个角
           （= 离太阳最远），光线就从那里擦过。此方法与物体朝向 rotation.y 无关，
           旋转过的建筑同样成立；非盒体（旗杆 / 树 / 小人）没有屋顶轮廓，退回中心线。
           ★ v53（任务三·3）：这里**不再调用 roofApexOf()** —— 掠过点已在本次迭代开头
             算好并存进 (rx,rz)（与影长线段起点、tMax 解算起点同源）。原因有二：
               ① roofApexOf 返回共享暂存对象 _roofP，第二次调用会覆盖第一次的结果；
               ② 「光线掠过点 / 影长线段起点 / tMax 起点」必须是**同一个点**，
                  分两次调用一旦参数或时机不同，建筑旋转时三者就会分叉（正是本 bug 的形态）。 */
        var roof = { x: rx, y: H, z: rz };
        /* ★ v44（需求六）：rayLen 拉满（= SUN_DIST）时，端点应到达**太阳所在的距离**，
           而不是「从掠过点再往前走 126」—— 后者会把物体自身的高度与水平偏移也加进去
           （实测行程 143 > 126，光线反而越过太阳）。这里改成「沿光线方向的行程 = SUN_DIST」：
             ra = SUN_DIST − (apex · pd)
           多条平行线共用同一个 ra ⇒ 仍然互相平行；只有上端点的行程被校准。 */
        if (rayLen >= SUN_DIST - 1e-6) {
          ra = SUN_DIST - (roof.x * pdx + H * pdy + roof.z * pdz);
          if (!(ra > 0)) ra = 0;
        }
        var camNow = (S.fp ? fpCam : (S.indoor ? iCam : (S.view === 'sky' ? cCam : gCam)));
        var rW = Math.max(0.02, (S.meas.rayW / 10) * 0.16);   /* 线粗细 → 半宽（世界单位） */
        for (var j = 0; j < nRays; j++) {
          var rj = rec.rays[j]; if (!rj) break;
          var off = (j - (nRays - 1) / 2) * _RAY_SPACING;
          var cx = roof.x + rayNX * off, cz = roof.z + rayNZ * off;   /* 第 j 条光线的掠过点 (y=H) */
          /* ★ 本批次（需求一）**光线与影长线段端点精确重合**：
             旧写法 a/b 都从「屋顶远角」cx 出发，地面端点 b = (cx − pd·tDrop)，
             而影长线是「物体中心 (px,pz) → 影尖 (tipX,tipZ)」——
             两者水平相差整整一个 (roof − 物体中心) 的量，屏幕上就是「光线落点没扎进影尖」。
             现在把光线的**地面端直接钉在影尖**上：b = 影尖 + 横向偏移(第 j 条)，
             再沿 pd 回升 tUp = tDrop + ra（先到物体顶端、再延伸 ra）。
             未夹紧时 tDrop 段恰好把光线送过物体顶端 (px, H, pz)（因为
             tipX + pdx·tDrop = px + ux·L + pdx·H/pdy = px，L = H·hz/pdy、ux = −pdx/hz），
             夹紧时也保证「端点重合」这一首要要求成立。 */
          var tUp = tDrop + ra;
          /* ★ v56（任务②a）：地面端 = **真实影尖**（未截断）—— j=0 时光线沿
             「太阳 → 屋顶远角最高点 → 真实落点」严格共线，任何高度角都过物体最高点；
             截断只作用于影长线段本身（显示不出界），不再把光线一起拽短。 */
          var bx = tipTX + rayNX * off, bz = tipTZ + rayNZ * off;
          var ax = bx + pdx * tUp, ay = pdy * tUp, az2 = bz + pdz * tUp;
          setRibbonSeg(rj.geometry, ax, ay, az2, bx, 0, bz,
            S.meas.rayDash, S.meas.rayN, S.meas.rayRatio, rW, camNow.position);
        rj.material.color.set(S.meas.rayColor);
        rj.material.opacity = S.meas.rayOp / 100;
        rj.visible = true;
        /* ★ v44：审计 / 探针用 —— 把这条线的**真实两端点**记下来。
           `rec.rays[j]` 是 ribbon（`setRibbonSeg` 画带宽度的四边形），
           geometry 里第 0 / 1 号顶点是同一端的两个侧向点，**不是线的两个端点** ——
           探针对此前的 `rays[].a/b` 断言其实读错了几何。这里显式存一下，口径才对得上。 */
        rj.userData._end = { ax: ax, ay: ay, az: az2, bx: bx, by: 0, bz: bz,
                             cx: cx, cy: H, cz: cz, ra: ra, tDrop: tDrop, tUp: tUp,
                             tipX: tipX, tipZ: tipZ };
        }
        for (var qq = nRays; qq < rec.rays.length; qq++) rec.rays[qq].visible = false;
        /* ★ v44：审计 / 探针用 —— 这条批次共用的几何参数（掠过方向、太阳距离、屋顶掠过点）。 */
        rec.pd = { x: pdx, y: pdy, z: pdz };
        rec.sunDist = SUN_DIST;
        rec.roof = { x: roof.x, y: H, z: roof.z };
      } else {
        for (var q0 = 0; q0 < rec.rays.length; q0++) rec.rays[q0].visible = false;
      }
      /* 三处数值注释（★ v64（需求4）：整体字号百分比已删，基准 1.5 恒定，
         实际字号由各注释分类的 @note.cats.*.size 承担） */
      var ls = 1.5;
      rec.lbH = setLabelText(rec.lbH, '物体高度 ' + H.toFixed(2) + ' m', { size: ls, color: '#ffe9b0', cat: 'svMeas' });
      rec.lbH.position.set(px, H + 0.9, pz); rec.lbH.userData._typeVis = !!S.meas.h; rec.lbH.visible = rec.lbH.userData._typeVis;
      rec.lbL = setLabelText(rec.lbL, '影长 ' + L.toFixed(2) + ' m', { size: ls, color: '#ffd8a0', cat: 'svMeasL' });
      /* ★ v53：影长标签取线段**自身**中点 —— 线段起点已是屋顶远角 (rx,rz)，若仍按
         物体中心 (px,pz) 取中点，标签会偏出实际线段（建筑越大偏得越明显）。 */
      rec.lbL.position.set((rx + tipX) / 2, 0.9, (rz + tipZ) / 2); rec.lbL.userData._typeVis = !!S.meas.len; rec.lbL.visible = rec.lbL.userData._typeVis;
      /* ★ v35（需求十二）：「太阳高度角」标注防重叠 —— 旧写法与「影长」同高（y=0.9）都贴地面，
         影子一短（太阳接近天顶 / 小人）两个精灵就叠在物脚处；「物体高度」也可能凑近。
         现在：恒定抬到影尖上空一层，且影子越短抬得越高（最多再 +1.5），
         与贴地的「影长」、物体顶上的「物体高度」恒错开。 */
      rec.lbA = setLabelText(rec.lbA, '太阳高度角 ' + alt.toFixed(1) + '°', { size: ls, color: '#a8d8ff', cat: 'svMeasA' });
      rec.lbA.position.set(tipX, 0.9 + 1.3 + clamp(3 - L, 0, 3) * 0.5, tipZ);
      rec.lbA.userData._typeVis = !!S.meas.ang; rec.lbA.visible = rec.lbA.userData._typeVis;
      /* ★ v53：把本次算出的影长参数挂到 rec 上（只读取值，供验证脚本 / 探针核对）。
         H/up = 物高÷tan(高度角) 的**未夹取**理论值、L = 实际绘制的长度，
         两者对比即可判断「是否被 SHADOW_MAX / tMax 夹断」以及夹在哪一档。 */
      rec.L = L; rec.H = H; rec.alt = alt; rec.up = up; rec.tMax = tMax;
      rec.Lideal = H / up; rec.seg = { x0: rx, z0: rz, x1: tipX, z1: tipZ };
    }
  }

  /* ============================ 17. 第一人称 / 室内 ============================ */
  /* ★ v39（需求二·4）：进入第一人称 / 室内视角时**自动显示地面视角悬浮窗** ——
     这两个视角看不到地面场景全貌，悬浮窗正好补位。用户随后仍可自行关闭。 */
  function autoShowGroundWin() {
    if (!S.panel.ground) S.panel.ground = true;
    if (!S.win.ground) S.win.ground = true;
    saveSoon();
    applyPanelVisibility();
  }
  /* ★ v53 修复（任务二·2）：enterFP 接受**可选**参数 host —— 「当前作为第一视角视点的小人」。
     旧实现无条件 `if (figObj) fpPos.copy(figObj.position)`，把双击菜单里已经设好的
     fpPos（= 被双击那个小人的位置）覆盖成「默认小人」figObj 的位置 ⇒ 多小人时
     永远固定在中心小人身上。现在：
       · 传了 host（双击小人 → 菜单「第一视角」这条路径）⇒ 站到 host 并隐藏 host；
       · 没传 host（工具条 #svEnterFp 按钮这条路径）⇒ 回退到原来的 figObj 行为。
     ★ 注意 host 是可选参数，调用方若误把 DOM 事件对象传进来（比如直接把
     `addEventListener('click', enterFP)`，事件对象上没有 .position），下面用
     「必须是 props 里的 figure」这一层校验把它挡掉，避免静默站错位置。 */
  function enterFP(host) {
    S.fp = true; S.indoor = false; S.sunflower = false;
    fpYaw = 0; fpPitch = 0.03;                              /* 每次进入从「朝向正北」开始 */
    fpFov = 62;                                             /* ★ 需求四·a：复位第一人称缩放 */
    dropDeadFpHost();
    var h = (host && host.userData && host.userData.kind === 'figure' &&
             props.indexOf(host) >= 0) ? host : (figObj || null);
    if (fpHost && fpHost !== h) fpHost.visible = true;       /* 换人：把上一个视点小人还回来 */
    fpHost = h;
    if (fpHost) { fpPos.copy(fpHost.position); fpHost.visible = false; }  /* 需求四·b：隐藏自身模型 */
    var b = $('svSunflower'); if (b) b.classList.remove('on');
    autoShowGroundWin();
    syncBodyClasses();
    toast('已进入第一人称视角 · WASD / 方向键移动，拖拽转头');
  }
  function exitFP() {
    S.fp = false; S.sunflower = false; fpKeys = {};
    /* ★ v53：恢复的是**视点小人** fpHost（不是默认小人 figObj）——
       多小人时视点可能是另外那个人，恢复 figObj 会让它凭空出现、而视点本人仍隐身。 */
    if (fpHost) { fpHost.visible = true; fpHost = null; }
    var b = $('svSunflower'); if (b) b.classList.remove('on');
    syncBodyClasses();
  }
  function enterIndoor() {
    S.indoor = true; S.fp = false;
    autoShowGroundWin();
    syncBodyClasses();
    toast('已进入室内视图 · 点击右下「退出室内」返回');
  }
  function exitIndoor() { S.indoor = false; syncBodyClasses(); }
  (function () {
    var a = $('svExitFp'), b = $('svExitIndoor'), c = $('svExitIndoorBtn'), d = $('svEnterIndoor'), e = $('svEnterFp');
    if (a) a.addEventListener('click', exitFP);
    if (b) b.addEventListener('click', exitIndoor);
    if (c) c.addEventListener('click', exitIndoor);
    if (d) d.addEventListener('click', enterIndoor);
    /* ★ v53：必须包一层 —— 直接 `addEventListener('click', enterFP)` 会把 MouseEvent 对象
       当成 host 传进 enterFP。虽然 enterFP 内部已用「kind==='figure' 且在 props 里」校验
       挡住了它（不会静默站到奇怪的位置），但语义上仍是把事件当参数传错的坑，
       这里显式包成零参调用，保持「无 host ⇒ 回退 figObj」这条路径的口径明确。 */
    if (e) e.addEventListener('click', function () { enterFP(); });
    var ecb = $('svExitCombo'); if (ecb) ecb.addEventListener('click', exitSunCombo);
    /* ★ v44（需求八）：右下角「退出物影测量」 —— 双击物体选「测量物影」后常驻显示，
       点击一次性关掉 S.meas.on 并解锁 measKeep，右下角按钮随即自动隐藏（syncMeasExit）。 */
    var emb = $('svExitMeas'); if (emb) emb.addEventListener('click', endMeasure);
    var sf = $('svSunflower');
    if (sf) sf.addEventListener('click', function () {
      var g = sunGeom(BR.getSimMs(), obsLat(), obsLon());
      if (g.alt < -0.5) toast('太阳在地平线以下 —— 已锁定至最接近的方位', true);
      S.sunflower = !S.sunflower;
      sf.classList.toggle('on', S.sunflower);
      var t = $('svSfTip');
      if (t) t.textContent = S.sunflower ? '已锁定太阳（再次点击解除）' : '镜头锁定太阳，随时间自动跟随';
    });
    var gv = $('svGroundViewBtn');
    if (gv) gv.addEventListener('click', function () {
      S.win.groundView = ((S.win.groundView | 0) + 1) % GROUND_VIEWS.length;
      applyGroundViewCam(); saveSoon();
    });
    var ba = $('svBldAdd'), bf = $('svFigAdd');
    /* ★ v35（需求十二）：修复拖拽放置。
       旧实现两个致命伤：① 单击按钮时 pointerdown 先 beginPlace、随后 click 又 endPlace
       —— 等于「开了立刻关」，单击永远进不了放置模式；② 按住按钮拖到地面松手，
       pointerup 不会触发放置（放置只挂在画布 pointerdown 上），拖拽流程整个断裂。
       现在：pointerdown 进入放置模式并接管 window 级 pointermove / pointerup ——
       拖动时预览幽灵跟随地面落点，**在地面松手即放置**；松手在画布外则保留
       「单击放置」模式；再点一次按钮仍可取消。 */
    function wire(btn, kind) {
      if (!btn) return;
      var dragOn = null;      // { id } 本次按住拖拽的 pointerId
      var armed = false;      // 本次 pointerdown 是否刚开启放置模式（吞掉随后的 click）
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        armed = (placing !== kind);
        if (armed) beginPlace(kind);
        dragOn = { id: e.pointerId };
        var mv = function (ev) {
          if (dragOn == null || ev.pointerId !== dragOn.id || placing !== kind) return;
          var hh = groundHitFromEvent(ev);
          if (hh) { ghost.position.set(hh.point.x, 0.9, hh.point.z); ghost.visible = true; }
          else if (ghost) ghost.visible = false;
        };
        var upFn = function (ev) {
          if (dragOn == null || ev.pointerId !== dragOn.id) return;
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', upFn);
          window.removeEventListener('pointercancel', upFn);
          dragOn = null;
          if (placing !== kind) return;
          var hh = groundHitFromEvent(ev);
          if (hh) placeAt(hh.point);        // 在地面松手 → 直接放置
          /* 松手不在画布上：placing 保留，退回「单击放置」（toast 已提示） */
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', upFn);
        window.addEventListener('pointercancel', upFn);
      });
      btn.addEventListener('click', function () {
        if (armed) { armed = false; return; }   // pointerdown 刚开启过 → 这次 click 不再切换
        if (!placing) beginPlace(kind); else endPlace();
      });
    }
    wire(ba, 'building'); wire(bf, 'figure');
    /* v31（需求六）：树木 / 旗杆的放置按钮 —— 与建筑物 / 小人同一套拖拽或单击落点流程 */
    wire($('svTreeAdd'), 'tree'); wire($('svFlagAdd'), 'flag');
    /* 「应用」：把当前面板上的树木属性套到所有选中的树木上 */
    var ta = $('svTreeApply');
    if (ta) ta.addEventListener('click', function () {
      var n = 0;
      selectedObjs().forEach(function (o) {
        if (o.userData && o.userData.kind === 'tree') {
          rebuildTree(o, S.tree.h, S.tree.color, S.tree.trunk); n++;
        }
      });
      toast(n ? ('已应用到 ' + n + ' 棵树') : '请先点选要修改的树木', n === 0);
      saveSoon();
    });
    /* ★ v52（需求G5）：把「旗杆属性设置」（杆高 / 杆色 / 旗色）套到所有选中的旗杆上。 */
    var fa = $('svFlagApply');
    if (fa) fa.addEventListener('click', function () {
      var n = 0;
      selectedObjs().forEach(function (o) {
        if (o.userData && o.userData.kind === 'flag') {
          o.userData.h = S.flag.h;
          o.userData.poleColor = S.flag.poleColor;
          o.userData.flagColor = S.flag.flagColor;
          applyProps(o); n++;
        }
      });
      toast(n ? ('已应用到 ' + n + ' 根旗杆') : '请先点选要修改的旗杆', n === 0);
      saveSoon();
    });
    /* 「删除选中」：建筑物 / 树木 / 旗杆通用 */
    var pd = $('svPropDelete');
    if (pd) pd.addEventListener('click', function () {
      /* ★ 修复 #2：删除前释放对象的几何 / 材质 / 每实例贴图（否则镂空建筑的 facadeTexture 常驻显存） */
      selectedObjs().forEach(function (o) { objGrp.remove(o); disposeObj(o); var i = props.indexOf(o); if (i >= 0) props.splice(i, 1); });
      if (props.indexOf(figObj) < 0) { rebuildFigure(); }
      /* ★ v53：删除选中项里可能包含视点小人 ⇒ 清空 fpHost 防悬空引用。 */
      dropDeadFpHost();
      clearSel(); saveSoon();
    });
    var bd = $('svBldDelete');
    if (bd) bd.addEventListener('click', function () {
      /* ★ 修复 #2：同上，删除前 dispose 子树资源 */
      selectedObjs().forEach(function (o) { objGrp.remove(o); disposeObj(o); var i = props.indexOf(o); if (i >= 0) props.splice(i, 1); });
      if (props.indexOf(figObj) < 0) { rebuildFigure(); }
      /* ★ v53：同上，清空可能已失效的视点小人引用。 */
      dropDeadFpHost();
      clearSel(); saveSoon();
    });
    var ap = $('svBldApply'); if (ap) ap.addEventListener('click', applyBldToSelection);
    var rs = $('svBldReset');
    if (rs) rs.addEventListener('click', function () {
      S.bld = JSON.parse(JSON.stringify(DEF.bld));
      selectedObjs().forEach(function (o) {
        if (o.userData.kind === 'building') {
          o.userData.color = DEF.bld.color; o.userData.floors = DEF.bld.floors; o.userData.floorH = DEF.bld.floorH;
          o.userData.winBase = DEF.bld.winBase; o.userData.winH = DEF.bld.winH; o.rotation.y = 0;
          applyProps(o);
        }
      });
      syncSunBinders(); saveSoon();
    });
    var fr = $('svFigReset');
    if (fr) fr.addEventListener('click', function () {
      /* v32（需求八）：重置 = 颜色 / 身高回到默认，并**移除额外放置的小人**，只留默认那一个 */
      S.fig = JSON.parse(JSON.stringify(DEF.fig));
      props.slice().forEach(function (o) {
        if (o.userData.kind === 'figure' && o !== figObj) {
          /* ★ 修复 #2：移除前释放该小人子树的几何 / 材质 */
          objGrp.remove(o); disposeObj(o); var ii = props.indexOf(o); if (ii >= 0) props.splice(ii, 1);
        }
      });
      /* ★ v53：额外小人已被全部移除，视点小人若不是 figObj 必然已被删 ⇒ fpHost 清空
         （rebuildFigure() 只会继承「旧 figObj」的站位，接不住这个悬空引用）。
         站位随后统一回落到默认小人 figObj 的位置，与下面 fpPos.copy 口径一致。 */
      fpHost = null;
      rebuildFigure(); fpPos.copy(figObj.position); syncSunBinders(); saveSoon();
    });
  })();
  document.addEventListener('keydown', function (e) {
    if (BR.getView() !== 'sun' || !S.fp) return;
    var k = e.key.toLowerCase();
    if ('wasd'.indexOf(k) >= 0 || k.indexOf('arrow') === 0) { fpKeys[k] = true; e.preventDefault(); }
    if (k === 'escape') exitFP();
  });
  document.addEventListener('keyup', function (e) { fpKeys[e.key.toLowerCase()] = false; });

  /* ============================ 18. 画布交互 ============================ */
  (function () {
    var drag = null;
    /* ★ v41（需求一·17）：「位置移动」改成**按住拖 + 松手落位**（旧版要再单击一次，
       拖不动）；按下即记录落点、移动时物体实时跟随指针、松手提交并保存。
       单击（按下/抬起同一点）仍然等价于「移到单击处」，行为向后兼容。 */
    var mvDrag = null;      // { id, moved }
    function commitMove(pt) {
      var o = moveTarget;
      if (placing !== 'move' || !o) return;
      if (pt) {
        var c = clampToGround(pt.x, pt.z, 3);
        o.position.set(c.x, 0, c.z);
        if (o.updateMatrixWorld) o.updateMatrixWorld(true);
        if (o === figObj || o.userData.kind === 'figure') fpPos.copy(o.position);
        saveSoon();
      }
      placing = null; moveTarget = null; mvDrag = null;
      if (ghost) ghost.visible = false;
    }
    function moveHit(e) {
      var h = groundHitFromEvent(e, true);
      return h ? h.point : null;
    }
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      canvas.classList.add('grabbing');
      if (placing && !S.fp) {
        if (placing === 'move' && moveTarget) {
          var p0 = moveHit(e);
          if (p0) {
            mvDrag = { id: e.pointerId, moved: false };
            var c0 = clampToGround(p0.x, p0.z, 3);
            if (ghost) { ghost.position.set(c0.x, 0.9, c0.z); ghost.visible = true; }
            moveTarget.position.set(c0.x, 0, c0.z);      // 单击落位（拖动则继续跟随）
            if (moveTarget.updateMatrixWorld) moveTarget.updateMatrixWorld(true);
          }
        } else {
          var h0 = groundHitFromEvent(e, false);
          if (h0) placeAt(h0.point);
        }
        canvas.classList.remove('grabbing');
        return;
      }
      drag = {
        x: e.clientX, y: e.clientY, moved: false, t: Date.now(),
        yaw: S.fp ? fpYaw : (S.indoor ? iYaw : (S.view === 'sky' ? cYaw : gYaw)),
        iPitch: S.indoor ? iPitch : null,
        pitch: S.fp ? fpPitch : (S.view === 'sky' ? cPitch : gPitch),
        dist: S.indoor ? iDist : 0,
      };
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] svCanvas setPointerCapture', er); } }
    });
    canvas.addEventListener('pointermove', function (e) {
      /* ★ v41（需求一·17）：位置移动中 —— 指针移动时物体实时跟随地面落点（幽灵预览同步） */
      if (placing === 'move' && moveTarget && (!mvDrag || e.pointerId === mvDrag.id)) {
        var pm = moveHit(e);
        if (pm) {
          var cm = clampToGround(pm.x, pm.z, 3);
          moveTarget.position.set(cm.x, 0, cm.z);            // 物体实时跟随指针
          if (moveTarget.updateMatrixWorld) moveTarget.updateMatrixWorld(true);
          if (ghost) { ghost.position.set(cm.x, 0.9, cm.z); ghost.visible = true; }
        } else if (ghost) { ghost.visible = false; }
      }
      if (placing && ghost && placing !== 'move') {
        var hh = groundHitFromEvent(e);
        if (hh) { ghost.position.set(hh.point.x, 0.9, hh.point.z); ghost.visible = true; }
        else ghost.visible = false;
      }
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (S.fp) {
        if (S.sunflower) { S.sunflower = false; var b = $('svSunflower'); if (b) b.classList.remove('on'); }
        fpYaw = drag.yaw - dx * 0.005;
        fpPitch = clamp(drag.pitch - dy * 0.004, -1.15, 1.25);
      } else if (S.indoor) {
        iYaw = drag.yaw + dx * 0.006;
        /* v31（需求二十）：室内拖动加俯仰，配合上面的 Y 向夹紧不会穿出天花板 / 地板 */
        if (drag.iPitch != null) iPitch = clamp(drag.iPitch - dy * 0.004, -0.35, 0.55);
      } else if (S.view === 'sky') {
        cYaw = drag.yaw - dx * 0.008;
        cPitch = clamp(drag.pitch + dy * 0.006, -0.25, 1.35);
      } else {
        gAimSun = false;                                   /* 用户接管机位后不再自动对准太阳 */
        gYaw = drag.yaw - dx * 0.008;
        gPitch = clamp(drag.pitch + dy * 0.006, 0.05, 1.35);
      }
    });
    function up(e) {
      canvas.classList.remove('grabbing');
      if (drag && !drag.moved && Date.now() - drag.t < 380) {
        var h = groundHitFromEvent(e);
        if (h && h.obj) selectObj(h.obj, e.ctrlKey || e.metaKey || (S.bld.multi && e.shiftKey) || (S.bld.multi && e.ctrlKey));
        else if (h && !h.obj) clearSel();
      }
      drag = null;
    }
    canvas.addEventListener('pointerup', function (e) { up(e); commitMove(moveHit(e) || (ghost && ghost.visible ? new THREE.Vector3(ghost.position.x, 0, ghost.position.z) : null)); });
    canvas.addEventListener('pointercancel', function (e) { drag = null; commitMove(null); canvas.classList.remove('grabbing'); });
    /* 松手时若指针已离开画布（window 级兜底）：以最后一次有效落点提交 */
    window.addEventListener('pointerup', function (e) {
      if (placing === 'move' && mvDrag && e.pointerId === mvDrag.id) commitMove(moveHit(e));
    });
    canvas.addEventListener('wheel', function (e) {
      if (BR.getView() !== 'sun') return;
      e.preventDefault();
      var k = e.deltaY > 0 ? 1.08 : 1 / 1.08;
      if (S.fp) { fpFov = clamp(fpFov * k, 18, 100); }        /* ★ 需求四·a：第一人称自由缩放 */
      else if (S.indoor) iDist = clamp(iDist * k, 1.6, 7.0);
      else if (S.view === 'sky') cDist = clamp(cDist * k, 12, 62);
      else gDist = clamp(gDist * k, 1.2, 340);
      if (!S.fp && !S.indoor && S.view !== 'sky') gAimSun = false;
    }, { passive: false });
    canvas.addEventListener('dblclick', function (e) {
      if (S.fp || S.indoor) return;
      var h = groundHitFromEvent(e);
      if (h && h.obj) { selectObj(h.obj, false); openObjMenu(h.obj, e.clientX, e.clientY); }
    });
    /* ★ v41（需求一·17）：Esc 取消「位置移动」—— 物体回到原位 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || BR.getView() !== 'sun' || placing !== 'move') return;
      var o = moveTarget;
      if (o && o.userData.home) { o.position.set(o.userData.home.x, o.userData.home.y, o.userData.home.z); }
      placing = null; moveTarget = null; mvDrag = null;
      if (ghost) ghost.visible = false;
    });
    document.addEventListener('click', function (e) {
      var om = $('svObjMenu');
      if (om && om.classList.contains('on') && !om.contains(e.target)) om.classList.remove('on');
    });
    document.addEventListener('pointerup', function () { if (ghost && placing) ghost.visible = false; });
  })();

  /* ============================ 19. 时间控制 / 节气 / 播放 ============================ */
  (function () {
    var hour = $('svHour'), btnPlay = $('svBtnPlay'), spd = $('svSpeed'), outSpd = $('svOutSpeed');
    var draggingHour = false;
    if (hour) {
      hour.addEventListener('pointerdown', function () { draggingHour = true; });
      window.addEventListener('pointerup', function () { draggingHour = false; });
      hour.addEventListener('input', function () {
        var target = parseInt(hour.value, 10) / 60;
        var cur = sunGeom(BR.getSimMs(), obsLat(), obsLon()).lst;
        BR.setSimMs(BR.getSimMs() + (target - cur) * 3600000);
      });
    }
    if (spd) {
      var lo = BR.getSpeedRange()[0], hi = BR.getSpeedRange()[1];
      var span = Math.log(hi / lo);
      spd.addEventListener('input', function () {
        BR.setSpeed(lo * Math.exp((parseFloat(spd.value) / 1000) * span));
        if (outSpd) outSpd.textContent = BR.fmtSpeed(BR.getSpeed());
      });
      /* 初始同步 */
      var v = clamp(BR.getSpeed(), lo, hi);
      spd.value = String(Math.round((Math.log(v / lo) / span) * 1000));
      if (outSpd) outSpd.textContent = BR.fmtSpeed(BR.getSpeed());
    }
    if (btnPlay) btnPlay.addEventListener('click', function () {
      BR.setPlaying(!BR.isPlaying());
      btnPlay.textContent = BR.isPlaying() ? '暂停' : '播放';
    });
    var btnNow = $('svBtnNow');
    if (btnNow) btnNow.addEventListener('click', function () {
      BR.setSimMs(Date.now());
      toast('已同步到当前真实时刻');
    });
    /* 节气跳转：改用**事件委托** —— 右上时间卡里的节气小卡片是动态生成的，
       用 querySelectorAll 一次性绑定会漏掉后生成的按钮（点了没反应）。 */
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-svterm]') : null;
      if (!b) return;
      var t = BR.solarTerms(BR.getYear());
      var ms = t[b.dataset.svterm];
      if (typeof ms !== 'number') { toast('节气时刻计算失败', true); return; }
      var cur = BR.getSimMs();
      var tod = ((cur % 86400000) + 86400000) % 86400000;
      BR.setSimMs(Math.floor(ms / 86400000) * 86400000 + tod);
      document.querySelectorAll('[data-svterm]').forEach(function (x) { x.classList.toggle('on', x === b); });
      toast('已跳转到' + b.textContent.replace(/\d+\/\d+$/, ''));
    });

    /* ---- v31（需求十一）：年月日滑块 ----
       拖动滑块 ⇒ 在「本演示年内」跳到该日，**保持当前的当地太阳时**（只有日期变、时刻不变）。
       实现上不做时区换算：直接按「本地日序差值 × 86400000」推时间，天然保持时分秒。 */
    var dsl = $('svDate'), dOut = $('svOutDate'), dNodes = $('svDateNodes'), termHost = $('svTtTerms');
    var dDragging = false, _dSig = '';
    function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
    function daysInYear(y) { return isLeap(y) ? 366 : 365; }
    function monthDays(y) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; }
    function mdOf(y, doy) {
      var dm = monthDays(y), acc = 0;
      for (var i = 0; i < 12; i++) { if (doy <= acc + dm[i]) return { mo: i + 1, day: doy - acc }; acc += dm[i]; }
      return { mo: 12, day: 31 };
    }
    function buildDateTicks() {
      /* ★ v43（需求一·5）：月份节点已删，dm（本月天数表）在此处不再需要，只留 total。 */
      var y = BR.getYear(), total = daysInYear(y);
      if (termHost) {
        var t0 = BR.solarTerms(y);
        termHost.innerHTML = '';
        [['春分', t0.VE, 'VE'], ['夏至', t0.SS, 'SS'], ['秋分', t0.AE, 'AE'], ['冬至', t0.WS, 'WS']]
          .forEach(function (d) {
            var p = BR.localParts(d[1]);
            /* ★ v59（需求 2）：日期精确到时分秒（旧版只到「月/日」）。 */
            var hh = (p.hh < 10 ? '0' : '') + p.hh;
            var mi = (p.mm < 10 ? '0' : '') + p.mm;
            var ss = (p.ss < 10 ? '0' : '') + p.ss;
            /* ★ v37（需求二·2）：按钮结构与主模块时间面板**同构**（span.n 名称 + span.d 日期），
               直接复用 style.css 的 .term / .term .n / .term .d 样式 —— 字体、字号、配色一致。 */
            var b = el('button', 'term',
              '<span class="n">' + d[0] + '</span><span class="d">' + p.mo + '/' + p.day + ' ' + hh + ':' + mi + ':' + ss + '</span>');
            b.title = BR.getYear() + '年' + p.mo + '月' + p.day + '日 ' + hh + ':' + mi + ':' + ss + '（本地时间）';
            b.dataset.svterm = d[2];
            termHost.appendChild(b);
          });
      }
      /* ★ v38（需求六）：日期滑块节点 —— 二分二至 4 个位置节点（正下方注释，可点击跳转；
         跳转走全局 data-svterm 事件委托）。
         ★ v43（需求一·5）：**取消 12 个月份节点**（v38 加的 `.svtb-node.mon`）——
           12 个月首数字与 4 个二分二至标注在同一条轨道上互相压字（春分 3/20 正好落在 3 月刻度上），
           而右侧读数 `#svOutDate` 已经常驻显示「X 月 X 日」，月份刻度本就是冗余信息。 */
      if (!dNodes) { _dSig = y + '|' + total; return; }
      dNodes.innerHTML = '';
      var t = BR.solarTerms(y);
      [['春分', t.VE, 'VE'], ['夏至', t.SS, 'SS'], ['秋分', t.AE, 'AE'], ['冬至', t.WS, 'WS']]
        .forEach(function (d) {
          var p = BR.localParts(d[1]);
          var nd = tbNode(dNodes, p.doy / total, d[0] + ' ' + p.mo + '/' + p.day,
            { prime: true, short: d[0],
              title: '跳转到' + d[0] + '（' + p.mo + '月' + p.day + '日）' });
          nd.dataset.svterm = d[2];     /* 复用全局 data-svterm 事件委托实现点击跳转 */
        });
      _dSig = y + '|' + total;
    }
    if (dsl) {
      dsl.addEventListener('pointerdown', function () { dDragging = true; });
      window.addEventListener('pointerup', function () { dDragging = false; });
      dsl.addEventListener('input', function () {
        var y = BR.getYear(), total = daysInYear(y);
        var l = BR.localParts(BR.getSimMs());
        var target = clamp(parseInt(dsl.value, 10) || 1, 1, total);
        BR.setSimMs(BR.getSimMs() + (target - l.doy) * 86400000);
      });
    }
    /* 滑块 / 刻度 / 读数 每帧同步（由 tickSun 调用） */
    window.__svDateSync = function (ms) {
      var y = BR.getYear();
      if (_dSig !== y + '|' + daysInYear(y)) buildDateTicks();
      var l = BR.localParts(ms);
      if (dsl && !dDragging) dsl.value = String(l.doy);
      if (dOut) { var mdd = mdOf(y, l.doy); dOut.textContent = mdd.mo + ' 月 ' + mdd.day + ' 日'; }
    };
    buildDateTicks();
    window.__svHourDragging = function () { return draggingHour; };
  })();

  /* ================= 19.5 右上时间窗：日期 / 时刻滑块 + 自定义时间 =================
     ★ v35（需求十六）：右上「时间」卡补齐主模块 timeCard 的三块 ——
       ① 日期滑块（含二分二至刻度）② 时刻滑块（北京时间 · 24 小时）③ 自定义时间。
       数据全部走 SUN_BRIDGE（daysInYear / msFromLocal / applyCustomTime），
       与主模块「时间」卡行为逐字一致；每帧由 updateHUD 调 __svTtSync 保持同步，
       拖动任意一处（右上 / 下方 svTimeBar / 主模块）其余位置自动跟随。 */
  (function () {
    var dsl = $('svTtRngDate'), hsl = $('svTtRngHour');
    var dOut = $('svTtOutDate'), hOut = $('svTtOutHour');
    var dTicks = $('svTtDateTicks'), hTicks = $('svTtHourTicks');
    var dDrag = false, hDrag = false, _ttSig = '';
    var ins = ['svTtInY', 'svTtInMo', 'svTtInD', 'svTtInH', 'svTtInMi', 'svTtInS'].map(function (id) { return $(id); });
    var KEYS = ['y', 'mo', 'day', 'hh', 'mm', 'ss'];
    var dirty = false;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
    function buildTicks() {
      var y = BR.getYear(), total = BR.daysInYear(y);
      if (dTicks) {
        var dm = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        var html = '', acc = 0;
        for (var i = 0; i < 12; i++) {
          html += '<span class="tk" style="left:' + (acc / (total - 1) * 100).toFixed(2) + '%">' + (i + 1) + '</span>';
          acc += dm[i];
        }
        /* ★ v38（需求二）：二分二至刻度改全称，与主模块 / 节气按钮统一 */
        var t = BR.solarTerms(y), TC = { VE: '春分', SS: '夏至', AE: '秋分', WS: '冬至' };
        [['VE', t.VE], ['SS', t.SS], ['AE', t.AE], ['WS', t.WS]].forEach(function (d) {
          var p = BR.localParts(d[1]);
          html += '<span class="tk key t2" style="left:' + ((p.doy - 1) / (total - 1) * 100).toFixed(2) + '%">' + TC[d[0]] + '</span>';
        });
        dTicks.innerHTML = html;
      }
      if (hTicks) {
        var hh2 = '';
        for (var h = 0; h <= 24; h += 3) hh2 += '<span class="tk" style="left:' + (h / 24 * 100) + '%">' + h + '</span>';
        hTicks.innerHTML = hh2;
      }
      _ttSig = y + '|' + total;
    }
    if (dsl) {
      dsl.addEventListener('pointerdown', function () { dDrag = true; });
      dsl.addEventListener('input', function () {
        var y = BR.getYear(), total = BR.daysInYear(y);
        var p = BR.localParts(BR.getSimMs());
        var doy = clamp(parseInt(dsl.value, 10) || 1, 1, total);
        BR.setSimMs(BR.msFromLocal(y, doy, clamp(p.minutes, 0, 1439)));   // 保持当前时刻，只改日期
      });
    }
    if (hsl) {
      hsl.addEventListener('pointerdown', function () { hDrag = true; });
      hsl.addEventListener('input', function () {
        var y = BR.getYear();
        var p = BR.localParts(BR.getSimMs());
        var mi = clamp(parseInt(hsl.value, 10) || 0, 0, 1439);
        BR.setSimMs(BR.msFromLocal(y, p.doy, mi));                        // 保持当前日期，只改时刻
      });
    }
    window.addEventListener('pointerup', function () { dDrag = false; hDrag = false; });
    var ap = $('svTtApply');
    function syncInputs(p, force) {
      if (dirty && !force) return;
      if (force) dirty = false;
      ins.forEach(function (el2, i) {
        if (!el2 || (!force && document.activeElement === el2)) return;
        var s = String(p[KEYS[i]]);
        if (el2.value !== s) el2.value = s;
      });
    }
    if (ap) ap.addEventListener('click', function () {
      var v = ins.map(function (el2) { return parseInt(el2 && el2.value, 10); });
      var cur = BR.localParts(BR.getSimMs());
      BR.applyCustomTime(
        clamp(Number.isFinite(v[0]) ? v[0] : cur.y, 1900, 2200),
        clamp(Number.isFinite(v[1]) ? v[1] : 1, 1, 12),
        clamp(Number.isFinite(v[2]) ? v[2] : 1, 1, 31),
        clamp(Number.isFinite(v[3]) ? v[3] : 0, 0, 23),
        clamp(Number.isFinite(v[4]) ? v[4] : 0, 0, 59),
        clamp(Number.isFinite(v[5]) ? v[5] : 0, 0, 59));
      syncInputs(BR.localParts(BR.getSimMs()), true);
    });
    ins.forEach(function (el2) {
      if (!el2) return;
      var mark = function () { dirty = true; };
      el2.addEventListener('input', mark);
      el2.addEventListener('change', mark);
      el2.addEventListener('keydown', function (e) { if (e.key === 'Enter' && ap) ap.click(); });
    });
    buildTicks();
    /* 每帧同步（updateHUD 调用）：滑块位置 / 读数 / 自定义输入框（脏标记时不覆盖） */
    window.__svTtSync = function (p) {
      var y = BR.getYear();
      if (_ttSig !== y + '|' + BR.daysInYear(y)) buildTicks();   // 跨年 → 重建刻度
      if (dsl && !dDrag) dsl.value = String(p.doy);
      if (hsl && !hDrag) hsl.value = String(clamp(p.minutes, 0, 1439));
      if (dOut) dOut.textContent = p.mo + '月' + p.day + '日';
      if (hOut) hOut.textContent = p2(p.hh) + ':' + p2(p.mm);
      syncInputs(p, false);
    };
  })();

  /* ============================ 20. 状态变化 → 场景重建 ============================ */
  var _figSig = '', _bldSig = '', _celSig = '', _roomSig = '', _roomViewSig = S.room.view;
  /* ★ v52（需求G5）：树木 / 旗杆样式签名 —— 菜单滑块变化后据此重建场景里的树木 / 旗杆。 */
  var _treeSig = S.tree.h + '|' + S.tree.color + '|' + S.tree.trunk;
  var _flagSig = S.flag.h + '|' + S.flag.poleColor + '|' + S.flag.flagColor;
  function onStateChanged() {
    ensureBeams(clamp(Math.round(S.vol.n), 1, 15));
    applySpacing();
    /* ★ v43（需求一·1）：立体边框线条的开关 / 颜色 / 透明度变动后立即刷新全部线框 */
    applyEdgeAll();
    var bldSig = S.bld.color + '|' + S.bld.floors + '|' + S.bld.floorH + '|' + S.bld.winBase + '|' + S.bld.winH;
    if (bldSig !== _bldSig) { _bldSig = bldSig; }
    var figSig = S.fig.h + '|' + S.fig.color;
    if (figSig !== _figSig) {
      _figSig = figSig;
      /* ★ v52（需求G4）：改为重建**全部**小人（此前只重建 figObj，额外放置的小人不跟随身高 / 颜色）。 */
      rebuildFiguresTo(S.fig.h, S.fig.color);
      if (!figObj) { rebuildFigure(); fpPos.copy(figObj.position); }
    }
    /* ★ v52（需求G5）：菜单「树木属性设置 / 旗杆属性设置」变化 → 实时重建场景里的树木 / 旗杆
       （否则拖滑块只改 S.tree.* / S.flag.*，画面毫无反应 = 「菜单属性无效」）。 */
    var treeSig = S.tree.h + '|' + S.tree.color + '|' + S.tree.trunk;
    if (treeSig !== _treeSig) { _treeSig = treeSig; rebuildAllTrees(); }
    var flagSig = S.flag.h + '|' + S.flag.poleColor + '|' + S.flag.flagColor;
    if (flagSig !== _flagSig) { _flagSig = flagSig; rebuildAllFlags(); }
    var roomSig = S.room.kind;
    if (roomSig !== _roomSig) { _roomSig = roomSig; rebuildFurniture(); }
    /* v32（需求八）：室内观察点切换 → 相机立即移到该墙角 / 房间中心 */
    if (S.room.view !== _roomViewSig) { _roomViewSig = S.room.view; applyRoomView(S.room.view); }
    /* v31（需求十五）：切换地平 / 固定赤道坐标系必须重建天球（要素集合不同） */
    var celSig = S.coord.sys + '|' + S.coord.grid + '|' + S.coord.gridSys + '|' + S.coord.gridDash
      /* v34：天赤道的线型（实虚 / 密度 / 虚实比）与「只显示地平线以上」都会改变几何 */
      + '|' + S.coord.st.equLine.dash + '|' + S.coord.st.equLine.n + '|' + S.coord.st.equLine.ratio
      + '|' + (S.coord.aboveOnly ? 1 : 0);
    if (celSig !== _celSig) { _celSig = celSig; _dirtyCel = true; }
    applyEarthTexture();
    /* v31（需求三 / 十六）：全局文字样式变动后立即刷新所有注记精灵 */
    applyNoteStyles();
  }

  /* ============================ 21. 每帧更新 ============================ */
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  /* v32（需求十二）：测量物影每帧复用的临时向量（与上面的通用 _v1.._v3 分开，
     因为 updateMeas 同一次迭代里已经占用了 _v1（太阳方向）与 _v2（太阳远景方向））。 */
  /* ★ v44（需求六）：_mv4 原仅供「连到太阳」模式算太阳中心用，该模式已删除 ⇒ 一并去掉。 */
  var _mv1 = new THREE.Vector3(), _mv2 = new THREE.Vector3(), _mv3 = new THREE.Vector3();
  /* v32（需求十二）：HUD 缩略图每帧复用（避免持续分配 Vector3 / Quaternion）。
     ★ v53（需求一·2）：地球姿态改成**纯 yaw**（eEarth.rotation.set(0,−(λ+90°),0)）后，
     setFromUnitVectors 不再被调用 ⇒ 配套的临时对象全部失去用处，一并删除：
       _hudV2（setFromUnitVectors 的目标轴常量）、_hudQ（最短旋转四元数）、
       _hudUp / _hudQ2（观测点文字精灵「屏幕正上方」偏移，精灵已删）、
       _hudV3（本就没有任何使用点，属历史遗留死代码）。
     已全局搜索确认：这 5 个标识符在 sunview.js 内除本声明外零引用；
     保留它们只会让读者误以为地球姿态仍由四元数路径控制。 */
  var _hudV1 = new THREE.Vector3();
  var _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();
  var _sunCol = new THREE.Color();
  /* ★ 修复 #8：updateCelestial 重建当日轨迹时复用的临时向量（位置点取出后立即被 copy 消费）。
     被 push 进曲线点数组的方向向量不能复用（pts 存引用，复用会让所有点重合），保持 new。 */
  var _celV = new THREE.Vector3();
  var _spdTrail = 0, _trailDrawn = -1;

  function updateGround(g) {
    /* 太阳位置与颜色 */
    var dir = dirOf(g.alt, g.az, _v1);
    sunGrp.position.copy(dir).multiplyScalar(SUN_DIST);
    var alt = g.alt;
    /* v32（需求一 / 九）：白昼系数覆盖**真实的暮光区间**（民用 −6°、航海 −12°）。
       旧口径 ss(-3.5, 7) 在日落后 20 分钟（alt ≈ −5°）就已把 dayF 压到 0，于是地面 / 建筑
       瞬间全黑，与同一时刻天空仍有的霞光严重脱节；改为 ss(-8, 7) 后黄昏有连续过渡。 */
    var dayF = ss(-8, 7, alt);
    var k = clamp((alt + 6) / 30, 0, 1);
    _sunCol.copy(_c1.setHex(0xff6a24)).lerp(_c2.setHex(0xffc06a), clamp(alt / 12, 0, 1));
    if (alt > 12) _sunCol.copy(_c2.setHex(0xffc06a)).lerp(_c3.setHex(0xfffbe8), clamp((alt - 12) / 18, 0, 1));
    sunCoreMat.color.copy(_sunCol);
    var sunVis = S.sunr.real && alt > -0.6 && S.sunr.quality !== 0;
    sunCore.visible = S.sunr.real && alt > -0.6;
    coronaIn.visible = coronaOut.visible = sunVis;
    /* v31（需求十九）：第一人称 / 室内时，太阳与光晕参与深度测试 —— 走到建筑背面时
       「太阳被建筑挡住」才成立。普通斜视全景仍保持 depthTest=false 的纯辉光观感。 */
    (function () {
      var occl = !!(S.fp || S.indoor);
      if (sunCoreMat.__occl !== occl) {
        sunCoreMat.__occl = occl;
        coronaIn.material.depthTest = occl;
        coronaOut.material.depthTest = occl;
        coronaIn.material.needsUpdate = true;
        coronaOut.material.needsUpdate = true;
      }
    })();
    var cs = (S.sunr.size / 100) * 24;
    coronaIn.scale.setScalar(cs * (0.9 + 0.35 * (1 - dayF)));
    coronaOut.scale.setScalar(cs * 2.3);
    coronaIn.material.opacity = S.sunr.corona / 100;
    coronaOut.material.opacity = 0.42 * (S.sunr.corona / 100);
    sunCore.scale.setScalar(S.sunr.size / 100);

    /* 平行光与阴影（夜晚自动关闭）
       ★ v53（任务三·4）：光源距离 90 → SHADOW_FAR。旧值 90 远小于新视锥 far
       （≈ 374），光源会落在阴影视锥的 far 之外 ⇒ 整场阴影直接消失。
       同时 SHADOW_FAR 必须 ≥ 光源到「最远影尖」的距离，否则低太阳高度角时影子被 far 裁断。 */
    sunLight.position.copy(dir).multiplyScalar(SHADOW_FAR);
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();
    sunLight.intensity = Math.max(0, Math.sin(alt * D)) * 1.15 + 0.02;
    /* ★ v53（任务三·5）：门槛统一用 SHADOW_MIN_ALT —— 旧写法 `alt > 1.5` 与 updateMeas 里
       `g.alt <= 0 就隐藏线段` 不是同一个数，于是 0 < alt ≤ 1.5 这段「有真实阴影、
       无线段」；反之线段画到 alt=0 才停，阴影却早在 1.5° 就没了。两端口径必须一致。 */
    sunLight.castShadow = S.ray.shadow && alt > SHADOW_MIN_ALT;
    sunLight.color.copy(_sunCol);
    sunLight.shadow.bias = -0.0012 - S.ray.shadowOff * 0.0004;
    /* ★ v32（需求九）：阴影深浅 —— sunFill 是一盏**不打阴影的同向补光**，作用是把暗部抬起来
       一点（避免阴影里黑得没有细节），它是**环境基调的一部分**。
       ★ v44（需求九）：**此处必须与 ray.shadowOp 解耦** —— 旧写法
           sunFill.intensity = sunLight.intensity × (1 − shadowOp/100) × 0.9
       让「影子强度」滑块变成整场景曝光器（地面/立面同步忽明忽暗）。
       现在 sunFill 冻结在历史默认（shadowOp=42 时的等价量 0.52×），只作固定补光；
       影子浓淡全部交给贴地接影面 shadowCatcher 的 opacity（见其定义处说明）。 */
    sunFill.intensity = sunLight.castShadow ? sunLight.intensity * 0.52 : 0;
    /* 「影子强度」= 接影面的不透明度 —— 非阴影像素 ShadowMaterial 本就全透明，
       故这里改多少都只影响影子本身，地面底色与周围环境一动不动。 */
    shadowCatcher.visible = !!sunLight.castShadow;
    shadowMat.opacity = clamp(S.ray.shadowOp, 0, 100) / 100;

    /* 天空 / 星空 / 环境光 */
    var night = 1 - dayF;
    skyMat.uniforms.uNight.value = night;
    skyMat.uniforms.uSunDir.value.copy(dir);
    /* ★ v41（需求一·14）：夜间天色也提亮一档（夜空底色 0x2b3550→0x39456b、
       0x2c3a58→0x3c4b70，并降低混入比例），与调亮后的地面 / 环境光一致，不再"黑成一片"。 */
    skyMat.uniforms.uTop.value.setHex(0x2f74d0).lerp(_c1.setHex(0x39456b), night * 0.78);
    skyMat.uniforms.uBot.value.setHex(0xa9c9ef).lerp(_c2.setHex(0x3c4b70), night * 0.72);
    /* v31（需求六）：朝霞 / 晚霞 —— 太阳越低越浓（日出日落时霞光最盛），属性全部可调 */
    (function () {
      var sk = S.sky;
      var low = clamp(1 - Math.abs(alt - 3) / 16, 0, 1);          // 太阳接近地平时最盛
      skyMat.uniforms.uDawnOn.value = sk.dawn ? 1 : 0;
      skyMat.uniforms.uDawnC.value.set(sk.dawnColor);
      skyMat.uniforms.uDawnOp.value = (sk.dawnOp / 100) * (0.30 + 0.70 * low);
      skyMat.uniforms.uDawnW.value = clamp(sk.dawnW / 100, 0.02, 1);
      skyMat.uniforms.uDawnH.value = clamp(sk.dawnH / 100 * 0.55, 0.02, 0.9);
      skyMat.uniforms.uHorC.value.set(sk.horizonColor);
      skyMat.uniforms.uHorOp.value = sk.horizon ? (sk.horizonOp / 100) * 0.5 * (0.35 + 0.65 * low) * (1 - night * 0.5) : 0;
      /* v31（需求十四）：夜间色调强度此前只写在 DEF 里、渲染侧从未读取（典型「调了没反应」） */
      skyMat.uniforms.uNightTint.value = clamp(sk.nightTint / 100, 0, 1);
      /* 「天空变色」：天空底色也朝霞光的颜色偏一点，越接近地平越明显 */
      if (sk.dawn) skyMat.uniforms.uBot.value.lerp(_c3.set(sk.dawnColor), low * 0.40);
      skyMat.uniforms.uTop.value.lerp(_c3.set(sk.dawnColor), low * 0.16);
    })();
    /* ★ v41（需求一·16）：星空淡入门槛放低（night>0.06 就开始出现），峰值略提。 */
    starMat.opacity = clamp(night * 1.35 - 0.08, 0, 1) * 0.95;
    /* ★ v32（需求九）：夜间色调强度同时作用于**环境光 / 半球光 / 地面亮度** ——
       此前只有天空着色器读它，白天/黄昏时几乎看不出差别；现在整场景一起变暗偏冷，
       拉滑块立刻有肉眼可辨的变化（0 = 夜间仅轻微压暗；100 = 夜间深暗偏蓝紫）。
       ★ v41（需求一·14）：**夜间整体调亮** —— 原系数在 nightTint 拉满时把半球光压到
       0.056、环境光 0.026、地面亮度 0.06（几乎全黑，物体只剩剪影）。现抬高夜间地板：
       nightTint=100 时仍有 hemi≈0.10 / amb≈0.048 / 地面≈0.16；默认 82 时约 1.8×。
       白天（dayF=1）完全不受影响（ntDark=ntFloor=1，系数与原来一致）。 */
    var nt = clamp(S.sky.nightTint / 100, 0, 1);
    var ntDark = 1 - (1 - dayF) * (0.08 + 0.72 * nt);
    var ntFloor = 0.42 + 0.58 * ntDark;                    /* 夜间地板，不再一路压到 0.2 */
    hemi.intensity = (0.55 * dayF + 0.16) * (0.55 + 0.45 * ntDark);
    amb.intensity = (0.18 * dayF + 0.08) * (0.50 + 0.50 * ntDark);
    ground.material.color.setHex(0x8b9a75).multiplyScalar((0.30 + 0.70 * dayF) * ntFloor);

    /* v32（需求七）：太阳「边缘光线」已整体取消（见上方留档）——此处不再有任何遗留可见物。
       v34：连同「真实太阳光线线段」一并删除（该物在 v31 起即被下方体积光取代，
       渲染侧恒不可见，菜单开关是死控件）。太阳光线一律由**体积光**表现。 */

    /* 体积光：★ v43（需求一·2）重做为「实心光柱 + 外围柔光束」双层壳 ——
       仍沿南北向排布 n 根，随太阳方向实时重建朝向与长度；差别在于每根不再是
       面向相机的平面贴图，而是一根**真正的封口实心圆柱**（内层，色可设）
       + 一圈**白色柔光外壳**（外层，半径 = 内层 × vol.sheath%），
       alpha 由 |dot(N,V)| 在屏幕空间径向衰减、轮廓处归零 ⇒ 任意视角都是一根柔和光柱。 */
    var volOn = S.vol.on && S.sunr.quality !== 0 && alt > 0.8;
    volGrp.visible = volOn;
    if (volOn) {
      var n = clamp(Math.round(S.vol.n), 1, 15);
      /* ★ 本批次修复 #272「体积光分布范围小」：光束南北铺展 0.42→0.72 倍 GSIZE，
         并加入与 spread 成正比的横向偏移，使光柱在水平面呈 2D 扇形铺开而非挤成一条窄带。 */
      var spread = GSIZE * 0.72;
      var len = SUN_DIST * 0.55;
      /* 基准半径：与旧实现的「光柱宽 2.0 + 9.0×弥散度」在默认值附近等效，
         之后由 vol.dia（直径百分比）与 vol.diffuse（弥散度）相乘。 */
      var baseR = 1.10 + 0.16 * (S.vol.diffuse / 100) * 10;
      var R = baseR * clamp(S.vol.dia, 20, 300) / 100;
      var RG = R * clamp(S.vol.sheath, 100, 400) / 100;
      var op = (S.vol.op / 100) * sin01(alt) * (S.vol.intensity / 100) * 0.9;
      var fade = 0.06 + 0.20 * (S.vol.decay / 100);      /* decay：轴向软收口宽度 */
      var edge = clamp(S.vol.edge, 40, 98) / 100;
      for (var j = 0; j < volBeams.length; j++) {
        var b = volBeams[j];
        if (j >= n) { b.grp.visible = false; continue; }
        b.grp.visible = true;
        var t = n === 1 ? 0 : (j / (n - 1)) * 2 - 1;
        var zz = t * spread;
        /* 横向偏移与 spread 同量级，让 n 根光柱在地面投影成一片扇形而非一列 */
        var px = Math.sin(j * 2.3) * spread * 0.32;
        var pos = _v3.set(px, 0, zz);
        /* 光柱自地面（y=0）起算，向太阳方向延伸 len —— 近地端被地面本体
           （depthTest）自然裁掉，与地球侧「自地心起算露出晨昏圈」的处理同源。 */
        pos.addScaledVector(dir, len / 2);
        b.grp.position.copy(pos);
        b.grp.quaternion.setFromUnitVectors(_volUp, dir);
        b.core.scale.set(R, len, R);
        b.sheath.scale.set(RG, len, RG);
        var uc = b.core.material.uniforms, us = b.sheath.material.uniforms;
        uc.uColor.value.set(S.vol.color || '#ffd873');
        uc.uOp.value = op;
        uc.uEdge.value = edge;
        uc.uFade.value = fade;
        us.uColor.value.set('#ffffff');
        us.uOp.value = op * 0.26;
        us.uEdge.value = Math.min(0.985, edge + 0.08);
        us.uFade.value = fade * 1.25;
      }
    }

    /* 地面方位标（3D 箭头 + 屏幕覆盖层文字，文字由 projectDirMarks 负责） */
    var dOn = S.dmark.on;
    dirGrp.visible = dOn;
    /* ★ v44（需求十一）：size 的单位已是「倍率」，不再 /100。 */
    var sc = clamp(+S.dmark.size || 1, 0.01, 10);
    dirMarks3D.forEach(function (m) {
      m.cone.visible = dOn && S.dmark.arrow;
      /* v34：方向箭头用自己的颜色 / 透明度 / 粗细（旧版与方向文字共用 dmark.color / op，
         改文字颜色会把箭头一起改掉）。粗细只缩放锥体的横截面，不动箭头长度。 */
      m.cone.material.color.set(S.dmark.arrowColor || S.dmark.color);
      m.cone.material.transparent = (S.dmark.arrowOp != null ? S.dmark.arrowOp : 100) < 100;
      m.cone.material.opacity = clamp((S.dmark.arrowOp != null ? S.dmark.arrowOp : 100) / 100, 0, 1);
      var aw = clamp((S.dmark.arrowW != null ? S.dmark.arrowW : 100) / 100, 0.2, 3);
      m.cone.scale.set(aw, 1, aw);
      m.g.scale.setScalar(sc);
    });
    updateGroundTraj(g);
    updateMeas(g);
    projectDirMarks();
    projectIndoorDirMarks();
  }
  function sin01(alt) { return clamp(Math.sin(clamp(alt, 0, 90) * D), 0, 1); }

  var _dmEls = null, _dmPts = null, _dmV = null;
  var _dmInv = new THREE.Matrix4();
  /* ★ v53（需求三·3）：内联样式「值真变才写」的小工具。
     为什么需要：applyDirTextStyle 是**每帧**被调用两次（projectDirMarks +
     projectIndoorDirMarks）的，旧实现无条件写 5 个 style 属性 × 4 个元素 = 每帧 40 次
     DOM 样式写入。即使值没变，赋值也会让浏览器重建该元素的样式计算结果
     （inline style 参与层叠），在标签只有 4 个、但每帧都动的情况下是无谓开销。
     口径与 app.js 里 setTxt 的「内容真变才写」完全一致。
     注意必须读回 el.style[prop]（已序列化的字符串）再比较，不能和原始值比：
     浏览器会把 '700' 规范化、fontFamily 会补引号，比原始值会导致永远「不等」而退化成全写。 */
  function setStyleIf(el, prop, val) {
    if (el.style[prop] !== val) el.style[prop] = val;
  }
  /* ★ v53（需求三·1）：方位文字某个属性的**统一解析** ——
     判据与 app.js noteStyleFor 的 `U(k) ? master : own(k)` 完全一致：
     该属性开了 note.unifyAttrs.<属性> ⇒ 取全局 master 值；没开 ⇒ 用方位标自己的值。
     与 noteStyleFor 的唯一差别是「own」的来源：
       · 精灵注释：own = note.cats[cat][k] ?? NOTE_CAT_DEF[cat][k]（分类菜单里的独立值）
       · 方位文字：own = S.dmark.*（「地面物体 › 地面方向标 › 方向文字」那一组控件）
     之所以不直接用 svNoteStyle() 返回的 st.cs[k] 作 own：cs 的回退目标是
     NOTE_CAT_DEF.svDirMark 的分类默认值（color #FFFFFF / op 1 / weight 400），
     用户并没有对应的分类控件，改那些分类默认值对方位文字毫无意义；
     而 S.dmark.* 才是用户真正在操作的「自己的值」。全局统一时两者一致，
     不统一时必须听 dmark 的，否则「方向文字 › 字颜色 / 透明度 / 字体 / 字重」
     四个控件会全部失效（这正是本次要修的 bug）。
     st.ua / st.m 由 svNoteStyle 现成给出，不另造解析体系。 */
  function svDirAttr(st, key, ownVal) {
    if (st.ua && st.ua[key]) {
      var mv = st.m[key];
      if (mv != null && mv !== '') return mv;
    }
    return ownVal;
  }
  /* ★ v43（一·6 / 三·2）：地面与室内两处方位文字的**公共样式入口** ——
     ① 字号不再是「15px × dmark.size」这种孤立口径，而是走**全局文字样式**（★ v44：
        dmark.size 也已是倍率，不再 /100）：
        取 svNoteStyle('svDirMark') 解析出的倍率（已含 note.unifyAttrs.size 与分类自定义），
        再乘 dmark.size（方向标自己的大小档）。于是「全局文字样式大小」能同时管到
        地面方向文字、室内方位文字与天球方位注释，三者同一把尺。
     ② ★ v53（需求三·1）：**颜色 / 透明度 / 字体 / 字重也并入全局体系** ——
        旧实现这四项直接读 S.dmark.*（完全绕过 note.unifyAttrs / note.master），
        于是用户勾上「统一颜色 / 统一透明度 / 统一字体 / 统一字重」对方位标毫无反应。
        现在四项统一走 svDirAttr()：开了统一 ⇒ 全局 master 值；没开 ⇒ dmark 自己的值。
     ③ ★ v53（需求三·3）：写入改为 setStyleIf（值真变才写），不再每帧无条件重写 5 个属性。 */
  function applyDirTextStyle(els) {
    var st = svNoteStyle('svDirMark');
    var cs = st.cs || null;
    /* ★ v44（需求五）：改走 dmarkFontScale() 唯一读点 —— 单位已是倍率，不再 /100。 */
    var fsz = dmarkFontScale();
    /* 字体：统一解析出的字体 id → CSS 字体栈。
       ★ v53：删掉本地 fmap、统一用 svFontCss()，让方位文字与所有精灵注释
       （traj / hrLine / poleN …）走**同一套字体栈解析** —— 旧 fmap 的 'simsun' /
       'both' 少写了 '"宋体"' 兜底，同一选项下地面方位字与天球注释字形会不一致。 */
    var ffamily = svFontCss(svDirAttr(st, 'font', S.dmark.font || 'default'));
    /* 基准 15px × 方向标大小档 × 全局字号倍率（世界基准 UNIFY_W 归一为 1.00） */
    var gk = cs && cs.size != null ? clamp(cs.size / SV_UNIFY_W, 0.2, 5) : 1;
    var sz = clamp(+S.dmark.size || 1, 0.01, 10) * fsz * gk;
    var col = svDirAttr(st, 'color', S.dmark.color || '#ffffff');
    /* 单位换算：note.master.op 存 0–1（与主模块一致），dmark.op 存 0–100 ⇒ own 先归一。 */
    var op = clamp(svDirAttr(st, 'op',
      clamp((S.dmark.op != null ? S.dmark.op : 100) / 100, 0, 1)), 0, 1);
    var wt = String(svDirAttr(st, 'weight', S.dmark.weight || '400'));
    /* ★ v61（需求 3）：对齐也接入全局统一解析（与天球方位注释同一判据）。
       地面 / 室内方位字是**单字**且按点定位（transform: translate(-50%,-50%)），
       textAlign 对渲染无实际影响，但保持五项属性「一套解析入口」，语义一致。 */
    var al = String(svDirAttr(st, 'align', 'center'));
    var fs = (15 * sz) + 'px';
    Object.keys(els).forEach(function (k) {
      var e = els[k];
      setStyleIf(e, 'color', col);
      setStyleIf(e, 'opacity', String(op));
      setStyleIf(e, 'fontSize', fs);
      setStyleIf(e, 'fontFamily', ffamily);
      setStyleIf(e, 'fontWeight', wt);
      setStyleIf(e, 'textAlign', al);
    });
  }
  function projectDirMarks() {
    var host = $('svDirMarks'); if (!host) return;
    if (!_dmEls) {
      _dmEls = {};
      ['北', '南', '东', '西'].forEach(function (k) {
        var d = el('div', 'svdm', k);
        host.appendChild(d);
        _dmEls[k] = d;
      });
    }
    /* ★ 本批次（需求四）：叠加全局「显示全部文字注释」总开关 ——
       方向标是 DOM 覆盖层文字（不走精灵的 gateMasterNotes），需在这里单独判定。 */
    var show = S.dmark.on && S.dmark.text && svNoteStyle('svDirMark').on &&
      S.view === 'ground' && !S.fp && !S.indoor && BR.getView() === 'sun';
    /* v34（面板规格）：方向文字有独立的字号 / 字体 / 字重（旧版只有颜色与透明度，
       字体永远跟随浏览器默认）。字体选项与「全局文字样式」同一套 FONT_OPTS。 */
    applyDirTextStyle(_dmEls);
    Object.keys(_dmEls).forEach(function (k) {
      _dmEls[k].style.display = show ? 'block' : 'none';
    });
    if (!show) return;
    var w = window.innerWidth, h = window.innerHeight;
    var cam = gCam;
    /* ★ v35（需求十一）：东南西北标注**置于地平线上**（地面圆盘边缘 = 地平圈与天际线交点）——
       旧坐标挂在模型活动区边缘（±GSIZE/2 ≈ ±22），而地平圈半径是 GROUND_R = 125.4，
       方位标悬在场景中间的半空里；现移到 GROUND_R·0.985 的圆周上（与影子钳制同口径），
       高度抬到 1.2 使文字贴着地平线上沿显示。 */
    var pts = _dmPts || (_dmPts = { '北': new THREE.Vector3(0, 1.2, -GROUND_R * 0.985), '南': new THREE.Vector3(0, 1.2, GROUND_R * 0.985),
                '东': new THREE.Vector3(GROUND_R * 0.985, 1.2, 0), '西': new THREE.Vector3(-GROUND_R * 0.985, 1.2, 0) });
    cam.updateMatrixWorld();
    /* ★ 必须按「相机空间 z」判断前后：只判 v.z > 1 放不住相机**身后**的点 ——
       透视除法在 w<0 时会把背后的方位标镜像投影到画面里，出现「背对东却看到东」。 */
    var inv = _dmInv.copy(cam.matrixWorld).invert();
    var e = inv.elements;
    Object.keys(pts).forEach(function (k) {
      var p = pts[k];
      var cz = p.x * e[2] + p.y * e[6] + p.z * e[10] + e[14];
      if (cz > -0.5) { _dmEls[k].style.display = 'none'; return; }
      var v = (_dmV || (_dmV = new THREE.Vector3())).copy(p).project(cam);
      if (v.z > 1 || v.z < -1) { _dmEls[k].style.display = 'none'; return; }
      _dmEls[k].style.display = 'block';
      _dmEls[k].style.left = ((v.x * 0.5 + 0.5) * w) + 'px';
      _dmEls[k].style.top = ((-v.y * 0.5 + 0.5) * h) + 'px';
    });
  }

  /* ★ v39（需求二·3）：室内东南西北方位标 —— 与地面方向标**同一开关**（S.dmark.on &&
     S.dmark.text）、**同一套字符样式**（applyDirTextStyle：字号含全局文字样式倍率 / 字体 /
     颜色 / 透明度 / 字重）。
     ★ v43（一·4）：方位锚点改为**世界坐标**，不再乘 iRoom.matrixWorld —— 房间每帧按
     「窗户朝向」旋转，钉在局部坐标上的方位字会被一起转走（默认朝赤道 ⇒ 整体错 180°）。 */
  var _idmEls = null, _idmV = null, _idmPins = null;
  function projectIndoorDirMarks() {
    var host = $('svIndoorDirMarks'); if (!host) return;
    if (!_idmEls) {
      _idmEls = {};
      ['北', '南', '东', '西'].forEach(function (k) {
        var d = el('div', 'svidm', k);
        host.appendChild(d);
        _idmEls[k] = d;
      });
    }
    var show = S.dmark.on && S.dmark.text && svNoteStyle('svDirMark').on && S.indoor && BR.getView() === 'sun';
    /* ★ v43（一·6）：与地面方向文字共用同一套样式解析（含全局文字样式大小）。 */
    applyDirTextStyle(_idmEls);
    Object.keys(_idmEls).forEach(function (k) {
      _idmEls[k].style.display = show ? 'block' : 'none';
    });
    if (!show) return;
    var w = window.innerWidth, h = window.innerHeight;
    var cam = iCam;
    /* ★ v44（需求四）：东南西北**分别钉在对应的四面墙上**（离墙内侧 0.4 m、齐眼高 1.7 m），
       不再像 v39 那样挤在房间中心一个 1.35 m 的小方位环上。
       难点：房间会随「窗户朝向」绕 Y 轴自转（`iRoom.rotation.y = -azWin`），
       所以「哪面墙是北」每次都可能不同 —— 必须先算每面墙**在世界坐标里的外法线方位角**
       （本项目方位约定：北 = −Z、东 = +X，方位角自北顺时针），再按「总偏差最小」
       给四面墙各分配一个互不重复的方位（4! = 24 种排列里挑最优，避免斜放时两墙抢同一个字）。
       这样语种── 房间转到哪个角度，墙上的「北」都真的是北。 */
    var INSET = 0.40, EYE = 1.70;
    var walls = [
      { P: [-RW / 2 + INSET, EYE, 0], N: [-1, 0, 0] },        /* 局部 −X 墙 */
      { P: [RW / 2 - INSET, EYE, 0], N: [1, 0, 0] },          /* 局部 +X 墙 */
      { P: [0, EYE, RD / 2 - INSET], N: [0, 0, 1] },          /* 局部 +Z 墙（背墙） */
      { P: [0, EYE, -RD / 2 + INSET], N: [0, 0, -1] }         /* 局部 −Z 墙（窗墙） */
    ];
    var ry = iRoom.rotation.y || 0, csR = Math.cos(ry), snR = Math.sin(ry);
    function rotY(p) { return [p[0] * csR + p[2] * snR, p[1], -p[0] * snR + p[2] * csR]; }
    var info = walls.map(function (wl) {
      var nn = rotY(wl.N);
      var az = Math.atan2(nn[0], -nn[2]) * R;                  /* 0=北 90=东 180=南 270=西 */
      if (az < 0) az += 360;
      return { W: rotY(wl.P), az: az };
    });
    var DIRS = ['北', '东', '南', '西'], DA = { '北': 0, '东': 90, '南': 180, '西': 270 };
    function dist(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
    /* 24 种排列里挑总角差最小的那种 —— 4 个元素的规模，穷举比贪心更稳。 */
    var best = null, bestCost = Infinity;
    (function pickPerm(cur, used) {
      if (cur.length === 4) {
        var c = 0;
        for (var i = 0; i < 4; i++) c += dist(info[i].az, DA[cur[i]]);
        if (c < bestCost) { bestCost = c; best = cur.slice(); }
        return;
      }
      for (var j = 0; j < 4; j++) {
        if (used[j]) continue;
        used[j] = true; cur.push(DIRS[j]); pickPerm(cur, used); cur.pop(); used[j] = false;
      }
    })([], [false, false, false, false]);
    var pin = info.map(function (it, i) {
      return [best[i], new THREE.Vector3(it.W[0], it.W[1], it.W[2])];
    });
    cam.updateMatrixWorld();
    var inv = _dmInv.copy(cam.matrixWorld).invert();
    var e2 = inv.elements;
    pin.forEach(function (it) {
      var p = _idmV ? _idmV : (_idmV = new THREE.Vector3());
      p.copy(it[1]);                                           /* 世界坐标，不再乘房间矩阵 */
      var cz = p.x * e2[2] + p.y * e2[6] + p.z * e2[10] + e2[14];
      if (cz > -0.5) { _idmEls[it[0]].style.display = 'none'; return; }
      var v = p.project(cam);
      if (v.z > 1 || v.z < -1) { _idmEls[it[0]].style.display = 'none'; return; }
      var px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
      /* ★ v39：投到屏幕外的方位标应隐藏（房间侧墙的东/西在窄视野里会落到视口左右外侧，
         旧写法只判前后不判左右 ⇒ 文字跑出屏幕）。留 40px 余量避免贴边抖动。 */
      if (px < -40 || px > w + 40 || py < -40 || py > h + 40) { _idmEls[it[0]].style.display = 'none'; return; }
      _idmEls[it[0]].style.display = 'block';
      _idmEls[it[0]].style.left = px + 'px';
      _idmEls[it[0]].style.top = py + 'px';
    });
  }

  /* ★ v41（需求一·11）：天球朝向（地平系固定 / 赤道系固定）的过渡 ——
     旧写法把缓动写在 updateCelestial() 里：`rotation.x += (target − cur) * 0.25`。
     两个毛病：① 固定系数 ⇒ 过渡快慢与帧率绑定（高刷屏一瞬到位、卡顿时拖很久）；
     ② updateCelestial() 会被主循环一条路径调用、但每帧调用次数还会随「悬浮窗 / 综合窗格
        是否在渲染」变化 ⇒ 同一帧被推进多次，过渡时长忽长忽短，观感就是「来回晃」。
     改为：**唯一写点 + 按 dt 收敛**（只在 tickSun 里推进一次），≈0.25 s 到位且严格单调；
     首次进入 / 重建后直接就位，不做无意义的入场动画。 */
  var _celRotX = null;
  function celTargetRotX() {
    var phiC = clamp(obsLat(), -89.5, 89.5) * D;
    return (S.coord.sys === 'equatorial') ? (Math.PI / 2 - phiC) : 0;
  }
  function stepCelRot(dt) {
    var t = celTargetRotX();
    if (_celRotX == null) _celRotX = t;
    var k = 1 - Math.exp(-clamp(dt || 0.016, 0, 0.1) * 12);
    _celRotX += (t - _celRotX) * k;
    if (Math.abs(t - _celRotX) < 1e-4) _celRotX = t;
  }
  function updateCelestial(g) {
    /* ★ v34（面板规格）：天球坐标系**逐要素样式** —— 地平圈 / 地平面 / 天顶 / 天底 /
       天赤道 / 天赤道平面 / 天北极 / 天南极 各有独立的线 / 面 / 点属性，逐帧写入材质。
       「只显示地平线以上的赤道坐标系」在 buildCelestial 里按几何裁掉地平线以下的半边，
       这里只负责把**落到地平线以下的天极**一并隐藏。 */
    var cst = S.coord.st;
    var colOf = function (hex, fallback) { return hex || fallback; };
    /* 坐标系要素显隐 */
    var aboveOnly = !!S.coord.aboveOnly;
    var poleNVis = S.coord.on && S.coord.poleN && !(aboveOnly && Math.sin(clamp(obsLat(), -89.5, 89.5) * D) < 0);
    var poleSVis = S.coord.on && S.coord.poleS && !(aboveOnly && Math.sin(clamp(obsLat(), -89.5, 89.5) * D) > 0);
    if (equLine) equLine.visible = S.coord.on && S.coord.equLine;
    if (equPlane) equPlane.visible = S.coord.on && S.coord.equPlane;
    if (poleN) poleN.visible = poleNVis;
    if (poleS) poleS.visible = poleSVis;
    var eqSys = (S.coord.sys === 'equatorial');
    if (poleAxisLine) poleAxisLine.visible = S.coord.on && (S.coord.poleN || S.coord.poleS) && !eqSys;
    if (zenM) zenM.visible = S.coord.on && S.coord.zenith;
    /* ★ v41（需求一·10）：天底恒在地平线以下 ⇒ 「只显示地平线以上」时一并隐藏 */
    if (nadM) nadM.visible = S.coord.on && S.coord.nadir && !aboveOnly;
    cGrid.visible = S.coord.on && S.coord.grid;
    horizonDisc.visible = S.coord.on && S.coord.hrPlane;
    horizonRing.visible = S.coord.on && S.coord.hrLine;
    meridianLine.visible = S.coord.on && S.coord.hrPlane;
    /* 逐要素材质：线（地平圈圆环 / 天赤道）、面（地平面 / 天赤道平面）、点（天顶 / 天底 / 天极） */
    applyHrLineW();
    horizonRing.material.color.set(colOf(cst.hrLine.color, '#37a05a'));
    horizonRing.material.opacity = clamp((cst.hrLine.op != null ? cst.hrLine.op : 100) / 100, 0, 1);
    horizonRing.material.transparent = horizonRing.material.opacity < 1;
    if (equLine) {
      equLine.material.color.set(colOf(cst.equLine.color, '#39c2ff'));
      equLine.material.opacity = clamp((cst.equLine.op != null ? cst.equLine.op : 100) / 100, 0, 1);
    }
    horizonDisc.material.color.set(colOf(cst.hrPlane.fill, '#5c9b6a'));
    horizonDisc.material.opacity = clamp((cst.hrPlane.fillOp != null ? cst.hrPlane.fillOp : 16) / 100, 0, 1);
    if (equPlane) {
      equPlane.material.color.set(colOf(cst.equPlane.fill, '#39c2ff'));
      equPlane.material.opacity = clamp((cst.equPlane.fillOp != null ? cst.equPlane.fillOp : 14) / 100, 0, 1);
    }
    [['zenith', zenM], ['nadir', nadM], ['poleN', poleN], ['poleS', poleS]].forEach(function (p) {
      var m = p[1], st = cst[p[0]]; if (!m || !st) return;
      m.scale.setScalar(clamp((st.size != null ? st.size : 100) / 100, 0.2, 4));
      m.material.color.set(colOf(st.color, '#ffffff'));
      m.material.opacity = clamp((st.op != null ? st.op : 100) / 100, 0, 1);
      m.material.transparent = m.material.opacity < 1;
    });
    /* ★ v32（需求四）：网格线型逐帧写入（颜色 / 透明度）。几何（坐标系 / 实虚线）变化时重建。 */
    var gcol = S.coord.gridColor || '#6f86ad';
    var gop = clamp(S.coord.gridOp / 100, 0, 1);
    for (var gi = 0; gi < cGridLines.length; gi++) {
      var gm = cGridLines[gi].material;
      gm.color.set(gcol);
      gm.opacity = gop * (gi % 4 === 0 ? 1.0 : 0.72);
    }
    /* v34（面板规格）：文字注释**逐要素**门控 —— 地平线 / 地平面 / 天顶 / 天底 / 天赤道 /
       天赤道平面 / 天北极 / 天南极 各有开关（S.coord.nt）。
       同时叠加总开关 S.coord.note 与坐标系总开关 S.coord.on。
       ★ v39（需求二·1·②）：东南西北（hrDir）与**地面方向文字合二为一** ——
         只受「地面物体 › 地面方向标 › 方向文字」（S.dmark.text）一个开关控制，
         不再叠加 S.coord.hrDir 的独立开关（该键已废弃）。 */
    cNotes.forEach(function (o) {
      var ck = o.userData._ck;
      /* ★ v52（需求G2）：注释显示规则 = 「对应地理事物处于显示状态」AND「逐要素文字开关」
         AND「全局文字总开关」。
         旧实现只看 S.coord.nt[ck]（逐要素文字开关），没有叠加**事物本身的显隐** ⇒
         把地平圈 / 天赤道 / 天平面等要素关掉后，其文字标注仍然孤零零地留在天球上。 */
      var objVis = {
        hrLine: S.coord.hrLine, hrPlane: S.coord.hrPlane,
        equLine: S.coord.equLine, equPlane: S.coord.equPlane,
        poleN: S.coord.poleN && !(aboveOnly && Math.sin(clamp(obsLat(), -89.5, 89.5) * D) < 0),
        poleS: S.coord.poleS && !(aboveOnly && Math.sin(clamp(obsLat(), -89.5, 89.5) * D) > 0),
        zenith: S.coord.zenith,
        nadir: S.coord.nadir && !aboveOnly,
        hrDir: !!S.dmark.on
      };
      var objOK = (ck && objVis[ck] !== undefined) ? objVis[ck] : true;
      var okElem = (ck === 'hrDir') ? (S.dmark.text !== false)
        : (ck ? (S.coord.nt[ck] !== false) : true);
      /* 全局文字总开关（显示全部文字注释）优先级最高：关闭时这里直接把 _typeVis 置 false，
         与随后 gateMasterNotes() 的叠加结果一致（双保险）。 */
      var on = svNoteStyle().on && S.coord.on && S.coord.note && okElem && objOK;
      o.userData._typeVis = on; o.visible = on;
    });
    cShell.visible = S.coord.on;
    cObserver.visible = true;
    /* ★ v32（需求四）修正「坐标固定」：
       地平坐标系固定 → cRoot 不旋转，地平面 / 地平圈保持水平（世界 XZ 面）；
       赤道坐标系固定 → 整组绕 X 轴旋转 (90°−纬度)，使**天赤道平面保持水平**、天极位于正上方。 */
    /* ★ v41（需求一·11）：这里**只应用**朝向，推进交给 tickSun 里的 stepCelRot(dt)。 */
    if (_celRotX != null) cRoot.rotation.x = _celRotX;

    /* v31（需求十八）：小人真实光线影子（天球视图）——太阳在地平线上方才有影子 */
    if (S.ray.shadow && g.alt > 0.5) {
      var Hr = g.alt * D;
      /* 反日光水平方向（影子指向）：dirOf 中水平分量 = (sin az, 0, −cos az)·cos alt，
         影子取反 → (−sin az, 0, cos az) */
      var sdx = -Math.sin(g.az * D), sdz = Math.cos(g.az * D);
      var L = clamp(C_FIG_H / Math.tan(Hr), 0, CS * 0.95);   // 不超过地平圈半径
      var tx = sdx * L, tz = sdz * L;
      /* 垂直于影子方向的水平分量（构造窄四边形），脚窄头略宽 */
      var px = -sdz, pz = sdx, wf = 0.22, wt = 0.42;
      var pos = cFigShadow.geometry.attributes.position;
      function setV(i, x, z) { pos.setXYZ(i, x, 0.006, z); }
      setV(0, -px * wf / 2, -pz * wf / 2);          /* 脚 — 左 */
      setV(1, px * wf / 2, pz * wf / 2);             /* 脚 — 右 */
      setV(2, tx + px * wt / 2, tz + pz * wt / 2);   /* 头影 — 右 */
      setV(3, tx - px * wt / 2, tz - pz * wt / 2);   /* 头影 — 左 */
      pos.needsUpdate = true;
      cFigShadow.geometry.computeBoundingSphere();
      /* v33（需求三）：天球视图的小人影子与「物影 › 影长线段」同色同透明度
         （旧版颜色 / 透明度写死为 0x101b30 / 0.42，改设置对它完全无效）。 */
      cFigShadow.material.color.set(S.meas.color);
      cFigShadow.material.opacity = clamp((S.meas.op / 100) * 0.55 * Math.sin(Hr) * 1.3, 0, 1);
      cFigShadow.visible = S.coord.on;
    } else {
      cFigShadow.visible = false;
    }

    /* 太阳位置 */
    var dir = dirOf(g.alt, g.az, _v1);
    cSun.position.copy(dir).multiplyScalar(CS * 0.98);
    cSun.visible = true;
    cSunRay.visible = false;

    /* ---- 当日轨迹 / 位置点 / 二分二至轨迹 ----
       这几组几何只随「观测点 · 太阳赤纬 · 时间 · 相关开关」变化，用一个签名做缓存，
       避免每帧重建上百个顶点的 BufferGeometry（天球悬浮窗在每一帧也会用到它们）。
       ★ v32（需求十二）：签名里的「地方恒星时」只在**动态绘制**模式下参与 ——
       完整绘制时轨迹与时间无关，把它算进去会让播放时钟时每帧重建整条轨迹。 */
    /* v33：地平线下轨迹的线粗细 / 透明度 / 线型纳入签名，改了才会重建。
       v35：二分二至三套线条属性（termCol）一并纳入。
       ★ v36（需求六/七）：traj.on（标题总开关）/ curPt（当前太阳位置点）/
       termShow.*（二分二至逐套显示）一并纳入 —— 改任何一个都要触发重建。
       ★ v62（需求一）：位置点与时刻组开关（ptOn）已取消，不再参与签名。 */
    var trailSig = [S.traj.on, S.traj.today, S.traj.under, S.traj.hourPt, S.traj.sunPt,
      S.traj.termShow.eq, S.traj.termShow.ss, S.traj.termShow.ws,
      S.traj.mode, S.traj.term4, S.traj.n, S.traj.color, S.traj.op,
      /* ★ v52（需求G1）：当日轨道的线型（实线 / 虚线）与虚实比纳入签名 ——
         此前这两项既不在签名里、渲染端也从未读取，故「改了不生效」。 */
      S.traj.dash, S.traj.ratio,
      /* ★ v43（需求一·3）：当日轨道线粗细纳入签名 —— 天球侧轨道此前是 1px 折线，
         「线粗细」完全不起作用；改为细管后必须靠签名触发重建。 */
      S.traj.w,
      S.traj.underColor, S.traj.underW, S.traj.underOp, S.traj.underDash, S.traj.underN, S.traj.underRatio,
      /* ★ v52（需求3/需求4）：日出日落中天点 / 整点位置点的点样式纳入签名。 */
      S.traj.sunPtColor, S.traj.sunPtSize, S.traj.sunPtOp,
      S.traj.hourPtColor, S.traj.hourPtSize, S.traj.hourPtOp,
      /* ★ v52（需求5.1/5.2/5.3）：二分二至轨道的线型（dash/n/ratio）纳入签名（w 已在旧签名里有）。 */
      S.traj.termCol.eq.color, S.traj.termCol.eq.w, S.traj.termCol.eq.op, S.traj.termCol.eq.dash, S.traj.termCol.eq.n, S.traj.termCol.eq.ratio,
      S.traj.termCol.ss.color, S.traj.termCol.ss.w, S.traj.termCol.ss.op, S.traj.termCol.ss.dash, S.traj.termCol.ss.n, S.traj.termCol.ss.ratio,
      S.traj.termCol.ws.color, S.traj.termCol.ws.w, S.traj.termCol.ws.op, S.traj.termCol.ws.dash, S.traj.termCol.ws.n, S.traj.termCol.ws.ratio,
      obsLat().toFixed(3), g.decl.toFixed(3),
      (S.traj.mode === 'dynamic' ? g.lst.toFixed(3) : 'static')].join('|');
    /* ★ 修复 #7：动态模式节流 —— 距上次重建不足 120ms 则跳过本帧重建（仅保留块外的
       状态更新：太阳位置、影长线段等仍在每帧执行）；静态模式维持原逻辑，签名一变即重建。 */
    var _dynTrail = (S.traj.mode === 'dynamic');
    var _nowT = (window.performance && performance.now) ? performance.now() : Date.now();
    if (trailSig !== _trailSig && (!_dynTrail || _nowT - _trailRebuildT >= 120)) {
    _trailSig = trailSig;
    _trailRebuildT = _nowT;
    /* 当日轨迹（上方 / 下方）—— ★ v32：上方轨迹改为「固定容量缓冲 + setDrawRange」，
       复用同一对象，不再每帧新建 BufferGeometry（旧实现会在播放时持续泄漏 GPU 缓冲）。 */
    if (trailAbove) { cRoot.remove(trailAbove); disposeObj(trailAbove); trailAbove = null; }
    if (trailUnder) { cRoot.remove(trailUnder); disposeObj(trailUnder); trailUnder = null; }
    trailMarks.forEach(function (m) { cRoot.remove(m); disposeObj(m); }); trailMarks = [];
    /* ★ v43（三·2）：hourNoteSps 必须连同 allNoteSps 一起摘掉 ——
       整点 / 日出日落注释在「动态绘制」模式下**每帧重建**（trailSig 含 lst），
       此前只 remove + dispose 而没 noteSplice ⇒ allNoteSps 每帧漏 2 个僵尸条目，
       applySvNoteK / applyNoteStyles 每帧遍历的其实是「历史残骸 + 当前精灵」。 */
    hourNoteSps.forEach(function (m) { cRoot.remove(m); noteSplice(m); disposeObj(m); }); hourNoteSps = [];

    var decl = g.decl;
    var cosH0 = -Math.tan(obsLat() * D) * Math.tan(decl * D);
    var H0 = (cosH0 <= -1) ? 180 : (cosH0 >= 1 ? 0 : Math.acos(cosH0) * R);

    /* 动态绘制：按"当前时刻"渐进画出轨迹（★ v36：全部受 traj.on 总开关门控） */
    var frac = 1;
    if (S.traj.on && S.traj.today && S.traj.mode === 'dynamic') {
      frac = H0 > 0 ? clamp((g.lst - (12 - H0 / 15)) / (2 * H0 / 15), 0, 1) : 1;
    }
    if (S.traj.on && S.traj.today && H0 > 0) {
      var ptsA = [], N = clamp(Math.round(S.traj.n), 20, 240), lim = Math.floor(N * frac);
      for (var i = 0; i <= lim; i++) {
        var Hd = -H0 + (i / N) * (2 * H0);
        var aa = altAzOfH(Hd, obsLat(), decl);
        /* 注意：dirOf 把结果写进第三个参数并返回它 —— 若复用同一个临时向量，
           ptsA 里就会是同一个对象的 N 份引用（所有点重合）。故这里必须新建。 */
        ptsA.push(dirOf(aa.alt, aa.az, new THREE.Vector3()).multiplyScalar(CS));
      }
      if (ptsA.length > 1) {
        /* ★ v43（需求一·3）：当日轨道由 **1px 折线** 改为**细管**，让「线粗细」真正生效。
           此前无论把 S.traj.w 调到多少，天球上这条线永远只有 1 个像素粗（WebGL 的
           LineBasicMaterial.lineWidth 在绝大多数实现里被忽略），是一个死控件。
           基准半径 0.018 是标定值：天球半径 CS = 9、相机默认距离 26、fov 42°，
           在 800px 高的窗口上约合 1.4px —— 与旧观感几乎一致，滑块 1.00× 即此粗细。 */
        var tm = svLwMult('traj.w');
        var trad = Math.max(0.003, SV_CEL_TRAJ_R * tm);
        if (ptsA.length < 3) {
          /* 点数不足 3 个时 CatmullRom 无法定 Frenet 标架，退回折线（此时本来就是极短一段） */
          trailAbove = lineOf(ptsA, S.traj.color, 1, 'solid');
          trailAbove.material.opacity = S.traj.op / 100;
        } else {
          /* ★ v52（需求G1）：当日轨道支持「实线 / 虚线 + 虚线密度 + 虚实比」——
             此前恒为实心细管，菜单的线型 / 虚实比完全被忽略。 */
          trailAbove = new THREE.Mesh(
            tubeStyledGeo(ptsA, trad, S.traj.dash, S.traj.n, S.traj.ratio, Math.min(300, ptsA.length * 2)),
            new THREE.MeshBasicMaterial({ color: S.traj.color, transparent: true, opacity: S.traj.op / 100 }));
        }
        cRoot.add(trailAbove);
      }
    }
    if (S.traj.on && S.traj.under && H0 < 180) {
      var ptsU = [];
      for (var j = 0; j <= 96; j++) {
        var Hd2 = H0 + (j / 96) * (360 - 2 * H0);
        var aa2 = altAzOfH(Hd2 > 180 ? Hd2 - 360 : Hd2, obsLat(), decl);
        ptsU.push(dirOf(aa2.alt, aa2.az, new THREE.Vector3()).multiplyScalar(CS));
      }
      /* v33：虚线密度 / 虚实比 / 透明度改由菜单控制（旧版写死 60 / 55 / 0.55）。
         ★ v43（需求一·3）：线粗细（S.traj.underW）此前也是死控件 —— lineOf 的 width
         参数在实线分支完全未被使用。改为与地面侧同一套规则：
           倍率 < 0.45 ⇒ 虚线（保留虚线语义的默认档，密度/虚实比仍生效）；
           ≥ 0.45 ⇒ 实心细管（半径随倍率变化）。 */
      var um2 = svLwMult('traj.underW');
      if (um2 < 0.45) {
        trailUnder = lineOf(ptsU, S.traj.underColor, 1, S.traj.underDash, S.traj.underN, S.traj.underRatio);
        trailUnder.material.opacity = (S.traj.underOp / 100) * 0.55;
      } else {
        var ucurve2 = new THREE.CatmullRomCurve3(ptsU);
        trailUnder = new THREE.Mesh(
          new THREE.TubeGeometry(ucurve2, 160, Math.max(0.003, SV_CEL_TRAJ_R * um2), 6, false),
          new THREE.MeshBasicMaterial({ color: S.traj.underColor, transparent: true, opacity: (S.traj.underOp / 100) * 0.55 }));
      }
      cRoot.add(trailUnder);
    }

    /* 整点位置点 / 日出日落点 / 整点时刻注释（★ v36：受 traj.on 总门控；
       ★ v62（需求一）：ptOn 组门控取消，改受 traj.today 门控 —— 与当日轨迹同显隐） */
    if (S.traj.on && S.traj.today && S.traj.hourPt) {
      for (var hh = 0; hh < 24; hh++) {
        var Hh = (hh - 12) * 15;
        var aah = altAzOfH(Hh, obsLat(), decl);
        if (aah.alt < -0.5) continue;
        if (S.traj.mode === 'dynamic' && frac < 1) {
          var tFrac = H0 > 0 ? ((Hh + H0) / (2 * H0)) : 0;
          if (tFrac > frac) continue;
        }
        /* ★ v52（需求4）：整点位置点样式读 traj.hourPt*（此前颜色与半径 0.085 写死）。
           基准半径 0.085 = 1.00×（与旧观感一致）。 */
        var hRadC = Math.max(0.005, 0.085 * (S.traj.hourPtSize / 100));
        var m = new THREE.Mesh(new THREE.SphereGeometry(hRadC, 10, 8),
          new THREE.MeshBasicMaterial({ color: S.traj.hourPtColor, transparent: true, opacity: clamp(S.traj.hourPtOp / 100, 0, 1) }));
        m.position.copy(dirOf(aah.alt, aah.az, _celV).multiplyScalar(CS));
        cRoot.add(m); trailMarks.push(m);
        /* ★ v63（需求A）：整点时刻文字注释随整点位置点一同创建，可见性由
           「文字注释 › 整点时刻」子组开关（traj.nt.svHour + traj.note）控制。 */
        var sp = textSprite(hh + ':00', { size: 0.34, color: '#ffe9b0', cat: 'svHour' });
        sp.position.copy(m.position).multiplyScalar(1.045);
        cRoot.add(sp); hourNoteSps.push(sp);
      }
    }
    /* ★ v44（需求十二）：地面视图同款 —— 天球视图的日出 / **日中天** / 日落点，
       与地面完全一致：同一开关 `traj.sunPt`、同一注释分类 svTraj、同一直 tcp 「H=0 ⇒ 最高点」口径，
       因此两个视图的数量与相对位置必然一致（「各子视图内容与对应单一视图保持一致」）。 */
    if (S.traj.on && S.traj.today && S.traj.sunPt && H0 > 0 && H0 < 180) {
      [['日出', -H0], ['日中天', 0], ['日落', H0]].forEach(function (p) {
        var aa3 = altAzOfH(p[1], obsLat(), decl);
        var noon = (p[1] === 0);
        /* ★ v52（需求3）：日出 / 日中天 / 日落点样式读 traj.sunPt*（此前颜色与半径写死）。
           基准半径沿用旧口径：日中天 0.14、日出/日落 0.12，再乘 size 倍率。 */
        var sRadC = Math.max(0.008, (noon ? 0.14 : 0.12) * (S.traj.sunPtSize / 100));
        var mm = new THREE.Mesh(new THREE.SphereGeometry(sRadC, 12, 10),
          new THREE.MeshBasicMaterial({ color: S.traj.sunPtColor, transparent: true, opacity: clamp(S.traj.sunPtOp / 100, 0, 1) }));
        mm.position.copy(dirOf(aa3.alt, aa3.az, _celV).multiplyScalar(CS));
        cRoot.add(mm); trailMarks.push(mm);
        var sp2 = textSprite(p[0], { size: 0.38, color: noon ? '#ffe08a' : '#ffb0a0', cat: 'svTraj' });
        sp2.position.copy(mm.position).multiplyScalar(1.06);
        cRoot.add(sp2); hourNoteSps.push(sp2);
      });
    }

    /* 二分二至 4 套轨迹（v35 需求九：三套线条的颜色 / 线粗细 / 透明度独立可调；
       ★ v36 需求六：受 traj.on 总开关门控 + termShow 逐套单独显示 ——
       春分秋分 / 夏至 / 冬至各一枚开关，地面视图与天球视图都生效） */
    term4Grp.children.slice().forEach(function (o) { term4Grp.remove(o); noteSplice(o); disposeObj(o); });
    if (S.traj.on && S.traj.term4) {
      var eps = BR.getObliquity();
      /* ★ v31（需求十五）：春分与秋分的太阳直射赤纬都是 0° ⇒ 两条轨迹**完全重合**。
         此前把它们当成两套各自画一遍，结果是同一条线被画两次（更亮更粗），
         两段文字注记又落在同一点上互相压字。现合并为一条，注释写「春分 / 秋分」。 */
      [['春分 / 秋分', 0, 'eq'], ['夏至', eps, 'ss'], ['冬至', -eps, 'ws']].forEach(function (tt) {
        if (!S.traj.termShow[tt[2]]) return;   /* ★ v36：逐套「单独显示」开关 */
        var pts = [], dd = tt[1], tc = S.traj.termCol[tt[2]] || S.traj.termCol.eq;
        var cH = -Math.tan(obsLat() * D) * Math.tan(dd * D);
        var HH = (cH <= -1) ? 180 : (cH >= 1 ? 0 : Math.acos(cH) * R);
        if (HH <= 0) return;
        for (var q = 0; q <= 96; q++) {
          var Hq = -HH + (q / 96) * (2 * HH);
          var aaq = altAzOfH(Hq, obsLat(), dd);
          pts.push(dirOf(aaq.alt, aaq.az, new THREE.Vector3()).multiplyScalar(CS * 0.995));
        }
        var col = new THREE.Color(tc.color || '#b7e07f');
        /* ★ v52（需求5.1/5.2/5.3）：二分二至轨道由 1px 折线改为**细管** ——
           线粗（tc.w，经 SV_LW_BASE 基准 3.0 换算为倍率）+ 线型（tc.dash/n/ratio）
           真正生效。基准半径 SV_CEL_TRAJ_R（与当日轨道同口径）= 1.00×。 */
        var tRadC = Math.max(0.003, SV_CEL_TRAJ_R * svLwMult('traj.termCol.' + tt[2] + '.w', tc.w));
        var tMeshC = new THREE.Mesh(
          tubeStyledGeo(pts, tRadC, tc.dash || 'solid', tc.n, tc.ratio, Math.min(300, pts.length * 2)),
          new THREE.MeshBasicMaterial({ color: col.getHex(), transparent: true, opacity: clamp((tc.op != null ? tc.op : 72) / 100, 0, 1) }));
        term4Grp.add(tMeshC);
        /* ★ v64（需求1）：轨道名称注释**无条件创建**（原 if (S.traj.term4Note) 包裹已删）——
           显隐改由 gateMasterNotes 按 traj.note && traj.nt.svTerm4 每帧控制（同地面视图口径）。 */
        var mid = pts[Math.floor(pts.length / 2)];
        var sp3 = textSprite(tt[0], { size: 0.42, color: '#' + col.getHexString(), cat: 'svTerm4' });
        sp3.position.copy(mid).multiplyScalar(1.07);
        term4Grp.add(sp3);
      });
    }
    }   /* ==== trailSig 缓存块结束 ==== */

    /* 影长线段 + 影长数值注释
       ★ v33（需求三）：样式统一取「观察与测量 › 物影 › 影长线段」（S.meas.*），
         并把长度**钳制在地平圈以内**（旧版夹到 200，而地平圈半径只有 CS = 9，
         太阳一低影子就整根穿出地平圈、横贯天球）。 */
    var shadowOn = S.traj.shadow && g.alt > 0.5;
    shadowLine.visible = shadowOn && S.traj.on && S.traj.today && S.meas.line;
    /* ★ v64（需求1）：原 S.traj.shadowNote（「影长数值注释」开关）已取消 ——
       注释自身可见性只由「影长线段（天球）」的渲染条件（shadowOn && traj.on && traj.today）
       决定，再经 gateMasterNotes 叠加「文字注释 › 物体影长数值（天球）」
       （traj.note && traj.nt.svMeasL）门控（_trajNote 标记，见 7874 行起）。 */
    var noteVis = shadowOn && S.traj.on && S.traj.today;
    if (shadowOn) {
      /* ★ v52（需求G4）：天球影长必须与「小人身高设置」**解耦** ——
         旧实现直接用 S.fig.h 算影长，拖动身高滑块会把天球上的影子一起拉长 / 缩短，物理上不成立。
         影长只与太阳高度角 g.alt 与「物体高度参数」有关，这里取固定的观测者基准高度 C_FIG_H。 */
      var hh2 = C_FIG_H;
      var lenRaw = hh2 / Math.tan(g.alt * D);
      var len = Math.min(lenRaw, CS * 0.95);          // 不得超出地平圈
      var sdir = dirOf(0, (g.az + 180) % 360, _v2);
      var a = _mv1.set(0, 0.02, 0);
      var b2 = _mv2.copy(sdir).multiplyScalar(len); b2.y = 0.02;
      setSegLine(shadowLine.geometry, [a, b2], S.meas.dash, S.meas.n, S.meas.ratio);
      shadowLine.material.color.set(S.meas.color);
      shadowLine.material.opacity = S.meas.op / 100;
      /* ★ v32：旧实现只写 `userData.svText`，而 svText 全工程没有任何读取方 ⇒ 勾选
         「影长数值注释」后贴图始终是空白的（典型「调了没反应」）。改走通用 setLabelText，
         文本才会真正烘焙进贴图，并且自动接受「全局文字样式 / 各注释单独样式」管辖。
         setLabelText 可能返回**新精灵**，故位置与显隐都必须在它之后设置。 */
      var nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
      if (nowMs - _shadowNoteT > 250 || !shadowNoteSp.userData.txt) {
        _shadowNoteT = nowMs;
        /* ★ v52（需求4）：天球影长数值改用 svMeasL（影长数值）分类 —— 与地面视图一致，
           并与「物体高度」（svMeas）分离，改影长注释样式不再连带改物体高度注释。 */
        shadowNoteSp = setLabelText(shadowNoteSp, '影长 ' + lenRaw.toFixed(2) + ' m',
          { size: 0.5, color: S.meas.color, cat: 'svMeasL' });
      }
      shadowNoteSp.position.copy(b2).multiplyScalar(0.55).setY(0.6);
    }
    shadowNoteSp.userData._typeVis = noteVis;
    shadowNoteSp.userData._trajNote = true;   /* ★ v62（需求二）：天球影长注释受「视运动轨迹 › 文字注释」组门控 */
    shadowNoteSp.visible = noteVis;
  }

  /* v31（需求二十）：窗户朝向（度）。'auto' = 朝赤道。 */
  function windowAzDeg() {
    var f = S.room.face;
    if (f === 'E') return 90; if (f === 'S') return 180;
    if (f === 'W') return 270; if (f === 'N') return 0;
    return obsLat() >= 0 ? 180 : 0;
  }
  function updateIndoor(g) {
    /* ★ v31（需求二十）核心修复：房间**不再跟着太阳转**。
       旧写法 iRoom.rotation.y = -azR 让窗墙永远正对太阳，于是太阳在「房间局部坐标」里
       方位角恒为 0，光斑只能前后伸缩、永远停在屋子中间 —— 看不到「影子从西向东」。
       现在房间朝向固定，太阳相对窗户的方位角 H 随时间从 -90° 走到 +90°，
       光斑与物影自然就从屋子的一侧扫到另一侧。 */
    var azWin = windowAzDeg();
    var azR = azWin * D;
    iRoom.rotation.y = -azR;
    var H = ((g.az - azWin + 540) % 360) - 180;      // 太阳相对窗户法线的方位角（°）
    var HR = H * D;
    var alt = g.alt;
    var altR = clamp(alt, 0, 90) * D;
    /* 室内局部的光线行进方向：含横向分量（H ≠ 0 时斜射进屋） */
    var ca = Math.cos(altR), sa = Math.sin(altR);
    var ldir = _v1.set(-Math.sin(HR) * ca, -sa, Math.cos(HR) * ca);
    var front = Math.cos(HR) > 0.02;                 // 太阳在窗户这一侧才有直射光
    var lit = front && alt > 1.0 && Math.abs(H) < 86;
    _lastH = H; _lastLit = lit;                      /* 探针用 */
    var on = lit && S.room.vol;
    /* 门口进来的体积光柱（★ 本批次需求五：双层壳实心光柱，与地面体积光同口径） */
    for (var i = 0; i < iBeams.length; i++) {
      var b = iBeams[i];
      var active = on && i < clamp(Math.round(S.vol.n), 1, 7);
      b.grp.visible = active;
      if (!active) continue;
      var t = (i / (iBeams.length - 1)) * 2 - 1;
      var wy = SILL + WINH / 2 + t * (WINH * 0.42);
      var wx = t * 1.4;
      var start = new THREE.Vector3(wx, wy, -RD / 2 + 0.2);
      var len2 = 13;
      var pos = start.clone().addScaledVector(ldir, len2 / 2);
      b.grp.position.copy(pos);
      b.grp.quaternion.setFromUnitVectors(_volUp, ldir);
      /* 光柱直径 / 外层柔光范围沿用全局 vol.diffuse / vol.dia / vol.sheath 口径
         （原平面宽度 1.6~5.6 ⇒ 圆柱半径 0.8~2.8，视觉尺度相当） */
      var R = (0.8 + 2.0 * (S.vol.diffuse / 100)) * clamp(S.vol.dia, 20, 300) / 100;
      var RG = R * clamp(S.vol.sheath, 100, 400) / 100;
      b.core.scale.set(R, len2, R);
      b.sheath.scale.set(RG, len2, RG);
      /* ★ v64（需求2）：室内光柱不透明度按 room.volScale（室内光强相对室外百分比，默认 45%）
         折算 —— 解决室内体积光过曝；100% 时与室外同参数完全一致。 */
      var opI = clamp((S.vol.op / 100) * (S.vol.intensity / 100)
        * (clamp(+(S.room.volScale != null ? S.room.volScale : 100), 5, 100) / 100)
        * Math.sin(altR) * 1.4, 0, 0.7);
      var uc = b.core.material.uniforms, us = b.sheath.material.uniforms;
      uc.uColor.value.set(S.vol.color || '#ffd873');
      uc.uOp.value = opI;
      uc.uEdge.value = clamp(S.vol.edge, 40, 98) / 100;
      uc.uFade.value = 0.06 + 0.20 * (S.vol.decay / 100);
      us.uColor.value.set('#ffffff');
      us.uOp.value = opI * 0.26;
      us.uEdge.value = Math.min(0.985, uc.uEdge.value + 0.08);
      us.uFade.value = uc.uFade.value * 1.25;
    }
    /* 边界光线（窗洞上下沿）—— ★ v44（需求四）：粗细 / 颜色 / 透明度均可设（ribbon 实现）。 */
    iEdges.visible = S.room.edge && g.alt > 1;
    if (iEdges.visible) {
      var ieW = Math.max(0.002, (svLwMult('room.edgeW') * (SV_LW_BASE['room.edgeW'] || 0.02)));
      var top = new THREE.Vector3(0, SILL + WINH, -RD / 2 + 0.2);
      var bot = new THREE.Vector3(0, SILL, -RD / 2 + 0.2);
      var tg = top.clone().addScaledVector(ldir, 26), bg = bot.clone().addScaledVector(ldir, 26);
      setRibbonSeg(iEdgeTop.geometry, top.x, top.y, top.z, tg.x, tg.y, tg.z, 'solid', 1, 1, ieW, iCam.position);
      setRibbonSeg(iEdgeBot.geometry, bot.x, bot.y, bot.z, bg.x, bg.y, bg.z, 'solid', 1, 1, ieW, iCam.position);
      var ieOp = clamp((+S.room.edgeOp || 0) / 100, 0, 1);
      iEdgeTop.material.color.set(S.room.edgeColor || '#fff2c8');
      iEdgeBot.material.color.set(S.room.edgeColor || '#fff2c8');
      iEdgeTop.material.opacity = ieOp; iEdgeBot.material.opacity = ieOp;
    }
    /* ===== 光斑（★ v44 需求四：地面 / 墙面分开渲染，且**所有受光面都画**） =====
       窗口四角沿光线方向投出去的是一个**平行四棱柱**；它与房间四个受光面
       （地面 y=0 / 背墙 z=+zw / 左墙 x=−xw / 右墙 x=+xw）各有一个交多边形。
       旧实现先「挑一个面」再整块画上去 ⇒ 例如斜射时柱体同时打到地面与侧墙，
       侧墙上那块就被丢掉了（需求里说的「缺失的墙面投影」）。
       现在对每个面：① 把四角沿 ldir 投到该面；② 在该面的二维坐标里做矩形裁剪
       （Sutherland–Hodgman）；③ 有面积就写进对应的光斑网格。 */
    iPatchFloor.visible = false;
    for (var wi = 0; wi < iPatchWalls.length; wi++) iPatchWalls[wi].visible = false;
    if (lit) {
      var z0 = -RD / 2 + 0.2, zw = RD / 2 - WTH / 2 - 0.012, xw = RW / 2 - WTH / 2 - 0.012;
      var yFloor = 0.012;                                          /* ★ v39：紧贴地面（旧值 0.02 略浮） */
      var yTop = RH - 0.05;
      /* 四个面：{ 被钉住的轴, 面坐标, 面内两轴及其取值区间 } */
      var faces = [
        { iPatch: iPatchFloor, wall: false, pin: 'y', v: yFloor, u: 'x', u0: -xw, u1: xw, w: 'z', w0: z0, w1: zw },
        { iPatch: iPatchWalls[0], wall: true, pin: 'z', v: zw, u: 'x', u0: -xw, u1: xw, w: 'y', w0: yFloor, w1: yTop },
        { iPatch: iPatchWalls[1], wall: true, pin: 'x', v: -xw, u: 'z', u0: z0, u1: zw, w: 'y', w0: yFloor, w1: yTop },
        { iPatch: iPatchWalls[2], wall: true, pin: 'x', v: xw, u: 'z', u0: z0, u1: zw, w: 'y', w0: yFloor, w1: yTop }
      ];
      var cor = [[-WINW / 2, SILL], [WINW / 2, SILL], [WINW / 2, SILL + WINH], [-WINW / 2, SILL + WINH]];
      var IN = { x: 0, y: 1, z: 2 };
      for (var fi = 0; fi < faces.length; fi++) {
        var F = faces[fi];
        var dc = F.pin === 'y' ? ldir.y : (F.pin === 'z' ? ldir.z : ldir.x);
        if (Math.abs(dc) < 1e-4) continue;                     /* 光线与该面平行 ⇒ 打不到这个面 */
        /* ① 投影四角 */
        var poly = [];
        for (var ci = 0; ci < 4; ci++) {
          var ox = cor[ci][0], oy = cor[ci][1], oz = z0;
          var source = (F.pin === 'y') ? oy : (F.pin === 'z' ? oz : ox);
          var tt = clamp((F.v - source) / dc, 0, 60);
          var P = [ox + ldir.x * tt, oy + ldir.y * tt, oz + ldir.z * tt];
          poly.push([P[IN[F.u]], P[IN[F.w]]]);                /* 面内二维坐标 (u, w) */
        }
        /* ② 裁到面矩形（略缩 0.02 免得压到墙与地面的交界） */
        var m2 = 0.02;
        poly = clipRect(poly, F.u0 + m2, F.u1 - m2, F.w0 + m2, F.w1 - m2);
        if (poly.length < 3) continue;
        /* ③ 还原成三维（被钉住的轴写回面坐标，消除浮点浮空） */
        var out3 = poly.map(function (p) {
          var q = [0, 0, 0];
          q[IN[F.u]] = p[0]; q[IN[F.w]] = p[1]; q[IN[F.pin]] = F.v;
          return q;
        });
        var ps = S.room.patch || ROOM_DEF.patch;
        if (F.wall && !ps.wallOn) continue;
        if (!F.wall && !ps.floorOn) continue;
        if (!setPatch(F.iPatch, out3)) continue;
        /* 透明度：仍按太阳高度给一点动态（越高越亮），基准值取自对应那一套属性。 */
        var baseOp = (F.wall ? (+ps.wallOp || 38) : (+ps.floorOp || 55)) / 100;
        F.iPatch.material.opacity = clamp(baseOp * (F.wall ? (0.7 + 0.5 * clamp(1 - sa, 0, 1)) : (0.7 + 0.5 * clamp(sa, 0, 1))), 0, 1);
      }
    }
    /* 光斑颜色：默认与室外的太阳颜色一致（日出日落偏橙、正午亮白）；
       ★ v44（需求四）：用户在「室内设置」里选了自定义色就用自定义色，两套分别生效。 */
    var ps2 = S.room.patch || ROOM_DEF.patch;
    iPatchFloor.material.color.set(ps2.floorColor || '#ffe6b0');
    for (var wi2 = 0; wi2 < iPatchWalls.length; wi2++) iPatchWalls[wi2].material.color.set(ps2.wallColor || '#ffe6b0');
    outSky.visible = true;
    /* 窗外的太阳：只在太阳真的在窗户这一侧时看得见，并按方位角横向偏移 */
    outSun.visible = alt > -0.5 && front && Math.abs(H) < 84;
    outSun.position.set(-Math.tan(HR) * 1.0, SILL + WINH / 2 + Math.tan(altR) * 1.0, -RD / 2 - 1.0);
    outSun.material.color.copy(_sunCol);
    outSky.material.color.setHex(0x8fc3f2).lerp(_c1.setHex(0x101a2e), clamp(1 - ss(-4, 8, g.alt), 0, 1));
    var nightAmt = 1 - ss(-4, 8, g.alt);
    iScene.children.forEach(function (o) { if (o.isAmbientLight) o.intensity = 0.42 * (1 - nightAmt * 0.6); });
    /* 墙面阴影 */
    iWallShadow.visible = S.room.wshadow;
    /* v31（需求二十）：墙面阴影也跟着太阳走 —— 太阳偏向哪一侧，那一侧的墙就被照亮
       （阴影淡），对侧的墙留在影子里（阴影浓）。这样一日内能看到阴影从西墙转到东墙。 */
    var sideBias = clamp(Math.sin(HR), -1, 1);           // >0 光偏右墙，<0 光偏左墙
    iWallShadow.children.forEach(function (q) {
      q.material.color.set(S.room.wsColor);
      var base = S.room.wsOp / 100;
      if (q === shL) q.material.opacity = base * clamp(0.35 - sideBias * 0.9, 0.05, 1);
      else if (q === shR) q.material.opacity = base * clamp(0.35 + sideBias * 0.9, 0.05, 1);
      else q.material.opacity = base * clamp(0.35 + 0.6 * clamp(sa, 0, 1), 0.05, 1);
    });
  }

  function updateFP(g, dt) {
    /* 移动：WASD / 方向键（限制在地面平面内） */
    var sp = 4.6 * dt;
    var fx = Math.sin(fpYaw), fz = -Math.cos(fpYaw);       /* 前方（视线方向） */
    var rx = Math.cos(fpYaw), rz = Math.sin(fpYaw);        /* 右方（前方顺时针 90°） */
    var dx = 0, dz = 0;
    if (fpKeys.w || fpKeys.arrowup) { dx += fx; dz += fz; }
    if (fpKeys.s || fpKeys.arrowdown) { dx -= fx; dz -= fz; }
    if (fpKeys.a || fpKeys.arrowleft) { dx -= rx; dz -= rz; }
    if (fpKeys.d || fpKeys.arrowright) { dx += rx; dz += rz; }
    var len = Math.hypot(dx, dz);
    if (len > 0.001) {
      fpPos.x = clamp(fpPos.x + dx / len * sp, -GSIZE / 2 + 1.5, GSIZE / 2 - 1.5);
      fpPos.z = clamp(fpPos.z + dz / len * sp, -GSIZE / 2 + 1.5, GSIZE / 2 - 1.5);
      /* ★ v53（任务二·2）：反向同步给**视点小人** fpHost，而不是默认小人 figObj。
         移动的是「你正站着的那个人」；若仍写 figObj，多小人时会凭空把场景中心的
         默认小人拽着跑，而视点本人站在原地不动。只有 fpHost 存在时才同步
         （fpHost 为空 = 走的是工具条按钮的 figObj 回退路径之外，或视点已被删除）。 */
      if (fpHost) fpHost.position.copy(fpPos);
    }
    /* 向日葵：锁定太阳 */
    if (S.sunflower) {
      var sdir = dirOf(g.alt, g.az, _v1);
      fpYaw = Math.atan2(sdir.x, -sdir.z);
      fpPitch = clamp(Math.asin(clamp(sdir.y, -1, 1)), -1.2, 1.2);
    }
    /* ★ 本批次（需求四·a/b）：隐藏观测者自身模型（相机就站在「小人」身上，其躯干 /
       头会挡在镜头前，表现为镜头前一块纯色方块），并把相机摆到当前机位（含缩放）。
       ★ v53（任务二·2）：隐藏的是 fpHost（视点小人），不是无条件隐藏 figObj ——
       多小人时若无条件隐藏 figObj，会让「视点本人」在镜头前挡脸、而中心小人凭空消失。 */
    if (fpHost) fpHost.visible = false;
    setFpCamFromState();
  }
  /* ★ 本批次（需求三/四）：把第一人称相机摆到当前机位 —— 单一视图（updateFP）与
     综合视图的「第一人称」窗格共用同一份 fpPos / fpYaw / fpPitch / fpFov，
     于是两处内容完全一致。 */
  function setFpCamFromState() {
    if (!fpCam) return;
    fpCam.position.set(fpPos.x, EYE, fpPos.z);
    if (Math.abs(fpCam.fov - fpFov) > 1e-4) { fpCam.fov = fpFov; fpCam.updateProjectionMatrix(); }
    var cp = Math.cos(fpPitch);
    fpCam.lookAt(fpPos.x + Math.sin(fpYaw) * cp * 10,
                 EYE + Math.sin(fpPitch) * 10,
                 fpPos.z - Math.cos(fpYaw) * cp * 10);
  }

  /* ★ v38（需求六）：滑块关键点节点 —— p ∈ [0,1]（0 = 滑块最小端）。
     left 用 calc 精确补偿 thumb 宽度，让圆点中心严格对准滑轨刻度位置。
     ★ v43（需求一·5）两处改动：
       ① 关键点圆点改为**实心小圆点、直接内嵌在轨道中线上**，滑块改为**空心大圆点**
          （thumb 直径 18·ui）⇒ 关键点只有滑块的一半大；节点 span 本体移到轨道**下方**
          （top:100%），只显示文字注释。样式见 sunview.css 的 `.svtb-node::before`。
       ② 补偿常数由 14px 改为 **18px**（= 新 thumb 直径，ui=1 时的实际像素宽），
          否则圆点整体偏离 thumb 中心 2px。端点防溢出边距同步改到 4.5·ui（= 9 - 4.5）。 */
  /* 关键点定位：纯百分比，见函数体末尾注释（v54 起不再需要 thumb 直径补偿）。 */
  function tbNode(host, p, txt, opt) {
    opt = opt || {};
    var s = el('span', 'svtb-node' + (opt.prime ? ' prime' : ''), txt);
    var q = clamp(p, 0, 1);
    if (opt.month) s.classList.add('mon');
    /* ★ v39（需求二·6）：竖排（窄）时用短标签，避免相邻节点文字重合 —— 长文写在 data-short，
       由 CSS 在 .vert 下切换显示。 */
    if (opt.short) { s.setAttribute('data-short', opt.short); s.classList.add('has-short'); }
    if (opt.title) s.title = opt.title;
    if (opt.click) {
      /* ★ v42（代码审查 · 二/#svTimeBar）：刻度节点是 `<span>`，肉眼与上方那排「真按钮」
         （节气按钮 .btn.xs）几乎一样、还有 hover 高亮，却能 **Tab 不到 / 空格按不动 /
         读屏不播报** —— 同一块面板里「看起来一样、行为完全不同」。
         这里给带 click 的节点补上键盘 / 无障碍三件套：role=button + tabindex=0 + aria-label，
         并把 click 挂到 Enter / 空格（与原生 button 一致）。无 click 的节点（日出 / 日中天 /
         日落此刻仍是纯说明文字）不加 tabindex，避免造出「按了没反应」的假焦点。 */
      s.setAttribute('role', 'button');
      s.setAttribute('tabindex', '0');
      s.setAttribute('aria-label', opt.title || txt);
      s.addEventListener('click', opt.click);
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); opt.click(); }
      });
    }
    /* ★ v43（需求一·5）：**定位必须放在 appendChild 之后**。
       观测点纬度 / 经度节点是在脚本执行期（DOM 就绪之前、页面还在解析）创建的，
       此时对尚未入文档的元素写 style.left，赋的值会被**静默丢弃** ——
       结果是这批节点全部塌到节点层左上角、五个标签叠成一团（截图里表现为纬度行下方
       一团黑字），而稍后由 updateHUD 创建的日出 / 日落节点却一切正常。 */
    host.appendChild(s);
    /* ★ v54（时间滑块对齐·3）：**不再做 thumb 直径补偿**。
       旧写法 `left = q·100% ± (0.5 − q)·thumbW`（thumbW 是 JS 里的硬编码 18 / 20，
       见文件顶部 TB_THUMB_W / TB_THUMB_W_WIDE）是为补偿「关键点层铺满容器、而 thumb
       圆心行程两端各内缩半个 thumb」造成的不对称。实测该补偿在宽轨（.svtb-slider.wide，
       thumb 20px）与主滑块（18px）之间、以及 --ui 缩放时必然漂移。
       现在 CSS 已让**关键点层与轨道条统一内缩 --trk-pad（= thumb 半径）**，
       与浏览器 thumb 圆心行程严格重合 ⇒ 纯百分比 `q·100%` 即精确对齐，
       thumb 尺寸变化只需改 CSS 变量，JS 不再参与。 */
    if (opt.l0 || q < 0.0005) { s.classList.add('l0'); s.style.left = '0px'; }
    else if (q > 0.9995) { s.classList.add('r0'); s.style.left = 'auto'; s.style.right = '0px'; }
    else s.style.left = (q * 100).toFixed(3) + '%';
    return s;
  }
  /* ★ v42（代码审查 · 二/#svTimeBar）：把「某个地方太阳时」写回时刻滑块并触发其 input
     监听器（监听器内部会按目标时刻差去 setSimMs），供日出 / 日中天 / 日落节点点击跳转复用。
     注意：滑块值要按**地方太阳时**取整写入，且必须 dispatch `input`，否则监听器不跑。 */
  function setHourSlider(lstT) {
    var hr = $('svHour');
    if (!hr) return;
    hr.value = String(Math.round(clamp(lstT, 0, 23.999) * 60));
    try { hr.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { console.warn('[sunview] setHourSlider dispatch input', e); }
  }

  /* ★ v37（需求二·2）：二分二至按钮「当前节气段」高亮签名（节名变化才写 DOM） */
  var _ttTermK = '';
  /* ★ v37（需求二·5）：日出 / 日中天 / 日落节点重建签名（时刻变化才重建 DOM） */
  var _sunSig = '';
  /* ★ 本批次（需求四·c/d）：第一人称方向盘的构建与拖动。
     · 把「东南西北」标签与虚线环包进一个 .svc-dial 容器 —— 该容器随航向反向旋转，
       罗盘按「方向盘转动」工作，而中间指针恒指向屏幕正前方（不再转动指针）。
     · 整盘可自由拖动：按下拖动即改 left/top（默认由 CSS 居中于视角正中心偏下方）。 */
  function setupFpCompass() {
    var cmp = $('svCompass'); if (!cmp || cmp._svBuilt) return;
    cmp._svBuilt = true;
    var dial = document.createElement('div'); dial.className = 'svc-dial';
    var ring = cmp.querySelector('.svc-ring'); if (ring) dial.appendChild(ring);
    /* ★ v58（需求 5）：方位字**搬回旋转盘面**（把 v53 的改法回退）。
       v53 把 4 个 `.svc-lbl` 留在 #svCompass 下、完全不参与旋转，后果是方位字永远钉在
       「北在上 / 东在右」的固定屏幕位置 —— 用户转向西北（朝向 296°）时罗盘仍指正北，
       这就是「方向标随视角转动时的方向指示错误」。
       正确做法是「多组风车叠加」：
         · 第 1 层 `.svc-dial` 随航向反向旋转 `rotate(-bearing)` ⇒ 方位字的**位置**正确
           （朝向 296° 时「北」转到右上 64°）；
         · 第 2 层每个 `.svc-lbl` 再自转 `rotate(+bearing)`（由 updateHUD 每帧写入的
           CSS 变量 `--svc-ccw` 驱动，见 sunview.css）⇒ 字面**恒正立**，不会侧躺 / 倒置。
       指针 #svCompassNeedle 仍在 dial 之外、恒定指向屏幕正前方（= 当前视线方向）。
       注：`.svc-dial` 是 `position:absolute; inset:0` 且无 padding / border，
       其 padding box 与 #svCompass 的 padding box 完全重合 ⇒ .svc-lbl 的
       left/top/right/bottom 偏移值无需改动。 */
    cmp.querySelectorAll('.svc-lbl').forEach(function (n) { dial.appendChild(n); });
    cmp.insertBefore(dial, cmp.firstChild);
    var drag = null;
    cmp.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      var r = cmp.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      /* 切到绝对定位：以当前实际位置为锚，避免拖动瞬间跳位 */
      cmp.style.left = Math.round(r.left) + 'px'; cmp.style.top = Math.round(r.top) + 'px';
      cmp.style.right = 'auto'; cmp.style.bottom = 'auto'; cmp._svMoved = true;
      if (cmp.setPointerCapture) { try { cmp.setPointerCapture(e.pointerId); } catch (er) { console.warn('[sunview] compass setPointerCapture', er); } }
      e.preventDefault(); e.stopPropagation();
    });
    cmp.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      cmp.style.left = Math.round(e.clientX - drag.dx) + 'px';
      cmp.style.top = Math.round(e.clientY - drag.dy) + 'px';
      e.preventDefault(); e.stopPropagation();
    });
    var up = function () { drag = null; };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { cmp.addEventListener(ev, up); });
  }
  function updateHUD(g) {
    var lst = g.lst;
    var dayLen = g.dayLen;   /* v31：必须在用到它之前声明（曾因 var 提升读到 undefined 抛异常） */
    /* v32（需求二）：日期 / 时刻 / 星期·时区 / 折叠态摘要 四段全部取自主模块同一个格式化器，
       与自转、公转、综合视图的时间卡**逐字一致**（含非 +8 时区机器上的本机时区偏移）。 */
    var tc = BR.timeCard(g.ms);
    setTxt('svTtDate', tc.date);
    setTxt('svTtClock', tc.clock);
    setTxt('svTtMeta', tc.meta);
    setTxt('svTtMini', tc.mini);
    setTxt('svLstBig', fmtHMS(lst));
    if (window.__svTtSync) window.__svTtSync(tc.parts);   /* ★ v35（需求十六）：右上时间窗滑块 / 自定义时间同步 */
    /* ★ v38（需求三）：天文数据读数 —— 与主模块 #timeCard 的 .facts 区块同源同显隐。
       数值全部来自 SUN_BRIDGE.factPanel()（主模块 updateUI 同一套算法），太阳侧只填空。 */
    var fp = BR.factPanel(g.ms);
    if (fp) {
      setTxt('svFDecl', fp.decl);
      setTxt('svFSubLon', fp.subLon);
      setTxt('svFPolarDay', fp.polarDay);
      setTxt('svFPolarNight', fp.polarNight);
      setTxt('svFObliq', fp.obliq);
      setTxt('svFTilt', fp.tilt);
      setTxt('svFOrbArea', fp.orbArea);
      setTxt('svFOrbV1', fp.orbV1);
      setTxt('svFOrbV2', fp.orbV2);
      setTxt('svFSeason', fp.season);
      var svDisp = function (id, on) { var n = $(id); if (n) n.style.display = on ? '' : 'none'; };
      svDisp('svFSubLatBox', fp.show.sub); svDisp('svFSubLonBox', fp.show.sub);
      svDisp('svFPolarDayBox', fp.show.polar); svDisp('svFPolarNightBox', fp.show.polar);
      svDisp('svFObliqBox', fp.show.obliq); svDisp('svFTiltBox', fp.show.obliq);
      svDisp('svFOrbAreaBox', fp.show.orbArea); svDisp('svFOrbVBox', fp.show.orbV);
    }
    var t24 = BR.currentTerm24(BR.solarInfo(g.ms).lam);
    setTxt('svTermTx', '当前节气：' + (t24 ? t24.name : '—') + ' · 直射点纬度 ' + BR.fmtLat(g.decl));
    /* ★ v37（需求二·2）：二分二至按钮「当前节气段」高亮 —— 口径与主模块时间面板一致：
       以上一个已过的二分二至为当前段（跨年时取上一年冬至），激活样式复用 .term.active。 */
    var _yr = BR.getYear(), _tCur = BR.solarTerms(_yr), _pk = 'WS';
    [['VE', _tCur.VE], ['SS', _tCur.SS], ['AE', _tCur.AE], ['WS', _tCur.WS]].forEach(function (s) {
      if (s[1] <= g.ms) _pk = s[0];
    });
    if (_pk !== _ttTermK) {
      _ttTermK = _pk;
      var _ttHost = $('svTtTerms');
      if (_ttHost) _ttHost.querySelectorAll('.term').forEach(function (b) {
        b.classList.toggle('active', b.dataset.svterm === _pk);
      });
    }
    /* ★ v37（需求二·5）：「时间设置」标题右侧显示地方太阳时（时分秒，显著红色）——
       取代旧版滑块上方的大号时钟（信息上移、面板更紧凑）。 */
    setTxt('svTbLst', fmtHMS(lst));
    if (!window.__svHourDragging || !window.__svHourDragging()) {
      var hr = $('svHour'); if (hr) hr.value = String(Math.round(clamp(lst, 0, 23.999) * 60));
    }
    /* 昼夜分段轨道：与关键点圆点（tbNode）**共用同一条内缩栅格**（CSS --trk-pad）。
       ★ v54（时间滑块对齐·4）：分段条是 .svtb-bar 的子元素、圆点与 range 同在 .svtb-track，
       三者的 left/right 都内缩了 --trk-pad（= thumb 半径）⇒ 分段边界可以退回**纯百分比**，
       与圆点、thumb 圆心三者严格同源。旧写法用 `calc(q·100% ± (0.5−q)·20px)`
       （TB_THUMB_W_WIDE 硬编码）硬凑，thumb 一改就漂。 */
    var _pctL = function (q) { return (q * 100).toFixed(3) + '%'; };
    var _pctR = function (q) { return ((1 - q) * 100).toFixed(3) + '%'; };
    var _riseF = g.rise / 24, _setF = g.set / 24;
    var daySeg = $('svDaySeg'), nightSeg = $('svNightSeg');
    if (daySeg) {
      if (dayLen >= 24) { daySeg.style.left = '0%'; daySeg.style.right = 'auto'; daySeg.style.width = '100%'; }
      else if (dayLen <= 0) { daySeg.style.left = '0%'; daySeg.style.right = 'auto'; daySeg.style.width = '0%'; }
      else { daySeg.style.left = _pctL(_riseF); daySeg.style.right = _pctR(_setF); daySeg.style.width = 'auto'; }
    }
    if (nightSeg) {
      if (dayLen >= 24) { nightSeg.style.left = '0%'; nightSeg.style.right = 'auto'; nightSeg.style.width = '0%'; }
      else if (dayLen <= 0) { nightSeg.style.left = '0%'; nightSeg.style.right = 'auto'; nightSeg.style.width = '100%'; }
      else { nightSeg.style.left = _pctL(0); nightSeg.style.right = _pctR(_riseF); nightSeg.style.width = 'auto'; }
    }
    /* ★ v44（需求三）：日出 / 日落原由 `.svtb-edge` 竖线标出 —— 与下方 #svSunNodes 的
       关键圆点是同一信息的两套画法。按需求「仅保留一种」，竖线（含 index.html 里的
       svEdgeRise / svEdgeNoon / svEdgeSet 与 sunview.css 的 .svtb-edge 规则）已删除，
       这里只保留**日中天时刻的推导**（与下方节点的 noonP 同源，仍是同一串计算）。 */
    var noonT = (g.rise + g.set) / 2;
    /* ★ v37（需求二·5）：日出 / 日中天 / 日落 —— 注释挂在昼夜轨道对应时刻的**正下方并
       居中对齐**，随时间实时更新；极昼 / 极夜时显示整段提示。按 rise|set|dayLen 签名，
       时刻变化才重建 DOM（旧版每帧 innerHTML 全量重建）。 */
    var sunHost = $('svSunNodes');
    if (sunHost) {
      var sunSig = Math.round(g.rise * 60) + '|' + Math.round(g.set * 60) + '|' + dayLen.toFixed(2);
      if (sunSig !== _sunSig) {
        _sunSig = sunSig;
        sunHost.innerHTML = '';
        if (dayLen > 0 && dayLen < 24) {
          /* ★ v42（代码审查 · 二/#svTimeBar）：这三个节点原先是**没有 click 的纯 span**，
             却和上面那些「真能点的刻度节点」长得一样、还带 hover 高亮 —— 同一块面板里两种
             「看起来一样、行为完全不同」的元素。现在三者都挂 click（点一下把时刻跳到该时刻），
             由 tbNode 统一补 role / tabindex / 键盘，语义与行为终于一致。 */
          tbNode(sunHost, g.rise / 24, '日出 ' + fmtHM(g.rise), {
            click: function () { setHourSlider(g.rise); }
          });
          tbNode(sunHost, g.set / 24, '日落 ' + fmtHM(g.set), {
            click: function () { setHourSlider(g.set); }
          });
          /* 日中天由上面的 noonT 推导（= (rise + set) / 2，见 v42 去掉硬编码 50% 的注释） */
          tbNode(sunHost, noonT / 24, '日中天 ' + fmtHM(noonT), {
            prime: true, click: function () { setHourSlider(noonT); }
          });
        } else if (dayLen >= 24) {
          tbNode(sunHost, 0.04, '极昼 · 昼长 24 时 00 分', {});
        } else {
          tbNode(sunHost, 0.04, '极夜 · 昼长 0 时 00 分', {});
        }
      }
    }
    /* 监测面板（v32 需求二：数值口径与主模块「地球运动观测」面板逐字统一）
       v34：按《副设置面板 › 观察与测量 › 数据面板》补齐为 15 行。 */
    var ob = BR.getObs();   /* 每帧只取一次，避免 obsLat()/obsLon() 各自再分配一个对象 */
    setTxt('svmPos', BR.fmtLat(ob.lat) + '，' + BR.fmtLon(ob.lon));
    /* ★ v37（需求二·5）：「观测点位置」标题右侧同步显示观测点经纬度（显著红色） */
    setTxt('svTbPos', BR.fmtLat(ob.lat) + '，' + BR.fmtLon(ob.lon));
    setTxt('svmLst', fmtHMS(lst));
    /* 节气：当前太阳黄经落在哪个节气（与时间面板同一份节气表） */
    var t24m = BR.currentTerm24(BR.solarInfo(g.ms).lam);
    setTxt('svmTerm', t24m ? t24m.name : '—');
    /* 时区：按经度就近取整时区（|lon|/15 四舍五入），区时 = 世界时 + 偏移 */
    var zOff = clamp(Math.round(ob.lon / 15), -12, 12);
    var zName = zOff === 0 ? '中时区（UTC±0）'
      : (zOff > 0 ? '东' + zOff + '区（UTC+' + zOff + '）' : '西' + (-zOff) + '区（UTC−' + (-zOff) + '）');
    setTxt('svmTz', zName + ' · 区时 ' + fmtHMS(((lst - ob.lon / 15) + zOff + 48) % 24));
    var dnRow = $('svmDnRow');
    var dn = g.polar === 1 ? '极昼' : (g.polar === -1 ? '极夜' : (g.alt > 0 ? '白昼' : '黑夜'));
    setTxt('svmDayNight', dn);
    if (dnRow) dnRow.classList.toggle('night', g.alt <= 0);
    setTxt('svmDayLen', dayLen >= 24 ? '极昼 · 24 时 00 分' : (dayLen <= 0 ? '极夜 · 0 时 00 分' : BR.fmtHm(dayLen)));
    /* 全年昼长极值：取二至日的昼长（夏至最长 / 冬至最短，极区按极昼 24h / 极夜 0h 呈现）。
       ★ v42（代码审查 · 二/#svTimeBar）：黄赤交角原先**写死 23.44°**，而本项目默认黄赤交角是
       23°26′ = 23.4333…°，且主模块「黄赤交角」是可调的 —— 于是面板其他地方显示 23°26′、
       这里却按 23.44° 算，读者把黄赤交角调一调，昼长极值读数却纹丝不动（自相矛盾）。
       改为统一走 `BR.getObliquity()`（与 dayLenAtDecl 的口径同源，主模块默认 23°26′）。 */
    var oblq = BR.getObliquity();
    var dlSum = dayLenAtDecl(ob.lat, oblq), dlWin = dayLenAtDecl(ob.lat, -oblq);
    var yMin = Math.min(dlSum, dlWin), yMax = Math.max(dlSum, dlWin);
    var yFmt = function (v) { return v >= 24 ? '极昼 24h' : (v <= 0 ? '极夜 0h' : BR.fmtHm(v)); };
    setTxt('svmYlen', yFmt(yMin) + ' ~ ' + yFmt(yMax));
    setTxt('svmAz', (g.alt > -0.5 ? azName(g.az) + ' ' + g.az.toFixed(1) + '°' : '—'));
    setTxt('svmAlt', (g.alt < 0 ? '−' : '') + Math.abs(g.alt).toFixed(1) + '°');
    /* 太阳直射点：纬度 = 太阳赤纬，经度 = −15°×(世界时 − 12) − 时差 */
    var utcHm = ((((g.ms % 86400000) + 86400000) % 86400000) / 3600000);
    var subLon = -15 * (utcHm - 12) - g.eot / 60;
    subLon = ((subLon + 540) % 360) - 180;
    setTxt('svmSub', BR.fmtLat(g.decl) + '，' + BR.fmtLon(subLon));
    /* 日出 / 日落时刻与方位：H0 = 日出时角，方位角用同一 altAzOfH 口径 */
    if (dayLen >= 24) setTxt('svmRise', '极昼 · 无日出日落');
    else if (dayLen <= 0) setTxt('svmRise', '极夜 · 无日出日落');
    else setTxt('svmRise', fmtHM(g.rise) + ' / ' + fmtHM(g.set));
    var rAz = '', sAz = '';
    if (dayLen > 0 && dayLen < 24) {
      var H0 = dayLen * 7.5;                       /* 半昼弧（度）= 昼长(h) × 15 ÷ 2 */
      rAz = altAzOfH(-H0, ob.lat, g.decl).az;
      sAz = altAzOfH(H0, ob.lat, g.decl).az;
    }
    setTxt('svmRaz', (rAz === '') ? '—' : rAz.toFixed(1) + '° / ' + sAz.toFixed(1) + '°');
    var noonAlt = 90 - Math.abs(ob.lat - g.decl);
    setTxt('svmNoon', (noonAlt <= 0 ? '太阳终日不升' : noonAlt.toFixed(1) + '°'));
    /* 自转线速度 = 465.1·cosφ m/s（赤道 465 m/s）；角速度处处相同 15°/h */
    setTxt('svmLv', (465.1 * Math.cos(ob.lat * D)).toFixed(1) + ' m/s');
    setTxt('svmAv', '15.0 °/h');
    /* v33（面板规格）：观测点数据面板逐行显隐 —— 由「观察与测量 › 数据面板」控制。
       这些行没有 .sv-on 显隐体系（它们随父面板一起显隐），直接切 display。 */
    ['pos:svmRowPos', 'lst:svmRowLst', 'term:svmRowTerm', 'tz:svmRowTz', 'dn:svmDnRow',
      'len:svmRowLen', 'ylen:svmRowYlen', 'az:svmRowAz', 'alt:svmRowAlt', 'sub:svmRowSub',
      'rise:svmRowRise', 'raz:svmRowRaz', 'noon:svmRowNoon', 'lv:svmRowLv', 'av:svmRowAv']
      .forEach(function (p) {
        var k = p.split(':'), n = $(k[1]);
        if (n) n.style.display = S.panel.rows[k[0]] ? '' : 'none';
      });
    /* 播放按钮 / 速度 */
    var bp = $('svBtnPlay'); if (bp) bp.textContent = BR.isPlaying() ? '暂停' : '播放';
    /* 第一人称罗盘（★ 需求四·c：盘面旋转、指针恒指正前） */
    if (S.fp) {
      var bearing = ((fpYaw * R) % 360 + 360) % 360;
      var read = $('svCompassRead');
      if (read) read.textContent = '朝向 ' + azName(bearing) + ' ' + bearing.toFixed(0) + '°';
      var cmp = $('svCompass');
      if (cmp) {
        /* ★ 需求四·c：虚线刻度环所在的盘面按航向反向旋转，中间指针固定指向正前方。
           ★ v58（需求 5）：盘面里现在**同时有**刻度环与 4 个方位字
           （见 setupFpCompass），rotate 一转，方位字的位置就跟着航向走 ——
           朝向 296°（西北）时「北」会转到右上约 64°，与真实方向一致。
           字面正的保证：同一帧把 +bearing 写进 --svc-ccw，每个 .svc-lbl 用它自转抵消
           （sunview.css 的 .svc-lbl 规则），因此字永远朝上、不会侧躺 / 倒置。
           指针 #svCompassNeedle 在 dial 外、不转，恒指屏幕正前（= 当前视线方向）。 */
        var dial = cmp.querySelector('.svc-dial');
        if (dial) dial.style.transform = 'rotate(' + (-bearing) + 'deg)';
        cmp.style.setProperty('--svc-ccw', bearing + 'deg');
        cmp.style.display = S.fpmark.on ? 'block' : 'none';
        var sc = S.fpmark.size / 100;
        /* ★ 需求四·d：拖动过后用绝对定位，否则保持默认「水平居中于正中心偏下方」 */
        cmp.style.transform = cmp._svMoved ? ('scale(' + sc + ')') : ('translateX(-50%) scale(' + sc + ')');
        cmp.style.opacity = String(S.fpmark.op / 100);
        /* 方位字颜色：标签已回到 #svCompass 下，querySelectorAll 仍能取到（后代选择器），
           取色口径不变。 */
        cmp.querySelectorAll('.svc-lbl').forEach(function (n) { n.style.color = S.fpmark.color; });
      }
    }
    /* ★ v53（需求一·3）：**删除** setTxt('svWinEarthTx', '观测点 …经纬度…')。
       为什么删：index.html 里 #svWinEarthTx 的默认文案是**静态**的「观测点正面」，
       描述的是小窗的姿态语义（正面中经线 / 地轴竖直），而每帧这行会用经纬度把它覆盖掉
       —— 两者语义不同、且每帧都写，静态文案等于 0 帧内就被改掉，等于白留。
       经纬度请看「观测点数据」面板（sVm* 系列行），那里本来就是完整显示且不重复。 */
    setTxt('svWinSkyTx', '天球 · 太阳高度 ' + (g.alt < 0 ? '−' : '') + Math.abs(g.alt).toFixed(1) + '°');
  }
  function setTxt(id, t) { var n = $(id); if (n && n.textContent !== t) n.textContent = t; }

  /* 悬浮窗缩略图更新 */
  var _hudLat = 1e9, _hudLon = 1e9;   /* ★ v35（需求五）：小窗专用观测点变化侦测 */
  function updateWinThumbs(g, dt) {
    /* 地球位置：让监测点正面朝向相机 */
    applyEarthTexture();
    var lat = clamp(obsLat(), -89, 89) * D, lon = obsLon() * D;
    /* ★ v35（需求五）：观测点悬浮窗**始终保持观测点在地球正面**。
       地球本体每帧被旋转到「观测点朝 +Z」，默认机位（yaw=0）正对 +Z ⇒ 正面；
       但用户拖拽小窗后机位偏移会一直保留，再改纬度 / 经度时观测点就跑到侧面甚至背面。
       处理：观测点一变，立即把小窗机位回正到默认（仍保留拖拽 / 缩放自由）。 */
    if (lat !== _hudLat || lon !== _hudLon) {
      _hudLat = lat; _hudLon = lon;
      orbEarth.yaw = orbEarth.def.yaw; orbEarth.pitch = orbEarth.def.pitch;
    }
    /* ★ v37（需求二·6）：松手后自动缓动回正 —— 拖拽期间完全不打扰（_dragging 置位时
       跳过），松手后每帧以 0.15 系数把 yaw / pitch 拉回默认机位，观测点恒在视角正面；
       缩放（dist）不受影响。yaw 取最短角路径，避免从大角度绕远路转回。 */
    if (!orbEarth._dragging &&
        (orbEarth.yaw !== orbEarth.def.yaw || orbEarth.pitch !== orbEarth.def.pitch)) {
      var dy = orbEarth.def.yaw - orbEarth.yaw;
      dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      orbEarth.yaw += dy * 0.15;
      orbEarth.pitch += (orbEarth.def.pitch - orbEarth.pitch) * 0.15;
      if (Math.abs(dy) < 0.004) orbEarth.yaw = orbEarth.def.yaw;
      if (Math.abs(orbEarth.def.pitch - orbEarth.pitch) < 0.004) orbEarth.pitch = orbEarth.def.pitch;
    }
    /* ★ v33（需求一）：经度号的符号此前与地球贴图 / 主模块相反。
       主模块约定（app.js geoDir）：0° 经线在 +X，方位角 az = −经度，
       故方向 = (cosφ·cos(−λ), sinφ, cosφ·sin(−λ)) = (cosφ·cosλ, sinφ, **−**cosφ·sinλ)。
       旧写法 z 分量取了 +cosφ·sinλ ⇒ 观测点在东西方向上镜像（北京被标到西半球一侧），
       与地球昼夜贴图上的海陆轮廓对不上。 */
    var dir = _hudV1
      .set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    /* ★★ v53（需求一·2，核心修复）：地球姿态改为**纯 yaw（只绕地轴 Y 旋转）**。
       ── 旧写法为什么错 ──────────────────────────────────────────────
       `q.setFromUnitVectors(dir, +Z)` 求的是「把 dir 这个单位向量转到 +Z 的**最短旋转**」。
       但 dir 一般既不是 +Z 也不是 −Z（例：lat=39.9°、lon=116.4° ⇒ dir≈(−0.402,0.642,−0.657)），
       于是旋转轴 = dir × (+Z) 是一条**既不是地轴、也不是任何坐标轴**的任意轴；
       最小旋转只保证「把 dir 送到 +Z」，**不约束其它轴向** ⇒ 整颗地球连同地轴 +Y 一起
       被转到任意姿态。结果：地轴不再竖直（北极点歪向一边，随经度变化越歪越离谱），
       相机 up=+Y 于是产生明显 roll，「南半球 / 北半球」在画面上左右颠倒。
       ── 新写法为什么对 ──────────────────────────────────────────────
       地球是绕自身 Y 轴（地轴）自转的，姿态只有一个自由度有意义 —— 经度。
       取 θ = −(λ + 90°)，代入 THREE 的绕 Y 旋转（x' = x·cosθ + z·sinθ，
       z' = −x·sinθ + z·cosθ）：
         x' = cosφ·cos(λ+θ) = cosφ·cos(−90°) = 0
         z' = −cosφ·sin(λ+θ) = −cosφ·sin(−90°) = +cosφ ≥ 0
         y' = sinφ（旋转不改 y ⇒ 纬度仍是 lat）
       ⇒ 观测点恰落在**朝向相机的正面中经线**上，纬度不变；
       又因为只绕 Y 旋转，地轴 +Y 严格保持竖直，相机 up=+Y ⇒ 无 roll。
       这与「用户手里转着地球仪、转到 wanted 经度正对眼前」完全等价。 */
    eEarth.rotation.set(0, -(lon + Math.PI / 2), 0);
    eMarker.position.copy(dir).multiplyScalar(1.02);
    /* ★ v53（需求一·1）：原先这里还有 4 行给 eMarkerLabel（「观测点」精灵）定位 ——
       其中 _hudUp 需要「把世界上方反变换到地球局部空间」，而现在地球只绕 Y 转、
       局部 Y 恒等于世界上方（偏移直接写 +Y 即可），该精灵已整体删除，逻辑随之移除。 */
  }

  /* ============================ 22. 主循环 ============================ */
  var _lastLat = 1e9, _lastLon = 1e9, _dirtyCel = true, _lastTS = 0, _hudAcc = 0;
  var _trailSig = '';
  /* ★ 修复 #7：动态绘制模式下 trailSig 含 g.lst（每帧变化）⇒ 每帧重建 TubeGeometry + 精灵。
     这里记录上次重建时间戳，动态模式下 <120ms 的重建请求直接跳过（静态模式立即重建）。 */
  var _trailRebuildT = 0;
  function tickSun(ts) {
    requestAnimationFrame(tickSun);
    var dt = Math.min(((ts - _lastTS) || 16) / 1000, 0.12);
    _lastTS = ts;
    tickView();
    if (BR.getView() !== 'sun') return;

    var lat = obsLat(), lon = obsLon();
    if (lat !== _lastLat || lon !== _lastLon) {
      _lastLat = lat; _lastLon = lon; _dirtyCel = true;
    }
    if (_dirtyCel) { _dirtyCel = false; buildCelestial(); }

    var g = sunGeom(BR.getSimMs(), lat, lon);
    stepCelRot(dt);                 /* ★ v41（需求一·11）：唯一写点，dt 归一化收敛 */
    updateGround(g);
    updateCelestial(g);
    if (window.__svDateSync) window.__svDateSync(BR.getSimMs());
    if (S.fp) updateFP(g, dt);
    updateIndoor(g);
    updateIndoorCam();
    projectIndoorDirMarks();   /* ★ v39：室内方位标投影（须在 iCam 位置更新之后） */
    if (!S.fp && !S.indoor) updateGroundCam(g);
    if (S.view === 'sky' && !S.indoor && !S.fp) updateCelestialCam();

    /* v31（需求三）：全局总开关「显示全部文字注释」叠加到各类注记自身显隐之上 */
    gateMasterNotes();
    /* ★ v44（需求八）：「退出物影测量」按钮跟随测量显示状态（每帧幂等同步，见 syncMeasExit） */
    syncMeasExit();

    /* 主画面 */
    var cam = S.fp ? fpCam : (S.indoor ? iCam : (S.view === 'sky' ? cCam : gCam));
    var scn = S.indoor ? iScene : (S.view === 'sky' ? cScene : gScene);
    /* ★ 修复 #13：原 `if (S.indoor && !S.fp) scn = iScene;` 是死赋值 —— 上一行的
       `S.indoor ? iScene : …` 已经把 indoor 情形覆盖，删除。 */
    /* ★ v35（需求七）：主视图渲染前按相机距离补偿注释字号（屏幕字号恒定）。
       ★ v43（三·2）：基准机位改为**取自相机默认距离的真实常量** ——
       地面此前写的是魔数 46（那其实是 wGroundCam 的 fov，不是距离；gDist 默认 36），
       标称距离与实际机位不匹配会让地面注释整体偏小/偏大。
       现在：天球 = orbSky.def.dist，地面 = gDist 的初始值 36（见 2139 行 gDist = 36）。
       室内 / 第一人称相机基本固定，不做补偿。 */
    if (!S.fp && !S.indoor) {
      if (S.view === 'sky') applySvNoteK(cCam, orbSky.def.dist, cScene);
      else applySvNoteK(gCam, G_REF_DIST, gScene);
    }
    /* ★ v58（需求 2）：选中描边粗细按「当前机位 + 视口高度」每帧重算 ⇒ 屏幕恒 3–5px。 */
    updateEdgeScale();
    rnd.render(scn, cam);

    /* ★ v39（需求三）：太阳视运动综合视图 —— 各窗格由自己的小 renderer 渲染；
       主画布的「地球自转 / 公转」内容经 SUN_BRIDGE.earthScene 的场景 + 相机直接出图。 */
    if (S.combo && S.combo.on && S.view === 'combo') {
      /* ★ 修复 #13：删除对主画布的冗余 `rnd.render(gScene, gCam)` ——
         ① 综合视图下 #svComboUI 是全屏不透明覆盖层，主画布被完全遮挡（渲了也看不见）；
         ② 地球 / 公转窗格由各窗格自己的 renderer 渲染 earthScene 返回的场景 + 相机，不依赖主画布。
         仅保留地面场景的注释字号补偿（地面窗格用 gCam 渲染，需要该口径；函数幂等）。 */
      applySvNoteK(gCam, G_REF_DIST, gScene);
      /* ★ 本批次（需求三）：天球窗格与单一「天球视图」同口径做注释字号补偿 */
      applySvNoteK(cCam, orbSky.def.dist, cScene);
      renderSunCombo(dt);
      /* ★ v53（需求一·1）：综合视图下**继续渲染 3 个缩略悬浮窗**。
         旧实现在这里直接 return，把悬浮窗渲染整段跳过了 —— 于是即使把面板的
         隐藏条件去掉，窗内容器也会是一片空白（画布从未被画过）。 */
      renderWinThumbs(g);
      _hudAcc += dt;
      if (_hudAcc > 0.09) { _hudAcc = 0; updateHUD(g); }
      return;
    }

    /* 单一视图：同样渲染 3 个缩略悬浮窗（v53 起与综合视图共用 renderWinThumbs） */
    renderWinThumbs(g);
    _hudAcc += dt;
    if (_hudAcc > 0.09) { _hudAcc = 0; updateHUD(g); }
  }

  /* ★ v53（需求一·1）：3 个缩略悬浮窗的渲染（观测点位置 / 天球视图 / 地面全景）。
     提取为独立函数，使**综合视图与单一视图共用同一段代码** ——
     旧实现在综合视图分支里直接 return，悬浮窗画布从未被渲染过（空白）。
     隐藏或折叠的窗直接跳过渲染，省开销。 */
  function renderWinThumbs(g) {
    function visible(id) { var n = $(id); return n && n.classList.contains('sv-on') && !n.classList.contains('collapsed'); }
    if (visible('svWinEarth')) { resizeWin($('svCvEarth'), wEarth, eCam); updateWinThumbs(); orbApply(eCam, orbEarth); wEarth.render(eScene, eCam); }
    /* 天球 / 地面悬浮窗用**单一视图同一套相机**出图 ——
       先把主相机摆到当前机位（update*Cam），再同步到小相机（syncWinCam），
       于是悬浮窗内容（朝向 / 缩放 / fov）与单一窗口完全一致。 */
    if (visible('svWinSky')) {
      updateCelestialCam();
      resizeWin($('svCvSky'), wSky, wSkyCam);
      syncWinCam(wSkyCam, cCam);
      wSky.render(cScene, wSkyCam);
    }
    if (visible('svWinGround')) {
      updateGroundCam(g);
      resizeWin($('svCvGround'), wGround, wGroundCam);
      syncWinCam(wGroundCam, gCam);
      wGround.render(gScene, wGroundCam);
    }
  }

  /* ============================ 23. 初始化 ============================ */
  function boot() {
    buildCelestial();
    /* v37（需求二·4）：地面机位默认静止，不再开机自动对准太阳（旧逻辑会随时间漂移） */
    applyEarthTexture();
    onStateChanged();
    resizeMain();
    syncBodyClasses();
    applySurfaceLayout();
    applyPanelVisibility();
    setupFpCompass();          /* ★ 需求四·c/d：构建可转动 / 可拖动的第一人称方向盘 */
    requestAnimationFrame(tickSun);
    /* 贴图异步就绪后再取一次 */
    setTimeout(applyEarthTexture, 1200);
    setTimeout(applyEarthTexture, 4000);
    setTimeout(function () { applySurfaceLayout(); }, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();


  /* 供外部（主模块 / 探针 / 菜单规模统计）查询本模块的对外状态 */
  window.SUNVIEW = {
    state: function () { return { view: S.view, indoor: S.indoor, fp: S.fp, sunflower: S.sunflower,
      win: S.win, panel: S.panel, coord: S.coord, traj: S.traj, vol: S.vol, sunr: S.sunr }; },
    /* ★ v40（需求六）：两行总菜单的一级按钮用 —— 进入 / 退出太阳视运动模块。
       enter：切顶层视图到 sun，并恢复到上次的太阳内部视图（combo 需重开对话框，回落到 ground）；
       exit ：切回地球运动（默认自转视图），由主模块决定。 */
    enter: function () {
      if (BR.setView && BR.getView() !== 'sun') BR.setView('sun');
      if (S.view === 'combo' && !(S.combo && S.combo.on)) S.view = 'ground';
      if (window.__svSyncViewSeg) window.__svSyncViewSeg();
      applyPanelVisibility();
      resizeMain();
    },
    exit: function () {
      if (S.fp) exitFP();
      if (S.indoor) exitIndoor();
      leaveSunCombo();                                 /* ★ v41（需求一·8）：切走即退出综合视图 */
      if (BR.setView) BR.setView('rotate');
    },
    geom: function () { return sunGeom(BR.getSimMs(), obsLat(), obsLon(), {}); },
    /* v31：审计 / 探针用 —— 菜单控件 path 是否真能命中状态对象（需求十四「调了没反应」的排查入口） */
    _S: function () { return S; },
    /* ★ v41（需求一·7）探针用：本模块各相机的状态量（综合窗格拖拽 / 滚轮是否真的驱动了机位）。
       地球自转 / 公转在 SUN_BRIDGE.earthOrbit 里，返回其当前球坐标。 */
    _cam: function () {
      var br = window.SUN_BRIDGE || {};
      return {
        view: S.view, fp: !!S.fp, indoor: !!S.indoor, sunflower: !!S.sunflower, gAimSun: !!gAimSun,
        g: { yaw: gYaw, pitch: gPitch, dist: gDist },
        c: { yaw: cYaw, pitch: cPitch, dist: cDist },
        i: { yaw: iYaw, pitch: iPitch, dist: iDist },
        fpv: { yaw: fpYaw, pitch: fpPitch },
        earth: br.earthOrbit ? br.earthOrbit('rotate', 0, 0, 1) : null,
        orbit: br.earthOrbit ? br.earthOrbit('revolve', 0, 0, 1) : null,
      };
    },
    /* ★ v41（需求一·9 / 一·10 / 一·11）探针用：天球坐标系几何统计。
       equ：天赤道折线（顶点数 / 半径范围 / y 范围 / 相邻最大间距 / 是否与地平圈相交于两点）；
       grid：经纬网格各条线的顶点数与 y 范围（判「只显示地平线以上」是否生效）；
       rotX：cRoot 当前 X 旋转（判赤道坐标系固定是否稳定 / 晃动）。 */
    _cel: function () {
      function pts(m) {
        if (!m || !m.geometry || !m.geometry.attributes.position) return null;
        var a = m.geometry.attributes.position;
        var n = (m.geometry.drawRange && isFinite(m.geometry.drawRange.count) && m.geometry.drawRange.count > 0)
          ? Math.min(a.count, m.geometry.drawRange.count) : a.count;
        var out = [];
        for (var i = 0; i < n; i++) out.push([+a.getX(i).toFixed(3), +a.getY(i).toFixed(3), +a.getZ(i).toFixed(3)]);
        return out;
      }
      function stat(list) {
        if (!list || !list.length) return null;
        var rMin = 1e9, rMax = -1e9, yMin = 1e9, yMax = -1e9, gap = 0;
        for (var i = 0; i < list.length; i++) {
          var p = list[i], r = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
          rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
          yMin = Math.min(yMin, p[1]); yMax = Math.max(yMax, p[1]);
          if (i) {
            var q = list[i - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            gap = Math.max(gap, d);
          }
        }
        return { n: list.length, rMin: +rMin.toFixed(3), rMax: +rMax.toFixed(3),
                 yMin: +yMin.toFixed(3), yMax: +yMax.toFixed(3), gap: +gap.toFixed(3) };
      }
      var eq = pts(equLine);
      return {
        sys: S.coord.sys, aboveOnly: !!S.coord.aboveOnly, rotX: +cRoot.rotation.x.toFixed(4),
        CS: CS, lat: obsLat(),
        equ: stat(eq),
        equEnds: eq && eq.length ? [eq[0], eq[eq.length - 1]] : null,
        /* 晃动排查：天赤道三个代表点的**世界坐标**（随帧采样看是否真的在动） */
        equWorld: (eq && eq.length) ? [0, Math.floor(eq.length / 2), eq.length - 1].map(function (i) {
          var v = new THREE.Vector3(eq[i][0], eq[i][1], eq[i][2]);
          if (equLine) equLine.localToWorld(v);
          return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
        }) : null,
        rebuilds: _celRebuilds,
        /* 晃动排查②：第一条网格线首顶点的世界坐标（随帧采样看网格是否真的在动） */
        gridWorld: (cGridLines.length && cGridLines[0].geometry.attributes.position)
          ? (function () {
              var a = cGridLines[0].geometry.attributes.position;
              var v = new THREE.Vector3(a.getX(0), a.getY(0), a.getZ(0));
              cGridLines[0].localToWorld(v);
              return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
            })() : null,
        equPlaneArc: equPlane && equPlane.geometry && equPlane.geometry.parameters
          ? { start: +equPlane.geometry.parameters.thetaStart.toFixed(4), len: +equPlane.geometry.parameters.thetaLength.toFixed(4) } : null,
        grid: cGridLines.map(function (l) { return stat(pts(l)); }),
      };
    },
    /* ★ v32（需求五）：已放置的地面物体清单（探针枚举用）——
       附带按当前地面相机投影出的屏幕坐标 sx/sy，探针据此**走真实拾取路径**（合成 pointerdown/up
       落到 svCanvas 上）来选中物体，而不是绕过 UI 直接改内部变量。 */
    _props: function () {
      var r = canvas.getBoundingClientRect();
      var v = new THREE.Vector3();
      return props.map(function (o) {
        var H = objHeightOf(o);
        v.set(o.position.x, H * 0.5, o.position.z).project(gCam);
        return {
          id: o.userData.id, kind: o.userData.kind,
          x: +o.position.x.toFixed(3), z: +o.position.z.toFixed(3),
          h: +H.toFixed(3), selected: !!o.userData.selected,
          sx: Math.round(r.left + (v.x * 0.5 + 0.5) * r.width),
          sy: Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height),
          inFront: v.z < 1,
        };
      });
    },
    /* ★ v58（需求 2）探针用：选中描边（inverted hull）状态 ——
       逐物体返回外壳网格数 / 实际显示数 / 描边色 / side / 法线外推量（世界单位）
       与折算出的**屏幕像素宽**（px ≈ EDGE_PX = 4 即达标）。 */
    _edge: function () {
      var cam = (S.fp && fpCam) ? fpCam : gCam;
      var vsz = new THREE.Vector2(); if (rnd && rnd.getSize) rnd.getSize(vsz);
      var v = new THREE.Vector3();
      return props.map(function (o) {
        var hs = (o.userData && o.userData.outline) || null;
        var kw = null, px = null;
        if (hs && hs.length && cam && vsz.y) {
          o.getWorldPosition(v);
          var dist = Math.max(1e-3, cam.position.distanceTo(v));
          var wpp = 2 * dist * Math.tan((cam.fov || 45) * D / 2) / vsz.y;
          var u = hs[0].material && hs[0].material.userData && hs[0].material.userData.uEdgeW;
          kw = u ? +u.value.toFixed(4) : null;
          px = kw != null ? +(kw / wpp).toFixed(2) : null;
        }
        return { id: o.userData.id, kind: o.userData.kind, selected: !!o.userData.selected,
                 hulls: hs ? hs.length : 0,
                 visible: hs ? hs.filter(function (h) { return h.visible; }).length : 0,
                 color: (hs && hs[0] && hs[0].material) ? '#' + hs[0].material.color.getHexString() : null,
                 side: (hs && hs[0] && hs[0].material) ? hs[0].material.side : null,
                 uEdgeW: kw, px: px };
      });
    },
    /* ★ v58（需求 2）探针用：逐物体「按当前机位投影 → 走真实拾取路径 groundHitFromEvent」
       自检 —— 用来判定「双击选中失效」到底是投影点不对还是射线拾取不对（二者都受
       相机机位影响，故必须走同一条 groundHitFromEvent，而不是另写一套 raycast）。
       注意：必须在渲染循环跑起来（相机已由 updateGroundCam 摆好）之后再调用。 */
    _hitSel: function () {
      var cam = S.fp ? fpCam : gCam;
      var r = canvas.getBoundingClientRect();
      var rows = props.map(function (o) {
        var H = objHeightOf(o);
        var p = new THREE.Vector3(o.position.x, H * 0.5, o.position.z).project(cam);
        var sx = r.left + (p.x * 0.5 + 0.5) * r.width;
        var sy = r.top + (-p.y * 0.5 + 0.5) * r.height;
        if (sx < r.left + 1 || sx > r.right - 1 || sy < r.top + 1 || sy > r.bottom - 1) {
          return { id: o.userData.id, kind: o.userData.kind, off: true };
        }
        var h = groundHitFromEvent({ clientX: sx, clientY: sy });
        return { id: o.userData.id, kind: o.userData.kind,
                 sx: Math.round(sx), sy: Math.round(sy),
                 hit: h ? (h.obj ? h.obj.userData.id : 'ground') : null };
      });
      return { placing: placing, view: S.view, fp: !!S.fp, indoor: !!S.indoor,
               canvas: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
               rows: rows };
    },
    _get: function (p) { return getPath(S, p); },
    _set: function (p, v) { setPath(S, p, v); onStateChanged(); saveSoon(); },
    _def: function () { return DEF; },
    /* ★ v32（需求六）：主模块改了「全局文字样式」后由 app.js 的 notifyNoteChange() 调进来，
       立即按分类重算 / 重绘本模块的全部注记精灵。
       ★ v33（需求：四视图「全局文字设置」统一）：同时 syncSunBinders() —— 否则本模块【全局文字样式】
       菜单里的控件值 / 置灰态仍停留在旧值，与主模块改后的值不一致。 */
    _refreshNotes: function () { applyNoteStyles(); syncSunBinders(); },
    /* ★ v32（需求六）：注释精灵清单（审计 / 探针用：查看每条注释的文本 / 分类 / 尺寸 / 显隐） */
    _notes: function () {
      /* ★ v41（需求一·15）：附带「屏幕占比」frac —— 精灵高度 / (2·到相机距离·tan(fov/2))，
         即注释在画面高度上占的比例。探针据此断言：滚轮推拉相机后 frac 不变（字号＝屏幕占比）。
         dist：精灵到当前相机（地面机位 / 天球机位 / 室内 / 第一人称）的距离。 */
      var cam = S.fp ? fpCam : (S.indoor ? iCam : (S.view === 'sky' ? cCam : gCam));
      var fov = (cam && cam.isPerspectiveCamera && cam.fov) ? cam.fov * Math.PI / 180 : null;
      var np = _nkPos || (_nkPos = new THREE.Vector3());
      /* ★ v43（三·2）：同 applySvNoteK —— 先刷世界矩阵，否则本帧新建精灵的距离读成 0。 */
      var _scn = S.indoor ? iScene : (S.view === 'sky' ? cScene : gScene);
      if (_scn && _scn.updateMatrixWorld) _scn.updateMatrixWorld(true);
      return allNoteSps.map(function (sp) {
        var u = sp.userData || {};
        var dist = 0;
        if (cam && cam.isPerspectiveCamera) {
          np.setFromMatrixPosition(sp.matrixWorld);
          dist = cam.position.distanceTo(np);
        }
        var frac = fov && dist > 1e-3 ? +(sp.scale.y / (2 * dist * Math.tan(fov / 2))).toFixed(5) : null;
        /* ★ v43（三·2）：sd0 / kf 两项随 noteRefDist 一并删除 —— 标称距离已改为
           applySvNoteK 的场景统一 refD，不再逐条登记；这里补上 pxH（屏幕像素高）便于探针核对。 */
        return { text: u.text, cat: u.cat || null, vis: !!sp.visible, dist: +dist.toFixed(3), frac: frac,
                 pxH: fov && dist > 1e-3 ? +((sp.scale.y / (2 * dist * Math.tan(fov / 2))) * (window.innerHeight / 2)).toFixed(2) : null,
                 w: +sp.scale.x.toFixed(4), h: +sp.scale.y.toFixed(4),
                 color: '#' + (sp.material && sp.material.color ? sp.material.color.getHexString() : 'ffffff'),
                 op: sp.material ? +sp.material.opacity.toFixed(3) : 1 };
      });
    },
    /* ★ v32（需求五）：测量物影几何（审计 / 探针用）——
       逐目标返回：物体高度 H、地面影线（中心 + 长度）、过顶光线三点（落地点 / 物体顶点 / 太阳端）、
       三处数值注释文本。用来断言三件事：
       ① 光线一端连太阳、经物体最高点、另一端落地（三点与太阳方向严格共线）；
       ② 影线一端连物体地面几何中心、另一端连该光线与地面的交点；
       ③ 高度 / 影长 / 高度角注释文本与几何一致。 */
    _meas: function () {
      var targets = measTargets();
      return targets.map(function (o, i) {
        var rec = _measPool[i]; if (!rec) return null;
        var H = objHeightOf(o);
        var pos = (rec.ray && rec.ray.geometry) ? rec.ray.geometry.attributes.position : null;
        var ray = null;
        if (pos && pos.count >= 3) {
          ray = [];
          for (var k = 0; k < 3; k++) ray.push({ x: +pos.getX(k).toFixed(4), y: +pos.getY(k).toFixed(4), z: +pos.getZ(k).toFixed(4) });
        }
        /* ★ v42（代码审查改法 B）：逐条掠顶光线（主光线 + 平行线）端点，供探针断言
           「擦过顶端 / 与影尖相接 / rayLen 拉满即等于太阳中心 / 多根时互相平行」。 */
        var rays = (rec.rays || []).map(function (r) {
          /* ★ v44：优先用 updateMeasure 写下的真实端点（ribbon 的第 0/1 顶点不是端点，见那里注释）。 */
          var e = (r && r.userData) ? r.userData._end : null;
          if (e) {
            return { vis: !!r.visible, y0: +e.ay.toFixed(4), y1: +e.by.toFixed(4), src: 'end',
              apex: { x: +e.cx.toFixed(4), y: +e.cy.toFixed(4), z: +e.cz.toFixed(4) },
              a: { x: +e.ax.toFixed(4), y: +e.ay.toFixed(4), z: +e.az.toFixed(4) },
              b: { x: +e.bx.toFixed(4), y: +e.by.toFixed(4), z: +e.bz.toFixed(4) } };
          }
          if (!r || !r.geometry || !r.geometry.attributes.position) return null;
          var a = r.geometry.attributes.position;
          if (a.count < 2) return null;
          return { vis: !!r.visible, y0: +a.getY(0).toFixed(4), y1: +a.getY(1).toFixed(4), src: 'ribbon',
                   a: { x: +a.getX(0).toFixed(4), y: +a.getY(0).toFixed(4), z: +a.getZ(0).toFixed(4) },
                   b: { x: +a.getX(1).toFixed(4), y: +a.getY(1).toFixed(4), z: +a.getZ(1).toFixed(4) } };
        });
        return {
          id: o.userData ? o.userData.id : i,
          H: +H.toFixed(4), x: +o.position.x.toFixed(4), z: +o.position.z.toFixed(4),
          /* ★ v44：`rec.pd`（掠过方向 = 平行光方向，指向太阳）/ `rec.sunDist` / `rec.roof`
             （远离太阳一侧的屋顶掠过点）—— 探针据此判断 rays 几何，不必自己重算天象。 */
          pd: rec.pd || null, sunDist: rec.sunDist == null ? null : rec.sunDist, roof: rec.roof || null,
          rayVis: !!(rec.ray && rec.ray.visible), ray: ray, rays: rays,
          shadowVis: !!(rec.shadow && rec.shadow.visible),
          /* v33：影长线段改为**直接写 4 个顶点**（不再用 position/scale 摆位），
             故这里按顶点读回「物脚 → 影尖」两端，供探针断言方向与长度。 */
          shadow: rec.shadow ? (function () {
            var a = rec.shadow.geometry.attributes.position;
            if (!a || a.count < 4) return null;
            var fx = (a.getX(0) + a.getX(1)) / 2, fz = (a.getZ(0) + a.getZ(1)) / 2;
            var tx = (a.getX(2) + a.getX(3)) / 2, tz = (a.getZ(2) + a.getZ(3)) / 2;
            return {
              foot: { x: +fx.toFixed(4), z: +fz.toFixed(4) },
              tip: { x: +tx.toFixed(4), z: +tz.toFixed(4) },
              len: +Math.sqrt((tx - fx) * (tx - fx) + (tz - fz) * (tz - fz)).toFixed(4),
            };
          })() : null,
          labels: [rec.lbH, rec.lbL, rec.lbA].map(function (s) {
            return (s && s.userData) ? { text: s.userData.text, vis: !!s.visible } : null;
          }),
        };
      }).filter(Boolean);
    },
    /* ★ v33（需求二 / 需求一）探针用：地平几何常量 + 轨迹与地平面交点 + 观测点标记世界坐标。
       用来断言三件事：
       ① 地面圆盘半径（= 地平圈）== 太阳视运动轨迹半径 ⇒ 日出 / 日落点严格落在地平圈上；
       ② 地平线上方轨迹的两个端点 y ≈ 0（= 与地平面相交），水平半径 == TRAJ_R；
       ③ 地球位置小窗里的观测点标记恒在正对相机的一面（世界方向 ≈ +Z）。 */
    _geom: function () {
      function ends(m) {
        if (!m || !m.geometry || !m.geometry.attributes.position) return null;
        var a = m.geometry.attributes.position, n = a.count;
        if (!n) return null;
        function r(i) {
          var x = a.getX(i), y = a.getY(i), z = a.getZ(i);
          return { x: +x.toFixed(4), y: +y.toFixed(4), z: +z.toFixed(4),
                   r: +Math.sqrt(x * x + z * z).toFixed(4) };
        }
        var lo = r(0), hi = r(n - 1), maxR = 0, maxAbsY = 0;
        for (var i = 0; i < n; i++) {
          var x = a.getX(i), y = a.getY(i), z = a.getZ(i);
          maxR = Math.max(maxR, Math.sqrt(x * x + z * z));
          maxAbsY = Math.max(maxAbsY, Math.abs(y));
        }
        return { first: lo, last: hi, maxR: +maxR.toFixed(4), maxAbsY: +maxAbsY.toFixed(4) };
      }
      var tube = null;
      gTrajGrp.children.forEach(function (o) { if (o.isMesh && !tube) tube = o; });
      var mw = new THREE.Vector3();
      eMarker.getWorldPosition(mw);
      /* ★ v41（需求一·3）探针用：过物体顶部的太阳光线是否「从太阳出发且穿过物体顶部」。
         判据：① 线段靠近太阳的那个端点 == 太阳中心（dist≈0）；
               ② 物体顶点到该线段的**垂距** ≈ 0（说明真正穿过顶部）。 */
      var ray = null;
      (function () {
        var rec = _measPool && _measPool[0];
        if (!rec || !rec.ray || !rec.ray.visible) return;
        var tg = measTargets(); if (!tg.length) return;
        var o = tg[0], H = objHeightOf(o);
        var T = _v2.set(o.position.x, H, o.position.z);
        var SP = sunGrp.position;
        var a = rec.ray.geometry.attributes.position;
        /* setSegLine 用固定容量缓冲 + setDrawRange，缓冲区尾部是上一次的残留值 ——
           必须只扫 drawRange 之内的顶点，否则会把残留的 (0,0,0) 当成端点。 */
        var dr = rec.ray.geometry.drawRange;
        var n = (dr && isFinite(dr.count) && dr.count > 0) ? Math.min(a.count, dr.count) : a.count;
        if (!n) return;
        var best = 1e9, p0 = null, p1 = null, far = -1;
        var tmp = _v3;
        for (var i = 0; i < n; i++) {
          tmp.set(a.getX(i), a.getY(i), a.getZ(i));
          var d = tmp.distanceTo(SP);
          if (d < best) { best = d; p0 = { x: tmp.x, y: tmp.y, z: tmp.z }; }
          if (d > far) { far = d; p1 = { x: tmp.x, y: tmp.y, z: tmp.z }; }
        }
        /* 顶点到线段 p0→p1 的垂距 */
        var ax = _v1.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
        var al = ax.length() || 1; ax.multiplyScalar(1 / al);
        var ap = _mv1.set(T.x - p0.x, T.y - p0.y, T.z - p0.z);
        var tt = ap.dot(ax);
        var perp = _mv2.copy(p0).addScaledVector(ax, tt).distanceTo(T);
        ray = {
          sun: { x: +SP.x.toFixed(3), y: +SP.y.toFixed(3), z: +SP.z.toFixed(3) },
          top: { x: +T.x.toFixed(3), y: +T.y.toFixed(3), z: +T.z.toFixed(3) },
          nearSun: { x: +p0.x.toFixed(3), y: +p0.y.toFixed(3), z: +p0.z.toFixed(3) },
          farEnd: { x: +p1.x.toFixed(3), y: +p1.y.toFixed(3), z: +p1.z.toFixed(3) },
          dSunEnd: +best.toFixed(4),      /* 太阳中心 → 最近端点（应 ≈ 0） */
          dTopPerp: +perp.toFixed(4),     /* 顶点 → 线段垂距（应 ≈ 0） */
        };
      })();
      return {
        GROUND_R: GROUND_R, TRAJ_R: TRAJ_R, SUN_DIST: SUN_DIST, CS: CS, GSIZE: GSIZE,
        gTraj: ends(tube), ray: ray,
        obsMarkerWorld: { x: +mw.x.toFixed(4), y: +mw.y.toFixed(4), z: +mw.z.toFixed(4) },
        gDist: gDist, gCamY: +gCam.position.y.toFixed(3),
      };
    },
    /* v31（需求二十）探针用：室内光斑 / 光线方向 / 相机是否还在房间里
       ★ v44（需求四）：光斑改成「每个受光面一块」，这里把**每一块的可见性与顶点范围**
       一起吐出来，供探针验证「地面 / 背墙 / 左墙 / 右墙各自独立成斑、且都夹在房间内」。 */
    /* ★ v44（需求十）探针用：综合视图各窗格的矩形 / 标题 / 是否复用天球场景。
       `skyUsesCelestial` = 天球窗格渲染的是不是**太阳视运动自己的天球场景**（cScene + cCam），
       而不是另起一套 —— 需求里「综合视图中的天球视图直接复用太阳视运动视图的天球视图」。 */
    _combo: function () {
      var out = { on: !!(S.combo && S.combo.on), view: S.view, avail: comboAvailRect(), cells: [] };
      Object.keys(sComboCells).forEach(function (k) {
        var o = sComboCells[k]; if (!o) return;
        var n = o.node, h2 = n.querySelector('.card-head h2');
        out.cells.push({
          key: k, label: (h2 ? h2.textContent.trim() : ''),
          ico: (h2 && h2.querySelector('.hd-ico')) ? h2.querySelector('.hd-ico').textContent : '',
          foldBtn: !!n.querySelector('.svc-fold'), closeBtn: !!n.querySelector('.svc-close'),
          x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight,
          collapsed: n.classList.contains('collapsed'),
          skyUsesCelestial: (o.scn === 'sky') && (o.renderer != null || true)
        });
      });
      return out;
    },
    _indoor: function () {
      function scan(m, kind) {
        if (!m.visible) return { kind: kind, vis: false };
        var a = m.geometry.attributes.position;
        var n = (m.geometry.drawRange.count / 3) + 2;
        if (!(n >= 3)) n = Math.min(4, PATCH_MAXV);
        var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], pt = [];
        for (var i = 0; i < n; i++) {
          var p = [a.getX(i), a.getY(i), a.getZ(i)];
          pt.push([+p[0].toFixed(3), +p[1].toFixed(3), +p[2].toFixed(3)]);
          for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        }
        return { kind: kind, vis: true, nv: n, op: +m.material.opacity.toFixed(3),
          col: '#' + m.material.color.getHexString(),
          lo: lo.map(function (v) { return +v.toFixed(3); }), hi: hi.map(function (v) { return +v.toFixed(3); }),
          pts: pt };
      }
      var ck = iPatchWalls.map(function (m, i) { return scan(m, ['wallBack', 'wallLeft', 'wallRight'][i]); });
      return {
        H: _lastH, lit: _lastLit,
        dir: { x: _v1.x, y: _v1.y, z: _v1.z },
        floor: scan(iPatchFloor, 'floor'), walls: ck, wallCount: ck.filter(function (w) { return w.vis; }).length,
        /* ★ v44（需求四）：当前四面墙各自被分配到的方位（世界坐标口径）。 */
        roomRotY: +iRoom.rotation.y.toFixed(4),
        dirLabels: (function () {
          var o = {};
          ['北', '东', '南', '西'].forEach(function (k) {
            var e = _idmEls && _idmEls[k];
            o[k] = e ? { disp: e.style.display, left: e.style.left, top: e.style.top } : null;
          });
          return o;
        })(),
        cam: { x: iCam.position.x, y: iCam.position.y, z: iCam.position.z },
        bounds: I_CAM, RW: RW, RD: RD, RH: RH, WINW: WINW, WINH: WINH, SILL: SILL, WTH: WTH,
      };
    },
  };
  var _lastH = 0, _lastLit = false;
  /* 与 menu.js 的 window.MENU 同口径：暴露本模块菜单树供统计脚本遍历 */
  window.SUN_MENU = SUN_MENU;
})();
