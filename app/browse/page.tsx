import { Suspense } from 'react'
import BrowseView from './BrowseView'

export default function BrowsePage() {
  return (
    <Suspense
      fallback={
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', height: '100vh' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '12px', letterSpacing: '2px' }}>
            CONNECTING...
          </div>
        </div>
      }
    >
      <BrowseView />
    </Suspense>
  )
}
