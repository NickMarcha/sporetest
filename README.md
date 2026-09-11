# SporeTest

A spine editor with a live implicit skin, automatic spine binding, and a bend preview. Rigging and pose evaluation run independently of the renderer.

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

Enable Preview pose to bend the bound skin. Sweep through the bend animates a four-second cycle. Shape controls are disabled during preview; turn it off to edit again. Weight smoothing compares raw provenance with adjacency-smoothed binding and reuses the existing skin. Posing and smoothing are diagnostics and are not saved in recipes.

The status bar reports worker meshing time, triangle count, actual grid cell size, and completed builds. Camera motion, selection, colour changes, posing, and smoothing do not trigger meshing. Binding has a separate timing display. Timings exclude transfer and rendering, so they are not end-to-end input-latency measurements. GPU reduction reports the greatest fraction of weight discarded at a vertex when packing four influences for Three.js.

## Verify

```powershell
npm test
npm run typecheck
npm run build
```

Tests use Node's built-in runner and TypeScript support. Run individual core files with `node --test src/field/field.test.ts`, for example. `typecheck` covers all TypeScript, including the client bootstrap and worker; Astro builds the page shell.

Visual checks should include dragging, undoing a whole drag, changing radius, inserting and deleting vertebrae down to one, orbiting without increasing the build count, and inspecting wireframe and skin detail. Watch a full bend sweep, compare raw and smoothed binding, and confirm that these operations leave the build count unchanged. Browser control requires permission under AGENTS.md.

## Architecture

`creature/` owns plain data and recipe mutations. `field/` compiles the spine into compact spherical contributions. `mesh/` samples the field and adapts surface nets into typed arrays with provenance and field normals. `rig/` derives bones and sparse weights; `anim/` evaluates poses and provides a CPU skinning reference. `render/` owns Three.js and GPU skinning; `editor/` owns inputs and the worker lifecycle. Astro mounts the application once.

Meshing and binding run after edits, in a worker with one active request and one replaceable pending request. Smoothing changes only rebind. The frame loop evaluates preview poses into reused buffers, updates the camera, and draws. The grid currently remeshes in full. Its sample budget can coarsen unusually large creatures and lose thin features; the displayed cell size makes that limit inspectable. `surface-nets` needs a browser Buffer dependency and a build-time `global` alias, configured in `astro.config.mjs`.

There are no parts, IK, or gait yet. The bend preview exercises spine binding; it does not prove automatic locomotion or binding quality for future limbs and attachments. Read [CONTEXT.md](CONTEXT.md) and [the ADRs](docs/adr/) before changing these contracts.
