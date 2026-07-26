import { PolicyType } from "@prisma/client";
import { prisma } from "../persistence/prismaClient";

export type PolicyOutcome = "insufficient" | "auto_approved" | "low_confidence" | "mandatory";

export interface PolicyResolution {
  policyType: PolicyType;
  outcome: PolicyOutcome;
}

// Per-skill semantic hooks: some skills' result payload changes routing
// independent of confidence -- e.g. TranscriptQualityChecker's
// result.sufficient short-circuits straight to TRANSCRIPT_INSUFFICIENT
// regardless of how confident the assessment was. Phase 2 locked decision:
// this hook is added now (rather than kept fully generic) as the template
// later skills' own semantic branches (e.g. ConflictDetector's "conflicts
// found") will reuse.
const SEMANTIC_HOOKS: Record<string, (result: Record<string, unknown>) => boolean> = {
  TranscriptQualityChecker: (result) => result.sufficient === false,
};

export async function resolvePolicy(params: {
  skillName: string;
  result: Record<string, unknown>;
  confidence: number;
}): Promise<PolicyResolution> {
  const policy = await prisma.approvalPolicy.findUnique({ where: { skillName: params.skillName } });
  if (!policy) {
    throw new Error(`No approval_policies row configured for skill "${params.skillName}"`);
  }

  const hook = SEMANTIC_HOOKS[params.skillName];
  if (hook?.(params.result)) {
    return { policyType: policy.policyType, outcome: "insufficient" };
  }

  if (policy.policyType === PolicyType.MANDATORY) {
    return { policyType: policy.policyType, outcome: "mandatory" };
  }
  if (policy.policyType === PolicyType.ADVISORY_ONLY) {
    return { policyType: policy.policyType, outcome: "auto_approved" };
  }

  // AUTO_IF_ABOVE
  const threshold = policy.confidenceThreshold ?? 1;
  if (params.confidence >= threshold) {
    return { policyType: policy.policyType, outcome: "auto_approved" };
  }
  return { policyType: policy.policyType, outcome: "low_confidence" };
}

// Phase 3: how many total attempts (initial run + retries) a skill's
// PENDING_HUMAN_CONFIRMATION checkpoint allows before retry/edit-retry are
// disabled and the reviewer must confirm or cancel. Falls back to the
// schema's own default (5) if the skill somehow has no policy row -- in
// practice resolvePolicy() above would already have thrown before a
// checkpoint could exist for an unregistered skill.
export async function getMaxRetries(skillName: string): Promise<number> {
  const policy = await prisma.approvalPolicy.findUnique({ where: { skillName } });
  return policy?.maxRetries ?? 5;
}
