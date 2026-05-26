"""
Constants ported directly from the Ruby source:
  config/initializers/02-osm_way_config.rb  — road/POI styles, type lists
  lib/scale.rb                              — paper sizes, scale-bar distances
  lib/map_drawer.rb                         — PAGE_PADDING, Y_OFFSET
  config/initializers/abbreviation_exceptions.rb
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path

FONTS_DIR = Path(__file__).parent.parent.parent / "fonts"

# ---------------------------------------------------------------------------
# Page geometry (lib/map_drawer.rb + lib/scale.rb)
# ---------------------------------------------------------------------------
# Ruby: PAGE_PADDING = OpenStruct.new(x: 230, y: 240), Y_OFFSET = 20
# map_x0 = PAGE_PADDING.x / 2 = 115
# map_y0 = PAGE_PADDING.y / 2 - Y_OFFSET = 120 - 20 = 100
# margin_bottom = page_h - map_y0 - map_h = page_h - 100 - (page_h - 240) = 140

PAGE_MARGIN_LEFT   = 115   # = PAGE_PADDING.x / 2
PAGE_MARGIN_RIGHT  = 115
PAGE_MARGIN_TOP    = 100   # = PAGE_PADDING.y / 2 - Y_OFFSET
PAGE_MARGIN_BOTTOM = 140   # = page_h - map_y0 - map_h (constant for all sizes)

@dataclass(frozen=True)
class PaperConfig:
    page_w: int    # total SVG page width  (Ruby: page_width)
    page_h: int    # total SVG page height (Ruby: page_height)
    map_w: int     # map area width        (Ruby: map_width  = page_w - 230)
    map_h: int     # map area height       (Ruby: map_height = page_h - 240)

PAPER_CONFIGS: dict[str, PaperConfig] = {
    "letter":            PaperConfig(612,  792,  382, 552),
    "letter_landscape":  PaperConfig(792,  612,  562, 372),
    "braille":           PaperConfig(828,  792,  598, 552),
    "tabloid_landscape": PaperConfig(1224, 792,  994, 552),
    "tabloid_portrait":  PaperConfig(792,  1224, 562, 984),
}

# ---------------------------------------------------------------------------
# Scale-bar distances per zoom level (lib/scale.rb#set_scale)
# ---------------------------------------------------------------------------
# Map-scale → OSM zoom mapping  (matches TMAP web-UI "Map Scale" dropdown)
# ---------------------------------------------------------------------------

SCALE_TO_ZOOM: dict[int, int] = {
    1500:  18,
    2500:  17,
    5000:  16,
    12500: 15,
    25000: 14,
    50000: 13,
}

# ---------------------------------------------------------------------------
# Scale-bar distances per zoom level (lib/scale.rb#set_scale)
# ---------------------------------------------------------------------------
# Units: feet (imperial), meters (metric).  Ruby always shows feet for US maps.

ZOOM_SCALE_FT: dict[int, int] = {
    18: 50, 17: 100, 16: 250, 15: 500, 14: 1000, 13: 2500,
}
ZOOM_SCALE_M: dict[int, int] = {
    18: 15, 17: 30, 16: 75, 15: 150, 14: 300, 13: 750,
}

# Radius used for the OSM Overpass fetch (approx metres that fits the paper)
ZOOM_TO_DIST: dict[int, int] = {
    18: 200, 17: 400, 16: 900, 15: 1800, 14: 3600, 13: 9000,
}

METERS_TO_FEET = 3.28084

# ---------------------------------------------------------------------------
# OSM feature classification (02-osm_way_config.rb)
# ---------------------------------------------------------------------------

ACCEPTABLE_ROADS = [
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "trunk_link", "primary_link", "secondary_link",
    "residential", "motorway_junction", "living_street",
    "bicycle_road", "road", "unclassified",
    "turning_circle", "motorway_link",
]

ACCEPTABLE_PATHWAYS = [
    "footway", "bridleway", "steps", "path", "unclassified",
    "pedestrian", "cycleway", "track",
]

ACCEPTABLE_RAILWAYS = ["rail", "subway", "light_rail", "tram"]

ROAD_PRIORITY: dict[str, int] = {
    road: i for i, road in enumerate(ACCEPTABLE_ROADS)
}

# ---------------------------------------------------------------------------
# SVG road/pathway/railway/POI styles (02-osm_way_config.rb)
# ---------------------------------------------------------------------------
# All roads share the same dark colour; only stroke-width varies slightly.

def _road(width: str) -> str:
    return f"stroke:#414042;stroke-width:{width};fill:none;stroke-linecap:round"

ROAD_STYLES: dict[str, str] = {
    "motorway":        _road("3px"),
    "motorway_link":   _road("2px"),
    "trunk":           _road("3px"),
    "primary":         _road("2px"),
    "secondary":       _road("2px"),
    "tertiary":        _road("2px"),
    "service":         _road("1px"),
    "living_street":   _road("2px"),
    "unclassified":    _road("2px"),
    "_default":        _road("2px"),
}

PATHWAY_STYLE = "stroke:#231f20;stroke-width:1px;stroke-dasharray:3 9;fill:none"

RAILWAY_STYLE = "stroke:#414042;stroke-width:2;stroke-dasharray:10 15;fill:none"

POI_STYLES: dict[str, str] = {
    "water":    "stroke-width:0;fill:#8EC4DE",
    "building": "stroke-width:4px;stroke:white;fill:#9d9fa2",
    "park":     "stroke-width:0;fill:#78D59F",
}

# ---------------------------------------------------------------------------
# Label drawing constants (lib/map_drawer/label_drawer.rb)
# ---------------------------------------------------------------------------

LEFT_PADDING     = 10
RIGHT_PADDING    = 10
TOP_PADDING      = 15
BOTTOM_PADDING   = 30
Y_CENTER_PADDING = 8

LABEL_FONT_PRINT        = "Arial, sans-serif"
LABEL_FONT_TACTILE      = "Braille29, monospace"
LABEL_FONT_SIZE_PRINT   = 18   # Ruby: font_size 18 for print
LABEL_FONT_SIZE_TACTILE = 29   # Ruby: font_size 29 for tactile

# ---------------------------------------------------------------------------
# Abbreviation exceptions (config/initializers/abbreviation_exceptions.rb)
# ---------------------------------------------------------------------------

ABBREVIATION_EXCEPTIONS: dict[str, str] = {
    "martin luther king jr way":    "MLK",
    "martin luther king junior":    "MLK",
    "martin luther king junior way": "MLK",
}

# Street-type suffix → short form (02-osm_way_config.rb STREET_TYPES)
STREET_TYPES: dict[str, str] = {
    "avenue": "Ave", "bend": "Bnd", "boulevard": "Blvd", "bypass": "Bpys",
    "circle": "Cir", "county road": "Rd", "court": "Ct", "courtyard": "Ct",
    "crossing": "Xing", "crossway": "Xing", "cul-de-sac": "Ct",
    "drive": "Dr", "driveway": "Dr", "expressway": "Expy", "fairway": "Way",
    "footway": "Way", "freeway": "Frwy", "state highway": "Hwy",
    "highway": "Hwy", "hill": "Hill", "junction": "Jnct", "lane": "Ln",
    "loop": "Lp", "motorway": "Mtrw", "parkway": "Pkwy", "pass": "pass",
    "road": "Rd", "roadway": "Rdwy", "state route": "Rte", "route": "Rt",
    "street": "St", "strip": "St", "thoroughfare": "Rd", "tollway": "Tlwy",
    "tunnel": "Tnnl", "way": "Way", "place": "Plc",
}
