# -*- coding: utf-8 -*-
"""
配信する陰影起伏図（terrain-hillshade.webp）を、元の PNG から作る。

これまでは PIL の一行（README に書いてあった）で PNG をそのまま WebP に
していた。それだと銚子電鉄で 241KB、有楽町線で 1,137KB あり、スマートフォンで
開いたときの転送量の大半をこれ 1 枚が占めていた。展開後の画素も 11MB / 28MB で、
半透明の重ね合わせ（mix-blend-mode: overlay）と合わさって描画も重い。

ここでやることは 2 つ。

1. 透明を捨てる。
   陰影の絵は海のところが透明で、そのぶん alpha を持っている。ところが
   WebP は alpha を失わずに持つので、そこが大きさに効く。この絵は
   overlay で重ねるためだけのもので、**50% の灰は overlay では何もしない色**
   （backdrop がそのまま残る）。だから透明のところを 50% 灰で埋めれば、
   見た目を変えずに alpha を丸ごと捨てられる。

2. 小さくする。
   地図の座標系は横 1000。画面いっぱいに広げても、いまどきの携帯電話で
   横 1200 画素あれば足りる。元の絵はそれより大きい（銚子 1410・有楽町 2784）。
   拡大していくと甘くなるが、これは地形の陰影であって読む対象ではない。

使い方:
    python tools/shrink-hillshade.py data/source/terrain-hillshade.png data/choshi/terrain-hillshade.webp
    python tools/shrink-hillshade.py data/source/yurakucho-hillshade.png data/yurakucho/terrain-hillshade.webp

元の PNG を作るのは tools/fetch-hillshade.js（国土地理院の陰影起伏図タイルを
貼り合わせる）。PNG のほうは配信しない（.gitignore に入れてある）。
"""

import os
import sys

from PIL import Image

# 横幅の上限（画素）。地図の座標系（横 1000）に対して少し余裕を持たせる
MAX_WIDTH = 1200

# WebP の品質。陰影は輪郭の無いなめらかな絵なので、低めでも粗が出にくい
QUALITY = 72

# overlay 合成で「何もしない」明るさ。透明だったところをこれで埋める
NEUTRAL = 128


def build(src_path, out_path):
    source = Image.open(src_path).convert('LA')
    shade, alpha = source.split()

    # 透明なところを 50% 灰に置きかえて、alpha を捨てる
    flat = Image.composite(shade, Image.new('L', source.size, NEUTRAL), alpha)

    width, height = source.size
    if width > MAX_WIDTH:
        height = round(height * MAX_WIDTH / width)
        width = MAX_WIDTH
        flat = flat.resize((width, height), Image.LANCZOS)

    # WebP に灰色 1 色の形式は無いので、同じ値を 3 つ並べて RGB にする。
    # 中身が同じぶんは圧縮で畳まれるので、大きさへの響きはほとんど無い
    Image.merge('RGB', (flat, flat, flat)).save(
        out_path, 'WEBP', quality=QUALITY, method=6
    )

    before = os.path.getsize(src_path) / 1024
    after = os.path.getsize(out_path) / 1024
    print('%s  %dx%d  %.0f KB → %s  %dx%d  %.0f KB'
          % (src_path, source.size[0], source.size[1], before,
             out_path, width, height, after))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    build(sys.argv[1], sys.argv[2])
