# 0002 - Parts do not contribute to the field

Status: accepted, 2026-08-26

## Context

A creature is a spine, limbs, and parts - mouths, eyes, feet, graspers. The question is whether parts are metaballs in the same field as the body, or separate meshes socketed onto the finished skin.

Spore split them: only spine and limbs generate metaballs, and parts are pre-authored meshes with parameterised deformation handles, called Rigblocks.

## Decision

Follow the split. The field is spine and limb segments only. Parts are separate meshes attached at sockets, each carrying its own bone and its own deformations.

## Consequences

Eyes and mouths stay crisp. A unified field would blob them into the body, and a blobby eye does not read as an eye.

Provenance weighting stays cheap, because every field contribution traces to exactly one body. This is what makes automatic binding nearly free, and it is the property a unified field would destroy.

Mesher cost scales with spine and limb complexity, not with part count. A creature with forty decorations costs the same to remesh as one with none.

A part can animate its own deforms - a mouth opening, a hand closing - without the mesher knowing anything about it.

The cost is the seam. A part meets the skin at a socket, and if the part's silhouette does not match the surface it sits on, you see the join. Spore lived with this. We will too, and it is the price of everything above.

One inherited quirk: with a single ungrouped field, limbs close together web together. Spore shipped this because players used it for wings. We inherit the behaviour by default and should decide deliberately, later, whether to suppress it.

## Alternatives

**Unified SDF.** Everything smooth-min'd together with blend groups to suppress webbing where unwanted. Cleaner in principle. Loses crisp parts, loses provenance, and makes every edit pay for every decoration.

## Sources

Choy, Ingram, Quigley, Sharp, Willmott, *Rigblocks: Player-deformable Objects*, SIGGRAPH 2007 Sketches.
