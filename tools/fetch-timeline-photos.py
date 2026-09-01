# -*- coding: utf-8 -*-
"""
絶景掲示板の時間軸で使う空中写真を、国土地理院のタイルから作る。

**なぜダウンロードして持つのか。**
ADR-0001 で「地図はタイルを使わず自作イラストとする」と決めてあるので、画面から
タイルサーバーを直接叩くことはしない。ADR-0003 で陰影起伏図を落として持っている
のと同じやり方で、ここでも**ファイルにしてリポジトリへ置く**。

**どの写真を使えるか（2026-08-27 に実測）**

    gazo1   1974〜1978年撮影   銚子にあり   縮尺17まで
    ort     2007年以降（最新） 銚子にあり   縮尺18まで

    ort_USA10（1945〜50）・ort_old10（1961〜64）・gazo2〜gazo4 は銚子を覆っていない。
    **1923年の空中写真は存在しない。** 撮影という手段そのものが無かった。

両方そろって使えるのは縮尺17までなので、**17に揃える**。片方だけ細かくすると、
並べたときに「昔のほうが粗い」という見え方の差が、土地の変化に見えてしまう。

**撮影年のずれを隠さないこと。** gazo1 は1974〜1978年撮影で、時間軸の真ん中に
置いている1981年度とは3〜7年ずれている。画面では必ず「国土地理院 1974〜1978年撮影」
と出す（data/choshi/timeline.json の aerialPhoto に文言がある）。

出典表示は必須。出典: 国土地理院タイル https://maps.gsi.go.jp/development/ichiran.html

使い方:
    python tools/fetch-timeline-photos.py

書き出し先: assets/choshi/timeline/{地物のid}-{時点のid}.webp
"""
import io
import json
import math
import os
import sys
import time
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMELINE = os.path.join(ROOT, "data", "choshi", "timeline.json")
OUT_DIR = os.path.join(ROOT, "assets", "choshi", "timeline")

ZOOM = 17
TILE = 256
# 切り出す大きさ。右パネルの幅（約300px）に対して2倍で足りる。
CROP_W, CROP_H = 600, 420
QUALITY = 80

# HTTPヘッダは latin-1 しか通らない。**日本語を書かないこと**——
# 書くと urlopen が UnicodeEncodeError で落ち、全部のタイルが「欠け」に見える
# （実際に一度そうなった。ネットワークの問題だと勘違いしやすい）。
UA = "2026Expo-board/1.0 (Geo Activity Contest entry; student project)"


def lonlat_to_pixel(lat, lon, z):
    """世界全体を1枚の画像と見たときの画素座標（縮尺zでの）"""
    n = 2 ** z * TILE
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(tileset, z, x, y):
    url = f"https://cyberjapandata.gsi.go.jp/xyz/{tileset}/{z}/{x}/{y}.jpg"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            if r.status != 200:
                return None
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception:
        return None


def crop_at(tileset, lat, lon):
    """中心 (lat,lon) の周りを CROP_W×CROP_H で切り出す。1枚でも欠けたら None"""
    px, py = lonlat_to_pixel(lat, lon, ZOOM)
    left, top = px - CROP_W / 2, py - CROP_H / 2
    tx0, ty0 = int(left // TILE), int(top // TILE)
    tx1, ty1 = int((left + CROP_W) // TILE), int((top + CROP_H) // TILE)

    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE))
    missing = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            img = fetch_tile(tileset, ZOOM, tx, ty)
            if img is None:
                missing += 1
                continue
            canvas.paste(img, ((tx - tx0) * TILE, (ty - ty0) * TILE))
            # 相手は公共のタイルサーバーなので、続けざまに叩かない
            time.sleep(0.12)
    if missing:
        return None, missing
    ox, oy = left - tx0 * TILE, top - ty0 * TILE
    return canvas.crop((int(ox), int(oy), int(ox) + CROP_W, int(oy) + CROP_H)), 0


def main():
    with io.open(TIMELINE, encoding="utf-8") as f:
        tl = json.load(f)

    aerial = tl["aerialPhoto"]
    targets = [(f["id"], f["name"], f["lat"], f["lon"]) for f in tl["features"]]

    os.makedirs(OUT_DIR, exist_ok=True)
    made, skipped = 0, []

    for point_id, spec in aerial.items():
        if not spec:
            # 1923年。空中写真そのものが存在しない
            continue
        tileset = spec["tileset"]
        for fid, name, lat, lon in targets:
            out = os.path.join(OUT_DIR, f"{fid}-{point_id}.webp")
            if os.path.exists(out):
                print(f"  すでにある: {os.path.relpath(out, ROOT)}")
                continue
            print(f"  取得中 {name} / {spec['capturedLabel']} ...", flush=True)
            img, missing = crop_at(tileset, lat, lon)
            if img is None:
                skipped.append(f"{fid}-{point_id}（タイルが{missing}枚欠け）")
                continue
            img.save(out, "WEBP", quality=QUALITY, method=6)
            made += 1
            print(f"    → {os.path.relpath(out, ROOT)}  {os.path.getsize(out) // 1024}KB")

    print("")
    print(f"作った枚数: {made}")
    if skipped:
        print("取れなかったもの（画面には出さないので、欠けたまま動く）:")
        for s in skipped:
            print("  -", s)
    print("")
    print("出典表示を忘れないこと: 国土地理院")


if __name__ == "__main__":
    sys.exit(main())
