// Temporary front-end identities only: never allocates a workspace or starts Chrome.
// Run with: bash scripts/limited-run.sh node scripts/users-production-probe.mjs
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readProbeCredentials } from "./probe-session.mjs";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");

if (!process.env.MIRROR_ORIGIN)
  throw new Error("Set MIRROR_ORIGIN to the service's public address");
const origin = new URL(process.env.MIRROR_ORIGIN).origin;
// The administrator this probe signs in as; an existing database keeps the name it was created with.
const administrator = process.env.MIRROR_ADMIN_USERNAME ?? "admin";
const requestOrigin = process.env.MIRROR_PUBLIC_ORIGIN || origin;
const logins = new Set();
const originals = new Set();
const originalProfiles = new Set();
const temporary = Array.from({ length: 2 }, () => ({
  username: `qa-${randomBytes(12).toString("hex")}`,
  password: randomBytes(32).toString("base64url"),
  requested: false,
  id: undefined,
}));
const result = {
  passed: false,
  allocatedNoWorkspaces: true,
  cleanupComplete: false,
  checks: {},
  counts: {
    createdUsers: 0,
    deletedUsers: 0,
    loginTokens: 0,
    loggedOutTokens: 0,
    cleanupFailures: 0,
  },
};
let adminCookie;
let failure;

class ProbeFailure extends Error {}
function check(name, condition) {
  result.checks[name] = Boolean(condition);
  if (!condition) throw new ProbeFailure(name);
}
function validUserId(value) {
  return typeof value === "string" && /^user-[0-9a-f-]+$/.test(value);
}
async function request(cookie, path, method = "GET", body) {
  return fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    headers: {
      Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
}
async function expectStatus(name, cookie, path, method, body, expected) {
  const response = await request(cookie, path, method, body);
  await response.arrayBuffer();
  check(name, response.status === expected);
}
async function json(name, cookie, path, method = "GET", body, expected = 200) {
  const response = await request(cookie, path, method, body);
  if (response.status !== expected) {
    await response.arrayBuffer();
    check(name, false);
  }
  const value = await response.json();
  check(name, true);
  return value;
}
async function login(credentials) {
  const response = await fetch(new URL("/gate", origin), {
    method: "POST",
    redirect: "manual",
    headers: { Origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(credentials),
    signal: AbortSignal.timeout(20000),
  });
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((header) => header.split(";", 1)[0]).join("; ");
  // Remember every issued token immediately, including one from an unexpected response.
  if (cookie) logins.add(cookie);
  result.counts.loginTokens = logins.size;
  await response.arrayBuffer();
  check("usernamePasswordLogin", response.status === 303 && cookies.length >= 2);
  check(
    "secureLoginCookies",
    cookies.every(
      (header) =>
        /;\s*Secure(?:;|$)/i.test(header) &&
        /;\s*HttpOnly(?:;|$)/i.test(header) &&
        /;\s*SameSite=Lax(?:;|$)/i.test(header),
    ),
  );
  return cookie;
}
async function accounts(cookie, name) {
  const value = await json(name, cookie, "/api/accounts");
  check(`${name}Shape`, Array.isArray(value.accounts));
  return value.accounts;
}

try {
  const credentials = await readProbeCredentials();
  check("expectedAdministratorCredential", credentials.username === administrator);
  adminCookie = await login(credentials);
  const me = await json("administratorIdentity", adminCookie, "/api/me");
  check(
    "administratorRole",
    me.user?.username === administrator && me.user?.role === "admin" && me.user?.enabled === true,
  );
  const baseline = await json("originalUsersRead", adminCookie, "/api/users");
  check("originalUsersShape", Array.isArray(baseline.users));
  for (const user of baseline.users) originals.add(user.id);
  for (const profile of await accounts(adminCookie, "originalProfilesRead"))
    originalProfiles.add(profile.id);
  check("originalProfilesPresent", originalProfiles.size > 0);

  for (const candidate of temporary) {
    // Register the exact random name before POST: cleanup can recover a committed creation
    // even if its response is lost. No pre-existing ID or account configuration is mutated.
    candidate.requested = true;
    const user = await json(
      "temporaryUserCreated",
      adminCookie,
      "/api/users",
      "POST",
      {
        username: candidate.username,
        password: candidate.password,
        role: "user",
      },
      201,
    );
    check(
      "temporaryUserIdentity",
      validUserId(user.id) &&
        user.username === candidate.username &&
        user.role === "user" &&
        user.enabled === true &&
        !originals.has(user.id),
    );
    candidate.id = user.id;
    result.counts.createdUsers++;
    candidate.cookie = await login({ username: candidate.username, password: candidate.password });
    const profiles = await accounts(candidate.cookie, "temporaryProfilesRead");
    check(
      "singleIndependentProfile",
      profiles.length === 1 &&
        typeof profiles[0]?.id === "string" &&
        /^p-[0-9a-f]{10}$/.test(profiles[0].id) &&
        !originalProfiles.has(profiles[0].id),
    );
    check(
      "temporaryBrowserRemainsStopped",
      profiles[0].running === false && profiles[0].sessions === 0,
    );
    candidate.profile = profiles[0].id;
  }
  const [first, second] = temporary;
  check("usersHaveDifferentProfiles", first.profile !== second.profile && first.id !== second.id);
  for (const [index, candidate] of temporary.entries()) {
    const other = temporary[1 - index];
    const key = index === 0 ? "first" : "second";
    await expectStatus(
      `${key}AdminListDenied`,
      candidate.cookie,
      "/api/users",
      "GET",
      undefined,
      403,
    );
    await expectStatus(
      `${key}ForeignRenameDenied`,
      candidate.cookie,
      `/api/accounts/${encodeURIComponent(other.profile)}`,
      "PATCH",
      { name: "QA denied rename" },
      403,
    );
    await expectStatus(
      `${key}ForeignDeleteDenied`,
      candidate.cookie,
      `/api/accounts/${encodeURIComponent(other.profile)}`,
      "DELETE",
      undefined,
      403,
    );
    // No real SID is allocated. This verifies the switch entry point cannot grant a
    // foreign browser; live-session switching is covered by the local Chrome smoke.
    const unallocated = `qa-unallocated-${randomBytes(12).toString("hex")}`;
    await expectStatus(
      `${key}UnallocatedForeignSwitchDenied`,
      candidate.cookie,
      `/api/client/session/${unallocated}/account`,
      "POST",
      { account: other.profile },
      403,
    );
    const renamed = await json(
      `${key}OwnRenameAllowed`,
      candidate.cookie,
      `/api/accounts/${encodeURIComponent(candidate.profile)}`,
      "PATCH",
      { name: "QA temporary browser" },
    );
    check(
      `${key}OwnRenameIdentity`,
      renamed.id === candidate.profile && renamed.name === "QA temporary browser",
    );
    const unchanged = await accounts(candidate.cookie, `${key}ProfilesRemainPrivate`);
    check(
      `${key}OnlyOwnStoppedBrowser`,
      unchanged.length === 1 &&
        unchanged[0].id === candidate.profile &&
        unchanged[0].running === false &&
        unchanged[0].sessions === 0,
    );
  }
  const replacement = randomBytes(32).toString("base64url");
  await json(
    "firstPasswordReset",
    adminCookie,
    `/api/users/${encodeURIComponent(first.id)}`,
    "PATCH",
    { password: replacement },
  );
  await expectStatus("firstOldTokenRevoked", first.cookie, "/api/me", "GET", undefined, 401);
  const replacementCookie = await login({ username: first.username, password: replacement });
  const replacementUser = await json("firstNewPasswordLogin", replacementCookie, "/api/me");
  check("firstIdentitySurvivesReset", replacementUser.user?.id === first.id);
  await json(
    "secondDisabled",
    adminCookie,
    `/api/users/${encodeURIComponent(second.id)}`,
    "PATCH",
    { enabled: false },
  );
  await expectStatus("secondOldTokenRevoked", second.cookie, "/api/me", "GET", undefined, 401);
  const after = await accounts(adminCookie, "originalProfilesAfterProbe");
  check(
    "originalProfilesUnchanged",
    after.length === originalProfiles.size &&
      after.every((profile) => originalProfiles.has(profile.id)),
  );
} catch (error) {
  // Never emit a response, identifier, credential, cookie, or arbitrary exception message.
  failure = error instanceof ProbeFailure ? error.message : "requestOrCredentialFailure";
} finally {
  let visibleUsers;
  if (adminCookie && temporary.some((candidate) => candidate.requested)) {
    try {
      const response = await request(adminCookie, "/api/users");
      if (response.status !== 200) throw new ProbeFailure("cleanupUserListDenied");
      visibleUsers = (await response.json()).users;
      if (!Array.isArray(visibleUsers)) throw new ProbeFailure("cleanupUserListInvalid");
    } catch {
      result.counts.cleanupFailures++;
    }
    for (const candidate of temporary.filter((candidate) => candidate.requested)) {
      // Exact random-name matching plus the baseline exclusion prevents deletion of an
      // original user, even after a lost create response or malformed server response.
      const discovered = visibleUsers?.find(
        (user) =>
          user.username === candidate.username && validUserId(user.id) && !originals.has(user.id),
      );
      const id = discovered?.id ?? candidate.id;
      if (!validUserId(id) || originals.has(id)) {
        if (visibleUsers === undefined) result.counts.cleanupFailures++;
        continue;
      }
      try {
        const response = await request(
          adminCookie,
          `/api/users/${encodeURIComponent(id)}`,
          "DELETE",
        );
        await response.arrayBuffer();
        if (![204, 404].includes(response.status))
          throw new ProbeFailure("temporaryUserDeleteFailed");
        if (response.status === 204) result.counts.deletedUsers++;
      } catch {
        result.counts.cleanupFailures++;
      }
    }
    try {
      const response = await request(adminCookie, "/api/users");
      if (response.status !== 200) throw new ProbeFailure("cleanupVerificationDenied");
      const remaining = (await response.json()).users;
      if (
        !Array.isArray(remaining) ||
        remaining.some((user) =>
          temporary.some(
            (candidate) => candidate.requested && user.username === candidate.username,
          ),
        )
      )
        throw new ProbeFailure("temporaryUsersRemain");
    } catch {
      result.counts.cleanupFailures++;
    }
  }
  // Each login used a fresh device cookie, so logout cannot release a pre-existing device's
  // workspace. Revoked and disabled tokens must also receive the public logout response.
  for (const cookie of logins) {
    try {
      const response = await request(cookie, "/logout", "POST");
      await response.arrayBuffer();
      if (response.status !== 204) throw new ProbeFailure("probeLogoutFailed");
      result.counts.loggedOutTokens++;
    } catch {
      result.counts.cleanupFailures++;
    }
  }
  result.cleanupComplete = result.counts.cleanupFailures === 0;
  result.passed =
    failure === undefined &&
    result.cleanupComplete &&
    result.counts.createdUsers === 2 &&
    result.counts.deletedUsers === 2;
  await mkdir("artifacts", { recursive: true });
  const artifact = "artifacts/users-production.json";
  await writeFile(artifact, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await chmod(artifact, 0o600);
  console.log(JSON.stringify(result));
  if (!result.passed) {
    console.error(`Users production probe failed: ${failure ?? "cleanupIncomplete"}`);
    process.exitCode = 1;
  }
}
