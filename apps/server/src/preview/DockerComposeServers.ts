import {
  DEFAULT_SERVER_SETTINGS,
  type DockerComposePublishedPort,
  type DockerComposeServerList,
  type DockerComposeServersInput,
  type DockerComposeServiceList,
  type DockerComposeServicesInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Links a thread to the Docker Compose stack running from its worktree (or project root).
 * Compose labels every container with the directory it ran from, which is the directory of
 * the workspace's compose file. Workspaces without a compose file never reach Docker.
 */
export class DockerComposeServers extends Context.Service<
  DockerComposeServers,
  {
    readonly list: (input: DockerComposeServersInput) => Effect.Effect<DockerComposeServerList>;
    readonly services: (
      input: DockerComposeServicesInput,
    ) => Effect.Effect<DockerComposeServiceList>;
  }
>()("t3/preview/DockerComposeServers") {}

const DOCKER_PS_TIMEOUT = Duration.seconds(3);
// `compose config` interpolates and merges every file, which can take a few seconds.
const COMPOSE_CONFIG_TIMEOUT = Duration.seconds(10);
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const SERVICE_LABEL = "com.docker.compose.service";
const ALL_INTERFACES = new Set(["", "0.0.0.0", "::"]);
const LOOPBACK_INTERFACES = new Set(["127.0.0.1", "::1"]);

/** The file names `docker compose` looks for, in its own order of preference. */
const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
/** Where repositories commonly keep a compose file when it is not at the root. */
const COMPOSE_SUBDIRECTORIES = ["docker", ".docker", "infra", "deploy", ".devcontainer"];

/** Services that usually serve the app itself, preferred in this order when none is chosen. */
const FRONTEND_SERVICES = [
  "proxy",
  "frontend",
  "web",
  "app",
  "nginx",
  "caddy",
  "traefik",
  "client",
  "ui",
];
/** Databases, caches, and mail servers a browser cannot open; never offered as links. */
const NON_HTTP_CONTAINER_PORTS = new Set([1025, 3306, 5432, 6379, 11211, 27017]);

const expandRange = (raw: string): ReadonlyArray<number> => {
  const [startRaw, endRaw = startRaw] = raw.split("-");
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};

/**
 * Parses `docker ps` `{{.Ports}}`, e.g. `0.0.0.0:8087->84/tcp, [::]:8087->84/tcp, 8000/tcp`.
 * Keeps TCP ports published on all interfaces or on loopback. Ports bound to another address
 * would need that address in the link, and unpublished ports have no host side.
 */
export const parseDockerPorts = (
  raw: string,
): ReadonlyArray<Omit<DockerComposePublishedPort, "service">> => {
  const ports = new Map<number, Omit<DockerComposePublishedPort, "service">>();
  for (const entry of raw.split(",")) {
    const match = /^\[?([^\]]*?)\]?:(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/tcp$/.exec(entry.trim());
    if (!match) continue;
    const [, host = "", hostRange = "", containerRange = ""] = match;
    const loopbackOnly = LOOPBACK_INTERFACES.has(host);
    if (!loopbackOnly && !ALL_INTERFACES.has(host)) continue;
    const hostPorts = expandRange(hostRange);
    const containerPorts = expandRange(containerRange);
    if (hostPorts.length !== containerPorts.length) continue;
    hostPorts.forEach((hostPort, index) => {
      const containerPort = containerPorts[index] ?? hostPort;
      // The same host port on all interfaces and on loopback is reachable from anywhere.
      const existing = ports.get(hostPort);
      ports.set(hostPort, {
        hostPort,
        containerPort,
        loopbackOnly: loopbackOnly && (existing?.loopbackOnly ?? true),
      });
    });
  }
  return [...ports.values()];
};

/** Parses `docker ps` lines of `<service>\t<ports>`. */
export const parseDockerPsOutput = (stdout: string): ReadonlyArray<DockerComposePublishedPort> =>
  stdout.split(/\r?\n/g).flatMap((line) => {
    const [service = "", ports = ""] = line.split("\t");
    if (service.trim().length === 0) return [];
    return parseDockerPorts(ports).map((port) => ({ service: service.trim(), ...port }));
  });

const rankService = (service: string) => {
  const index = FRONTEND_SERVICES.indexOf(service);
  return index === -1 ? FRONTEND_SERVICES.length : index;
};

/**
 * What Automatic picks among a stack's ports: frontend-like services first, then ports reachable
 * from anywhere, then the lowest port, skipping ports a browser cannot open.
 */
export const rankAutomaticPorts = <
  Port extends {
    readonly service: string;
    readonly containerPort: number;
    readonly loopbackOnly: boolean;
  },
>(
  ports: ReadonlyArray<Port>,
  portNumber: (port: Port) => number,
): ReadonlyArray<Port> =>
  ports
    .filter((port) => !NON_HTTP_CONTAINER_PORTS.has(port.containerPort))
    .toSorted(
      (left, right) =>
        rankService(left.service) - rankService(right.service) ||
        Number(left.loopbackOnly) - Number(right.loopbackOnly) ||
        portNumber(left) - portNumber(right),
    );

/**
 * Reads one `ports` entry. Interpolated config uses the long form; `--no-interpolate` keeps
 * the short form, `[ip:]published:target[/protocol]`, whose variables may contain colons.
 */
const parseComposePortEntry = (
  raw: unknown,
): ReadonlyArray<{ readonly containerPort: number; readonly host: string }> => {
  if (typeof raw === "string") {
    const [spec = "", protocol = "tcp"] = raw.replace(/\$\{[^}]*\}/g, "VAR").split("/");
    if (protocol !== "tcp") return [];
    const bracketed = /^\[([^\]]*)\]:(.*)$/.exec(spec);
    const parts = bracketed
      ? [bracketed[1] ?? "", ...(bracketed[2] ?? "").split(":")]
      : spec.split(":");
    // A bare container port is not published.
    if (parts.length < 2) return [];
    const host = parts.length >= 3 ? (parts[0] ?? "") : "";
    return expandRange(parts.at(-1) ?? "").map((containerPort) => ({ containerPort, host }));
  }
  if (typeof raw !== "object" || raw === null) return [];
  const port = raw as {
    readonly target?: unknown;
    readonly published?: unknown;
    readonly host_ip?: unknown;
    readonly protocol?: unknown;
  };
  if (port.published === undefined || (port.protocol ?? "tcp") !== "tcp") return [];
  return [
    {
      containerPort: Number(port.target),
      host: typeof port.host_ip === "string" ? port.host_ip : "",
    },
  ];
};

/**
 * Parses `docker compose config --format json` into each service's published TCP container
 * ports. Ports bound to a specific non-loopback address are left out, as in `docker ps`.
 */
export const parseComposeConfig = (stdout: string): DockerComposeServiceList["ports"] => {
  const config: unknown = JSON.parse(stdout);
  const services =
    typeof config === "object" && config !== null && "services" in config
      ? (config.services as Record<string, { readonly ports?: ReadonlyArray<unknown> }>)
      : {};
  const ports = new Map<string, DockerComposeServiceList["ports"][number]>();
  for (const [service, definition] of Object.entries(services)) {
    for (const { containerPort, host } of (definition?.ports ?? []).flatMap(
      parseComposePortEntry,
    )) {
      if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) continue;
      const loopbackOnly = LOOPBACK_INTERFACES.has(host);
      if (!loopbackOnly && !ALL_INTERFACES.has(host)) continue;
      const key = `${service}:${containerPort}`;
      ports.set(key, {
        service,
        containerPort,
        loopbackOnly: loopbackOnly && (ports.get(key)?.loopbackOnly ?? true),
      });
    }
  }
  return [...ports.values()].toSorted(
    (left, right) =>
      left.service.localeCompare(right.service) || left.containerPort - right.containerPort,
  );
};

const parseComposeConfigOption = Option.liftThrowable(parseComposeConfig);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machineHostname = (yield* HostProcess.Hostname).split(".")[0] || "localhost";

  /** Reads the workspace root, and only the known subdirectories it contains. */
  const findComposeFile = Effect.fn("DockerComposeServers.findComposeFile")(function* (
    workspaceRoot: string,
  ) {
    const readNames = (directory: string) =>
      fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const rootNames = yield* readNames(workspaceRoot);
    const directories = [
      "",
      ...COMPOSE_SUBDIRECTORIES.filter((directory) => rootNames.includes(directory)),
    ];
    for (const directory of directories) {
      const names =
        directory === "" ? rootNames : yield* readNames(path.join(workspaceRoot, directory));
      const name = COMPOSE_FILE_NAMES.find((candidate) => names.includes(candidate));
      if (name !== undefined) {
        return {
          directory: path.join(workspaceRoot, directory),
          relativePath: directory === "" ? name : `${directory}/${name}`,
        };
      }
    }
    return null;
  });

  const list = Effect.fn("DockerComposeServers.list")(function* (input: DockerComposeServersInput) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS)),
      input.projectId ?? null,
    ).settings;
    const none = { ports: [], machineHostname };
    if (!settings.dockerComposeLinksEnabled) return none;
    const composeFile = yield* findComposeFile(input.workspaceRoot);
    if (composeFile === null) return none;
    const ports = yield* processRunner
      .run({
        command: "docker",
        args: [
          "ps",
          "--filter",
          `label=${WORKING_DIR_LABEL}=${composeFile.directory}`,
          "--format",
          `{{.Label "${SERVICE_LABEL}"}}\t{{.Ports}}`,
        ],
        timeout: DOCKER_PS_TIMEOUT,
        maxOutputBytes: 256 * 1024,
      })
      .pipe(
        Effect.map((result) => (result.code === 0 ? parseDockerPsOutput(result.stdout) : [])),
        // No Docker, no daemon, or no permission all mean "nothing to link".
        Effect.orElseSucceed(() => []),
      );
    return { ports: rankAutomaticPorts(ports, (port) => port.hostPort), machineHostname };
  });

  const services = Effect.fn("DockerComposeServers.services")(function* (
    input: DockerComposeServicesInput,
  ) {
    const composeFile = yield* findComposeFile(input.workspaceRoot);
    if (composeFile === null) {
      return { composeFile: null, readable: false, ports: [], automatic: null };
    }
    const readConfig = (args: ReadonlyArray<string>) =>
      processRunner
        .run({
          command: "docker",
          args: ["compose", "config", "--format", "json", ...args],
          cwd: composeFile.directory,
          timeout: COMPOSE_CONFIG_TIMEOUT,
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.map((result) =>
            result.code === 0 ? parseComposeConfigOption(result.stdout) : Option.none(),
          ),
          // A missing Compose plugin or an invalid file both mean "unreadable".
          Effect.orElseSucceed(() => Option.none()),
        );
    // Projects that start Compose through a wrapper script often leave required variables
    // unset here. Container ports are rarely variables, so the raw file still lists them.
    let ports = yield* readConfig([]);
    if (Option.isNone(ports)) ports = yield* readConfig(["--no-interpolate"]);
    const detected = Option.getOrElse(ports, () => []).filter(
      (port) => !NON_HTTP_CONTAINER_PORTS.has(port.containerPort),
    );
    const automatic = rankAutomaticPorts(detected, (port) => port.containerPort)[0];
    return {
      composeFile: composeFile.relativePath,
      readable: Option.isSome(ports),
      ports: detected,
      automatic: automatic
        ? { service: automatic.service, containerPort: automatic.containerPort }
        : null,
    };
  });

  return DockerComposeServers.of({ list, services });
});

export const layer = Layer.effect(DockerComposeServers, make);
