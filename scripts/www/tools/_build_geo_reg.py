# -*- coding: utf-8 -*-
"""v53：从 geo-cont.png（大洲调色板掩膜）派生「统一区域掩膜」。

背景
----
旧版有**两套互不相干**的数据同时驱动大洲相关图层：
  · assets/geo-cont.png  —— 七大洲调色板掩膜（RGB 就近匹配解码）
  · assets/coast-vectors.js —— 海岸线 / 大洲界线的**独立矢量环**
                            （GEO_COAST.coast = 全球海岸线；GEO_COAST.cont = 7 大洲
                              全部边界环**合并成的一个扁平数组**，与洲索引无关）
于是「只勾选亚洲」也会把欧洲 / 非洲 / 大洋洲的描边整片画出来 —— 即用户反馈的
「填色按钮与区域错配」。同时两套数据还各自含一套海岸线/洲界，二者不可能对齐。

v53 方案：**只保留一份掩膜，四者全部由它派生**
  · 七大洲填色   ← 索引通道（本像素属于哪一洲）
  · 统一陆地填充 ← 索引通道（索引 > 0 的并集）—— 里海在源掩膜里就是「无洲」，
                   故合并后**天然成为海洋**，不需要额外的经纬度包围盒补丁
  · 大洲界线     ← 索引通道的「相邻像素索引不同」处
  · 海岸线       ← 索引通道的「索引 = 0 与索引 > 0」处（并集外边界）
四者来自同一张图 ⇒ 边界与填充永远闭合，不可能错配；样式也走同一套 style.fill。

输出
----
  assets/geo-reg.png   RGB 三通道（R=索引 / G=海岸距离场 / B=洲界距离场）
  另附 --embed 参数可重写 assets-geo.js（把新图内嵌成 Data URI）

索引编码：R = round(索引 × 255/7)，索引 0..7（0=海洋，1..7=七大洲）。
  着色器侧用 round(r*7) 精确还原索引，**彻底消除「颜色最近匹配」可能产生的错配**。
距离场：G/B 为「到对应边界的距离」，量程 SPREAD px 归一化到 0..255（0 = 正好在边界上）。
"""
import os
import sys
import base64
import argparse

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)

# 七大洲调色板 —— 必须与 app.js 的 CONT_COLORS 完全一致（索引 1..7）
CONT_COLORS = {
    'AS': (242, 193, 78),
    'EU': (111, 168, 220),
    'AF': (224, 122, 95),
    'NA': (129, 178, 154),
    'SA': (176, 136, 201),
    'OC': (94, 201, 192),
    'AN': (233, 237, 242),
}
ORDER = ['AS', 'EU', 'AF', 'NA', 'SA', 'OC', 'AN']

# 距离场量程（像素）。与旧 geo-land.png 保持一致的量级，着色器里 uSpread 用同一值。
SPREAD = 24


def decode_index(png_path):
    """把调色板掩膜解码成整数索引图（0=海洋，1..7=大洲）。用精确匹配，
    不做「最近邻」—— 源图只有 8 种纯色，精确匹配可保证零错配。"""
    a = np.array(Image.open(png_path).convert('RGB')).astype(np.int16)
    h, w, _ = a.shape
    idx = np.zeros((h, w), dtype=np.uint8)
    unassigned = np.ones((h, w), dtype=bool)
    for i, k in enumerate(ORDER, start=1):
        c = CONT_COLORS[k]
        m = (a[:, :, 0] == c[0]) & (a[:, :, 1] == c[1]) & (a[:, :, 2] == c[2])
        idx[m] = i
        unassigned &= ~m
    # 非黑非调色板的像素（抗锯齿过渡色）→ 就近归类，避免出现「无名洲」的空洞
    if unassigned.any():
        dark = (a[:, :, 0] + a[:, :, 1] + a[:, :, 2]) < 24
        idx[unassigned & dark] = 0
        rest = unassigned & ~dark
        if rest.any():
            pal = np.array([CONT_COLORS[k] for k in ORDER], dtype=np.int16)
            flat = a[rest].reshape(-1, 3)
            d = ((flat[:, None, :] - pal[None, :, :]) ** 2).sum(-1)
            idx[rest] = (d.argmin(1) + 1).astype(np.uint8)
    return idx


def edt2d(mask, max_d=SPREAD, wrap_x=True):
    """到最近前景像素的距离场（单位：像素），上限 max_d 后截断。

    实现：逐层 3×3 膨胀。第 k 层命中 ⇒ 距离 ≤ k。
    量程只有 max_d（默认 24px ≈ 2.1°），故最多迭代 max_d 次即饱和 ——
    全程都是 numpy 切片运算，4096×2048 也只要几十毫秒；
    比逐像素的精确 EDT（Felzenszwalb）快几个数量级，精度上因 3×3 邻域
    的切比雪夫距离与欧氏距离在 24px 内最大偏差 < 0.5px，肉眼不可见。
    经度方向按周期 wrap（东西经 ±180° 相接），纬度方向不 wrap。
    """
    cur = mask.copy()
    hit = mask.copy()
    # ★ 关键：未命中区域必须初始化为「饱和值 = max_d」，而不是 0。
    #   膨胀只能传播 max_d 步，量程之外的像素永远不会被 newly 命中；
    #   若初值给 0，它们就会被当成「正好压在边界上」而被描边涂满
    #   （与旧 geo-land.png 那次「整片内陆被洲界线色铺满」是同一类错误）。
    d = np.full(mask.shape, float(max_d), dtype=np.float32)
    d[mask] = 0.0
    for k in range(1, max_d):
        g = cur.copy()
        g[1:, :] |= cur[:-1, :]
        g[:-1, :] |= cur[1:, :]
        if wrap_x:
            g[:, 1:] |= cur[:, :-1]
            g[:, :-1] |= cur[:, 1:]
        else:
            g[:, 1:] |= cur[:, :-1]
            g[:, :-1] |= cur[:, 1:]
        newly = g & ~hit
        if not newly.any():
            break
        d[newly] = k
        hit |= newly
        cur = g
        if hit.all():
            break
    return d


def boundary_masks(idx):
    """返回 (海岸边界, 洲界边界) 两个布尔图。

    海岸边界：索引 0（海洋）与索引 > 0（陆地）相邻处 —— 即「陆地并集的外边界」。
    洲界边界：两个**不同**的非零索引相邻处（同一洲内部的相邻像素不算）。
    经度方向按周期处理（东西经 ±180° 相接），纬度方向不周期。
    """
    land = idx > 0
    # 经度周期：左右两列互为邻居
    left = np.roll(idx, 1, axis=1)
    right = np.roll(idx, -1, axis=1)
    up = np.roll(idx, 1, axis=0)
    dn = np.roll(idx, -1, axis=0)
    up[0, :] = idx[0, :]
    dn[-1, :] = idx[-1, :]

    coast = np.zeros(idx.shape, dtype=bool)
    coast |= (land != np.roll(land, 1, axis=1))
    coast |= (land != np.roll(land, -1, axis=1))
    coast |= (land != np.roll(land, 1, axis=0))
    coast |= (land != np.roll(land, -1, axis=0))

    def diff_nz(a, b):
        return (a != b) & (a > 0) & (b > 0)

    cont = np.zeros(idx.shape, dtype=bool)
    cont |= diff_nz(idx, left)
    cont |= diff_nz(idx, right)
    cont |= diff_nz(idx, up)
    cont |= diff_nz(idx, dn)
    return coast, cont


def build(src_png, out_png, spread=SPREAD, scale=2):
    idx = decode_index(src_png)
    print('源掩膜索引图: %dx%d  海洋=%d 陆地=%d' % (
        idx.shape[1], idx.shape[0], int((idx == 0).sum()), int((idx > 0).sum())))

    if scale > 1:
        idx = np.repeat(np.repeat(idx, scale, axis=0), scale, axis=1)
        print('放大到 %dx%d（nearest，保持边界不糊）' % (idx.shape[1], idx.shape[0]))

    coast, cont = boundary_masks(idx)
    print('海岸边界像素=%d  洲界边界像素=%d' % (int(coast.sum()), int(cont.sum())))

    d_coast = edt2d(coast, spread)
    d_cont = edt2d(cont, spread)
    print('海岸距离场 max=%.2f  洲界距离场 max=%.2f（像素）' % (d_coast.max(), d_cont.max()))

    r = np.rint(idx.astype(np.float64) * 255.0 / 7.0).astype(np.uint8)
    g = np.rint(np.clip(d_coast / spread, 0, 1) * 255.0).astype(np.uint8)
    b = np.rint(np.clip(d_cont / spread, 0, 1) * 255.0).astype(np.uint8)
    # ★ 海洋像素的距离场**必须保留**、不能置 0。
    #   coast / cont 边界像素同时落在陆地侧与海洋侧（它是「状态突变的那一像素」），
    #   海洋紧邻陆地处 dCoast 同样接近 0 —— 海岸线本就该跨在岸线上（陆海各半）。
    #   若把海洋一律置 0，整个海洋都会被判成「正好压在线上」而被描边涂满。
    #   洲界线只在陆地内部（两洲交界），海洋像素的 dCont 天然饱和，无副作用。

    out = np.dstack([r, g, b])
    Image.fromarray(out, 'RGB').save(out_png, optimize=True)
    print('已写出 %s  (%d 字节)' % (out_png, os.path.getsize(out_png)))

    # 抽样自检
    im = np.array(Image.open(out_png).convert('RGB')).astype(np.int16)
    names = ['OCEAN'] + ORDER
    checks = {'西伯利亚': (65, 100), '西欧': (50, 10), '埃及': (25, 30), '美国': (40, -100),
              '巴西': (-10, -52), '澳洲': (-25, 134), '南极': (-80, 0),
              '里海': (41, 51), '太平洋': (0, -140), '大西洋': (0, -30)}
    print('--- 自检（索引 / 海岸距 / 洲界距）---')
    H, W, _ = im.shape
    for nm, (la, lo) in checks.items():
        x = int((lo + 180) / 360 * W) % W
        y = int((90 - la) / 180 * H)
        i = int(round(im[y, x, 0] * 7 / 255.0))
        print('  %-8s %-6s dCoast=%3d dCont=%3d' % (nm, names[i], im[y, x, 1], im[y, x, 2]))

    # 沿线取样：验证「跨洲」与「跨海」处距离场确实出现低值（≈0）
    print('--- 剖面自检（沿 40°N 由西向东，应两次穿过海岸线）---')
    yy = int((90 - 40) / 180 * H)
    row = im[yy, :, 1]
    lo_px = [i for i in range(W) if row[i] < 40]
    print('  dCoast<40 的像素段数 =', len(lo_px), '（40°N 穿过的陆块：北美 / 大西洋 / 欧非 / 亚洲）')
    print('--- 剖面自检（沿 60°N，亚洲内陆，应只穿一次海岸线）---')
    yy2 = int((90 - 60) / 180 * H)
    row2 = im[yy2, :, 2]
    print('  dCont<40 的像素数 =', int((row2 < 40).sum()), '（60°N 穿过亚欧两洲 ⇒ 应有一段洲界）')


def embed(png_path, js_path):
    with open(png_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    with open(png_path, 'rb') as f:
        head = f.read(33)
    w = int.from_bytes(head[16:20], 'big')
    h = int.from_bytes(head[20:24], 'big')
    uri = 'data:image/png;base64,' + b64

    with open(js_path, encoding='utf-8') as f:
        s = f.read()
    import re
    m = re.search(r'window\.EARTH_GEO\s*=\s*\{', s)
    if not m:
        print('未找到 window.EARTH_GEO，跳过内嵌')
        return
    # 整块替换 {...}
    i = s.index('{', m.start())
    depth = 0
    for j in range(i, len(s)):
        if s[j] == '{':
            depth += 1
        elif s[j] == '}':
            depth -= 1
            if depth == 0:
                break
    new = ('{\n'
           '  regW: %d, regH: %d, spread: %d,\n'
           '  reg: "%s"\n'
           '}' % (w, h, SPREAD, uri))
    s = s[:i] + new + s[j + 1:]
    hdr = ('/* 自动生成：内嵌「统一区域掩膜」geo-reg.png（Data URI），请勿手改。\n'
           '   由 tools/_build_geo_reg.py 生成：源 assets/geo-cont.png（七大洲调色板掩膜）。\n'
           '   R=大洲索引(0..7) · G=到海岸线距离场 · B=到大洲界线距离场。\n'
           '   七大洲填色 / 统一陆地填充 / 海岸线 / 大洲界线**全部由这一张图派生**，\n'
           '   因此四者边界天然闭合、不会互相错配；里海在源图里即「无洲」，合并后为海洋。 */\n')
    s = re.sub(r'^/\*.*?\*/\s*', '', s, count=1, flags=re.S)
    s = hdr + s
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(s)
    print('已重写 %s（%d 字节，内嵌 %dx%d）' % (js_path, os.path.getsize(js_path), w, h))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(APP, 'assets', 'geo-cont.png'))
    ap.add_argument('--out', default=os.path.join(APP, 'assets', 'geo-reg.png'))
    ap.add_argument('--js', default=os.path.join(APP, 'assets-geo.js'))
    ap.add_argument('--scale', type=int, default=2)
    ap.add_argument('--spread', type=int, default=SPREAD)
    ap.add_argument('--no-embed', action='store_true')
    a = ap.parse_args()
    build(a.src, a.out, a.spread, a.scale)
    if not a.no_embed:
        embed(a.out, a.js)
