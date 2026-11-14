import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { separateDefaultProfile } from "./profile-directory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
async function serviceDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "profile-migration-"));
  directories.push(directory);
  return directory;
}

describe("default browser directory migration", () => {
  it("preserves site state while keeping management data outside the browser mount", async () => {
    const service = await serviceDirectory();
    await mkdir(join(service, "Default"));
    await writeFile(join(service, "Default", "Cookies"), "login-state");
    await writeFile(join(service, "Local State"), "encryption-state");
    await writeFile(join(service, "users.sqlite"), "management-state");
    await mkdir(join(service, "downloads"));
    await writeFile(join(service, "downloads", "result.txt"), "retained-download");

    const directory = await separateDefaultProfile(service);

    expect(await readFile(join(directory, "Default", "Cookies"), "utf8")).toBe("login-state");
    expect(await readFile(join(directory, "Local State"), "utf8")).toBe("encryption-state");
    expect(await readFile(join(service, "users.sqlite"), "utf8")).toBe("management-state");
    expect(await readFile(join(directory, "downloads", "result.txt"), "utf8")).toBe(
      "retained-download",
    );
    await expect(readFile(join(directory, "users.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await separateDefaultProfile(service)).toBe(directory);
  });

  it("resumes a partial migration and refuses to overwrite an existing login", async () => {
    const service = await serviceDirectory();
    const directory = await separateDefaultProfile(service);
    await mkdir(join(directory, "Default"));
    await writeFile(join(directory, "Default", "Cookies"), "retained-login");
    await writeFile(join(service, "Local State"), "remaining-state");
    await separateDefaultProfile(service);
    expect(await readFile(join(directory, "Local State"), "utf8")).toBe("remaining-state");

    await mkdir(join(service, "Default"));
    await expect(separateDefaultProfile(service)).rejects.toThrow("Both legacy and separated");
    expect(await readFile(join(directory, "Default", "Cookies"), "utf8")).toBe("retained-login");
  });
});
