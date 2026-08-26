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

A creature owns **parts**. A part is anything attached to the surface: a limb, a foot, a hand, a mouth, an eye, a decoration. Parts attach at **sockets**, and a socket is both a location and the frame that location implies. Parts are recursive, because a limb is itself a chain of segments and things hang off its end.

Parts carry **caps**. A cap is a semantic tag — `foot`, `grasper`, `mouth`, `eye` — and it is the only way the animation layer is allowed to talk about a creature. Nothing downstream may address a part by index or by name. This is the single mechanism that lets an action authored against no particular creature run on every creature.

### What is deliberately absent

There is no notion of a legal creature. No base bodies, no rules about which part attaches where, no symmetry requirement, no leg count. A creature is any spine with any parts anywhere, and everything above the line must survive that. If a function only works for a quadruped it is a spike and it says so in a comment.

Curation, if it ever arrives, lives in `editor/` and nowhere else.

## The field and the skin

The **field** is the implicit scalar function a creature defines in space. Vertebrae and limb segments contribute to it. **Parts do not** — they are separate meshes that socket onto the surface, carrying their own bones and their own deformations. ADR 0002 has the reasoning.

The **mesher** turns field into **skin**, a triangle mesh. Because the field is a sum of local contributions, an edit that moves one vertebra only changes the field near that vertebra, so only cells near it need rebuilding. The mesher is expected to exploit this. A mesher that rebuilds the whole creature on every drag is a correct mesher and a useless one.

While the mesher runs it records **provenance**: which bodies contributed to each vertex, and by how much. Provenance is not a debugging aid. It is the input to weight binding, and discarding it means recomputing from geometry what the field already knew.

## The rig

A **rig** is a skeleton plus the weights that bind skin to it.

A **bone** derives from a vertebra, a limb segment, or a part — one bone each. Bones are not vertebrae. They share positions at rest and diverge the moment anything moves, and code that conflates them will produce a creature that looks correct standing still.

**Weights** are per-vertex bone influences. They come from provenance, normalised, then smoothed across mesh adjacency. The smoothing is not optional polish; the raw provenance weights shear at spine joints and on heavy torsos, which is documented failure rather than speculation.

Bones are not solver particles. The IK solver allocates particles where it needs them, which is far fewer places than there are bones. Keeping these two populations distinct is what makes a forty-vertebra torso affordable.

## Pose and motion

A **pose** is bone transforms at one instant. It is the output of animation and the input to rendering, and it is the only thing that crosses between them.

Motion is produced by two systems that do not know about each other.

**Gait** synthesises locomotion. Legs are clustered into **leg groups** by length; groups are harmonised by approximating their length ratios as small whole numbers, which is what keeps mismatched legs from looking broken. Each foot has a **duty factor**, the fraction of the cycle it spends planted, and a **step trigger**, its offset within the cycle. One normalised flight path, scaled by leg length, serves every foot.

**Actions** produce everything else. An action is a function from creature, intent and time to pose goals — looking at something, reaching for something, breathing, chewing. Actions select by cap, never by index.

Both feed **pose goals** into the IK solver, which is the only place they meet. That seam is deliberate and load-bearing: it is where recorded animation would attach if we ever build a tool to record any.

## Spaces and units

State the space. "Position" is not a complete name for a variable.

- **creature space** — the authored creature's own frame, origin at the root vertebra.
- **root-relative rest** — every bone's rest transform expressed relative to the root bone. The IK solver's preconditioner lives here.
- **world space** — below the line only.

Distances are metres. Angles are radians. Time is seconds. The gait cycle is normalised to `[0, 1)` and is not time.

## Invariants

Things that must hold, and that are worth asserting in tests:

- A creature round-trips through serialisation unchanged.
- Every bone traces to exactly one vertebra, limb segment, or part.
- Weights per vertex are non-negative and sum to one.
- A creature with no parts still meshes, rigs, and poses. So does a creature with one vertebra.
- Nothing above the line imports `three`.
