# 0001 - Surface nets, not marching cubes

Status: accepted, 2026-08-26

## Context

The mesher turns the creature's implicit field into a triangle mesh, and it runs every time the user drags anything. It is the most expensive operation in the editor, so its cost model matters more than its output quality.

Spore used ear-clipping with Moore & Warren's mesh displacement. That choice carries no information for us: the marching cubes patent was live in 2005 and this was a way around it. The patent has expired.

## Decision

Surface nets. One vertex per cell whose corner signs differ, positioned by interpolating the crossings, then quads between adjacent cells.

## Consequences

Moving a vertebra changes scalar values within the old and new support bounds of affected contributions. These values can move surface vertices without changing corner signs. Incremental updates must invalidate those bounds plus neighbouring cells needed for connectivity and normals.

Triangle sizes come out far more uniform than marching cubes produces. That matters downstream: weights and deformation read badly across slivers, and we are binding automatically with no artist to fix it.

The surface is smooth everywhere, with no sharp features. For a creature made of blended clay this is what we want. If we ever need a hard edge, we do not get one.

`surface-nets` on npm has no `three` dependency, so it can sit above the line. The first slice uses version 1.0.2, which has no incremental-update or provenance API. Its adapter converts grid coordinates to creature space and evaluates provenance at output vertices. Start with full remeshing in a worker and measure it; replace the package when it becomes the bottleneck. Compact-support sampling and retained provenance are required from the start.

## Alternatives

**Marching cubes.** Familiar and well documented. Produces slivers and topology that shifts unpredictably with the isosurface, which is exactly the input that makes automatic weighting look bad.

**Dual contouring.** Surface nets plus sharp feature preservation, at the cost of Hermite data and a QEF solve per cell. We would be paying for the one property we actively do not want.

## Sources

Chris Hecker, *My Liner Notes for Spore* - on the ear-clipping workaround and its cause.
