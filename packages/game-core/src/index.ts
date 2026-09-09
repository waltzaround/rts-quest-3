export {
  ALL_SHIP_CLASSES,
  BUILDABLE_STRUCTURE_TYPES,
  DAMAGE_PROFILE_MULTIPLIERS,
  calculateProfiledDamage,
  DEFENSIVE_STRUCTURE_TYPES,
  FIGHTER_SQUAD_OFFSETS,
  getFighterSquadMemberPose,
  getStructureWeaponDamage,
  getStructureWeaponRange,
  getWeaponArmorMultiplier,
  SHIPS,
  SHIP_TURRET_SCALES,
  SHIP_ECONOMY,
  SHIPYARD_TYPES,
  RESOURCE_EXTRACTOR_TYPES,
  STRUCTURES,
  WEAPONS,
} from "./data";
export { calculateChecksum } from "./checksum";
export { createMapVariantLayout, type MapVariantLayout } from "./map-layouts";
export { LockstepInputs, type LockstepPlayerTransition } from "./lockstep-inputs";
export {
  REPLAY_FORMAT,
  REPLAY_FORMAT_VERSION,
  ReplayPlayer,
  ReplayRecorder,
  parseReplay,
  playReplay,
  validateReplay,
} from "./replay";
export type {
  ReplayAction,
  ReplayArchive,
  ReplayChecksumCheckpoint,
  ReplayCommandAction,
  ReplayFile,
  ReplayPlaybackFailure,
  ReplayPlaybackProgress,
  ReplayPlaybackResult,
  ReplayPlaybackSuccess,
  ReplayPlayerStateAction,
  ReplayRecorderOptions,
  ReplayResult,
  ReplayStepResult,
  ReplayValidationResult,
} from "./replay";
export {
  calculateOmniscientViewChecksum,
  calculatePlayerViewChecksum,
  calculateTeamViewChecksum,
  projectOmniscientView,
  projectPlayerView,
  projectTeamView,
  visibleEntityIdsFromPlayerView,
} from "./player-view";
export {
  areTeamsAllied,
  getTeamVisibility,
  isEntityVisibleToTeam,
  isProjectileVisibleToTeam,
  isResourceNodeDiscoveredByTeam,
} from "./visibility";
export {
  GameSimulation,
  computeFormationAssignments,
  createCombatScenario,
  createMenuBattleScenario,
  createShowcaseScenario,
  getLocalBearing,
  getTurretMuzzleWorldPosition,
  getTurretWorldPosition,
  isPointInTurretArc,
  restoreSimulation,
} from "./simulation";
export type { ScenarioOptions, ScenarioPlayerConfig } from "./simulation";
export {
  createSharedRenderBuffers,
  SharedRenderReader,
  SharedRenderWriter,
  SHARED_RENDER_LAYOUT,
} from "./shared-render-buffer";
export type {
  SharedRenderBuffers,
  SharedRenderCapacity,
  SharedRenderFrame,
} from "./shared-render-buffer";
export type * from "./types";
export * from "./factions";
export * from "./territory";
export { createTutorialScenario, TutorialSession, TUTORIAL_LESSONS, TUTORIAL_PLAYER_ID, TUTORIAL_BASE } from "./tutorial";
export type { TutorialLesson, TutorialInput } from "./tutorial";
