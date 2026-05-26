"""
Renders a FeatureSet into a print or tactile SVG map matching the Lighthouse
for the Blind TMAP format.

Label positioning formulas ported from lib/map_drawer/label_drawer.rb:
  LEFT  edge: svg_x = map_x0 - LEFT_PADDING,   svg_y = map_y0 + pos_y + Y_CENTER_PADDING
  RIGHT edge: svg_x = map_x0 + map_w + RIGHT_PADDING,  same y
  TOP   edge: svg_x = map_x0 + pos_x,           svg_y = map_y0 - TOP_PADDING
  BOTTOM edge: svg_x = map_x0 + pos_x,          svg_y = map_y0 + map_h + BOTTOM_PADDING

Address marker from lib/map_drawer/orientation_drawer.rb#draw_poi_locator:
  print:   white erase ring r=10 stroke-width=8px, dark ring r=10 stroke=#231f20 6px
  tactile: white fill circle r=16, dark ring r=10 stroke=#414042 2px

North arrow (Y-shape) from lib/map_drawer/orientation_drawer.rb#draw_orientation:
  line_x = map_w + 230 - 47  (= page_width - 47)
  vertical stem (cx, cy+36)→(cx, cy),  arms ±11 px, "N" text at (cx-8, 18)

Scale bar from lib/map_drawer/scale_drawer.rb:
  text at (page_width - 217, 18),  line at same x, y=32
  length = ZOOM_SCALE_FT[zoom] feet converted to pixels
"""
from __future__ import annotations
import base64
from pathlib import Path

import svgwrite
from shapely.geometry import MultiPolygon, Polygon

from .config import (
    FONTS_DIR,
    LABEL_FONT_PRINT, LABEL_FONT_SIZE_PRINT,
    LABEL_FONT_TACTILE, LABEL_FONT_SIZE_TACTILE,
    LEFT_PADDING, RIGHT_PADDING, TOP_PADDING, BOTTOM_PADDING, Y_CENTER_PADDING,
    ZOOM_SCALE_FT, METERS_TO_FEET,
)
from .features import FeatureSet, RoadFeature, RailwayFeature, PathwayFeature, PoiFeature
from .geometry import CoordTransformer
from .labeler import Abbreviator, MarginLabel, place_labels


# ---- road styles -----------------------------------------------------------
# Uniform thin strokes — from lib/map_drawer/road_drawer.rb / 02-osm_way_config.rb

_PRINT_ROAD      = "stroke:#414042;stroke-width:1.5;stroke-linecap:round;fill:none"
_TACTILE_ROAD    = "stroke:#414042;stroke-width:2.5;stroke-linecap:round;fill:none"

_PRINT_RAILWAY   = "stroke:#414042;stroke-width:1.5;stroke-dasharray:10 15;fill:none"
_TACTILE_RAILWAY = "stroke:#414042;stroke-width:2.5;stroke-dasharray:10 15;fill:none"

_PRINT_PATHWAY   = "stroke:#231f20;stroke-width:1;stroke-dasharray:3 9;fill:none"
_TACTILE_PATHWAY = "stroke:#231f20;stroke-width:1.5;stroke-dasharray:3 9;fill:none"

_PRINT_POI   = {
    "building": "fill:#9d9fa2;stroke:white;stroke-width:4px",
    "park":     "fill:#78D59F;stroke-width:0",
    "water":    "fill:#8EC4DE;stroke-width:0",
}
_TACTILE_POI = {
    "building": "fill:#000000;fill-opacity:0.2;stroke:#000000;stroke-width:1",
    "park":     "fill:none;stroke:#000000;stroke-width:1.5;stroke-dasharray:3 3",
    "water":    "fill:#000000;fill-opacity:0.1;stroke:#000000;stroke-width:1",
}

# ---- helpers ---------------------------------------------------------------

def _embed_font(path: Path) -> str | None:
    if not path.exists():
        return None
    data = base64.b64encode(path.read_bytes()).decode()
    return f"data:font/truetype;base64,{data}"


# ---- main class ------------------------------------------------------------

class SvgMap:
    def __init__(
        self,
        width: int,
        height: int,
        transformer: CoordTransformer,
        tactile: bool = False,
    ) -> None:
        self.width  = width
        self.height = height
        self.tx     = transformer
        self.tactile = tactile

        self.road_style    = _TACTILE_ROAD    if tactile else _PRINT_ROAD
        self.railway_style = _TACTILE_RAILWAY if tactile else _PRINT_RAILWAY
        self.pathway_style = _TACTILE_PATHWAY if tactile else _PRINT_PATHWAY
        self.poi_styles    = _TACTILE_POI     if tactile else _PRINT_POI
        self.font_size     = LABEL_FONT_SIZE_TACTILE if tactile else LABEL_FONT_SIZE_PRINT
        self.font_family   = LABEL_FONT_TACTILE      if tactile else LABEL_FONT_PRINT

        self.dwg = svgwrite.Drawing(
            size=(f"{width}px", f"{height}px"),
            viewBox=f"0 0 {width} {height}",
        )
        self._inject_fonts()

        # White background
        self.dwg.add(self.dwg.rect((0, 0), (width, height), style="fill:white"))

        # Layer groups (painters order)
        self.g_pois   = self.dwg.g(id="pois")
        self.g_roads  = self.dwg.g(id="roads")
        self.g_marker = self.dwg.g(id="marker")
        self.g_labels = self.dwg.g(id="labels")
        self.g_deco   = self.dwg.g(id="decorations")
        for g in [self.g_pois, self.g_roads, self.g_marker, self.g_labels, self.g_deco]:
            self.dwg.add(g)

        # Map border rectangle
        self.g_deco.add(self.dwg.rect(
            (self.tx.map_x0, self.tx.map_y0),
            (self.tx.map_w,  self.tx.map_h),
            style="fill:none;stroke:black;stroke-width:1",
        ))

    def _inject_fonts(self) -> None:
        rules: list[str] = []
        for fname, family in [("Braille29.ttf", "Braille29"), ("Arial.ttf", "Arial")]:
            uri = _embed_font(FONTS_DIR / fname)
            if uri:
                rules.append(
                    f"@font-face{{font-family:'{family}';src:url('{uri}') format('truetype');}}"
                )
        if rules:
            self.dwg.defs.add(self.dwg.style("".join(rules)))

    # ---- feature drawing ---------------------------------------------------

    def draw_pois(self, pois: list[PoiFeature]) -> None:
        for poi in pois:
            style = self.poi_styles.get(poi.kind, "fill:#CCCCCC")
            polys = poi.geometry.geoms if isinstance(poi.geometry, MultiPolygon) else [poi.geometry]
            for poly in polys:
                pts = self.tx.polygon_to_pixels(poly)
                if len(pts) >= 3:
                    self.g_pois.add(self.dwg.polygon(pts, style=style))

    def draw_roads(self, roads: list[RoadFeature]) -> None:
        for road in roads:
            pts = self.tx.linestring_to_pixels(road.geometry)
            if len(pts) >= 2:
                self.g_roads.add(self.dwg.polyline(pts, style=self.road_style))

    def draw_railways(self, railways: list[RailwayFeature]) -> None:
        for r in railways:
            pts = self.tx.linestring_to_pixels(r.geometry)
            if len(pts) >= 2:
                self.g_roads.add(self.dwg.polyline(pts, style=self.railway_style))

    def draw_pathways(self, pathways: list[PathwayFeature]) -> None:
        for p in pathways:
            pts = self.tx.linestring_to_pixels(p.geometry)
            if len(pts) >= 2:
                self.g_roads.add(self.dwg.polyline(pts, style=self.pathway_style))

    def draw_address_marker(self, lat: float, lon: float) -> None:
        """
        Port of lib/map_drawer/orientation_drawer.rb#draw_poi_locator.
        Print:   white erase ring (r=10, stroke-width=8px) then dark ring (stroke=#231f20, 6px)
        Tactile: white fill circle (r=16) then dark ring (r=10, stroke=#414042, 2px)
        """
        x, y = self.tx.to_pixel(lat, lon)
        if self.tactile:
            self.g_marker.add(self.dwg.circle(
                center=(x, y), r=16,
                style="fill:#ffffff;stroke:none",
            ))
            self.g_marker.add(self.dwg.circle(
                center=(x, y), r=10,
                style="fill:#ffffff;stroke:#414042;stroke-width:2px",
            ))
        else:
            self.g_marker.add(self.dwg.circle(
                center=(x, y), r=10,
                style="fill:#ffffff;stroke:#ffffff;stroke-width:8px",
            ))
            self.g_marker.add(self.dwg.circle(
                center=(x, y), r=10,
                style="fill:#ffffff;stroke:#231f20;stroke-width:6px",
            ))

    # ---- margin labels (no leader lines — Ruby style) ----------------------

    def draw_labels(self, labels: list[MarginLabel]) -> None:
        """
        Port of lib/map_drawer/label_drawer.rb.
        Labels sit at the map boundary with small padding offsets.  No leader lines.
        """
        tx = self.tx
        style_base = (
            f"font-family:{self.font_family};"
            f"font-size:{self.font_size}px;"
            f"fill:#000000"
        )

        for lbl in labels:
            if not lbl.resolved:
                continue

            px, py = lbl.pos_x, lbl.pos_y

            # SVG anchor and coordinates — Ruby label_drawer.rb formulas
            if px == 0:                         # left edge
                anchor = "end"
                svg_x  = tx.map_x0 - LEFT_PADDING
                svg_y  = tx.map_y0 + py + Y_CENTER_PADDING
            elif px == tx.map_w:                # right edge
                anchor = "start"
                svg_x  = tx.map_x0 + tx.map_w + RIGHT_PADDING
                svg_y  = tx.map_y0 + py + Y_CENTER_PADDING
            elif py == 0:                       # top edge
                anchor = "middle"
                svg_x  = tx.map_x0 + px
                svg_y  = tx.map_y0 - TOP_PADDING
            else:                               # bottom edge
                anchor = "middle"
                svg_x  = tx.map_x0 + px
                svg_y  = tx.map_y0 + tx.map_h + BOTTOM_PADDING

            self.g_labels.add(self.dwg.text(
                lbl.text,
                insert=(svg_x, svg_y),
                style=f"{style_base};text-anchor:{anchor}",
            ))

    # ---- decorations -------------------------------------------------------

    def draw_scale_bar(self, zoom: int, units: str = "feet") -> None:
        """
        Port of lib/map_drawer/scale_drawer.rb.
        Text at (page_width - 217, 18), line at same x, y=32.
        Length = ZOOM_SCALE_FT[zoom] feet (or ZOOM_SCALE_M[zoom] meters) → pixels.
        """
        from .config import ZOOM_SCALE_M
        if units == "meters":
            bar_val = ZOOM_SCALE_M.get(zoom, 150)
            bar_m   = float(bar_val)
            label   = f"{bar_val} m"
        else:
            bar_ft  = ZOOM_SCALE_FT.get(zoom, 500)
            bar_m   = bar_ft / METERS_TO_FEET
            label   = f"{bar_ft} ft"
        bar_px = self.tx.meters_to_pixels(bar_m)

        text_x = self.width - 217
        line_y = 32
        text_y = 18

        self.g_deco.add(self.dwg.line(
            (text_x, line_y), (text_x + bar_px, line_y),
            style="stroke:black;stroke-width:2px",
        ))
        for tx in [text_x, text_x + bar_px]:
            self.g_deco.add(self.dwg.line(
                (tx, line_y - 5), (tx, line_y + 5),
                style="stroke:black;stroke-width:2px",
            ))
        font = f"font-family:{'Braille29' if self.tactile else 'Arial'},sans-serif"
        self.g_deco.add(self.dwg.text(
            label,
            insert=(text_x, text_y),
            style=f"{font};font-size:{self.font_size}px;text-anchor:start;fill:black",
        ))

    def draw_north_arrow(self) -> None:
        """
        Port of lib/map_drawer/orientation_drawer.rb#draw_orientation.
        Y-shape: vertical stem + two arms; 'N' label above.
        Position: (page_width - 47, 32)  i.e. map_w + 230 - 47 in Ruby coords.
        """
        cx = self.tx.map_w + 230 - 47   # = page_width - 47
        cy = 32
        font = f"font-family:{'Braille29' if self.tactile else 'Arial'},sans-serif"
        sz  = self.font_size if self.tactile else 24

        g = self.dwg.g()
        # Vertical stem
        g.add(self.dwg.line((cx, cy + 36), (cx, cy), style="stroke:black;stroke-width:2px"))
        # Left arm
        g.add(self.dwg.line((cx, cy), (cx - 11, cy + 18), style="stroke:black;stroke-width:2px"))
        # Right arm
        g.add(self.dwg.line((cx, cy), (cx + 11, cy + 18), style="stroke:black;stroke-width:2px"))
        # "N" label
        g.add(self.dwg.text(
            "N",
            insert=(cx - 8, 18),
            style=f"{font};font-size:{sz}px;fill:black",
        ))
        self.g_deco.add(g)

    def draw_header(self, address: str) -> None:
        title = "Tactile Map" if self.tactile else address
        font  = f"font-family:{'Braille29' if self.tactile else 'Arial'},sans-serif"
        self.g_deco.add(self.dwg.text(
            title,
            insert=(self.tx.map_x0, self.tx.map_y0 - 12),
            style=f"{font};font-size:{self.font_size}px;font-weight:bold;text-anchor:start;fill:black",
        ))

    def draw_footer(self, url: str = "lighthouse-sf.org/tmap") -> None:
        y = self.tx.map_y0 + self.tx.map_h + 18
        self.g_deco.add(self.dwg.text(
            url,
            insert=(self.tx.map_x0, y),
            style="font-family:Arial,sans-serif;font-size:10px;text-anchor:start;fill:#666666",
        ))

    # ---- output ------------------------------------------------------------

    def to_string(self) -> str:
        return self.dwg.tostring()

    def save(self, path: str | Path) -> None:
        self.dwg.saveas(str(path))


# ---------------------------------------------------------------------------

def build_svg(
    features: FeatureSet,
    transformer: CoordTransformer,
    width: int,
    height: int,
    address: str,
    zoom: int,
    lat: float,
    lon: float,
    units: str = "feet",
    tactile: bool = False,
    include_pois: bool = False,
    include_railways: bool = False,
    include_pathways: bool = False,
) -> tuple[SvgMap, list[MarginLabel]]:
    """
    Returns (SvgMap, labels) — labels also used to build the legend.
    """
    svg = SvgMap(width, height, transformer, tactile=tactile)
    abbreviator = Abbreviator()
    labels = place_labels(features.roads, transformer, zoom, abbreviator)

    svg.draw_header(address)
    svg.draw_scale_bar(zoom, units)
    svg.draw_north_arrow()

    if include_pois:
        svg.draw_pois(features.pois)
    if include_railways:
        svg.draw_railways(features.railways)
    if include_pathways:
        svg.draw_pathways(features.pathways)

    svg.draw_roads(features.roads)
    svg.draw_address_marker(lat, lon)
    svg.draw_labels(labels)
    svg.draw_footer()

    return svg, labels
