import { httpRouter, type FunctionReference } from "convex/server";
import {
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  MachineAuthError,
  authenticateMachineRequest,
  sha256Hex,
  type MachineScope,
} from "./machineAuth";

const http = httpRouter();

http.route({
  path: "/api/v1/auth/whoami",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    try {
      const identity = await authenticateMachineRequest(request, null);
      return jsonResponse(
        { ok: true, actor: identity.keyId, scopes: identity.scopes },
        200,
      );
    } catch (error) {
      if (error instanceof MachineAuthError) {
        return jsonResponse({ ok: false, error: error.message }, error.status);
      }
      console.error("[machine-api] auth check failed", error);
      return jsonResponse(
        { ok: false, error: "Machine authentication is unavailable" },
        500,
      );
    }
  }),
});

type InternalMutationReference = FunctionReference<
  "mutation",
  "internal",
  Record<string, Value>,
  unknown
>;

type MachineRouteOptions = {
  path: string;
  operation: string;
  scope: MachineScope;
  mutation: InternalMutationReference;
  idempotentSubmission?: boolean;
};

class MachineRequestError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = "MachineRequestError";
    this.status = status;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeArguments(bodyText: string): Record<string, Value> {
  const encoded = JSON.parse(bodyText) as JSONValue;
  const decoded = jsonToConvex(encoded);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new MachineRequestError("Request body must encode an object", 400);
  }
  return decoded as Record<string, Value>;
}

function submissionKey(request: Request, machineId: string): string {
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (
    idempotencyKey === null ||
    !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)
  ) {
    throw new MachineRequestError(
      "Idempotency-Key must contain 8 to 200 URL-safe characters",
      400,
    );
  }
  return `${machineId}:${idempotencyKey}`;
}

function registerMachineRoute(options: MachineRouteOptions): void {
  http.route({
    path: options.path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const identity = await authenticateMachineRequest(
          request,
          options.scope,
        );
        const bodyText = await request.text();
        const args = decodeArguments(bodyText);

        if (options.idempotentSubmission) {
          args.submission_id = submissionKey(request, identity.keyId);
          args.submission_fingerprint = await sha256Hex(bodyText);
        }

        const result = await ctx.runMutation(options.mutation, args);
        console.info(
          `[machine-api] ${identity.keyId} completed ${options.operation}`,
        );
        return jsonResponse(
          {
            ok: true,
            actor: identity.keyId,
            value: convexToJson((result ?? null) as Value),
          },
          200,
        );
      } catch (error) {
        if (error instanceof MachineAuthError) {
          console.warn(
            `[machine-api] rejected ${options.operation}: ${error.message}`,
          );
          return jsonResponse(
            { ok: false, error: error.message },
            error.status,
          );
        }
        if (error instanceof MachineRequestError) {
          console.warn(
            `[machine-api] invalid ${options.operation}: ${error.message}`,
          );
          return jsonResponse(
            { ok: false, error: error.message },
            error.status,
          );
        }

        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("Idempotency conflict") ? 409 : 500;
        console.error(`[machine-api] ${options.operation} failed`, error);
        return jsonResponse({ ok: false, error: message }, status);
      }
    }),
  });
}

registerMachineRoute({
  path: "/api/v1/eval-sessions/submit",
  operation: "eval-sessions.submit",
  scope: "ingest",
  mutation: internal.evalSessions.submit,
  idempotentSubmission: true,
});
registerMachineRoute({
  path: "/api/v1/eval-sessions/add-rounds",
  operation: "eval-sessions.add-rounds",
  scope: "ingest",
  mutation: internal.evalSessions.addRounds,
});
registerMachineRoute({
  path: "/api/v1/datasets/register",
  operation: "datasets.register",
  scope: "ingest",
  mutation: internal.datasets.register,
});
registerMachineRoute({
  path: "/api/v1/datasets/update-stats",
  operation: "datasets.update-stats",
  scope: "ingest",
  mutation: internal.datasets.updateStats,
});
registerMachineRoute({
  path: "/api/v1/policies/register",
  operation: "policies.register",
  scope: "ingest",
  mutation: internal.policies.register,
});

registerMachineRoute({
  path: "/api/v1/curation/set-excluded",
  operation: "curation.set-excluded",
  scope: "curate",
  mutation: internal.evalSessions.setExcluded,
});
registerMachineRoute({
  path: "/api/v1/curation/update-notes",
  operation: "curation.update-notes",
  scope: "curate",
  mutation: internal.evalSessions.updateNotes,
});
registerMachineRoute({
  path: "/api/v1/curation/update-dataset-task",
  operation: "curation.update-dataset-task",
  scope: "curate",
  mutation: internal.datasets.updateTask,
});
registerMachineRoute({
  path: "/api/v1/curation/update-policy-environment",
  operation: "curation.update-policy-environment",
  scope: "curate",
  mutation: internal.policies.updateEnvironment,
});
registerMachineRoute({
  path: "/api/v1/curation/set-policy-links",
  operation: "curation.set-policy-links",
  scope: "curate",
  mutation: internal.policies.setLinks,
});

registerMachineRoute({
  path: "/api/v1/admin/delete-session",
  operation: "admin.delete-session",
  scope: "admin",
  mutation: internal.evalSessions.deleteSession,
});
registerMachineRoute({
  path: "/api/v1/admin/remove-policy-from-session",
  operation: "admin.remove-policy-from-session",
  scope: "admin",
  mutation: internal.evalSessions.removePolicyFromSession,
});
registerMachineRoute({
  path: "/api/v1/admin/delete-policy",
  operation: "admin.delete-policy",
  scope: "admin",
  mutation: internal.policies.deletePolicy,
});
registerMachineRoute({
  path: "/api/v1/admin/delete-dataset",
  operation: "admin.delete-dataset",
  scope: "admin",
  mutation: internal.datasets.deleteByRepo,
});
registerMachineRoute({
  path: "/api/v1/admin/recompute-elo",
  operation: "admin.recompute-elo",
  scope: "admin",
  mutation: internal.evalSessions.recomputeAllRatings,
});

export default http;
