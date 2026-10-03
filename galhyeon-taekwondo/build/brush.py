"""붓 터치(드라이 브러시) SVG 생성기 — 표지·마무리 슬라이드의 태극 줄무늬, 빨간 붓 스윕, 별."""
import math
import random


def _bristle_path(L, T, rng, fringe=40, end_ragged=260, start_ragged=260):
    """가로로 누운 붓 자국 하나. (0..L, -T/2..T/2) 영역을 가는 털 자국들로 채운다.
    몸통은 거의 꽉 차되 가는 흰 결이 드문드문, 가장자리로 갈수록 끊기고 가늘어진다."""
    d = []
    y = -T / 2 - fringe
    while y < T / 2 + fringe:
        u = abs(y) / (T / 2)
        if u > 1 and rng.random() < 0.7:
            y += rng.uniform(3, 8)
            continue
        h = rng.uniform(1.4, 2.8) if u > 1 else rng.uniform(2.5, 5.5)
        if u <= 0.7:
            seg_mean, gap_rng, gap_p = 1400, (6, 50), 0.35
        elif u <= 1.0:
            seg_mean, gap_rng, gap_p = 260, (15, 160), 0.9
        else:
            seg_mean, gap_rng, gap_p = 70, (40, 400), 1.0
        x = rng.random() ** 1.3 * start_ragged * (0.4 + u)
        x_end = L - rng.random() ** 1.3 * end_ragged * (0.4 + u)
        nseg = 99
        if u > 1:
            x += rng.uniform(0, L * 0.85)
            nseg = rng.randint(1, 3)
        while x < x_end - 4 and nseg > 0:
            nseg -= 1
            ln = min(rng.expovariate(1 / seg_mean) + 12, x_end - x)
            d.append(f"M{x:.0f} {y:.1f}h{ln:.0f}v{h:.1f}h{-ln:.0f}z")
            x += ln
            if rng.random() < gap_p:
                x += rng.uniform(*gap_rng)
        y += h * rng.uniform(0.5, 0.9)
    return "".join(d)


def band(p0, angle_deg, offset, s0, s1, T, color, seed, opacity=1.0, end_ragged=260, start_ragged=260):
    """p0를 지나는 기준선(angle)에서 법선 방향으로 offset 떨어진 줄무늬. s0..s1 = 진행 방향 범위."""
    rng = random.Random(seed)
    a = math.radians(angle_deg)
    ux, uy = math.cos(a), math.sin(a)
    nx, ny = -uy, ux  # 오른쪽 아래를 향하는 법선
    if ny < 0:
        nx, ny = -nx, -ny
    sx = p0[0] + nx * offset + ux * s0
    sy = p0[1] + ny * offset + uy * s0
    L = s1 - s0
    path = _bristle_path(L, T, rng, end_ragged=end_ragged, start_ragged=start_ragged)
    return (f'<g transform="translate({sx:.1f} {sy:.1f}) rotate({angle_deg})" opacity="{opacity}" filter="url(#rough)">'
            f'<path fill="{color}" d="{path}"/></g>')


def swoosh(p0, p1, ctrl, w, color, seed, streaks=7):
    """빨간 붓 스윕: 시작은 굵고 끝은 가늘게 빠지는 획 + 마른 붓 결."""
    rng = random.Random(seed)

    def pt(t):
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * ctrl[0] + t * t * p1[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * ctrl[1] + t * t * p1[1]
        return x, y

    def nrm(t):
        dx = 2 * (1 - t) * (ctrl[0] - p0[0]) + 2 * t * (p1[0] - ctrl[0])
        dy = 2 * (1 - t) * (ctrl[1] - p0[1]) + 2 * t * (p1[1] - ctrl[1])
        l = math.hypot(dx, dy) or 1
        return -dy / l, dx / l

    def width(t):
        return w * min(1, t * 7) * (1 - t) ** 0.55

    n = 40
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        (x, y), (nx, ny), ww = pt(t), nrm(t), width(t) / 2
        left.append((x + nx * ww, y + ny * ww))
        right.append((x - nx * ww, y - ny * ww))
    poly = left + right[::-1]
    out = [f'<path fill="{color}" d="M' + " L".join(f"{x:.1f} {y:.1f}" for x, y in poly) + 'Z"/>']
    for _ in range(streaks):  # 획 가장자리의 마른 붓 결
        off = rng.uniform(-0.75, 0.75)
        t0, t1 = rng.uniform(0.15, 0.5), rng.uniform(0.6, 1.0)
        pts = []
        for i in range(12):
            t = t0 + (t1 - t0) * i / 11
            (x, y), (nx, ny) = pt(t), nrm(t)
            k = off * width(t0) * 0.9
            pts.append((x + nx * k, y + ny * k))
        out.append(f'<path fill="none" stroke="{color}" stroke-width="{rng.uniform(1.2, 2.6):.1f}" '
                   f'stroke-linecap="round" d="M' + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + '"/>')
    return "".join(out)


def star(cx, cy, r, color, rot=0, stroke=None):
    """둥근 모서리 별."""
    pts = []
    for i in range(10):
        rr = r if i % 2 == 0 else r * 0.47
        a = math.radians(rot - 90 + i * 36)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"
    sw = r * 0.16
    return (f'<path d="{d}" fill="{color}" stroke="{stroke or color}" stroke-width="{sw:.1f}" '
            f'stroke-linejoin="round"/>')
