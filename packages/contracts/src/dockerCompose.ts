import * as Schema from "effect/Schema";

import { PortSchema, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A service's container port. Host ports often shift per worktree, so the
 * container port is what stays stable across a project's checkouts.
 */
export const DockerComposeLinkTarget = Schema.Struct({
  service: TrimmedNonEmptyString,
  containerPort: PortSchema,
});
export type DockerComposeLinkTarget = typeof DockerComposeLinkTarget.Type;

/** A published port of a running Docker Compose container. */
export const DockerComposePublishedPort = Schema.Struct({
  service: TrimmedNonEmptyString,
  hostPort: PortSchema,
  containerPort: PortSchema,
  /** Bound to 127.0.0.1 or ::1, so only a client on the same machine reaches it. */
  loopbackOnly: Schema.Boolean,
});
export type DockerComposePublishedPort = typeof DockerComposePublishedPort.Type;

export const DockerComposeServersInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  /** Selects the project's Docker Compose setting overrides. */
  projectId: Schema.optionalKey(ProjectId),
});
export type DockerComposeServersInput = typeof DockerComposeServersInput.Type;

/**
 * The running stack's published ports a browser can open, in the order Automatic prefers them.
 * Clients apply the project's main link and path from their live settings, so a change shows
 * without refetching.
 */
export const DockerComposeServerList = Schema.Struct({
  ports: Schema.Array(DockerComposePublishedPort),
  /** Reaches the server from clients that cannot use their connection's own host. */
  machineHostname: TrimmedNonEmptyString,
});
export type DockerComposeServerList = typeof DockerComposeServerList.Type;

export const DockerComposeServicesInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type DockerComposeServicesInput = typeof DockerComposeServicesInput.Type;

/** The services a workspace's compose file publishes, read without starting the stack. */
export const DockerComposeServiceList = Schema.Struct({
  /** Relative to the workspace; null when the workspace has no compose file. */
  composeFile: Schema.NullOr(TrimmedNonEmptyString),
  /** False when Docker Compose could not read the file. */
  readable: Schema.Boolean,
  ports: Schema.Array(
    Schema.Struct({
      ...DockerComposeLinkTarget.fields,
      loopbackOnly: Schema.Boolean,
    }),
  ),
  /** What Automatic picks from these ports, so the picker can say so. */
  automatic: Schema.NullOr(DockerComposeLinkTarget),
});
export type DockerComposeServiceList = typeof DockerComposeServiceList.Type;
