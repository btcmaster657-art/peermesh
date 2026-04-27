import { Suspense } from 'react'
import BillingPageClient from './BillingPageClient'

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)' }}>
          LOADING BILLING...
        </div>
      }
    >
      <BillingPageClient />
    </Suspense>
  )
}
