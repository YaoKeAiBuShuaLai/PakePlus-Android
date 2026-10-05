/* 菜单控件定义表：由 gen_ctrl.py 从现有 index.html 自动收割，供 menu.js 数据驱动渲染复用。
   改动菜单时不要手改本文件；新增控件直接在 menu.js 的 MENU 里写完整 spec 即可。
   v20.0：按 menu.js / app.js / index.html 的实际引用情况，剔除 17 条已随菜单重构删除的
          历史条目（单条注释实例面板、黄赤交角扇形与平面注释项、旧经纬网颜色/透明度、
          极昼极夜填充图案），避免表里留下永远读不到的死配置。
   注（如实说明现状）：本表仍**保留一部分当前 MENU 未直接 use() 引用的备用/历史条目**，
       未做删除以保证向后兼容；它们只在 menu.js 的 use()/specOf 缺失时作为回退值使用。
       因此「表内存在未被引用的键」属预期保留，并非遗漏。 */
window.CTRLS = 
{
 "btnCollapse": {
  "cls": "link",
  "k": "btn",
  "label": "收起"
 },
 "btnMonClear": {
  "cls": "btn xs",
  "k": "btn",
  "label": "清除"
 },
 "btnMonCustom": {
  "cls": "btn xs",
  "k": "btn",
  "label": "应用自定义经纬度"
 },
 "btnPtsClear": {
  "cls": "btn xs",
  "k": "btn",
  "label": "清空全部点"
 },
 "cbAddMode": {
  "k": "sw",
  "label": "添加点模式（点击地球表面添加）"
 },
 "cbAr": {
  "k": "sw",
  "label": ""
 },
 "cbAtmo": {
  "k": "sw",
  "label": "大气光晕"
 },
 "cbAurora": {
  "k": "sw",
  "label": "极光（极夜区）"
 },
 "cbAxis": {
  "k": "sw",
  "label": "显示地轴"
 },
 "cbClouds": {
  "k": "sw",
  "label": "云层"
 },
 "cbDawn": {
  "k": "sw",
  "label": ""
 },
 "cbDusk": {
  "k": "sw",
  "label": ""
 },
 "cbEq": {
  "k": "sw",
  "label": ""
 },
 "cbGrat": {
  "k": "sw",
  "label": "显示经纬网（总开关）"
 },
 "cbGratMer": {
  "k": "sw",
  "label": ""
 },
 "cbGratPar": {
  "k": "sw",
  "label": ""
 },
 "cbHourMain": {
  "k": "sw",
  "label": ""
 },
 "cbHourRest": {
  "k": "sw",
  "label": ""
 },
 "cbMonCircle": {
  "k": "sw",
  "label": ""
 },
 "cbNight": {
  "k": "sw",
  "label": "夜间城市灯光"
 },
 "cbNoteAll": {
  "k": "sw",
  "label": "显示全部文字注释"
 },
 "cbOrbOrbit": {
  "k": "sw",
  "label": "显示公转轨道"
 },
 "cbOrbTerms": {
  "k": "sw",
  "label": ""
 },
 "cbOrbTerms24": {
  "k": "sw",
  "label": ""
 },
 "cbPd": {
  "k": "sw",
  "label": ""
 },
 "cbPdStroke": {
  "k": "sw",
  "label": ""
 },
 "cbPlaneEcl": {
  "k": "sw",
  "label": "显示黄道面"
 },
 "cbPlaneEqu": {
  "k": "sw",
  "label": "显示赤道面"
 },
 "cbPm": {
  "k": "sw",
  "label": ""
 },
 "cbPn": {
  "k": "sw",
  "label": ""
 },
 "cbPnStroke": {
  "k": "sw",
  "label": ""
 },
 "cbPolar": {
  "k": "sw",
  "label": "显示极昼极夜区域（总开关）"
 },
 "cbPtsShow": {
  "k": "sw",
  "label": ""
 },
 "cbPtsSnap": {
  "k": "sw",
  "label": "吸附到经纬网（显示经纬网时生效）"
 },
 "cbRays": {
  "k": "sw",
  "label": "显示太阳光线箭头"
 },
 "cbRaysCenter": {
  "k": "sw",
  "label": "只显示直射光线（中间一条）"
 },
 "cbReadObliq": {
  "k": "sw",
  "label": "显示黄赤交角"
 },
 "cbReadOrbArea": {
  "k": "sw",
  "label": "显示地球公转面积速度"
 },
 "cbReadOrbV": {
  "k": "sw",
  "label": "显示地球公转瞬时线速度 / 角速度"
 },
 "cbReadPolar": {
  "k": "sw",
  "label": "显示极昼 / 极夜纬度范围"
 },
 "cbReadSub": {
  "k": "sw",
  "label": "显示太阳直射点经纬度"
 },
 "cbSub": {
  "k": "sw",
  "label": "显示太阳直射点"
 },
 "cbSubTrail": {
  "k": "sw",
  "label": "记录太阳直射点轨迹"
 },
 "cbTerm": {
  "k": "sw",
  "label": "显示晨昏线（总开关）"
 },
 "cbTr": {
  "k": "sw",
  "label": ""
 },
 "cbTz": {
  "k": "sw",
  "label": "显示时区图层"
 },
 "cbTzStripe": {
  "k": "sw",
  "label": "相邻面交互填充"
 },
 "cbTzStroke": {
  "k": "sw",
  "label": ""
 },
 "cbZones": {
  "k": "sw",
  "label": "显示温度带（总开关）"
 },
 "clrAr": {
  "hex": "hexAr",
  "k": "color",
  "label": "线条颜色"
 },
 "clrAxis": {
  "hex": "hexAxis",
  "k": "color",
  "label": "轴线颜色"
 },
 "clrDawn": {
  "hex": "hexDawn",
  "k": "color",
  "label": "线条颜色"
 },
 "clrDusk": {
  "hex": "hexDusk",
  "k": "color",
  "label": "线条颜色"
 },
 "clrEcl": {
  "hex": "hexEcl",
  "k": "color",
  "label": "黄道面颜色"
 },
 "clrEq": {
  "hex": "hexEq",
  "k": "color",
  "label": "线条颜色"
 },
 "clrEqu": {
  "hex": "hexEqu",
  "k": "color",
  "label": "赤道面颜色"
 },
 "clrHourMain": {
  "hex": "hexHourMain",
  "k": "color",
  "label": "点颜色"
 },
 "clrHourRest": {
  "hex": "hexHourRest",
  "k": "color",
  "label": "点颜色"
 },
 "clrMarker": {
  "hex": "hexMarker",
  "k": "color",
  "label": "点击标记颜色"
 },
 "clrMonDay": {
  "hex": "hexMonDay",
  "k": "color",
  "label": "昼弧颜色"
 },
 "clrMonNight": {
  "hex": "hexMonNight",
  "k": "color",
  "label": "夜弧颜色"
 },
 "clrNoteColor": {
  "hex": "hexNoteColor",
  "k": "color",
  "label": "总颜色"
 },
 "clrOrbOrbit": {
  "hex": "hexOrbOrbit",
  "k": "color",
  "label": "轨道颜色"
 },
 "clrOrbRay": {
  "hex": "hexOrbRay",
  "k": "color",
  "label": "线颜色"
 },
 "clrPanelFont": {
  "hex": "hexPanelFont",
  "k": "color",
  "label": "颜色"
 },
 "clrPdFill": {
  "hex": "hexPdFill",
  "k": "color",
  "label": "填充颜色"
 },
 "clrPdStroke": {
  "hex": "hexPdStroke",
  "k": "color",
  "label": "描边颜色"
 },
 "clrPm": {
  "hex": "hexPm",
  "k": "color",
  "label": "线条颜色"
 },
 "clrPnFill": {
  "hex": "hexPnFill",
  "k": "color",
  "label": "填充颜色"
 },
 "clrPnStroke": {
  "hex": "hexPnStroke",
  "k": "color",
  "label": "描边颜色"
 },
 "clrPtColor": {
  "hex": "hexPtColor",
  "k": "color",
  "label": "点颜色"
 },
 "clrSub": {
  "hex": "hexSub",
  "k": "color",
  "label": "标记颜色"
 },
 "clrT24": {
  "hex": "hexT24",
  "k": "color",
  "label": "标记颜色"
 },
 "clrTerms": {
  "hex": "hexTerms",
  "k": "color",
  "label": "标记颜色"
 },
 "clrTr": {
  "hex": "hexTr",
  "k": "color",
  "label": "线条颜色"
 },
 "clrTzFill": {
  "hex": "hexTzFill",
  "k": "color",
  "label": "填充颜色"
 },
 "clrTzFill2": {
  "hex": "hexTzFill2",
  "k": "color",
  "label": "交替面颜色"
 },
 "clrTzStroke": {
  "hex": "hexTzStroke",
  "k": "color",
  "label": "描边颜色"
 },
 "clrZcoldN": {
  "hex": "hexZcoldN",
  "k": "color",
  "label": "北寒带色"
 },
 "clrZcoldS": {
  "hex": "hexZcoldS",
  "k": "color",
  "label": "南寒带色"
 },
 "clrZtempN": {
  "hex": "hexZtempN",
  "k": "color",
  "label": "北温带色"
 },
 "clrZtempS": {
  "hex": "hexZtempS",
  "k": "color",
  "label": "南温带色"
 },
 "clrZtropic": {
  "hex": "hexZtropic",
  "k": "color",
  "label": "热带色"
 },
 "inMonLat": {
  "k": "num",
  "label": "自定义纬度",
  "max": "90",
  "min": "-90",
  "step": "0.01"
 },
 "inMonLon": {
  "k": "num",
  "label": "自定义经度",
  "max": "180",
  "min": "-180",
  "step": "0.01"
 },
 "piCurve": {
  "k": "sw",
  "label": "全年昼长曲线"
 },
 "piDaylen": {
  "k": "sw",
  "label": "当日昼长（大字）"
 },
 "piLst": {
  "k": "sw",
  "label": "地方时（真太阳时）"
 },
 "piNoon": {
  "k": "sw",
  "label": "正午太阳高度"
 },
 "piPos": {
  "k": "sw",
  "label": "位置（纬度 / 经度）"
 },
 "piSpinV": {
  "k": "sw",
  "label": "该点自转线速度"
 },
 "piSpinW": {
  "k": "sw",
  "label": "该点自转角速度"
 },
 "piSr": {
  "k": "sw",
  "label": "日出 / 日落时刻与方位"
 },
 "piSraz": {
  "k": "sw",
  "label": "日出日落方位角（数值）"
 },
 "piSub": {
  "k": "sw",
  "label": "太阳直射点"
 },
 "piTerm": {
  "k": "sw",
  "label": "节气"
 },
 "piTz": {
  "k": "sw",
  "label": "时区（区名 · UTC 偏移 · 区时）"
 },
 "piYear": {
  "k": "sw",
  "label": "全年昼长极值"
 },
 "rngArN": {
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outArN",
  "step": "1"
 },
 "rngArOp": {
  "k": "range",
  "label": "不透明度",
  "max": "100",
  "min": "10",
  "out": "outArOp",
  "step": "1"
 },
 "rngArRatio": {
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outArRatio",
  "step": "1"
 },
 "rngArW": {
  "k": "range",
  "label": "线条粗细",
  "max": "120",
  "min": "5",
  "out": "outArW",
  "step": "1"
 },
 "rngAuroraBright": {
  "k": "range",
  "label": "极光亮度",
  "max": "200",
  "min": "0",
  "out": "outAuroraBright",
  "step": "5"
 },
 "rngAxisLen": {
  "k": "range",
  "label": "地轴长度",
  "max": "60",
  "min": "15",
  "out": "outAxisLen",
  "step": "1"
 },
 "rngAxisWidth": {
  "k": "range",
  "label": "轴线粗细",
  "max": "40",
  "min": "1",
  "out": "outAxisWidth",
  "step": "1"
 },
 "rngDawnN": {
  "dash": "dawn",
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outDawnN",
  "step": "1"
 },
 "rngDawnRatio": {
  "dash": "dawn",
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outDawnRatio",
  "step": "1"
 },
 "rngDawnW": {
  "k": "range",
  "label": "线条粗细",
  "max": "40",
  "min": "2",
  "out": "outDawnW",
  "step": "1"
 },
 "rngDayGain": {
  "k": "range",
  "label": "昼面亮度",
  "max": "220",
  "min": "60",
  "out": "outDayGain",
  "step": "1"
 },
 "rngDistScale": {
  "k": "range",
  "label": "距离比例",
  "max": "400",
  "min": "30",
  "out": "outDistScale",
  "step": "1"
 },
 "rngDuskN": {
  "dash": "dusk",
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outDuskN",
  "step": "1"
 },
 "rngDuskRatio": {
  "dash": "dusk",
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outDuskRatio",
  "step": "1"
 },
 "rngDuskW": {
  "k": "range",
  "label": "线条粗细",
  "max": "40",
  "min": "2",
  "out": "outDuskW",
  "step": "1"
 },
 "rngEarthScale": {
  "k": "range",
  "label": "地球大小",
  "max": "300",
  "min": "30",
  "out": "outEarthScale",
  "step": "1"
 },
 "rngEclOp": {
  "k": "range",
  "label": "黄道面透明",
  "max": "60",
  "min": "2",
  "out": "outEclOp",
  "step": "1"
 },
 "rngEqOp": {
  "k": "range",
  "label": "不透明度",
  "max": "100",
  "min": "10",
  "out": "outEqOp",
  "step": "1"
 },
 "rngEqW": {
  "k": "range",
  "label": "线条粗细",
  "max": "120",
  "min": "5",
  "out": "outEqW",
  "step": "1"
 },
 "rngEquOp": {
  "k": "range",
  "label": "赤道面透明",
  "max": "60",
  "min": "2",
  "out": "outEquOp",
  "step": "1"
 },
 "rngHourMainSize": {
  "k": "range",
  "label": "点大小",
  "max": "80",
  "min": "4",
  "out": "outHourMainSize",
  "step": "1"
 },
 "rngHourRestSize": {
  "k": "range",
  "label": "点大小",
  "max": "80",
  "min": "4",
  "out": "outHourRestSize",
  "step": "1"
 },
 "rngMarkerSize": {
  "k": "range",
  "label": "点击标记大小",
  "max": "120",
  "min": "5",
  "out": "outMarkerSize",
  "step": "1"
 },
 "rngMonDayOp": {
  "k": "range",
  "label": "昼弧透明",
  "max": "100",
  "min": "10",
  "out": "outMonDayOp",
  "step": "1"
 },
 "rngMonNightOp": {
  "k": "range",
  "label": "夜弧透明",
  "max": "100",
  "min": "10",
  "out": "outMonNightOp",
  "step": "1"
 },
 "rngMonW": {
  "k": "range",
  "label": "纬线圈宽度",
  "max": "200",
  "min": "10",
  "out": "outMonW",
  "step": "1"
 },
 "rngNightGain": {
  "k": "range",
  "label": "夜面亮度",
  "max": "30",
  "min": "0",
  "out": "outNightGain",
  "step": "1"
 },
 "rngNoteOp": {
  "k": "range",
  "label": "总透明度",
  "max": "100",
  "min": "10",
  "out": "outNoteOp",
  "step": "1"
 },
 "rngNoteSize": {
  "k": "range",
  "label": "总字号",
  "max": "1000",
  "min": "1",
  "out": "outNoteSize",
  "step": "1"
 },
 "rngObliq": {
  "k": "range",
  "label": "黄赤交角",
  "max": "900",
  "min": "0",
  "out": "outObliq",
  "step": "1"
 },
 "rngOrbOrbitOp": {
  "k": "range",
  "label": "轨道透明度",
  "max": "100",
  "min": "10",
  "out": "outOrbOrbitOp",
  "step": "1"
 },
 "rngOrbOrbitW": {
  "k": "range",
  "label": "轨道粗细",
  "max": "60",
  "min": "2",
  "out": "outOrbOrbitW",
  "step": "1"
 },
 "rngOrbRayOp": {
  "k": "range",
  "label": "透明度",
  "max": "100",
  "min": "10",
  "out": "outOrbRayOp",
  "step": "1"
 },
 "rngPanelFont": {
  "k": "range",
  "label": "字号",
  "max": "180",
  "min": "70",
  "out": "outPanelFont",
  "step": "1"
 },
 "rngPanelFontOp": {
  "k": "range",
  "label": "透明度",
  "max": "100",
  "min": "20",
  "out": "outPanelFontOp",
  "step": "1"
 },
 "rngPdOpacity": {
  "k": "range",
  "label": "填充透明",
  "max": "100",
  "min": "0",
  "out": "outPdOpacity",
  "step": "1"
 },
 "rngPdStrokeOp": {
  "k": "range",
  "label": "描边透明",
  "max": "100",
  "min": "0",
  "out": "outPdStrokeOp",
  "step": "1"
 },
 "rngPdStrokeW": {
  "k": "range",
  "label": "描边粗细",
  "max": "100",
  "min": "1",
  "out": "outPdStrokeW",
  "step": "1"
 },
 "rngPmOp": {
  "k": "range",
  "label": "不透明度",
  "max": "100",
  "min": "10",
  "out": "outPmOp",
  "step": "1"
 },
 "rngPmW": {
  "k": "range",
  "label": "线条粗细",
  "max": "120",
  "min": "5",
  "out": "outPmW",
  "step": "1"
 },
 "rngPnOpacity": {
  "k": "range",
  "label": "填充透明",
  "max": "100",
  "min": "0",
  "out": "outPnOpacity",
  "step": "1"
 },
 "rngPnStrokeOp": {
  "k": "range",
  "label": "描边透明",
  "max": "100",
  "min": "0",
  "out": "outPnStrokeOp",
  "step": "1"
 },
 "rngPnStrokeW": {
  "k": "range",
  "label": "描边粗细",
  "max": "100",
  "min": "1",
  "out": "outPnStrokeW",
  "step": "1"
 },
 "rngPtSize": {
  "k": "range",
  "label": "点大小",
  "max": "300",
  "min": "50",
  "out": "outPtSize",
  "step": "5"
 },
 "rngRayN": {
  "dash": "ray",
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outRayN",
  "step": "1"
 },
 "rngRayRatio": {
  "dash": "ray",
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outRayRatio",
  "step": "1"
 },
 "rngRayW": {
  "k": "range",
  "label": "线粗细",
  "max": "60",
  "min": "2",
  "out": "outRayW",
  "step": "1"
 },
 "rngSoft": {
  "k": "range",
  "label": "明暗过渡",
  "max": "28",
  "min": "2",
  "out": "outSoft",
  "step": "1"
 },
 "rngSpec": {
  "k": "range",
  "label": "高光反光",
  "max": "100",
  "min": "0",
  "out": "outSpec",
  "step": "1"
 },
 "rngSubSize": {
  "k": "range",
  "label": "标记大小",
  "max": "120",
  "min": "10",
  "out": "outSubSize",
  "step": "1"
 },
 "rngSunScale": {
  "k": "range",
  "label": "太阳大小",
  "max": "300",
  "min": "20",
  "out": "outSunScale",
  "step": "1"
 },
 "rngT24Size": {
  "k": "range",
  "label": "标记大小",
  "max": "300",
  "min": "50",
  "out": "outT24Size",
  "step": "1"
 },
 "rngTermsSize": {
  "k": "range",
  "label": "标记大小",
  "max": "300",
  "min": "50",
  "out": "outTermsSize",
  "step": "1"
 },
 "rngTrN": {
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outTrN",
  "step": "1"
 },
 "rngTrOp": {
  "k": "range",
  "label": "不透明度",
  "max": "100",
  "min": "10",
  "out": "outTrOp",
  "step": "1"
 },
 "rngTrRatio": {
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outTrRatio",
  "step": "1"
 },
 "rngTrW": {
  "k": "range",
  "label": "线条粗细",
  "max": "120",
  "min": "5",
  "out": "outTrW",
  "step": "1"
 },
 "rngTzFillOp": {
  "k": "range",
  "label": "填充透明度",
  "max": "100",
  "min": "0",
  "out": "outTzFillOp",
  "step": "1"
 },
 "rngTzFillOp2": {
  "k": "range",
  "label": "交替面透明度",
  "max": "100",
  "min": "0",
  "out": "outTzFillOp2",
  "step": "1"
 },
 "rngTzStrokeN": {
  "dash": "tzstroke",
  "k": "range",
  "label": "虚线密度",
  "max": "200",
  "min": "10",
  "out": "outTzStrokeN",
  "step": "1"
 },
 "rngTzStrokeOp": {
  "k": "range",
  "label": "描边透明度",
  "max": "100",
  "min": "0",
  "out": "outTzStrokeOp",
  "step": "1"
 },
 "rngTzStrokeRatio": {
  "dash": "tzstroke",
  "k": "range",
  "label": "实虚比",
  "max": "90",
  "min": "20",
  "out": "outTzStrokeRatio",
  "step": "1"
 },
 "rngTzStrokeW": {
  "k": "range",
  "label": "描边粗细",
  "max": "100",
  "min": "1",
  "out": "outTzStrokeW",
  "step": "1"
 },
 "rngZoneOp": {
  "k": "range",
  "label": "填充透明度",
  "max": "100",
  "min": "0",
  "out": "outZoneOp",
  "step": "1"
 },
 "selDawnDash": {
  "k": "sel",
  "label": "线型",
  "opts": [
   [
    "solid",
    "实线"
   ],
   [
    "dash",
    "虚线"
   ]
  ]
 },
 "selDuskDash": {
  "k": "sel",
  "label": "线型",
  "opts": [
   [
    "solid",
    "实线"
   ],
   [
    "dash",
    "虚线"
   ]
  ]
 },
 "selGratMerStep": {
  "k": "sel",
  "label": "经线间隔",
  "opts": [
   [
    "10",
    "每 10°"
   ],
   [
    "15",
    "每 15°"
   ],
   [
    "20",
    "每 20°"
   ],
   [
    "30",
    "每 30°"
   ],
   [
    "45",
    "每 45°"
   ],
   [
    "60",
    "每 60°"
   ]
  ]
 },
 "selGratParStep": {
  "k": "sel",
  "label": "纬线间隔",
  "opts": [
   [
    "10",
    "每 10°"
   ],
   [
    "15",
    "每 15°"
   ],
   [
    "20",
    "每 20°"
   ],
   [
    "30",
    "每 30°"
   ],
   [
    "45",
    "每 45°"
   ],
   [
    "60",
    "每 60°"
   ]
  ]
 },
 "selNoteAlign": {
  "k": "sel",
  "label": "总对齐",
  "opts": [
   [
    "left",
    "左对齐"
   ],
   [
    "center",
    "居中"
   ],
   [
    "right",
    "右对齐"
   ]
  ]
 },
 "selNoteFont": {
  "k": "sel",
  "label": "字体",
  "opts": [
   [
    "default",
    "系统默认"
   ],
   [
    "both",
    "宋体 / Times New Roman"
   ],
   [
    "simsun",
    "宋体"
   ],
   [
    "hei",
    "黑体"
   ],
   [
    "times",
    "新罗马字体（Times New Roman）"
   ]
  ]
 },
 "selNoteWeight": {
  "k": "sel",
  "label": "总字重",
  "opts": [
   [
    "300",
    "细体"
   ],
   [
    "400",
    "常规"
   ],
   [
    "500",
    "中等"
   ],
   [
    "600",
    "半粗"
   ],
   [
    "700",
    "粗体"
   ]
  ]
 },
 "selPanelFont": {
  "k": "sel",
  "label": "字体",
  "opts": [
   [
    "default",
    "系统默认（随浏览器）"
   ],
   [
    "both",
    "宋体 / Times New Roman"
   ],
   [
    "simsun",
    "宋体"
   ],
   [
    "hei",
    "黑体"
   ],
   [
    "times",
    "新罗马字体（Times New Roman）"
   ]
  ]
 },
 "selRayDash": {
  "k": "sel",
  "label": "类型",
  "opts": [
   [
    "solid",
    "实线"
   ],
   [
    "dash",
    "虚线"
   ]
  ]
 },
 "selTzStrokeDash": {
  "k": "sel",
  "label": "描边线型",
  "opts": [
   [
    "solid",
    "实线"
   ],
   [
    "dash",
    "虚线"
   ]
  ]
 }
};
