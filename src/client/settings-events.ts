import type { Settings } from "./types";

export const settingsUpdatedEvent = "sparklingkit:settings-updated";

export function announceSettingsUpdated(settings: Settings) {
  window.dispatchEvent(new CustomEvent<Settings>(settingsUpdatedEvent, { detail: settings }));
}
