import { redirect } from 'next/navigation'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

export default async function LegacyBillingPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const resolvedSearchParams = await searchParams
  const nextSearch = new URLSearchParams()

  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => nextSearch.append(key, entry))
      continue
    }
    if (typeof value === 'string') {
      nextSearch.set(key, value)
    }
  }

  redirect(
    nextSearch.size > 0
      ? `/developers/billing?${nextSearch.toString()}`
      : '/developers/billing',
  )
}
