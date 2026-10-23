import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";

import { useOpenLink } from "../browser/useOpenLink";
import { useDockerComposeStack } from "./useDockerComposeStack";

/**
 * Links to the main URL of the Docker Compose stack published from a thread's workspace,
 * so each worktree's running app is one click away from the sidebar hover card.
 */
export function ThreadDockerComposeLinks({
  environmentId,
  projectId,
  threadId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  workspaceRoot: string | null;
}) {
  const stack = useDockerComposeStack({ environmentId, projectId, workspaceRoot });
  const openLink = useOpenLink(scopeThreadRef(environmentId, threadId));
  const url = stack?.mainUrl ?? null;
  if (url === null) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-w-0 items-center gap-2"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        void openLink(url, { event }).catch((error: unknown) => console.error(error));
      }}
    >
      <GlobeIcon className="size-3 shrink-0 stroke-muted-foreground" />
      <span className="min-w-0 truncate text-foreground/75 underline-offset-2 group-hover:text-foreground group-hover:underline">
        {url.replace(/^https?:\/\//, "")}
      </span>
    </a>
  );
}
