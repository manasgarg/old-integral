export const INTEGRAL_VERSION = "0.1.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// The one Pi version integral installs and builds into its default image.
// Pi releases are not backward compatible; follow docs/runbooks/upgrade-pi.md
// to change it, and keep `ARG PI_VERSION` in Dockerfile.pi identical.
export const PI_VERSION = "1.5.2";
export const DEFAULT_PI_IMAGE = `integral-pi:${INTEGRAL_VERSION}`;

export const COMPONENTS = [
  "coordinator",
  "runner",
  "gateway",
  "scheduler",
] as const;
export type Component = (typeof COMPONENTS)[number];

export const DEFAULT_PORTS: Readonly<Record<Component, number>> = {
  gateway: 7310,
  coordinator: 7311,
  runner: 7312,
  scheduler: 7313,
};
