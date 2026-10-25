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

## The graphical builder

```bash
node bin/flmap.mjs serve ../maps-folder --port 5183 --open
```

A local web app over a library folder (`web/`, served by `lib/server.mjs`,
no dependencies). Everything below is also there, pointed and clicked:

- **New from real terrain** — pick the spot on a slippy map (USGS aerial or
  topo), drag the coverage box, build; the CLI runs underneath and its
  progress streams into the page.
- **Edit any map** — a hillshaded top-down view. Stand points and launch
  starts are draggable; the **View tool** marks everything you *cannot* see
  from a spot (red), with a horizon panorama, so a launch site gets picked
  before it is flown. Runways flatten the ground under themselves. Terrain
  brushes, surface painting, and obstacles — trees, forest scatter,
  buildings, poles, wires, gates — write straight into the format.
- **Fly it** — the server serves the library with CORS at `/library/`, so
  Flightline's *Settings → Map → Map library* can read your edits live,
  before anything is published.
- **Save & publish** — the editor's Save commits the map it just saved and
  pushes it, because the sim's default library is the *published* one: a map
  saved to this folder and not pushed is a map the sim never sees, and an
  afternoon of moved stand points stayed invisible that way. Untick **publish**
  beside the button to save to the folder only (offline, or not ready) — the
  sim can still read the folder live, see *Fly it* above. Remembered.
- **Publish…** — the topbar button, for several maps at once or after saving
  with publish off. A scoped `git add` of just the maps you picked (plus the
  index), commit, push. Either way, unrelated dirt in the folder is left alone,
  because sessions share a library's working copy.

Every save re-reads the ground under the pilot and settles `fieldElevM` and
`origin.datumElevM` onto it — the datum rule that has cost two altimeter
bugs — and reindexes the library.

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

## Where you stand

A map is kilometres across and a build picks one spot on it to stand — the
centre of the box, unless you pass `--pilot`. On a canyon map the centre of
the box is a wall. The sim can move the stand point at runtime (press **B**
to stand where the aircraft is), but a map should still open somewhere
sensible, and it can carry a list of named alternatives.

```bash
node bin/flmap.mjs sites ../maps-folder/zion-canyon
```

reads the heightfield and prints places worth standing: flat enough to land
on, with the horizon low enough to see the model. **It proposes, it does not
decide** — it has no idea where the road is, whether you are allowed to stand
there, or which way the interesting flying lies. The column that matters is
`open`, how many of sixteen compass directions have a horizon below the sky
angle: it is what separates a usable site from a hole. Then pick and name:

```bash
node bin/flmap.mjs sites ../maps-folder/zion-canyon \
  --pilot "250,346" \
  --set "-2470,-1830,Canyon mouth" --set "474,1562,East rim"
```

`--set` writes the `sites` array the sim lists under **Settings → Map → Where
you stand**. `--pilot` moves the map's default, and takes with it the three
things that have to move together: the pilot-anchored starts (or you stand on
one side of the canyon and the model appears on the other), `fieldElevM`
(which sets density altitude), and `origin.datumElevM` (or the altimeter
reads a thousand feet while the model sits on the ground). It edits
`map.json` in place and re-downloads nothing.

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
| **USGS NAIP imagery** — `imagery.nationalmap.gov/.../USGSNAIPImagery/ImageServer` | **Verified 18 Oct 2026.** `probe` gets a JPEG, and the eight maps in the public library all carry a 2048 px drape from it. It does 504 on a large render when it is busy, so a failed `--color` is retried at half the size, down to 512 — that is a load problem, not a size limit, and the same request often works minutes later. |
| **USGS NAIP Plus** — `.../USGSNAIPPlus/ImageServer` | **NOT verified.** Answers 504 every time it has been tried from here, at any size. Plain NAIP covers the same job at better resolution. |
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

Two browser checks sit outside `npm test`, because they need a browser.
Playwright is borrowed from the one repo here that carries it:

```bash
NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules node test/smoke-gui.mjs
NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules node test/smoke-publish.mjs
```

`smoke-gui` drives the home view, the editor, a viewshed and a brush stroke.
`smoke-publish` moves a stand point and presses Save, then checks the commit
landed on a real remote — it copies one map into a temp library with its own
bare remote first, so it never touches the real one. That check exists because
the failure it guards is silent: the builder saved, the sim read the published
library, and the edit was nowhere with no error anywhere.

The UTM conversion is checked by round-tripping through an independently
derived inverse series over 5,760 points from 78°S to 82°N: worst closure
0.84 mm. One published reference point (New York, 18N 583959E 4507351N) is
checked too, so the pair cannot be self-consistently wrong together.

What the tests cannot tell you is whether the real services are up. That is
`flmap probe`.

## Licence

MIT.
