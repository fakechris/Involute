import { useParams } from 'react-router-dom';

export function IssuePage() {
  const { id } = useParams();

  return (
    <main className="placeholder-page">
      <h1>Issue detail</h1>
      <p>Issue route ready for <code>{id}</code>.</p>
    </main>
  );
}
