# -*- coding: utf-8 -*-
"""v53：把 app.js 中「海陆分布 / 七大洲」的渲染层整块替换为单一掩膜派生版。"""
import io
import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(APP, 'app.js')

NEW = r'''  /* ============ v53：海陆分布 / 七大洲（**单一掩膜，四者同源**） ============
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
      if (uContOn > 0.002 && bi > 0) {
        vec4 pv = texture2D(uPal, vec2((float(bi) - 0.5) / 8.0, 0.5));
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
  geoMeshR.renderOrder = 4; geoMeshO.renderOrder = 4;      // 面内最底 —— 海陆 + 七大洲填充
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
      u.uCBndOn.value = (C.on && C.line && F.contLine.on) ? 1 : 0;
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
'''


def main():
    with io.open(JS, encoding='utf-8') as f:
        lines = f.readlines()
    start = end = -1
    for i, ln in enumerate(lines):
        # ★ 必须匹配「行首两个空格缩进」的那一处（2231 行的渲染层注释）；
        #   DEFAULTS 里还有一处 4 空格缩进的同名注释（466 行），不能误伤。
        if ln.startswith('  /* ============ v25.1（需求⑤）：海陆分布 / 七大洲（球面掩膜叠加层）') and start < 0:
            start = i
        if start >= 0 and '/* ============ 云层 ============ */' in ln:
            end = i
            break
    if start < 0 or end < 0:
        print('定位失败 start=%d end=%d' % (start, end))
        sys.exit(1)
    print('替换 app.js 第 %d..%d 行（共 %d 行 → %d 行）' % (start + 1, end, end - start, NEW.count('\n')))
    out = lines[:start] + [NEW] + lines[end:]
    with io.open(JS, 'w', encoding='utf-8', newline='') as f:
        f.write(''.join(out))
    print('已写入 %s（%d 字节）' % (JS, os.path.getsize(JS)))


if __name__ == '__main__':
    main()
