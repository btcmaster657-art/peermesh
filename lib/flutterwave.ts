import { createHmac, timingSafeEqual } from 'crypto'

const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3'

type FlutterwaveRequestOptions = RequestInit & {
  expectJson?: boolean
}

export type FlutterwaveCheckoutRequest = {
  txRef: string
  amountUsd: number
  customerEmail: string
  customerName: string
  redirectUrl: string
  title?: string
  description?: string
  meta?: Record<string, unknown>
}

export type FlutterwaveCheckoutResponse = {
  status: string
  message: string
  data: {
    link?: string
    id?: number
  } & Record<string, unknown>
}

export type FlutterwaveVerifyResponse = {
  status: string
  message: string
  data: {
    id: number
    tx_ref?: string
    status?: string
    amount?: number
    currency?: string
    customer?: {
      email?: string | null
      name?: string | null
    } | null
  } & Record<string, unknown>
}

export type FlutterwaveTransferRateResponse = {
  status: string
  message: string
  data: {
    rate: number
    source: {
      currency: string
      amount: number
    }
    destination: {
      currency: string
      amount: number
    }
  }
}

export type FlutterwaveBank = {
  id?: number | string
  code?: string | null
  name?: string | null
  country?: string | null
  currency?: string | null
  type?: string | null
} & Record<string, unknown>

export type FlutterwaveBanksResponse = {
  status: string
  message: string
  data: FlutterwaveBank[]
}

export type FlutterwaveResolveAccountResponse = {
  status: string
  message: string
  data: {
    account_number?: string | null
    account_name?: string | null
  } | null
}

export type FlutterwaveTransferResponse = {
  status: string
  message: string
  data: {
    id?: number | string
    reference?: string | null
    status?: string | null
    amount?: number | null
    currency?: string | null
    debit_currency?: string | null
    destination_currency?: string | null
    source_currency?: string | null
    complete_message?: string | null
    callback_url?: string | null
    fee?: {
      currency?: string | null
      value?: number | null
    } | null
  } & Record<string, unknown>
}

export type FlutterwaveTransferInput = {
  accountBank: string
  accountNumber: string
  amount: number
  currency: string
  beneficiaryName: string
  reference: string
  debitCurrency?: string
  callbackUrl?: string
  destinationBranchCode?: string | null
  meta?: Record<string, unknown>
}

export type FlutterwaveSourceQuote = {
  sourceCurrency: string
  destinationCurrency: string
  rate: number
  sourceAmount: number
  destinationAmount: number
}

function getFlutterwaveSecretKey(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY ?? ''
  if (!key) throw new Error('FLUTTERWAVE_SECRET_KEY is not configured')
  return key
}

async function flutterwaveRequest<T>(path: string, init: FlutterwaveRequestOptions = {}): Promise<T> {
  const secretKey = getFlutterwaveSecretKey()
  const response = await fetch(`${FLUTTERWAVE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Flutterwave request failed (${response.status}): ${body.slice(0, 200)}`)
  }

  if (init.expectJson === false) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export async function createFlutterwaveCheckout(
  input: FlutterwaveCheckoutRequest,
): Promise<FlutterwaveCheckoutResponse> {
  return flutterwaveRequest<FlutterwaveCheckoutResponse>('/payments', {
    method: 'POST',
    body: JSON.stringify({
      amount: Number(input.amountUsd.toFixed(2)),
      tx_ref: input.txRef,
      currency: 'USD',
      redirect_url: input.redirectUrl,
      customer: {
        email: input.customerEmail,
        name: input.customerName,
      },
      customizations: {
        title: input.title ?? 'PeerMesh Wallet Top-up',
        description: input.description ?? 'Fund your PeerMesh USD wallet for API usage and payouts.',
      },
      meta: input.meta ?? {},
    }),
  })
}

export async function verifyFlutterwaveTransaction(transactionId: number | string): Promise<FlutterwaveVerifyResponse> {
  return flutterwaveRequest<FlutterwaveVerifyResponse>(`/transactions/${encodeURIComponent(String(transactionId))}/verify`, {
    method: 'GET',
  })
}

export async function getFlutterwaveTransferRate(
  sourceCurrency: string,
  destinationCurrency: string,
  amount: number,
): Promise<FlutterwaveTransferRateResponse> {
  const query = new URLSearchParams({
    source_currency: sourceCurrency,
    destination_currency: destinationCurrency,
    amount: String(amount),
  })
  return flutterwaveRequest<FlutterwaveTransferRateResponse>(`/transfers/rates?${query.toString()}`, {
    method: 'GET',
  })
}

export async function getFlutterwaveBanks(country: string): Promise<FlutterwaveBanksResponse> {
  return flutterwaveRequest<FlutterwaveBanksResponse>(`/banks/${encodeURIComponent(country.trim().toUpperCase())}?include_provider_type=1`, {
    method: 'GET',
  })
}

export async function resolveFlutterwaveAccount(
  accountNumber: string,
  accountBank: string,
): Promise<FlutterwaveResolveAccountResponse> {
  return flutterwaveRequest<FlutterwaveResolveAccountResponse>('/accounts/resolve', {
    method: 'POST',
    body: JSON.stringify({
      account_number: accountNumber.trim(),
      account_bank: accountBank.trim(),
    }),
  })
}

export async function createFlutterwaveTransfer(
  input: FlutterwaveTransferInput,
): Promise<FlutterwaveTransferResponse> {
  return flutterwaveRequest<FlutterwaveTransferResponse>('/transfers', {
    method: 'POST',
    body: JSON.stringify({
      account_bank: input.accountBank.trim(),
      account_number: input.accountNumber.trim(),
      amount: Number(input.amount.toFixed(2)),
      currency: input.currency.trim().toUpperCase(),
      beneficiary_name: input.beneficiaryName.trim(),
      reference: input.reference.trim(),
      debit_currency: (input.debitCurrency ?? 'USD').trim().toUpperCase(),
      callback_url: input.callbackUrl ?? undefined,
      destination_branch_code: input.destinationBranchCode?.trim() || undefined,
      meta: input.meta ?? {},
    }),
  })
}

export async function getFlutterwaveTransfer(transferId: number | string): Promise<FlutterwaveTransferResponse> {
  return flutterwaveRequest<FlutterwaveTransferResponse>(`/transfers/${encodeURIComponent(String(transferId))}`, {
    method: 'GET',
  })
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function floorCurrency(value: number): number {
  return Math.floor(value * 100) / 100
}

export async function quoteFlutterwaveDestinationFromSourceAmount(
  sourceCurrency: string,
  destinationCurrency: string,
  sourceAmount: number,
): Promise<FlutterwaveSourceQuote> {
  const normalizedSourceCurrency = sourceCurrency.trim().toUpperCase()
  const normalizedDestinationCurrency = destinationCurrency.trim().toUpperCase()
  const normalizedSourceAmount = roundCurrency(Number(sourceAmount) || 0)

  if (normalizedSourceCurrency === normalizedDestinationCurrency) {
    return {
      sourceCurrency: normalizedSourceCurrency,
      destinationCurrency: normalizedDestinationCurrency,
      rate: 1,
      sourceAmount: normalizedSourceAmount,
      destinationAmount: normalizedSourceAmount,
    }
  }

  const probe = await getFlutterwaveTransferRate(
    normalizedSourceCurrency,
    normalizedDestinationCurrency,
    1,
  )

  const rate = Number(probe.data?.rate ?? 0)
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Flutterwave did not return a usable transfer rate')
  }

  let destinationAmount = floorCurrency(normalizedSourceAmount * rate)
  if (destinationAmount <= 0) {
    throw new Error('Payout amount is too small for the selected destination currency')
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const verification = await getFlutterwaveTransferRate(
      normalizedSourceCurrency,
      normalizedDestinationCurrency,
      destinationAmount,
    )
    const requiredSourceAmount = Number(verification.data?.source?.amount ?? 0)
    if (Number.isFinite(requiredSourceAmount) && requiredSourceAmount <= normalizedSourceAmount + 0.0001) {
      return {
        sourceCurrency: normalizedSourceCurrency,
        destinationCurrency: normalizedDestinationCurrency,
        rate: Number(verification.data?.rate ?? rate),
        sourceAmount: roundCurrency(requiredSourceAmount),
        destinationAmount: roundCurrency(destinationAmount),
      }
    }
    destinationAmount = floorCurrency(destinationAmount - 0.01)
    if (destinationAmount <= 0) break
  }

  throw new Error('Could not compute a destination payout amount from the current Flutterwave rate')
}

export function normalizeFlutterwaveTransferStatus(status: unknown): 'new' | 'pending' | 'successful' | 'failed' | 'cancelled' {
  const normalized = typeof status === 'string' ? status.trim().toUpperCase() : ''
  if (normalized === 'SUCCESSFUL' || normalized === 'SUCCESS' || normalized === 'COMPLETED') return 'successful'
  if (normalized === 'FAILED' || normalized === 'FAILURE' || normalized === 'ERROR') return 'failed'
  if (normalized === 'CANCELLED' || normalized === 'CANCELED' || normalized === 'REVERSED') return 'cancelled'
  if (normalized === 'PENDING' || normalized === 'PROCESSING' || normalized === 'QUEUED') return 'pending'
  return 'new'
}

export function isSuccessfulFlutterwaveCharge(payload: FlutterwaveVerifyResponse | { data?: { status?: string } | null }): boolean {
  const status = payload?.data?.status?.toLowerCase?.() ?? ''
  return status === 'successful' || status === 'succeeded'
}

export function verifyFlutterwaveWebhookSignature(
  rawBody: string,
  signature: string | null,
  secretHash: string | null | undefined,
  options: { allowPlainSecret?: boolean } = {},
): boolean {
  if (!signature || !secretHash) return false
  if (options.allowPlainSecret && signature === secretHash) return true

  const digest = createHmac('sha256', secretHash).update(rawBody).digest('base64')
  const actual = Buffer.from(signature)
  const expected = Buffer.from(digest)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
