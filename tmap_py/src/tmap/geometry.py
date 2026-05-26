from __future__ import annotations
import math
from dataclasses import dataclass


@dataclass
class BoundingBox:
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    @classmethod
    def from_center(cls, lat: float, lon: float, dist_meters: float) -> BoundingBox:
        lat_deg = dist_meters / 111_320.0
        lon_deg = dist_meters / (111_320.0 * math.cos(math.radians(lat)))
        return cls(
            min_lat=lat - lat_deg,
            max_lat=lat + lat_deg,
            min_lon=lon - lon_deg,
            max_lon=lon + lon_deg,
        )


class CoordTransformer:
    """Maps WGS-84 (lat, lon) to SVG pixel coordinates within a padded canvas."""

    def __init__(
        self,
        bbox: BoundingBox,
        canvas_width: int,
        canvas_height: int,
        margin_top: int,
        margin_bottom: int,
        margin_left: int,
        margin_right: int,
    ) -> None:
        self.bbox = bbox
        self.map_x0 = margin_left
        self.map_y0 = margin_top
        self.map_w = canvas_width - margin_left - margin_right
        self.map_h = canvas_height - margin_top - margin_bottom

    def to_pixel(self, lat: float, lon: float) -> tuple[float, float]:
        x = (lon - self.bbox.min_lon) / (self.bbox.max_lon - self.bbox.min_lon) * self.map_w + self.map_x0
        y = (self.bbox.max_lat - lat) / (self.bbox.max_lat - self.bbox.min_lat) * self.map_h + self.map_y0
        return round(x, 2), round(y, 2)

    def linestring_to_pixels(self, geom) -> list[tuple[float, float]]:
        # Shapely LineString coords are (lon, lat) for geographic data
        return [self.to_pixel(lat, lon) for lon, lat in geom.coords]

    def polygon_to_pixels(self, geom) -> list[tuple[float, float]]:
        return [self.to_pixel(lat, lon) for lon, lat in geom.exterior.coords]

    def to_map_pixel(self, lat: float, lon: float) -> tuple[float, float]:
        """Convert (lat, lon) to map-space coords: x in [0, map_w], y in [0, map_h]."""
        x = (lon - self.bbox.min_lon) / (self.bbox.max_lon - self.bbox.min_lon) * self.map_w
        y = (self.bbox.max_lat - lat) / (self.bbox.max_lat - self.bbox.min_lat) * self.map_h
        return round(x, 2), round(y, 2)

    def linestring_to_map_pixels(self, geom) -> list[tuple[float, float]]:
        """LineString (lon, lat) coords → list of map-space (x, y) points."""
        return [self.to_map_pixel(lat, lon) for lon, lat in geom.coords]

    def meters_to_pixels(self, meters: float) -> float:
        mid_lat = (self.bbox.min_lat + self.bbox.max_lat) / 2
        lon_span = self.bbox.max_lon - self.bbox.min_lon
        meters_per_lon_deg = 111_320.0 * math.cos(math.radians(mid_lat))
        return meters / (lon_span * meters_per_lon_deg) * self.map_w
