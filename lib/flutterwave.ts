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
