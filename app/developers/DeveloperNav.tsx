'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/developers/api-docs', label: 'API Docs' },
  { href: '/developers/billing', label: 'Billing' },
  { href: '/developers/keys', label: 'Keys' },
]

export function DeveloperNav() {
  const pathname = usePathname()

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(0,255,136,0.08), rgba(0,0,0,0))',
        border: '1px solid rgba(0,255,136,0.16)',
        borderRadius: '14px',
        padding: '16px 18px',
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '3px', marginBottom: '6px' }}>
          PEERMESH DEVELOPERS
        </div>
        <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.7 }}>
          Authenticated API access, usage billing, payout operations, and developer onboarding.
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Link
          href="/dashboard"
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
          Dashboard
        </Link>
        {links.map((link) => {
          const active = pathname === link.href
          return (
            <Link
              key={link.href}
              href={link.href}
              style={{
                padding: '9px 12px',
                border: `1px solid ${active ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`,
                borderRadius: '8px',
                color: active ? 'var(--accent)' : 'var(--text)',
                background: active ? 'var(--accent-dim)' : 'transparent',
                textDecoration: 'none',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '11px',
              }}
            >
              {link.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
