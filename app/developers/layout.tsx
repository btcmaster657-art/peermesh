import type { ReactNode } from 'react'
import { DeveloperNav } from './DeveloperNav'
import { developerShellStyle } from './ui'

export default function DevelopersLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 justify-center px-6 py-12">
      <div style={developerShellStyle}>
        <DeveloperNav />
        {children}
      </div>
    </main>
  )
}
