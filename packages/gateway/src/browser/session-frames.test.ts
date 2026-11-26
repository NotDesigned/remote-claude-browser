import { expect, it } from "vitest";
import { createSessionFrames, MAX_FRAMES_PER_SESSION } from "./account-pool";

it("forgets a page's frames when its main frame commits a new document or its session goes", () => {
  const owners = new Map<string, string>();
  const frames = createSessionFrames(owners);
  frames.navigated("page", { id: "main" }, "s1");
  for (let index = 0; index < 20; index++)
    frames.navigated("page", { id: `child-${index}`, parentId: "main" }, "s1");
  expect(owners.size).toBe(21);

  frames.navigated("page", { id: "main" }, "s1");
  expect([...owners.keys()]).toEqual(["main"]);

  // A frame swapped into its own process is reported there too, and stays while either has it.
  frames.navigated("page", { id: "ad", parentId: "main" }, "s1");
  frames.navigated("oopif", { id: "ad", parentId: "main" }, "s1");
  frames.detached("oopif");
  expect(owners.has("ad")).toBe(true);
  frames.detached("page");
  expect(owners.size).toBe(0);
  expect(frames.sessions).toBe(0);
});

it("keeps only the most recent frames of a page that never navigates", () => {
  const owners = new Map<string, string>();
  const frames = createSessionFrames(owners);
  frames.navigated("page", { id: "main" }, "s1");
  for (let index = 0; index < MAX_FRAMES_PER_SESSION * 3; index++)
    frames.navigated("page", { id: `child-${index}`, parentId: "main" }, "s1");
  expect(owners.size).toBe(MAX_FRAMES_PER_SESSION);
  expect(owners.has(`child-${MAX_FRAMES_PER_SESSION * 3 - 1}`)).toBe(true);
});
