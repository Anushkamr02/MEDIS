import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { openStoredDocument } from '../lib/patientAccess';
import { toast } from 'sonner';
import { Button } from './ui';
import { ErrorState, Spinner } from './medis';

export default function SecureDocumentPreview({ doc }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: signError } = await supabase.storage.from('medical-reports').createSignedUrl(doc.file_url, 300);
      if (signError || !data?.signedUrl) throw signError || new Error('Could not open this document.');
      setUrl(data.signedUrl);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [doc.file_url]);
  useEffect(() => { load(); }, [load]);
  const isPdf = /\.pdf$/i.test(doc.file_name || doc.file_url);
  const isImage = /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(doc.file_name || doc.file_url);
  return <div className="min-w-0 space-y-2">
    {loading ? <Spinner text="Opening secure preview…" /> : error ? <ErrorState text={error} onRetry={load} /> : url && <>
      {isPdf ? <iframe title={`Preview of ${doc.file_name}`} src={url} className="h-[55dvh] min-h-64 w-full rounded-lg border bg-muted" />
        : isImage ? <img alt={`Report: ${doc.file_name}`} src={url} className="max-h-[60dvh] w-full rounded-lg border object-contain" onError={() => setError('This file cannot be previewed here. Open the original document below.')} />
          : <p className="text-sm text-muted-foreground">Open this file in a compatible viewer using the button below.</p>}
    </>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={async () => { const { error: openError } = await openStoredDocument(doc.file_url); if (openError) toast.error(openError); }}>Open original document</Button>
      <Button size="sm" variant="ghost" onClick={load} disabled={loading}>Refresh preview</Button></div>
    <p className="text-xs text-muted-foreground">Private preview link expires after five minutes.</p>
  </div>;
}
