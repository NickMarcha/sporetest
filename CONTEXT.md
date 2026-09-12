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

Vertebrae have stable string identifiers. Recipe mutations and field provenance refer to these identifiers; inserting a vertebra does not rename its neighbours. The current creature contains a spine, skin colour, and recursive limb parts. Separate meshes for feet, eyes, mouths, and details are not implemented yet.

A creature owns **parts**. A part is anything attached to the surface: a limb, a foot, a hand, a mouth, an eye, a decoration. Parts attach at **sockets**, and a socket is both a location and the frame that location implies. Parts are recursive, because a limb is itself a chain of segments and things hang off its end.

Parts carry **caps**, which transfer to their derived bones. A cap is a semantic tag: `foot`, `grasper`, `mouth`, `eye`. Actions select targets by cap rather than hard-coded part names or indices. After selection, the solver and renderer may use resolved indices into typed arrays.

### Limb and socket coordinates

A limb owns an ordered chain of **limb segments**, each with a stable identifier, position, orientation, and radius. Segment transforms are authored in the limb's socket frame, not relative to the preceding segment. This lets the editor reshape a chain without rewriting every subsequent segment. A limb's optional cap transfers to its final bone. It is semantic metadata and creates no attached mesh or field density.

A socket references a source in its immediate parent chain, a vertebra for a top-level limb or a segment for a nested limb. Its position and orientation are relative to that source's authored frame. Resolving the hierarchy composes these transforms into creature space. Moving or rotating the source carries the attachment; changing its radius does not scale the saved socket offset. Viewport placement picks a point on the current skin and converts it to a socket relative to the closest source by distance divided by radius. Later edits preserve that authored offset rather than continuously projecting it onto the skin.

An **arm** is an editor preset for a limb capped `grasper`; the leg preset uses `foot`. Both produce ordinary limb data. Placement uses a ghost preview without meshing. Mirroring reflects across the fixed creature-space plane Z = 0. Each side raycasts the skin to check attachment availability. The second ghost is an exact reflection of the first; the opposite skin must be within its 0.25-metre root radius. Within 0.14 metres of the plane, placement tries a centre-plane raycast and emits one limb when the intersection is nearby. A dashed skin intersection marks this plane. Arms default to mirroring off and legs default to mirroring on.

Placing a pair records one `attach-pair` mutation and a **mirror pair**, two stable limb identifiers saved in the creature. Editing either side reflects its socket and segment rest transforms across creature-space Z = 0 into the partner's attachment frame. Radii, tip caps, segment insertion, and segment removal stay synchronized. Surviving segment identifiers are preserved. Pair dependencies follow attachment ancestry, so parent edits synchronize before nested pairs regardless of JSON array order. Links that create cyclic dependencies are invalid.

Removing a linked limb removes both sides and their dependent branches. Removing an attachment source likewise prunes affected pairs. The `unlink` mutation keeps both limbs and removes their link, permitting asymmetric edits. Mirror links affect authored data per edit; the rig and animation still receive individual limbs with no assumption about symmetry. Viewport dragging converts creature-space positions back into the selected segment's socket frame. Picking is disabled while the displayed skin is waiting for a geometry rebuild and during pose preview.

The field adds a buried connector from the parent source centre to the limb's first segment, using the first segment's radius. The connector blends provenance between parent and limb. Each limb then uses the same continuous-chain field as the spine. Nearby limbs can web together, as described in ADR 0002.

Part and source identifiers are globally unique within a creature. A child socket cannot reference a sibling or its own descendants. Removing a vertebra removes its attached limbs and their descendants. Removing a limb removes its subtree; the editor likewise removes attachments on a deleted segment. Undo restores the complete previous subtree through recipe replay.

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

The rig has one bone per vertebra and limb segment, including coincident sources. The head is the root; each later spine bone is parented to the preceding spine bone. A limb's first bone is parented to its socket source's bone; subsequent bones follow its chain. Parents always precede children. Stable bone identifiers derive from authored source identifiers. Rest transforms use resolved positions and orientations. Local, creature-space, and inverse-bind matrices are column-major arrays, separate from the authored creature.

**Weights** are per-vertex bone influences. Binding resolves provenance identifiers to bones and normalises the source density. Four Jacobi passes then blend half the current weights with half the mean of adjacent vertices. Disconnected surfaces do not exchange weights. The editor exposes the pass count, including zero for comparison with raw provenance. The core retains all influences in sparse arrays; the Three.js adapter keeps the strongest four and renormalises them. The editor reports the largest discarded fraction at any vertex.

Hecker documents torso shear from raw provenance, but does not establish that our adjacency pass will fix it. Bent spines, heavy torsos, and torso-attached parts must be checked together as those features arrive. The current bend preview makes smoothing inspectable; it does not establish binding quality for arbitrary creatures.

Bones are not solver particles. The IK solver allocates particles where it needs them, which is far fewer places than there are bones. Keeping these two populations distinct is what makes a forty-vertebra torso affordable.

## Pose and motion

A **pose** is bone transforms at one instant. It is the output of animation and the input to rendering, and it is the only thing that crosses between them.

The current pose implementation composes local transforms through the bone hierarchy and multiplies by inverse-bind transforms for skinning. It reuses allocated matrix buffers. A diagnostic bend distributes local Z rotation along the spine by incoming rest-segment length, leaving the root fixed. Single-vertebra and fully coincident spines remain at rest. Limb flex independently applies a local Z rotation to each limb bone. With zero flex, limbs inherit their parent pose without additional rotation. This preview is forward kinematics, not an action, an IK solver, or a gait. It never mutates the creature or its recipe.

### Limb IK

The Particle IK limb phase takes a supplied, fixed spine pose. A **pose goal** names a stable bone and a desired position in creature-space metres. Foot and grasper goals select bones by cap. Head and tail are ordered spine roles, resolved to stable bone identifiers when compiling the solver. The viewport exposes these goals as draggable orange targets. These are temporary pose controls, independent of authored mirror links. Shape mode returns to the authored creature.

`createLimbIK` compiles only the limb paths needed by the chosen targets. A **particle** is a solver position, separate from a bone. Each top-level limb's first segment stays fixed at its socket position in the supplied base pose. Nested limbs share their ancestor particles. Length constraints carry separate inverse masses for their endpoints; additional cross-constraints preserve separation between immediate active children at branches. Unselected branches inherit their parent's reconstructed pose without participating in the solve.

Each solve starts from the base pose, making its output independent of previous frames. The aim preconditioner rotates toward the average descendant goal and scales only along that direction, then repeats at branches. Nonlinear length corrections iterate from the tips inward. An outward reconstruction enforces exact segment lengths, leaving a positional residual when a goal cannot be reached. Bone orientations use minimal-twist alignment and a second constraint axis at branches. The solver and pose reuse their buffers.

This implementation uses 96 iterations and rigid lengths as a diagnostic baseline. A tiny deterministic perpendicular seed lets a perfectly straight compressed chain start bending. Neither choice is claimed as a parameter from the paper. Soft limb stretch/compression tuning, orientation goals, joint limits, collision handling, and secondary motion remain unimplemented. An uncapped creature has no limb targets; a one-segment limb can only report its fixed socket's distance from the target.

### Spine IK

`createIK` compiles both phases. The head remains the FK root; its target supplies translation while its authored orientation stays fixed. The tail is a positional goal, so its target can retain a residual when the spine cannot reach it. A one-vertebra creature has only the head target.

`createSpineIK` allocates particles at the head, tail, and spine sources supporting active limb targets. Vertebrae between these particles are not solver particles. Adjacent particles have chord constraints bounded to 10–120% of their rest distance. Each limb target contributes a simplified chord constraint to its spine attachment, with the same compression/stretch range. Thus the spine can respond to a foot before the limb phase tries to reach it.

Each intervening span uses a quintic Hermite curve fitted per rig with fixed endpoints and least-squares endpoint derivatives. A small straight-chord prior handles underdetermined fits. Arc-length parameters and transported-frame offsets preserve each authored vertebra's rest position and orientation even when the fitted curve does not pass through it exactly. Derivatives are with respect to the span's normalised parameter and are stored in creature-space metres. Reconstruction rotates endpoint derivatives, scales them with the posed chord, transports frames, and reapplies the saved offsets. Endpoint orientations use minimal-twist tangent alignment; the root keeps its supplied orientation.

The spine uses 32 iterations, followed by outward projection onto its permitted chord ranges. A smooth angular anti-buckling weight compares neighbouring chords against the root-relative rest shape and pulls folding attachment regions toward that reference. The gains, derivative regularisation, and finite-difference endpoint tangents are our initial tuning choices. The 10–120% limits apply to reduced chords, not every reconstructed vertebra spacing. This is a positional IK baseline, not a guarantee against self-intersection or implausible poses. The limb phase then freezes the reconstructed spine and uses the existing solver. Both phases restart from rest relative to the requested root, reuse buffers, and leave the recipe and skin topology unchanged.

Motion is produced by two systems that do not know about each other.

**Gait** synthesises locomotion. Legs are clustered into **leg groups** by length; groups are harmonised by approximating their length ratios as small whole numbers, which is what keeps mismatched legs from looking broken. Each foot has a **duty factor**, the fraction of the cycle it spends planted, and a **step trigger**, its offset within the cycle. One normalised flight path, scaled by leg length, serves every foot.

**Actions** produce everything else. An action is a function from creature, intent and time to pose goals — looking at something, reaching for something, breathing, chewing. Actions select by cap, never by index.

Both feed **pose goals** into the IK solver, which is the only place they meet. That seam is deliberate and load-bearing: it is where recorded animation would attach if we ever build a tool to record any.

The pipeline diagram omits animation state for brevity. Gait and damped secondary motion need explicit previous state, elapsed seconds, root motion, and ground information. These remain plain data. Ground information is converted into creature space below the rendering boundary. The solver may remain path-independent even though gait tracks planted feet. No implementation should hide this state in renderer objects or module globals.

## Spaces and units

State the space. "Position" is not a complete name for a variable.

- **creature space** — a fixed right-handed authoring frame, +Y up. Moving a vertebra does not recenter this frame. The rig's root-relative rest frame is derived separately.
- Spine dragging intersects the fixed Z = 0 mirror plane, keeping body shaping centred regardless of the camera angle. Numeric Z edits still allow an asymmetric body. Align spine sets every vertebra's Z to zero in one undo step, carrying sockets through the existing move mutations.
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
