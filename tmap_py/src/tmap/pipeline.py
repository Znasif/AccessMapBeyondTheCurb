from __future__ import annotations
from pathlib import Path

from .config import (
    PAPER_CONFIGS,
    PAGE_MARGIN_LEFT, PAGE_MARGIN_RIGHT, PAGE_MARGIN_TOP, PAGE_MARGIN_BOTTOM,
    SCALE_TO_ZOOM, ZOOM_TO_DIST,
)
from .features import classify
from .geocoder import geocode
from .geometry import BoundingBox, CoordTransformer
from .legend import build_legend
from .osm_fetcher import fetch
from .raster import render_pin_display
from .svg_builder import build_svg


def generate(
    address: str,
    scale: int = 5000,
    paper: str = "letter",
    units: str = "feet",
    output_dir: str | Path = ".",
    include_pois: bool = False,
    include_railways: bool = False,
    include_pathways: bool = False,
    pin_render: bool = False,
    pin_svg: bool = False,
) -> dict[str, Path]:
    """
    Full pipeline: address → four SVG files (print map, tactile map,
    print legend, tactile legend).

    Parameters
    ----------
    scale  : map scale denominator — 1500 / 2500 / 5000 / 12500 / 25000 / 50000
    paper  : PAPER_CONFIGS key — 'letter' / 'letter_landscape' / 'braille' /
             'tabloid_landscape' / 'tabloid_portrait'
    units  : 'feet' (default) or 'meters' — controls scale-bar label
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    zoom      = SCALE_TO_ZOOM.get(scale, 16)
    dist      = ZOOM_TO_DIST.get(zoom, 900)
    paper_cfg = PAPER_CONFIGS.get(paper, PAPER_CONFIGS["letter"])
    width     = paper_cfg.page_w
    height    = paper_cfg.page_h

    print(f"Geocoding: {address}")
    lat, lon = geocode(address)
    print(f"  → ({lat:.5f}, {lon:.5f})")

    print(f"Fetching OSM data  scale=1:{scale}  paper={paper}  dist={dist}m …")
    osm_data = fetch(lat, lon, dist,
                     pois=include_pois,
                     railways=include_railways,
                     pathways=include_pathways)
    print(f"  → {len(osm_data.edges)} road edges")

    print("Classifying features…")
    features = classify(osm_data)
    print(f"  → {len(features.roads)} roads, {len(features.pois)} POIs")

    bbox = BoundingBox.from_center(lat, lon, dist)
    transformer = CoordTransformer(
        bbox=bbox,
        canvas_width=width,
        canvas_height=height,
        margin_top=PAGE_MARGIN_TOP,
        margin_bottom=PAGE_MARGIN_BOTTOM,
        margin_left=PAGE_MARGIN_LEFT,
        margin_right=PAGE_MARGIN_RIGHT,
    )

    print("Rendering print SVG…")
    print_svg, labels = build_svg(
        features, transformer, width, height,
        address=address, zoom=zoom, lat=lat, lon=lon, units=units,
        tactile=False,
        include_pois=include_pois,
        include_railways=include_railways,
        include_pathways=include_pathways,
    )

    print("Rendering tactile SVG…")
    tactile_svg, _ = build_svg(
        features, transformer, width, height,
        address=address, zoom=zoom, lat=lat, lon=lon, units=units,
        tactile=True,
        include_pois=include_pois,
        include_railways=include_railways,
        include_pathways=include_pathways,
    )

    print("Rendering legends…")
    print_legend   = build_legend(labels, address, width, height, tactile=False)
    tactile_legend = build_legend(labels, address, width, height, tactile=True)

    safe = address.replace(",", "").replace(" ", "_")[:40]
    paths = {
        "print_map":      output_dir / f"{safe}_print.svg",
        "tactile_map":    output_dir / f"{safe}_tactile.svg",
        "print_legend":   output_dir / f"{safe}_print_legend.svg",
        "tactile_legend": output_dir / f"{safe}_tactile_legend.svg",
    }

    print_svg.save(paths["print_map"])
    tactile_svg.save(paths["tactile_map"])
    print_legend.saveas(str(paths["print_legend"]))
    tactile_legend.saveas(str(paths["tactile_legend"]))

    if pin_render:
        pin_path = output_dir / f"{safe}_pins.png"
        paths["pin_display"] = pin_path
        print("Rendering pin display PNG…")
        render_pin_display(paths["tactile_map"], pin_path)

    if pin_svg:
        from .brailledoodle import rasterize_roads, export_pin_svg
        pin_svg_path = output_dir / f"{safe}_pin_overlay.svg"
        paths["pin_svg"] = pin_svg_path
        print("Rasterizing pin grid for SVG overlay…")
        pin_grid, attr_grid, index_to_name = rasterize_roads(features.roads, transformer)
        export_pin_svg(
            pin_grid, attr_grid, index_to_name,
            transformer,
            paths["tactile_map"],
            pin_svg_path,
        )

    print("\nSaved:")
    for k, p in paths.items():
        print(f"  {k}: {p}")
    return paths
