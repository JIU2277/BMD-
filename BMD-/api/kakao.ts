export const runtime = 'nodejs';

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 2500;
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

async function askGemini(utterance: string, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: '한국어로 짧고 정확하게 답하세요. 보통 1~2문단, 최대 5문장.',
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
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? '').join('\n').trim();
    if (!text) {
      throw new Error('Gemini returned empty text');
    }

    return clampText(text);
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'kakao-gemini-skill',
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
