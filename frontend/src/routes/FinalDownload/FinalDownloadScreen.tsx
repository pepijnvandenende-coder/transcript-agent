import { useEffect, useState } from "react";
import {
  ApiError,
  finalReportDownloadUrl,
  getFinalReport,
  getPostProcessingResults,
  type FinalReport,
  type PostProcessingResult,
  type Workflow,
} from "../../api-client/client";
import { translateError } from "../../api-client/translateError";

// Phase 18: known result shapes for the two example follow-up skills --
// rendered specifically for readability. Any other skillKey (a future
// follow-up skill added purely via catalog + prompt) falls back to
// GenericResult below, so the section never breaks, it just renders less
// prettily until the frontend is taught its shape.
interface OpenQuestionsShape {
  open_questions: Array<{ question: string; explanation: string }>;
}

interface CriteriaCoverageShape {
  items: Array<{ criterion: string; status: "covered" | "partially_covered" | "not_covered"; explanation: string }>;
}

function isOpenQuestionsShape(value: unknown): value is OpenQuestionsShape {
  return typeof value === "object" && value !== null && Array.isArray((value as OpenQuestionsShape).open_questions);
}

function isCriteriaCoverageShape(value: unknown): value is CriteriaCoverageShape {
  return typeof value === "object" && value !== null && Array.isArray((value as CriteriaCoverageShape).items);
}

const COVERAGE_LABELS: Record<CriteriaCoverageShape["items"][number]["status"], string> = {
  covered: "Voldoende behandeld",
  partially_covered: "Gedeeltelijk behandeld",
  not_covered: "Niet behandeld",
};

function PostProcessingResultCard({ result }: { result: PostProcessingResult }) {
  if (result.status === "SKIPPED") {
    return (
      <div className="section">
        <h3>{result.displayName}</h3>
        <p className="helper-text">{result.errorMessage ?? "Overgeslagen: benodigde context ontbreekt."}</p>
      </div>
    );
  }

  if (result.status === "FAILED") {
    return (
      <div className="section">
        <h3>{result.displayName}</h3>
        <p role="alert">Deze analyse is niet gelukt.</p>
      </div>
    );
  }

  if (isOpenQuestionsShape(result.resultJson)) {
    return (
      <div className="section">
        <h3>{result.displayName}</h3>
        {result.resultJson.open_questions.length === 0 ? (
          <p className="helper-text">Geen openstaande vragen gevonden.</p>
        ) : (
          // Each question is its own block (number + question, duiding below)
          // rather than a <ul>/<li> bullet list -- a bullet reads as one item
          // among equals, but each question here carries its own context and
          // deserves to stand apart, per the UX fix request.
          <div className="open-questions">
            {result.resultJson.open_questions.map((item, index) => (
              <div className="open-question" key={index}>
                <p className="open-question-title">
                  <span className="open-question-number">{index + 1}.</span> {item.question}
                </p>
                <p className="open-question-context">
                  <span className="open-question-label">Duiding:</span> {item.explanation}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isCriteriaCoverageShape(result.resultJson)) {
    return (
      <div className="section">
        <h3>{result.displayName}</h3>
        <ul>
          {result.resultJson.items.map((item, index) => (
            <li key={index}>
              <strong>{item.criterion}</strong> -- {COVERAGE_LABELS[item.status]}
              <p>{item.explanation}</p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Generic fallback for a follow-up skill the frontend doesn't have a
  // dedicated renderer for yet -- still shows something rather than nothing.
  return (
    <div className="section">
      <h3>{result.displayName}</h3>
      <pre>{JSON.stringify(result.resultJson, null, 2)}</pre>
    </div>
  );
}

// Rendered by WorkflowPage for COMPLETED. Tolerates a momentary 404: reaching
// COMPLETED and writing the final_reports row are two separate steps inside
// jobs/runners/finalRendererRunner.ts (a known, pre-existing ordering race
// flagged back in the Phase 9 plan), not treated as a hard error here.
//
// Phase 16: no cancel control on this screen (either branch) -- COMPLETED is
// a terminal FSM state (workflow/transitions.ts's CANCEL_TRANSITIONS only
// covers non-terminal states), so "Workflow annuleren" here was already a
// dead control that would fail with an FSM error if clicked. The report's
// own title, format, and timestamp aren't shown either (Phase 16 plan item
// 6, "geen overbodige informatie") -- getFinalReport() is still called, but
// only to know whether the file is ready yet; the visible copy is the fixed
// "Uw gespreksverslag is gereed." plus one centered primary download action.
export function FinalDownloadScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [finalReport, setFinalReport] = useState<FinalReport | null>(null);
  const [notReadyYet, setNotReadyYet] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [postProcessingResults, setPostProcessingResults] = useState<PostProcessingResult[]>([]);

  function load() {
    getFinalReport(workflow.id)
      .then((report) => {
        setFinalReport(report);
        setNotReadyYet(false);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotReadyYet(true);
          return;
        }
        setLoadError(translateError(err));
      });
  }

  useEffect(load, [workflow.id]);

  // Phase 18: the generic post-generation follow-up phase's results.
  // Fetched independently of the final report itself -- an empty list just
  // means no follow-up skills produced anything (yet), never a hard error,
  // since the report itself is the important deliverable this screen exists
  // for.
  useEffect(() => {
    getPostProcessingResults(workflow.id)
      .then(setPostProcessingResults)
      .catch(() => setPostProcessingResults([]));
  }, [workflow.id]);

  if (loadError) return <p role="alert">{loadError}</p>;

  if (notReadyYet || !finalReport) {
    return (
      <div className="section">
        <p>Eindrapport nog niet beschikbaar, probeer te vernieuwen.</p>
        <div className="actions">
          <button type="button" className="button-primary" onClick={load}>
            Vernieuwen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="section section-centered">
      <p>Uw gespreksverslag is gereed.</p>
      <div className="actions actions-centered">
        <a href={finalReportDownloadUrl(workflow.id)} download className="button-primary">
          Download gespreksverslag
        </a>
      </div>

      {postProcessingResults.length > 0 && (
        <div className="section">
          <h2>Vervolgonderzoek</h2>
          <p className="helper-text">
            De AI heeft het gespreksverslag automatisch geanalyseerd op mogelijke vervolgstappen.
          </p>
          {postProcessingResults.map((result) => (
            <PostProcessingResultCard key={result.id} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
