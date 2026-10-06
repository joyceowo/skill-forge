# D3 7.9.0

The unmodified UMD distribution is stored locally so the viewer works offline.

- Official documentation: https://d3js.org/getting-started#d3-in-vanilla-html
- Pinned distribution: https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js
- Original license: https://raw.githubusercontent.com/d3/d3/v7.9.0/LICENSE
- License copy: `LICENSE-D3` (ISC)

No package installation or runtime CDN request is required.

# d3-voronoi-treemap 1.1.2 (with d3-voronoi-map 2.1.1, d3-weighted-voronoi 1.1.3)

Used only by `globe.html` to shape systems and modules as territories on the planet. The unmodified UMD builds extend the global `d3` and must load after `d3.v7.min.js`, in this order: `d3-weighted-voronoi.js`, `d3-voronoi-map.js`, `d3-voronoi-treemap.js`.

- Sources: https://cdn.jsdelivr.net/npm/d3-weighted-voronoi@1.1.3/build/d3-weighted-voronoi.js, https://cdn.jsdelivr.net/npm/d3-voronoi-map@2.1.1/build/d3-voronoi-map.js, https://cdn.jsdelivr.net/npm/d3-voronoi-treemap@1.1.2/build/d3-voronoi-treemap.js
- License copies: `LICENSE-d3-weighted-voronoi`, `LICENSE-d3-voronoi-map`, `LICENSE-d3-voronoi-treemap` (BSD-3-Clause)
- If they are missing, globe.html falls back to rectangular territories.
