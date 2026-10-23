import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Option from "effect/Option";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useServerConfigs } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentQuery } from "../state/query";
import { usePreparedConnection } from "../state/session";
import {
  dockerComposeMainLinkUrl,
  resolveDockerComposeLinkHost,
} from "./ThreadDockerComposeLinks.logic";

/**
 * The Docker Compose stack running from a thread's workspace, with the host this client reaches
 * its ports on and the main link per the project's live settings. Null when the setting is off,
 * before the server answers, or without a workspace. Mount callers only while visible: each
 * query asks the environment's Docker daemon.
 */
export function useDockerComposeStack(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string | null;
}) {
  const settings = useServerConfigs().get(input.environmentId)?.settings ?? null;
  const projectSettings = settings
    ? resolveProjectSettings(settings, input.projectId).settings
    : null;
  const enabled = projectSettings?.dockerComposeLinksEnabled ?? true;
  const query = useEnvironmentQuery(
    input.workspaceRoot === null || !enabled
      ? null
      : previewEnvironment.dockerComposeServers({
          environmentId: input.environmentId,
          input: { workspaceRoot: input.workspaceRoot, projectId: input.projectId },
        }),
  );
  const connection = Option.getOrNull(usePreparedConnection(input.environmentId));
  if (!enabled || !query.data) return null;
  const link = resolveDockerComposeLinkHost(
    connection && {
      target: connection.target,
      httpBaseUrl: connection.httpBaseUrl,
      isDesktopLocal: isDesktopLocalConnectionTarget(connection.target),
    },
    query.data.machineHostname,
  );
  const chosen = projectSettings?.dockerComposeLink ?? null;
  return {
    list: query.data,
    link,
    settings,
    chosen,
    mainUrl: dockerComposeMainLinkUrl({
      ports: query.data.ports,
      chosen,
      path: projectSettings?.dockerComposeLinkPath ?? "",
      link,
    }),
  };
}
