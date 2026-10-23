import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type DockerComposeLinkTarget,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import { useRef } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  dockerComposeLinkChoices,
  dockerComposePortReachable,
  dockerComposePortUrl,
} from "../ThreadDockerComposeLinks.logic";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useDockerComposeStack } from "../useDockerComposeStack";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const AUTOMATIC = "automatic";
const linkValue = (link: DockerComposeLinkTarget) => `${link.service}:${link.containerPort}`;
const linkLabel = (link: DockerComposeLinkTarget) => `${link.service} · port ${link.containerPort}`;

/**
 * Opens the app the thread's Docker Compose stack serves, beside "Open in editor". The menu
 * opens any other running service and sets the project's main link where it is used.
 * Renders nothing unless the stack is running with published ports.
 */
export function ThreadDockerComposeAppControl({
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
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save main link",
  });
  if (stack === null || stack.list.ports.length === 0) return null;
  const { list, link, mainUrl, chosen, settings } = stack;
  // Automatic opens the first port this client reaches, so name that one.
  const automatic = list.ports.find((port) => dockerComposePortReachable(port, link)) ?? null;
  const services = list.ports.toSorted(
    (left, right) => left.service.localeCompare(right.service) || left.hostPort - right.hostPort,
  );
  const choices = dockerComposeLinkChoices(list.ports);

  const open = (url: string, event?: { metaKey: boolean; ctrlKey: boolean }) =>
    void openLink(url, event ? { event } : {}).catch((error: unknown) => console.error(error));

  /** Inherits the environment's choice for Automatic unless the environment chose a service. */
  const setMainLink = (target: DockerComposeLinkTarget | null) => {
    if (settings === null) return;
    const { dockerComposeLink: _previous, ...rest } =
      settings.projectSettingsOverrides[projectId] ?? {};
    const next =
      target === null && settings.dockerComposeLink === null
        ? rest
        : { ...rest, dockerComposeLink: target };
    void updateSettings({
      environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: Object.keys(next).length === 0 ? null : next,
          },
        },
      },
    });
  };

  return (
    <div
      aria-label="Open app"
      role="group"
      className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
      ref={anchorRef}
    >
      <ThreadDetailsControl
        aria-label={mainUrl ? `Open app at ${mainUrl}` : "Open app"}
        size="sm"
        variant="ghost"
        part="primary"
        disabled={mainUrl === null}
        onClick={(event) => {
          if (mainUrl) open(mainUrl, event);
        }}
      >
        <GlobeIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={`shrink-0 ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>Open app</span>
        <span className="ml-auto min-w-0 truncate text-xs font-normal text-muted-foreground">
          {mainUrl ? mainUrl.replace(/^https?:\/\//, "") : "Not running"}
        </span>
      </ThreadDetailsControl>
      <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              aria-label="Choose service"
              size="sm"
              variant="ghost"
              part="secondary"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
          <MenuGroup>
            <MenuGroupLabel>Running services</MenuGroupLabel>
            {services.map((port) => {
              const reachable = dockerComposePortReachable(port, link);
              return (
                <MenuItem
                  key={port.hostPort}
                  disabled={!reachable}
                  onClick={(event) => open(dockerComposePortUrl(port, link), event)}
                >
                  <MenuItemLabel>{port.service}</MenuItemLabel>
                  <MenuShortcut>
                    {reachable ? `:${port.hostPort}` : `Only on ${list.machineHostname}`}
                  </MenuShortcut>
                </MenuItem>
              );
            })}
          </MenuGroup>
          {canWriteSettings && settings !== null ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>
                  <MenuItemLabel>Main link</MenuItemLabel>
                  <MenuShortcut>{chosen ? chosen.service : "Automatic"}</MenuShortcut>
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={chosen === null ? AUTOMATIC : linkValue(chosen)}
                    onValueChange={(value) => {
                      if (value === AUTOMATIC) {
                        setMainLink(null);
                        return;
                      }
                      const picked = choices.find((choice) => linkValue(choice) === value);
                      if (picked) {
                        setMainLink({
                          service: picked.service,
                          containerPort: picked.containerPort,
                        });
                      }
                    }}
                  >
                    <MenuRadioItem value={AUTOMATIC} closeOnClick>
                      {automatic ? `Automatic (${linkLabel(automatic)})` : "Automatic"}
                    </MenuRadioItem>
                    {choices.map((choice) => (
                      <MenuRadioItem key={linkValue(choice)} value={linkValue(choice)} closeOnClick>
                        {linkLabel(choice)}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
