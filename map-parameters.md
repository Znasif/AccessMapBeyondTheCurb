# Map Parameters Documentation

This document describes the URL parameters and configuration options available for Audiom maps accessed through the `/map` endpoint.

## URL Structure

The base URL for the map endpoint follows this pattern:
`https://[your-audiom-instance-url]/map`

Query parameters are appended to configure the map behavior and data sources.

## Core Map Parameters

### Navigation & Display

#### `center` (Optional)

- **Description**: Map center coordinates as "longitude,latitude"
- **Type**: String in format "lng,lat"
- **Example**: `center="-84.38,33.75"`

#### `zoom` (Optional)

- **Description**: Initial zoom level of the map
- **Type**: Number
- **Example**: `zoom=15`

### Data Sources

#### `source` (Optional, Legacy)

- **Description**: Single data source identifier or direct URL to GeoJSON data
- **Type**: String
- **Default**: `"osm"` if no sources specified
- **Example**: `source=osm`
- **Example (URL)**: `source=https://example.com/data.geojson`

#### `sources` (Optional, Recommended)

- **Description**: Comma-separated list of data source identifiers and/or URLs
- **Type**: String (comma-separated)
- **Example**: `sources=osm,TDEI`
- **Example (Mixed)**: `sources=osm,https://example.com/custom.geojson`

### Available Data Sources

The following predefined sources are available:

- **`osm`** - OpenStreetMap data (default for travel mapping)
- **`covid_daily`** - COVID-19 daily statistics
- **`covid_county_stats`** - COVID-19 county statistics
- **`covid_global_stats`** - COVID-19 global statistics
- **`covid_nytimes`** - COVID-19 NYTimes data
- **`goodmaps`** - Goodmaps APH Facility (IMDF indoor mapping)
- **`coon`** - Georgia Tech Coon Building (IMDF indoor mapping)
- **`TDEI`** - TDEI sidewalk accessibility data
- **`IMDF`** - Generic IMDF indoor mapping loader
- **`presidential_election`** - US Presidential Election 2024 data
- **Direct URLs** - Any valid GeoJSON URL is automatically detected and loaded

### Multi-Source Configuration

For advanced configurations, use namespaced parameters to pass source-specific settings:

**Format**: `{sourceName}.{parameter}={value}`

#### Source-Specific Parameters

- **`{source}.type`** - Override the source loader type
  - **Example**: `routes.type=esri` (forces ESRI loader for "routes" source)
- **`{source}.mapType`** - Override the map rendering type for this source
  - **Values**: `travel`, `heatmap`, `indoor`
  - **Example**: `elevation.mapType=heatmap`
- **`{source}.name`** - Custom display name for the source
  - **Example**: `osm.name=Street%20Network`
- **`{source}.url`** - URL for dynamic sources (required for ESRI type)
  - **Example**: `weather.url=https://services.arcgis.com/...`

**Complete Example**:

```
?sources=routes,elevation&routes.type=esri&routes.url=https://example.com/service&elevation.mapType=heatmap
```

### Coordinate Systems & Projections

#### `projection` (Optional)

- **Description**: Coordinate system projection to use
- **Type**: String
- **Values**: `enu` (default), `utm`, `webmercator`
- **Default**: `enu`
- **Example**: `projection=utm`

#### `zone` (Required for UTM)

- **Description**: UTM zone number (required when projection=utm)
- **Type**: Number (1-60)
- **Example**: `zone=17`

### Audio & Interface

#### `soundpack` (Optional)

- **Description**: Audio theme path for spatial audio
- **Type**: String (path)
- **Default**: `/audio` (or `/election_results` for election data)
- **Example**: `soundpack=/audio/nature`

#### `demo` (Optional)

- **Description**: Enable demo mode features
- **Type**: Boolean (`"true"` or `"false"`)
- **Default**: `false`
- **Example**: `demo=true`

#### `title` (Optional)

- **Description**: Custom title for the map (overrides auto-generated titles)
- **Type**: String
- **Example**: `title=Campus%20Accessibility%20Map`

#### `stepsize` (Optional)

- **Description**: Custom step size for navigation/movement in the audio map
- **Type**: String with optional unit suffix
- **Units**: `km` (kilometers), `m` (meters, default if no unit), `mi` (miles), `ft` (feet)
- **Example**: `stepsize=10m` (10 meters)
- **Example**: `stepsize=5km` (5 kilometers)
- **Example**: `stepsize=100` (100 meters, assumes meters without unit)

### Organization & Access

#### `organizationId` (Optional)

- **Description**: Organization identifier for access control and data filtering
- **Type**: String
- **Example**: `organizationId=university-123`

## Parameter Processing

### Reserved Parameters

The following parameters are handled by the map system and not passed to data loaders:

- `center`, `sources`, `zoom`, `organizationId`
- `demo`, `title`, `soundpack`, `projection`, `zone`, `stepsize`
- All namespaced parameters (containing `.`)

### Additional Parameters

Any other URL parameters are collected and passed as `additionalParams` to all data loaders, enabling custom functionality for specific sources.

## Default Behaviors

### Automatic Center Detection

Certain sources have predefined default centers when no `center` parameter is provided:

- **`covid_daily`**: [-90, 40] (US center)
- **`TDEI`**: [-122.1430782, 47.6495122] (Seattle area)
- **`goodmaps`**: [-85.714617798777724, 38.256777226202168]

### Map Type Inference

- **Travel sources** (osm, TDEI): Use `travel` map type for navigation
- **Statistical sources** (covid\_\*): Use `heatmap` map type for visualization
- **Indoor sources** (goodmaps, coon, IMDF): Use `indoor` map type

### Cache Behavior

Sources marked as cacheable are stored in browser localStorage for 2 days to improve performance.

## Examples

### Basic OpenStreetMap

```
/map?source=osm&center="-84.38,33.75"&zoom=15
```

### Multi-Source Urban Planning

```
/map?sources=osm,TDEI&center="-122.14,47.65"&zoom=16&title=Seattle%20Accessibility
```

### Custom ESRI Service Integration

```
/map?sources=base,traffic&base.type=esri&base.url=https://services.arcgis.com/base&traffic.type=esri&traffic.url=https://services.arcgis.com/traffic&projection=webmercator
```

### Indoor Mapping

```
/map?source=goodmaps&projection=enu&title=APH%20Facility%20Tour&demo=true
```

### Election Data Visualization

```
/map?source=presidential_election&soundpack=/election_results&center="-84,39"&zoom=6
```

### Research Data with UTM Projection

```
/map?sources=osm,https://research.university.edu/data.geojson&projection=utm&zone=17&organizationId=research-lab
```

## Error Handling

### Invalid Sources

- Invalid source names are logged but don't prevent other sources from loading
- Failed source loads are tracked in the `errors` array returned with map data

### Projection Errors

- Invalid projection types fall back to ENU projection
- Invalid UTM zones fall back to ENU projection with console warnings

### Coordinate Validation

- Invalid center coordinates are validated before processing
- Invalid coordinates prevent map loading with appropriate error messages

### URL Source Handling

- URLs are automatically detected and loaded using the GeoJSON loader
- Network errors for URL sources are handled gracefully with error reporting
