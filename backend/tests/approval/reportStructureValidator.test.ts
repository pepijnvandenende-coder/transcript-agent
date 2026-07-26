import { describe, expect, it } from "vitest";
import { validateRequiredSections } from "../../src/approval/reportStructureValidator";

// Pure logic -- no database needed. `optionalSections` (the source prompts'
// own "indien van toepassing" headings) are never enforced here, matching
// their conditional framing.
describe("reportStructureValidator.validateRequiredSections", () => {
  const policy = { requiredSections: ["Samenvatting", "Notulen"] };

  it("passes when every required heading is present", () => {
    const sections = [
      { heading: "Samenvatting", content: "x" },
      { heading: "Notulen", content: "y" },
    ];
    expect(validateRequiredSections(sections, policy).valid).toBe(true);
  });

  it("passes when optional headings are also present, in any order", () => {
    const sections = [
      { heading: "Notulen", content: "y" },
      { heading: "Acties en vervolgstappen", content: "z" },
      { heading: "Samenvatting", content: "x" },
    ];
    expect(validateRequiredSections(sections, policy).valid).toBe(true);
  });

  it("fails when a required heading is missing", () => {
    const sections = [{ heading: "Samenvatting", content: "x" }];
    const result = validateRequiredSections(sections, policy);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("fails when no sections are present at all", () => {
    const result = validateRequiredSections([], policy);
    expect(result.valid).toBe(false);
  });

  it("does not require optionalSections to be present", () => {
    // Absence of "Acties en vervolgstappen" / "Openstaande vragen /
    // onduidelijkheden" / "Bijlagen/verwijzingen" must never fail validation.
    const sections = [
      { heading: "Samenvatting", content: "x" },
      { heading: "Notulen", content: "y" },
    ];
    expect(validateRequiredSections(sections, policy).valid).toBe(true);
  });
});
