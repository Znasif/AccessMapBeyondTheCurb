# Audiom Embed Endpoint Documentation

The Audiom Embed Endpoint allows you to integrate the Audiom inclusive mapping solution into your platform using an iFrame. The service dynamically generates an interactive map based on the URL query parameters provided.

## URL Structure

The base URL for the embed endpoint typically follows this pattern:
`https://[your-audiom-instance-url]/embed/[embedId]`

Query parameters are appended to this URL to configure the map.

## Path Parameters

### `embedId` (Required in URL Path)

- **Description**: Part of the URL path that identifies the map to load. Use a numeric ID for pre-configured static maps, or use `"dynamic"` to load a map dynamically based on query parameters.
- **Static Map Example**: `/embed/12345` (loads pre-configured map with ID 12345)
- **Dynamic Map Example**: `/embed/dynamic?source=osm&latitude=47.6495&longitude=-122.1431`
- **Note**: This must be specified in the URL path, not as a query parameter.

## Query Parameters

The following parameters can be passed via the URL query string:

### `apiKey` (Required)

- **Description**: Your API key, necessary for fetching map data.
- **Example**: `apiKey=abcxyz123456`

### `source` (Optional, Legacy)

- **Description**: Single data source identifier or direct URL to GeoJSON data. For multiple sources, prefer the `sources` parameter instead.
- **Example (Single Source)**: `source=osm`
- **Example (URL Source)**: `source=https://example.com/mycustommap.geojson`

### `sources` (Optional, Recommended)

- **Description**: Comma-separated list of data source identifiers and/or URLs. This is the recommended parameter for specifying one or more data sources. Takes precedence over `source` when both are provided.
- **Example**: `sources=osm,TDEI`
- **Example (Mixed)**: `sources=osm,https://example.com/custom.geojson`

**Note**: When using `embed/dynamic`, either `source`/`sources` or a valid center (`center` or `latitude`+`longitude`) must be provided. If neither is specified, a `422 Unprocessable Entity` error is returned.

#### Available Data Sources

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

### `center` (Optional)

- **Description**: Map center coordinates as "longitude,latitude". This parameter takes precedence over separate `latitude` and `longitude` parameters.
- **Type**: String in format "lng,lat"
- **Example**: `center="-122.1431,47.6495"`

### `latitude` (Optional)

- **Description**: The latitude for the map's center point. Used when loading a map dynamically. Note: If `center` parameter is provided, it takes precedence over `latitude` and `longitude`.
- **Type**: Number
- **Example**: `latitude=47.6495122`

### `longitude` (Optional)

- **Description**: The longitude for the map's center point. Used when loading a map dynamically. Note: If `center` parameter is provided, it takes precedence over `latitude` and `longitude`.
- **Type**: Number
- **Example**: `longitude=-122.1430782`

### `zoom` (Optional)

- **Description**: The initial zoom level of the map.
- **Type**: Number
- **Default**: `14`
- **Example**: `zoom=15`

### `soundpack` (Optional)

- **Description**: Identifier or path for the soundpack to be used. If not provided, it may default based on the `embedId` or to a system-wide default (e.g., `/audio`).
- **Example**: `soundpack=/audio/custompackname`

### `demo` (Optional)

- **Description**: Enables or disables demo mode.
- **Type**: Boolean (`"true"` or `"false"`)
- **Example**: `demo=true`

### `title` (Optional)

- **Description**: A custom title for the map. This will override any title derived from map data.
- **Example**: `title=My%20Custom%20Interactive%20Map`

### `showVisualMap` (Optional)

- **Description**: Determines whether the visual map component is displayed.
- **Type**: Boolean (`"true"` or `"false"`)
- **Default**: `true`
- **Example**: `showVisualMap=false` (Hides the visual map, showing only the audio interface)

### `heading` (Optional)

- **Description**: Sets the HTML heading level (e.g., `h1`, `h2`) for the map title when `showHeading` is `true`.
- **Type**: Number (1-6)
- **Default**: `2` (renders as `<h2>`)
- **Example**: `heading=1` (Renders the title as `<h1>`)

### `showHeading` (Optional)

- **Description**: Controls whether the map title heading element is rendered on the page.
- **Type**: Boolean (`"true"` or `"false"`)
- **Default**: Not explicitly set, but the title might appear by default if a map name exists. Use this to explicitly control its visibility.
- **Example**: `showHeading=true`

### `stepsize` (Optional)

- **Description**: Custom step size for navigation/movement in the audio map.
- **Type**: String with optional unit suffix
- **Units**: `km` (kilometers), `m` (meters, default if no unit), `mi` (miles), `ft` (feet)
- **Example**: `stepsize=10m` (10 meters)
- **Example**: `stepsize=5km` (5 kilometers)
- **Example**: `stepsize=100` (100 meters, assumes meters without unit)

### `filters` (Optional)

- **Description**: Comma-separated list of object types to filter the map features.
- **Type**: String (comma-separated)
- **Example**: `filters=walls,poi,building`

### `filterMode` (Optional)

- **Description**: Controls how filters are applied.
- **Type**: String
- **Values**: `"global"` (filters apply to all features everywhere) or `"scan"` (filters apply to menus and sonar scans only)
- **Default**: `"scan"`
- **Example**: `filterMode=global`

### `visualStyle` (Optional)

- **Description**: Sets the visual rendering style for the map.
- **Type**: String
- **Example**: `visualStyle=geology`

### `allowedOrigins` (Optional, Required to enable PostMessage API)

- **Description**: Comma-separated list of origins allowed to send messages to the embedded map via the PostMessage API, or `*` to allow any origin. The PostMessage API is disabled by default; this parameter is required to enable it.
- **Security**: Only origins in this list can send commands to the map. Messages from other origins are rejected with an `INVALID_ORIGIN` error.
- **Examples**:
  - `allowedOrigins=https://myapp.com` (single origin)
  - `allowedOrigins=https://myapp.com,https://staging.myapp.com` (multiple origins)
  - `allowedOrigins=*` (any origin - use only for development/testing)

### Multi-Source Configuration

For advanced configurations with multiple data sources, you can use namespaced parameters to pass source-specific settings. This works identically to the `/map` endpoint.

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
- **`{source}.rules`** - Path to a rules JSON file for custom feature classification
  - **Example**: `census.rules=/rules/census.json`
- **`{source}.where`** - SQL-style filter for ESRI sources
  - **Example**: `census.where=State='Hawaii'`

**Complete Example**:

```
/embed/dynamic?source=routes,elevation&routes.type=esri&routes.url=https://example.com/service&elevation.mapType=heatmap&apiKey=xyz123
```

### Other Parameters

- **Description**: Any URL query parameters not listed above (e.g., `organizationId`, custom parameters for specific data loaders) will be collected and passed as `additionalParams` to the map data loader. This allows for extending functionality for custom data sources.
- **Excluded from additionalParams**: `center`, `size`, `sources`, `zoom`, `organizationId`, `demo`, `title`, `soundpack`, `embedId`, `apiKey`, `showVisualMap`, `heading`, `showHeading`, `stepsize`, `filters`, `filterMode`, `visualStyle`, and all namespaced parameters (containing `.`).
- **Example**: `myCustomParam=customValue` (This would be passed to the loader if `myCustomParam` is not a recognized top-level parameter).

### Parameters NOT Supported in Embed

The following parameters are available in the `/map` endpoint but **NOT supported** in the `/embed` endpoint:

- **`projection`** - Coordinate system projection (ENU, UTM, WebMercator)
- **`zone`** - UTM zone number

If these parameters are passed to the embed endpoint, they will be ignored.

## Error Handling

### API Key Not Provided

- **Status Code**: `422 Unprocessable Entity`
- **Condition**: If the `apiKey` parameter is missing.
- **Response**: An error page indicating that an API key is required.

### Rate Limit Exceeded

- **Status Code**: `429 Too Many Requests`
- **Condition**: If the number of requests to the map service exceeds the allowed rate limit.
- **Response**: An error page indicating that the rate limit has been exceeded.

### Data Loading Errors

- **Condition**: Errors can occur if specified `source`(s) are invalid, data cannot be fetched, or the data is malformed.
- **Response**: An error page will be displayed, often with a status code and message from the underlying map loading process (e.g., `400 Bad Request`, `404 Not Found`, `500 Internal Server Error`). The specific message will depend on the nature of the error.

## PostMessage API

The Audiom Embed API provides bidirectional communication between embedded maps and parent windows using the `postMessage` API. This allows external applications to control the embedded map and receive real-time updates about user interactions.

### Enabling the API

The PostMessage API is **disabled by default** for security. To enable it, you must specify which origins are allowed to communicate with the embedded map using the `allowedOrigins` URL query parameter (see [allowedOrigins](#allowedorigins-optional-required-to-enable-postmessage-api) in the Query Parameters section above).

**Complete embed URL example**:
```
/embed/dynamic?source=osm&latitude=47.6495&longitude=-122.1431&apiKey=xyz123&allowedOrigins=https://myapp.com
```

### Message Format

All messages follow a consistent structure with `type` and `payload` properties:

```typescript
interface Message {
  type: string;
  payload: object;
}
```

### Outbound Events (Embed → Parent)

These events are sent from the embedded Audiom map to your parent window.

#### `ready`

Sent when the embed is fully initialized and ready to receive commands.

```javascript
// Payload
{
  apiVersion: "1.0.0"  // Semantic version of the API
}
```

#### `positionChanged`

Sent whenever the avatar's position changes.

```javascript
// Payload
{
  position: [longitude, latitude]  // GeoJSON coordinate order
}
```

#### `featureEntered`

Sent when the avatar enters one or more map features (e.g., buildings, parks).

```javascript
// Payload
{
  features: [
    {
      id: "feature-123",
      name: "Central Park",
      type: "park",
      position: [longitude, latitude],
      properties: { /* original feature properties */ }
    }
  ]
}
```

#### `featureExited`

Sent when the avatar exits one or more map features.

```javascript
// Payload
{
  features: [
    {
      id: "feature-123",
      name: "",  // May be empty for exited features
      type: "unknown",
      position: [0, 0],
      properties: {}
    }
  ]
}
```

#### `featureSelected`

Sent when the avatar crosses a feature boundary. Contains all features currently enclosing the avatar.

```javascript
// Payload
{
  features: [/* array of FeaturePayload objects */]
}
```

#### `stateChanged`

Response to a `getState` query. Contains the current avatar position.

```javascript
// Payload
{
  position: [longitude, latitude]
}
```

#### `error`

Sent when an error occurs processing an inbound command.

```javascript
// Payload
{
  code: "INVALID_ORIGIN",  // Error code
  message: "Origin https://evil.com not allowed"  // Human-readable message
}

// Error codes:
// - INVALID_ORIGIN: Message from disallowed origin
// - INVALID_MESSAGE: Message format is invalid
// - UNKNOWN_COMMAND: Unknown command type
// - COMMAND_FAILED: Command execution failed
// - NOT_READY: API not initialized
```

### Inbound Commands (Parent → Embed)

Send these commands from your parent window to control the embedded map.

#### `moveAvatar`

Move the avatar to a specific geographic position.

```javascript
iframe.contentWindow.postMessage({
  type: 'moveAvatar',
  payload: {
    position: [-122.4194, 37.7749]  // [longitude, latitude]
  }
}, 'https://[your-audiom-instance-url]');
```

#### `getState`

Query the current avatar position. The embed responds with a `stateChanged` event.

```javascript
iframe.contentWindow.postMessage({
  type: 'getState'
}, 'https://[your-audiom-instance-url]');
```

#### `getEnclosingFeatures`

Query the features currently enclosing the avatar. The embed responds with a `featureSelected` event.

```javascript
iframe.contentWindow.postMessage({
  type: 'getEnclosingFeatures'
}, 'https://[your-audiom-instance-url]');
```

#### `setFilters`

Set feature type filters for global display and/or sonar scanning.

```javascript
iframe.contentWindow.postMessage({
  type: 'setFilters',
  payload: {
    global: ['building', 'park'],  // Types to show globally
    scan: ['poi', 'transit']       // Types to include in sonar scan
  }
}, 'https://[your-audiom-instance-url]');
```

#### `executeCommand`

Execute an Audiom keyboard command programmatically.

```javascript
iframe.contentWindow.postMessage({
  type: 'executeCommand',
  payload: {
    command: 'announceCoordinates'  // Command name
  }
}, 'https://[your-audiom-instance-url]');

// Common commands: 'up', 'down', 'left', 'right', 'toggleSonar', 'announceCoordinates', 'announceDirections'
```

Unknown command names are rejected with an `UNKNOWN_COMMAND` error.

### Complete Integration Example

```javascript
// Get reference to the iframe
const iframe = document.getElementById('audiom-embed');
const audiomOrigin = 'https://your-audiom-instance.com';

// Listen for messages from the embed
window.addEventListener('message', (event) => {
  // Security: verify the message origin
  if (event.origin !== audiomOrigin) return;

  const { type, payload } = event.data;

  switch (type) {
    case 'ready':
      console.log('Audiom ready, API version:', payload.apiVersion);
      break;

    case 'positionChanged':
      console.log('User moved to:', payload.position);
      // Update your UI with the new position
      updateMapMarker(payload.position);
      break;

    case 'featureEntered':
      console.log('User entered features:', payload.features);
      // Show feature info in your sidebar
      showFeatureDetails(payload.features);
      break;

    case 'featureExited':
      console.log('User exited features:', payload.features.map(f => f.id));
      break;

    case 'error':
      console.error('Audiom error:', payload.code, payload.message);
      break;
  }
});

// Send a command to move the avatar
function moveToLocation(lng, lat) {
  iframe.contentWindow.postMessage({
    type: 'moveAvatar',
    payload: { position: [lng, lat] }
  }, audiomOrigin);
}

// Query current state
function getCurrentPosition() {
  iframe.contentWindow.postMessage({
    type: 'getState'
  }, audiomOrigin);
}
```

### Security Best Practices

1. **Always specify explicit origins**: Avoid using `allowedOrigins=*` in production. List only the domains that need to communicate with the embed.

2. **Validate message origins**: Always check `event.origin` in your message handler to ensure messages are from your Audiom instance.

3. **Use HTTPS**: Both your application and the Audiom embed should use HTTPS to prevent message interception.

## iFrame Permissions

### Fullscreen Support

Audiom supports fullscreen mode, which is especially useful during demos and presentations. Users can toggle fullscreen by:

- Pressing the `z` key
- Clicking the fullscreen button in the top-right corner of the map
- Selecting "Toggle Fullscreen" from the main menu (press `Enter` to open)

**Important**: For fullscreen to work within an embedded iframe, you must include the `allowfullscreen` attribute on your iframe element:

```html
<iframe
	src="https://[your-audiom-instance-url]/embed/12345?apiKey=xyz123"
	allowfullscreen
></iframe>
```

Or using the modern Permissions Policy syntax:

```html
<iframe
	src="https://[your-audiom-instance-url]/embed/12345?apiKey=xyz123"
	allow="fullscreen"
></iframe>
```

If the `allowfullscreen` attribute is not present, users will receive an audio message saying "Fullscreen is not available" when attempting to enter fullscreen mode.

### Recommended iframe Attributes

For the best user experience, we recommend the following iframe configuration:

```html
<iframe
	src="https://[your-audiom-instance-url]/embed/12345?apiKey=xyz123"
	title="Audiom Interactive Map"
	allowfullscreen
	style="width: 100%; height: 600px; border: none;"
></iframe>
```
