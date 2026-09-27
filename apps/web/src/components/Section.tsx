import type { ReactNode } from 'react';

export function Section(props: {
  step: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={`step-${props.step}`}>
      <div className="card-head">
        <h2 id={`step-${props.step}`}>
          <span className="step">{props.step}</span>
          {props.title}
        </h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="note note-error" role="alert">
      <span aria-hidden="true">⚠</span> {message}
    </p>
  );
}
