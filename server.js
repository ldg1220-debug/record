import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const client = new Anthropic();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ChunkAnalysisSchema = z.object({
  category: z
    .enum(['main', 'side'])
    .describe('main: 메인 아젠다와 관련된 본론. side: 사담/잡담/참고 에피소드.'),
  summary: z.string().describe('해당 청크의 한 줄(최대 60자) 요약.'),
});

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'context-note-backend' });
});

app.post('/api/analyze-chunk', async (req, res) => {
  const { agenda, textChunk } = req.body ?? {};
  if (typeof agenda !== 'string' || typeof textChunk !== 'string' || !textChunk.trim()) {
    return res.status(400).json({ error: 'agenda와 textChunk(string)가 필요합니다.' });
  }

  try {
    const response = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: CLASSIFIER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `[아젠다]\n${agenda}\n\n[분석할 텍스트]\n"""\n${textChunk}\n"""`,
        },
      ],
      output_config: {
        format: zodOutputFormat(ChunkAnalysisSchema),
      },
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      return res.status(502).json({ error: '분류 결과 파싱 실패' });
    }
    res.json(parsed);
  } catch (err) {
    handleApiError(err, res);
  }
});

app.post('/api/generate-final-note', async (req, res) => {
  const { agenda, mainNotes = [], sideNotes = [], fullText } = req.body ?? {};
  if (typeof agenda !== 'string' || typeof fullText !== 'string' || !fullText.trim()) {
    return res.status(400).json({ error: 'agenda와 fullText(string)가 필요합니다.' });
  }

  const userPrompt = [
    `# 오늘의 아젠다\n${agenda}`,
    `# 실시간 분류 - 본론 메모\n${formatList(mainNotes)}`,
    `# 실시간 분류 - 사담/참고 메모\n${formatList(sideNotes)}`,
    `# 전체 원문 (음성 인식 결과)\n"""\n${fullText}\n"""`,
    `# 작성 지침\n- 주제별 섹션으로 재구성\n- 결정 사항 / 액션 아이템 분리\n- 도움이 되는 사담은 본문에 녹이기, 잡담은 제거\n- 한국어 마크다운, 제목은 \`#\`로 시작`,
  ].join('\n\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system: FINAL_EDITOR_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  stream.on('text', (delta) => {
    res.write(delta);
  });

  try {
    await stream.finalMessage();
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      return handleApiError(err, res);
    }
    console.error('[final-note stream error]', err);
    res.end();
  }
});

function formatList(items) {
  if (!Array.isArray(items) || items.length === 0) return '(없음)';
  return items.map((item, i) => `${i + 1}. ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
}

function handleApiError(err, res) {
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(401).json({ error: 'ANTHROPIC_API_KEY가 올바르지 않습니다.' });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
  console.error('[unexpected error]', err);
  res.status(500).json({ error: '내부 오류가 발생했습니다.' });
}

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`ContextNote backend listening on http://localhost:${PORT}`);
});
