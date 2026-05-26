from __future__ import annotations
from dataclasses import dataclass

import geopandas as gpd
import networkx as nx
import osmnx as ox

# Show each HTTP request in the terminal and cache responses to disk so
# repeat runs are instant (~/.cache/osmnx/ by default).
ox.settings.log_console = True
ox.settings.use_cache = True


@dataclass
class OsmData:
    graph: nx.MultiDiGraph
    edges: gpd.GeoDataFrame
    nodes: gpd.GeoDataFrame
    buildings: gpd.GeoDataFrame
    parks: gpd.GeoDataFrame
    water: gpd.GeoDataFrame
    railways: gpd.GeoDataFrame
    pathways: gpd.GeoDataFrame


def fetch(
    lat: float,
    lon: float,
    dist: int,
    pois: bool = False,
    railways: bool = False,
    pathways: bool = False,
) -> OsmData:
    center = (lat, lon)

    print("  [1] road network…")
    G = ox.graph_from_point(center, dist=dist, network_type="all", retain_all=True)
    nodes, edges = ox.graph_to_gdfs(G)

    empty = gpd.GeoDataFrame()

    def _features(label: str, tags: dict) -> gpd.GeoDataFrame:
        print(f"  {label}…")
        try:
            return ox.features_from_point(center, tags=tags, dist=dist)
        except Exception:
            return empty

    return OsmData(
        graph=G,
        edges=edges,
        nodes=nodes,
        buildings=_features("[2] buildings", {"building": True})              if pois     else empty,
        parks=_features(    "[3] parks",     {"leisure": "park"})             if pois     else empty,
        water=_features(    "[4] water",     {"natural": ["water", "wetland"],
                                              "waterway": ["river", "stream", "canal"]}) if pois else empty,
        railways=_features( "[2] railways",  {"railway": ["rail", "subway", "light_rail", "tram", "monorail"]}) if railways else empty,
        pathways=_features( "[3] pathways",  {"highway": ["footway", "bridleway", "steps", "path", "cycleway", "pedestrian"]}) if pathways else empty,
    )
