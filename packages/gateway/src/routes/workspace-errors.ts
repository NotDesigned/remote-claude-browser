/**
 * How the workbench's own routes (workspaces, browser profiles, administration) answer errors:
 * `{ error: message, code, ownedSessions }`, where ownedSessions lists the requesting device's
 * workspaces when the route knows the device, so the page can offer to end one. CPA and remote-cc
 * errors keep their `{ error: code, message }`; anything unexpected is logged and answered as the
 * workspace being unavailable.
 */
import type { FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import { UserStoreError } from "../auth/users";
import { CpaError } from "../cpa/store";
import { ProxyCatalogError } from "../egress/catalog";
import {
  codeAnswer,
  HttpError,
  messageAnswer,
  type ErrorAnswer,
  type ErrorStyle,
} from "../http-errors";
import { RemoteCcError } from "../remote-cc/store";
import { ClientSessionError } from "../session/clients";

export interface WorkspaceErrorDeps {
  currentOwner(request: IncomingMessage): string | undefined;
  /** The workspaces of a device, as the session routes describe them. */
  owned(owner: string): unknown[];
  report(message: string, error: unknown): void;
}

export type WorkspaceErrors = ReturnType<typeof createWorkspaceErrors>;

export function createWorkspaceErrors(deps: WorkspaceErrorDeps) {
  const owners = new WeakMap<FastifyRequest, string>();
  const sessionAnswer = (
    error: ClientSessionError | UserStoreError,
    request: FastifyRequest,
  ): ErrorAnswer => {
    const owner = owners.get(request);
    return messageAnswer(error, { ownedSessions: owner ? deps.owned(owner) : [] });
  };
  const answer = (error: unknown, request: FastifyRequest, exitErrors: boolean): ErrorAnswer => {
    if (error instanceof ClientSessionError || error instanceof UserStoreError)
      return sessionAnswer(error, request);
    if (error instanceof CpaError || error instanceof RemoteCcError) return codeAnswer(error);
    // Routes that check an exit node show the catalog's own message.
    if (exitErrors && error instanceof ProxyCatalogError)
      return { status: error.statusCode, body: { error: error.message } };
    deps.report("client session failed", error);
    return {
      status: 503,
      body: { error: "远程会话暂不可用，请稍后重试", code: "CLIENT_UNAVAILABLE" },
    };
  };
  const errors: ErrorStyle = (error, request) => answer(error, request, false);
  const exitErrors: ErrorStyle = (error, request) => answer(error, request, true);
  /** Mailbox errors keep Fastify's answer, as on the user's own mailbox routes. */
  const adminMailboxErrors: ErrorStyle = (error, request) =>
    error instanceof ClientSessionError || error instanceof UserStoreError
      ? sessionAnswer(error, request)
      : undefined;
  return {
    config: { errors },
    exitConfig: { errors: exitErrors },
    adminMailboxConfig: { errors: adminMailboxErrors },
    /**
     * The requesting device's owner key, which later errors of this request list the workspaces
     * of. Without one, the request is refused with exactly `{ error: message }`.
     */
    owner(request: FastifyRequest, status: number, message: string): string {
      const owner = deps.currentOwner(request.raw);
      if (!owner) throw new HttpError(status, { error: message });
      owners.set(request, owner);
      return owner;
    },
  };
}
