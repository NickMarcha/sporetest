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

Parts carry **caps**, which transfer to their derived bones. A cap is a semantic tag: `foot`, `grasper`, `mouth`, `eye`, `tail`. Actions select targets by cap rather than hard-coded part names or indices. After selection, the solver and renderer may use resolved indices into typed arrays.

### Limb and socket coordinates

A limb owns an ordered chain of **limb segments**, each with a stable identifier, position, orientation, and radius. Segment transforms are authored in the limb's socket frame, not relative to the preceding segment. This lets the editor reshape a chain without rewriting every subsequent segment. A limb's optional cap transfers to its final bone. It is semantic metadata and creates no attached mesh or field density.

A socket references a source in its immediate parent chain, a vertebra for a top-level limb or a segment for a nested limb. Its position and orientation are relative to that source's authored frame. Resolving the hierarchy composes these transforms into creature space. Moving or rotating the source carries the attachment; changing its radius does not scale the saved socket offset. Viewport placement picks a point on the current skin and converts it to a socket relative to the closest source by distance divided by radius. Later edits preserve that authored offset rather than continuously projecting it onto the skin.

An **arm** is an editor preset for a limb capped `grasper`; the leg preset uses `foot`. Both produce ordinary limb data. Placement uses a ghost preview without meshing. Mirroring reflects across the fixed creature-space plane Z = 0. Each side raycasts the skin to check attachment availability. The second ghost is an exact reflection of the first; the opposite skin must be within its 0.25-metre root radius. Within 0.14 metres of the plane, placement tries a centre-plane raycast and emits one limb when the intersection is nearby. A dashed skin intersection marks this plane. Arms default to mirroring off and legs default to mirroring on.

Placing a pair records one `attach-pair` mutation and a **mirror pair**, two stable limb identifiers saved in the creature. Editing either side reflects its socket and segment rest transforms across creature-space Z = 0 into the partner's attachment frame. Radii, tip caps, segment insertion, and segment removal stay synchronized. Surviving segment identifiers are preserved. Pair dependencies follow attachment ancestry, so parent edits synchronize before nested pairs regardless of JSON array order. Links that create cyclic dependencies are invalid.

Removing a linked limb removes both sides and their dependent branches. Removing an attachment source likewise prunes affected pairs. The `unlink` mutation keeps both limbs and removes their link, permitting asymmetric edits. Mirror links affect authored data per edit; the rig and animation still receive individual limbs with no assumption about symmetry. Viewport dragging converts creature-space positions back into the selected segment's socket frame. Picking is disabled while the displayed skin is waiting for a geometry rebuild and during pose preview.

The field adds a buried connector from the parent source centre to the limb's first segment, using the first segment's radius. The connector blends provenance between parent and limb. Each limb then uses the same continuous-chain field as the spine. Nearby limbs can web together, as described in ADR 0002.

Part and source identifiers are globally unique within a creature. A child socket cannot reference a sibling or its own descendants. Removing a vertebra removes its attached limbs and their descendants. Removing a limb removes its subtree; the editor likewise removes attachments on a deleted segment. Undo restores the complete previous subtree through recipe replay.

### Local recipe saving

The editor writes the current base and mutations to `localStorage` under `sporetest.current-recipe` after committed edits, Undo, Redo, Reset, and file loading. A pending drag is also saved when the page hides. Startup validates the saved recipe with `parseRecipe`, replays it, restores each mutation as an Undo step, and frames the creature. Original gesture grouping and Redo history are not persisted. Preview settings and motion commands are not part of the recipe.

Local saving belongs to the browser origin, so development and the hosted site have separate saves. Storage failures appear beside Save recipe and leave editing and file export available. Invalid saved data is not overwritten merely by opening or closing the page; the next deliberate document edit or load replaces it.

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

The Particle IK limb phase takes a supplied, fixed spine pose. A **pose goal** names a stable bone and a desired position in creature-space metres. Foot, grasper, and attached-tail goals select bones by cap. Head and tail are ordered spine roles, resolved to stable bone identifiers when compiling the solver. The viewport exposes these goals as draggable orange targets. These are temporary pose controls, independent of authored mirror links. Shape mode returns to the authored creature.

`createLimbIK` compiles only the limb paths needed by the chosen targets. A **particle** is a solver position, separate from a bone. Each top-level limb's first segment stays fixed at its socket position in the supplied base pose. Nested limbs share their ancestor particles. Length constraints carry separate inverse masses for their endpoints; additional cross-constraints preserve separation between immediate active children at branches. Unselected branches inherit their parent's reconstructed pose without participating in the solve.

Each solve starts from the base pose, making its output independent of previous frames. The aim preconditioner rotates toward the average descendant goal and scales only along that direction, then repeats at branches. Nonlinear length corrections iterate from the tips inward. An outward reconstruction enforces exact segment lengths, leaving a positional residual when a goal cannot be reached. Bone orientations use minimal-twist alignment and a second constraint axis at branches. The solver and pose reuse their buffers.

This implementation uses 96 iterations and rigid lengths as a diagnostic baseline. A tiny deterministic perpendicular seed lets a perfectly straight compressed chain start bending. Neither choice is claimed as a parameter from the paper. Soft limb stretch/compression tuning, orientation goals, joint limits, collision handling, and secondary motion remain unimplemented. An uncapped creature has no limb targets; a one-segment limb can only report its fixed socket's distance from the target.

### Spine IK

`createIK` compiles both phases. The head remains the FK root; its target supplies translation while its authored orientation stays fixed. The tail is a positional goal, so its target can retain a residual when the spine cannot reach it. A one-vertebra creature has only the head target.

`createSpineIK` allocates particles at the head, tail, and spine sources supporting active limb targets. Vertebrae between these particles are not solver particles. Adjacent particles have chord constraints bounded to 10–120% of their rest distance. Each limb target contributes a simplified chord constraint to its spine attachment, with the same compression/stretch range. Thus the spine can respond to a foot before the limb phase tries to reach it.

Each intervening span uses a quintic Hermite curve fitted per rig with fixed endpoints and least-squares endpoint derivatives. A small straight-chord prior handles underdetermined fits. Arc-length parameters and transported-frame offsets preserve each authored vertebra's rest position and orientation even when the fitted curve does not pass through it exactly. Derivatives are with respect to the span's normalised parameter and are stored in creature-space metres. Reconstruction rotates endpoint derivatives, scales them with the posed chord, transports frames, and reapplies the saved offsets. Endpoint orientations use minimal-twist tangent alignment; the root keeps its supplied orientation.

The spine uses 32 iterations, followed by outward projection onto its permitted chord ranges. A smooth angular anti-buckling weight compares neighbouring chords against the root-relative rest shape and pulls folding attachment regions toward that reference. The gains, derivative regularisation, and finite-difference endpoint tangents are our initial tuning choices. The 10–120% limits apply to reduced chords, not every reconstructed vertebra spacing. This is a positional IK baseline, not a guarantee against self-intersection or implausible poses. The limb phase then freezes the reconstructed spine and uses the existing solver. Both phases restart from rest relative to the requested root, reuse buffers, and leave the recipe and skin topology unchanged.

### Standing and foot contact

The static standing controller derives a **foot contact patch** from generated skin vertices whose largest binding influence belongs to a foot-capped bone. It measures the lowest posed point in each patch using the full sparse binding. A **standing floor** is a horizontal plane supplied in creature-space metres. The viewer uses the grid height established by the last skin build and keeps it fixed during posing.

The highest rest sole sets initial body height, so shorter legs do not start above the floor. The controller keeps foot targets at their authored horizontal positions, places their vertical targets using skin clearance, and solves both IK phases. It corrects targets against measured posed contact error and can lower an overextended body. The body-height adjustment is bounded by rest torso clearance. Up to 24 correction passes run when standing inputs change, not on idle render frames. This resets from authored targets on every invocation, leaving the creature and recipe untouched.

The preview reports contact within one centimetre and marks misses rather than claiming every morphology can stand. Feet with no identifiable skin patch are unsupported. Contact uses the full core weights, so GPU influence reduction can introduce a small visual discrepancy. Rest torso clearance is not posed-body collision detection. This controller does not solve dynamic balance, non-horizontal terrain, self-intersection, or walking. The spine endpoint target controls the torso; attached tails have separate limb targets.

Stand offers optional horizontal torso correction. Strength requests a fraction of the distance from the centre projection to the nearest support point, capped by a shift limit in metres. The controller translates non-foot goals and corrects foot goals against fixed baseline sole vertices horizontally and measured skin clearance vertically. It tries up to eight successively halved shifts, with 24 contact passes each. A candidate must improve support distance, preserve grounded foot count, keep horizontal sole drift within 2 mm, and worsen no foot's vertical error by more than 0.1 mm. If none passes, it restores the baseline. Strength zero is the default and exactly preserves the original standing pose. These controls run only when standing inputs change and do not affect Walk or the recipe.

Motion is produced by two systems that do not know about each other.

### Support diagnostic

The **centre of mass estimate** assumes uniform mass per unit rest-skin surface area. Each triangle distributes its area equally among its vertices; the rig's full sparse weights collapse these area-weighted positions into per-bone moments at compile time. Applying the skinning matrices to those moments measures the posed centre in O(bones), with fixed buffers. This is a surface-mass approximation, not uniform volume density, and it has no material or internal-density information.

The **support area** is the convex hull in creature-space XZ of foot-patch vertices within one centimetre of the standing floor. A foot must have measured contact within that tolerance; walking also requires its planted flag. Flight feet, missed floor contacts, and torso contact do not supply support. The diagnostic reuses buffers, skins only eligible foot patches, and handles absent, duplicate, point, and collinear contacts explicitly.

Stand and Walk show a purple centre estimate, its floor projection, and a green support outline. The projection turns orange outside support, with a line to the nearest supporting point and a distance in metres. An independent checkbox hides this overlay. The diagnostic itself never changes goals, pose, or the recipe; the optional standing controller uses its measurements for torso correction. It is a static support check; dynamic balance and a volumetric mass model remain unimplemented.

### Walking preview

Walk previews straight or curved travel on the standing floor, starting from the standing pose. It derives each leg's length by tracing its foot cap back to the spine, including shared paths for branched legs. Legs within 20 percent of the shortest length in a group share a cycle. Group periods approximate length ratios with rational numbers whose denominators are at most four. Feet are ordered around each group's horizontal centre and given evenly spaced lift-off triggers, independently of mirror links.

The default walk style uses a 0.65 duty factor, a 1.8-second shortest-group cycle, and cruising speed equal to 0.16 times the shortest group length per second. The flight arc lifts by 0.12 leg lengths. Flight interpolates between fixed authoring-frame contacts with cubic smoothstep horizontally and a quartic height arc. Ground-relative velocity is zero at lift-off and touchdown, joining planted contact continuously. These defaults are initial tuning choices. Travel points horizontally from tail to head, falling back to negative X for a vertical or one-vertebra spine.

Travel commands record elapsed seconds, ramp duration, initial and target forward speed, ground-space lateral velocity, and accumulated travel in the pure gait data. In the inspection preview, speed follows a 0.6-second cubic smoothstep ramp whose analytic integral supplies root travel. An interrupted ramp starts from its current speed and position. Position and velocity remain continuous; acceleration can change abruptly on interruption. This timing is an initial tuning choice. The travel-speed slider requests zero to twice the baseline cruising speed; zero stops, and Start walking resumes the last nonzero speed. The core accepts finite signed speeds in metres per second; negative speed reverses travel. Changing direction uses the same continuous speed ramp.

Each moving interval reserves 0.25 seconds for preparation, then staggers lift-offs by leg trigger. A foot's landing position predicts root travel at touchdown plus half the planted sweep, using only intent known at lift-off. Inspection speed changes preserve the running step schedule and existing flights. Inspection stop commands leave flights unchanged and suppress new walking lift-offs. Already planted feet stay fixed while the body slows. Restart preserves contacts and the minimum planted duration before the next lift. Each leg group restarts on a shared rhythm after retained flights land. The earliest eligible foot leads; the group start shifts just enough to preserve every planted interval. Independent per-foot delays are avoided because they can synchronize previously alternating flights.

**Settling** returns feet to the compiled standing sole positions at the final travel position and heading. A stop command compiles a finite sequence after the speed ramp and all existing flights finish. Feet within 2 cm of their preferred position and 5 degrees of their preferred heading do not step. The others step one at a time in leg-group trigger order, with 0.25 seconds of preparation between flights. Each flight lasts the walking flight duration clamped to 0.35–0.65 seconds. Lift is capped by the configured lift and 6% of leg length, using half the correction distance with a 2.5 cm minimum before that cap so a heading-only correction can lift. Root position and heading stay fixed throughout settling. Support intent anticipates these lift-offs and reloads afterward; the status reports remaining steps and final torso easing before Standing.

Settling plans live in travel commands, not frame history. Restart cancels pending settling steps, preserves any flight already underway, and resumes walking after the minimum planted interval. A new stop plans from those retained contacts. Backward scrubbing reproduces the same steps. The preferred stance is the existing standing pose, not a collision-free or dynamically balanced stance guaranteed for every creature.

The gait playground exposes duty factor, shortest-group cycle duration in seconds, and foot lift as a fraction of each leg's length. `configureGait` preserves the compiled group period ratios and sampling buffers. These style changes resample the current time immediately and may jump between poses; travel-speed commands use smooth ramps. Style settings and travel commands belong to the preview and are not saved in recipes.

**Steering** adds constant-curvature path segments to travel commands. Each command records a ground-plane position, yaw about +Y, and curvature in radians per metre. Arc distance comes from the speed integral; a midpoint/sinc formula handles straight and tiny-curvature segments without a division singularity. Position, heading, and travel speed stay continuous when steering changes. Curvature changes immediately; angular acceleration is not smoothed. Steering retains the existing acceleration ramp. The turn-rate control spans 45 degrees per second left or right at baseline cruising speed. Actual angular speed scales with travel speed, so stopping also stops rotation. Steer straight keeps the reached heading.

The turning pivot is the mean rest-spine position in XZ. Flight endpoints are ground-plane sole positions, predicted from the path and intent known at lift-off. New steering commands preserve existing flights and step timing. Each sample inverse-transforms those fixed positions by current path translation and yaw into the creature's moving frame before solving IK. This keeps planted sole targets fixed in ground coordinates through turns. Each planted foot also retains its landing heading in ground space. Flights interpolate heading along the shortest angular arc toward the predicted landing heading. After position IK, the foot rotates about vertical to match that heading while retaining IK pitch and roll; contact feedback measures the skin after rotation. A standing basis axis with a strong horizontal projection supplies the heading reference; correction skips a nearly vertical current reference axis. This constrains heading, not full sole orientation. Tight turns can exceed reach and retain measured contact errors.

Preview mode and tuning are stored in URL search parameters. Mode uses `mode=walk` or `mode=stand`; controls use their element IDs, such as `walk-around=1`, `walk-body=0.5`, and `walk-tail=0.7`. Gait, movement speed, turn rate, playback rate, torso correction, and diagnostic overlays restore once the rig is ready. Cycle duration is stored at inspection tempo, preserving tuning across walk-around mode changes. Default values are omitted, invalid values are ignored, and unrelated parameters and the hash are retained. Edits replace the current history entry after a short debounce. The URL does not include the creature, camera, held input, command history, or playback position; a shared URL applies the settings to the recipient's current creature.

Playback has pause, slow motion, a 1/60-second step, restart, and elapsed-time scrubbing. Start walking and Stop walking change locomotion intent; Pause freezes time immediately. Clicking Walk again also changes intent while staying in the preview. Scrubbing pauses playback; slow motion scales the preview clock without changing gait parameters. A paused pose is solved again only when time, intent, or settings change. Blue wireframe targets show the scheduled sole positions and lift, independently of the planted-contact rings. The timeline grows in 30-second intervals as playback advances.

`sampleGait` writes foot offsets, planted flags, support intent, root travel, and yaw into reused arrays. It evaluates command history and skips completed cycles analytically, so repeated samples, backward scrubbing, and skipped frames produce the same goals without replaying frames. Commands entered after scrubbing replace future commands. Applying yaw about the turning pivot and adding root travel recovers a constant planted contact location in the fixed authoring frame. The viewer follows translation while visibly rotating the skin, skeleton, sole targets, and support overlay together. The metre grid retains its orientation and scrolls with travel. Leaving Walk resets the display rotation.

Walk around uses the same gait with actual root translation on a fixed floor marked every 5 m. The camera follows translation while retaining its orbit. A tempo of 3 triples baseline travel speed and divides cycle, preparation, and settling durations by three. The default cycle is 0.6 seconds. The inspector shows actual cycle seconds and retains normalized tuning across modes. The slower inspection preview uses tempo 1. The travel-speed multiplier changes stride length independently of cadence.

With the canvas focused, W/S request forward/reverse travel and A/D strafe relative to the current facing. Diagonal input is normalized. Strafing preserves facing; camera orbit does not steer the creature. Player velocity changes linearly with bounded acceleration of 12 baseline cruising speeds per second and braking of 20. At the default multiplier, reaching full speed takes 83 ms, stopping takes 50 ms, a right-angle redirect takes 118 ms, and a full reversal takes 167 ms. These durations depend on velocity change, independently of the stepping cycle. Analytic integration preserves root position and velocity when commands interrupt ramps.

Player commands redirect airborne feet toward newly predicted landings. A horizontal cubic Hermite curve preserves current sole position and velocity, with zero velocity at touchdown. The original touchdown time, vertical arc, and heading interpolation remain. Landing correction fades during the final 80 ms of flight to avoid whipping a foot near contact. Planted targets remain fixed. Abrupt repeated reversals can still exceed stance reach, and measured contact residuals remain visible.

Releasing keys, losing canvas or window focus, or hiding the tab requests braking. Forward, Reverse, and strafe buttons provide persistent movement until Stop or focus loss. The travel-speed slider retains a separate movement multiplier across stops; changing it does not start movement. Actual metres per second remain visible alongside the requested multiplier. Leaving the mode restores the preview camera. These controls and travel position are not saved in the recipe. The viewer timestamps movement commands on arrival and samples the full elapsed visible time, including long frames. Pause and hidden tabs suspend the clock; resuming resets its reference.

**Support intent** is a unitless contribution per foot for anticipatory torso motion. It smoothly falls before scheduled lift-off and rises after touchdown. Each ramp lasts half a planted interval, spreading torso travel across the step rather than holding each extreme and rushing between them. Travel commands snapshot its value and rate. A tangent-preserving blend over the same duration prevents jumps when a command cancels anticipated unloading. This intent is not a force estimate or a measured contact flag; during a command transition it can retain a contribution briefly after lift-off. Physical support diagnostics still exclude flight feet.

Optional **weight transfer** offsets non-foot goals using compiled sole positions relative to their mean. Each foot's centred support intent multiplies its relative position, and twice the mean of these contributions supplies the horizontal shift. Normalization by foot count stays fixed, avoiding rapid motion when total support intent approaches zero. Scaling by the compiled foot spread bounds travel without compressing the curve near its extremes. Equal loads return the torso to neutral during all-foot flight or after settling. Strength scales travel. The playground defaults to zero strength and a 0.15 m limit, with limits up to 0.30 m. Weight transfer uses foot arrangement and timing, not the mass diagnostic, and does not promise dynamic balance. It introduces no movement for a creature with zero or one foot.

Movement lean and tail sway use average ground-space acceleration over the preceding 180 ms, computed from analytic velocity samples. Ground velocity includes heading, so curved travel supplies centripetal acceleration and makes tails sway outward. Acceleration rotates into the current creature frame. Lean is bounded with tanh to 0.08 radians per horizontal axis at full strength, plus a head shift of 30% of standing height times lean. It shares body-motion contact reduction. Tail sway opposes acceleration, scales with authored tail length, and shares the 8% length bound with delayed follow-through. Both controls work independently of step bob, settle after braking leaves the sampling window, and replay without frame history. Viewer defaults are 50% lean and 70% sway; URL keys are `walk-lean` and `walk-sway`.

Optional **body motion** lowers the torso during foot swing and tilts it toward the supporting side. It averages scheduled foot lift over all legs and scales tilt by the authored stance spread. Bob is one quarter of mean lift at full strength; pitch and roll derive from the horizontal distribution of that lift. The existing zero-velocity lift endpoints make the requested motion continuous at touchdown and return it to neutral after settling. Non-foot goals rotate about the standing head height above the contact centre. Foot goals stay fixed, and the existing contact-feedback reduction relaxes body motion when reach is limited. The viewer defaults to 50% strength; zero disables it. It uses reused goal buffers and exact-time sampling, including backward scrubbing. This body-motion control follows stepping; movement lean separately handles acceleration. Head stabilization remains unimplemented.

Walking starts from compiled standing goals and remembers a sole vertex per foot. Up to six IK and contact-feedback passes correct horizontal movement of that vertex and the minimum height of its contact patch. Nonzero torso transfer or enabled body motion allows up to 24 passes. After the first six, residual errors above 2 mm continuously reduce requested torso travel so foot reach takes priority. All foot targets participate in this reduction, avoiding a discontinuous constraint change at lift-off. Zero strength or zero limit uses the original six-pass solve. This prevents changing lowest vertices from redefining horizontal contact during a step. Rings show scheduled planted contacts, green within one centimetre and orange for a residual. Flight feet have no ring. The counter reports only planted feet. Correction and posing reuse buffers and never remesh.

Shape and other posing modes still exit the walking preview immediately. Dynamic balance and locomotion for creatures without feet remain unimplemented. An unreachable or unsupported foot is not evidence of a successful gait. Skin contact still uses full core weights rather than the renderer's reduced four influences.


The optional frame-timing readout reports one-second averages for frame delivery, CPU frame work, posing, draw submission, asynchronous GPU queries where supported, and the worst frame gap in the window. Key timing measures event-handler entry through render submission, not physical key-to-display latency. Hidden-tab intervals are excluded; active long frames remain visible. Profiling a saved 19-bone, 37,604-triangle creature on 2026-09-14 measured about 0.14–0.15 ms per pose in Node and 0.2–0.3 ms in Chrome. A 1,000-command history remained below 0.2 ms per pose in the standalone measurement. Chrome CPU frame cost was about 0.5–0.6 ms, but frame delivery and GPU time varied. A browser check initially delivered about 1 fps with low CPU and GPU costs; bringing the creature tab forward restored 60 fps. Foreground movement measured about 0.5–0.6 ms of CPU work per frame. These are local observations, not portable performance guarantees.

Player acceleration and braking determine travel; gait adapts its airborne landings to that travel. This follows the separation in [Quake III movement](https://github.com/id-Software/Quake-III-Arena/blob/master/code/game/bg_pmove.c), where acceleration and friction drive travel before footstep animation is selected, and [the Spore paper, section 4.2](https://www.chrishecker.com/images/c/cb/Sporeanim-siggraph08.pdf), where gait style follows movement speed. Exact-time path sampling does not require a physics loop for this separation. [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/) describes fixed-step integration and interpolation for stateful physics; the current analytic sampler can skip directly to elapsed time.

### Attached tails

The Tail tool places an ordinary limb with a `tail` cap, three tapered segments, and mirroring off by default. It grows along the picked surface normal with a slight upward curve. Centre-plane snapping and optional mirror links work as they do for arms and legs. Segment dragging, socket edits, adding segments, and recipe replay use the same limb data and mutations.

An attached tail's tip gets a limb IK target, identified by its stable bone identifier. The spine endpoint retains its separate body-control target. Tail caps never count as feet or participate in leg groups. During standing they follow translated rest goals. Walking adds optional tail follow-through driven by body bob and tilt.

Attached-tail follow-through samples body motion at three earlier times, weighted 0.5, 0.3, and 0.2. The delay is 0.12 times the square root of authored chain length in metres, capped at 0.3 seconds and divided by gait tempo. The difference from current body motion offsets the tail goal, smoothly bounded to 8% of chain length. A dedicated reused limb-goal buffer applies this offset after the spine solve, so secondary motion does not feed back into the torso goals. It identifies attached tails by cap and limb kind, excluding the spine endpoint. Sampling uses the command timeline rather than frame history, and returns to rest after the delayed body motion ends. Tail follow-through defaults to 70% in the viewer and requires nonzero body motion. It is a finite motion filter, not a spring simulation; tail-floor collision and head stabilization remain unimplemented.

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
