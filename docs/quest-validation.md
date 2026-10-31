# Quest 3 skirmish acceptance checklist

Run through USB localhost or trusted HTTPS in Quest Browser with Touch controllers. Hardware results remain unchecked until exercised on a physical headset.

- [ ] Start with `pnpm dev` (Quest mode). While running the demo in VR/passthrough, save a source edit: the page must not reload or freeze. Leave XR, refresh manually, and enter again to load the change.

- [ ] Enter VR/passthrough: a floating battle appears with no table/grid; there is no face-following terminal. Raise the left wrist/controller to reveal the cuff; lower it to hide.
- [ ] First valid movement/attack order starts a ready match and ships visibly travel. Explicit Pause keeps new orders queued and displays PAUSED / Resume feedback.
- [ ] Touch a friendly ship and trigger to select; touch an enemy and trigger to attack. Empty-space orders go to the controller/fingertip XYZ position, including above/below ships.
- [ ] There is no altitude/depth control in XR and pointing alone does not select or attack. A 3 cm physical contact tolerance stays consistent through zoom. Outside-volume orders explain how to bring the hand inside.
- [ ] One controller grip pulls the battle in XYZ without changing selection. Two grips translate and zoom together around the moving hand midpoint; releasing one continues translation without a jump or accidental order.
- [ ] Set down controllers and enable hand tracking. Thumb/index quick pinch selects/orders; hold pinch pulls; two pinches spread/close to zoom in/out. Both hands show fingertip markers.
- [ ] Touching a wrist button and pinching/triggering activates it without dragging the battle. Wrist cuff and expanded tools stay readable at 0.02× and 12×.
- [ ] Lose/reacquire hand tracking mid-pinch; no accidental click, stuck grab or jump. Test changing between hands and controllers.
- [ ] Wrist Overview restores overview; left X toggles overview/action; Enter action positions the selected fleet close at 5×. Walk through/around the field; it must not recenter automatically.
- [ ] B/Y expands/collapses tools above the wrist; More tools works with hands. Right A holds selected ships.
- [ ] Controls selection modes, Fleet and Build remain available. In XR construction also uses the hand/controller position; Extractor snaps to deposits.
- [ ] Fleet → Frigate consumes resources, queues production and launches a real reinforcement. Cancel order refunds its remaining portion.
- [ ] Build → Extractor snaps to a gold deposit; invalid placements are rejected with feedback. Solar, Shipyard, Fleet yard, Capital yard, Storage and Plasma Battery are available entirely inside XR.
- [ ] Completed construction starts contributing income/technology; an unfinished building does not. Fleet yard unlocks heavier ships.
- [ ] Enemy AI builds, produces and attacks in three dimensions. Destroying either core ends the battle and stops simulation progress.
- [ ] New skirmish restores resources, entities, effects, queues, selection and the planning state without stale geometry or picking targets.
- [ ] Leaving XR / interrupting headset visibility pauses a running match. Reentry and Resume both work.
- [ ] Passthrough shows the room; returning to VR restores the background.
- [ ] Disconnect/reconnect each controller; the other controller continues to operate.
- [ ] Check comfort seated and standing, and while leaning/walking around the table.
- [ ] Test 48 total ships plus structures/projectiles for several minutes using remote DevTools; measure frame time and memory on Quest hardware.

## Automated verification

The client suite covers XYZ movement and formations, 3D weapon range, swept sphere hits and altitude misses, shield overflow/armor multipliers, focus pursuit, attack-move resume, order ownership, point defense, beams, shield regeneration, separation, projectile expiry, fixed-step equivalence, pause, core destruction, resource charging, fleet/technology limits, construction income, lost/refunded queues, an AI offensive, a successful player offensive and idle-player defeat.

## Browser verification

Desktop playtesting checks production, actual movement and exchange of fire, ship losses, core damage, pause, spatial-panel picking, construction feedback and restart. Screenshot: `quest-combat-preview.jpg`. Physical headset performance and tracking are not established by desktop checks.

### Control experiment verification

Automated selection tests cover single replacement, toggle/Shift behavior, ownership, dead/stale selections, class filtering, 3D distance boundaries and additive nearby groups. Desktop browser checks cover class and nearby selections, focus-fire rejection on empty space, an enemy focus order, camera zoom, the spatial Controls tab, and a first movement order starting a match with visible ship movement. Headset zoom, comfort and controller bindings remain hardware checks above.

Spatial-control tests cover XYZ grabbing, target-preserving fast zoom, scale limits, near-coincident hands, hand-count transitions, fresh-match order auto-start and preserved explicit pause. Physical pinch tracking and XR HUD interactions remain unchecked until exercised on the headset.

- [ ] Start demo from the left wrist and from desktop: both fleets move and fire without orders. Casualties are replenished with bounded fleet sizes.
- [ ] A demo core death starts the next round while world position, scale and user view stay unchanged. Pause freezes the demo; Resume continues it. Stop demo returns to a ready normal match.
- [ ] A ~30 cm spread zooms from overview into action; closing reverses it. The grabbed midpoint follows both hands upward and sideways while scaling. Left-stick zoom is fast, with a stable target until release.
- [ ] Left X toggles overview/close action immediately. Test comfort and hand-tracking noise at the 0.02× and 12× limits on hardware.

- [ ] Fighter squads and bombers are available in Fleet on wrist and desktop. Production charges the original batch price once and produces five logical units without exceeding the fleet cap.
- [ ] Demo has both craft types on both sides. Squads show five banking craft, lose members/guns with health, and have curved engine wakes. Touching an individual surviving craft selects its squad.
- [ ] Bombers fire visible torpedoes; original weapon heads, coloured trails and destruction shock rings work at all scales. Pause freezes flight/wakes; new demo rounds clear old wakes and effects.
- [ ] Test maximum small-craft fleets on physical Quest for rendering cost. Existing desktop checks cannot establish headset frame time or hand-contact usability.


### Capitals, audio and free manipulation

Automated coverage includes capital size ratios, original hardpoint counts, pitched deck mount alignment, capital-yard production/launch clearance, demo reinforcements, audio cue deduplication/paused silence and event preservation, moving-midpoint zoom with Y-axis-only rotation and cuff ownership.

- [ ] Start a fresh demo: each side has a visibly massive battleship and cruiser among fighters and bombers. Approach a battleship and inspect its 18 visible, active hardpoints.
- [ ] Build a capital yard after a fleet yard and sufficient storage. Queue both siege capital and battleship; verify costs, progress and unobstructed launch.
- [ ] Pinch/grip with the cuff-owning hand and lift: battlefield rises without the cuff swallowing the grab. The other hand still activates cuff buttons.
- [ ] Move both pinched hands up and toward you while spreading. Battle follows without staying pinned to a ship. Release one hand to continue pulling; bring hands within 6 cm and separate without a jump.
- [ ] Turn both grabbed hands horizontally: the battle yaws around their moving midpoint. Raise one hand: no pitch or roll. Cross the ±180° heading boundary or bring hands into vertical alignment: no spin/jump. Right-stick rotation, rotation buttons and Q/E bindings remain absent.
- [ ] Hear weapons, impacts, explosions and a quiet engine bed after interaction. Turn your head and move/rotate/scale the battle: audio follows. Mute/unmute works on cuff and desktop; pause/hide silences it.
- [ ] Check headset frame time with the enlarged ships and audio enabled. Desktop validation does not establish Quest comfort, spatial sound quality or performance.


### Wrist presses and projectile contacts

- [ ] Hover an index fingertip or the other controller over a wrist button: gold cursor and green highlight appear. Pinch/trigger activates immediately and only once, even if the wrist moves before release. Releasing never issues a fleet order.
- [ ] Hold a pinch on a button, then lose/reacquire tracking: no duplicate activation. Release and press again to rearm. Touching the wrist with its own hand does not block upward dragging.
- [ ] Start demo: 64 units per side, including twenty-one fighter squads, fifteen bombers and twenty-eight larger combat ships. Reinforcement remains bounded during extended play.
- [ ] Inspect a pitched capital turret: shots leave its barrel mouths; beams and point-defense interception lines also start at the muzzle. Fast trails never extend behind their launch point.
- [ ] Off-center bullet hits spark at the collision surface, beams end there, and only destroyed ships generate a central explosion. Check headset frame time with the 128-unit demo and sound enabled.

Historical desktop verification before the three-fight expansion: client build/typecheck passes; the 2,400-tick (two simulated minutes) 32-unit demo stayed below its fleet/event/projectile caps, with a peak of 316 shots and approximately 0.24 ms per simulation tick on the development host. Browser preview showed approximately 120 FPS and no console warnings/errors. These measurements exclude headset GPU load and do not validate physical wrist input.


### Strategic icons and separate fights

- [ ] Start demo: Overview fits Alpha, Bravo and Charlie with two stacked NATO-inspired force cards per site and distinct original unit icons. Friendly selection brightens icons and hull bars; no affiliation or selection rings surround ships.
- [ ] Select icons with fingertip/controller contact or desktop picking; fighter squad icons select the correct logical unit. Orders remain in expanded XYZ coordinates.
- [ ] Enter each fight using either force card and its desktop button, or wrist Next fight. Nearby hulls/turrets/effects return while distant fights use icons. Overview returns without resetting any fight.
- [ ] Zoom slowly across the icon/detail threshold and vary head distance: no rapid flickering. Test extreme 0.02× / 12× scales and Y-only rotation.
- [ ] All three encounters keep firing, replacing casualties and remaining separate over several minutes. Total demo fleet remains at most 64 units per side; pause freezes all sites.
- [ ] Test on Quest: readable stereo icons/force cards, reliable contact and acceptable frame time while diving between fights. Desktop tests do not establish these hardware results.

Automated strategic checks cover class symbol geometry, icon/detail transitions and picking, default versus expanded map bounds, and three independent combat/reinforcement sites. Shared icon geometry is reused by the original renderer and Quest.

Compact force cards follow the Battlespace army badge layout: fighter/bomber/warship symbol counts, a Σ total tab and a thin hull-plus-shield strength strip. Strength includes remaining hull and shields relative to the site’s full roster, so casualties reduce it. Automated checks cover damage, losses, side/site isolation and reinforcement recovery. Textures update only when changed, at most twice per second, and only while visible.

Current automated validation: 148 client tests pass and the client typecheck/production build pass (existing bundle-size warning remains). The 2,400-tick 96-unit demo remained within fleet/event/projectile caps, peaking at 704 projectiles and averaging 1.56 ms per simulation tick during the full parallel test run on the development host. These are CPU test measurements, not Quest GPU timings. Desktop verification confirms force-card selection enters the correct fight and all cards hide within the action.

- [ ] On Quest, verify compact class-count badges and total tabs are readable, stay above unit silhouettes while rotating/pulling the map, and remain steady as ships move. Both strips still enter their fight by direct contact.

### NATO unit symbols and zoom decluttering

- [ ] Verify mint friendly rectangles, pink hostile diamonds and distinct class glyphs in both eyes; selected symbols are gold, with no ship rings.
- [ ] Zoom out through a dense fight: symbols separate and remain individually selectable with mouse and direct controller/fingertip contact.
- [ ] Models remain visible farther out (8 battle metres); zooming back in restores them below 6.5 metres without flicker. Check Quest frame time while more ships are shown.

Automated checks cover bounded displacement for 160 coincident symbols, stable offsets, NATO geometry for every class, picking at displaced icon positions, unchanged simulation positions and later model/icon transitions. Dense views aggregate nearby units rather than moving labels arbitrarily far away.

### Shared front and supply routes

- [ ] Start endless demo: one front spans three separate battles at different heights and depths, with a single rear base on each side. All fourteen supply lanes branch from those two bases.
- [ ] Follow a replacement ship from a rear base, through the common junction and along its branch to a fight. Its cruise speed returns to class combat speed on arrival. Incoming ships reserve their roster slots so repeated waves cannot duplicate them.
- [ ] Pause: convoys, directional supply markers and territory geometry freeze. Resume continues their progress. Stop demo removes the territory and supply overlays.
- [ ] Inspect the eighteen defensive installations: plasma, rail and point-defense batteries on each side of each battle, with working weapons and fixed 3D positions. Destroyed stations return after at most twelve simulation seconds.
- [ ] Walk around the composition panels: both their positions and orientations remain fixed in battle space. They never turn toward the viewer. Direct contact and desktop ray picking still enter the correct fight.
- [ ] Check the faint shared blue/red territory surfaces in stereo. They follow 3D fleet/installation pressure and fade near the action. Verify Quest frame time during both a territory rebuild and a reinforcement wave.

Automated checks cover base-origin replacement travel and arrival, cruise-speed restoration, pause behavior, live/transit fleet caps, stationary defense replacement, altitude-sensitive control influence, fixed card transforms/contact, and bounded global territory geometry. The field uses two meshes and rebuilds at most twice per simulation second. A dedicated desktop CPU check measured a 2.0 ms median / 2.4 ms maximum repeated rebuild; headset timings require separate verification.


### Icon depth and grouped units

- [ ] Move around a mixed hull/icon fight: nearby badges appear larger than distant ones; distant unhighlighted badges are dimmer with team colours still identifiable.
- [ ] Put a capital hull in front of a distant icon: the hull hides the filled badge. Only selected/hovered occluded badges retain a faint dashed affiliation frame. Check both eyes while moving the head.
- [ ] In a crowded area, displaced icons retain an anchor dot at the true unit position and a thin connector. Hover/contact highlights the connection; labels stay near their anchors through zoom and battle rotation.
- [ ] At top zoom beyond 32 battle metres, nearby same-class ships combine into a counted badge. Different sides, encounters and depth layers remain separate. Select a friendly badge with mouse or direct contact: its members select together and expand. Approach below 27 metres to expand automatically; Overview regroups expanded units.
- [ ] Clear selection: undamaged idle ships lose their health bars. Hovering, selecting, taking damage or construction reveals bars; damage-only bars expire after three simulation seconds.
- [ ] Check symbol/count legibility, tracking stability and frame time on physical Quest. Desktop results cannot establish stereo depth perception or hand-contact usability.

Regression coverage includes perspective/contrast bounds, group depth/side/class/site isolation, group hysteresis and expansion, group contact at the displayed centroid, anchor placement, depth-tested materials and selected-only occluded frames, contextual bars and reset cleanup. Desktop browser verification confirms selecting a counted four-frigate badge selects all four ships and expands their symbols.

Validation for the icon-depth change: all 163 client tests pass; the 13 focused icon/strategic tests pass again after the backing-depth fix. Client TypeScript checking and production build pass, with the existing bundle-size warning. Final desktop preview: `artifacts/quest-depth-icons.png`.


### Wide middle zoom and depth skirmishes

- [ ] Individual NATO flags opens the middle layer at an 18-metre demo view distance. Main force cards are hidden and all units retain individual flags, even in distant fights. Wrist Controls → Individual flags opens the same layer.
- [ ] Zoom all the way out: force counts appear beyond 32 metres; returning below 27 metres restores individual flags. Sudden view changes blend smoothly. Overview and pinch/grip manipulation remain stable down to 0.02× scale.
- [ ] Start demo: 64 ships per side across seven fights. The three main battles retain their original rosters and eighteen defenses. Two four-per-side skirmishes bridge the main battles, another fights high above friendly space, and another fights low in hostile space.
- [ ] Desktop Depth skirmishes and wrist Next fight visit both crossings, Friendly High and Hostile Low. Move around them to inspect their XYZ separation; all seven fights continue firing while you navigate.
- [ ] Kill ships in each new skirmish: replacements travel from the base and return to the correct compact combat volume without duplicating roster slots. Pausing freezes fighting, replacements and supply markers.
- [ ] Measure physical Quest frame time with 128 ships, fighters, sound and all seven supply routes active. Verify stereo depth and individual-flag readability across the wider middle layer.

Regression checks include all seven sites firing, compact site bounds, friendly-high/enemy-low placement, expanded live/transit fleet caps, top-only counts, cards hidden in the middle layer, auxiliary symbols retained under top-zoom main force cards, and stable grabs at the new minimum scale.

### Smooth three-level zoom transitions

Displaced NATO symbols now converge on their live ship anchors between 18 and 10.5 battle metres, before the 10.5–8 metre hull crossfade. Verify an individual crowded unit stays traceable through this approach, including moving ships and quick zoom reversals. At close range the icon and hull share the same position; zooming out gradually restores decluttering. The regression test exercises docking, moving anchors, reversal and matching pick proxies.

- [ ] Exit XR, refresh, and re-enter after updating the stable Quest server. Slowly zoom across model → NATO icon → force-card ranges and back; each layer should blend, with a broad individual-icon middle view.
- [ ] Reverse a pinch rapidly and use Overview / Individual flags / Into action presets. Check for blank frames, abrupt switches, stereo artifacts and headset frame-time spikes.
- [ ] Select during a transition: contacts follow the dominant visible layer, and hidden units beneath full force cards cannot intercept a trigger.

Models stay complete through 8 battle metres and blend to icons by 10.5. Cards blend over 27–32 metres. Presentation easing runs independently of simulation pause. Model instances use depth-preserving alpha hashing; symbols, counts and cards use alpha blending. Vertex/index buffers remain shared, and only narrow transition bands render both layers. Automated tests cover complementary weights, refresh-rate-independent easing, fast reversals, per-instance buffer isolation, both layers during a blend, dominant-layer picking and full-card suppression.

Validation for the wide-middle/depth-skirmish change: 177 client tests pass; client TypeScript checking and production build pass (existing bundle-size warning). The final card-layer checks also pass after including all seven sites in the distance calculation. Desktop verification confirms middle flags, top counts, and navigation to Friendly High and Hostile Low, with no console warnings/errors. Preview: `artifacts/quest-middle-depth-skirmishes.png`. Physical Quest acceptance remains unchecked.


### Force selection, battle pressure and quiet overview

- [x] Desktop: selecting a friendly composition banner highlights its border and deployed force in gold without moving the view; selecting the same banner again enters that fight.
- [x] Automated: changing side or battle requires another selection before entering; leaving overview clears the highlight. Contact picks the nearest banner when the physical touch tolerance covers both stacked cards at minimum zoom.
- [x] Automated: pressure counts destroyed units once and completed reinforcement arrivals only, separates each battle, expires after 20 simulation seconds, freezes during pause and clears on restart. ▲/▼ gives net unit momentum; GAIN/LOSS/EVEN is relative to that banner’s side.
- [x] Automated: projectile heads, trails, beams, flashes and destruction rings clear in overview and restore locally. Distant effects fade over four to eight battle metres; long beams crossing nearby space retain their local visibility. Combat damage and projectile state are unchanged.
- [ ] Physical Quest: check friendly/enemy banner contact, two-step activation, gold force-outline legibility, pressure cue readability and combat/overview effects in stereo. Exit XR, refresh, and re-enter to load saved changes; stable server HMR settings remain unchanged.
