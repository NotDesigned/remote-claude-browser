import { ApiError } from "./api";
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createUser, currentUser, deleteUser, logout, updateUser } from "./users";

const user = {
  id: "u-one",
  username: "alice",
  role: "user" as const,
  enabled: true,
  createdAt: 123,
};
const response = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  );

describe("frontend user API", () => {
  it("reads current identity", async () => {
    await expect(currentUser(response({ user }))).resolves.toMatchObject({ username: "alice" });
  });

  it("sends creation and changes only to authenticated same-origin APIs", async () => {
    const created = response(user);
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
    await expect(updateUser("u-one", {}, response({ error: "无权管理用户" }, 403))).rejects.toThrow(
      "无权管理用户",
    );
    await expect(currentUser(response(null, 401))).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
    expect(new ApiError(401, "expired")).toBeInstanceOf(Error);
    // Signing out of a sign-in that already expired has nothing left to do.
    await expect(logout(response({ error: "请登录工作台" }, 401))).resolves.toBeUndefined();
    await expect(logout(response({ error: "服务暂不可用" }, 503))).rejects.toThrow("服务暂不可用");
  });
});
