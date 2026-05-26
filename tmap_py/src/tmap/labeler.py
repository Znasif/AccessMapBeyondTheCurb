"""
Port of:
  lib/osm/road/abbreviator.rb  — Abbreviator class
  lib/labeler/label.rb         — _Label (cursor, axis, collision)
  lib/labeler/variance.rb      — _Variance (odometer quality metric)
  lib/labeler.rb               — odometer variance loop + collision resolution
  lib/map_drawer/label_drawer.rb — SVG position formulas (used in svg_builder)
"""
from __future__ import annotations
import math
import re
from dataclasses import dataclass, field

from shapely.geometry import LineString, MultiPoint, Point, box as shapely_box

from .config import (
    ABBREVIATION_EXCEPTIONS, STREET_TYPES,
)
from .features import RoadFeature
from .geometry import CoordTransformer


# ---------------------------------------------------------------------------
# Abbreviator — port of lib/osm/road/abbreviator.rb
# ---------------------------------------------------------------------------

_IDEAL = 3
_MAX   = 4
_DIRS  = ["north", "south", "east", "west"]


class Abbreviator:
    """
    Processes road names one-by-one (in call order), building a unique
    abbreviation for each following the Ruby pipeline: strip type → exception →
    non-alpha → numeric-directional → numeric → direction → dedup → vowels →
    reduce → make-unique.
    """
    def __init__(self) -> None:
        self._name_to_abbr: dict[str, str] = {}
        self._abbr_to_name: dict[str, str] = {}

    def abbreviate(self, name: str) -> str:
        if name in self._name_to_abbr:
            return self._name_to_abbr[name]

        base = _strip_street_type(name.lower())
        cur  = _run_pipeline(base, set(self._abbr_to_name))
        cur  = _make_unique(cur, self._abbr_to_name)

        self._name_to_abbr[name] = cur
        self._abbr_to_name[cur]  = name
        return cur

    def get(self, name: str) -> str:
        return self._name_to_abbr.get(name, name[:3].upper())


def _strip_street_type(base: str) -> str:
    """Remove a matching street-type word from the name string."""
    for st, abbv in STREET_TYPES.items():
        if f" {st}" in base or f"{st} " in base:
            return re.sub(r"\b" + re.escape(st) + r"\b", "", base).strip()
        if f" {abbv.lower()}" in base:
            return re.sub(r"\b" + re.escape(abbv.lower()) + r"\b", "", base).strip()
    return base


class _AbbrDone(Exception):
    pass


def _run_pipeline(base: str, taken: set[str]) -> str:
    """
    Run the abbreviation pipeline.  Returns uppercase abbreviation string.
    `taken` is the set of already-assigned uppercase abbreviations.
    """
    cur = base
    try:
        # 1. Exception table
        if cur in ABBREVIATION_EXCEPTIONS:
            cur = ABBREVIATION_EXCEPTIONS[cur].upper()
            raise _AbbrDone()

        # 2. Strip non-alphanumeric
        cur = re.sub(r"[^0-9a-zA-Z]", "", cur)
        if len(cur) <= _IDEAL:
            raise _AbbrDone()

        # 3. Numeric directional  e.g. "north14" → "n14"
        dm = re.search(r"(north|south|east|west)", cur)
        nm = re.search(r"(\d+)", cur)
        if dm and nm:
            cur = dm.group(1)[0] + nm.group(1)
            if len(cur) >= 4:
                cur = cur[0] + cur[2:]  # Ruby: slice!(1)
            raise _AbbrDone()

        # 4. Pure numeric street  e.g. "10th" → "10"
        m = re.match(r"^(\d+)", cur)
        if m:
            cur = m.group(1)
            raise _AbbrDone()

        # 5. Abbreviate direction words
        for d in _DIRS:
            if d in cur:
                cur = cur.replace(d, d[0])
        if len(cur) <= _IDEAL:
            raise _AbbrDone()

        # 6. Strip consecutive duplicate non-digit chars
        cur = _strip_dups(cur)
        if len(cur) <= _IDEAL:
            raise _AbbrDone()

        # 7. Strip vowels from position 1 onwards
        cur = _strip_vowels(cur)
        if len(cur) <= _IDEAL:
            raise _AbbrDone()

        # 8. Reduce: prefer 3 chars if unique, else 4
        ideal = cur[:_IDEAL].upper()
        cur = ideal if ideal not in taken else cur[:_MAX].upper()

    except _AbbrDone:
        pass

    return cur.upper()


def _strip_dups(s: str) -> str:
    """Remove consecutive duplicate non-digit chars, stopping at IDEAL length."""
    chars = list(s)
    i = 0
    while i < len(chars) - 1:
        if chars[i] == chars[i + 1] and not chars[i].isdigit():
            chars.pop(i)
            if len(chars) <= _IDEAL:
                return "".join(chars)
        else:
            i += 1
    return "".join(chars)


def _strip_vowels(s: str) -> str:
    """Remove vowels from index 1 onward, stopping at IDEAL length."""
    chars = list(s)
    i = 1
    while i < len(chars):
        if chars[i].lower() in "aeiou":
            chars.pop(i)
            if len(chars) <= _IDEAL:
                return "".join(chars)
        else:
            i += 1
    return "".join(chars)


def _make_unique(cur: str, abbr_to_name: dict[str, str]) -> str:
    """
    If `cur` is already taken, replace the last char with an incrementing digit.
    Mirrors Ruby's make_unique! / incriment!
    """
    if cur not in abbr_to_name:
        return cur
    last = cur[-1]
    try:
        cur = cur[:-1] + str(int(last) + 1)
    except ValueError:
        cur = cur[:-1] + "1"
    return cur


# ---------------------------------------------------------------------------
# Intersection finding — port of lib/geometry/bounding_box.rb#intersection
# ---------------------------------------------------------------------------

def _road_intersections(
    map_pts: list[tuple[float, float]],
    map_w: float,
    map_h: float,
) -> list[tuple[float, float]]:
    """
    Return map-space (x, y) points where the road polyline crosses the map
    boundary rectangle [0, map_w] × [0, map_h].

    Snaps results to 0 or map_w / map_h within a 1px tolerance so that
    the axis check (x==0, x==map_w, y==0, y==map_h) is exact.
    """
    if len(map_pts) < 2:
        return []
    road   = LineString(map_pts)
    border = shapely_box(0, 0, map_w, map_h).exterior
    ix     = road.intersection(border)
    if ix.is_empty:
        return []

    raw: list[tuple[float, float]] = []
    if isinstance(ix, Point):
        raw = [(ix.x, ix.y)]
    elif isinstance(ix, MultiPoint):
        raw = [(p.x, p.y) for p in ix.geoms]
    elif hasattr(ix, "geoms"):
        for g in ix.geoms:
            if isinstance(g, Point):
                raw.append((g.x, g.y))

    result = []
    for x, y in raw:
        if abs(x)       < 1.0:  x = 0.0
        elif abs(x - map_w) < 1.0:  x = float(map_w)
        if abs(y)       < 1.0:  y = 0.0
        elif abs(y - map_h) < 1.0:  y = float(map_h)
        result.append((x, y))
    return result


# ---------------------------------------------------------------------------
# Cardinal direction — port of lib/osm/way.rb#orientation
# ---------------------------------------------------------------------------

def _cardinal_direction(map_pts: list[tuple[float, float]]) -> str:
    """
    Return N-S / E-W / NE-SW / NW-SE based on the road's overall bearing.
    In map space y increases downward, so:
      angle ≈ 0° or 180° → E-W
      angle ≈ 90°         → N-S
    """
    if len(map_pts) < 2:
        return "N-S"
    dx = map_pts[-1][0] - map_pts[0][0]
    dy = map_pts[-1][1] - map_pts[0][1]
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return "N-S"
    angle = math.degrees(math.atan2(abs(dy), abs(dx)))  # 0=horizontal, 90=vertical
    if angle < 22.5:
        return "E-W"
    if angle > 67.5:
        return "N-S"
    return "NE-SW" if dx * dy < 0 else "NW-SE"


# ---------------------------------------------------------------------------
# Public output type
# ---------------------------------------------------------------------------

@dataclass
class MarginLabel:
    text:      str    # abbreviation shown on map
    full_name: str    # full road name (for legend)
    direction: str    # N-S / E-W / NE-SW / NW-SE (for legend)
    pos_x:     float  # map-space x: 0=left edge, map_w=right edge
    pos_y:     float  # map-space y: 0=top edge,  map_h=bottom edge
    resolved:  bool   = True


# ---------------------------------------------------------------------------
# Internal label — port of lib/labeler/label.rb
# ---------------------------------------------------------------------------

X_PROXIMITY = 25   # px proximity for left/right (x-axis) labels
Y_PROXIMITY = 75   # px proximity for top/bottom  (y-axis) labels


@dataclass
class _Label:
    name:          str
    abbreviation:  str
    direction:     str
    intersections: list[tuple[float, float]]
    priority:      int
    size:          float   # approx pixel length of the road
    map_w:         float
    map_h:         float
    cursor:        int  = field(default=0, init=False)
    resolved:      bool = field(default=True, init=False)

    @property
    def position(self) -> tuple[float, float]:
        return self.intersections[self.cursor]

    @property
    def axis(self) -> str:
        """'x' for left/right edge, 'y' for top/bottom edge."""
        x, _ = self.position
        return "x" if (x == 0 or x == self.map_w) else "y"

    @property
    def _proximity(self) -> float:
        return X_PROXIMITY if self.axis == "x" else Y_PROXIMITY

    def collides_with(self, other: _Label) -> bool:
        if self.axis != other.axis:
            return False
        dx = self.position[0] - other.position[0]
        dy = self.position[1] - other.position[1]
        return math.hypot(dx, dy) < self._proximity

    def writable(self, existing: list[_Label]) -> bool:
        for lbl in existing:
            if lbl.collides_with(self):
                return False
        return True

    def has_collisions_with(self, others: list[_Label]) -> bool:
        return any(o.collides_with(self) for o in others if o is not self)

    def next(self) -> bool:
        if self.cursor + 1 < len(self.intersections):
            self.cursor += 1
            return True
        return False

    def reset_cursor(self) -> None:
        self.cursor = 0


# ---------------------------------------------------------------------------
# Variance — port of lib/labeler/variance.rb
# ---------------------------------------------------------------------------

@dataclass
class _Variance:
    skips:    int   = 0
    priority: int   = 0
    size:     float = 0.0

    def add(self, lbl: _Label) -> None:
        self.skips    += 1
        self.priority += lbl.priority
        self.size     += lbl.size

    @property
    def perfect(self) -> bool:
        return self.skips == 0

    def __lt__(self, other: _Variance) -> bool:
        """True if self is a BETTER (lower) variance than other."""
        if self.skips != other.skips:
            return self.skips < other.skips
        if self.priority != other.priority:
            return self.priority > other.priority   # higher = less important roads skipped = better
        return self.size < other.size


# ---------------------------------------------------------------------------
# Labeler — port of lib/labeler.rb
# ---------------------------------------------------------------------------

def _find_best_cursors(labels: list[_Label]) -> None:
    """Odometer variance loop: try all cursor combinations, keep the best."""
    winner        = [0] * len(labels)
    winner_var: _Variance | None = None

    while True:
        var = _Variance()
        for i, lbl in enumerate(labels):
            if not lbl.writable(labels[:i]):
                var.add(lbl)

        if var.perfect:
            return

        if winner_var is None or var < winner_var:
            winner_var = var
            winner     = [lbl.cursor for lbl in labels]

        # Advance odometer
        advanced = False
        for i, lbl in enumerate(labels):
            if lbl.next():
                for j in range(i):
                    labels[j].reset_cursor()
                advanced = True
                break
        if not advanced:
            break

    for i, cur in enumerate(winner):
        labels[i].cursor = cur


def _set_best_choice(l1: _Label, l2: _Label) -> None:
    """Collision resolution: keep the higher-priority / larger road."""
    if l1.priority == l2.priority:
        if l1.size == l2.size:
            l1.resolved = False
            l2.resolved = False
        elif l1.size > l2.size:
            l1.resolved = True
            l2.resolved = False
        else:
            l1.resolved = False
            l2.resolved = True
    elif l1.priority < l2.priority:   # l1 more important (lower index)
        l1.resolved = True
        l2.resolved = False
    # else: l1 is less important — do nothing (outer loop will handle it the other way round)


def _resolve_collisions(labels: list[_Label]) -> None:
    """Port of lib/labeler.rb#resolve_collisions!"""
    for l1 in labels:
        if not l1.resolved:
            continue
        for l2 in labels:
            if l1 is l2 or not l2.resolved:
                continue
            if l1.collides_with(l2):
                _set_best_choice(l1, l2)

    # Second pass: give unresolved labels a second chance
    resolved = [l for l in labels if l.resolved]
    for lbl in labels:
        if not lbl.resolved and not lbl.has_collisions_with(resolved):
            lbl.resolved = True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def place_labels(
    roads: list[RoadFeature],
    transformer: CoordTransformer,
    zoom: int,
    abbreviator: Abbreviator,
) -> list[MarginLabel]:
    """
    Find which roads cross the map boundary, abbreviate their names, run the
    odometer variance loop, resolve collisions, and return a MarginLabel for
    every road that should be drawn.
    """
    map_w = float(transformer.map_w)
    map_h = float(transformer.map_h)

    # Collect roads that cross the map boundary
    intersecting: list[tuple[RoadFeature, list[tuple], list[tuple]]] = []
    seen_names: set[str] = set()

    # Sort by priority so higher-priority roads are abbreviated first
    sorted_roads = sorted(
        (r for r in roads if r.name),
        key=lambda r: r.priority,
    )
    for road in sorted_roads:
        if road.name in seen_names:
            continue
        map_pts  = transformer.linestring_to_map_pixels(road.geometry)
        crossings = _road_intersections(map_pts, map_w, map_h)
        if not crossings:
            continue
        seen_names.add(road.name)
        intersecting.append((road, map_pts, crossings))

    if not intersecting:
        return []

    # Pre-abbreviate all names (maintains order-dependent uniqueness)
    for road, _, _ in intersecting:
        abbreviator.abbreviate(road.name)

    # Build internal Label objects
    labels: list[_Label] = []
    for road, map_pts, crossings in intersecting:
        labels.append(_Label(
            name=road.name,
            abbreviation=abbreviator.get(road.name),
            direction=_cardinal_direction(map_pts),
            intersections=crossings,
            priority=road.priority,
            size=road.length,
            map_w=map_w,
            map_h=map_h,
        ))

    _find_best_cursors(labels)
    _resolve_collisions(labels)

    return [
        MarginLabel(
            text=lbl.abbreviation,
            full_name=lbl.name,
            direction=lbl.direction,
            pos_x=lbl.position[0],
            pos_y=lbl.position[1],
            resolved=lbl.resolved,
        )
        for lbl in labels
    ]
