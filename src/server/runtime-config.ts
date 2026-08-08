import type { ServiceInstance } from "hono-aep-cms";

/**
 * Runtime-neutral service-instance source: the Bun entry fills it from
 * readServices(fs); the Worker entry fills it from a bundled artifact —
 * set BEFORE the server body (./app) is dynamically imported, so
 * services.ts evaluates against the right instances (and an installed db).
 */
let instances: ServiceInstance[] = [];
export const setInstances = (value: ServiceInstance[]): void => {
  instances = value;
};
export const getInstances = (): ServiceInstance[] => instances;
