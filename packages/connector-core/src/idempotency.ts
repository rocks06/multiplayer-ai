/**
 * Idempotency keys are a protocol discipline, not an agent-runtime detail: a key must be
 * stable across retries of the same step and must never be reused across tasks, or a new
 * task collides with a previous task's committed command receipts.
 */
export const WORKFLOW_STEPS = ["start", "message", "decision", "awaiting", "final", "complete"] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number] | (string & {});

export const taskStepKey = (profile: string, taskId: string, step: WorkflowStep) => `${profile}-${taskId}-${step}-v1`;
