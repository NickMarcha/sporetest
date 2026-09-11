# SporeTest

A spine editor with a live implicit skin. The first slice of a procedural creature creator, built to leave automatic rigging and animation independent of the renderer.

## Run

Use Node **26.7.0**, recorded in `.nvmrc`. With nvm-windows, install and select it explicitly:

```powershell
nvm install 26.7.0
nvm use 26.7.0
npm ci
npm run dev
```

Open the local URL printed by Astro, normally `http://127.0.0.1:4321`.

Drag a vertebra in the viewport or select one in the sidebar. Adjust its radius and position, add or remove vertebrae, and use Undo or Redo to revisit edits. Drag empty space to orbit; scroll to zoom. Frame creature fits the current skin into view. Save recipe downloads the base creature and ordered mutations as JSON. Loading recipes is not implemented yet; `replayRecipe` reconstructs them in the pure core.

The status bar reports worker meshing time, triangle count, actual grid cell size, and completed builds. Camera motion, selection, and colour changes do not trigger meshing. Mesh time excludes transfer and rendering, so it is not an end-to-end input-latency measurement.

## Verify

```powershell
npm test
npm run typecheck
npm run build
```

Tests use Node's built-in runner and TypeScript support. Run individual core files with `node --test src/field/field.test.ts`, for example. `typecheck` covers all TypeScript, including the client bootstrap and worker; Astro builds the page shell.

Visual checks should include dragging, undoing a whole drag, changing radius, inserting and deleting vertebrae down to one, orbiting without increasing the build count, and inspecting wireframe and skin detail. Browser control requires permission under AGENTS.md.

## Architecture

`creature/` owns plain data and recipe mutations. `field/` compiles the spine into compact spherical contributions. `mesh/` samples the field and adapts surface nets into typed arrays with provenance and field normals. `render/` owns Three.js; `editor/` owns inputs and the worker lifecycle. Astro mounts the application once.

Meshing runs only after edits, in a worker with one active request and one replaceable pending request. The frame loop only updates the camera and draws. The grid currently remeshes in full. Its sample budget can coarsen unusually large creatures and lose thin features; the displayed cell size makes that limit inspectable. `surface-nets` needs a browser Buffer dependency and a build-time `global` alias, configured in `astro.config.mjs`.

There are no parts, bones, weights, IK, or gait yet. Skin provenance is unnormalised source density, ready for the later binding layer. Read [CONTEXT.md](CONTEXT.md) and [the ADRs](docs/adr/) before changing these contracts.
