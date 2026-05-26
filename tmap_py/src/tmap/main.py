from __future__ import annotations
import argparse
import sys

from .pipeline import generate

# Map scale choices from the TMAP web UI "Map Scale" dropdown
_SCALES = [1500, 2500, 5000, 12500, 25000, 50000]

# Paper size choices from the TMAP web UI "Paper Size" dropdown
# CLI label → PAPER_CONFIGS key in config.py
_PAPERS = {
    "8.5x11":  "letter",
    "11x8.5":  "letter_landscape",
    "11.5x11": "braille",
    "17x11":   "tabloid_landscape",
    "11x17":   "tabloid_portrait",
}


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tmap",
        description="Generate tactile and print SVG maps from a street address.",
    )
    parser.add_argument("address", help='e.g. "8 10th St, San Francisco, CA"')
    parser.add_argument(
        "--scale", type=int, default=5000,
        choices=_SCALES, metavar="SCALE",
        help=f"Map scale 1:N — choices: {_SCALES} (default: 5000)",
    )
    parser.add_argument(
        "--paper", default="8.5x11", choices=list(_PAPERS),
        help="Paper size in inches (default: 8.5x11)",
    )
    parser.add_argument(
        "--units", default="feet", choices=["feet", "meters"],
        help="Distance units for scale bar (default: feet)",
    )
    parser.add_argument(
        "--output", "-o", default=".", metavar="DIR",
        help="Output directory (default: current directory)",
    )
    parser.add_argument("--pois",     action="store_true", help="Include buildings, parks, water")
    parser.add_argument("--railways", action="store_true", help="Include railways")
    parser.add_argument("--pathways", action="store_true", help="Include footways and paths")
    args = parser.parse_args()

    try:
        generate(
            address=args.address,
            scale=args.scale,
            paper=_PAPERS[args.paper],
            units=args.units,
            output_dir=args.output,
            include_pois=args.pois,
            include_railways=args.railways,
            include_pathways=args.pathways,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
