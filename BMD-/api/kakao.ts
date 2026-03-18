export const runtime = 'nodejs';

const PRIMARY_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 2200;
const MAX_OUTPUT_CHARS = 320;

function kakaoSimpleText(text: string) {
  return {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: {
            text,
          },
        },
      ],
    },
  };
}

function clampText(input: string, maxLength = MAX_OUTPUT_CHARS) {
  const normalized = input.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildGeminiBody(utterance: string) {
  return {
    systemInstruction: {
      parts: [
        {
          text: '한국어로 짧고 정확하게 답하세요. 핵심만 말하고, 최대 5문장.',
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: utterance.slice(0, 800),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 220,
    },
  };
}

function isResourceExhausted(status: number, data: any, rawText: string) {
  const apiCode = data?.error?.code;
  const apiStatus = data?.error?.status;
  const message = String(data?.error?.message || rawText || '').toLowerCase();

  return (
    status === 429 ||
    apiCode === 429 ||
    apiStatus === 'RESOURCE_EXHAUSTED' ||
    message.includes('resource has been exhausted') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  );
}

async function callGeminiModel(model: string, utterance: string, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(buildGeminiBody(utterance)),
      }
    );

    const rawText = await response.text();

    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(
        `Gemini API error: ${response.status} ${data?.error?.status || ''}`.trim()
      ) as Error & {
        httpStatus?: number;
        apiData?: any;
        rawText?: string;
        model?: string;
        resourceExhausted?: boolean;
      };

      error.httpStatus = response.status;
      error.apiData = data;
      error.rawText = rawText;
      error.model = model;
      error.resourceExhausted = isResourceExhausted(response.status, data, rawText);

      throw error;
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part: { text?: string }) => part.text ?? '').join('\n').trim();

    if (!text) {
      throw new Error(`Gemini returned empty text from ${model}`);
    }

    return clampText(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(utterance: string, apiKey: string) {
  try {
    return await callGeminiModel(PRIMARY_MODEL, utterance, apiKey);
  } catch (error: any) {
    const shouldFallback = Boolean(error?.resourceExhausted);

    if (!shouldFallback) {
      throw error;
    }

    console.warn(
      `Primary model exhausted. Falling back from ${PRIMARY_MODEL} to ${FALLBACK_MODEL}.`,
      {
        httpStatus: error?.httpStatus,
        apiStatus: error?.apiData?.error?.status,
        message: error?.apiData?.error?.message || error?.message,
      }
    );

    return await callGeminiModel(FALLBACK_MODEL, utterance, apiKey);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'kakao-gemini-skill',
      primaryModel: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const fallbackText = '지금은 답변이 지연되고 있어요. 잠시 후 다시 질문해 주세요.';
  const missingUtteranceText = '질문을 받지 못했어요. 다시 입력해 주세요.';

  try {
    const rawBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const utterance = rawBody?.userRequest?.utterance?.toString().trim();

    if (!utterance) {
      return res.status(200).json(kakaoSimpleText(missingUtteranceText));
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(200).json(kakaoSimpleText(fallbackText));
    }

    const answer = await askGemini(utterance, apiKey);
    return res.status(200).json(kakaoSimpleText(answer));
  } catch (error) {
    console.error('Kakao skill error:', error);
    return res.status(200).json(kakaoSimpleText(fallbackText));
  }
}