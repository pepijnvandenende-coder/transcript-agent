import { PolicyType } from "@prisma/client";
import { prisma } from "../persistence/prismaClient";

// "requires_review" (Phase 4) is distinct from "insufficient" (Phase 2):
// both are semantic-hook-triggered short-circuits that bypass confidence
// scoring entirely, but "insufficient" routes to an auto-approved, no-human-
// needed state (e.g. TRANSCRIPT_INSUFFICIENT), while "requires_review" routes
// to a MANDATORY human checkpoint (e.g. CONFLICTS_PENDING_REVIEW) -- see
// approval/gateway.ts's handleSkillOutput(), which must NOT auto-approve the
// latter.
export type PolicyOutcome = "insufficient" | "auto_approved" | "low_confidence" | "mandatory" | "requires_review";

export interface PolicyResolution {
  policyType: PolicyType;
  outcome: PolicyOutcome;
}

// Per-skill semantic hooks: some skills' result payload changes routing
// independent of confidence -- e.g. TranscriptQualityChecker's
// result.sufficient short-circuits straight to TRANSCRIPT_INSUFFICIENT
// regardless of how confident the assessment was, and (Phase 4)
// ConflictDetector's result.conflicts short-circuits straight to
// CONFLICTS_PENDING_REVIEW regardless of confidence. Each hook returns the
// specific outcome it triggers (or null to fall through to normal
// confidence-based scoring) rather than a bare boolean, since different
// skills' semantic branches can mean different things (auto vs. mandatory).
const SEMANTIC_HOOKS: Record<string, (result: Record<string, unknown>) => PolicyOutcome | null> = {
  TranscriptQualityChecker: (result) => (result.sufficient === false ? "insufficient" : null),
  ConflictDetector: (result) => {
    const conflicts = result.conflicts;
    return Array.isArray(conflicts) && conflicts.length > 0 ? "requires_review" : null;
  },
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

  const hookOutcome = SEMANTIC_HOOKS[params.skillName]?.(params.result);
  if (hookOutcome) {
    return { policyType: policy.policyType, outcome: hookOutcome };
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
