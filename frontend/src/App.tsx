import { type FormEvent, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { NewWorkflowPage } from "./routes/Upload/NewWorkflowPage";
import { WorkflowPage } from "./routes/WorkflowPage";
import { useCurrentUser } from "./state/currentUser";

// A one-time "who are you?" prompt, gating everything else -- see
// state/currentUser.ts's doc comment: this is a stopgap for real auth, not a
// login screen. Defined locally rather than as its own component/file: it's
// used exactly once, here.
//
// Phase 16 items 1 and 7: moved onto the shared Layout (centered, same as
// every other short screen -- see routes/Upload/NewWorkflowPage.tsx) instead
// of a bare <main>/<h1>/<form> with no spacing or shared styling. Also shows
// a "session expired" notice instead of nothing when the previously
// remembered user turned out not to exist server-side anymore (see
// state/currentUser.ts's sessionExpired).
function WelkomForm({
  registering,
  error,
  sessionExpired,
  onSubmit,
}: {
  registering: boolean;
  error: string | null;
  sessionExpired: boolean;
  onSubmit: (name: string, email: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name, email);
  }

  return (
    <Layout title="Welkom" centered>
      {sessionExpired && <p role="alert">Je sessie is verlopen. Vul je gegevens opnieuw in om verder te gaan.</p>}
      <p className="page-intro">Vul je naam in om een nieuw gespreksverslag te starten.</p>
      <form onSubmit={handleSubmit} className="section">
        <div className="field">
          <label htmlFor="welkom-name">Naam</label>
          <input id="welkom-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="welkom-email">E-mailadres</label>
          <input
            id="welkom-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="actions actions-centered">
          <button type="submit" className="button-primary" disabled={registering || name.trim().length === 0 || email.trim().length === 0}>
            Doorgaan
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </Layout>
  );
}

export function App() {
  const { user, registering, error, sessionExpired, register } = useCurrentUser();

  if (!user) {
    return <WelkomForm registering={registering} error={error} sessionExpired={sessionExpired} onSubmit={register} />;
  }

  return (
    <Routes>
      <Route path="/" element={<NewWorkflowPage currentUserId={user.id} />} />
      <Route path="/workflows/:id" element={<WorkflowPage currentUserId={user.id} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
