import Link from 'next/link'

const COUNTRIES = ['🇳🇬', '🇬🇧', '🇺🇸', '🇰🇪', '🇩🇪', '🇧🇷', '🇯🇵', '🇿🇦', '🇨🇦']

export default function LandingPage() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center px-6 py-20 text-center">
      {/* Logo */}
      <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', opacity: 0.7 }}>
        PEERMESH
      </div>

      {/* Headline */}
      <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', fontWeight: 700, lineHeight: 1.1, letterSpacing: '-0.03em', maxWidth: '640px', marginBottom: '20px' }}>
        Browse the world through{' '}
        <span style={{ color: 'var(--accent)' }}>real connections</span>
      </h1>

      <p style={{ color: 'var(--muted)', fontSize: '1.1rem', maxWidth: '480px', lineHeight: 1.7, marginBottom: '40px' }}>
        Access the internet from any country through a verified peer network.
        Share your connection, browse through others — for free.
      </p>

      {/* Country flags */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '48px', fontSize: '28px' }}>
        {COUNTRIES.map((flag, i) => (
          <span key={i} style={{ opacity: 0.8 }}>{flag}</span>
        ))}
      </div>

      {/* CTAs */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/auth?mode=signup"
          style={{
            padding: '14px 32px',
            background: 'var(--accent)',
            color: '#000',
            borderRadius: '10px',
            fontFamily: 'var(--font-geist-mono)',
            fontWeight: 700,
            fontSize: '13px',
            letterSpacing: '0.5px',
            textDecoration: 'none',
          }}
        >
          GET STARTED FREE
        </Link>
        <Link
          href="/extension"
          style={{
            padding: '14px 32px',
            background: 'transparent',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: '10px',
            fontFamily: 'var(--font-geist-mono)',
            fontSize: '13px',
            letterSpacing: '0.5px',
            textDecoration: 'none',
          }}
        >
          🧩 CHROME EXTENSION
        </Link>
        <Link
          href="/auth?mode=login"
          style={{
            padding: '14px 32px',
            background: 'transparent',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            fontFamily: 'var(--font-geist-mono)',
            fontSize: '13px',
            letterSpacing: '0.5px',
            textDecoration: 'none',
          }}
        >
          SIGN IN
        </Link>
      </div>

      {/* Trust line */}
      <p style={{ marginTop: '48px', color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)' }}>
        Verified identities · Cryptographic accountability · $1 one-time setup
      </p>
    </main>
  )
}
