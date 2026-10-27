# Quest 3 acceptance checklist

Run through USB localhost or trusted HTTPS in Quest Browser with Touch controllers.

- [ ] Enter VR: the table is in front of you, at a comfortable seated/standing height, and both eyes render correctly.
- [ ] Trigger a ship: its selection ring appears. Grip selects the whole fleet.
- [ ] Move the thumbstick vertically: the plane, spatial ALT readout and pointer move together.
- [ ] Trigger empty plane: ships move in XYZ and preserve their formation, including vertical spacing.
- [ ] Trigger ALL, HOLD, ALT −/+, RESET and +4 SHIPS on the spatial panel.
- [ ] A/X stops selected vessels; B/Y recenters the table without moving the player camera.
- [ ] Exit and reenter: desktop orbit restores, XR can restart, and controls keep working.
- [ ] Enter passthrough: the room is visible around the table; returning to VR restores the background.
- [ ] Disconnect/reconnect a controller: the other controller continues to work.
- [ ] Reset repeatedly and test 48 vessels; verify stable memory and acceptable frame time for several minutes using remote DevTools.
- [ ] Check comfort while leaning/walking around the table. Test in seated and standing use.

Hardware results are intentionally unchecked until exercised on a physical headset. Frame-rate targets must be measured on-device; desktop FPS is not a Quest performance guarantee.

## Development verification — 27 October 2026

- 75 client tests passed, including XYZ movement, formation boundary preservation and frame-rate equivalence.
- All workspace TypeScript checks passed.
- Client production bundle and Worker dry-run build passed.
- Desktop browser: selected a vessel, issued a movement order, added a wing, selected all, changed altitude to both bounds, and reset the fleet. No browser errors were reported.
- Preview: `quest-preview.jpg`. No physical-headset testing has been performed.
