import osmnx as ox


def geocode(address: str) -> tuple[float, float]:
    """Return (lat, lon) for the given address via Nominatim (OSM, free, no key needed)."""
    result = ox.geocode(address)
    return result  # osmnx already returns (lat, lon)
