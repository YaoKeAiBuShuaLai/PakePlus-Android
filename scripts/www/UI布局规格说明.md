# UI 布局规格说明（可复用）

> 产品：**地理3D实验室——地球运动&太阳视运动（单页 Web 应用）**
> 用途：导出可被其他软件直接复用的 UI 布局规格（层级 / 尺寸 / 图层 / 状态 / 交互）
> 树形格式：component-tree（YAML / JSON 同构）；描述语言：简体中文

## 0. 元信息 / 缩放适配

- **基准分辨率**：<PLACEHOLDER: 产品源码未固化基准分辨率；应用为全窗口自适应（#gl/#svCanvas position:fixed inset:0），标题栏为固定高 78px·ui。建议标注为「设计基准视口 = 1280×720 或 1920×1080（待与作者确认）」>
- **缩放模型**：CSS 自定义属性乘子（css-custom-property-multiplier）
  - 公式：`--ui = (--uiW) × (--uiH)；所有像素尺寸 = 设计基准值 × --ui`
  - 声明但未启用：源码 :root 默认 --uiW:1; --uiH:1（即 --ui=1）。按视口尺寸驱动 --uiW/--uiH 的 JS 在当前 shipped 代码中未实现（仅 tools/_probe_overflow.js 测试桩出现）。
  - 实际自适应：实际自适应由 CSS @media 断点承担：源码含 @media 块在窄宽度（约 828px / 1100px 附近）调整标题栏内边距/间距/字号与换行。
  - 断点：<PLACEHOLDER: 需确认具体断点宽度与对应覆盖规则；源码 style.css 中 @media 位于约 line 678 / 827 / 1103 / 1146 / 1162 / 1331 等处>
- **主题**：body[data-mode="light"]（默认）| body[data-mode="dark"]；毛玻璃（backdrop-filter: blur），透明度由 --glass-head/--glass-fly/--glass-ctl 变量控制
- **圆角基准**：`--r = 14px × --ui（圆角统一基准，按钮/卡片/浮层共用）`
- **卡片内边距**：`--pad-x = 16px × --ui（卡片水平内边距；含 .card-head 的表头负 margin 抵消量需与之相等，否则左右留 1px 缝隙）`
- **字号/字重**：--ui-fs（倍率，默认 1；由「全局文字样式」滑块写入）；--ui-fw = 400（正文基准字重）；--ui-fw-m = 600（中粗：标题/分组名）；--ui-fw-b = 700/800（加粗：大标题/强调）

## 1. 顶部菜单栏

- 容器 `#titleBar`（`<header>`）：fixed; top:0; left:0; right:0；高 `78px × --ui（--tb-h）`；padding `0 20px × --ui（左右内边距）；gap 13px × --ui`；z=15
- 子元素顺序：badgeView（地球 SVG 徽标） → tb-text（主副标题：地理3D实验室——地球运动&太阳视运动 + 制作者徽标） → btnImmersive（沉浸模式） → segView（模块/视图一行式切换，margin-left:auto 推到右侧） → btnPanelMenu2（面板与悬浮窗） → flyPanelMenu2（面板菜单浮层，默认隐藏）
- 模块/视图切换 `#segView`：一级按钮（🌍 地球运动、☀️ 太阳视运动）切模块；二级分组（earth/sun 互斥）含视图按钮与下拉。
- 下拉 `.tbm2-drop`：trigger=点击 ▾；position=absolute; top: calc(100% + 5px); right:0；z=40；选项选中态 `.on`（accent 底+✓）。
- 右侧按钮：`btnImmersive`（沉浸模式）、`btnPanelMenu2`（面板与悬浮窗，开 `#flyPanelMenu2` z60）。

## 2. 面板与悬浮窗

| id | 标题 | 停靠 | 默认/最小尺寸(px, ×--ui) | z | 拖 | 缩 | 折 | 关 |
|---|---|---|---|---|---|---|---|---|
| `optsCard` | 设置（地球运动侧主设置） | fixed; left:16px×--ui; top:calc(--tb-h + 12px×--ui)（--dock-top） | 292×<PLACEHOLDER: 内容自适应；需实测展开态高度> / min 252×140 | <PLACEHOLDER: 卡片层：位于画布(#gl z auto)之上、标题栏(z15)之下，未显式声明 z-index，按 DOM 顺序堆叠> | ✓ | ✓ | ✓ | – |
| `timeCard` | 时间（地球运动侧） | fixed; right:16px×--ui; top:--dock-top | 336×<PLACEHOLDER: 内容自适应> / min 260×130 | <PLACEHOLDER: 同 optsCard，卡片层> | ✓ | ✓ | ✓ | – |
| `geoInfo` | 观测点数据 | fixed; 默认隐藏（.on 才显示）；位于时间面板左侧 | <PLACEHOLDER: 内容自适应>×<PLACEHOLDER: 内容自适应> / min 220×110 | <PLACEHOLDER: 卡片层> | ✓ | ✓ | ✓ | – |
| `controlBar` | 底部控制条 | fixed; left:50%; bottom:14px×--ui; transform:translateX(-50%)（水平居中贴底） | <PLACEHOLDER: 内容自适应宽度>×<PLACEHOLDER: 内容自适应> / min 400×112 | 12 | ✓ | – | ✓ | – |
| `svOptsCard` | 太阳视运动设置 | fixed; left:16px×--ui; top:--dock-top（太阳侧主设置） | <PLACEHOLDER: 内容自适应>×<PLACEHOLDER: 内容自适应> / min 250×140 | <PLACEHOLDER: 卡片层（同主侧）> | ✓ | ✓ | ✓ | – |
| `svTimeTop` | 时间（太阳侧右上·北京时间） | fixed; right:16px×--ui; top:--dock-top | <PLACEHOLDER: 内容自适应>×<PLACEHOLDER: 内容自适应> / min 260×130 | <PLACEHOLDER: 卡片层> | ✓ | ✓ | ✓ | – |
| `svTimeBar` | 观测点与时间控制（太阳侧下方·地方太阳时） | fixed; 贴底部（下方条）；横排/竖排可切换 | <PLACEHOLDER: 内容自适应（横排时较宽）>×<PLACEHOLDER: 内容自适应> / min 400×112 | <PLACEHOLDER: 卡片层> | ✓ | ✓ | ✓ | – |
| `svMonitor` | 观测点数据（太阳侧右上） | fixed; right（位于 svTimeTop 下方） | <PLACEHOLDER: 内容自适应>×<PLACEHOLDER: 内容自适应> / min 236×118 | <PLACEHOLDER: 卡片层> | ✓ | ✓ | ✓ | – |
| `svWinEarth/svWinSky/svWinGround` | 太阳侧 3D 悬浮窗（观测点位置/天球视图/地面全景） | fixed; 默认右下区域（makeFloatPanel 计算，彼此错位避免重叠） | <PLACEHOLDER: 内容自适应>×<PLACEHOLDER: 内容自适应> / min 188×166 | <PLACEHOLDER: 卡片层；拖动中 .pm-dragging → z60> | ✓ | ✓ | ✓ | ✓ |
| `mvWinMap/mvWinOrbit/mvWinSide/mvWinSub/mvWinNorth/mvWinSouth` | 地球运动侧 6 个 3D/2D 悬浮窗 | fixed; 默认散布（MV_DEFS 各自初值，互不重叠） | 自适应 / min ?×? | 容器 #mvWins z12；.mvwin.sv-active → z40；拖动中 .pm-dragging → z60 | ✓ | ✓ | ✓ | ✓ |
| `comboUI/svComboUI` | 综合视图多窗组合（地球运动侧 / 太阳侧） | fixed; inset:0（全屏覆盖） | 自适应 / min ?×? | 容器 #comboUI z6；.cdiv z7；退出按钮 #svExitCombo z70 级 | ✓ | ✓ | – | ✓ |

## 3. 菜单面板结构（同一 DSL 驱动 MENU 与 SUN_MENU）

### 3.1 DSL 结构
- 分组 `G(name, children, opts)`：`opts.sw` 为标题行总开关，`opts.gate` 为父级门控。
- 分隔 `sep()`；控件：`sw`(复选)/`rg`(滑块)/`cl`(颜色)/`sl`(下拉)/`use`(复用)/`tip`(说明)/`raw`(自定义HTML)/`noteGrp`(注释组)。
- 图标区：每行左侧 emoji（`icon` 字段）；快捷键区：<PLACEHOLDER: 源码未实现快捷键区（无 accelerator 字段）；如需复用请显式补充快捷键定义与提示文本位置>
- 子菜单方向：二级菜单在一级行下方容器内展开；三级+控制项在面板右侧浮层展开（flyHost）；三级标题点击后控制项向下展开

### 3.2 主侧一级菜单（MENU，6 组）
- ☀️ **光照系统** — 太阳光线 · 晨昏线 · 直射点 · 极昼极夜
- 🌫️ **地球表层** — 灯光 · 地轴 · 经纬线 · 温度带 · 时刻 · 时区 · 时差
- 🛰️ **公转系统** — 示意比例 · 椭圆轨道 · 节气标记 · 公转速度 · 注释
- 📌 **地球运动观测** — 观测点 · 标记点 · 小人模型 · 球面最短距离
- 📝 **全局文字样式** — 注释总开关 · 样式统一设置 · 面板文字样式
- 🎨 **界面与主题** — UI 色系 · 半透明毛玻璃 · 面板背景

### 3.3 太阳侧一级菜单（SUN_MENU，7 组）
- ☀️ **太阳光线与光照** — 真实太阳 · 体积光 · 天空与霞光
- 🌅 **太阳视运动** — 视运动轨迹 · 地面轨迹 · 光线与阴影
- 🧭 **天球坐标系** — 地平要素 · 赤道要素 · 固定模式 · 文字注释
- 🏙️ **地面物体** — 方向标 · 建筑物 · 小人 · 树木旗杆 · 室内
- 📏 **观察与测量** — 数据面板 · 物影 · 第一人称方向标
- 📝 **全局文字样式** — 显示全部注释 · 统一属性 · 面板文字样式
- 🎨 **界面与主题** — UI 风格 · 色系 · 面板毛玻璃

### 3.4 项状态
- **hover**：CSS :hover → color:var(--accent)（蓝 #2563eb）；分组/行 hover 浅蓝底 rgba(37,99,235,.08)
- **selected_on**：选中项 .on：accent 背景 + 白字；下拉/分段按钮 .on 显示 ✓
- **checkbox**：复选框（sw/toggle）：开=填充圆点 + 蓝；关=白底
- **radio**：单选（seg/select）：同 .on 表现，互斥
- **disabled**：gate 未满足 → 置灰（--ink-faint）+ 隐藏或不可点
- **expanded**：分组展开 .open / 浮层显示；折叠态隐藏 children

### 3.5 示例分支（光照系统 › 光照与太阳光线）
  - use(cbRaysCenter) 只显示直射光线（gate:rays）
  - G(直射光线样式)[ lwCtl 线粗细 / cl 线颜色 / rg 透明度 / G(类型)[虚线密度,虚实比] ]（gate:rays）
  - G(箭头样式)[ rg 点大小 / cl 点颜色 / rg 透明度 ]（gate:rays）
  - G(光线密度)[ rg 光线数量 3–25 ]（gate:rays）
  - sep()
  - G(体积光柱)[ G(强度与外观)[...] ]（sw=cbVolShaft，独立开关）
  - sep()
  - G(太阳贴图)[ sw(cbSunTex) ]
  - sep()
  - noteGrp(文字注释【太阳光线】)

## 4. 交互逻辑（状态列表 + 伪代码）

### 顶部模块/视图切换（#segView）
- **trigger**：点击 .tbm2-lv1 → 切模块并显示对应 .tbm2-lv2grp(.on)；点击 .tbm2-lv2btn → 切视图
- **dropdown**：点击 .tbm2-more → 切换 .tbm2-drop(.open)；再次点击或点击外部/Esc 关闭
- **hover**：.tbm2-lv1:hover 变 accent；.tbm2-drop button:hover 浅蓝底
- **select**：点击 drop 内选项 → 标记 .on（同组互斥，原 .on 移除）并写入对应状态
- **keyboard**：<PLACEHOLDER: 源码未见针对顶部栏的 keydown/方向键导航实现；如需复用请补充：←/→ 切换一级，↑/↓ 在 drop 内移动，Enter 选中，Esc 关闭>

### 设置菜单（#optsCard / #svOptsCard）三级折叠
- **documented_behavior**：一级行点击 → 二级菜单在下方容器展开；二级行点击 → 三级+控制项浮层在面板右侧展开（全局互斥）；三级标题点击 → 控制项向下展开
- **auto_collapse**：鼠标移出菜单范围 → 自动收起已展开的浮层（flyHost）
- **exclusivity**：二级浮层全局互斥：打开一个新的会关闭其它
- **hover_delay**：<PLACEHOLDER: 源码未设显式 hover 延迟（无 setTimeout 悬停定时器）；展开为 click 触发，非 hover 触发。如需 hover 展开请补充 delay 常量（建议 120–200ms）>
- **gating**：子项 gate 表达式（如 note.master.on,rays）为假 → 子项 disabled（置灰+隐藏）
- **keyboard**：<PLACEHOLDER: 设置菜单内部未见 keydown 导航实现；如需复用请补充方向键/Enter/Esc 与焦点环>

### 浮动面板（拖拽 / 缩放 / 折叠 / 关闭）
- **drag**：pointerdown 于 .card-head（或抓手）→ 移动；clamp 范围：允许部分推出屏幕（app.js: clamp(x, 4 - w + 64, innerWidth - 64)；顶部受标题栏下沿限制）
- **resize**：边缘把手 pointerdown/move/up；最小尺寸按 P 表 / MV_DEFS 强制；宽高比 ar[min,max] 超出时回拉
- **collapse**：header 链接按钮 → 切换 .collapsed/.min/.gi-min（隐藏 body）
- **close**：floating-window 的 close 链接 → 隐藏 + 置面板状态 false；重开经「面板与悬浮窗」菜单
- **memory**：位置/尺寸写入布局状态（S.layout.*），重载后恢复
- **focus_z**：拖动/缩放中类 .pm-dragging → z60，释放恢复

### 失焦关闭 / 外部点击
- **rule**：下拉（.tbm2-drop）、面板菜单浮层（#flyPanelMenu2）、二级浮层（flyHost）在点击其外部区域或 Esc 时关闭
- **blur_close_delay**：<PLACEHOLDER: 外部点击即时关闭；源码未设关闭延迟/淡出定时器（如需可补 0ms 即时 / 150ms 淡出）>

### 沉浸模式
- **enter**：btnImmersive / 或触发 → 加 body.immersive：隐藏 #titleBar 与所有 .card；仅留 #gl/#svCanvas
- **exit**：右上 imm-exit 按钮 或 Esc → 退出沉浸

## 5. 复用注意事项

- 所有像素尺寸应作为「设计基准值」存储，渲染时统一乘以 --ui（乘子），不要在各自组件内硬编码缩放。
- 圆角/内边距/字重/字号均通过 CSS 变量（--r/--pad-x/--ui-fw*/--ui-fs）统一控制，复用时应保留这套变量层。
- 卡片头（.card-head）必须声明与自身水平内边距相等的 --pad-x，否则表头负 margin 抵消量为 0，左右各留 1px 缝隙（验收基准差 1px 非 0）。
- 占位符（<PLACEHOLDER: ...>）为源码中未固化或需作者确认的数值，复用时请先实测或向作者确认后再落地。

---
*本文件由 tools/_gen_uispec.js 从单一数据源生成，YAML/JSON 与之同源。占位符 `<PLACEHOLDER: ...>` 为源码未固化或需确认项，复用时请先实测。*
