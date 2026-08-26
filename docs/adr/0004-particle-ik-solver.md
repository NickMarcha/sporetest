# 0004 - Particle IK, written here

Status: accepted, 2026-08-26

## Context

Every pose goal in the system converges on one solver. It runs per frame, on a skeleton with more degrees of freedom than goals, with goals that routinely conflict - four legs pulling on one torso is not a chain, it is a tree with contradictory demands.

`AGENTS.md` says a library that wants to own `rig/` needs an ADR. This is that ADR, and it says no library gets it.

## Decision

Port the Particle IK Solver from Hecker et al. Bones become 3-DOF particles joined by 1-DOF length constraints, solved by iterative nonlinear length correction, with a per-constraint, per-endpoint mass value that is pure tuning and means nothing physically.

Two phases. Spine first, allocating particles only at IK branch points and fitting quintic Hermite splines between them, with anti-buckling that blends back toward the root-relative rest pose when the spine folds. Then limbs, with the spine frozen, using an aim preconditioner: rotate and scale the limb so its leaf sits on the goal before iterating, deliberately violating length constraints to get there.

6-DOF goals reduce to 3-DOF position goals at joints. Sub-trees with no goals are not solved; they get passive damped secondary motion that never feeds back.

## Consequences

We write and tune this ourselves, and the aim preconditioner and anti-buckling heuristic are subtle enough that tuning will happen by eye over weeks rather than in an afternoon.

It is a few hundred lines of plain arrays and numbers, so it sits above the line without argument and is testable headless.

Per-endpoint masses and soft constraints are the knobs that make poses read as organic rather than mechanical. No library exposes anything equivalent, which is most of the reason for this decision.

Quintic splines, not cubic. Hecker reports cubics failing to fit the inflection points players actually create, and player-created spines are precisely our input.

## Alternatives

**FABRIK** (`THREE.IK`, `fullik`). Genuinely good on isolated serial chains and simpler to reason about. No answer for a branching spine under conflicting goals.

**CCD** (three.js `CCDIKSolver`). Free today, and lives below the line, which alone disqualifies it - `rig/` cannot import `three`.

Worth recording: Hecker's team implemented CCD, Jacobian methods and constrained dynamics, and discarded all three as slower and less tunable. Every IK library available in JavaScript is one of the two families they rejected.

## Sources

Hecker, Raabe, Enslow, DeWeese, Maynard, van Prooijen, *Real-time Motion Retargeting to Highly Varied User-Created Morphologies*, SIGGRAPH 2008, section 4.3. Cached under the project temp directory.
