import { NextResponse } from 'next/server'
import { getFlutterwaveBanks } from '@/lib/flutterwave'
import { getRequestUser } from '@/lib/request-auth'

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const country = (searchParams.get('country') ?? '').trim().toUpperCase()
  if (!country) {
    return NextResponse.json({ error: 'country is required' }, { status: 400 })
  }

  try {
    const response = await getFlutterwaveBanks(country)
    const banks = (response.data ?? [])
      .filter((bank) => bank.code && bank.name)
      .map((bank) => ({
        id: bank.id ?? null,
        code: bank.code ?? '',
        name: bank.name ?? '',
        country: bank.country ?? country,
        currency: bank.currency ?? null,
        type: bank.type ?? null,
      }))

    return NextResponse.json({ banks })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load banks' },
      { status: 500 },
    )
  }
}
