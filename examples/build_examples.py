#!/usr/bin/env python3
"""Put example marks into the survey page.

Drop sketchpad (or survey) mark files into examples/line, examples/short or
examples/dot, then run from the marks-survey folder:

    python3 examples/build_examples.py

Each mark is drawn as an inline SVG (sharp at any size), with the board's
guides shown faintly behind it, and written into index.html between the
<!-- examples:line -->, <!-- examples:short --> and <!-- examples:dot -->
markers. Files are shown in filename order (i.e. the order you drew them).
"""
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE.parent / 'index.html'
KINDS = ['line', 'short', 'dot']
LABELS = {'line': 'Example long lines', 'short': 'Example short lines', 'dot': 'Example dots'}
NAMES = {'line': 'long line', 'short': 'short line', 'dot': 'dot'}
GUIDE = '#85857f'  # same as the drawing boards on the page
THIN_MM = 0.6  # skip points closer than this, like the page's on-screen smoothing


def drawings_in(data):
    if isinstance(data.get('drawings'), list):
        return data['drawings']
    return [data['drawing']] if data.get('drawing') else []


def kind_of(d):
    t = d.get('template')
    if t in KINDS:
        return t
    return 'line' if (d.get('board') or {}).get('width') == 210 else None


def thin(p):
    if len(p) < 3:
        return p
    out, last = [p[0]], p[0]
    for q in p[1:-1]:
        if math.hypot(q[0] - last[0], q[1] - last[1]) >= THIN_MM:
            out.append(q)
            last = q
    if p[-1] != last:
        out.append(p[-1])
    return out


def average(p):
    if len(p) < 3:
        return p
    return [p[0]] + [((p[i-1][0] + 2*p[i][0] + p[i+1][0]) / 4, (p[i-1][1] + 2*p[i][1] + p[i+1][1]) / 4)
                     for i in range(1, len(p) - 1)] + [p[-1]]


def f(n):
    s = f'{n:.2f}'.rstrip('0').rstrip('.')
    return s if s != '-0' else '0'


def path_d(points):
    p = average(thin([(pt[0], pt[1]) for pt in points]))
    if len(p) == 1:
        return None, p[0]
    d = [f'M{f(p[0][0])} {f(p[0][1])}']
    for i in range(len(p) - 1):  # Catmull-Rom, as on the page
        p0 = p[i-1] if i > 0 else p[i]
        p1, p2 = p[i], p[i+1]
        p3 = p[i+2] if i + 2 < len(p) else p2
        d.append('C' + ' '.join(f(v) for v in (
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1])))
    return ''.join(d), None


def guides_svg(d):
    g = d.get('guides') or {}
    out = []
    c = g.get('circles')
    if c:
        for r in (c['innerRadius'], c['outerRadius']):
            out.append(f'<circle cx="{f(c["x"])}" cy="{f(c["y"])}" r="{f(r)}" fill="none" stroke="{GUIDE}" stroke-width="1" vector-effect="non-scaling-stroke"/>')
    dots = g.get('dots') or d.get('dots')
    if dots:
        r = dots.get('radius', 2.5)
        for role, col in (('start', '#4a9463'), ('end', '#d0654c')):
            if role in dots:
                out.append(f'<circle cx="{f(dots[role]["x"])}" cy="{f(dots[role]["y"])}" r="{f(r)}" fill="{col}"/>')
    return out


def mark_svg(d, label):
    w, h = d['board']['width'], d['board']['height']
    parts = guides_svg(d)
    for s in d.get('strokes', []):
        pd, dot = path_d(s['points'])
        sw = f(s.get('w', 5.398))
        if pd:
            parts.append(f'<path d="{pd}" fill="none" stroke="#000" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>')
        else:
            parts.append(f'<circle cx="{f(dot[0])}" cy="{f(dot[1])}" r="{f(s.get("w", 5.398) / 2)}" fill="#000"/>')
    return (f'<svg viewBox="0 0 {f(w)} {f(h)}" style="aspect-ratio:{f(w)}/{f(h)}" role="img" aria-label="{label}">'
            + ''.join(parts) + '</svg>')


def block(kind):
    files = sorted((HERE / kind).glob('*.json'))
    svgs = []
    for fp in files:
        data = json.loads(fp.read_text())
        for d in drawings_in(data):
            if kind_of(d) == kind and d.get('strokes'):
                svgs.append(mark_svg(d, f'Example {NAMES[kind]} {len(svgs) + 1}'))
    if not svgs:
        return None, 0
    html = (f'<div class="examples examples-{kind}" role="group" aria-label="{LABELS[kind]}">\n'
            + ''.join(f'        {s}\n' for s in svgs) + '      </div>')
    return html, len(svgs)


def main():
    page = PAGE.read_text()
    for kind in KINDS:
        html, n = block(kind)
        pat = re.compile(rf'<!-- examples:{kind} -->.*?<!-- /examples:{kind} -->', re.S)
        if not pat.search(page):
            print(f'{kind}: no marker in index.html, skipped')
            continue
        if html is None:
            print(f'{kind}: no example files, left as is')
            continue
        page = pat.sub(lambda m: f'<!-- examples:{kind} -->\n      {html}\n      <!-- /examples:{kind} -->', page)
        print(f'{kind}: {n} examples')
    PAGE.write_text(page)


if __name__ == '__main__':
    sys.exit(main())
