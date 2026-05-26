"""
Generates the Map Key page — a separate SVG listing every abbreviation with
its full street name and cardinal direction, matching the Lighthouse TMAP format:

  Map Key
  ○  <address>
     <city, state>
  —  Street
  MRK  Market St -- NE-SW
  ...
"""
from __future__ import annotations
from pathlib import Path

import svgwrite

from .labeler import MarginLabel


_UI_FONT  = "Arial, sans-serif"
_BODY_SIZE = 14
_TITLE_SIZE = 20
_LINE_H    = 22
_MARGIN    = 60


def _build(
    labels: list[MarginLabel],
    address: str,
    width: int,
    height: int,
    tactile: bool,
    font_family: str,
    font_size: int,
) -> svgwrite.Drawing:
    dwg = svgwrite.Drawing(size=(f"{width}px", f"{height}px"), viewBox=f"0 0 {width} {height}")
    dwg.add(dwg.rect((0, 0), (width, height), style="fill:white"))

    # Shared text style helpers
    def txt(content, x, y, size=None, anchor="start", weight="normal", color="black"):
        s = (
            f"font-family:{font_family};"
            f"font-size:{size or font_size}px;"
            f"font-weight:{weight};"
            f"text-anchor:{anchor};"
            f"fill:{color}"
        )
        dwg.add(dwg.text(content, insert=(x, y), style=s))

    cx = width / 2
    y = _MARGIN

    # Title
    txt("Map Key", cx, y, size=_TITLE_SIZE, anchor="middle", weight="bold")
    y += _TITLE_SIZE + 10

    # Address line with circle marker
    r = 8
    dwg.add(dwg.circle(center=(_MARGIN, y - r / 2), r=r, style="fill:none;stroke:black;stroke-width:2"))
    txt(address, _MARGIN + r * 2 + 6, y, size=_BODY_SIZE)
    y += _LINE_H

    # Street line symbol
    line_x0, line_x1 = _MARGIN, _MARGIN + 40
    line_y = y - font_size / 2
    dwg.add(dwg.line((line_x0, line_y), (line_x1, line_y), style="stroke:black;stroke-width:1.5"))
    txt("Street", line_x1 + 8, y, size=_BODY_SIZE)
    y += _LINE_H * 1.5

    # Sorted legend rows: abbreviation  Full Name -- Direction
    sorted_labels = sorted(
        {lbl.text: lbl for lbl in labels}.values(),  # deduplicate by abbreviation
        key=lambda l: l.text,
    )
    col_abbr = _MARGIN
    col_name = _MARGIN + 60

    for lbl in sorted_labels:
        txt(lbl.text, col_abbr, y, size=_BODY_SIZE, weight="bold")
        txt(f"{lbl.full_name} -- {lbl.direction}", col_name, y, size=_BODY_SIZE)
        y += _LINE_H

    return dwg


def build_legend(
    labels: list[MarginLabel],
    address: str,
    width: int,
    height: int,
    tactile: bool = False,
) -> svgwrite.Drawing:
    from .config import LABEL_FONT_TACTILE, LABEL_FONT_PRINT, LABEL_FONT_SIZE_TACTILE, LABEL_FONT_SIZE_PRINT
    font_family = LABEL_FONT_TACTILE if tactile else LABEL_FONT_PRINT
    font_size   = LABEL_FONT_SIZE_TACTILE if tactile else _BODY_SIZE
    return _build(labels, address, width, height, tactile, font_family, font_size)
