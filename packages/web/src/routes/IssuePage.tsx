import { useParams } from 'react-router-dom';

export function IssuePage() {
  const { id } = useParams();

  return (
    <main className="placeholder-page issue-page">
      <p className="app-shell__eyebrow">Involute</p>
      <h1>Issue detail</h1>
      <p>
        Issue route ready for <code>{id}</code>.
      </p>
    </main>
  );
}
