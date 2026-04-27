import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/request-auth'
import { getSavedPayoutDestination, savePayoutDestination } from '@/lib/wallet'
import { adminClient } from '@/lib/supabase/admin'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const destination = await getSavedPayoutDestination(user.id)
    return NextResponse.json({ destination })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load payout destination' },
      { status: 500 },
    )
  }
}

export async function PUT(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))

  try {
    const destination = await savePayoutDestination({
      userId: user.id,
      countryCode: asString(body.countryCode),
      currency: asString(body.currency),
      bankCode: asString(body.bankCode),
      bankName: asString(body.bankName),
      accountNumber: asString(body.accountNumber),
      accountName: asString(body.accountName),
      beneficiaryName: asString(body.beneficiaryName),
      branchCode: asString(body.branchCode) || null,
    })

    return NextResponse.json({ destination })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not save payout destination' },
      { status: 400 },
    )
  }
}

export async function DELETE(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await adminClient
    .from('profiles')
    .update({
      payout_currency: null,
      payout_country_code: null,
      payout_bank_code: null,
      payout_bank_name: null,
      payout_account_number: null,
      payout_account_name: null,
      payout_beneficiary_name: null,
      payout_branch_code: null,
    })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    destination: {
      currency: null,
      countryCode: null,
      bankCode: null,
      bankName: null,
      accountName: null,
      beneficiaryName: null,
      branchCode: null,
      maskedAccountNumber: null,
      hasDestination: false,
    },
  })
}
