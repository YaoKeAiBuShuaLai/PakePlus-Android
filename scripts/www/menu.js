/* =============================================================================
   menu.js —— 显示设置面板「菜单数据结构 + 渲染逻辑」
   -----------------------------------------------------------------------------
   结构严格依据《面板菜单框架.md》：一级 / 二级 / 三级…… 的顺序、名称、父子层级
   与勾选状态全部由 MENU 描述，DOM 由 renderMenu() 一次性生成，不再手写菜单 HTML。

   节点（node）字段：
     name      显示名称（已去掉「（滑块控制）」这类控件说明）
     children  子级；有 children 才渲染展开 / 收起标识（▾），没有则直接显示
     sw        开关控件 id：☑️ 项。关闭时子级整体隐藏（不纳入菜单）
     k         叶子控件类型：sw / range / color / sel / num / btn
     id        控件 id（与 app.js 绑定一一对应）
     path      状态路径（新控件由 app.js 的通用绑定器按 path 自动接上）
     opts      select 选项
     raw       直接插入的原始 HTML（预设按钮、标注列表等特殊块）
     tip       灰色说明文字

   默认状态：一级、二级及其以下所有可展开节点默认折叠，点击后才展开。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 控件定义表（gen_ctrl.py 从旧菜单 HTML 收割，见 menu-ctrls.js）---------- */
  var CTRLS = window.CTRLS || {};

  /* ---------- 构造简写 ----------
     gate（v21.0 新增）：该节点受哪些「上级开关」控制（状态路径，多个用逗号分隔，全部为真才可用）。
     与 app.js 的 spriteNoteGate / thingGateOn 是同一套判据：界面上被上级压住的开关会被
     置灰并禁用，从视觉上把「总开关 → 地理事物 → 注释」这个先后顺序讲清楚（需求③）。 */
  function G(name, children, o) {
    var n = { name: name, children: children || [] };
    if (o) for (var k in o) n[k] = o[k];
    return n;
  }
  function use(id, name, o) {                      // 引用已收割控件
    var n = { id: id }; if (name) n.name = name;
    if (o) for (var k in o) n[k] = o[k];
    return n;
  }
  function rg(id, name, path, min, max, step, out, map, fmt) {
    return { k: 'range', id: id, name: name, path: path, min: min, max: max, step: step,
             out: out || null, map: map || 'lin01', fmt: fmt || 'pct' };
  }
  function cl(id, name, path, hex) { return { k: 'color', id: id, name: name, path: path, hex: hex || null }; }
  function sl(id, name, path, opts) { return { k: 'sel', id: id, name: name, path: path, opts: opts }; }
  function sw(id, name, path, gate) {
    return { k: 'sw', id: id, name: name, path: path || null, gate: gate || null };
  }
  function tip(t) { return { tip: t }; }
  function raw(h) { return { raw: h }; }
  function sep() { return raw('<div class="section-sep"></div>'); }

  /* ★ v43（需求三·1）：**线宽统一为「相对倍率」口径** ——
     全站所有「线粗细 / 线宽 / 描边粗细 / 纬线圈宽度」滑块一律 10–300（= 0.10×–3.00×），
     读数一律「1.00×」（1.00× = 该线自身的默认粗细）。此前这些控件分成五套互不相容的
     单位与量程（度 0.5–0.55 / 度 0.16–0.30 / 度 0.9 / 世界单位 0.003–0.011 / 度 0.0018），
     同名控件的上下限与读数完全无法互相比较。
     真实换算在 app.js 的 bindRange 里做（查 LW_BASE[path] 得基准线宽），
     本函数只负责产出「量程统一」的菜单 spec。
     注意：**有 path 的控件会被 bindMenuLeaf 的通用绑定器自动接上**，
     所以这里必须自带 path（早先用 use() 引用收割表 → 无 path → 走的是旧量程）。 */
  function lwCtl(id, name, path, out) {
    return rg(id, name, path, 10, 300, 1, out, 'lwRel', 'lwX');
  }

  var FONT_OPTS = [['default', '系统默认'], ['both', '宋体 / Times New Roman'], ['simsun', '宋体'],
                   ['hei', '黑体'], ['times', '新罗马字体']];
  var DASH_OPTS = [['solid', '实线'], ['dash', '虚线']];
  /* v31（需求十七）：UI 风格色系 —— 第一项「原色系」= 项目原有的默认蓝，
     其余为可选色系；CSS 侧由 body[data-ui="<id>"] 覆写主题变量（见 style.css）。 */
  var UI_SCHEME_OPTS = [['default', '原色系（默认蓝）'], ['teal', '青碧'], ['green', '翠绿'],
                        ['amber', '暖橙'], ['violet', '紫罗兰'], ['rose', '玫瑰红'], ['graphite', '石墨灰']];
  /* ★ v44（需求一）：明暗模式 —— 浅色（白底黑字 / 面板浅蓝白半透明）与
     深色（黑底白字 / 面板黑色半透明），两套模式各自的面板底色与文字色都可自定义。 */
  var UI_MODE_OPTS = [['light', '浅色模式（白底黑字）'], ['dark', '深色模式（黑底白字）']];
  var STEP_OPTS = [['10', '10°'], ['15', '15°'], ['20', '20°'], ['30', '30°'], ['45', '45°'], ['60', '60°']];
  // v29（需求①）：v28 的「面积单位」选项（SPD_UNIT_OPTS / selSpdUnit）已随面积单位移除而删除；
  //              面积速度读数固定 km²/日。
  // v20.0：字重（与 app.js 的 NOTE_WEIGHTS 一一对应）—— 每个文字注释菜单都带这一项
  var WEIGHT_OPTS = [['300', '细体'], ['400', '常规'], ['500', '中等'], ['600', '半粗'], ['700', '粗体']];

  /* 「文字注释」五件套：字号 / 字体 / 颜色 / 透明度 / 字重（cat → state.note.cats[cat]）
     v20.0：每个注释菜单都带「字重」。
     gate（v21.0）：该注释组受哪些「地理事物开关」控制（需求③）。
     swPath（v25.1）：该注释分组的开关所写的**状态路径**。默认是 note.cats.<cat>.on
       （分类自己的开关）；但时差演示的 5 条注记，其开关写的是 tzdiff.note.* ——
       故允许外部显式给出 swPath。 */
  function noteGrp(name, cat, p, swId, gate, swPath, extra) {
    var kids = [
      /* v23.0（需求④）：**所有**控制文字字号大小的滑块上下限统一为 0.01× ~ 10.00×
         （滑条值 = 字号倍率 × 100，故 min / max 写 1 / 1000）—— 与「全局文字样式 ›
         全局文字大小样式统一 › 总字号」（menu-ctrls.js 的 rngNoteSize）完全相同。
         同时 app.js 端恒做「字号基准归一」（unifyBaseK），所以无论拖哪一根滑条，
         滑出同一个数时屏幕上看到的字都一样大（此前分类滑条与总字号量纲不同：
         同一个 0.55 在两类滑条下能差出好几倍）。 */
      rg(p + 'Size', '字号', 'note.cats.' + cat + '.size', 1, 1000, 1, 'out' + p + 'Size', 'w100', 'x'),
      sl(p + 'Font', '字体', 'note.cats.' + cat + '.font', FONT_OPTS),
      cl(p + 'Color', '颜色', 'note.cats.' + cat + '.color', 'hex' + p + 'Color'),
      rg(p + 'Op', '透明度', 'note.cats.' + cat + '.op', 0, 100, 1, 'out' + p + 'Op', 'lin01', 'pct'),
      sl(p + 'Weight', '字重', 'note.cats.' + cat + '.weight', WEIGHT_OPTS),
    ];
    /* v52（需求）：允许调用方追加额外选项（如「二分二至」注释组内的「显示日期」开关）——
       追加项仍由 bindMenuTree 按 id / path 绑定，不受影响。 */
    if (extra) kids = kids.concat(extra);
    return G(name, kids, { sw: swId || null, swPath: swId ? (swPath || ('note.cats.' + cat + '.on')) : null, cat: cat, gate: gate || null });
  }
  /* 描边（轮廓）：开关 + 线粗细 / 线颜色 / 透明度 / 类型
     ids 里的各项既可传 id 字符串（沿用已收割的控件），也可直接传完整 spec 对象（新增控件）。 */
  function pick(x, nm) { return (x && typeof x === 'object') ? x : { id: x, name: nm }; }
  /* v27.1（需求④）：strokeGrp 增加 swPath / title 可选项 ——
     组开关此前只传 sw 不传 swPath，bindMenuTree（要求 sw+swPath 成对）不会绑定，
     导致「东西 / 南北半球」的描边开关是死开关；标题也按语义改为「分界线」。
     v27.2（需求③）：增加第 7 参 gate ——「分界线」组从「显示样式」组内提取为
     同级并列选项后，不再是嵌套在带 gate 的父组里，必须自带门控
     （如 'hemi.ew.on'），否则区域总开关关闭时该组不会被置灰。
     v35（需求二）：ids.dash 缺省 ⇒ 不再渲染「类型」（线型选择 + 虚线密度 + 虚实比）——
     固定为实线的分界线（东西半球 / 南北半球）只保留线粗细 / 颜色 / 透明度。 */
  function strokeGrp(ids, path, dashKey, swId, swPath, title, gate) {
    const rows = [pick(ids.w, '线粗细'), pick(ids.c, '线颜色'), pick(ids.op, '透明度')];
    if (ids.dash) {
      rows.push(G('类型', [
        pick(ids.n, '虚线密度'), pick(ids.ratio, '虚实比'),
      ].map(function (c) { return Object.assign({ dash: dashKey }, c); }),
        { ctl: pick(ids.dash, '类型') }));
    }
    return G(title || '描边（轮廓）', rows,
      { sw: swId || null, swPath: swPath || null, gate: gate || null });
  }
  /* =========================================================================
     v25.1（需求⑧）：标记演示 › 球面最短距离 —— 面板里的两个原始 HTML 块
     三块「取点方式」面板（由 app.js 按 gcd.mode 切换显隐）+ 状态提示与结果读数。
     id 与 app.js 的 bindGcdUI / renderGcdPanel 一一对应。
     ====================================================================== */
  var GCD_PANEL =
    '<div class="gcd-bx" id="gcdBoxClick">'
      + '<p class="gcd-hint">在地球上<b>依次点击两点</b>：第一次点击设 A 点，第二次点击设 B 点；'
      + '再点一次即开始新一轮测量。点击只作用于本功能，不影响观测点查询。</p>'
      + '</div>'
    + '<div class="gcd-bx" id="gcdBoxMarker">'
      + '<div class="gcd-grid">'
      + '<span class="gcd-lb">A 点</span><select id="selGcdA"></select>'
      + '<span class="gcd-lb">B 点</span><select id="selGcdB"></select>'
      + '</div>'
      + '<div class="btn-row"><button class="btn xs" id="btnGcdMkApply">用所选标记点测量</button></div>'
      + '</div>'
    + '<div class="gcd-bx" id="gcdBoxInput">'
      + '<div class="gcd-grid gcd-grid3">'
      + '<span class="gcd-lb"></span><span class="gcd-hd">纬度</span><span class="gcd-hd">经度</span>'
      + '<span class="gcd-lb">A 点</span>'
      + '<input type="number" id="inGcdALat" step="0.1" min="-90" max="90" />'
      + '<input type="number" id="inGcdALon" step="0.1" min="-180" max="180" />'
      + '<span class="gcd-lb">B 点</span>'
      + '<input type="number" id="inGcdBLat" step="0.1" min="-90" max="90" />'
      + '<input type="number" id="inGcdBLon" step="0.1" min="-180" max="180" />'
      + '</div>'
      + '<div class="btn-row"><button class="btn xs" id="btnGcdInApply">用输入的经纬度测量</button></div>'
      + '</div>';
  var GCD_RESULT =
    '<div id="gcdMsg" class="gcd-msg"></div>'
    + '<div id="gcdResult" class="gcd-res"></div>'
    + '<div class="btn-row">'
    + '<button class="btn xs" id="btnGcdRematch">重新测量</button>'
    + '<button class="btn xs" id="btnGcdClear">清除结果</button>'
    + '</div>';

  /* =========================================================================
     MENU —— 一级菜单（顺序 / 名称 / 副标题与框架文件一致）
     ====================================================================== */
  var MENU = [

    /* ---------------- 一、光照系统 ---------------- */
    {
      id: 'sLight', icon: '☀️', name: '光照系统', sub: '太阳光线 · 晨昏线 · 直射点 · 极昼极夜',
      children: [
        {
          /* v26.1（需求⑫）：菜单标题前的开关 = 本菜单的总开关（与弹窗标题行那个是同一个）。
             swTip 是鼠标悬停时的说明，因为标题前的开关没有文字标签。 */
          id: 'pLightRays', icon: '☀️', name: '光照与太阳光线', sw: 'cbRays', swTip: '显示太阳光线箭头', children: [
            // v23.0（需求②）：下面三项都是「太阳光线」的下级设置 / 子要素 —— 必须先打开
            //   「显示太阳光线箭头」，关闭上级后它们连同「太阳光标注」一起置灰并隐藏。
            use('cbRaysCenter', '只显示直射光线（中间一条）', { gate: 'rays' }),
            G('直射光线样式', [
              lwCtl('rngRayW', '线粗细', 'style.ln.ray.w', 'outRayW'), use('clrOrbRay', '线颜色'), use('rngOrbRayOp', '透明度'),
              G('类型', [use('rngRayN', '虚线密度'), use('rngRayRatio', '虚实比')],
                { ctl: use('selRayDash', '类型'), dash: 'ray' }),
            ], { gate: 'rays' }),
            G('箭头样式', [
              rg('rngArrowSize', '点大小', 'style.pt.arrow.size', 20, 300, 1, 'outArrowSize', 'w100', 'x'),
              cl('clrArrow', '点颜色', 'style.pt.arrow.color', 'hexArrow'),
              rg('rngArrowOp', '透明度', 'style.pt.arrow.op', 0, 100, 1, 'outArrowOp', 'lin01', 'pct'),
            ], { gate: 'rays' }),
            /* v31（需求七）/ v32（需求一）：太阳光线**按纬度纵向分布** ——
               北极 / 南极 / 赤道 / 南北纬 45° 各一条为默认 5 条；加大条数即在
               纬度方向加密。箭头锥尖恒落在**地表朝日侧**，因此始终指向地表。 */
            G('光线密度（按纬度分布）', [
              rg('rngRayVertN', '光线数量', 'rayVert.n', 3, 25, 1, 'outRayVertN', 'int1', 'raw'),
              tip('太阳光线沿**纬度**纵向排列：默认 5 条 = 北极 90° / 北纬 45° / 赤道 0° / ' +
                '南纬 45° / 南极 −90° 各一条（正中那条为直射光线）。加大条数即在纬度方向均匀加密，' +
                '便于同时观察直射（赤道）与斜射（高纬）。每条光线的箭头锥尖都落在该纬度对应的' +
                '**地表朝日侧**，方向恒指向地面。'),
            ], { gate: 'rays' }),
            sep(),
            /* v31（需求七）：太阳「体积光柱」——
             与「显示太阳光线箭头」相互独立（本组不受它门控）。
             v37（需求一·3）：重做为「实心光柱 + 外围柔光束」—— 核心圆柱颜色可设
             （默认暖黄），外围包一层长条形半透明白色体积光束（边缘柔和衰减向外淡化，
             滤色发光、不遮挡星空、无镜头眩光）；滑块读数一律为直观百分比。 */
            G('体积光柱', [
              G('强度与外观', [
                cl('clrVolColor', '光柱颜色', 'volShaft.color', 'hexVolColor'),
                rg('rngVolInt', '光柱亮度', 'volShaft.intensity', 0, 100, 1, 'outVolInt', 'int1', 'pctInt'),
                rg('rngVolOp', '核心不透明度', 'volShaft.op', 0, 100, 1, 'outVolOp', 'int1', 'pctInt'),
                rg('rngVolDia', '光柱直径（相对地球直径）', 'volShaft.dia', 60, 400, 1, 'outVolDia', 'int1', 'pctInt'),
                rg('rngVolGlow', '外围光束范围', 'volShaft.glow', 100, 320, 1, 'outVolGlow', 'int1', 'pctInt'),
              ], { gate: 'volShaft.on' }),
              tip('体积光柱沿「太阳 → 地球」方向实时重建：**实心光柱**（颜色可设，默认暖黄，' +
                '直径默认 = 地球直径）外围再包一层**长条形半透明白色体积光束** —— ' +
                '边缘柔和衰减向外淡化、滤色发光效果，不遮挡星空背景，也没有镜头眩光。' +
                '光柱连接太阳球心与地球球心，**只显示地表以外的部分**；' +
                '「外围光束范围」= 外层光束直径相对核心光柱直径的百分比。' +
                '自转 / 公转 / 综合三个视图同时生效，与本组上方「显示太阳光线箭头」互相独立。'),
            ], { sw: 'cbVolShaft', swPath: 'volShaft.on', swTip: '显示太阳体积光柱（默认关闭）' }),
            sep(),
            /* v31（需求九）：太阳贴图 —— 真实贴图（程序化生成的太阳表面纹理）。
               与「光线箭头 / 体积光柱」互相独立（本组不受 cbRays 门控），自转 / 公转 / 综合一并生效。
               v33：按面板规格定名「太阳贴图」。 */
            G('太阳贴图', [
              sw('cbSunTex', '真实太阳贴图', 'sun.tex'),
              tip('开启后太阳球使用程序化生成的**真实太阳表面纹理**（米粒组织 + 黑子 + 临边增亮），' +
                  '自转 / 公转 / 综合三个视图的太阳一并生效；关闭则还原为原色（纯黄）——' +
                  '自转 / 综合视图里原本不显示太阳盘，关闭后即恢复原样。'),
            ]),
            sep(),
            noteGrp('文字注释【太阳光线】', 'ray', 'ncRay', 'ncRayOn', 'note.master.on,rays'),
          ]
        },
        {
          id: 'pLightTerm', icon: '🌓', name: '晨昏线', sw: 'cbTerm', swTip: '显示晨昏线', children: [
            G('晨线设置', [
              lwCtl('rngDawnW', '线粗细', 'style.ln.dawn.w', 'outDawnW'), use('clrDawn', '线颜色'),
              rg('rngDawnOp', '透明度', 'style.ln.dawn.op', 0, 100, 1, 'outDawnOp', 'lin01', 'pct'),
              G('类型', [use('rngDawnN', '虚线密度'), use('rngDawnRatio', '虚实比')],
                { ctl: use('selDawnDash', '线型'), dash: 'dawn' }),
            ], { sw: 'cbDawn', gate: 'term' }),
            G('昏线设置', [
              lwCtl('rngDuskW', '线粗细', 'style.ln.dusk.w', 'outDuskW'), use('clrDusk', '线颜色'),
              rg('rngDuskOp', '透明度', 'style.ln.dusk.op', 0, 100, 1, 'outDuskOp', 'lin01', 'pct'),
              G('类型', [use('rngDuskN', '虚线密度'), use('rngDuskRatio', '虚实比')],
                { ctl: use('selDuskDash', '线型'), dash: 'dusk' }),
            ], { sw: 'cbDusk', gate: 'term' }),
            sep(),
            /* ★ v41（需求二·2）：晨昏线「文字注释」改版为
                 「组级总开关（标题行）+ 每条注释一个子组（各自标题行带开关）」，
               与「🌫️ 地球表层 › 🕐 地方时刻 › 文字注释（主时刻 / 其余时刻两个下拉）」完全同构。
               组开关写新状态 termNote.on，门控 note.master.on + term（显示晨昏线）。 */
            G('文字注释', [
              noteGrp('晨线注释', 'dawn', 'ncDawn', 'ncDawnOn', 'note.master.on,term,termNote.on,dawn.on'),
              noteGrp('昏线注释', 'dusk', 'ncDusk', 'ncDuskOn', 'note.master.on,term,termNote.on,dusk.on'),
            ], { sw: 'cbTermNote', swPath: 'termNote.on', gate: 'note.master.on,term' }),
          ]
        },
        {
          id: 'pLightSub', icon: '🎯', name: '太阳直射点', sw: 'cbSub', swTip: '显示太阳直射点', children: [
            // v23.0（需求②）：样式组跟随「显示太阳直射点」—— 直射点不显示时样式设置一并置灰
            G('太阳直射点样式', [
              use('rngSubSize', '点大小'), use('clrSub', '点颜色'),
              rg('rngSubOp', '透明度', 'style.pt.sub.op', 0, 100, 1, 'outSubOp', 'lin01', 'pct'),
            ], { gate: 'sub' }),
            sep(),
            /* v23.17（需求②）：太阳直射点轨迹记录（默认关闭）
                 · 线条属性（粗细 / 颜色 / 透明度 / 线型 / 虚线密度 / 虚实比）与其余线要素
                   完全同一套控件类型与量纲（粗细以「°」计，与赤道 / 南北回归线一致）；
                 · 轨迹经过南北回归线 / 赤道时自动生成的标记点，颜色 / 大小 / 透明度可设；
                 · 「清除轨迹并重新记录」清空已记录内容，从当前时刻重新开始。 */
            /* ★ v52（需求一）：总开关前置到分组标题行（[开关] 直射点轨迹记录 ▾），
               正文里不再重复渲染同一个 state 的开关控件（避免同一状态两处入口）。
               cbSubTrail 由 app.js 的 bindSwitch 手动绑定，不依赖节点位置。 */
            G('直射点轨迹记录', [
              G('轨迹线条', [
                rg('rngSubTrailW', '线粗细', 'style.ln.subTrail.w', 10, 300, 1, 'outSubTrailW', 'lwRel', 'lwX'),
                cl('clrSubTrail', '线颜色', 'style.ln.subTrail.color', 'hexSubTrail'),
                rg('rngSubTrailOp', '透明度', 'style.ln.subTrail.op', 0, 100, 1, 'outSubTrailOp', 'lin01', 'pct'),
                G('类型', [
                  rg('rngSubTrailN', '虚线密度', 'style.ln.subTrail.n', 10, 200, 1, 'outSubTrailN', 'int1', 'raw'),
                  rg('rngSubTrailRatio', '虚实比', 'style.ln.subTrail.ratio', 20, 90, 1, 'outSubTrailRatio', 'lin01', 'pct'),
                ], { ctl: sl('selSubTrailDash', '类型', 'style.ln.subTrail.dash', DASH_OPTS), dash: 'subTrail' }),
              ], { gate: 'subTrail' }),
              G('回归线 / 赤道标记点', [
                rg('rngSubTrailMarkSize', '点大小', 'style.pt.subTrailMark.size', 10, 120, 1, 'outSubTrailMarkSize', 'thousandth', 'raw3'),
                cl('clrSubTrailMark', '点颜色', 'style.pt.subTrailMark.color', 'hexSubTrailMark'),
                rg('rngSubTrailMarkOp', '透明度', 'style.pt.subTrailMark.op', 0, 100, 1, 'outSubTrailMarkOp', 'lin01', 'pct'),
              ], { gate: 'subTrail' }),
              raw('<div class="btn-row"><button class="btn xs" id="btnSubTrailClear">清除轨迹并重新记录</button></div>'),
              tip('开启后随仿真时间推进，自动记录太阳直射点在地表的移动轨迹（约一整圈后停止记录）；'
                + '轨迹经过南回归线、北回归线和赤道时会自动打上标记点。'),
            ], { sw: 'cbSubTrail', swTip: '记录直射点轨迹' }),
            sep(),
            /* v27.4（新增）：太阳直射点所在纬线与经线 —— 随仿真时间实时跟随直射点。
               · 纬线圈 = 纬度（= 太阳赤纬 decl）的**整圈**平行圈；
                 经线   = 经度（= 直射点经度）的**半圆弧**（北极 → 直射点 → 南极，只画直射点这一侧）；
               · 线条属性（粗细 / 颜色 / 透明度 / 线型 / 虚线密度 / 虚实比）与「直射点轨迹」完全
                 同一套控件类型与量纲（粗细以「°」计）。
               · 显示于「地球侧视」窗口与「直射点回归运动」窗口（简洁模式下亦保留）。 */
            G('直射点所在纬线与经线', [
              G('纬线圈（直射点所在纬度）', [
                rg('rngSubCircleLatW', '线粗细', 'style.ln.subLatCircle.w', 10, 300, 1, 'outSubCircleLatW', 'lwRel', 'lwX'),
                cl('clrSubCircleLat', '线颜色', 'style.ln.subLatCircle.color', 'hexSubCircleLat'),
                rg('rngSubCircleLatOp', '透明度', 'style.ln.subLatCircle.op', 0, 100, 1, 'outSubCircleLatOp', 'lin01', 'pct'),
                G('类型', [
                  rg('rngSubCircleLatN', '虚线密度', 'style.ln.subLatCircle.n', 10, 200, 1, 'outSubCircleLatN', 'int1', 'raw'),
                  rg('rngSubCircleLatRatio', '虚实比', 'style.ln.subLatCircle.ratio', 20, 90, 1, 'outSubCircleLatRatio', 'lin01', 'pct'),
                ], { ctl: sl('selSubCircleLatDash', '类型', 'style.ln.subLatCircle.dash', DASH_OPTS), dash: 'subLatCircle' }),
              ], { gate: 'subCircle.on' }),
              G('经线（直射点所在经度 · 半圆弧）', [
                rg('rngSubCircleLonW', '线粗细', 'style.ln.subLonCircle.w', 10, 300, 1, 'outSubCircleLonW', 'lwRel', 'lwX'),
                cl('clrSubCircleLon', '线颜色', 'style.ln.subLonCircle.color', 'hexSubCircleLon'),
                rg('rngSubCircleLonOp', '透明度', 'style.ln.subLonCircle.op', 0, 100, 1, 'outSubCircleLonOp', 'lin01', 'pct'),
                G('类型', [
                  rg('rngSubCircleLonN', '虚线密度', 'style.ln.subLonCircle.n', 10, 200, 1, 'outSubCircleLonN', 'int1', 'raw'),
                  rg('rngSubCircleLonRatio', '虚实比', 'style.ln.subLonCircle.ratio', 20, 90, 1, 'outSubCircleLonRatio', 'lin01', 'pct'),
                ], { ctl: sl('selSubCircleLonDash', '类型', 'style.ln.subLonCircle.dash', DASH_OPTS), dash: 'subLonCircle' }),
              ], { gate: 'subCircle.on' }),
              tip('纬线圈（整圈平行圈）与经线（穿过直射点半圆弧）随仿真时间实时跟随太阳直射点移动；'
                + '显示于「地球侧视」与「直射点回归运动」窗口。'),
            ], { sw: 'cbSubCircle', swPath: 'subCircle.on' }),
          ]
        },
        /* ★ v37（需求一·1）：「极昼极夜」「时间面板数据」上移为**二级菜单** ——
           v33 曾按面板规格把它们归入「太阳直射点」之下（三级）；现按新规格直接挂在
           「光照系统」下（与光照与太阳光线 / 晨昏线 / 太阳直射点平级）。
           层级变了，开关 id / 状态路径全部保持原样，绑定不受影响。 */
        {
          id: 'pLightPolar', icon: '❄️', name: '极昼极夜', sw: 'cbPolar', swTip: '显示极昼极夜', children: [
            G('极昼区域', [
              G('填充', [use('clrPdFill', '填充颜色'), use('rngPdOpacity', '透明度')]),
              strokeGrp({ w: lwCtl('rngPdStrokeW', '线粗细', 'style.fill.pd.stroke.w', 'outPdStrokeW'), c: 'clrPdStroke', op: 'rngPdStrokeOp',
                dash: sl('selPdStrokeDash', '类型', 'style.fill.pd.stroke.dash', DASH_OPTS),
                n: rg('rngPdStrokeN', '虚线密度', 'style.fill.pd.stroke.n', 10, 200, 1, 'outPdStrokeN', 'int1', 'raw'),
                ratio: rg('rngPdStrokeRatio', '虚实比', 'style.fill.pd.stroke.ratio', 20, 90, 1, 'outPdStrokeRatio', 'lin01', 'pct') },
                'style.fill.pd.stroke', 'pdstroke', 'cbPdStroke'),
            ], { sw: 'cbPd', gate: 'polar' }),
            G('极夜区域', [
              G('填充', [use('clrPnFill', '填充颜色'), use('rngPnOpacity', '透明度')]),
              strokeGrp({ w: lwCtl('rngPnStrokeW', '线粗细', 'style.fill.pn.stroke.w', 'outPnStrokeW'), c: 'clrPnStroke', op: 'rngPnStrokeOp',
                dash: sl('selPnStrokeDash', '类型', 'style.fill.pn.stroke.dash', DASH_OPTS),
                n: rg('rngPnStrokeN', '虚线密度', 'style.fill.pn.stroke.n', 10, 200, 1, 'outPnStrokeN', 'int1', 'raw'),
                ratio: rg('rngPnStrokeRatio', '虚实比', 'style.fill.pn.stroke.ratio', 20, 90, 1, 'outPnStrokeRatio', 'lin01', 'pct') },
                'style.fill.pn.stroke', 'pnstroke', 'cbPnStroke'),
            ], { sw: 'cbPn', gate: 'polar' }),
            sep(),
            /* ★ v41（需求二·2）：极昼极夜「文字注释」同晨昏线改版 ——
               组级总开关（标题行）+ 极昼 / 极夜两条注释各一个子组（各自标题行带开关）。
               组开关写新状态 polarNote.on，门控 note.master.on + polar。 */
            G('文字注释', [
              noteGrp('极昼注释', 'pd', 'ncPd', 'ncPdOn', 'note.master.on,polar,polarNote.on,pd.on'),
              noteGrp('极夜注释', 'pn', 'ncPn', 'ncPnOn', 'note.master.on,polar,polarNote.on,pn.on'),
            ], { sw: 'cbPolarNote', swPath: 'polarNote.on', gate: 'note.master.on,polar' }),
          ]
        },
        /* ★ v37（需求一·1）：「时间面板数据」同步上移为二级菜单（原在「太阳直射点」下）。
           它读的就是时间面板上那几行实时数值（直射点经纬度 / 极昼极夜度数范围 /
           黄赤交角 / 公转速度 / 面积速度），名称直指去向。 */
        {
          id: 'pLightRead', icon: '📟', name: '时间面板数据', children: [
            use('cbReadSub', '太阳直射点经纬度'),
            use('cbReadPolar', '极昼极夜度数范围'),
            use('cbReadObliq', '黄赤交角与地轴倾角'),
            /* v28（需求④）：地球公转的实时瞬时线速度与角速度 —— 默认隐藏。
               数值由真实椭圆轨道解算（近日点 30.29 km/s · 1.019°/日，
               远日点 29.29 km/s · 0.954°/日），并同时给出当日日地距离。 */
            use('cbReadOrbV', '地球公转瞬时线速度 / 角速度'),
            /* v29（需求③）：地球公转面积速度（dA/dt，开普勒第二定律，恒定）——
               显隐由本面板控制；数值显示在「时间」面板。 */
            use('cbReadOrbArea', '地球公转面积速度'),
          ]
        },
      ]
    },

    /* ---------------- 二、地球表层 ---------------- */
    {
      id: 'sSurface', icon: '🌫️', name: '地球表层', sub: '灯光 · 地轴 · 经纬线 · 温度带 · 时刻 · 时区 · 时差',
      children: [
        {
          id: 'pSurfAxis', icon: '🧭', name: '地轴与南北极', sw: 'cbAxis', swTip: '显示地轴', children: [
            /* v33（面板规格）：撤掉多余的「地轴样式」一层，线粗细 / 线长度 / 线颜色 /
               透明度 / 类型 直接挂在「地轴」下。 */
            G('地轴', [
              lwCtl('rngAxisWidth', '线粗细', 'style.ln.axis.w', 'outAxisWidth'),
              use('rngAxisLen', '地轴长度'),
              use('clrAxis', '线颜色'),
              rg('rngAxisOp', '透明度', 'style.ln.axis.op', 0, 100, 1, 'outAxisOp', 'lin01', 'pct'),
              G('类型', [
                rg('rngAxisN', '虚线密度', 'style.ln.axis.n', 10, 200, 1, 'outAxisN', 'int1', 'raw'),
                rg('rngAxisRatio', '虚实比', 'style.ln.axis.ratio', 20, 90, 1, 'outAxisRatio', 'lin01', 'pct'),
              ], { ctl: sl('selAxisDash', '类型', 'style.ln.axis.dash', DASH_OPTS), dash: 'axis' }),
            ], { gate: 'axis' }),
            sep(),
            G('文字注释【N、S】', [
              sw('cbAxisNoteN', '北极注释（写N）', 'axisNote.n'),
              sw('cbAxisNoteS', '南极注释（写S）', 'axisNote.s'),
              sep(),
              noteGrp('注释样式', 'axis', 'ncAxis', null),
            ], { sw: 'cbAxisNote', swPath: 'note.cats.axis.on', gate: 'note.master.on,axis' }),
          ]
        },
        {
          /* v26.1（需求⑥ + 需求⑫）：「显示真实地球」是本菜单的总开关（移到标题前），
             下面每一项都是它的**子开关** —— 关掉总开关，夜间城市灯光 / 云层 / 大气光晕 /
             极光 / 昼夜对比 一并关闭并置灰（真实地球关 = 白色球，这些贴图效果无意义）。
             v26.1（需求⑥·用户确认口径）：**含昼夜对比** —— 白色球模式下不再调节明暗。 */
          id: 'pSurfFx', icon: '🌫️', name: '表层效果', sw: 'cbRealEarth', swPath: 'realTex',
          swTip: '显示真实地球（关＝白色球）', children: [
            // v25.1（需求④）：真实地球 / 白色球切换 —— 开启显示真实地表贴图；
            //   关闭则显示白色球，仅呈现太阳光照形成的明暗阴影（昼半球受光、夜半球背光变暗）。
            /* v33（面板规格）曾把四种贴图效果连同强度滑块收进「真实地球」一组；
               v52（需求二）起又移出到本面板（见下），该分组已空置。 */
            /* ★ v52（需求二）：四个贴图效果开关从「真实地球」子级移出 —— 与「真实地球」
               平级、直接显示在「表层效果」面板里（不再被 realTex 门控隐藏）；
               各自的开关同时前置到分组标题行（需求一）。它们原先只继承父组 真实地球 的
               gate:'realTex'，节点本身并无 gate，移出后即自然解除门控。 */
            G('夜间城市灯光', [
              rg('rngNightOp', '灯光透明度', 'sfx.nightOp', 0, 100, 1, 'outNightOp', 'lin01', 'pct'),
            ], { sw: 'cbNight', swTip: '夜间城市灯光' }),
            G('云层', [
              rg('rngCloudsOp', '云层透明度', 'sfx.cloudsOp', 0, 100, 1, 'outCloudsOp', 'lin01', 'pct'),
            ], { sw: 'cbClouds', swTip: '云层' }),
            G('大气光晕', [
              rg('rngAtmoStr', '大气光晕强度', 'sfx.atmoStr', 0, 200, 1, 'outAtmoStr', 'lin01', 'pct'),
            ], { sw: 'cbAtmo', swTip: '大气光晕' }),
            G('极光', [
              use('rngAuroraBright', '极光亮度'),
              rg('rngAuroraOp', '极光透明度', 'sfx.auroraOp', 0, 100, 1, 'outAuroraOp', 'lin01', 'pct'),
            ], { sw: 'cbAurora', swTip: '极光' }),
            /* ★ v52（需求二）：四个贴图效果移出后「真实地球」组已无子项，且该组自身不带 sw
               （真实地球总开关是「表层效果」标题行的 cbRealEarth）—— 故整组删除。 */
            G('昼夜对比', [
              use('rngDayGain', '昼面亮度'), use('rngNightGain', '夜面亮度'), use('rngSpec', '高光反光'),
              use('rngSoft', '明暗过渡'),
            ], { gate: 'realTex' }),
          ]
        },
        {
          id: 'pSurfGrat', icon: '📐', name: '经纬网', sw: 'cbGrat', swTip: '显示经纬网', children: [
            G('经线', [
              /* v33（面板规格）：「显示间隔」改为复选框多选 —— 勾几个就同时画几套
                 （实际描的是各间隔角度的并集，不会重复描线）。 */
              G('显示间隔', [
                sw('cbGratMerStep10', '每 10°', 'grat.merSteps.10'),
                sw('cbGratMerStep15', '每 15°', 'grat.merSteps.15'),
                sw('cbGratMerStep20', '每 20°', 'grat.merSteps.20'),
                sw('cbGratMerStep30', '每 30°', 'grat.merSteps.30'),
                sw('cbGratMerStep45', '每 45°', 'grat.merSteps.45'),
                sw('cbGratMerStep60', '每 60°', 'grat.merSteps.60'),
              ]),
              G('经线样式', [
                rg('rngMerW', '线粗细', 'style.ln.mer.w', 10, 300, 1, 'outMerW', 'lwRel', 'lwX'),
                cl('clrMer', '线颜色', 'style.ln.mer.color', 'hexMer'),
                rg('rngMerOp', '透明度', 'style.ln.mer.op', 0, 100, 1, 'outMerOp', 'lin01', 'pct'),
                G('类型', [
                  rg('rngMerN', '虚线密度', 'style.ln.mer.n', 10, 200, 1, 'outMerN', 'int1', 'raw'),
                  rg('rngMerRatio', '虚实比', 'style.ln.mer.ratio', 20, 90, 1, 'outMerRatio', 'lin01', 'pct'),
                ], { ctl: sl('selMerDash', '类型', 'style.ln.mer.dash', DASH_OPTS), dash: 'mer' }),
              ]),
            ], { sw: 'cbGratMer', gate: 'graticule' }),
            G('纬线', [
              G('显示间隔', [
                sw('cbGratParStep10', '每 10°', 'grat.parSteps.10'),
                sw('cbGratParStep15', '每 15°', 'grat.parSteps.15'),
                sw('cbGratParStep20', '每 20°', 'grat.parSteps.20'),
                sw('cbGratParStep30', '每 30°', 'grat.parSteps.30'),
                sw('cbGratParStep45', '每 45°', 'grat.parSteps.45'),
                sw('cbGratParStep60', '每 60°', 'grat.parSteps.60'),
              ]),
              G('纬线样式', [
                rg('rngParW', '线粗细', 'style.ln.par.w', 10, 300, 1, 'outParW', 'lwRel', 'lwX'),
                cl('clrPar', '线颜色', 'style.ln.par.color', 'hexPar'),
                rg('rngParOp', '透明度', 'style.ln.par.op', 0, 100, 1, 'outParOp', 'lin01', 'pct'),
                G('类型', [
                  rg('rngParN', '虚线密度', 'style.ln.par.n', 10, 200, 1, 'outParN', 'int1', 'raw'),
                  rg('rngParRatio', '虚实比', 'style.ln.par.ratio', 20, 90, 1, 'outParRatio', 'lin01', 'pct'),
                ], { ctl: sl('selParDash', '类型', 'style.ln.par.dash', DASH_OPTS), dash: 'par' }),
              ]),
            ], { sw: 'cbGratPar', gate: 'graticule' }),
            G('特殊经纬线', [
              // v23.0（需求②）：特殊经纬线（赤道 / 回归线 / 极圈 / 本初子午线）隶属「经纬网」——
              //   必须先打开「显示经纬网」，这四项才可用；经纬网一关，它们连同各自注释一起隐藏。
              G('赤道', [
                lwCtl('rngEqW', '线粗细', 'style.ln.eq.w', 'outEqW'), use('clrEq', '线颜色'), use('rngEqOp', '透明度'),
                G('类型', [
                  rg('rngEqN', '虚线密度', 'style.ln.eq.n', 10, 200, 1, 'outEqN', 'int1', 'raw'),
                  rg('rngEqRatio', '虚实比', 'style.ln.eq.ratio', 20, 90, 1, 'outEqRatio', 'lin01', 'pct'),
                ], { ctl: sl('selEqDash', '类型', 'style.ln.eq.dash', DASH_OPTS), dash: 'eq' }),
              ], { sw: 'cbEq', gate: 'graticule' }),
              G('南北回归线', [
                lwCtl('rngTrW', '线粗细', 'style.ln.tr.w', 'outTrW'), use('clrTr', '线颜色'), use('rngTrOp', '透明度'),
                use('rngTrN', '虚线密度'), use('rngTrRatio', '虚实比'),
              ], { sw: 'cbTr', gate: 'graticule' }),
              G('南北极圈', [
                lwCtl('rngArW', '线粗细', 'style.ln.ar.w', 'outArW'), use('clrAr', '线颜色'), use('rngArOp', '透明度'),
                use('rngArN', '虚线密度'), use('rngArRatio', '虚实比'),
              ], { sw: 'cbAr', gate: 'graticule' }),
              G('本初子午线', [
                lwCtl('rngPmW', '线粗细', 'style.ln.pm.w', 'outPmW'), use('clrPm', '线颜色'), use('rngPmOp', '透明度'),
                G('类型', [
                  rg('rngPmN', '虚线密度', 'style.ln.pm.n', 10, 200, 1, 'outPmN', 'int1', 'raw'),
                  rg('rngPmRatio', '虚实比', 'style.ln.pm.ratio', 20, 90, 1, 'outPmRatio', 'lin01', 'pct'),
                ], { ctl: sl('selPmDash', '类型', 'style.ln.pm.dash', DASH_OPTS), dash: 'pm' }),
              ], { sw: 'cbPm', gate: 'graticule' }),
            ], { gate: 'graticule' }),
            // v21.0（需求③）：经纬网文字注释逐项受「对应经纬线是否显示」控制 ——
            //   经纬网 → 经线 / 纬线 / 特殊经纬线 → 对应注释，三级依次为真才显示。
            G('文字注释', [
              sw('cbGratNoteLon', '经度（除了本初子午线）', 'grat.note.lon', 'graticule,grat.mer'),
              sw('cbGratNoteLat', '纬度（除了特殊纬线）', 'grat.note.lat', 'graticule,grat.par'),
              // v23.5：赤道文字注释从「纬度」中拆出，作为「特殊经纬线」单独控制
              //   （受 显示经纬网 + 赤道 两个开关制约）
              sw('cbGratNoteEq', '赤道（标文字）', 'grat.note.eq', 'graticule,eq.on'),
              sw('cbGratNoteTr', '南北回归线（标文字）', 'grat.note.tr', 'graticule,tr.on'),
              sw('cbGratNoteAr', '南北极圈（标文字）', 'grat.note.ar', 'graticule,ar.on'),
              sw('cbGratNotePm', '本初子午线（标文字）', 'grat.note.pm', 'graticule,pm.on'),
              noteGrp('文字样式', 'lat', 'ncLat', null, 'note.master.on,graticule'),
            ], { sw: 'cbGratNote', swPath: 'grat.note.on', gate: 'note.master.on,graticule' }),
          ]
        },
        {
          /* v25.1（需求⑤）：海陆分布 —— 海洋 / 陆地两面 + 海岸线轮廓 + 四大洋注记
             v33（面板规格）：原「海陆分布」与「七大洲」两个并列的二级菜单**合并**为
             「海陆分布与七大洲」一个 —— 二者同属一套掩膜数据（陆地外壳 / 海岸线 / 大洲边界环），
             合并后按「海洋 → 陆地 → 海岸线 → 七大洲」的顺序一次排完，不必来回切两个面板。
             各开关 id 与状态路径全部保持原样，app.js 绑定链不受影响。 */
          id: 'pLandSea', icon: '🗺️', name: '海陆分布与七大洲', sw: 'cbLandSea', swPath: 'geo.landSea.on',
          swTip: '显示海陆分布', children: [
            G('海洋', [
              G('填充', [
                cl('clrGeoOcean', '填充颜色', 'style.fill.ocean.fill', 'hexGeoOcean'),
                rg('rngGeoOceanOp', '填充透明度', 'style.fill.ocean.op', 0, 100, 1, 'outGeoOceanOp', 'lin01', 'pct'),
              ]),
              noteGrp('文字注释【太平洋、北冰洋、大西洋、印度洋】', 'sea', 'ncSea', 'cbGeoSeaNote',
                'geo.landSea.on', 'geo.landSea.note.on'),
            ], { sw: 'cbGeoOcean', swPath: 'geo.landSea.ocean', gate: 'geo.landSea.on' }),
            G('陆地', [
              cl('clrGeoLand', '填充颜色', 'style.fill.land.fill', 'hexGeoLand'),
              rg('rngGeoLandOp', '填充透明度', 'style.fill.land.op', 0, 100, 1, 'outGeoLandOp', 'lin01', 'pct'),
            ], { sw: 'cbGeoLand', swPath: 'geo.landSea.land', gate: 'geo.landSea.on' }),
            G('海岸线轮廓', [
              rg('rngGeoCoastW', '线粗细', 'style.fill.coast.w', 10, 300, 1, 'outGeoCoastW', 'lwRel', 'lwX'),
              cl('clrGeoCoast', '线颜色', 'style.fill.coast.color', 'hexGeoCoast'),
              rg('rngGeoCoastOp', '透明度', 'style.fill.coast.op', 0, 100, 1, 'outGeoCoastOp', 'lin01', 'pct'),
            ], { sw: 'cbGeoCoast', swPath: 'style.fill.coast.on', gate: 'geo.landSea.on' }),
            G('七大洲', [
              G('单独显示', [
                sw('cbContAS', '亚洲', 'geo.cont.list.AS', 'geo.cont.on'),
                sw('cbContEU', '欧洲', 'geo.cont.list.EU', 'geo.cont.on'),
                sw('cbContAF', '非洲', 'geo.cont.list.AF', 'geo.cont.on'),
                sw('cbContNA', '北美洲', 'geo.cont.list.NA', 'geo.cont.on'),
                sw('cbContSA', '南美洲', 'geo.cont.list.SA', 'geo.cont.on'),
                sw('cbContOC', '大洋洲', 'geo.cont.list.OC', 'geo.cont.on'),
                sw('cbContAN', '南极洲', 'geo.cont.list.AN', 'geo.cont.on'),
              ], { gate: 'geo.cont.on' }),
              G('各洲填色', [
                cl('clrContAS', '亚洲', 'style.fill.cont.colors.AS', 'hexContAS'),
                cl('clrContEU', '欧洲', 'style.fill.cont.colors.EU', 'hexContEU'),
                cl('clrContAF', '非洲', 'style.fill.cont.colors.AF', 'hexContAF'),
                cl('clrContNA', '北美洲', 'style.fill.cont.colors.NA', 'hexContNA'),
                cl('clrContSA', '南美洲', 'style.fill.cont.colors.SA', 'hexContSA'),
                cl('clrContOC', '大洋洲', 'style.fill.cont.colors.OC', 'hexContOC'),
                cl('clrContAN', '南极洲', 'style.fill.cont.colors.AN', 'hexContAN'),
                rg('rngGeoContOp', '填充透明度', 'style.fill.cont.op', 0, 100, 1, 'outGeoContOp', 'lin01', 'pct'),
              ], { gate: 'geo.cont.on' }),
              G('大洲界线', [
                rg('rngGeoContLineW', '线粗细', 'style.fill.contLine.w', 10, 300, 1, 'outGeoContLineW', 'lwRel', 'lwX'),
                cl('clrGeoContLine', '线颜色', 'style.fill.contLine.color', 'hexGeoContLine'),
                rg('rngGeoContLineOp', '透明度', 'style.fill.contLine.op', 0, 100, 1, 'outGeoContLineOp', 'lin01', 'pct'),
              ], { sw: 'cbGeoContLine', swPath: 'style.fill.contLine.on', gate: 'geo.cont.on' }),
              noteGrp('文字注释【亚洲、非洲、欧洲、北美洲、南美洲、大洋洲、南极洲】', 'cont', 'ncCont',
                'cbGeoContNote', 'geo.cont.on', 'geo.cont.note.on'),
            ], { sw: 'cbGeoCont', swPath: 'geo.cont.on' }),
            /* v26.1（需求③）：数据装载状态行 —— 掩膜贴图缺失时 app.js 会回落到全黑掩膜，
               图层「开着却什么都不画」。以前界面上毫无提示，这里把装载结果写出来。
               v33：合并后两块数据（陆地外壳 / 大洲边界）的状态行上下并列。 */
            raw('<div class="geo-stat" id="landSeaStat"></div>'),
            raw('<div class="geo-stat" id="contStat"></div>'),
            tip('数据：全球陆地外壳 553 个环 / 26498 个点，海岸线由矢量边界栅格化成掩膜轮廓；'
              + '界线取自 7 大洲各自的边界环（共 1425 环 / 61548 点），大洲之间以陆上国界相接时显示分界'),
          ]
        },
        /* ================= v26.1（需求⑨）：四组「区域」面要素 =================
           与「温度带」同构：总开关（菜单标题前）→ 各分区单独显示 → 填充颜色 / 透明度 /
           分界线描边 → 逐项文字注释。所有面都由代码按经纬度直接生成球面几何，
           不依赖任何外部数据文件，因此不会出现「数据缺失 → 面画不出来」。 */
        {
          id: 'pHemiEW', icon: '🌗', name: '东西半球', sw: 'cbHemiEW', swPath: 'hemi.ew.on',
          swTip: '显示东西半球', children: [
            G('单独显示', [
              sw('cbHemiEast', '东半球（20°W 向东到 160°E）', 'hemi.ew.east', 'hemi.ew.on'),
              sw('cbHemiWest', '西半球（160°E 向东到 20°W）', 'hemi.ew.west', 'hemi.ew.on'),
            ], { gate: 'hemi.ew.on' }),
            G('显示样式', [
              G('填充颜色', [
                cl('clrHemiEast', '东半球', 'style.fill.hemi.east', 'hexHemiEast'),
                cl('clrHemiWest', '西半球', 'style.fill.hemi.west', 'hexHemiWest'),
              ]),
              rg('rngHemiOp', '填充透明度', 'style.fill.hemi.op', 0, 100, 1, 'outHemiOp', 'lin01', 'pct'),
            ], { gate: 'hemi.ew.on' }),
            /* v27.2（需求③）：「分界线」从「显示样式」组内提取为同级并列选项（三个区域面板统一结构），
               组本身自带门控 —— 功能行为（开关 / 样式绑定 / 置灰链）与提取前完全一致。 */
            /* v35（需求二）：东西半球分界线固定**实线** —— 删除线型 / 虚线密度 / 虚实比控件。 */
            strokeGrp({ w: rg('rngHemiLineW', '线粗细', 'style.fill.hemi.lineW', 10, 300, 1, 'outHemiLineW', 'lwRel', 'lwX'),
                        c: cl('clrHemiLine', '线颜色', 'style.fill.hemi.line', 'hexHemiLine'),
                        op: rg('rngHemiLineOp', '透明度', 'style.fill.hemi.lineOp', 0, 100, 1, 'outHemiLineOp', 'lin01', 'pct') },
                      'style.fill.hemi', null, 'cbHemiLine', 'hemi.ew.line', '分界线（20°W / 160°E）· 实线', 'hemi.ew.on'),
            sep(),
            G('文字注释', [
              sw('cbHemiNoteEast', '东半球', 'hemi.ew.note.east', 'hemi.ew.on,hemi.ew.east'),
              sw('cbHemiNoteWest', '西半球', 'hemi.ew.note.west', 'hemi.ew.on,hemi.ew.west'),
              noteGrp('文字样式', 'hemiEW', 'ncHemiEW', null, 'note.master.on,hemi.ew.on'),
            ], { sw: 'cbHemiNote', swPath: 'hemi.ew.note.on', gate: 'note.master.on,hemi.ew.on' }),
            tip('东西半球不以 0° / 180° 经线划分 —— 按 20°W 与 160°E 这一对经线划分，'
              + '为的是避免把欧洲和非洲的一些国家切到两个半球去。'),
          ]
        },
        {
          id: 'pHemiNS', icon: '🌓', name: '南北半球', sw: 'cbHemiNS', swPath: 'hemi.ns.on',
          swTip: '显示南北半球', children: [
            G('单独显示', [
              sw('cbHemiNorth', '北半球（赤道以北）', 'hemi.ns.north', 'hemi.ns.on'),
              sw('cbHemiSouth', '南半球（赤道以南）', 'hemi.ns.south', 'hemi.ns.on'),
            ], { gate: 'hemi.ns.on' }),
            G('显示样式', [
              G('填充颜色', [
                cl('clrHemiNorth', '北半球', 'style.fill.hemiNS.north', 'hexHemiNorth'),
                cl('clrHemiSouth', '南半球', 'style.fill.hemiNS.south', 'hexHemiSouth'),
              ]),
              rg('rngHemiNSOp', '填充透明度', 'style.fill.hemiNS.op', 0, 100, 1, 'outHemiNSOp', 'lin01', 'pct'),
            ], { gate: 'hemi.ns.on' }),
            /* v27.2（需求③）：「分界线」提取为与「显示样式」同级的并列选项（三个区域面板统一结构）。 */
            /* v35（需求二）：南北半球分界线（赤道）固定**实线**。 */
            strokeGrp({ w: rg('rngHemiNSLineW', '线粗细', 'style.fill.hemiNS.lineW', 10, 300, 1, 'outHemiNSLineW', 'lwRel', 'lwX'),
                        c: cl('clrHemiNSLine', '线颜色', 'style.fill.hemiNS.line', 'hexHemiNSLine'),
                        op: rg('rngHemiNSLineOp', '透明度', 'style.fill.hemiNS.lineOp', 0, 100, 1, 'outHemiNSLineOp', 'lin01', 'pct') },
                      'style.fill.hemiNS', null, 'cbHemiNSLine', 'hemi.ns.line', '分界线（赤道）· 实线', 'hemi.ns.on'),
            sep(),
            G('文字注释', [
              sw('cbHemiNoteNorth', '北半球', 'hemi.ns.note.north', 'hemi.ns.on,hemi.ns.north'),
              sw('cbHemiNoteSouth', '南半球', 'hemi.ns.note.south', 'hemi.ns.on,hemi.ns.south'),
              noteGrp('文字样式', 'hemiNS', 'ncHemiNS', null, 'note.master.on,hemi.ns.on'),
            ], { sw: 'cbHemiNoteNS', swPath: 'hemi.ns.note.on', gate: 'note.master.on,hemi.ns.on' }),
            tip('南北半球以赤道（0° 纬线）为界 —— 赤道是地球上唯一的大圆纬线，'
              + '也是南北纬度、南北半球的起始线。'),
          ]
        },
        {
          id: 'pSurfZone', icon: '🌡️', name: '温度带', sw: 'cbZones', swTip: '显示温度带', children: [
            G('单独显示', [
              sw('cbZcoldN', '北寒带', 'zones.bands.coldN'),
              sw('cbZtempN', '北温带', 'zones.bands.tempN'),
              sw('cbZtropic', '热带', 'zones.bands.tropic'),
              sw('cbZtempS', '南温带', 'zones.bands.tempS'),
              sw('cbZcoldS', '南寒带', 'zones.bands.coldS'),
            ], { gate: 'zones.on' }),
            // v23.0（需求②）：「显示样式」属于温度带自身的设置，温度带总开关关闭时一并置灰
            G('显示样式', [
              G('填充颜色', [
                use('clrZcoldN', '北寒带'), use('clrZtempN', '北温带'), use('clrZtropic', '热带'),
                use('clrZtempS', '南温带'), use('clrZcoldS', '南寒带'),
              ]),
              use('rngZoneOp', '填充透明度'),
            ], { gate: 'zones.on' }),
            // v23.0（需求①）：「纬度带（五带）描边」整组取消 —— 填充面不再自带描边。
            // v27.1（需求④）：分界线（南北回归线 / 南北极圈）以**独立图层**回归：
            //   独立显隐开关（zones.line）+ 独立线型，随黄赤交角自动移动纬度。
            /* v35（需求二）：温度带分界线固定**虚线** —— 删除线型选择器，
               只保留虚线密度 / 虚实比两个参数（行不再随实线置灰）。 */
            G('分界线（回归线 / 极圈）· 虚线', [
              rg('rngZoneLineW', '线粗细', 'style.fill.zone.line.w', 10, 300, 1, 'outZoneLineW', 'lwRel', 'lwX'),
              cl('clrZoneLine', '线颜色', 'style.fill.zone.line.color', 'hexZoneLine'),
              rg('rngZoneLineOp', '透明度', 'style.fill.zone.line.op', 0, 100, 1, 'outZoneLineOp', 'lin01', 'pct'),
              rg('rngZoneLineN', '虚线密度', 'style.fill.zone.line.n', 10, 200, 1, 'outZoneLineN', 'int1', 'raw'),
              rg('rngZoneLineRatio', '虚实比', 'style.fill.zone.line.ratio', 20, 90, 1, 'outZoneLineRatio', 'lin01', 'pct'),
            ], { sw: 'cbZoneLine', swPath: 'zones.line', gate: 'zones.on' }),
            sep(),
            // v21.0（需求③）：温度带 → 该带是否显示 → 该带文字注释，三级依次为真才显示
            G('文字注释', [
              sw('cbZoneNoteColdN', '北寒带', 'zones.note.coldN', 'zones.on,zones.bands.coldN'),
              sw('cbZoneNoteTempN', '北温带', 'zones.note.tempN', 'zones.on,zones.bands.tempN'),
              sw('cbZoneNoteTropic', '热带', 'zones.note.tropic', 'zones.on,zones.bands.tropic'),
              sw('cbZoneNoteTempS', '南温带', 'zones.note.tempS', 'zones.on,zones.bands.tempS'),
              sw('cbZoneNoteColdS', '南寒带', 'zones.note.coldS', 'zones.on,zones.bands.coldS'),
              noteGrp('文字样式', 'zone', 'ncZone', null, 'note.master.on,zones.on'),
            ], { sw: 'cbZoneNote', swPath: 'zones.note.on', gate: 'note.master.on,zones.on' }),
          ]
        },
        {
          id: 'pLatBelt', icon: '📶', name: '低中高纬度', sw: 'cbLatBelt', swPath: 'latbelt.on',
          swTip: '显示低中高纬度带', children: [
            G('单独显示', [
              sw('cbBeltLow', '低纬度 0°–30°', 'latbelt.bands.low', 'latbelt.on'),
              sw('cbBeltMid', '中纬度 30°–60°', 'latbelt.bands.mid', 'latbelt.on'),
              sw('cbBeltHigh', '高纬度 60°–90°', 'latbelt.bands.high', 'latbelt.on'),
            ], { gate: 'latbelt.on' }),
            G('显示样式', [
              G('填充颜色', [
                cl('clrBeltLow', '低纬度', 'style.fill.latbelt.low', 'hexBeltLow'),
                cl('clrBeltMid', '中纬度', 'style.fill.latbelt.mid', 'hexBeltMid'),
                cl('clrBeltHigh', '高纬度', 'style.fill.latbelt.high', 'hexBeltHigh'),
              ]),
              rg('rngBeltOp', '填充透明度', 'style.fill.latbelt.op', 0, 100, 1, 'outBeltOp', 'lin01', 'pct'),
            ], { gate: 'latbelt.on' }),
            // v27.0（需求二.3）：纬度带不再绘制轮廓描边，此前的「描边（轮廓）」组整组删除
            //   （与温度带 v23.0 取消五带描边同口径）。
            // v27.1（需求④）：±30° / ±60° 分界线以**独立图层**回归：独立显隐开关 + 独立线型。
            /* v27.2（需求③）：「分界线」从「显示样式」组内提取为同级并列选项（三个区域面板统一结构），
               门控 / 开关 / 样式绑定均保持原样。 */
            /* v35（需求二）：低中高纬度分界线固定**实线** —— 删除类型 / 虚线密度 / 虚实比控件。 */
            G('分界线（±30° / ±60°）· 实线', [
              rg('rngBeltLineW', '线粗细', 'style.fill.latbelt.line.w', 10, 300, 1, 'outBeltLineW', 'lwRel', 'lwX'),
              cl('clrBeltLine', '线颜色', 'style.fill.latbelt.line.color', 'hexBeltLine'),
              rg('rngBeltLineOp', '透明度', 'style.fill.latbelt.line.op', 0, 100, 1, 'outBeltLineOp', 'lin01', 'pct'),
            ], { sw: 'cbBeltLine', swPath: 'latbelt.line', gate: 'latbelt.on' }),
            sep(),
            G('文字注释', [
              sw('cbBeltNoteLow', '低纬度（南 / 北）', 'latbelt.note.low', 'latbelt.on,latbelt.bands.low'),
              sw('cbBeltNoteMid', '中纬度（南 / 北）', 'latbelt.note.mid', 'latbelt.on,latbelt.bands.mid'),
              sw('cbBeltNoteHigh', '高纬度（南 / 北）', 'latbelt.note.high', 'latbelt.on,latbelt.bands.high'),
              noteGrp('文字样式', 'latBelt', 'ncLatBelt', null, 'note.master.on,latbelt.on'),
            ], { sw: 'cbLatBeltNote', swPath: 'latbelt.note.on', gate: 'note.master.on,latbelt.on' }),
            tip('低中高纬度是人们按「获得太阳光热的多少」作的习惯划分：'
              + '低纬度大致对应热带，中纬度对应温带，高纬度对应寒带 —— 与「温度带」互为参照。'
              + '文字注释在南北半球各标一份、只写文字不写度数；分界线（±30°/±60°）是独立图层，可单独开关与设置样式。'),
          ]
        },
        {
          id: 'pSurfHour', icon: '🕐', name: '地方时刻', sw: 'cbHourOn', swPath: 'hour.on',
          swTip: '显示地方时刻', children: [
            // v18.0：菜单标题由「地方时刻标注」改为「地方时刻」—— 本菜单同时管「点」与「文字标注」两件事：
            //        下面两组开关控制赤道上的时刻点（默认隐藏），末尾「文字注释」组控制对应的数字标注（默认隐藏）。
            G('四个主时刻点（0 / 6 / 12 / 18）', [
              use('rngHourMainSize', '点大小'), use('clrHourMain', '点颜色'),
              rg('rngHourMainOp', '透明度', 'style.pt.hourMain.op', 0, 100, 1, 'outHourMainOp', 'lin01', 'pct'),
            ], { sw: 'cbHourMain', gate: 'hour.on' }),
            G('其余二十个时刻点', [
              use('rngHourRestSize', '点大小'), use('clrHourRest', '点颜色'),
              rg('rngHourRestOp', '透明度', 'style.pt.hourRest.op', 0, 100, 1, 'outHourRestOp', 'lin01', 'pct'),
            ], { sw: 'cbHourRest', gate: 'hour.on' }),
            sep(),
            // v21.0（需求③）：地方时刻 → 该组时刻点是否显示 → 该组文字标注，三级依次为真才显示
            G('文字注释', [
              noteGrp('四个主时刻（0 / 6 / 12 / 18）', 'hourMain', 'ncHourMain', 'ncHourMainOn',
                      'note.master.on,hour.on,style.pt.hourMain.on'),
              noteGrp('其余二十个', 'hourRest', 'ncHourRest', 'ncHourRestOn',
                      'note.master.on,hour.on,style.pt.hourRest.on'),
            ], { sw: 'cbHourNote', swPath: 'hourNote.on', gate: 'note.master.on,hour.on' }),
          ]
        },
        {
          id: 'pSurfTz', icon: '🕓', name: '时区', sw: 'cbTz', swTip: '显示时区', children: [
            // v23.0（需求②）：时区样式隶属「时区」这一地理事物 —— 总开关关闭时一并置灰
            G('时区样式', [
              use('cbTzStripe', '相邻面交互填充'),
              use('clrTzFill', '填充颜色'),
              use('rngTzFillOp', '填充透明度'),
              use('clrTzFill2', '交替面填充颜色'),
              use('rngTzFillOp2', '交替面透明度'),
              strokeGrp({ w: lwCtl('rngTzStrokeW', '线粗细', 'style.fill.tz.stroke.w', 'outTzStrokeW'), c: 'clrTzStroke', op: 'rngTzStrokeOp',
                          dash: 'selTzStrokeDash', n: 'rngTzStrokeN', ratio: 'rngTzStrokeRatio' },
                        'style.fill.tz.stroke', 'tzstroke', 'cbTzStroke'),
            ], { gate: 'tz.on' }),
            sep(),
            noteGrp('文字注释', 'tz', 'ncTz', 'ncTzOn', 'note.master.on,tz.on'),
          ]
        },
        {
          /* v25.1（需求⑦）：时差演示 —— 面板顺序严格按用户给定的布局排列：
             时差演示（总开关）→ 中时区 / 国际日期变更线 / 0°时刻所在经线 / 新的一天 / 旧的一天
             → 文字注释（下含同名的 5 组注释样式）。
             · 中时区（零时区）：面填充 + 描边，属性类型与其它面要素完全一致；
             · 两条日期分界线 + 两个日期范围面：线用「粗细 / 颜色 / 透明度 / 类型」，
               面用「填充颜色 / 填充透明度」，同样照搬其它线 / 面要素的控件写法；
             · 5 条注释各自一个开关节点的样式组（状态路径写 tzdiff.note.*，
               分类则逐条独立：tzdiffTz0 / tzdiffIdl / tzdiffZero / tzdiffNew / tzdiffOld）。 */
          id: 'pTzdiff', icon: '🌐', name: '时差演示', sw: 'cbTzdiff', swPath: 'tzdiff.on',
          swTip: '显示时差演示', children: [
            G('中时区', [
              G('填充', [
                cl('clrTzdiffTz0', '填充颜色', 'style.fill.tzdiff.fill', 'hexTzdiffTz0'),
                rg('rngTzdiffTz0Op', '透明度', 'style.fill.tzdiff.op', 0, 100, 1, 'outTzdiffTz0Op', 'lin01', 'pct'),
              ]),
              strokeGrp({ w: rg('rngTzdiffStrokeW', '线粗细', 'style.fill.tzdiff.stroke.w', 10, 300, 1, 'outTzdiffStrokeW', 'lwRel', 'lwX'),
                          c: cl('clrTzdiffStroke', '线颜色', 'style.fill.tzdiff.stroke.color', 'hexTzdiffStroke'),
                          op: rg('rngTzdiffStrokeOp', '透明度', 'style.fill.tzdiff.stroke.op', 0, 100, 1, 'outTzdiffStrokeOp', 'lin01', 'pct'),
                          dash: sl('selTzdiffStrokeDash', '类型', 'style.fill.tzdiff.stroke.dash', DASH_OPTS),
                          n: rg('rngTzdiffStrokeN', '虚线密度', 'style.fill.tzdiff.stroke.n', 10, 200, 1, 'outTzdiffStrokeN', 'int1', 'raw'),
                          ratio: rg('rngTzdiffStrokeRatio', '虚实比', 'style.fill.tzdiff.stroke.ratio', 20, 90, 1, 'outTzdiffStrokeRatio', 'lin01', 'pct') },
                        'style.fill.tzdiff.stroke', 'tzdiffstroke', 'cbTzdiffStroke'),
            ], { sw: 'cbTzdiffTz0', swPath: 'tzdiff.tz0.on', gate: 'tzdiff.on' }),
            G('国际日期变更线', [
              rg('rngTzdiffIdlW', '线粗细', 'style.fill.tzdiff.idl.w', 10, 300, 1, 'outTzdiffIdlW', 'lwRel', 'lwX'),
              cl('clrTzdiffIdl', '线颜色', 'style.fill.tzdiff.idl.color', 'hexTzdiffIdl'),
              rg('rngTzdiffIdlOp', '透明度', 'style.fill.tzdiff.idl.op', 0, 100, 1, 'outTzdiffIdlOp', 'lin01', 'pct'),
              G('类型', [
                rg('rngTzdiffIdlN', '虚线密度', 'style.fill.tzdiff.idl.n', 10, 200, 1, 'outTzdiffIdlN', 'int1', 'raw'),
                rg('rngTzdiffIdlRatio', '虚实比', 'style.fill.tzdiff.idl.ratio', 20, 90, 1, 'outTzdiffIdlRatio', 'lin01', 'pct'),
              ], { ctl: sl('selTzdiffIdlDash', '类型', 'style.fill.tzdiff.idl.dash', DASH_OPTS), dash: 'tzdiffidl' }),
            ], { sw: 'cbTzdiffIdl', swPath: 'tzdiff.idl.on', gate: 'tzdiff.on' }),
            G('0°时刻所在经线', [
              rg('rngTzdiffZeroW', '线粗细', 'style.fill.tzdiff.zero.w', 10, 300, 1, 'outTzdiffZeroW', 'lwRel', 'lwX'),
              cl('clrTzdiffZero', '线颜色', 'style.fill.tzdiff.zero.color', 'hexTzdiffZero'),
              rg('rngTzdiffZeroOp', '透明度', 'style.fill.tzdiff.zero.op', 0, 100, 1, 'outTzdiffZeroOp', 'lin01', 'pct'),
              G('类型', [
                rg('rngTzdiffZeroN', '虚线密度', 'style.fill.tzdiff.zero.n', 10, 200, 1, 'outTzdiffZeroN', 'int1', 'raw'),
                rg('rngTzdiffZeroRatio', '虚实比', 'style.fill.tzdiff.zero.ratio', 20, 90, 1, 'outTzdiffZeroRatio', 'lin01', 'pct'),
              ], { ctl: sl('selTzdiffZeroDash', '类型', 'style.fill.tzdiff.zero.dash', DASH_OPTS), dash: 'tzdiffzero' }),
            ], { sw: 'cbTzdiffZero', swPath: 'tzdiff.zero.on', gate: 'tzdiff.on' }),
            G('新的一天', [
              cl('clrTzdiffNew', '填充颜色', 'style.fill.tzdiff.newFill', 'hexTzdiffNew'),
              rg('rngTzdiffNewOp', '填充透明度', 'style.fill.tzdiff.newOp', 0, 100, 1, 'outTzdiffNewOp', 'lin01', 'pct'),
            ], { sw: 'cbTzdiffNew', swPath: 'tzdiff.newDay.on', gate: 'tzdiff.on' }),
            G('旧的一天', [
              cl('clrTzdiffOld', '填充颜色', 'style.fill.tzdiff.oldFill', 'hexTzdiffOld'),
              rg('rngTzdiffOldOp', '填充透明度', 'style.fill.tzdiff.oldOp', 0, 100, 1, 'outTzdiffOldOp', 'lin01', 'pct'),
            ], { sw: 'cbTzdiffOld', swPath: 'tzdiff.oldDay.on', gate: 'tzdiff.on' }),
            sep(),
            G('文字注释', [
              noteGrp('中时区', 'tzdiffTz0', 'ncTzdiffTz0', 'cbTzdiffNoteTz0', 'note.master.on,tzdiff.on', 'tzdiff.note.tz0'),
              noteGrp('国际日期变更线', 'tzdiffIdl', 'ncTzdiffIdl', 'cbTzdiffNoteIdl', 'note.master.on,tzdiff.on', 'tzdiff.note.idl'),
              noteGrp('0°时刻所在经线', 'tzdiffZero', 'ncTzdiffZero', 'cbTzdiffNoteZero', 'note.master.on,tzdiff.on', 'tzdiff.note.zero'),
              noteGrp('新的一天', 'tzdiffNew', 'ncTzdiffNew', 'cbTzdiffNoteNew', 'note.master.on,tzdiff.on', 'tzdiff.note.newDay'),
              noteGrp('旧的一天', 'tzdiffOld', 'ncTzdiffOld', 'cbTzdiffNoteOld', 'note.master.on,tzdiff.on', 'tzdiff.note.oldDay'),
            ], { sw: 'cbTzdiffNote', swPath: 'tzdiff.note.on', gate: 'note.master.on,tzdiff.on' }),
            tip('0°时刻所在经线 = 太阳直射点所在经线 + 180°，与「地方时刻」标注同源 —— ' +
                '它自东向西扫过地球：该经线向东到 180° 经线为新的一天，向西到 180° 经线为旧的一天。' +
                '「新的一天 / 旧的一天」两块范围面随时刻移动，二者宽度之和恒为 360°。'),
          ]
        },
      ]
    },

    /* ---------------- 三、公转系统 ---------------- */
    {
      id: 'sOrbit', icon: '🛰️', name: '公转系统', sub: '示意比例 · 椭圆轨道 · 节气标记 · 公转速度 · 注释',
      children: [
        {
          id: 'pOrbBody', icon: '🪐', name: '天体与轨道', sw: 'cbOrbOrbit', swTip: '显示公转轨道', children: [
            use('rngEarthScale', '地球大小'),
            use('rngSunScale', '太阳大小'),
            use('rngDistScale', '日地距离'),
            G('公转轨道', [
              lwCtl('rngOrbOrbitW', '线粗细', 'style.ln.orbit.w', 'outOrbOrbitW'), use('clrOrbOrbit', '线颜色'), use('rngOrbOrbitOp', '透明度'),
              G('类型', [
                rg('rngOrbOrbitN', '虚线密度', 'style.ln.orbit.n', 10, 200, 1, 'outOrbOrbitN', 'int1', 'raw'),
                rg('rngOrbOrbitRatio', '虚实比', 'style.ln.orbit.ratio', 20, 90, 1, 'outOrbOrbitRatio', 'lin01', 'pct'),
              ], { ctl: sl('selOrbOrbitDash', '类型', 'style.ln.orbit.dash', DASH_OPTS), dash: 'orbit' }),
            ], { gate: 'orb.orbit.on' }),
            // v29（需求⑦）：公转轨道椭圆离心率（0–1）滑块 —— 默认取地球真实离心率；
            //   另提供「圆（离心率0）」「地球真实离心率」两个一键默认。
            G('轨道离心率', [
              // v29（需求⑦）：轨道离心率滑块 —— 0（正圆）~1（极端扁）；滑块单位 = 离心率 ×10000
              //   （map=w10000，1 格 = 0.0001），与右侧 raw4 读数同粒度
              rg('rngOrbEcc', '离心率 e', 'orb.ecc', 0, 10000, 1, 'outOrbEcc', 'w10000', 'raw4'),
              raw('<div class="btn-row">'
                + '<button class="btn xs" id="btnOrbEcc0">圆（离心率0）</button>'
                + '<button class="btn xs" id="btnOrbEccReal">地球真实离心率</button>'
                + '</div>'),
            ], { gate: 'orb.orbit.on' }),
            sep(),
            // v21.0（需求⑥）：「公转轨道」名称注释补上独立控制 ——
            //   显隐复选框 + 字号 / 字体 / 颜色 / 透明度 / 字重，与其它注释完全一致。
            noteGrp('公转轨道注释', 'orbit', 'ncOrbit', 'ncOrbitOn', 'note.master.on,orb.orbit.on'),
          ]
        },
        {
          id: 'pOrbTerms', icon: '🗓️', name: '二十四节气', sw: 'cbTermsOn', swPath: 'terms.on',
          swTip: '显示二十四节气位置标记', children: [
            G('二分二至位置', [
              use('rngTermsSize', '点大小'), use('clrTerms', '点颜色'),
              rg('rngTermsOp', '透明度', 'style.pt.term.op', 0, 100, 1, 'outTermsOp', 'lin01', 'pct'),
            ], { sw: 'cbOrbTerms', gate: 'terms.on' }),
            G('其余节气位置', [
              use('rngT24Size', '点大小'), use('clrT24', '点颜色'),
              rg('rngT24Op', '透明度', 'style.pt.term24.op', 0, 100, 1, 'outT24Op', 'lin01', 'pct'),
            ], { sw: 'cbOrbTerms24', gate: 'terms.on' }),
            sep(),
            // v21.0（需求③）：节气位置标记 → 该组标记是否显示 → 该组文字注释
            G('文字注释', [
              /* ★ v52（需求三）：二分二至「显示日期」开关从「二分二至位置」组迁入本注释组 ——
                 它与该组注释文字同属「二分二至」这一语义单元，逻辑上放在一起。
                 state 键（orb.terms.date）与绑定方式（bindMenuLeaf，按 path）均未改动。 */
              noteGrp('二分二至', 'terms', 'ncTerms', 'ncTermsOn', 'note.master.on,orb.terms.on', null, [
                sw('cbTermsDate', '显示日期（另起一行）', 'orb.terms.date', 'terms.on'),
              ]),
              noteGrp('其余节气', 'terms24', 'ncTerms24', 'ncTerms24On',
                      'note.master.on,orb.terms24.on'),
            ], { sw: 'cbTermsNote', swPath: 'termsNote.on', gate: 'note.master.on,terms.on' }),
          ]
        },
        {
          /* ===================================================================
             v28（需求③）：公转速度 —— 开普勒第二定律（等面积速率）的完整演示
             -------------------------------------------------------------------
             把「近日点快、远日点慢」落到轨道平面上一眼看懂的三件事：
               ① 近日点 / 远日点位置标注（含距离与到达日期）；
               ② 单位时间内太阳与地球连线**扫过的面积**（扇形）—— 按可配置的时间步长 Δt，
                  在「当前时刻 / 近日点 / 远日点」各画一个：三者面积严格相等，而张角与弧长
                  明显不同（近日点又短又宽、远日点又长又窄），这就是等面积速率；
               ③ 面积速度 dA/dt 读数 —— 它恒定不变，是开普勒第二定律的直接表述。
             显示开关 / 颜色 / 时间步长 / 文字标注 全部可设置（面积单位已移除，面积速度读数固定 km²/日）。
             =================================================================== */
          id: 'pOrbSpeed', icon: '⏱️', name: '公转速度', sw: 'cbSpdOn', swPath: 'spd.on',
          swTip: '显示单位时间内扫过的面积（开普勒第二定律）与近日点 / 远日点位置',
          children: [
            /* v29（需求①）：将「时间步长」与「扫过的面积」合并为统一菜单，并新增总开关
               spd.area 统一控制扇形显隐；去掉面积单位、去掉时间步长预设与默认值。 */
            G('等面积速率演示', [
              sw('cbSpdArea', '显示扫过面积（总开关）', 'spd.area', 'spd.on'),
              rg('rngSpdDt', '时间步长 Δt', 'spd.dt', 25, 6000, 1, 'outSpdDt', 'w100', 'day'),
              sep(),
              sw('cbSpdCur', '当前时刻的扇形', 'spd.cur', 'spd.on,spd.area'),
              sw('cbSpdRef', '近日点 / 远日点对比扇形', 'spd.ref', 'spd.on,spd.area'),
              cl('clrSpdFill', '当前扇形填充色', 'style.fill.spd.fill', 'hexSpdFill'),
              rg('rngSpdOp', '填充透明度', 'style.fill.spd.op', 0, 100, 1, 'outSpdOp', 'lin01', 'pct'),
              cl('clrSpdRefFill', '对比扇形填充色', 'style.fill.spd.refFill', 'hexSpdRefFill'),
              rg('rngSpdRefOp', '对比扇形透明度', 'style.fill.spd.refOp', 0, 100, 1, 'outSpdRefOp', 'lin01', 'pct'),
              sep(),
              cl('clrSpdLine', '扇形边界线色', 'style.ln.spd.color', 'hexSpdLine'),
              rg('rngSpdLineOp', '边界线透明度', 'style.ln.spd.op', 0, 100, 1, 'outSpdLineOp', 'lin01', 'pct'),
              // 扇形边界线用 LineDashedMaterial 绘制（WebGL 下线宽恒为 1px，故不设「线粗细」）
              G('类型', [
                rg('rngSpdLineN', '虚线密度', 'style.ln.spd.n', 10, 200, 1, 'outSpdLineN', 'int1', 'raw'),
                rg('rngSpdLineRatio', '虚实比', 'style.ln.spd.ratio', 20, 90, 1, 'outSpdLineRatio', 'lin01', 'pct'),
              ], { ctl: sl('selSpdLineDash', '类型', 'style.ln.spd.dash', DASH_OPTS), dash: 'spd' }),
            ], { gate: 'spd.on' }),
            G('近日点与远日点', [
              sw('cbSpdApsis', '显示位置标记', 'spd.apsis', 'spd.on'),
              cl('clrApsis', '点颜色', 'style.pt.apsis.color', 'hexApsis'),
              // v29（需求⑤）：点大小改为倍率（默认 1.0，与二分二至标记半径一致）
              //   单位同其余「点大小」滑块：滑块值 = 倍率 ×100（map=w100）→ 0.2~4.0
              rg('rngApsisSize', '点大小', 'style.pt.apsis.size', 20, 400, 1, 'outApsisSize', 'w100', 'x'),
              rg('rngApsisOp', '透明度', 'style.pt.apsis.op', 0, 100, 1, 'outApsisOp', 'lin01', 'pct'),
              sep(),
              /* v29（需求⑤）：位置标注拆分为「名称 / 日期 / 日地距离」三部分 ——
                 名称默认优先显示；日期与日地距离可选择性另起一行显隐。 */
              sw('cbApsisName', '显示名称', 'spd.apsisName', 'spd.on,spd.apsis'),
              sw('cbApsisDate', '显示日期（另起一行）', 'spd.apsisDate', 'spd.on,spd.apsis'),
              sw('cbApsisDist', '显示日地距离（另起一行）', 'spd.apsisDist', 'spd.on,spd.apsis'),
            ], { gate: 'spd.on' }),
            sep(),
            // v29（需求①⑤）：位置标注沿用 spd 分类（仅控制远日点 / 近日点名称标注的样式）
            noteGrp('位置标注样式', 'spd', 'ncSpd', 'ncSpdOn', 'note.master.on,spd.on,spd.apsis'),
            tip('开普勒第二定律（等面积速率）：太阳与地球的连线在相等时间内扫过相等的面积。'
              + '调节「时间步长」即可验证 —— 同一个 Δt 下，近日点处的扇形又短又宽、'
              + '远日点处的又长又窄，但三个扇形标注里的面积数字完全相同；面积速度 dA/dt 恒为常数（已移至时间面板）。'
              + '近日点每年 1 月初到达（约 1.4710 亿 km，公转线速度 30.29 km/s、角速度 1.019°/日），'
              + '远日点 7 月初（约 1.5207 亿 km，29.29 km/s、0.954°/日）。'),
          ]
        },
        {
          id: 'pOrbObliq', icon: '📐', name: '黄赤交角', sw: 'cbPlanes', swPath: 'orb.planes.on',
          swTip: '显示黄道面与赤道面', children: [
            G('黄道面', [
              rg('rngEclR', '填充半径', 'style.fill.ecl.r', 20, 200, 1, 'outEclR', 'w100', 'x'),
              use('clrEcl', '填充颜色'),
              use('rngEclOp', '透明度'),
            ], { sw: 'cbPlaneEcl', gate: 'orb.planes.on' }),
            G('赤道面', [
              rg('rngEquR', '填充半径', 'style.fill.equ.r', 20, 200, 1, 'outEquR', 'w100', 'x'),
              use('clrEqu', '填充颜色'),
              use('rngEquOp', '透明度'),
            ], { sw: 'cbPlaneEqu', gate: 'orb.planes.on' }),
            G('黄赤交角控制', [
              use('rngObliq', '黄赤交角'),
              // v23.14：一键回到默认值 23°26′（= 23.4333…°，课标/天文真值）
              raw('<div class="btn-row"><button class="btn xs" id="btnObliqReset">重置为 23°26′</button></div>'),
            ]),
            sep(),
            // v21.0（需求⑧）：黄道面 / 赤道面的「名称标注」严格跟着「面本身是否显示」走 ——
            //   面关 → 名称标注一并置灰禁用；面开 → 名称标注开关才可用（三级层级）。
            G('文字注释', [
              noteGrp('黄道面', 'ecl', 'ncEcl', 'ncEclOn', 'note.master.on,orb.planes.ecl'),
              noteGrp('赤道面', 'equ', 'ncEqu', 'ncEquOn', 'note.master.on,orb.planes.equ'),
            ], { sw: 'cbObliqNote', swPath: 'obliqNote.on', gate: 'note.master.on,orb.planes.on' }),
          ]
        },
      ]
    },

    /* ---------------- 四、观测·标记·演示（v26.1 需求①）----------------
       它的两个二级菜单（观测点定位 / 数据面板）整体并入「标记演示」，该一级菜单随之
       更名为「观测·标记·演示」—— 观测点、标记点、小人模型、球面最短距离 四件事
       都是「在地球上取一个点 / 放一样东西」的同类操作，放在一处更好找。 */
    {
      id: 'sPts', icon: '📌', name: '地球运动观测',
      sub: '观测点 · 标记点 · 小人模型 · 球面最短距离',
      children: [
        {
          id: 'pMonLoc', icon: '📍', name: '观测点定位', sw: 'cbMonCircle', swTip: '显示观测点所在纬线圈', children: [
            G('预设点', [
              raw('<div class="btn-row">'
                + '<button class="btn xs" data-mon="beijing" data-lat="39.9" data-lon="116.4">北京</button>'
                + '<button class="btn xs" data-mon="taiyuan" data-lat="37.87" data-lon="112.55">太原</button>'
                + '<button class="btn xs" data-mon="london" data-lat="51.51" data-lon="-0.13">伦敦</button>'
                + '<button class="btn xs" id="btnMonClear">清除</button></div>'),
              G('自定义', [
                use('inMonLat', '纬度'), use('inMonLon', '经度'),
                raw('<div class="btn-row"><button class="btn xs" id="btnMonCustom">应用</button></div>'),
              ]),
            ]),
            // v20.0：昼弧 / 夜弧「线粗细」与上方「纬线圈宽度」用同一量纲（都是这条纬线圈带的角宽度，
            //        单位 °）。原先两者写入同一个字段却相差 1000 倍量纲 —— 一拖滑杆圆弧就被压成
            //        0.02° 宽而「消失」，这里统一为 0.20°–4.00°。
            G('纬线圈昼夜弧', [
              lwCtl('rngMonW', '线粗细', 'style.ln.monDay.w', 'outMonW'),
              // v21.0（需求⑨）：昼弧 / 夜弧补「类型」（实线 / 虚线），默认实线；
              //   选虚线后「虚线密度 / 虚实比」才可调（实线时自动置灰禁用）。
              G('昼弧', [
                rg('rngMonDayW', '线粗细', 'style.ln.monDay.w', 10, 300, 1, 'outMonDayW', 'lwRel', 'lwX'),
                use('clrMonDay', '线颜色'), use('rngMonDayOp', '透明度'),
                G('类型', [
                  rg('rngMonDayN', '虚线密度', 'style.ln.monDay.n', 10, 200, 1, 'outMonDayN', 'int1', 'raw'),
                  rg('rngMonDayRatio', '虚实比', 'style.ln.monDay.ratio', 20, 90, 1, 'outMonDayRatio', 'lin01', 'pct'),
                ], { ctl: sl('selMonDayDash', '类型', 'style.ln.monDay.dash', DASH_OPTS), dash: 'monDay' }),
              ], { sw: 'cbMonDay', swPath: 'mon.day' }),
              G('夜弧', [
                rg('rngMonNightW', '线粗细', 'style.ln.monNight.w', 10, 300, 1, 'outMonNightW', 'lwRel', 'lwX'),
                use('clrMonNight', '线颜色'), use('rngMonNightOp', '透明度'),
                G('类型', [
                  rg('rngMonNightN', '虚线密度', 'style.ln.monNight.n', 10, 200, 1, 'outMonNightN', 'int1', 'raw'),
                  rg('rngMonNightRatio', '虚实比', 'style.ln.monNight.ratio', 20, 90, 1, 'outMonNightRatio', 'lin01', 'pct'),
                ], { ctl: sl('selMonNightDash', '类型', 'style.ln.monNight.dash', DASH_OPTS), dash: 'monNight' }),
              ], { sw: 'cbMonNight', swPath: 'mon.night' }),
            ], { gate: 'mon.circle' }),
            G('点击标记', [use('rngMarkerSize', '点大小'), use('clrMarker', '点颜色')]),
          ]
        },
        {
          id: 'pMonPanel', icon: '📊', name: '数据面板', children: [
            use('piPos', '位置（纬度 / 经度）'),
            use('piLst', '地方时'),
            use('piTerm', '节气'),
            use('piDaylen', '当地昼长'),
            use('piTz', '时区（区名 + UTC偏移 + 区时）'),
            use('piSub', '太阳直射点（经纬度）'),
            use('piSr', '日出 / 日落时刻与方位'),
            use('piSraz', '日出日落方位角（数值）'),
            use('piNoon', '正午太阳高度'),
            use('piYear', '全年昼长极值（极大值与极小值）'),
            use('piCurve', '全年昼长曲线'),
            /* v28（需求④）：该点随地球自转的线速度 / 角速度 —— 默认隐藏。
               线速度随纬度余弦衰减（赤道 465.1 m/s → 极点 0），角速度处处相同（15.0411 °/h）。 */
            use('piSpinV', '自转线速度（随纬度变化）'),
            use('piSpinW', '自转角速度（处处相同）'),
          ]
        },
        {
          id: 'pPtsAdd', icon: '📍', name: '标记点', sw: 'cbPtsShow', swTip: '显示标记点', children: [
            use('cbAddMode', '标记模式'),
            use('cbPtsSnap', '吸附到经纬网上'),
            G('点样式', [use('rngPtSize', '点大小'), use('clrPtColor', '点颜色')], { gate: 'points.show' }),
            sep(),
            noteGrp('文字注释（A、B、C等）', 'pts', 'ncPts', 'ncPtsOn', 'note.master.on,points.show'),
            G('标注列表', [
              raw('<div id="ptList" class="pt-list"></div>'),
              raw('<div class="btn-row"><button class="btn xs" id="btnPtsClear">清空全部点</button></div>'),
            ]),
          ]
        },
        {
          /* v27.0（需求一）：标记文本 —— 在地球表面放置可编辑的文字注释框。
             · 拖拽卡片：按住文本框拖到地球表面 → 松开即放置（可选吸附经纬网），未落表面不创建；
             · 文本框吸附地表、随球旋转缩放并保持相对位置与朝向（锚定球面，非朝向相机的广告牌）；
             · 框体样式（尺寸 / 填充色与透明度 / 描边色与宽 / 圆角）有默认并支持整体与逐实例自定义；
             · 点击或双击编辑文本，失焦或确认保存，空文本删除 / 隐藏，按内容自适应尺寸；
             · 文字默认继承「全局文字注释样式」（字体 / 字号 / 颜色 / 字重 / 对齐），仅显式覆盖时
               保留自定义值，全局变更同步未覆盖实例；增删改查、选中、显隐、持久化一应俱全。 */
          id: 'pMarkText', icon: '🏷️', name: '标记文本', sw: 'cbMarkText', swPath: 'markText.on',
          swTip: '显示标记文本（开＝进入文本标记模式）', children: [
            raw('<div class="fig-drag" id="mtDrag" title="按住拖到地球表面放置">'
              + '<span class="fig-ico mt-ico"></span>'
              + '<span class="fig-t"><b>拖动文本框到地球表面</b>'
              + '<span>按住这里拖到地球上，松开即放置（拖动时会在地球上预览落点）</span></span>'
              + '</div>'),
            G('框体样式', [
              /* v27.1（需求①）：宽 / 高可调下限 0.001（thousandth 缩放：滑条 1 格 = 0.001），
                 描边宽度调到 0 = 隐藏边框 */
              rg('rngMtW', '宽度', 'markText.box.w', 1, 1400, 1, 'outMtW', 'thousandth', 'x'),
              rg('rngMtH', '高度', 'markText.box.h', 1, 800, 1, 'outMtH', 'thousandth', 'x'),
              cl('clrMtFill', '填充色', 'markText.box.fill', 'hexMtFill'),
              rg('rngMtFillOp', '填充透明度', 'markText.box.fillOp', 0, 100, 1, 'outMtFillOp', 'lin01', 'pct'),
              cl('clrMtStroke', '描边色', 'markText.box.stroke', 'hexMtStroke'),
              rg('rngMtStrokeW', '描边宽度', 'markText.box.strokeW', 0, 40, 1, 'outMtStrokeW', 'w100', 'x'),
              rg('rngMtRadius', '圆角', 'markText.box.radius', 0, 40, 1, 'outMtRadius', 'w100', 'x'),
            ], { gate: 'markText.on' }),
            noteGrp('文字样式（默认继承全局，可独立覆盖）', 'markText', 'ncMarkText', 'ncMarkTextOn', 'note.master.on,markText.on'),
            sw('cbMtSnap', '放置时吸附到经纬网上', 'markText.snap'),
            sep(),
            G('已放置的文本', [
              raw('<div id="mtList" class="pt-list"></div>'),
              raw('<div class="btn-row"><button class="btn xs" id="btnMtClear">清空全部文本</button></div>'),
            ]),
            tip('点击已放置的文本框即可编辑文字；留空则自动删除。框体 / 文字样式在上方统一设置，'
              + '选中某条后上方控件改为编辑该条（单独自定义）。描边宽度调到 0 即隐藏边框。'),
          ]
        },
        {
          /* v25.1（需求⑥）：小人模型演示
             · 拖拽卡片：按住小人拖到地球表面 → 松开即放置（可选吸附经纬网）；
             · 小人钉在地表随地球一起运动，身高 / 颜色 / 透明度可调；
             · 影子按当前太阳方向实时解算：朝向 = 太阳水平投影的反方向、
               长度随太阳高度角变化（太阳低 → 影子长；夜晚不画影子）。 */
          id: 'pFigure', icon: '🧍', name: '小人模型', sw: 'cbFigure', swPath: 'figure.on',
          swTip: '显示小人模型', children: [
            raw('<div class="fig-drag" id="figDrag" title="按住拖到地球表面放置">'
              + '<span class="fig-ico"></span>'
              + '<span class="fig-t"><b>拖动小人到地球表面</b>'
              + '<span>按住这里拖到地球上，松开即放置（拖动时会在地球上预览落点）</span></span>'
              + '</div>'),
            G('小人样式', [
              rg('rngFigSize', '身高', 'style.pt.figure.size', 10, 300, 1, 'outFigSize', 'thousandth', 'raw3'),
              cl('clrFigure', '颜色', 'style.pt.figure.color', 'hexFigure'),
              rg('rngFigOp', '透明度', 'style.pt.figure.op', 0, 100, 1, 'outFigOp', 'lin01', 'pct'),
            ], { gate: 'figure.on' }),
            G('太阳光照阴影', [
              sw('cbFigShadow', '显示影子', 'style.ln.figShadow.on', 'figure.on'),
              rg('rngFigShadowW', '影宽', 'style.ln.figShadow.w', 20, 400, 1, 'outFigShadowW', 'w100', 'x'),
              cl('clrFigShadow', '影子颜色', 'style.ln.figShadow.color', 'hexFigShadow'),
              rg('rngFigShadowOp', '透明度', 'style.ln.figShadow.op', 0, 100, 1, 'outFigShadowOp', 'lin01', 'pct'),
              rg('rngFigShadowSoft', '边缘柔和度', 'style.ln.figShadow.soft', 0, 100, 1, 'outFigShadowSoft', 'lin01', 'pct'),
            ], { gate: 'figure.on' }),
            /* v27.3（需求）：脚下的「东南西北」方位箭头 ——
               · 四个箭头自脚底向外铺开，分别指向**当地**正东 / 正南 / 正西 / 正北，
                 与经纬网严格对应（随小人落点变化，不是画面上的固定指向）；
               · 箭头样式（长度 / 杆宽 / 箭头占比 / 颜色 / 透明度）可调，
                 长度与宽度均以「小人身高」为基准 —— 改身高时箭头等比跟随；
               · N / S / W / E 文字注释可单独显隐，字体 / 字号 / 颜色 / 字重 / 透明度独立可调，
                 每个字母落在对应箭尖外侧，与箭头一一匹配；
               · 本组自成体系（独立于「全局文字注释」，不受其总开关与统一设置影响）。 */
            G('方位箭头（脚下 · 东南西北）', [
              sw('cbFigDir', '显示方位箭头', 'figure.dir.on', 'figure.on'),
              sw('cbFigDirText', '显示 N / S / W / E 文字', 'figure.dir.text', 'figure.on,figure.dir.on'),
              G('箭头样式', [
                rg('rngFigDirLen', '长度', 'style.pt.figDir.len', 20, 400, 1, 'outFigDirLen', 'w100', 'x'),
                rg('rngFigDirW', '杆宽', 'style.pt.figDir.w', 2, 80, 1, 'outFigDirW', 'w100', 'x'),
                rg('rngFigDirHead', '箭头占比', 'style.pt.figDir.head', 5, 70, 1, 'outFigDirHead', 'lin01', 'pct'),
                cl('clrFigDir', '箭头颜色', 'style.pt.figDir.color', 'hexFigDir'),
                rg('rngFigDirOp', '透明度', 'style.pt.figDir.op', 0, 100, 1, 'outFigDirOp', 'lin01', 'pct'),
              ], { gate: 'figure.on,figure.dir.on' }),
              G('文字样式（N / S / W / E）', [
                rg('rngFigDirTextSize', '字号', 'style.pt.figDir.text.size', 20, 1500, 1, 'outFigDirTextSize', 'thousandth', 'x'),
                sl('selFigDirTextFont', '字体', 'style.pt.figDir.text.font', FONT_OPTS),
                cl('clrFigDirText', '颜色', 'style.pt.figDir.text.color', 'hexFigDirText'),
                rg('rngFigDirTextOp', '透明度', 'style.pt.figDir.text.op', 0, 100, 1, 'outFigDirTextOp', 'lin01', 'pct'),
                sl('selFigDirTextWeight', '字重', 'style.pt.figDir.text.weight', WEIGHT_OPTS),
              ], { gate: 'figure.on,figure.dir.on,figure.dir.text' }),
              tip('箭头长度 / 杆宽 / 字号均为「小人身高的倍率」—— 改身高时箭头与文字等比跟随；'
                + '字号 = 字母的墨迹高度。方向取自当地地理方位：正北沿经线指北极、正东沿纬线指东，'
                + '因此箭头永远与经纬网对齐，换到南北极附近也依然成立。'),
            ], { gate: 'figure.on' }),
            sw('cbFigSnap', '放置时吸附到经纬网上', 'figure.snap'),
            sep(),
            G('已放置的小人', [
              raw('<div id="figList" class="pt-list"></div>'),
              raw('<div class="btn-row"><button class="btn xs" id="btnFigClear">清空全部小人</button></div>'),
            ]),
            tip('影子由当前太阳方向实际解算：朝向 = 太阳方向的球面水平分量反向，'
              + '长度由「过小人的平行光线与球面的交点」求出 —— 太阳越低影子越长，'
              + '正午最短；太阳落到地平线以下（当地夜晚）不画影子，日出日落前后影子被晨昏线截断。'),
          ]
        },
        {
          /* v25.1（需求⑧）：球面最短距离（大圆劣弧）——
             · 勾选总开关即进入测量状态，三种取点方式：点击拾取 / 选取标记点 / 输入经纬度；
             · 两点确定后标注球面最短距离（单位自适应米 / 千米）与两端点经纬度；
             · 同时绘制过这两点的**完整大圆环线**与两点间的**劣弧线段**（二者共用同一条大圆，
               视觉上一粗一细、一实一虚，明确区分）；
             · 大圆 / 劣弧的线段属性各自可配：颜色 / 线宽 / 透明度 / 是否贴地夹持地形 /
               虚线样式（类型 · 虚线密度 · 虚实比）；
             · 重合点、对跖点（大圆不唯一）等边界情况在面板里直接给出提示。 */
          id: 'pGCD', icon: '📏', name: '球面最短距离', sw: 'cbGCD', swPath: 'gcd.on',
          swTip: '显示球面最短距离（开＝进入标记模式）', children: [
            G('测量方式', [
              sl('selGcdMode', '取点方式', 'gcd.mode',
                 [['click', '点击地球拾取'], ['marker', '从标记点选取'], ['input', '输入经纬度']]),
              raw(GCD_PANEL),
            ], { gate: 'gcd.on' }),
            G('测量结果', [raw(GCD_RESULT)], { gate: 'gcd.on' }),
            sep(),
            G('大圆环线（完整一圈）', [
              rg('rngGcdRingW', '线宽', 'style.ln.gcdRing.w', 10, 300, 1, 'outGcdRingW', 'lwRel', 'lwX'),
              cl('clrGcdRing', '颜色', 'style.ln.gcdRing.color', 'hexGcdRing'),
              rg('rngGcdRingOp', '透明度', 'style.ln.gcdRing.op', 0, 100, 1, 'outGcdRingOp', 'lin01', 'pct'),
              sw('cbGcdRingDrape', '贴地夹持地形', 'style.ln.gcdRing.drape'),
              G('类型', [
                rg('rngGcdRingN', '虚线密度', 'style.ln.gcdRing.n', 10, 200, 1, 'outGcdRingN', 'int1', 'raw'),
                rg('rngGcdRingRatio', '虚实比', 'style.ln.gcdRing.ratio', 20, 90, 1, 'outGcdRingRatio', 'lin01', 'pct'),
              ], { ctl: sl('selGcdRingDash', '类型', 'style.ln.gcdRing.dash', DASH_OPTS), dash: 'gcdring' }),
            ], { sw: 'cbGcdRing', swPath: 'gcd.ring.on', gate: 'gcd.on' }),
            G('最短弧线（劣弧）', [
              rg('rngGcdArcW', '线宽', 'style.ln.gcdArc.w', 10, 300, 1, 'outGcdArcW', 'lwRel', 'lwX'),
              cl('clrGcdArc', '颜色', 'style.ln.gcdArc.color', 'hexGcdArc'),
              rg('rngGcdArcOp', '透明度', 'style.ln.gcdArc.op', 0, 100, 1, 'outGcdArcOp', 'lin01', 'pct'),
              sw('cbGcdArcDrape', '贴地夹持地形', 'style.ln.gcdArc.drape'),
              G('类型', [
                rg('rngGcdArcN', '虚线密度', 'style.ln.gcdArc.n', 10, 200, 1, 'outGcdArcN', 'int1', 'raw'),
                rg('rngGcdArcRatio', '虚实比', 'style.ln.gcdArc.ratio', 20, 90, 1, 'outGcdArcRatio', 'lin01', 'pct'),
              ], { ctl: sl('selGcdArcDash', '类型', 'style.ln.gcdArc.dash', DASH_OPTS), dash: 'gcdarc' }),
            ], { sw: 'cbGcdArc', swPath: 'gcd.arc.on', gate: 'gcd.on' }),
            sep(),
            G('文字注释', [
              noteGrp('距离标注（含两点经纬度）', 'gcdDist', 'ncGcdDist', 'cbGcdNoteDist',
                      'note.master.on,gcd.on', 'gcd.note.dist'),
              noteGrp('端点标注（A / B）', 'gcdEnd', 'ncGcdEnd', 'cbGcdNoteEnd',
                      'note.master.on,gcd.on', 'gcd.note.end'),
            ], { sw: 'cbGcdNote', swPath: 'gcd.note.on', gate: 'note.master.on,gcd.on' }),
            tip('球面最短距离 = 过两点的大圆**劣弧**长度，也就是球面上两点的最短路径 —— ' +
                '按地球平均半径 6371 km 换算，距离不足 1 km 时自动改用「米」。' +
                '洋红粗线是劣弧本身，青色虚线是它所在的整条大圆：两条线严格共用同一条大圆' +
                '（同一个解算结果），因此两个端点必然同时落在两条线上。' +
                '两点重合（距离 ≈ 0）时大圆不唯一、两点互为对跖点（相距 180°）时大圆有无穷多条，' +
                '这两种情况都会在状态行里明确提示。文字注释同样受「全局文字样式」总开关控制，' +
                '关闭时数值仍完整显示在下面的结果区。'),
          ]
        },
      ]
    },

    /* ★ 本批次（需求五）：「全局文字样式」（含「面板文字样式设置」）已**移至右上角**
       「全局设置」浮层 —— #btnPanelMenu2 → sunview.js fillGlobalSettings，
       与「面板和悬浮窗」合成同一个入口；此处不再保留重复菜单项。
       数据仍是唯一一份 state.ui.panel.* / state.note.*（改任一侧另一侧即时跟随）。 */
    /* ★ 本批次（需求三）：地球侧「界面与主题」（色系 / 明暗模式 / 面板底色 / 文字颜色 /
       面板背景不透明度 / 毛玻璃模糊）已**整合进右上角「全局设置」面板**的「界面与主题」
       分区（#btnPanelMenu2 → sunview.js fillGlobalSettings），并从此处移除，避免重复入口。
       数据仍是唯一一份 state.ui.theme.*，两侧实时同步。 */
  ];

  /* =========================================================================
     渲染逻辑
     ====================================================================== */
  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* 控件定义：MENU 节点自带 > 收割表 */
  function specOf(n) {
    if (n.k) return n;
    var c = CTRLS[n.id] || {};
    /* ★ 缺配置嗅探：CTRLS 里没有该 id 时会静默退化成「开关」（k 默认 'sw'），
       这里给出告警但不改变返回值（保持向后兼容）。 */
    if (!c.k && !n.k) console.warn('[menu] CTRLS 缺少配置：', n.id);
    return {
      k: c.k || 'sw', id: n.id, name: n.name || c.label || n.id,
      min: c.min, max: c.max, step: c.step, out: c.out || null, hex: c.hex || null,
      opts: c.opts || null, dash: n.dash || c.dash || null, tzstripe: c.tzstripe || null,
      cls: c.cls || '', unit: c.unit || '', type: c.type || ''
    };
  }

  /* ---- 叶子控件 -> DOM ---- */
  function buildCtl(n) {
    var s = specOf(n), lb = esc(s.name || '');
    if (s.k === 'sw') {
      /* v26.1（需求⑫）：二级菜单标题前的开关没有文字标签（标题本身就是说明），
         因此把 name / tip 挂到 title 上，鼠标悬停即可知道它控制什么。 */
      var ttl = esc(s.tip || s.name || '');
      var swl = el('label', 'sw', '<input type="checkbox" id="' + s.id + '"' + (ttl ? ' title="' + ttl + '"' : '') + ' />'
        + '<span class="track"></span><span class="sw-label">' + lb + '</span>');
      /* ★ role="switch"：aria-checked 的同步由 app.js / sunview.js 的绑定器负责（见接口约定）。 */
      swl.setAttribute('role', 'switch');
      return swl;
    }
    var e;
    if (s.k === 'range') {
      var o = s.out ? '<output id="' + s.out + '" for="' + s.id + '"></output>' : '';
      e = el('div', 'row' + (s.dash ? ' dash-only' : ''),
        '<label>' + lb + '</label><input type="range" id="' + s.id + '" min="' + (s.min || 0)
        + '" max="' + (s.max || 100) + '" step="' + (s.step || 1) + '" />' + o);
    } else if (s.k === 'color') {
      var hx = s.hex ? '<span class="clr-hex" id="' + s.hex + '"></span>' : '';
      e = el('div', 'row', '<label>' + lb + '</label><input type="color" id="' + s.id + '" />' + hx);
    } else if (s.k === 'sel') {
      var op = (s.opts || []).map(function (p) {
        return '<option value="' + esc(p[0]) + '">' + esc(p[1]) + '</option>';
      }).join('');
      e = el('div', 'row', '<label>' + lb + '</label><select id="' + s.id + '">' + op + '</select>');
    } else if (s.k === 'num') {
      e = el('div', 'row', '<label>' + lb + '</label><input type="number" id="' + s.id
        + '" min="' + (s.min || '') + '" max="' + (s.max || '') + '" step="' + (s.step || '0.01')
        + '" /><span class="unit">' + esc(s.unit || '') + '</span>');
    } else if (s.k === 'btn') {
      e = el('div', 'btn-row', '<button class="' + (s.cls || 'btn xs') + '" id="' + s.id + '">' + lb + '</button>');
    } else {
      e = el('div', 'row', lb);
    }
    if (s.dash) e.setAttribute('data-dash', s.dash);
    if (s.tzstripe) e.setAttribute('data-tzstripe', '');
    return e;
  }

  /* ---- 三级及更深的节点 ---- */
  function buildNode(n, depth) {
    if (n.raw) return el('div', 'raw-blk', n.raw);
    if (n.tip != null && !n.children) return el('p', 'grp-tip', esc(n.tip));
    if (!n.children || !n.children.length) {                 // 无子级 -> 直接显示
      var leaf = buildCtl(n);
      if (n.gate) leaf.setAttribute('data-gate', n.gate);     // v21.0：受上级开关控制
      return leaf;
    }
    // v20.0：「类型」这类分组节点把自身的 dash 键下传给子级数值行 —— 子行据此获得 .dash-only，
    //        只有线型选中「虚线」时「虚线密度 / 虚实比」才可调（实线时置灰禁用）。
    /* ★ 不写回共享 MENU 模板：dash 只在本次渲染中通过浅拷贝下传，避免污染 MENU
       （MENU 还被 app.js 的 bindMenuTree(window.MENU) 消费，renderInto 可能被多次调用）。
       风格与 strokeGrp 的 Object.assign({dash:...}, c) 造副本一致。 */
    var kids = n.children;
    if (n.dash) kids = n.children.map(function (ch) {
      return (ch && ch.k === 'range' && !ch.dash) ? Object.assign({}, ch, { dash: n.dash }) : ch;
    });
    var d = el('div', 'nd d' + depth);
    if (n.gate) d.setAttribute('data-gate', n.gate);          // v21.0：受上级开关控制
    var head = el('div', 'nd-h');
    /* ★ .nd-h 为键盘可达的分组标题：role/tabindex/aria-expanded 在此声明；
       折叠态切换与 aria-expanded 的同步由 app.js / sunview.js 的事件委托负责（见接口约定）。 */
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    /* swTip 一并传给标题前的开关作 title（标题前开关无可见文字标签，靠 title 提供可读名）。 */
    if (n.sw) head.appendChild(buildCtl({ k: 'sw', id: n.sw, name: '', tip: n.swTip }));
    head.appendChild(el('span', 'nd-t', esc(n.name)));
    if (n.ctl) { var c = buildCtl(n.ctl); c.className += ' inline-ctl'; head.appendChild(c); }
    head.appendChild(el('i', 'ar', '▾'));
    d.appendChild(head);
    var body = el('div', 'nd-b');
    kids.forEach(function (c2) { if (c2.on === false) return; body.appendChild(buildNode(c2, depth + 1)); });
    d.appendChild(body);
    return d;
  }

  /* ---- 二级：右侧内容窗口 ---- */
  function buildFly(sec, node) {
    var f = el('div', 'opt-fly');
    f.id = node.id;
    /* ★ 浮层语义：与 index.html 静态 #flyPanelMenu2 的 role="menu" 对齐，动态浮层补 dialog + 可读名。 */
    f.setAttribute('role', 'dialog');
    f.setAttribute('aria-label', [sec.name, node.name].filter(Boolean).join(' › ') || '菜单');
    if (node.gate) f.setAttribute('data-gate', node.gate);
    var head = el('div', 'fly-head');
    /* v27.0（需求三.1）：二级菜单标题前开关与窗口顶部开关共存时，取消**窗口顶部总开关**，
       由标题前开关控制。此前（v20.0 / v26.1 需求⑫）浮层标题行最前面还有一个同状态的
       总开关（id = node.sw），与左侧菜单标题前那个开关构成「同一状态两处入口」；
       现在该开关只保留在左侧菜单标题前（它就是主开关，走 app.js 的通用绑定链），
       弹窗标题行只留标题与关闭按钮。 */
    head.appendChild(el('span', 'fly-t',
      esc(sec.icon + ' ' + sec.name + ' › ' + (node.icon ? node.icon + ' ' : '') + node.name)));
    var close = document.createElement('button'); close.className = 'fly-close'; close.type = 'button';
    close.setAttribute('aria-label', '隐藏'); close.title = '隐藏'; close.textContent = '×';
    head.appendChild(close);
    f.appendChild(head);
    node.children.forEach(function (c) { if (c.on === false) return; f.appendChild(buildNode(c, 3)); });
    /* ★ v40（需求一）：二级菜单浮层支持**拖拽调整尺寸**（8 向抓手），
       尺寸按 id 记忆在 state.ui.pmSize，内容随高度自适应（内部滚动），不出现空白区域。 */
    makeFlyResizable(f, node.id);
    return f;
  }

  /* ★ v40（需求一）：给二级菜单浮层加 8 向拉伸抓手。
     - 抓手类沿用主面板的 .pm-grip（同一套外观与光标）；
     - 宽度写内联 width、高度由 max-height 控制（浮层默认按内容自适应，拉伸后固定）；
     - 记忆写入 window.__pmSize（由 app.js 暴露 = state.ui.pmSize），随设置持久化。 */
  function makeFlyResizable(f, id) {
    if (!f || f.dataset.rsInit) return;
    f.dataset.rsInit = '1';
    var store = window.__pmSize;
    if (!store) return;             // app.js 尚未就绪（极早调用）→ 跳过，功能不受影响
    var lay = store[id] || (store[id] = {});
    if (lay.w) f.style.width = lay.w + 'px';
    if (lay.h) f.style.height = lay.h + 'px';
    var minW = 220, minH = 120;
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (d) {
      var gp = document.createElement('div');
      gp.className = 'pm-grip ' + d;
      f.appendChild(gp);
      var rs = false, sx = 0, sy = 0, sw = 0, sh = 0, sl = 0, st = 0;
      gp.addEventListener('pointerdown', function (e) {
        e.stopPropagation(); e.preventDefault();
        var r = f.getBoundingClientRect();
        rs = true; sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top;
        f.style.maxHeight = 'none';
        f.classList.add('pm-resizing');
        if (gp.setPointerCapture) { try { gp.setPointerCapture(e.pointerId); } catch (er) { } }
      });
      gp.addEventListener('pointermove', function (e) {
        if (!rs) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        var nw = sw, nh = sh;
        if (d.indexOf('e') >= 0) nw = Math.max(minW, sw + dx);
        if (d.indexOf('s') >= 0) nh = Math.max(minH, sh + dy);
        if (d.indexOf('w') >= 0) nw = Math.max(minW, sw - dx);
        if (d.indexOf('n') >= 0) nh = Math.max(minH, sh - dy);
        f.style.width = nw + 'px';
        f.style.height = nh + 'px';
      });
      var rstop = function () {
        if (!rs) return; rs = false; f.classList.remove('pm-resizing');
        f.style.maxHeight = '';        // 复原 CSS 的 max-height: inherit（pointerdown 时曾置 'none'）
        lay.w = f.offsetWidth; lay.h = f.offsetHeight;
        if (window.__persistUI) window.__persistUI();
      };
      gp.addEventListener('pointerup', rstop);
      gp.addEventListener('pointercancel', rstop);
      gp.addEventListener('lostpointercapture', rstop);
    });
  }

  /* ---- 一级 ---- */
  function buildSec(sec, host) {
    var d = el('div', 'opt-sec');
    d.id = sec.id;
    /* ★ v39（需求二·5）：一级菜单标题前也支持总开关（sec.sw + sec.swPath）——
       太阳视运动「观察与测量」的时间数据面板开关即用此渲染（原先只支持二级菜单标题前开关）。 */
    var secSw = sec.sw ? '<label class="sw mini" title="' + esc(sec.swTip || sec.name) + '">'
      + '<input type="checkbox" id="' + sec.sw + '" />'
      + '<span class="track"></span></label>' : '';
    /* ★ 一级菜单行由 <button> 改为 <div>：其内部嵌套了开关 <label>/<input>，
       button 内不允许可交互子内容（无效 HTML，且点击会冒泡到 button）。
       div + role/tabindex 语义等价；键盘 Enter/Space 激活与 aria-expanded 的同步
       由 app.js / sunview.js 的事件委托负责（见接口约定）。 */
    var lv1 = el('div', 'opt-row lv1' + (sec.sw ? ' has-sw' : ''),
      secSw + '<i class="opt-ico">' + esc(sec.icon) + '</i><span class="opt-txt"><span class="opt-t">'
      + esc(sec.name) + '</span><span class="opt-sub">' + esc(sec.sub || '') + '</span></span><i class="chev">›</i>');
    lv1.setAttribute('role', 'button');
    lv1.setAttribute('tabindex', '0');
    lv1.setAttribute('aria-expanded', 'false');
    d.appendChild(lv1);
    var wrap = el('div', 'lv2-wrap');
    (sec.children || []).forEach(function (n) {
      if (n.on === false) return;            // 需求4：框架未勾选(☐)的项不纳入最终菜单结构
      if (n.children && n.children.length) {
        /* v26.1（需求⑫）：二级菜单标题前的总开关 —— 不用打开弹窗就能直接开 / 关
           该菜单对应的地理事物（或功能 / 模式）。
           v27.0（需求三.1）：标题前开关与窗口顶部开关共存时取消**窗口顶部**那个 ——
           这里不再是「__m 镜像」，而是直接以 id = node.sw 承担主开关身份
           （app.js 的 bindSwitch / bindMenuTree 按此 id 绑定状态路径），
           镜像同步机制（data-mirror / bindMirrorSwitches）随之整体删除。 */
        var msw = n.sw ? '<label class="sw mini" title="' + esc(n.swTip || n.name) + '">'
          + '<input type="checkbox" id="' + n.sw + '" />'
          + '<span class="track"></span></label>' : '';
        var row = el('button', 'opt-row lv2-row' + (n.sw ? ' has-sw' : ''),
          msw + '<i class="opt-ico">' + (n.icon || '•') + '</i><span class="opt-txt"><span class="opt-t">'
          + esc(n.name) + '</span></span><i class="chev">›</i>');
        row.dataset.fly = n.id;
        wrap.appendChild(row);
        (host || wrap).appendChild(buildFly(sec, n));
      } else {
        wrap.appendChild(buildNode(n, 2));         // 无子级：直接显示在二级列表里
      }
    });
    d.appendChild(wrap);
    return d;
  }

  /* v30：把渲染逻辑抽成「可指定 导航容器 / 浮层宿主 / 菜单数据」的通用函数 ——
     太阳视运动模块（sunview.js）用它把自有菜单（太阳视运动设置 / 地面物体 / 光照与太阳光线）
     渲染成与「显示设置」完全同一套外观的折叠菜单，无需复制任何 DOM 代码。
     行为与原先完全一致（默认仍渲染 #optMenu + #flyHost + MENU）。 */
  function renderInto(navEl, hostEl, menu) {
    var nav = navEl || document.getElementById('optMenu');
    var host = hostEl || document.getElementById('flyHost');
    if (!nav) return null;
    nav.innerHTML = '';
    if (host) host.innerHTML = '';
    (menu || MENU).forEach(function (sec) { nav.appendChild(buildSec(sec, host)); });
    return { nav: nav, host: host };
  }
  function renderMenu() { return renderInto(null, null, MENU); }

  window.MENU = MENU;
  window.renderMenu = renderMenu;
  window.renderMenuInto = renderInto;
  /* 供外部菜单（sunview.js）构造同样的节点结构 */
  window.MENU_DSL = { G: G, use: use, rg: rg, cl: cl, sl: sl, sw: sw, tip: tip, raw: raw, sep: sep,
                      FONT_OPTS: FONT_OPTS, DASH_OPTS: DASH_OPTS, WEIGHT_OPTS: WEIGHT_OPTS,
                      UI_SCHEME_OPTS: UI_SCHEME_OPTS };
})();
