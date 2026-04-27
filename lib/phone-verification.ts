const TWILIO_VERIFY_BASE_URL = 'https://verify.twilio.com/v2'

type TwilioVerifyConfig = {
  accountSid: string
  authToken: string
  serviceSid: string
}

function getTwilioVerifyConfig(): TwilioVerifyConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? ''
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? ''
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim() ?? ''

  if (!accountSid || !authToken || !serviceSid) return null
  return { accountSid, authToken, serviceSid }
}

function createTwilioAuthHeader(config: TwilioVerifyConfig): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`
}

async function postTwilioVerify(
  path: string,
  body: URLSearchParams,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const config = getTwilioVerifyConfig()
  if (!config) {
    return { ok: false, status: 503, data: null }
  }

  const response = await fetch(`${TWILIO_VERIFY_BASE_URL}/Services/${config.serviceSid}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: createTwilioAuthHeader(config),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })

  const data = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    data: data && typeof data === 'object' ? data as Record<string, unknown> : null,
  }
}

export function isPhoneVerificationBypassEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BYPASS_VERIFICATION === 'true'
}

export function isTwilioVerifyConfigured(): boolean {
  return getTwilioVerifyConfig() !== null
}

export function normalizePhoneNumber(phone: string): string | null {
  const normalized = phone.trim().replace(/[\s()-]/g, '')
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null
}

export async function sendPhoneVerificationCode(phone: string): Promise<{
  ok: boolean
  status: number
  error?: string
}> {
  const payload = new URLSearchParams({
    To: phone,
    Channel: 'sms',
  })

  const response = await postTwilioVerify('Verifications', payload)
  if (!response.ok) {
    const message = typeof response.data?.message === 'string'
      ? response.data.message
      : 'Could not send verification code'
    return { ok: false, status: response.status, error: message }
  }

  return { ok: true, status: response.status }
}

export async function checkPhoneVerificationCode(phone: string, code: string): Promise<{
  ok: boolean
  status: number
  approved: boolean
  error?: string
}> {
  const payload = new URLSearchParams({
    To: phone,
    Code: code,
  })

  const response = await postTwilioVerify('VerificationCheck', payload)
  if (!response.ok) {
    const message = typeof response.data?.message === 'string'
      ? response.data.message
      : 'Could not verify code'
    return {
      ok: false,
      status: response.status,
      approved: false,
      error: message,
    }
  }

  return {
    ok: true,
    status: response.status,
    approved: response.data?.status === 'approved' || response.data?.valid === true,
  }
}
