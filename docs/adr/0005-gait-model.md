# 0005 - Gait by leg groups and duty factors

Status: accepted, 2026-08-26

## Context

Limbs are free-form, so a creature can have any number of legs, of any lengths, in any arrangement, and legs can branch. Locomotion has to come out plausible with no per-creature authoring, because there is nobody to author it.

Spore's gait system was entirely separate from its animation retargeting and entirely procedural. That separation is the useful part: walking never needed an animator, even at Maxis.

## Decision

Cluster legs into groups of roughly equal length. Harmonise the groups by approximating their length ratios as small whole numbers, and use those ratios to set each group's cycle frequency.

Within a group, each foot gets a **duty factor** - the fraction of the cycle it is planted - and a **step trigger**, its offset within the cycle. One flight path, authored in normalised space, scaled by leg length, serves every foot.

Creatures with no feet get a heuristic: float, or convert spine bones to pseudo-feet and inch along.

## Consequences

Mismatched legs work. Two short legs and four long ones is the case that breaks naive approaches, and the rational frequency ratios are the specific machinery that handles it.

Gait style becomes data: a mapping from movement speed to gait parameters. Limping, lumbering, and creature-specific styles are parameter sets rather than code, and different leg groups can run different styles simultaneously.

Hecker's team authored parameters for one to six feet and generated them procedurally beyond that. We have no animators, so ours are generated throughout, and the one-to-six range is where hand-tuned constants will earn their keep first.

Gait output is pose goals, same as any action. It has no privileged path into the solver.

Sharp turns and sudden stops are the known weakness of a scheduled cycle. Keep a reactive fallback in reserve: step when a foot drifts too far from where it should be.

## Alternatives

**Physics-driven**, spring-loaded inverted pendulum or similar. Hands the update loop to a physics engine, which then decides the rigging model - the one thing `AGENTS.md` says a library may not do here.

**Purely reactive stepping.** Elegant, popular, and looks good on spiders. No concept of gait style and no way to coordinate legs of unequal length; it only reacts.

## Sources

Hecker et al., SIGGRAPH 2008, section 4.2. Alexander on duty factor; Rotenberg on step triggers, both cited there.
