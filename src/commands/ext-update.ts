import * as clc from "cli-color";
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
const { marked } = require("marked");
import TerminalRenderer = require("marked-terminal");

import { checkMinRequiredVersion } from "../checkMinRequiredVersion";
import { Command } from "../command";
import { FirebaseError } from "../error";
import * as extensionsApi from "../extensions/extensionsApi";
import {
  ensureExtensionsApiEnabled,
  logPrefix,
  getSourceOrigin,
  SourceOrigin,
  confirm,
  diagnoseAndFixProject,
  isLocalPath,
} from "../extensions/extensionsHelper";
import * as paramHelper from "../extensions/paramHelper";
import { inferUpdateSource } from "../extensions/updateHelper";
import * as refs from "../extensions/refs";
import { getProjectId, needProjectId } from "../projectUtils";
import { requirePermissions } from "../requirePermissions";
import * as utils from "../utils";
import { previews } from "../previews";
import * as manifest from "../extensions/manifest";
import { Options } from "../options";

marked.setOptions({
  renderer: new TerminalRenderer(),
});

/**
 * Command for updating an existing extension instance
 */
export default new Command("ext:update <extensionInstanceId> [updateSource]")
  .description(
    previews.extdev
      ? "update an existing extension instance to the latest version or from a local or URL source"
      : "update an existing extension instance to the latest version"
  )
  .before(requirePermissions, [
    "firebaseextensions.instances.update",
    "firebaseextensions.instances.get",
  ])
  .before(ensureExtensionsApiEnabled)
  .before(checkMinRequiredVersion, "extMinVersion")
  .before(diagnoseAndFixProject)
  .withForce()
  .option("--params <paramsFile>", "name of params variables file with .env format.")
  .action(async (instanceId: string, updateSource: string, options: Options) => {
    const projectId = getProjectId(options);
    const config = manifest.loadConfig(options);

    const oldRefOrPath = manifest.getInstanceTarget(instanceId, config);
    if (isLocalPath(oldRefOrPath)) {
      throw new FirebaseError(
        `Updating an extension with local source is not neccessary. ` +
          `Rerun "firebase deploy" or restart the emulator after making changes to your local extension source. ` +
          `If you've edited the extension param spec, you can edit an extension instance's params ` +
          `interactively by running "firebase ext:configure --local {instance-id}"`
      );
    }

    const oldRef = manifest.getInstanceRef(instanceId, config);
    const oldExtensionVersion = await extensionsApi.getExtensionVersion(
      refs.toExtensionVersionRef(oldRef)
    );
    updateSource = inferUpdateSource(updateSource, refs.toExtensionRef(oldRef));

    const newSourceOrigin = getSourceOrigin(updateSource);
    if (
      ![SourceOrigin.PUBLISHED_EXTENSION, SourceOrigin.PUBLISHED_EXTENSION_VERSION].includes(
        newSourceOrigin
      )
    ) {
      throw new FirebaseError(`Only updating to a published extension version is allowed`);
    }

    const newExtensionVersion = await extensionsApi.getExtensionVersion(updateSource);

    if (oldExtensionVersion.ref === newExtensionVersion.ref) {
      utils.logLabeledBullet(
        logPrefix,
        `${clc.bold(instanceId)} is already up to date. Its version is ${clc.bold(
          newExtensionVersion.ref
        )}.`
      );
      return;
    }

    utils.logLabeledBullet(
      logPrefix,
      `Updating ${clc.bold(instanceId)} from version ${clc.bold(
        oldExtensionVersion.ref
      )} to version ${clc.bold(newExtensionVersion.ref)}.`
    );

    if (
      !(await confirm({
        nonInteractive: options.nonInteractive,
        force: options.force,
        default: false,
      }))
    ) {
      utils.logLabeledBullet(logPrefix, "Update aborted.");
      return;
    }

    const oldParamValues = manifest.readInstanceParam({
      instanceId,
      projectDir: config.projectDir,
    });

    const newParamBindingOptions = await paramHelper.getParamsForUpdate({
      spec: oldExtensionVersion.spec,
      newSpec: newExtensionVersion.spec,
      currentParams: oldParamValues,
      projectId,
      paramsEnvPath: (options.params ?? "") as string,
      nonInteractive: options.nonInteractive,
      instanceId,
    });

    await manifest.writeToManifest(
      [
        {
          instanceId,
          ref: refs.parse(newExtensionVersion.ref),
          params: newParamBindingOptions,
          extensionSpec: newExtensionVersion.spec,
          extensionVersion: newExtensionVersion,
        },
      ],
      config,
      {
        nonInteractive: options.nonInteractive,
        force: true, // Skip asking for permission again
      }
    );
    manifest.showPostDeprecationNotice();
    return;
  });
