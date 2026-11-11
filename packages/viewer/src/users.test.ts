// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createUser,
  currentUser,
  deleteUser,
  listUsers,
  logout,
  updateUser,
  UserApiError,
} from "./users";

const user = {
  id: "u-one",
  username: "alice",
  role: "user" as const,
  enabled: true,
  createdAt: 123,
};
const response = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(
    async () => new Response(status === 204 ? null : JSON.stringify(body), { status }),
  );

describe("frontend user API", () => {
  it("reads current identity and validates the managed user list", async () => {
    await expect(currentUser(response({ user }))).resolves.toMatchObject({ username: "alice" });
    await expect(listUsers(response({ users: [user] }))).resolves.toEqual([user]);
    await expect(listUsers(response({ users: [{ ...user, role: "owner" }] }))).rejects.toThrow(
      "无法读取",
    );
    await expect(currentUser(response({ user: null }))).rejects.toThrow("无法读取");
  });

  it("sends creation and changes only to authenticated same-origin APIs", async () => {
    const created = response({ user });
    await createUser({ username: "alice", password: "temporary-password", role: "user" }, created);
    expect(created).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "temporary-password", role: "user" }),
      }),
    );
    const changed = response(user);
    await updateUser("id/with spaces", { enabled: false }, changed);
    expect(changed).toHaveBeenCalledWith(
      "/api/users/id%2Fwith%20spaces",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    const reset = response(user);
    await updateUser("u-one", { password: "new-password" }, reset);
    expect(JSON.parse(reset.mock.calls[0]![1]!.body as string)).toEqual({
      password: "new-password",
    });
  });

  it("accepts empty delete/logout responses and preserves authorization failures", async () => {
    const removed = response(null, 204);
    await deleteUser("u-one", removed);
    expect(removed).toHaveBeenCalledWith(
      "/api/users/u-one",
      expect.objectContaining({ method: "DELETE" }),
    );
    const signedOut = response(null, 204);
    await logout(signedOut);
    expect(signedOut).toHaveBeenCalledWith("/logout", expect.objectContaining({ method: "POST" }));
    await expect(
      deleteUser("u-one", response({ error: "最后一个管理员不能删除" }, 409)),
    ).rejects.toThrow("最后一个管理员不能删除");
    await expect(listUsers(response(null, 403))).rejects.toThrow("没有管理用户的权限");
    await expect(currentUser(response(null, 401))).rejects.toMatchObject({
      name: "UserApiError",
      status: 401,
    });
    expect(new UserApiError(401, "expired")).toBeInstanceOf(Error);
  });
});
