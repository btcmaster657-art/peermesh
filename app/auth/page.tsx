import { Suspense } from 'react'
import AuthForm from './AuthForm'

export default function AuthPage() {
  return (
    <Suspense fallback={
      <main className="flex flex-1 items-center justify-center">
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '12px', letterSpacing: '2px' }}>
          LOADING...
        </div>
      </main>
    }>
      <AuthForm />
    </Suspense>
  )
}
