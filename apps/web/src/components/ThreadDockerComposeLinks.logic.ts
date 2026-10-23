import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { DockerComposeLinkTarget, DockerComposePublishedPort } from "@t3tools/contracts";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";

export interface DockerComposeLinkConnection {
  readonly target: ConnectionTarget;
  readonly httpBaseUrl: string;
  /** The desktop app's own backend, which runs on the same machine as its windows. */
  readonly isDesktopLocal: boolean;
}

/**
 * The host a published port answers on for this client. A direct connection names the host
 * the client already reaches; SSH and relay connections only reach a forwarded or relayed
 * port, so they fall back to the server's machine name. A loopback URL means the same
 * machine only for the app's own backend: other loopback URLs may be forwarded ports.
 */
export function resolveDockerComposeLinkHost(
  connection: DockerComposeLinkConnection | null,
  machineHostname: string,
): DockerComposeLinkHost {
  const fallback = { host: machineHostname, reachesLoopback: false };
  if (
    connection === null ||
    connection.target._tag === "SshConnectionTarget" ||
    connection.target._tag === "RelayConnectionTarget"
  ) {
    return fallback;
  }
  const hostname = normalizeHostname(new URL(connection.httpBaseUrl).hostname);
  if (isLocalLoopbackHost(hostname)) {
    return connection.target._tag === "PrimaryConnectionTarget" || connection.isDesktopLocal
      ? { host: "localhost", reachesLoopback: true }
      : fallback;
  }
  return { host: hostname.includes(":") ? `[${hostname}]` : hostname, reachesLoopback: false };
}

export interface DockerComposeLinkHost {
  readonly host: string;
  readonly reachesLoopback: boolean;
}

export const dockerComposePortReachable = (
  port: Pick<DockerComposePublishedPort, "loopbackOnly">,
  link: DockerComposeLinkHost,
): boolean => link.reachesLoopback || !port.loopbackOnly;

export const dockerComposePortUrl = (
  port: Pick<DockerComposePublishedPort, "hostPort">,
  link: DockerComposeLinkHost,
  path = "",
): string => `http://${link.host}:${port.hostPort}${path}`;

export const normalizeDockerComposeLinkPath = (path: string): string =>
  path === "" || /^[/?#]/.test(path) ? path : `/${path}`;

/**
 * The main link for this client: the chosen service and port, or the first port Automatic
 * prefers, skipping ports bound to loopback when this client is on another machine.
 */
export function dockerComposeMainLinkUrl(input: {
  readonly ports: ReadonlyArray<DockerComposePublishedPort>;
  readonly chosen: DockerComposeLinkTarget | null;
  readonly path: string;
  readonly link: DockerComposeLinkHost;
}): string | null {
  const { chosen, link } = input;
  const candidates =
    chosen === null
      ? input.ports
      : input.ports
          .filter(
            (port) =>
              port.service === chosen.service && port.containerPort === chosen.containerPort,
          )
          .toSorted((left, right) => Number(left.loopbackOnly) - Number(right.loopbackOnly));
  const port = candidates.find((candidate) => dockerComposePortReachable(candidate, link));
  return port ? dockerComposePortUrl(port, link, normalizeDockerComposeLinkPath(input.path)) : null;
}

/** Each service and container port once, as the choices for a project's main link. */
export function dockerComposeLinkChoices(
  ports: ReadonlyArray<DockerComposePublishedPort>,
): ReadonlyArray<DockerComposeLinkTarget & { readonly loopbackOnly: boolean }> {
  const choices = new Map<string, DockerComposeLinkTarget & { readonly loopbackOnly: boolean }>();
  for (const port of ports) {
    const key = `${port.service}:${port.containerPort}`;
    choices.set(key, {
      service: port.service,
      containerPort: port.containerPort,
      loopbackOnly: port.loopbackOnly && (choices.get(key)?.loopbackOnly ?? true),
    });
  }
  return [...choices.values()];
}
