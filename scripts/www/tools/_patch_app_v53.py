# -*- coding: utf-8 -*-
"""v53：app.js 剩余改动。

1. 贴图加载：两张旧掩膜（geo-land / geo-cont）→ 一张 geo-reg（uReg）
2. 世界地图窗（mvDrawMap 等）的海岸线：不再读 GEO_COAST 矢量，
   改由**同一张 geo-reg 掩膜**在 Canvas 上做「陆海掩膜描边」得到 —— 与 3D 球面同源。
3. 标记点：二级菜单关闭时隐藏全部标记点（圆点 + 文字）。
4. 文字注释门控优先级链：显示隐藏全局文字注释 ＞ 二级菜单标题开关 ＞ 地理事物开关 ＞ 自身文字注释开关。
"""
import io
import os
import re
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(APP, 'app.js')

REPL = []


def sub1(pat, new, flags=0, count=1, label=''):
    REPL.append((pat, new, flags, count, label))


# ---------------------------------------------------------------- 1. 贴图加载
sub1(
    r"loadTex\(GEO_URI\('land', 'assets/geo-land\.png'\), false\),\s*\n\s*loadTex\(GEO_URI\('cont', 'assets/geo-cont\.png'\), true\),",
    "loadTex(GEO_URI('reg', 'assets/geo-reg.png'), false),",
    label='1a 掩膜贴图加载改为单张 geo-reg')

sub1(
    r"""    const gLand = r\[4\] \|\| loadTex\(fallbackGray\(0\), false\);\s*
    const gCont = r\[5\] \|\| loadTex\(fallbackGray\(0\), true\);\s*
    Promise\.all\(\[gLand, gCont\]\)\.then\(function \(g\) \{\s*
      \[geoMatR, geoMatO\]\.forEach\(function \(m\) \{\s*
        m\.uniforms\.uLand\.value = g\[0\];\s*
        m\.uniforms\.uCont\.value = g\[1\];\s*
      \}\);\s*
      geoDataState = \(r\[4\] && r\[5\]\) \? 'ok' : \(\(r\[4\] \|\| r\[5\]\) \? 'part' : 'missing'\);\s*
      if \(g\[0\]\) geoMaskW = g\[0\]\.image\.width;\s*
      syncGeoStat\(\);\s*
    \}\);""",
    """    const gReg = r[4] || loadTex(fallbackGray(0), false);
    gReg.then(function (g) {
      [geoMatR, geoMatO].forEach(function (m) { m.uniforms.uReg.value = g; });
      geoDataState = r[4] ? 'ok' : 'missing';
      if (g && g.image) geoMaskW = g.image.width;
      applyGeo();                                   // 拿到真实掩膜宽度后重算「度→像素」换算
      syncGeoStat();
    });""",
    label='1b 掩膜 uniforms 绑定改为 uReg')

# 提示文案同步（面板上仍写着「其中一张缺失」）
sub1(
    r"part: '数据：只装载到一半 —— 海陆与大洲中有一张缺失，请检查 assets-geo\.js',",
    "",
    label='1c 删除 part 文案')

# ------------------------------------------------- 2. 世界地图窗：海岸线改同源
sub1(
    r"""  /\* 海岸线矢量（assets/coast-vectors\.js 内联的精简海岸环）：画在世界图上，
     使窗口里的海陆轮廓与 3D 球面一致。每个窗口按「投影 \+ 尺寸」缓存一组 Path2D，
     避免每帧重建近万段线段；跨 ±180° 的环（源文件里经度已展开到 \[-180,360\]）在此断开重起笔。 \*/
  function mvCoastRings\(\) \{
    const g = window\.GEO_COAST;
    if \(!g\) return null;
    const out = \[\];
    \['coast', 'cont'\]\.forEach\(function \(key\) \{
      const arr = g\[key\];
      if \(!arr \|\| !arr\.length\) return;
      for \(let i = 0; i < arr\.length; i\+\+\) \{
        const r = arr\[i\];
        if \(r && r\.length >= 6\) out\.push\(r\);
      \}
    \}\);
    return out;
  \}
  function mvCoastPaths\(o, key, W, proj\) \{
    if \(o && o\.cKey === key && o\.cPaths\) return o\.cPaths;
    const rings = mvCoastRings\(\) \|\| \[\];
    const paths = \[\];
    for \(let i = 0; i < rings\.length; i\+\+\) \{
      const r = rings\[i\];
      const p = new Path2D\(\);
      let prevX = null, anyOk = false;
      for \(let j = 0; j \+ 1 < r\.length; j \+= 2\) \{
        const q = proj\(r\[j\], r\[j \+ 1\]\);
        if \(!q\) \{ prevX = null; continue; \}
        if \(prevX === null \|\| Math\.abs\(q\[0\] - prevX\) > W \* 0\.5\) p\.moveTo\(q\[0\], q\[1\]\);
        else p\.lineTo\(q\[0\], q\[1\]\);
        prevX = q\[0\]; anyOk = true;
      \}
      if \(anyOk\) paths\.push\(p\);
    \}
    if \(o\) \{ o\.cKey = key; o\.cPaths = paths; \}
    return paths;
  \}""",
    """  /* ★ v53：世界地图窗的海岸线不再读 assets/coast-vectors.js 的矢量环 ——
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
  }""",
    label='2a 海岸线矢量 → 掩膜派生')

# 2b. mvDrawMap 里调用点替换
sub1(
    r"""    /\* --- 海岸线（贴合贴图 / 球面的海陆轮廓）--- \*/\s*
    try \{\s*
      const cps = mvCoastPaths\(o, 'map\|' \+ W \+ 'x' \+ H, W, function \(lon, lat\) \{\s*
        if \(lat < -84\.5 \|\| lat > 84\.5\) return null;\s*
        return \[X\(wrap180\(lon\)\), Y\(clamp\(lat, -84\.5, 84\.5\)\)\];\s*
      \}\);\s*
      ctx\.save\(\);\s*
      ctx\.strokeStyle = 'rgba\(226,240,252,\.42\)';\s*
      ctx\.lineWidth = Math\.max\(0\.6, 0\.75 \* dpr\);\s*
      ctx\.lineJoin = 'round';\s*
      for \(let i = 0; i < cps\.length; i\+\+\) ctx\.stroke\(cps\[i\]\);\s*
      ctx\.restore\(\);\s*
    \} catch \(e\) \{ /\* 老浏览器无 Path2D —— 退化为不画海岸线 \*/ \}""",
    """    /* --- 海岸线 + 大洲界线（与 3D 球面同源：同一张 geo-reg 掩膜）--- */
    try { mvStrokeRegions(ctx, W, H, dpr, false); } catch (e) { /* 掩膜未就绪 —— 不画 */ }""",
    label='2b mvDrawMap 海岸线调用点')

# --------------------------------------------- 3. 标记点：二级菜单关闭 → 全隐藏
sub1(
    r"""      _ptSprites = \[\];
      while \(ptsGroup\.children\.length\) ptsGroup\.remove\(ptsGroup\.children\[0\]\);
      while \(ptsGroupOrb\.children\.length\) ptsGroupOrb\.remove\(ptsGroupOrb\.children\[0\]\);""",
    """      _ptSprites = [];
      while (ptsGroup.children.length) ptsGroup.remove(ptsGroup.children[0]);
      while (ptsGroupOrb.children.length) ptsGroupOrb.remove(ptsGroupOrb.children[0]);
      /* ★ v53（需求一·2）：二级菜单「标记点」关闭时，**整组隐藏**（圆点 + 文字）。
         旧写法只把文字包在 if (p.show) 里、圆点无条件加入场景，
         于是关掉开关后地上仍留着一堆彩色圆点（用户截图里的红/黄/橙点）。 */
      ptsGroup.visible = ptsGroupOrb.visible = !!p.show;""",
    label='3a 标记点整组显隐')

# ------------------------------------------------- 4. 门控优先级链（全局文字）
sub1(
    r"""  function spriteNoteGate\(sp\) \{""",
    """  /* ★ v53（需求二·2 / 全局需求·2）：全局文字注释门控的**优先级链**。
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
    if (_c0 && !noteGateLevel2(_c0, sp)) return false;   // 优先级 ② → ③""",
    label='4a 门控优先级链')

sub1(
    r"""    textSprites\.forEach\(function \(sp\) \{\s*
      if \(sp\.userData\.hourLabel\) return;                          // 地方时刻标签由 applyHourStyle 单独管（7674）\s*
      const st = noteStyleFor\(sp\.userData\.cat \|\| 'misc', sp\.userData\.key\);""",
    """    textSprites.forEach(function (sp) {
      if (sp.userData.hourLabel) return;                          // 地方时刻标签由 applyHourStyle 单独管
      const _cat0 = sp.userData.cat || 'misc';
      /* ① 全局总开关（优先级最高）—— 关掉时**立即隐藏全部文字注释**，
         不再逐个去问 ②③④，任何分类开关都救不回来。 */
      if (!state.note.master.on) { sp.visible = false; sp.userData.noteGate = false; return; }
      /* ② 二级菜单标题开关 ＞ ③ 地理事物开关 —— 顺序固定，先过标题再过事物 */
      if (!noteGateLevel2(_cat0, sp)) { sp.visible = false; sp.userData.noteGate = false; return; }
      const st = noteStyleFor(_cat0, sp.userData.key);""",
    label='4b applyAll 内门控加优先级')


def main():
    with io.open(JS, encoding='utf-8') as f:
        s = f.read()
    orig = s
    for pat, new, flags, count, label in REPL:
        if not new.endswith('\n') and not new.endswith('}'):
            pass
        rx = re.compile(pat, flags)
        s2, n = rx.subn(lambda _m: new, s, count=count)
        if n == 0:
            print('  [FAIL] %s —— 模式未匹配' % label)
            continue
        s = s2
        print('  [ok  ] %s （%d 处）' % (label, n))
    if s == orig:
        print('没有任何改动')
        sys.exit(1)
    with io.open(JS, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    print('已写入 %s（%d 字节）' % (JS, os.path.getsize(JS)))


if __name__ == '__main__':
    main()
