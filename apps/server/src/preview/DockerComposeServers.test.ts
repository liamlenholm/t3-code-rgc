import { it as effectIt } from "@effect/vitest";
import type { DockerComposePublishedPort } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  DockerComposeServers,
  layer as layerDockerComposeServers,
  parseComposeConfig,
  parseDockerPorts,
  parseDockerPsOutput,
  rankAutomaticPorts,
} from "./DockerComposeServers.ts";

describe("parseDockerPorts", () => {
  it("keeps TCP ports on all interfaces or loopback, deduplicating IPv4 and IPv6", () => {
    expect(
      parseDockerPorts(
        "80/tcp, 443/udp, 0.0.0.0:27036->84/tcp, [::]:27036->84/tcp, 127.0.0.1:29036->5432/tcp, [::1]:3000->3000/tcp, 192.168.1.5:4000->4000/tcp",
      ),
    ).toEqual([
      { hostPort: 27036, containerPort: 84, loopbackOnly: false },
      { hostPort: 29036, containerPort: 5432, loopbackOnly: true },
      { hostPort: 3000, containerPort: 3000, loopbackOnly: true },
    ]);
  });

  it("treats a port on both loopback and all interfaces as reachable from anywhere", () => {
    expect(parseDockerPorts("127.0.0.1:8080->80/tcp, 0.0.0.0:8080->80/tcp")).toEqual([
      { hostPort: 8080, containerPort: 80, loopbackOnly: false },
    ]);
  });

  it("expands published port ranges pairwise", () => {
    expect(parseDockerPorts("0.0.0.0:9000-9001->9000-9001/tcp")).toEqual([
      { hostPort: 9000, containerPort: 9000, loopbackOnly: false },
      { hostPort: 9001, containerPort: 9001, loopbackOnly: false },
    ]);
  });
});

describe("parseDockerPsOutput", () => {
  it("labels each published port with its service", () => {
    expect(
      parseDockerPsOutput(
        ["proxy\t80/tcp, 0.0.0.0:27036->84/tcp", "backend\t8000/tcp", ""].join("\n"),
      ),
    ).toEqual([{ service: "proxy", hostPort: 27036, containerPort: 84, loopbackOnly: false }]);
  });
});

describe("rankAutomaticPorts", () => {
  const port = (
    service: string,
    hostPort: number,
    containerPort = 80,
    loopbackOnly = false,
  ): DockerComposePublishedPort => ({ service, hostPort, containerPort, loopbackOnly });
  const rank = (ports: ReadonlyArray<DockerComposePublishedPort>) =>
    rankAutomaticPorts(ports, (candidate) => candidate.hostPort).map(
      (candidate) => `${candidate.service}:${candidate.hostPort}`,
    );

  it("prefers frontend-like services, then the lowest host port", () => {
    expect(rank([port("rustfs", 35104), port("proxy", 28104), port("proxy", 27104)])).toEqual([
      "proxy:27104",
      "proxy:28104",
      "rustfs:35104",
    ]);
    expect(rank([port("api", 8000), port("app", 8080)])).toEqual(["app:8080", "api:8000"]);
  });

  it("leaves out databases and caches", () => {
    expect(rank([port("db", 5432, 5432, true), port("api", 8001, 8000)])).toEqual(["api:8001"]);
  });

  it("puts reachable-from-anywhere ports before loopback ones", () => {
    expect(rank([port("web", 3000, 3000, true), port("web", 3001, 3001)])).toEqual([
      "web:3001",
      "web:3000",
    ]);
  });
});

describe("parseComposeConfig", () => {
  it("reads short-form ports left uninterpolated, whose variables contain colons", () => {
    expect(
      parseComposeConfig(
        JSON.stringify({
          services: {
            proxy: { ports: ["${PROXY_PORT:-84}:84", "8084"] },
            db: { ports: ["127.0.0.1:${DB_PORT:-5434}:5432"] },
            rustfs: { ports: ["${RUSTFS_PORT:-9000}-${RUSTFS_END:-9001}:9000-9001/tcp"] },
            dns: { ports: ["53:53/udp"] },
            lan: { ports: ["192.168.1.5:3000:3000"] },
            v6: { ports: ["[::1]:4000:4000"] },
          },
        }),
      ),
    ).toEqual([
      { service: "db", containerPort: 5432, loopbackOnly: true },
      { service: "proxy", containerPort: 84, loopbackOnly: false },
      { service: "rustfs", containerPort: 9000, loopbackOnly: false },
      { service: "rustfs", containerPort: 9001, loopbackOnly: false },
      { service: "v6", containerPort: 4000, loopbackOnly: true },
    ]);
  });

  it("lists each service's published TCP container ports", () => {
    expect(
      parseComposeConfig(
        JSON.stringify({
          services: {
            proxy: {
              ports: [
                { target: 84, published: "27036" },
                { target: 8084, published: "28036", host_ip: "0.0.0.0" },
              ],
            },
            db: { ports: [{ target: 5432, published: "29036", host_ip: "127.0.0.1" }] },
            dns: { ports: [{ target: 53, published: "53", protocol: "udp" }] },
            backend: { expose: ["8000"] },
            internal: { ports: [{ target: 9000 }] },
          },
        }),
      ),
    ).toEqual([
      { service: "db", containerPort: 5432, loopbackOnly: true },
      { service: "proxy", containerPort: 84, loopbackOnly: false },
      { service: "proxy", containerPort: 8084, loopbackOnly: false },
    ]);
  });
});

const PS_OUTPUT = "proxy\t0.0.0.0:27036->84/tcp, [::]:27036->84/tcp\n";

/** Records every process the service runs; `docker ps` reports one published proxy port. */
const makeHarness = (input: {
  readonly files: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly settings?: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0];
}) => {
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  const layer = layerDockerComposeServers.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (run) => {
            runs.push(run);
            return Effect.succeed({
              stdout: PS_OUTPUT,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
        ServerSettings.ServerSettingsService.layerTest(input.settings),
        FileSystem.layerNoop({
          readDirectory: (directory) => Effect.succeed([...(input.files[directory] ?? [])]),
        }),
        Path.layer,
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Hostname, "devbox.tailnet.ts.net")),
  );
  return { runs, layer };
};

describe("DockerComposeServers.list", () => {
  effectIt.effect("links the stack when the workspace has a compose file", () => {
    const { runs, layer } = makeHarness({ files: { "/repo": ["compose.yaml", "src"] } });
    return Effect.gen(function* () {
      const result = yield* (yield* DockerComposeServers).list({ workspaceRoot: "/repo" });
      expect(result).toEqual({
        ports: [{ service: "proxy", hostPort: 27036, containerPort: 84, loopbackOnly: false }],
        machineHostname: "devbox",
      });
      expect(runs.map((run) => run.args.join(" "))).toEqual([
        expect.stringContaining("label=com.docker.compose.project.working_dir=/repo "),
      ]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect("finds a compose file in a known subdirectory", () => {
    const { runs, layer } = makeHarness({
      files: { "/repo": ["infra", "src"], "/repo/infra": ["docker-compose.yml"] },
    });
    return Effect.gen(function* () {
      yield* (yield* DockerComposeServers).list({ workspaceRoot: "/repo" });
      expect(runs[0]?.args).toContain("label=com.docker.compose.project.working_dir=/repo/infra");
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect("never runs Docker for a workspace without a compose file", () => {
    const { runs, layer } = makeHarness({ files: { "/repo": ["package.json", "src"] } });
    return Effect.gen(function* () {
      const result = yield* (yield* DockerComposeServers).list({ workspaceRoot: "/repo" });
      expect(result.ports).toEqual([]);
      expect(runs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect("never runs Docker when the setting is off", () => {
    const { runs, layer } = makeHarness({
      files: { "/repo": ["compose.yaml"] },
      settings: { dockerComposeLinksEnabled: false },
    });
    return Effect.gen(function* () {
      const result = yield* (yield* DockerComposeServers).list({ workspaceRoot: "/repo" });
      expect(result.ports).toEqual([]);
      expect(runs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
