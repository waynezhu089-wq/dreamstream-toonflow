import { readPilot, PilotError } from "./service";
import { directorDryRunRequest } from "./directorContract";
import {
  compileDirectorCandidate,
  DirectorValidationError,
} from "./directorCompiler";
// readPilot captures existing project state in its one read transaction. No AI,
// media read, coordinator, reconcile or database writer is imported here.
export async function directorDryRun(input: unknown) {
  const request = directorDryRunRequest.parse(input);
  const state = await readPilot({
    projectId: request.projectId,
    scriptId: request.scriptId,
  });
  try {
    return compileDirectorCandidate(state, request.intent);
  } catch (error) {
    if (error instanceof DirectorValidationError)
      throw new PilotError("DIRECTOR_CANDIDATE_INVALID", error.message, 422);
    throw error;
  }
}
