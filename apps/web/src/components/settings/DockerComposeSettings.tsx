import { DEFAULT_SERVER_SETTINGS, type DockerComposeLinkTarget } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useRef } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useServerConfigs } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { resolveDockerComposeLinkHost } from "../ThreadDockerComposeLinks.logic";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const AUTOMATIC = "automatic";

const linkValue = (link: DockerComposeLinkTarget) => `${link.service}:${link.containerPort}`;
const linkLabel = (link: DockerComposeLinkTarget) => `${link.service} · port ${link.containerPort}`;

/** Lists the selected project's compose services so its main link is a pick, not typing. */
function DockerComposeMainLinkSetting() {
  const { scope, target } = useSettingsScope();
  const link = useScopedSettings((settings) => settings.dockerComposeLink);
  const mixed = useScopedSettingsMixed(["dockerComposeLink"]);
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const member = isProjectScope
    ? (scope.members.find(
        (candidate) =>
          candidate.environmentId === target?.environmentId && candidate.id === target.projectId,
      ) ?? null)
    : null;
  const detection = useEnvironmentQuery(
    member === null
      ? null
      : previewEnvironment.dockerComposeServices({
          environmentId: member.environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        }),
  );
  const connection = Option.getOrNull(usePreparedConnection(member?.environmentId ?? null));
  // Only the reachability matters here, so no machine name is needed.
  const reachesLoopback = resolveDockerComposeLinkHost(
    connection && {
      target: connection.target,
      httpBaseUrl: connection.httpBaseUrl,
      isDesktopLocal: isDesktopLocalConnectionTarget(connection.target),
    },
    "",
  ).reachesLoopback;
  const detected = detection.data ?? null;
  const ports = detected?.ports ?? [];
  // Keep a saved choice selectable while its stack is edited or the file is unreadable.
  const options =
    link === null || ports.some((port) => linkValue(port) === linkValue(link))
      ? ports
      : [{ ...link, loopbackOnly: false }, ...ports];
  const labels = new Map(options.map((option) => [linkValue(option), linkLabel(option)]));
  const automaticLabel = detected?.automatic
    ? `Automatic (${linkLabel(detected.automatic)})`
    : "Automatic";
  const chosenLocalOnly =
    !reachesLoopback &&
    link !== null &&
    (ports.find((port) => linkValue(port) === linkValue(link))?.loopbackOnly ?? false);

  const status = !isProjectScope
    ? "Select a project at the top of this page to choose from its services."
    : detected === null
      ? detection.error
        ? "Couldn't check this project for a compose file."
        : "Reading the project's compose file…"
      : detected.composeFile === null
        ? "No compose file found in this project, so no link is shown."
        : !detected.readable
          ? `Couldn't read ${detected.composeFile}. Run docker compose config next to it to see why.`
          : ports.length === 0
            ? `${detected.composeFile} publishes no ports.`
            : chosenLocalOnly
              ? `${link.service} only answers on the server's machine, so this device can't open it.`
              : `Services from ${detected.composeFile}.`;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["dockerComposeLink"]}
      {...searchableSetting("docker-compose-main-link")}
      description="The service and port the link opens. Automatic prefers a proxy, frontend, or web service, then the lowest port."
      status={status}
      resetAction={
        mixed || link !== null ? (
          <SettingResetButton
            label="main link"
            onClick={() => updateSettings({ dockerComposeLink: null })}
          />
        ) : null
      }
      control={
        isProjectScope ? (
          <Select
            value={mixed ? null : link === null ? AUTOMATIC : linkValue(link)}
            onValueChange={(value) => {
              if (value === AUTOMATIC) {
                updateSettings({ dockerComposeLink: null });
                return;
              }
              const picked = options.find((option) => linkValue(option) === value);
              if (picked) {
                updateSettings({
                  dockerComposeLink: {
                    service: picked.service,
                    containerPort: picked.containerPort,
                  },
                });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Main link">
              <SelectValue>
                {(value: string | null) =>
                  value === null
                    ? "Mixed"
                    : value === AUTOMATIC
                      ? automaticLabel
                      : (labels.get(value) ?? value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={AUTOMATIC}>{automaticLabel}</SelectItem>
              {options.map((option) => (
                <SelectItem key={linkValue(option)} value={linkValue(option)}>
                  {linkLabel(option)}
                  {option.loopbackOnly ? " (server's machine only)" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null
      }
    />
  );
}

function DockerComposeLinkPathSetting() {
  const path = useScopedSettings((settings) => settings.dockerComposeLinkPath);
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const mixed = useScopedSettingsMixed(["dockerComposeLinkPath"]);
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["dockerComposeLinkPath"]}
      {...searchableSetting("docker-compose-link-path")}
      description="Where the link lands in the app, such as /dashboard."
      resetAction={
        mixed || path !== DEFAULT_SERVER_SETTINGS.dockerComposeLinkPath ? (
          <SettingResetButton
            label="link path"
            onClick={() =>
              updateSettings({
                dockerComposeLinkPath: DEFAULT_SERVER_SETTINGS.dockerComposeLinkPath,
              })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${path}`}
          size="sm"
          className="w-full sm:w-64"
          aria-label="Link path"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "/"}
          defaultValue={mixed ? "" : path}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (edited.current && (mixed || next !== path)) {
              updateSettings({ dockerComposeLinkPath: next });
            }
            edited.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      }
    />
  );
}

export function DockerComposeSettings() {
  const { scope, targets } = useSettingsScope();
  const serverConfigs = useServerConfigs();
  const enabled = useScopedSettings((settings) => settings.dockerComposeLinksEnabled);
  const enabledMixed = useScopedSettingsMixed(["dockerComposeLinksEnabled"]);
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // Official servers drop these settings, so offer them only where a target stores them.
  const supported = targets.some(
    (target) =>
      serverConfigs.get(target.environmentId)?.environment.capabilities.dockerComposeLinks === true,
  );
  if (!supported) return null;

  return (
    <SettingsSection id="docker-compose" title="Docker Compose">
      <SettingsRow
        serverScoped
        settingKeys={["dockerComposeLinksEnabled"]}
        {...searchableSetting("docker-compose-links")}
        description={
          isProjectScope
            ? "Link the app this project's Docker Compose stack serves from each thread's sidebar hover card."
            : "Link the app a thread's Docker Compose stack serves from its sidebar hover card. Only projects with a compose file are checked. Projects can override this."
        }
        resetAction={
          enabled !== DEFAULT_SERVER_SETTINGS.dockerComposeLinksEnabled ? (
            <SettingResetButton
              label="Docker Compose links"
              onClick={() =>
                updateSettings({
                  dockerComposeLinksEnabled: DEFAULT_SERVER_SETTINGS.dockerComposeLinksEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["dockerComposeLinksEnabled"]}
            aria-label="Docker Compose links"
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ dockerComposeLinksEnabled: checked })}
          />
        }
      />
      {enabled || enabledMixed ? (
        <>
          <DockerComposeMainLinkSetting />
          <DockerComposeLinkPathSetting />
        </>
      ) : null}
    </SettingsSection>
  );
}
