import { EventEmitter } from "node:events";

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

export function publishJob(id: string, payload: unknown) {
  jobEvents.emit(id, payload);
}
