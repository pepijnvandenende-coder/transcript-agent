import type { AiOutputInputType } from "@prisma/client";
import { prisma } from "../prismaClient";

// Polymorphic lineage join (see prisma/schema.prisma's AiOutputInput model):
// maps an ai_outputs row to the exact versioned input(s) it consumed. First
// populated in Phase 3 by Merger, the first multi-input skill.
export function createAiOutputInputs(
  aiOutputId: string,
  inputs: Array<{ inputType: AiOutputInputType; inputId: string; inputVersion: number }>,
) {
  if (inputs.length === 0) return Promise.resolve({ count: 0 });
  return prisma.aiOutputInput.createMany({
    data: inputs.map((input) => ({
      aiOutputId,
      inputType: input.inputType,
      inputId: input.inputId,
      inputVersion: input.inputVersion,
    })),
  });
}
