# Flightline map builder

Turns public elevation data into **Flightline RC Sim** map folders — real
terrain you can fly, from USGS 3DEP lidar or any ArcGIS image service.

The format these write is specified in
[`docs/map-format.md`](https://github.com/RealPapaNerf/flightline-sim/blob/main/docs/map-format.md)
in the sim's own repo. One folder per map: `map.json`, `height.u16`, and
optionally `surface.u8` and a colour image.

**No dependencies.** Node 18 or newer, and nothing else — no GDAL, no rasterio,
no PDAL. The elevation layer is lifted from
[relief](https://github.com/RealPapaNerf/relief), the LiDAR-to-STL tool, where
it is already exercised against the live services.

## Run this first

```bash
node bin/flmap.mjs probe
```

Every service this tool uses, reached from your machine, with what came back.
Nothing else here is trustworthy until it passes — see **What has and has not
been verified** below, which is the honest part of this README.

## Build a map

```bash
node bin/flmap.mjs build \
  --center 37.6775,-113.0628 \
  --size 2048 --cell 4 \
  --out ../flightline-maps/cedar-city-field \
  --id cedar-city-field --name "Cedar City field" --region "Cedar City, Utah" \
  --runway -12,0,90,120,10 --flatten-runway \
  --classify --snow-above 2600
```

Then add it to the library's index:

```bash
node bin/flmap.mjs index ../flightline-maps --name "Flightline public maps"
```

and check it:

```bash
node bin/flmap.mjs inspect ../flightline-maps/cedar-city-field
```

`flmap help` lists every option. The ones worth knowing:

| | |
|---|---|
| `--size M` | ground covered, metres square. 2048 is about right for a flying site. |
| `--cell M` | metres per cell. 2 to 4 is the sweet spot; the format caps a side at 1024 posts, so the cell is widened automatically if your size needs more. |
| `--source` | `usgs-3dep` (default), `open-meteo`, or any ArcGIS `/ImageServer` URL. |
| `--runway N,E,YAW,LEN,WID` | a runway rectangle, in local metres, yaw clockwise from north. |
| `--flatten-runway` | level the heightfield under it, feathered over 15 m so there is no step. |
| `--classify` | write a surface grid. **A heuristic** — read the warning below. |
| `--color [naip]` | drape an orthophoto. |
| `--dsm URL` | a first-return surface service; trees and buildings come out of where it stands above the bare earth. |
| `--obstacles FILE` | merge an obstacle array you made some other way. |
| `--dry-run` | work it all out and print it, write nothing. |

## Frag Zone arenas in the same library

A library holds both kinds of map: the heightfield terrain Flightline flies,
and the axis-aligned brush arenas Frag Zone fights in. They share storage and
an index, not a geometry model — neither game can read the other's documents,
so every index entry carries a `kind` and each game lists only what it
understands.

Frag Zone's arena editor saves one `.json` file. To put it in a library:

```bash
node bin/flmap.mjs arena ~/Downloads/my-arena.json --out ../maps-folder \
  --region "An original layout" --author "you"
node bin/flmap.mjs index ../maps-folder --name "Flightline public maps"
```

It lands at `<library>/<id>/map.json`, unchanged except for any metadata you
passed. The arena is checked first — brush and spawn shapes, jump pads,
duplicate waypoint ids, links pointing at waypoints that exist — against the
same rules Frag Zone's own content loader applies, so a map that cannot be
played is refused rather than filed and discovered in someone's browser.
`--force` overrides that if you want the folder anyway.

## What has and has not been verified

This matters more than usual, because a service URL that has moved fails in a
way that looks like your network.

| | Status |
|---|---|
| **USGS 3DEP elevation** — `elevation.nationalmap.gov/.../3DEPElevation/ImageServer` | **Known good.** relief exercises this against the live server; it is the source its README's 1 m Utah examples come from. |
| **Open-Meteo elevation** — `api.open-meteo.com/v1/elevation` | **Known good**, same provenance. ~90 m, a fallback outside the US. |
| **NOAA topo-bathy** — `gis.ngdc.noaa.gov/...` | **Known good**, same provenance. Not useful for a flying site. |
| **USGS NAIP imagery** — `imagery.nationalmap.gov/.../USGSNAIPImagery/ImageServer` and `USGSNAIPPlus` | **NOT verified.** Written from the published USGS service names and never reached from the machine this was built on, which had no outbound access to them. `flmap probe` is the check. |
| **First-return surface (`--dsm`)** | **No default.** USGS 3DEP publishes bare earth nationally; a first-return surface is published by some states and not others, so you supply the URL. |

`flmap build --color` does not fail the build if imagery cannot be fetched: it
says so, says to run `probe`, and writes the map without it. A map without
imagery is still worth flying — the terrain is coloured by surface class and
slope.

## The two heuristics, and what they are not

**`--classify` is not a landcover product.** It reads the shape of the ground:
flat and low in a basin becomes water, steep becomes rock, high becomes snow if
you give it `--snow-above`, the rest is grass or brush by slope. That gets the
rangefinder behaving differently in the places a search flight cares about —
above all water, which comes back at 0.03 reflectivity and gives a TF-Luna
almost nothing. It will also put rock on a steep meadow and miss a reservoir
that is not in a hollow. Pin what you know with `--water-below` and
`--snow-above`, or leave it off: with no surface grid every post is `unknown`
and the sim uses slope and elevation, which is what the built-in field does.

**`--dsm` extraction merges.** Where the surface model stands more than 2.5 m
above the bare earth, connected cells are grouped into one blob and emitted as
a tree or a building by how flat-topped and how rectangular it is — a shed
comes out as a building at its real size, a lumpy canopy as a tree. But a
connected stand of trees becomes **one** cylinder: 120 m of forest is a single
46 m-radius obstacle, not two hundred trees. For "do not fly into the trees"
that is a conservative shape and fine. For threading gaps between trunks it is
not, and doing better needs the lidar returns themselves.

**Per-tree extraction from LAZ class 5 and 6 is not implemented.** It was in
the original plan and it is not here: reading LAZ needs either PDAL (a heavy
native dependency this tool deliberately avoids) or a pure-JS LAZ reader, and
neither is a small job. The hook is `--obstacles FILE`, which merges an
obstacle array in the map format's own shape, so a PDAL pipeline written
separately can feed this without changing anything here.

## Files you downloaded yourself

For a UGRC Utah tile, a LidarExplorer GeoTIFF, or anything else you have
converted with GDAL:

```bash
node bin/flmap.mjs from-grid my-grid.json --out ../flightline-maps/my-field
```

where `my-grid.json` is

```json
{ "cols": 513, "rows": 513, "cell": 4, "lat": 37.6775, "lon": -113.0628,
  "elev": [ 1700.2, 1700.4, ... ] }
```

north-up (row 0 is the north edge), metres above sea level, `cols * rows`
values. `gdal_translate -of AAIGrid` plus a few lines of script gets you there
from a GeoTIFF.

## Where the elevation layer came from

`lib/sources.mjs`, `lib/elevation.mjs`, `lib/raster.mjs` and `lib/geo.mjs` are
copied verbatim from [relief](https://github.com/RealPapaNerf/relief) at commit
`5263350`, with a header on each saying so. They handle the ArcGIS image
service protocol, including the two things that bite: the service widens a
bounding box that is not a whole number of square pixels, silently, about its
centre — so the request is built as a whole number of cells each way and
resampled afterwards — and it answers errors with JSON and HTTP 200, so the
body has to be sniffed.

They were copied rather than imported, and rather than bolting a Flightline
export onto relief, because relief's job is 3D printing and this tool's job is
a flight sim: pilot spots, NED frames, runways and density altitude have no
business in an STL exporter. Keep edits to those four files minimal so the two
copies can still be diffed.

## Tests

```bash
npm test
```

Drives the CLI end to end against a stubbed ArcGIS service — the same
`exportImage` query string, the same raw little-endian Float32 body, rows north
first — so what it exercises is the URL this tool builds and the decode it
does, not a mock of them.

The check that earns its keep compares **every post** of the written map
against the analytic surface the stub served. A flipped row, a transposed axis
or a half-cell offset would all produce a map that looks plausible and is
wrong; here they read as tens of metres of error. It currently comes out under
1.5 m, which is the stub's own curvature between samples.

The UTM conversion is checked by round-tripping through an independently
derived inverse series over 5,760 points from 78°S to 82°N: worst closure
0.84 mm. One published reference point (New York, 18N 583959E 4507351N) is
checked too, so the pair cannot be self-consistently wrong together.

What the tests cannot tell you is whether the real services are up. That is
`flmap probe`.

## Licence

MIT.
