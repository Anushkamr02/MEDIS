import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, MessageCircle, MoreHorizontal, Send, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { aiRequest } from '../lib/aiClient';
import { cn } from '../lib/utils';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Textarea,
} from './ui';
import { AIBadge } from './medis';

const SUGGESTIONS = [
  'Summarize my health records',
  'Explain my latest results',
  'What are my current medicines for?',
  'When is my next appointment?',
  'How do I share my ID with a doctor?',
];
const MAX_LENGTH = 1000;

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Renders **bold** and "- " bullet lines from the assistant's reply
function Rich({ text }) {
  return (
    <div className="space-y-1">
      {text.split('\n').map((line, i) => {
        const parts = line
          .replace(/^- /, '')
          .split(/(\*\*[^*]+\*\*)/)
          .map((s, j) => (s.startsWith('**') && s.endsWith('**') ? <b key={j}>{s.slice(2, -2)}</b> : s));
        return line.startsWith('- ') ? (
          <p key={i} className="flex gap-1.5">
            <span>•</span>
            <span>{parts}</span>
          </p>
        ) : (
          <p key={i}>{parts}</p>
        );
      })}
    </div>
  );
}

/**
 * "Ask MEDIS" patient chatbot in a side drawer (opened from the patient
 * header or the floating button). Answers come from the AI service
 * (/ai/chat), which only sees what this patient can see on their
 * dashboard. History is kept in chat_messages.
 */
export default function PatientChat({ open, onOpenChange }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [contactHint, setContactHint] = useState(false);
  const [about, setAbout] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    if (!open || loaded || !user?.id) return;
    supabase
      .from('chat_messages')
      .select('*')
      .eq('patient_id', user.id)
      .order('created_at', { ascending: true })
      .limit(100)
      .then(({ data, error: loadError }) => {
        if (loadError) setError(loadError.message);
        setMessages(data ?? []);
        setLoaded(true);
      });
  }, [open, loaded, user?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending, open]);

  async function send(text) {
    const message = text.trim();
    if (!message || sending) return;
    setError('');
    setContactHint(false);
    setInput('');
    setSending(true);
    // Shown right away; replaced by the saved row when the reply arrives
    const pending = { id: 'pending', role: 'user', content: message, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, pending]);

    const { data, error: chatError } = await aiRequest('/ai/chat', { body: { message } });
    setSending(false);
    if (chatError) {
      setMessages((prev) => prev.filter((m) => m.id !== 'pending'));
      setInput(message);
      setError(chatError);
      return;
    }
    setMessages((prev) => [...prev.filter((m) => m.id !== 'pending'), data.question, data.reply]);
    setContactHint(data.suggest_contact_doctor);
  }

  async function clearConversation() {
    const { error: deleteError } = await supabase.from('chat_messages').delete().eq('patient_id', user.id);
    if (deleteError) setError(deleteError.message);
    else setMessages([]);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md [&>button]:hidden">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <SheetTitle className="flex items-center gap-2 text-base">
              Ask MEDIS <AIBadge />
            </SheetTitle>
            <SheetDescription className="text-xs">Answers from your available health records</SheetDescription>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Chat options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={messages.length === 0} onClick={clearConversation}>
                Clear conversation
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAbout((a) => !a)}>About this assistant</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        {about && (
          <p className="border-b bg-muted px-4 py-2 text-xs text-muted-foreground">
            Ask MEDIS uses your available profile, shared visits, medicines, recent prescriptions, appointments and shared
            heart check to answer questions with Google Gemini. Uploaded files are listed by name and status; their contents
            are not read here. It does not diagnose or change treatment.
          </p>
        )}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
          {!loaded && <p className="text-sm text-muted-foreground">Loading conversation...</p>}
          {loaded && messages.length === 0 && (
            <div className="space-y-3">
              <p className="rounded-xl bg-muted p-3 text-sm">
                Ask me to summarize your health records or explain your shared results, medicines and appointments.
                I'll tell you when information is missing from the records I can see.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    disabled={sending}
                    onClick={() => send(s)}
                    className="rounded-full border border-primary/30 bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-auto max-w-[85%]">
                <div className="rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{m.content}</div>
                <p className="mt-0.5 text-right text-[10px] text-muted-foreground">{timeOf(m.created_at)}</p>
              </div>
            ) : (
              <div key={m.id} className="max-w-[90%] space-y-2">
                {m.is_emergency && (
                  <div role="alert" className="rounded-xl border-2 border-destructive bg-destructive-soft p-3 text-sm text-destructive">
                    <p className="flex items-center gap-2 font-semibold">
                      <AlertTriangle className="h-4 w-4" />
                      Possible emergency
                    </p>
                    <p className="mt-1">
                      Your message mentions a symptom that may need urgent care. Call 108 / 112 or go to the nearest
                      emergency department now.
                    </p>
                    <p className="mt-2 font-bold">Emergency numbers: 112 or 108</p>
                  </div>
                )}
                <div className="rounded-2xl rounded-bl-sm border bg-card px-3 py-2 text-sm">
                  <Rich text={m.content} />
                  {m.sources?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.sources.map((s) => (
                        <span key={s} className="rounded-md border bg-muted px-2 py-0.5 font-mono text-[10px]">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 border-t pt-1.5 text-[10px] text-muted-foreground">
                    For information only, not medical advice. Ask your doctor about any decision.
                  </p>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{timeOf(m.created_at)}</p>
              </div>
            )
          )}
          {sending && (
            <div className="flex w-16 gap-1 rounded-2xl border bg-card px-3 py-3" aria-label="Assistant is typing">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-dot" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          )}
          {contactHint && !sending && (
            <p className="rounded-xl border border-info/30 bg-info-soft p-3 text-sm text-info">
              This needs your doctor's judgement. Raise it at your next appointment, or contact your doctor's hospital.
            </p>
          )}
          <div ref={endRef} />
        </div>
        {error && <p className="bg-destructive-soft px-4 py-2 text-center text-xs text-destructive">{error}</p>}
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="flex-1">
            <Textarea
              value={input}
              maxLength={MAX_LENGTH}
              rows={2}
              placeholder="Type your question…"
              className={cn('min-h-0 resize-none')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              aria-label="Your question"
            />
            <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
              {input.length}/{MAX_LENGTH}
            </p>
          </div>
          <Button type="submit" size="icon" disabled={!input.trim() || sending} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
