"""deck.src.html → ../index.html
- 폰트를 사용 글자만 남겨(subset) base64로 HTML 안에 넣어 파일 하나로 어디서 열어도 같은 모양이 나오게 한다.
- 붓 터치 줄무늬·스윕·별 SVG를 생성해 끼워 넣는다.
실행: python3 build/build.py   (fonttools, brotli 필요)
"""
import base64
import html
import io
import os
import re

from fontTools import subset
from fontTools.ttLib import TTFont

from brush import band, star, swoosh

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONTS = os.path.join(ROOT, "fonts")

# 이름 → (파일, 수정 대비 KS X 1001 한글 2,350자 포함 여부)
FONT_FILES = {
    "Recipekorea": ("Recipekorea.woff", True),
    "Pretendard": ("PretendardVariable.woff2", True),
    "Manse": ("Manse.woff", False),
    "Sukyung": ("OnglyphSukyung.woff", False),
    "Montserrat": ("Montserrat-800.woff2", False),
}


def ksx1001_hangul():
    out = []
    for cp in range(0xAC00, 0xD7A4):
        try:
            chr(cp).encode("euc-kr")
            out.append(chr(cp))
        except UnicodeEncodeError:
            pass
    return "".join(out)


def subset_b64(path, text):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = TTFont(path)
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = "woff2"
    font.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


def brush_cover():
    """1장 표지 — 샘플 색 분포(80×45 격자)에서 잰 위치: 오른쪽 위 네이비, 아래 네이비, 오른쪽 아래 빨강."""
    return "".join([
        band((1470, 70), -24, 0, -420, 360, 250, "#1c2d6e", 11, start_ragged=360),
        band((1330, 300), -27, 0, -40, 480, 26, "#1c2d6e", 15, opacity=.9),
        band((960, 735), -40, 0, -520, 230, 175, "#1c2d6e", 12, end_ragged=380),
        band((1320, 700), -34, 0, -560, 520, 255, "#e2302c", 13),
    ])


def brush_ending():
    """9장 마무리 — 오른쪽 위 네이비, 가운데 빨강, 아래 왼쪽·오른쪽 네이비."""
    return "".join([
        band((1500, 110), -30, 0, -260, 300, 230, "#1c2d6e", 21, start_ragged=320),
        band((1200, 40), -9, 0, -150, 160, 48, "#1c2d6e", 24, opacity=.9),
        band((1530, 455), -42, 0, -760, 300, 215, "#e2302c", 22),
        band((960, 800), -33, 0, -420, 250, 180, "#1c2d6e", 23, end_ragged=360),
        band((1470, 780), -37, 0, -360, 400, 175, "#1c2d6e", 25),
    ])


def build():
    src = open(os.path.join(HERE, "deck.src.html"), encoding="utf-8").read()

    parts = {
        "BRUSH_COVER": brush_cover(),
        "BRUSH_ENDING": brush_ending(),
        # 1장 로고 위아래 빨간 붓 스윕 + 별
        "LOGO_SWOOSH": swoosh((470, 232), (720, 200), (600, 208), 15, "#e3312d", 31, 5)
                       + swoosh((900, 470), (1180, 405), (1050, 450), 13, "#e3312d", 32, 5),
        "LOGO_STAR": star(1300, 236, 46, "#e5352f", rot=12),
        # 9장 문구 아래 빨간 붓 스윕 + 별
        "END_SWOOSH": swoosh((150, 478), (320, 420), (230, 440), 12, "#e3312d", 41, 4)
                      + swoosh((540, 572), (890, 462), (730, 500), 17, "#e3312d", 42, 6),
        "END_STAR": star(846, 212, 58, "#e5352f", rot=8),
    }
    for k, v in parts.items():
        src = src.replace("{{" + k + "}}", v)

    # 화면에 보이는 글자 전부(+ 숫자·문장부호) 수집 → 폰트 서브셋
    visible = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<(script|style)[\s\S]*?</\1>", " ", src)))
    base = visible + "0123456789 .,:·()-–~!?'\"“”‘’/%+&★ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    full = base + ksx1001_hangul()
    css = []
    for fam, (fname, wide) in FONT_FILES.items():
        b64 = subset_b64(os.path.join(FONTS, fname), full if wide else base)
        weight = "100 900" if fam == "Pretendard" else "400"
        css.append(f'@font-face{{font-family:"{fam}";font-weight:{weight};font-display:block;'
                   f'src:url(data:font/woff2;base64,{b64}) format("woff2");}}')
    src = src.replace("/*{{FONTS}}*/", "\n".join(css))

    out = os.path.join(ROOT, "index.html")
    open(out, "w", encoding="utf-8").write(src)
    print("wrote", out, f"{os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    build()
