# [Draft] AccessMap Beyond The Curb

## Open Source Assistive Technology Hackathon: Door-to-Door Accessibility Explorer

A hackathon project that combines **accessible routing** with **street-level frontage review** so participants can evaluate whether a trip is usable **from real origin to real destination**, not just from one sidewalk segment to another.

This repo is for teams building:

- an **accessible routing layer** powered by the **AccessMap API**
- a **frontage visibility layer** powered by the **Mapillary API**
- a **barrier identification layer** that flags where a route works on the network but may fail at the door, entry, curb, or bus boarding platform

---

## Why this project matters

Most trip-planning tools stop too early. They may show that a sidewalk or transit stop is nearby, but they often do **not** answer the practical question:

> Can someone actually get from their true starting point to their true destination in a way that matches their mobility needs?

This project focuses on the gap between:

1. the **network route** on the sidewalk graph, and
2. the **frontage approach** between the sidewalk and the actual entry, boarding pad, or destination access point.

A route can succeed on paper and still fail in reality because of:

- stairs at the entrance
- missing curb ramps
- unclear frontage paths
- inaccessible bus stop landing zones
- obstructions near the final approach

---

## Hackathon objective

Build a lightweight tool that:

1. accepts a start point, end point, and mobility preferences
2. requests an accessible route from the AccessMap API
3. retrieves nearby street-level imagery from Mapillary around the origin and destination frontages
4. presents the route and imagery together
5. classifies the trip with a simple label such as:
   - `Origin/destination fully reviewable`
   - `Origin/destination accessible`
   - `Origin/destination frontage uncertain`
   - `Origin/destination barrier`
  
**The application included in this repo achieves the first 4 objectives!**

---

## Suggested user stories

- As a wheelchair user, I want to know whether I can get from **my apartment entrance to a grocery entrance**.
- As a rider using transit, I want to know whether I can get from **my home door to a bus stop boarding zone**.
- As a planner, I want to identify locations where **the route works on the map but fails in the frontage zone**.
- As an advocate, I want to show why **a route line alone is not enough** to represent accessibility.

---

## Getting started

TBD

---

## AccessMap API quick start

For this hackathon, use the **shortest path custom routing endpoint**:

```http
GET https://www.accessmap.app/api/v1/routing/shortest_path/custom.json
```

### Required query parameters

- `lon1` — origin longitude
- `lat1` — origin latitude
- `lon2` — destination longitude
- `lat2` — destination latitude

### Optional routing controls

- `uphill` — maximum tolerated uphill incline percentage
- `downhill` — maximum tolerated downhill incline percentage
- `avoidCurbs` — `0` or `1`
- `streetAvoidance` — `0.0` to `1.0`
- `avoidPrimaryStreet` — `0` or `1`
- `timestamp` — epoch timestamp for time-restricted routing cases

### Example request

```http
GET https://www.accessmap.app/api/v1/routing/shortest_path/custom.json?lon1=-121.914971&lat1=47.647018&lon2=-121.913763&lat2=47.6485371&uphill=0.05&downhill=0.099&avoidCurbs=1&streetAvoidance=1
```

### AccessMap response codes to handle

- `Ok` — route found
- `InvalidWaypoint` — origin and/or destination are not close enough to a traversable path
- `NoPath` — valid points, but no route available under the chosen constraints
- `NoGraph` — server-side graph error

### Why AccessMap matters here

AccessMap gives us the **network-level accessibility answer**. It tells us whether the route can be traversed on the modeled pedestrian graph under the user's mobility constraints.

What it does **not** fully answer is whether the **frontage approach** to the real door, stop pad, or entrance is usable. That is where Mapillary helps.

---

## Mapillary API quick start

Mapillary is the imagery side of this project.

Use it to:

- find street-level images near the start frontage
- find street-level images near the destination frontage
- inspect curb edges, sidewalk-to-entry transitions, frontage walkways, and boarding contexts
- optionally display imagery in a custom viewer experience

### How to get a Mapillary token

1. Create a Mapillary account.
2. Open the developer dashboard and register an application.
3. Copy the **Client Token** from the dashboard.
4. Store it in your local `.env` file as `MAPILLARY_CLIENT_TOKEN`.

For this project, the **Client Token** is usually enough for **read access** to the API.

---

## Minimum viable demo

A strong MVP for the hackathon should:

- let the user click a start point and destination
- allow a small set of mobility constraints
- request and draw the AccessMap route
- fetch 3–10 Mapillary images near each endpoint
- show imagery beside the route
- produce a simple classification label
- explain uncertainty in plain language

---

## Stretch goals

- add bus stop specific workflows
- add a confidence score
- rank imagery by approach direction
- support reviewer annotations
- export a review as JSON or GeoJSON

---

## Project wiki / docs

See [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) for:

- AccessMap endpoint details
- Mapillary API
