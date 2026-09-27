import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type UploadResult } from '../api';
import { fmt } from '../format';
import { ErrorNote, Section } from './Section';

interface HeaderErrorDetails {
  missing?: string[];
  unexpected?: string[];
  duplicated?: string[];
}

export function UploadPanel({ onJobStarted }: { onJobStarted: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  // Changing the key remounts the file input, clearing the browser's chosen-file label.
  const [inputKey, setInputKey] = useState(0);

  const upload = useMutation({
    mutationFn: (f: File) => api.upload(f),
    onSuccess: setResult,
    onMutate: () => setResult(null),
  });

  const start = useMutation({
    mutationFn: (uploadId: string) => api.startJob(uploadId),
    onSuccess: ({ job }) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setResult(null);
      setFile(null);
      setInputKey((k) => k + 1);
      onJobStarted(job.id);
    },
  });

  const headerError =
    upload.error instanceof ApiError && upload.error.code === 'INVALID_CSV_HEADER'
      ? (upload.error.details as HeaderErrorDetails)
      : null;

  return (
    <Section step={1} title="Upload store list">
      <p className="hint">
        CSV with columns <code>store_id, store_name, address, city, state, country</code>.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate(file);
        }}
      >
        <input
          key={inputKey}
          type="file"
          accept=".csv,text/csv"
          aria-label="Store list CSV"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? 'Checking…' : 'Upload'}
        </button>
      </form>

      {upload.error && !headerError && <ErrorNote error={upload.error} />}
      {headerError && (
        <div className="note note-error" role="alert">
          <strong>The file's header doesn't match.</strong> Nothing was stored.
          <ul>
            {!!headerError.missing?.length && <li>Missing: {headerError.missing.join(', ')}</li>}
            {!!headerError.unexpected?.length && (
              <li>Unexpected: {headerError.unexpected.join(', ')}</li>
            )}
            {!!headerError.duplicated?.length && (
              <li>Duplicated: {headerError.duplicated.join(', ')}</li>
            )}
          </ul>
        </div>
      )}

      {result && (
        <div className="upload-result">
          <p>
            <strong>{result.upload.filename}</strong>: {fmt(result.acceptedRows)} stores ready
            {result.rejectedRows > 0 && (
              <>
                , <span className="text-warn">{fmt(result.rejectedRows)} rows skipped</span>
              </>
            )}
            .
          </p>
          {result.errors.length > 0 && (
            <details>
              <summary>
                Skipped rows{result.errorsTruncated ? ` (first ${result.errors.length})` : ''}
              </summary>
              <table className="table compact">
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">store_id</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e) => (
                    <tr key={e.line}>
                      <td className="num">{e.line}</td>
                      <td>{e.storeId ?? '–'}</td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <button
            className="primary"
            onClick={() => start.mutate(result.upload.id)}
            disabled={start.isPending}
          >
            {start.isPending ? 'Starting…' : `Enrich ${fmt(result.acceptedRows)} stores`}
          </button>
          <ErrorNote error={start.error} />
        </div>
      )}
    </Section>
  );
}
