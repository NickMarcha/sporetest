# SporeTest

SporeTest asks one question: can modern web tech rebuild the Spore creature creator?

You drag out a spine, hang limbs and eyes and mouths off it, and a skin meshes over the whole thing while you work. Then the thing you invented gets rigged, and it walks.

Where it goes after that, in order: a playground where the algorithms can be tuned by eye with instant reload, then a gallery with accounts where people make creatures and come back for them, then possibly a small multiplayer game in the shape of an `.io` title. Each stage only starts because the one before it worked.

There is a sibling project at `../unreal-spore-test`, a wuxia game in Unreal that shares this project's ancestry and several of its algorithms. It is not this project. Decisions do not automatically cross between them, and neither repo is authoritative for the other.

## What is actually under test

The editor is a known quantity. Dragging control points and polygonising a blob are solved problems with published algorithms.

The unsolved part is everything downstream. A mesh generated thirty seconds ago, from a topology nobody anticipated, has to be given a skeleton, bound to it with sensible weights, and animated with a gait derived from however many legs the user happened to attach. No artist ever sees this creature. No animator authors its walk cycle. If that pipeline holds, the test passes.

So: **the rigging and animation architecture is the deliverable.** Every layer boundary in this document exists to serve it. When a decision is close, ask which option leaves rigging more room.

## Status

Design is settled. `CONTEXT.md` holds the domain model, and `docs/adr/` records the five decisions that would be expensive to reverse. Read both before you write anything.

The first slice implements the spine editor and mesher: drag vertebrae, adjust radii, and watch a skin appear. Recipes can be downloaded as JSON. Skin already carries authored-source provenance and analytic field normals. Rigging comes next; parts, binding, IK, and gait are not implemented yet.

Meshing runs in a worker on edits, with one in-flight request and the newest pending edit. The surface-nets package currently rebuilds the full sampled grid. This is the measured baseline before incremental remeshing.

Nothing here is shipped. See the note on backward compatibility below, which says exactly when that changes.

## Glossary

Use these words exactly. Do not substitute "node", "joint", "model", "entity", or "component" for anything below, and do not invent synonyms mid-file.

- **you** means the agent reading this file.
- **we** and **I** mean Nicolas, who owns this repo. You are talking to me.
- **user** means whoever is using the creature creator. For now that is also me, but design as though it is not.
- **creature** means the whole authored thing: spine, parts, colors. Pure data, serialisable, no rendering types anywhere near it.
- **spine** means the ordered chain of vertebrae running head to tail. It is the creature's skeleton before it is a skeleton.
- **vertebra** means one control point on the spine: a position, a radius, an orientation.
- **part** means anything attached to the surface: limb, foot, hand, mouth, eye, detail. A limb is itself a chain, so parts are recursive.
- **socket** means where a part attaches, and the frame it attaches in. The seam between "the user placed this" and "the mesher must account for it".
- **field** means the implicit scalar function the creature defines in space. Vertebrae and limb segments contribute to it. **Parts do not.** See ADR 0002.
- **cap** means a semantic tag on a bone: `foot`, `grasper`, `mouth`, `eye`. Caps are how animation talks about a creature it has never seen. Never address a bone by index.
- **leg** means a path from a spine bone to a bone capped `foot`. **leg group** means legs of roughly equal length, clustered so they share a gait cycle.
- **action** means a function from creature, intent and time to pose goals. It is what we have instead of animators.
- **recipe** means the serialised creature: a base plus an ordered list of mutations. It is what gets saved and retrieved.
- **skin** means the triangle mesh polygonised out of the field.
- **mesher** means the thing that turns field into skin.
- **rig** means the skeleton plus the skin weights that bind skin to it.
- **bone** means one element of the rig. Bones derive from vertebrae and limb chains. They are not the same objects, and conflating them will hurt.
- **weights** means the per-vertex bone influences produced by binding.
- **pose** means bone transforms at one instant. The output of animation, the input to rendering.
- **gait** means the procedural walk: which feet are planted, where they reach, how the body rides on top.
- **editor** means the tools, gizmos, and panels that mutate a creature.
- **viewer** means the read-only path: given a creature, render it.

## Layers

The single most important line in this project is the one between plain data and Three.js.

```
creature/   spine, parts, sockets              pure data
field/      creature -> scalar field           pure
mesh/       field -> triangles                 pure
rig/        creature + skin -> bones, weights  pure
anim/       rig + time + intent -> pose        pure
--------------------------------------------------- the line
render/     pose + skin -> pixels              Three.js lives here
editor/     input -> mutations on creature     Three.js for gizmos only
```

Everything above the line takes and returns plain arrays, plain objects, and numbers. It does not import `three`. It has no canvas, no GPU, no requestAnimationFrame. It runs in a test file with no browser.

Everything below the line is glue. It is allowed to be dull and it is allowed to be thrown away.

This is not architectural decoration. It is how the hard question gets answered: if binding and gait are pure functions over plain data, you can test them, diff them, and reason about them. If `Vector3` from `three` reaches into `rig/`, that is gone, and so is the point of the exercise.

## The three ways to hurt yourself

1. **Leaking the renderer upward.** The moment a Three.js type appears above the line, the test seam is dead and the architecture stops being the thing under test. Convert at the boundary, in `render/`, and only there. Yes, this means writing our own small vector math above the line, or taking a dependency that is not `three`. That cost is deliberate.

2. **Working per frame when you could work per edit.** Remeshing is the expensive operation. It belongs to editing, not to the frame loop. Posing and skinning belong to the frame loop. Confusing the two is how this ends up at 12fps with a stuttering camera. Do not allocate inside the loop either: reuse buffers, mutate in place, and keep the GC quiet.

3. **Handing the architecture to a library.** A physics engine, an animation system, or an IK package that owns the update loop will decide the rigging model for us, and the rigging model is the deliverable. Libraries below the line are welcome. Libraries that want to own `rig/` or `anim/` need an ADR first.

One more, less dramatic: **do not bake in a creature.** No assumption about leg count, symmetry, or spine length survives contact with a user. If a function only works for a quadruped, it is a spike, and it should say so in a comment.

## Principles

Adapted from Marcos Hernanz and from Theo's notes on T3 Code. They are good defaults, not law. My preferences override anything here, and if a rule fights the task in front of you, say so out loud instead of quietly working around it.

- **Do not preserve backward compatibility.** Nothing has shipped. Nobody depends on this. Remove obsolete paths instead of adding fallbacks, shims, or migrations. This rule stays in force until I tell you, in words, that something has shipped. Do not infer it from a deploy, a server, or a saved creature. Ask if you think the moment has come; do not decide it yourself.
- **Simplest implementation that fully meets the current requirement.** No speculative abstraction, no configuration for a case that does not exist yet, no indirection that buys nothing today.
- **Grow in layers.** Start from the smallest version that works end to end, then add capability on top of something that already runs. Never trade a working product for unfinished complexity.
- **Lean on what is already installed** before writing your own or adding a package. Check the library's docs and types before concluding it cannot do the thing.
- **Decide for the long term above the line, stay disposable below it.** This is where Marcos and Theo pull against each other, and the split is by layer. `creature/`, `field/`, `mesh/`, `rig/`, and `anim/` get the long-term treatment: get the model right, no stopgaps meant to be replaced later. `render/` and `editor/` are yagni territory. Build the panel you need this week, delete it next week, do not gold-plate it.
- **Latest tech, pinned.** See below.
- **Ambitious ideas, simple systems.** Do not keep complexity because it is already there. Do not add machinery because it looks impressive. Find the real constraint, then find the smallest model that makes the correct behavior unsurprising.

## Decisions already made

Full reasoning is in `docs/adr/`. The short version, so you do not relitigate:

| decision | choice | ADR |
|---|---|---|
| mesher | surface nets, not marching cubes | 0001 |
| what feeds the field | spine and limbs only; parts socket on top | 0002 |
| weight binding | provenance from the field, then a smoothing pass | 0003 |
| IK solver | Particle IK, ported from Hecker et al. | 0004 |
| gait | leg groups, duty factor, step trigger | 0005 |

Two more that did not warrant a file. Vector maths above the line is **gl-matrix**, because writing your own slerp and minimal-twist rotation is a time sink and both are load-bearing. Recipes are **plain JSON**, because nothing in the current requirements needs them small.

## Versions

Run the latest, pin it exactly, and treat upgrading as its own task rather than something that happens in the middle of a feature.

Exact versions in `package.json`, no `^` and no `~`. Node pinned in `.nvmrc`. When you notice something is behind, say so and let me decide. Do not bump it as a side effect of other work.

Current latest as of 2026-08-26:

| | version | note |
|---|---|---|
| Node | 26.7.0 | Current channel, not LTS. Active LTS is 24.19.0 (Krypton) |
| TypeScript | 7.0.2 | the native rewrite, not a point release on 5.x |
| Astro | 7.2.7 | |
| Vite | 8.2.2 | |
| three | 0.185.1 | plus `@types/three` 0.185.4 |

Two things to know. Node 26 is the Current channel, so it is the literal latest and not the safest. Flipping to 24 LTS is an ADR away if the runtime starts costing us time. TypeScript 7 is the Go-native compiler, fast and young, so if something type-checks strangely, suspect the compiler before you suspect yourself.

## Stack

**Astro** for the shell, **Vite** underneath it, **TypeScript** throughout, **Three.js** for rendering.

Astro is here for flexibility at low cost: a landing page, docs, and eventually a gallery all come free, and the editor lives as one client-only island. Be honest about that shape. The editor is not an Astro component tree that happens to draw. It is a self-contained TypeScript application that Astro mounts and then leaves alone.

Three.js is the deliberate application of "lean on established libraries". Writing a renderer is not what is being tested. Skinning, morph targets, and post-processing already exist, and the interesting work is upstream of all of them.

## Where code will live

The first slice contains `creature/`, `field/`, `mesh/`, `render/`, `editor/`, and `pages/`. The remaining directories below are planned.

```
src/
  creature/   spine, parts, sockets, serialisation
  field/      implicit surface from a creature
  mesh/       polygonisation
  rig/        skeleton derivation, weight binding
  anim/       gait, IK, pose evaluation
  render/     Three.js scene, materials, passes
  editor/     tools, gizmos, panels
  pages/      Astro
docs/
  adr/
CONTEXT.md
```

## Verifying

Test the pure core. Look at the pixels.

Everything above the line ships with tests, because it is pure functions over plain data and testing it is cheap. Spine math, field evaluation, mesh topology, weight binding, gait phase, and IK solutions all have right answers you can assert on.

Everything below the line is verified by running it and looking. There is no useful assertion for "the shading reads as skin". Do not write pixel-diff tests, do not mock the GPU, and do not build a screenshot harness. If you want to know whether it looks right, run it and look, or ask me to.

Run the tests you touched, not the whole suite. Typecheck the scope you changed.

For anything animated, "it renders" is not the test. Frames matter. A walk cycle that looks correct in a still and slides its feet across the floor in motion is broken. Capture a few seconds and watch it, or tell me to.

Ask before you drive a browser or use computer use.

## Research and network access

Reading the literature is part of this project. The Spore papers, the graphics papers they cite, and the prior-art repos are all things you will want more than once. Fetch them once.

Cache every fetched resource under `%TEMP%\claude\C--Users-Nicol-Desktop-SporeTest\web-cache\`. That directory is outside the repo, survives between sessions, and is never committed. Before you fetch anything, look there first. Name files after what they are, not after the URL that produced them, and keep a `sources.md` next to them mapping file to origin URL and fetch date.

When you want a repository, clone it. `git clone --depth 1` into the cache, then read it with the normal file tools. Do not page through a repo one file at a time over the network. The same applies to documentation sites that ship their source in a repo: clone the repo, read the markdown.

PDFs need `pypdf`, which is installed. Extract to text once, cache the text alongside the PDF, and read the text after that.

## Taste

- Inferred types over annotations. `any` is the enemy. Above the line, so is `unknown` used as an escape hatch.
- Comments explain why a thing exists and how it is meant to be used. They do not narrate the next line. Algorithms taken from a paper get a link.
- Name things from the glossary. If you need a word that is not in it, that is a signal to add it to `CONTEXT.md`, not to invent a local synonym.
- Numeric code states its units and coordinate space. "position" is not enough. Say whose space it is in.
- Prefer flat and typed arrays for anything the frame loop touches. Prefer readable objects everywhere else.
- If it looks wrong on screen, it is wrong, whatever the tests say.

## Working with me

- **Prefer not to use Python.** All else equal I would rather avoid it, so reach for TypeScript or a native tool first. This is a tie-breaker, not a ban: where Python is genuinely the right tool for a specific job, use it and say in one line why it won.
- **Do not write memory files.** No notes about me or this project persisted under `.claude/`, no `memory/` directory, nothing squirrelled away outside the repo for a future session to read. If something is worth remembering, it goes in this file where I can see it and edit it.
- Do not commit implementation plans, scratch notes, or agent working files. Keep them outside the repo.
- Do not commit or create a PR unless I ask.
- Tell me when you are uncertain instead of picking silently. On a project whose whole point is finding out whether an approach works, a confidently wrong assumption costs more than a question.
