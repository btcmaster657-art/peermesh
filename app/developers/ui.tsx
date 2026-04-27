import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

export const developerShellStyle: CSSProperties = {
  width: '100%',
  maxWidth: '1100px',
  display: 'grid',
  gap: '18px',
}

export const developerCardStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '14px',
  padding: '18px',
}

export const developerGridStyle: CSSProperties = {
  display: 'grid',
  gap: '16px',
}

export const developerMonospaceLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-geist-mono)',
  fontSize: '11px',
  color: 'var(--accent)',
  letterSpacing: '2px',
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '14px',
        background: 'var(--bg)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '10px',
        overflowX: 'auto',
        fontSize: '12px',
        lineHeight: 1.65,
      }}
    >
      <code>{code}</code>
    </pre>
  )
}

export function DeveloperPageHeader(props: {
  eyebrow: string
  title: string
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <div style={{ ...developerCardStyle, padding: '20px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: '760px' }}>
          <div style={{ ...developerMonospaceLabelStyle, marginBottom: '10px', letterSpacing: '3px' }}>
            {props.eyebrow}
          </div>
          <h1 style={{ margin: 0, fontSize: '30px', lineHeight: 1.1, fontWeight: 650 }}>
            {props.title}
          </h1>
          <div style={{ marginTop: '12px', fontSize: '14px', color: 'var(--muted)', lineHeight: 1.8 }}>
            {props.description}
          </div>
        </div>
        {props.actions ? (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {props.actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function DeveloperActionLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{
        padding: '9px 12px',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        color: 'var(--text)',
        textDecoration: 'none',
        fontFamily: 'var(--font-geist-mono)',
        fontSize: '11px',
      }}
    >
      {label}
    </Link>
  )
}
