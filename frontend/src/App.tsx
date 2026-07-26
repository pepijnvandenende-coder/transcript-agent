import { type FormEvent, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NewWorkflowPage } from "./routes/Upload/NewWorkflowPage";
import { UploadPage } from "./routes/Upload/UploadPage";
import { useCurrentUser } from "./state/currentUser";

// A one-time "who are you?" prompt, gating everything else -- see
// state/currentUser.ts's doc comment: this is a stopgap for real auth, not a
// login screen. Defined locally rather than as its own component/file: it's
// used exactly once, here.
function WhoAreYouForm({
  registering,
  error,
  onSubmit,
}: {
  registering: boolean;
  error: string | null;
  onSubmit: (name: string, email: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name, email);
  }

  return (
    <main>
      <h1>Wie ben je?</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Naam
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          E-mailadres
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <button type="submit" disabled={registering || name.trim().length === 0 || email.trim().length === 0}>
          Doorgaan
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export function App() {
  const { user, registering, error, register } = useCurrentUser();

  if (!user) {
    return <WhoAreYouForm registering={registering} error={error} onSubmit={register} />;
  }

  return (
    <Routes>
      <Route path="/" element={<NewWorkflowPage currentUserId={user.id} />} />
      <Route path="/workflows/:id" element={<UploadPage currentUserId={user.id} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
