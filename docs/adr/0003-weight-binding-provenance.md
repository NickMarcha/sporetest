# 0003 - Weights from provenance, then smoothed

Status: accepted, 2026-08-26

## Context

A mesh generated thirty seconds ago, from a topology nobody anticipated, has to be bound to a skeleton with no artist in the loop. This is the crux of the whole project.

The field already knows, at every point in space, which bodies contributed and how much. Throwing that away and re-deriving it from geometry is doing the same work twice, worse.

## Decision

Record provenance during meshing - which bodies contributed to each vertex, and by how much. Normalise those contributions into bone weights. Then run a smoothing pass that relaxes weights across mesh adjacency.

## Consequences

Binding costs almost nothing, because the field evaluation already computed it. This is what makes per-edit rebinding affordable, and per-edit rebinding is what makes the editor feel live.

The smoothing pass is required, not optional. Hecker names the failure modes: discontinuities at spine joints, and torso shear on heavy creatures. Those are reported from shipping a game to millions of players, so treat them as given rather than as something to discover.

Parts need no binding at all. They are separate meshes rigidly bound to their own bone, so this only has to cover the skin.

Provenance must survive the mesher. If an optimisation pass discards it, binding breaks, so it is part of the mesher's contract rather than a side effect.

## Alternatives

**Bone heat or geodesic voxel binding.** The standard automatic approach, robust to geometry it knows nothing about. Slower by orders of magnitude, and running heat diffusion on every drag would destroy the edit loop. Worth keeping in mind as a fallback for cases provenance handles badly.

## Sources

Chris Hecker, *My Liner Notes for Spore* - on generating weights from which parts generated which metaballs, and on the spine-joint and obese-torso failures.
