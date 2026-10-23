import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DockerComposePublishedPort } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dockerComposeLinkChoices,
  dockerComposeMainLinkUrl,
  resolveDockerComposeLinkHost,
} from "./ThreadDockerComposeLinks.logic";

const environmentId = EnvironmentId.make("environment");
const primary = (httpBaseUrl: string) => ({
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "Local",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
  }),
  httpBaseUrl,
  isDesktopLocal: false,
});

describe("resolveDockerComposeLinkHost", () => {
  it("uses localhost and loopback ports for a client on the server's machine", () => {
    expect(resolveDockerComposeLinkHost(primary("http://127.0.0.1:3773"), "devbox")).toEqual({
      host: "localhost",
      reachesLoopback: true,
    });
  });

  it("uses the host a direct remote connection already reaches", () => {
    expect(
      resolveDockerComposeLinkHost(primary("http://devbox.tail1234.ts.net:3773"), "devbox"),
    ).toEqual({ host: "devbox.tail1234.ts.net", reachesLoopback: false });
    expect(resolveDockerComposeLinkHost(primary("http://[fd7a::1]:3773"), "devbox")).toEqual({
      host: "[fd7a::1]",
      reachesLoopback: false,
    });
  });

  it("falls back to the machine name over SSH, whose loopback URL is a forwarded port", () => {
    expect(
      resolveDockerComposeLinkHost(
        {
          target: new SshConnectionTarget({ environmentId, label: "devbox", connectionId: "ssh" }),
          httpBaseUrl: "http://127.0.0.1:41234",
          isDesktopLocal: false,
        },
        "devbox",
      ),
    ).toEqual({ host: "devbox", reachesLoopback: false });
    expect(
      resolveDockerComposeLinkHost(
        {
          target: new BearerConnectionTarget({ environmentId, label: "x", connectionId: "manual" }),
          httpBaseUrl: "http://localhost:41234",
          isDesktopLocal: false,
        },
        "devbox",
      ),
    ).toEqual({ host: "devbox", reachesLoopback: false });
  });
});

describe("dockerComposeMainLinkUrl", () => {
  const ports: ReadonlyArray<DockerComposePublishedPort> = [
    { service: "web", hostPort: 3000, containerPort: 3000, loopbackOnly: true },
    { service: "api", hostPort: 8000, containerPort: 8000, loopbackOnly: false },
    { service: "rustfs", hostPort: 9100, containerPort: 9000, loopbackOnly: false },
  ];
  const local = { host: "localhost", reachesLoopback: true };
  const remote = { host: "devbox", reachesLoopback: false };

  it("opens Automatic's first port this client can reach, with the path", () => {
    expect(dockerComposeMainLinkUrl({ ports, chosen: null, path: "/dashboard", link: local })).toBe(
      "http://localhost:3000/dashboard",
    );
    expect(dockerComposeMainLinkUrl({ ports, chosen: null, path: "dashboard", link: remote })).toBe(
      "http://devbox:8000/dashboard",
    );
  });

  it("opens only the chosen service and port", () => {
    expect(
      dockerComposeMainLinkUrl({
        ports,
        chosen: { service: "rustfs", containerPort: 9000 },
        path: "",
        link: remote,
      }),
    ).toBe("http://devbox:9100");
    expect(
      dockerComposeMainLinkUrl({
        ports,
        chosen: { service: "web", containerPort: 3000 },
        path: "",
        link: remote,
      }),
    ).toBeNull();
  });
});

describe("dockerComposeLinkChoices", () => {
  it("lists each service port once, reachable from anywhere if any binding is", () => {
    expect(
      dockerComposeLinkChoices([
        { service: "proxy", hostPort: 86, containerPort: 84, loopbackOnly: false },
        { service: "proxy", hostPort: 8086, containerPort: 8084, loopbackOnly: false },
        { service: "web", hostPort: 3000, containerPort: 3000, loopbackOnly: true },
        { service: "web", hostPort: 3001, containerPort: 3000, loopbackOnly: false },
      ]),
    ).toEqual([
      { service: "proxy", containerPort: 84, loopbackOnly: false },
      { service: "proxy", containerPort: 8084, loopbackOnly: false },
      { service: "web", containerPort: 3000, loopbackOnly: false },
    ]);
  });
});
