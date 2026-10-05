"""v54：地方时间滑块**像素级**对账。

不变量（不受 thumb / 刻度圆点遮挡影响）：
  ① 轨道条左右端 == thumb 圆心行程两端（各内缩半个 thumb）。
  ② **昼夜分段边界**（夜→昼、日→夜的转折）必须落在 rise/24、set/24 处
     —— 这正是用户肉眼拿来对照「日出 / 日落」刻度圆点的那条线。
  ③ 刻度圆点圆心的归一化位置 == rise/24、set/24。

遮挡处理：thumb（白心）与刻度圆点（主题色实心）会打断「连续段」判定，
  故先按列在轨道条高度范围内对 D/N 投票，再用左右已知列线性插值补回被遮挡的列。

用法：
  python _pix_timebar.py                          # 批量（读 _shots/tb_sweep.json）
  python _pix_timebar.py <png> [rise_h] [set_h]  # 单文件，一行 JSON
"""
import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SWEEP = os.path.join(ROOT, "_shots", "tb_sweep.json")


def is_day(p):
    r, g, b = p
    return r > 150 and g > 120 and r >= b


def is_night(p):
    r, g, b = p
    return b >= g and b > 18 and r < 130


def analyse(png, rise_h=None, set_h=None):
    im = Image.open(png).convert("RGB")
    px = im.load()
    W, H = im.size
    ymid = H // 2
    y0, y1 = max(0, ymid - 3), min(H, ymid + 4)

    def col_cls(x):
        d = n = 0
        for y in range(y0, y1):
            p = px[x, y]
            if is_day(p):
                d += 1
            elif is_night(p):
                n += 1
        if d > n:
            return "D"
        if n > d:
            return "N"
        return "."

    raw = [col_cls(x) for x in range(W)]
    xs = [x for x in range(W) if raw[x] in "DN"]
    if not xs:
        return {"png": os.path.basename(png), "err": "no bar"}
    L, R = min(xs), max(xs)
    Wb = R - L + 1

    # 插值补回被 thumb / 圆点遮挡的列
    col = list(raw[L:R + 1])
    known = [i for i, k in enumerate(col) if k in "DN"]
    for i, k in enumerate(col):
        if k == ".":
            lo = max([j for j in known if j < i], default=None)
            hi = min([j for j in known if j > i], default=None)
            if lo is not None and hi is not None:
                col[i] = col[lo] if (col[lo] == col[hi] or
                                     abs(i - lo) <= abs(i - hi)) else col[hi]
            elif lo is not None:
                col[i] = col[lo]
            elif hi is not None:
                col[i] = col[hi]

    bounds = [i + 0.5 for i in range(1, Wb) if col[i] != col[i - 1] and col[i] in "DN" and col[i - 1] in "DN"]
    out = {"png": os.path.basename(png), "barL": L, "barR": R, "barW": Wb,
           "boundsQ": [round(b / Wb, 4) for b in bounds]}
    if rise_h is not None and set_h is not None:
        rq, sq = rise_h / 24.0, set_h / 24.0
        out["riseQ"], out["setQ"] = round(rq, 4), round(sq, 4)
        if bounds:
            out["riseErrPx"] = round(bounds[0] - rq * Wb, 2)
            out["setErrPx"] = round(bounds[-1] - sq * Wb, 2)
    return out


def main():
    if len(sys.argv) > 1:
        a = float(sys.argv[2]) if len(sys.argv) > 2 else None
        b = float(sys.argv[3]) if len(sys.argv) > 3 else None
        print(json.dumps(analyse(sys.argv[1], a, b), ensure_ascii=False))
        return
    steps = json.load(open(SWEEP, encoding="utf-8"))
    for s in steps:
        print(json.dumps(analyse(s["png"], s.get("rise"), s.get("set")), ensure_ascii=False))


if __name__ == "__main__":
    main()
