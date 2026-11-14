import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** The original Chrome shared its directory with service databases. Keep only its site state. */
export async function separateDefaultProfile(serviceDirectory: string): Promise<string> {
  const directory = join(serviceDirectory, "browser-default");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["Default", "Local State", "First Run", "Last Version", "downloads"]) {
    const source = join(serviceDirectory, name);
    try {
      await stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Never overwrite a profile restored or migrated by another deployment.
    try {
      await stat(join(directory, name));
      throw new Error(`Both legacy and separated browser state exist: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, join(directory, name));
  }
  return directory;
}
