from __future__ import annotations
from dataclasses import dataclass, field

from shapely.geometry import LineString, MultiPolygon, Polygon

from .config import ROAD_PRIORITY, ACCEPTABLE_ROADS as ROAD_TYPES
from .osm_fetcher import OsmData


@dataclass
class RoadFeature:
    highway: str
    name: str | None
    geometry: LineString
    priority: int
    length: float


@dataclass
class RailwayFeature:
    railway: str
    name: str | None
    geometry: LineString


@dataclass
class PathwayFeature:
    highway: str
    geometry: LineString


@dataclass
class PoiFeature:
    kind: str  # 'building' | 'park' | 'water'
    geometry: Polygon | MultiPolygon


@dataclass
class FeatureSet:
    roads: list[RoadFeature] = field(default_factory=list)
    railways: list[RailwayFeature] = field(default_factory=list)
    pathways: list[PathwayFeature] = field(default_factory=list)
    pois: list[PoiFeature] = field(default_factory=list)


def _str_tag(val) -> str | None:
    if isinstance(val, list):
        val = val[0]
    return str(val) if isinstance(val, str) else None


def classify(data: OsmData) -> FeatureSet:
    fs = FeatureSet()

    # Roads (from the road-network graph edges)
    for _, row in data.edges.iterrows():
        highway = _str_tag(row.get("highway"))
        if not highway:
            continue
        base = highway[:-5] if highway.endswith("_link") else highway
        if highway not in ROAD_TYPES and base not in ROAD_TYPES:
            continue
        geom = row.get("geometry")
        if geom is None or not isinstance(geom, LineString) or geom.is_empty:
            continue
        name = _str_tag(row.get("name"))
        priority = ROAD_PRIORITY.get(highway, ROAD_PRIORITY.get(base, 0))
        fs.roads.append(RoadFeature(highway=highway, name=name, geometry=geom, priority=priority, length=geom.length))

    # Railways (from features GDF, may contain Points/Lines/Polygons)
    for _, row in data.railways.iterrows():
        geom = row.get("geometry")
        if not isinstance(geom, LineString) or geom.is_empty:
            continue
        fs.railways.append(RailwayFeature(
            railway=_str_tag(row.get("railway")) or "rail",
            name=_str_tag(row.get("name")),
            geometry=geom,
        ))

    # Pathways
    for _, row in data.pathways.iterrows():
        geom = row.get("geometry")
        if not isinstance(geom, LineString) or geom.is_empty:
            continue
        fs.pathways.append(PathwayFeature(
            highway=_str_tag(row.get("highway")) or "path",
            geometry=geom,
        ))

    # POIs — only keep polygon geometries
    for gdf, kind in [(data.buildings, "building"), (data.parks, "park"), (data.water, "water")]:
        for _, row in gdf.iterrows():
            geom = row.get("geometry")
            if geom is None or geom.is_empty:
                continue
            if isinstance(geom, (Polygon, MultiPolygon)):
                fs.pois.append(PoiFeature(kind=kind, geometry=geom))

    return fs
