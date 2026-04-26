import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const MODEL_CLASSIFIER = process.env.MODEL_CLASSIFIER || 'gemini-2.5-flash';
const MODEL_FINAL = process.env.MODEL_FINAL || 'gemini-2.5-pro';

const app = express();

// ── CORS: allowlist 기반, 모바일(no-origin)은 통과 ───────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      cb(new Error('CORS: 허용되지 않은 출처입니다.'));
    },
  }),
);

app.use(express.json({ limit: '256kb' }));

// ── 토큰 인증 미들웨어 ────────────────────────────────────────────────────────
const API_TOKEN = process.env.API_TOKEN ?? '';

function requireToken(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.headers['x-api-token'];
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: '인증 실패' });
  }
  next();
}

// ── Rate limit ────────────────────────────────────────────────────────────────
const chunkLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});

const finalLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});

// ── 입력 길이 제한 ─────────────────────────────────────────────────────────────
const MAX_AGENDA = 500;
const MAX_CHUNK = 2_000;
const MAX_FULL_TEXT = 150_000;
const MAX_NOTES_ITEM = 200;

// ── Gemini 구조화 출력 스키마 ─────────────────────────────────────────────────
const ChunkAnalysisSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['main', 'side'],
      description: 'main: 메인 아젠다와 관련된 본론. side: 사담/잡담/참고 에피소드.',
    },
    summary: {
      type: 'string',
      description: '해당 청크의 한 줄(최대 60자) 요약.',
    },
  },
  required: ['category', 'summary'],
  propertyOrdering: ['category', 'summary'],
};

// ── 시스템 프롬프트 ───────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `당신은 실시간 회의/강의 음성 인식 결과를 분류하는 분석기입니다.
사용자가 정의한 메인 아젠다를 기준으로, 전달된 텍스트 조각이
- 본론(main): 아젠다와 직접적으로 연결되는 논의/설명/결정
- 사이드(side): 잡담, 개인 에피소드, 주제에서 벗어난 이야기, 본론 이해에 도움이 될 수도 있는 비유/예시
중 어디에 해당하는지 판단하고, 한 줄로 간결히 요약합니다.
애매하면 본문 이해에 도움이 되는가를 기준으로 판단하세요.`;

const FINAL_EDITOR_SYSTEM = `당신은 장시간 녹취된 회의/강의 원문과 실시간 분류 메모를 바탕으로
최종 문서를 작성하는 편집자입니다.
- 본론을 주제별 섹션으로 재구성합니다.
- 결정 사항(Decisions)과 액션 아이템(Action Items)을 별도로 표기합니다.
- 사담(side notes) 중 본론 이해에 기여하는 비유/예시는 본문에 자연스럽게 녹입니다.
- 순수 잡담은 제거합니다.
- 한국어 마크다운으로 출력합니다.`;

// ── 라우트 ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'context-note-backend', llm: 'gemini' });
});

app.post('/api/analyze-chunk', requireToken, chunkLimiter, async (req, res) => {
  const { agenda, textChunk } = req.body ?? {};
  if (typeof agenda !== 'string' || typeof textChunk !== 'string' || !textChunk.trim()) {
    return res.status(400).json({ error: 'agenda와 textChunk(string)가 필요합니다.' });
  }
  if (agenda.length > MAX_AGENDA) {
    return res.status(400).json({ error: `agenda는 ${MAX_AGENDA}자 이하여야 합니다.` });
  }
  if (textChunk.length > MAX_CHUNK) {
    return res.status(400).json({ error: `textChunk는 ${MAX_CHUNK}자 이하여야 합니다.` });
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL_CLASSIFIER,
      contents: `[아젠다]\n${agenda}\n\n[분석할 텍스트]\n"""\n${textChunk}\n"""`,
      config: {
        systemInstruction: CLASSIFIER_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: ChunkAnalysisSchema,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 0 }, // 분류는 thinking 끄고 빠르게
      },
    });

    const raw = response.text;
    if (!raw) {
      return res.status(502).json({ error: '분류 결과가 비어 있습니다.' });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: '분류 결과 파싱 실패' });
    }
    if (parsed?.category !== 'main' && parsed?.category !== 'side') {
      return res.status(502).json({ error: '분류 결과 카테고리가 유효하지 않습니다.' });
    }
    res.json({
      category: parsed.category,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    });
  } catch (err) {
    handleApiError(err, res);
  }
});

app.post('/api/generate-final-note', requireToken, finalLimiter, async (req, res) => {
  const { agenda, mainNotes = [], sideNotes = [], fullText } = req.body ?? {};
  if (typeof agenda !== 'string' || typeof fullText !== 'string' || !fullText.trim()) {
    return res.status(400).json({ error: 'agenda와 fullText(string)가 필요합니다.' });
  }
  if (agenda.length > MAX_AGENDA) {
    return res.status(400).json({ error: `agenda는 ${MAX_AGENDA}자 이하여야 합니다.` });
  }
  if (fullText.length > MAX_FULL_TEXT) {
    return res.status(400).json({ error: `fullText는 ${MAX_FULL_TEXT}자 이하여야 합니다.` });
  }
  if (!Array.isArray(mainNotes) || !Array.isArray(sideNotes)) {
    return res.status(400).json({ error: 'mainNotes, sideNotes는 배열이어야 합니다.' });
  }

  const userPrompt = [
    `# 오늘의 아젠다\n${agenda}`,
    `# 실시간 분류 - 본론 메모\n${formatList(mainNotes, MAX_NOTES_ITEM)}`,
    `# 실시간 분류 - 사담/참고 메모\n${formatList(sideNotes, MAX_NOTES_ITEM)}`,
    `# 전체 원문 (음성 인식 결과)\n"""\n${fullText}\n"""`,
    `# 작성 지침\n- 주제별 섹션으로 재구성\n- 결정 사항 / 액션 아이템 분리\n- 도움이 되는 사담은 본문에 녹이기, 잡담은 제거\n- 한국어 마크다운, 제목은 \`#\`로 시작`,
  ].join('\n\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const stream = await ai.models.generateContentStream({
      model: MODEL_FINAL,
      contents: userPrompt,
      config: {
        systemInstruction: FINAL_EDITOR_SYSTEM,
        thinkingConfig: { thinkingBudget: -1, includeThoughts: false }, // 동적 thinking
        maxOutputTokens: 32_000,
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      return handleApiError(err, res);
    }
    console.error('[final-note stream error]', err);
    res.end();
  }
});

// ── 유틸 ───────────────────────────────────────────────────────────────────────
function formatList(items, maxItemLen) {
  if (!Array.isArray(items) || items.length === 0) return '(없음)';
  return items
    .slice(0, 500)
    .map((item, i) => {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      return `${i + 1}. ${text.slice(0, maxItemLen)}`;
    })
    .join('\n');
}

function handleApiError(err, res) {
  // Google GenAI는 에러를 status 필드 있는 객체로 던짐
  const status = err?.status ?? err?.response?.status;
  if (status === 429) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  }
  if (status === 401 || status === 403) {
    return res.status(401).json({ error: 'API 키 인증 오류' });
  }
  if (typeof status === 'number') {
    return res.status(status).json({ error: '외부 AI 서비스 오류가 발생했습니다.' });
  }
  console.error('[unexpected error]', err);
  res.status(500).json({ error: '내부 오류가 발생했습니다.' });
}

// ── 시작 ───────────────────────────────────────────────────────────────────────
if (!process.env.GOOGLE_API_KEY) {
  console.warn('[config] GOOGLE_API_KEY 미설정 — Gemini API 호출이 실패합니다.');
}
if (!API_TOKEN) {
  console.warn('[security] API_TOKEN 미설정 — 인증 없이 동작 중. .env에 API_TOKEN을 추가하세요.');
}

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`ContextNote backend listening on http://localhost:${PORT}`);
  console.log(`  classifier: ${MODEL_CLASSIFIER}`);
  console.log(`  final-note: ${MODEL_FINAL}`);
});
