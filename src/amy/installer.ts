// A.M.Y Loader — one place that installs an .ipa with live progress.
// Used by manual installs, the library, library updates and auto-refresh, so
// every install shows up in the progress dock the same way.
import { invoke } from "@tauri-apps/api/core";
import type { DeviceInfo } from "../Device";
import { IpaInfo, JobMeta, beginJob, endJob, newJobId, readIpaInfo } from "./progress";
import { appNameFromPath } from "./history";

export type InstallOutcome = { info: IpaInfo | null; appName: string };

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Sign and install `path` onto the phone that is currently selected in the
 * engine (`set_selected_device`). Throws the engine's AppError on failure.
 */
export async function installWithProgress(path: string, device: DeviceInfo, kind: JobMeta["kind"]): Promise<InstallOutcome> {
  let info: IpaInfo | null = null;
  try {
    info = await readIpaInfo(path);
  } catch {
    // Not fatal here: the engine reports a clear error if the file is unusable.
  }
  const appName = info?.name ?? appNameFromPath(path);
  const jobId = newJobId();
  beginJob(jobId, {
    app: appName,
    version: info?.version,
    phone: device.name,
    connection: device.connectionType,
    ipaBytes: info?.size ?? 0,
    kind,
  });
  try {
    await invoke("amy_sideload_operation", { appPath: path, jobId });
    endJob(jobId);
    return { info, appName };
  } catch (e) {
    endJob(jobId, errorText(e));
    throw e;
  }
}
