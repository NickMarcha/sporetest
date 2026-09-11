# 0003 - Weights from provenance, then smoothed

Status: accepted, 2026-08-26

## Context

A mesh generated thirty seconds ago, from a topology nobody anticipated, has to be bound to a skeleton with no artist in the loop. This is the crux of the whole project.

The field already knows, at every point in space, which bodies contributed and how much. Throwing that away and re-deriving it from geometry is doing the same work twice, worse.

## Decision

Record provenance during meshing - which bodies contributed to each vertex, and by how much. Normalise those contributions into bone weights. Then run a smoothing pass that relaxes weights across mesh adjacency.

## Consequences

Provenance avoids reconstructing source ownership from geometry. The initial mesher adapter evaluates contributions at output vertices because the surface-nets package does not retain them. Normalisation, adjacency construction, smoothing, and any influence reduction still have a cost that must be measured when binding is implemented.

The smoothing pass remains required by this decision. Hecker reports torso shear and poor spine weights, but does not prescribe our adjacency smoothing algorithm or establish its sufficiency. Validate deformation on bent spines, heavy torsos, and torso-attached parts rather than treating normalised weights as proof of a good bind.

Parts need no binding at all. They are separate meshes rigidly bound to their own bone, so this only has to cover the skin.

Provenance must survive the mesher. If an optimisation pass discards it, binding breaks, so it is part of the mesher's contract rather than a side effect.

## Alternatives

**Bone heat or geodesic voxel binding.** The standard automatic approach, robust to geometry it knows nothing about. Slower by orders of magnitude, and running heat diffusion on every drag would destroy the edit loop. Worth keeping in mind as a fallback for cases provenance handles badly.

## Sources

Chris Hecker, *My Liner Notes for Spore* - on generating weights from which parts generated which metaballs, and on the spine-joint and obese-torso failures.
