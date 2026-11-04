import { ShieldCheck } from 'lucide-react';
import { EcgLine, Logo } from './medis';

/** Shared login design; registration grows naturally without clipping. */
export default function AuthLayout({ children, badge = 'Secure sign-in' }) {
  return (
    <div className="auth-layout grid min-h-svh bg-card md:grid-cols-2">
      <aside className="hidden min-w-0 flex-col justify-between gap-12 bg-primary-soft px-8 py-10 md:flex xl:px-14 xl:py-12">
        <Logo className="text-2xl tracking-normal" />
        <div className="max-w-lg py-6">
          <h1 className="auth-hero-title font-display font-bold leading-tight tracking-normal">
            One patient ID.
            <br />
            Every hospital.
          </h1>
          <p className="auth-hero-subtitle mt-4 font-semibold leading-snug text-primary">
            Your heart-health history,
            <br className="hidden xl:block" /> all in one place.
          </p>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Your visits, prescriptions and reports stay connected across hospitals.
          </p>
          <EcgLine className="mt-8 h-14 text-primary" />
        </div>
        <p className="text-xs text-muted-foreground">Your health. Your record.</p>
      </aside>
      <main className="relative flex min-w-0 flex-col overflow-hidden px-6 py-8 sm:px-10 md:justify-center xl:px-16">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-primary-soft/50 via-background to-secondary/80" />
          <div className="absolute -right-28 -top-28 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />
          <div className="absolute -bottom-36 -left-28 h-80 w-80 rounded-full bg-ai-soft/40 blur-3xl" />
          <EcgLine className="absolute inset-x-0 bottom-10 h-12 text-primary/8" />
        </div>
        <Logo className="relative z-10 mb-14 text-2xl tracking-normal md:hidden" />
        <div className="relative z-10 my-auto w-full max-w-[clamp(28rem,28vw,34rem)] self-center py-6 md:my-0">
          <div className="auth-card rounded-2xl border bg-card/85 p-7 shadow-card backdrop-blur-sm sm:p-9">
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-primary-soft px-3 py-1 text-xs font-semibold text-primary">
              <ShieldCheck className="h-3.5 w-3.5" /> {badge}
            </span>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
