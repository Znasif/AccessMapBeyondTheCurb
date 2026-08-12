# API Reference

This page is intended as a **hackathon-friendly** reference for the two core APIs used in the Door-to-Door Accessibility Explorer.

---

# 1) AccessMap API reference

## Endpoint

```http
GET https://stage.accessmap.app/api/v1/routing/shortest_path/custom.json
```

## Purpose

Use AccessMap as the **routing engine** for sidewalk-centerline-to-sidewalk-centerline accessible routing.

This endpoint is the backbone of the **network-level analysis**.

## Query parameters

### Required

| Parameter | Description |
|---|---|
| `lon1` | Origin longitude |
| `lat1` | Origin latitude |
| `lon2` | Destination longitude |
| `lat2` | Destination latitude |

### Optional

| Parameter | Description |
|---|---|
| `uphill` | Maximum tolerated uphill incline percentage, e.g. `0.07` for 7% |
| `downhill` | Maximum tolerated downhill incline percentage |
| `avoidCurbs` | `0` or `1`; whether to prefer avoiding curbs and stairs |
| `streetAvoidance` | Preference for avoiding streets, from `0.0` to `1.0` |
| `avoidPrimaryStreet` | `0` or `1`; whether to avoid primary streets where possible |
| `timestamp` | Epoch timestamp for time-restricted routing situations |

## Example request

```http
GET https://stage.accessmap.app/api/v1/routing/shortest_path/custom.json?lon1=-121.914971&lat1=47.647018&lon2=-121.913763&lat2=47.6485371&uphill=0.05&downhill=0.099&avoidCurbs=1&streetAvoidance=1
```

## Response codes

| Code | Meaning |
|---|---|
| `Ok` | A valid route was found |
| `InvalidWaypoint` | The origin and/or destination are not close enough to a traversable path |
| `NoPath` | The points are valid, but no route matches the chosen constraints |
| `NoGraph` | Server-side graph error |

## Response fields to inspect

### Top level

- `code`
- `origin`
- `destination`
- `routes`
- `waypoints`

### Route object

- `distance`
- `duration`
- `geometry`
- `legs`
- `segments`
- `summary`
- `total_cost`

## Useful fields from `legs` and `segments`

These are especially helpful for debugging and UI explanation:

- `crossing`
- `curbramps`
- `incline`
- `indoor`
- `length`
- `surface`
- landmarks metadata when present

## How to use AccessMap in this project

Recommended flow:

1. accept GPS start and end points
2. submit them to AccessMap with profile constraints
3. draw the returned `geometry`
4. inspect `segments` and `legs` for explanation details
5. use the success/failure outcome as the **network baseline**
6. then enrich the result with Mapillary frontage evidence

## Important limitation

AccessMap tells us whether a path exists in the modeled pedestrian network under a mobility profile.

It does **not** fully verify the last frontage approach from sidewalk to:

- building entrance
- clinic door
- apartment gate
- bus stop boarding pad

That is why this project pairs AccessMap with Mapillary.

---

# 2) Mapillary API reference

TBD
