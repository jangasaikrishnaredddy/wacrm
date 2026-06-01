import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

const META_RATE_LIMIT_RETRY_DELAYS_MS = [3000, 6000, 10000]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMetaRateLimitError(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('error: 429') ||
    normalized.includes('code 429') ||
    normalized.includes('131056') ||
    normalized.includes('130429') ||
    normalized.includes('80007')
  )
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  params?: string[]
  body_parameter_objects?: Array<{
    type: 'text'
    text: string
    parameter_name?: string
  }>
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)
    const { data: templateRow, error: templateError } = await supabase
      .from('message_templates')
      .select('header_type, header_content')
      .eq('user_id', user.id)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle()

    if (templateError) {
      return NextResponse.json(
        { error: `Failed to load template metadata: ${templateError.message}` },
        { status: 400 }
      )
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        const mediaHeaderComponent =
          templateRow?.header_type === 'image' && templateRow.header_content
            ? [
                {
                  type: 'header',
                  parameters: [
                    {
                      type: 'image',
                      image: { link: templateRow.header_content },
                    },
                  ],
                },
              ]
            : templateRow?.header_type === 'video' && templateRow.header_content
              ? [
                  {
                    type: 'header',
                    parameters: [
                      {
                        type: 'video',
                        video: { link: templateRow.header_content },
                      },
                    ],
                  },
                ]
              : templateRow?.header_type === 'document' && templateRow.header_content
                ? [
                    {
                      type: 'header',
                      parameters: [
                        {
                          type: 'document',
                          document: { link: templateRow.header_content },
                        },
                      ],
                    },
                  ]
                : []

        for (let attempt = 0; attempt <= META_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
          try {
            const result = await sendTemplateMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: template_name,
              language: template_language || 'en_US',
              params: recipient.params ?? [],
              components:
                recipient.body_parameter_objects &&
                recipient.body_parameter_objects.length > 0
                  ? [
                      ...mediaHeaderComponent,
                      {
                        type: 'body',
                        parameters: recipient.body_parameter_objects,
                      },
                    ]
                  : mediaHeaderComponent.length > 0
                    ? mediaHeaderComponent
                    : undefined,
            })
            sentMessageId = result.messageId
            lastError = null
            break
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error'
            lastError = errorMessage

            if (isRecipientNotAllowedError(errorMessage)) {
              break
            }

            const retryDelay = META_RATE_LIMIT_RETRY_DELAYS_MS[attempt]
            if (!isMetaRateLimitError(errorMessage) || retryDelay === undefined) {
              break
            }

            console.warn(
              `[broadcast] Meta rate limit for ${recipient.phone}; retrying in ${retryDelay}ms`,
              errorMessage
            )
            await sleep(retryDelay)
          }
        }

        if (sentMessageId || !isRecipientNotAllowedError(lastError || '')) {
          break
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
