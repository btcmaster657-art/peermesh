import { Suspense } from 'react'
import InstallPageClient from './InstallPageClient'

export default function InstallPage() {
  return (
    <Suspense fallback={
      <main className="flex flex-1 items-center justify-center">
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '12px', letterSpacing: '2px' }}>LOADING...</div>
      </main>
    }>
      <InstallPageClient />
    </Suspense>
  )
}
