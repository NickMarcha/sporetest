# CONTEXT

The domain model. `AGENTS.md` says how to work here; this says what the words mean and how the pieces relate. When code and this document disagree, one of them is wrong and it is worth finding out which before writing more code.

## The pipeline

Everything in this project is one dataflow, evaluated at two different rates.

```
creature ──▶ field ──▶ skin ──▶ rig          per edit
                                  │
                        intent ──▶├──▶ pose ──▶ pixels   per frame
                          time ──▶│
```

The top row is expensive and runs when the user changes something. The bottom row is cheap and runs sixty times a second. Confusing the two is the second of the three ways to hurt yourself, and it is the one that actually happens.

## The creature

A **creature** is plain serialisable data. It has no methods, no renderer types, and no back-references to anything that draws it.

A creature owns one **spine**: an ordered chain of **vertebrae**, running head to tail. Each vertebra is a position, a radius, and an orientation. The spine is the creature's skeleton before it is a skeleton — it is authored geometry, not a rig.

Vertebrae have stable string identifiers. Recipe mutations and field provenance refer to these identifiers; inserting a vertebra does not rename its neighbours. The first slice implements spine and skin colour. The part and socket contracts below describe the subsequent slice and do not yet have TypeScript representations.

A creature owns **parts**. A part is anything attached to the surface: a limb, a foot, a hand, a mouth, an eye, a decoration. Parts attach at **sockets**, and a socket is both a location and the frame that location implies. Parts are recursive, because a limb is itself a chain of segments and things hang off its end.

Parts carry **caps**, which transfer to their derived bones. A cap is a semantic tag: `foot`, `grasper`, `mouth`, `eye`. Actions select targets by cap rather than hard-coded part names or indices. After selection, the solver and renderer may use resolved indices into typed arrays.

### What is deliberately absent

There is no notion of a legal creature. No base bodies, no rules about which part attaches where, no symmetry requirement, no leg count. A creature is any spine with any parts anywhere, and everything above the line must survive that. If a function only works for a quadruped it is a spike and it says so in a comment.

Curation, if it ever arrives, lives in `editor/` and nowhere else.

## The field and the skin

The **field** is the implicit scalar function a creature defines in space. Vertebrae and limb segments contribute to it. Attached meshes such as eyes, mouths, feet, and decorations do not. Although the authored part hierarchy includes limbs, their segments supply field contributions while their attached meshes socket onto the skin. ADR 0002 has the reasoning.

The **mesher** turns field into **skin**, a triangle mesh. The first implementation uses the surface-nets package to rebuild a sampled grid per edit, in a worker. Field sampling visits only each contribution's support box. Incremental remeshing comes after measuring this baseline. Its invalidation must include the old and new support bounds of every affected contribution, plus neighbouring cells needed for connectivity and normals. Scalar values can move a vertex even when corner signs stay unchanged.

The mesher records **provenance**: which authored vertebrae or limb segments contributed to each vertex, and by how much. The package returns only geometry, so the adapter evaluates provenance at each output vertex. The representation is sparse: offsets per vertex, source indices into a stable identifier list, and unnormalised non-negative values. These values are the input to binding, not final bone weights. Normals come from the negative field gradient, rather than triangle adjacency.

### First field implementation

The field uses Hecker's compact spherical polynomial, `strength * (1 - distanceSquared / supportSquared)^4`, with zero contribution outside its support. Support radius is twice the authored radius, and the isosurface threshold is `(3/4)^4`. Thus a single vertebra has exactly its authored surface radius before grid approximation.

Along each straight spine segment, midpoint quadrature samples spherical contributions with linearly interpolated position and radius. Spacing is at most 0.4 times the smaller endpoint radius. Contribution strength scales with interval length divided by radius; the density constant makes a long straight constant-radius spine meet the same isosurface radius. Half-strength endpoint contributions close the chain. Source fractions interpolate between the segment's two vertebrae. The quadrature and cap treatment are our implementation choices, not algorithms claimed from the paper. They need visual tuning on bent and tapered spines.

The default cell size is a quarter of the smallest authored radius. A sample budget coarsens the grid for unusually large bounds, and the editor reports the actual cell size. This can lose thin features; it is a visible performance limit of the full-grid baseline.

Consecutive coincident vertebrae share a geometric location. The field uses the largest radius there and attributes it to that vertebra's stable identifier, choosing the first on ties. Smaller coincident controls remain in the creature but do not add field density until separated or enlarged.

## The rig

A **rig** is a skeleton plus the weights that bind skin to it.

A **bone** derives from a vertebra, a limb segment, or a part — one bone each. Bones are not vertebrae. They share positions at rest and diverge the moment anything moves, and code that conflates them will produce a creature that looks correct standing still.

**Weights** are per-vertex bone influences. They come from provenance, normalised, then smoothed across mesh adjacency. Smoothing remains the binding decision. Hecker documents torso shear from raw provenance, but does not establish that our adjacency pass will fix it. Bent spines, heavy torsos, and torso-attached parts must be checked together when binding is implemented.

Bones are not solver particles. The IK solver allocates particles where it needs them, which is far fewer places than there are bones. Keeping these two populations distinct is what makes a forty-vertebra torso affordable.

## Pose and motion

A **pose** is bone transforms at one instant. It is the output of animation and the input to rendering, and it is the only thing that crosses between them.

Motion is produced by two systems that do not know about each other.

**Gait** synthesises locomotion. Legs are clustered into **leg groups** by length; groups are harmonised by approximating their length ratios as small whole numbers, which is what keeps mismatched legs from looking broken. Each foot has a **duty factor**, the fraction of the cycle it spends planted, and a **step trigger**, its offset within the cycle. One normalised flight path, scaled by leg length, serves every foot.

**Actions** produce everything else. An action is a function from creature, intent and time to pose goals — looking at something, reaching for something, breathing, chewing. Actions select by cap, never by index.

Both feed **pose goals** into the IK solver, which is the only place they meet. That seam is deliberate and load-bearing: it is where recorded animation would attach if we ever build a tool to record any.

The pipeline diagram omits animation state for brevity. Gait and damped secondary motion need explicit previous state, elapsed seconds, root motion, and ground information. These remain plain data. Ground information is converted into creature space below the rendering boundary. The solver may remain path-independent even though gait tracks planted feet. No implementation should hide this state in renderer objects or module globals.

## Spaces and units

State the space. "Position" is not a complete name for a variable.

- **creature space** — a fixed right-handed authoring frame, +Y up. Moving a vertebra does not recenter this frame. The rig's root-relative rest frame is derived separately.
- **root-relative rest** — every bone's rest transform expressed relative to the root bone. The IK solver's preconditioner lives here.
- **world space** — below the line only.

Distances are metres. Angles are radians. Time is seconds. The gait cycle is normalised to `[0, 1)` and is not time.

Orientations are unit quaternions stored as `[x, y, z, w]`. The initial spherical field is orientation independent; orientations remain authored data for later sockets and rig derivation.

## Invariants

Things that must hold, and that are worth asserting in tests:

- A creature round-trips through serialisation unchanged.
- Every bone traces to exactly one vertebra, limb segment, or part.
- Weights per vertex are non-negative and sum to one.
- A creature with no parts still meshes, rigs, and poses. So does a creature with one vertebra.
- Nothing above the line imports `three`.
