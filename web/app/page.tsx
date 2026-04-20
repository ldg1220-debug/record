'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

type Category = 'main' | 'side';

type Chunk = {
  id: number;
  text: string;
  category?: Category;
  summary?: string;
  pending?: boolean;
  error?: string;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default function Home() {
  const [agenda, setAgenda] = useState('');
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(true);
  const [finalNote, setFinalNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const chunkIdRef = useRef(0);
  const shouldRestartRef = useRef(false);

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);

  const analyzeChunk = useCallback(async (id: number, text: string, agendaNow: string) => {
    try {
      const res = await fetch('/api/analyze-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agenda: agendaNow, textChunk: text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { category: Category; summary: string };
      setChunks((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, category: data.category, summary: data.summary, pending: false } : c,
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChunks((prev) => prev.map((c) => (c.id === id ? { ...c, pending: false, error: msg } : c)));
    }
  }, []);

  const startRecording = useCallback(() => {
    setError(null);
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('이 브라우저는 Web Speech API를 지원하지 않습니다. Chrome을 사용하세요.');
      return;
    }
    if (!agenda.trim()) {
      setError('먼저 아젠다를 입력하세요.');
      return;
    }
    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = false;

    rec.onresult = (ev) => {
      const agendaNow = agenda;
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        if (!r.isFinal) continue;
        const text = r[0].transcript.trim();
        if (!text) continue;
        const id = (chunkIdRef.current += 1);
        setChunks((prev) => [...prev, { id, text, pending: true }]);
        analyzeChunk(id, text, agendaNow);
      }
    };
    rec.onerror = (ev) => {
      const err = (ev as unknown as { error?: string }).error ?? 'unknown';
      setError(`음성 인식 오류: ${err}`);
    };
    rec.onend = () => {
      if (shouldRestartRef.current) {
        try {
          rec.start();
        } catch {
          shouldRestartRef.current = false;
          setRecording(false);
        }
      } else {
        setRecording(false);
      }
    };

    recognitionRef.current = rec;
    shouldRestartRef.current = true;
    rec.start();
    setRecording(true);
  }, [agenda, analyzeChunk]);

  const stopRecording = useCallback(() => {
    shouldRestartRef.current = false;
    recognitionRef.current?.stop();
    setRecording(false);
  }, []);

  const generateFinal = useCallback(async () => {
    if (!agenda.trim() || chunks.length === 0) {
      setError('아젠다와 최소 1개 이상의 메모가 필요합니다.');
      return;
    }
    setError(null);
    setGenerating(true);
    setFinalNote('');
    try {
      const mainNotes = chunks.filter((c) => c.category === 'main' && c.summary).map((c) => c.summary!);
      const sideNotes = chunks.filter((c) => c.category === 'side' && c.summary).map((c) => c.summary!);
      const fullText = chunks.map((c) => c.text).join('\n');

      const res = await fetch('/api/generate-final-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agenda, mainNotes, sideNotes, fullText }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setFinalNote((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [agenda, chunks]);

  const resetAll = useCallback(() => {
    stopRecording();
    setChunks([]);
    setFinalNote('');
    setError(null);
    chunkIdRef.current = 0;
  }, [stopRecording]);

  const mainCount = chunks.filter((c) => c.category === 'main').length;
  const sideCount = chunks.filter((c) => c.category === 'side').length;

  return (
    <main>
      <h1>ContextNote</h1>
      <p className="status">강의/회의 실시간 정리 — 본론과 사담을 자동 분류하고, 끝나면 한 번에 정리합니다.</p>

      <h2>아젠다</h2>
      <div className="panel">
        <textarea
          value={agenda}
          onChange={(e) => setAgenda(e.target.value)}
          placeholder="오늘의 메인 주제를 한두 줄로 적어주세요. 예) Q3 제품 출시 일정 확정 및 리스크 점검"
          disabled={recording}
        />
      </div>

      <h2>녹음</h2>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="status">
            <span className={`dot ${recording ? 'rec' : ''}`} />
            {recording ? '녹음 중...' : supported ? '대기 중' : 'Web Speech API 미지원'}
            {chunks.length > 0 && (
              <span style={{ marginLeft: 12 }}>
                본론 {mainCount} · 사담 {sideCount} · 총 {chunks.length}
              </span>
            )}
          </div>
          <div className="row">
            {!recording ? (
              <button onClick={startRecording} disabled={!supported}>
                녹음 시작
              </button>
            ) : (
              <button className="danger" onClick={stopRecording}>
                중지
              </button>
            )}
            <button className="secondary" onClick={resetAll} disabled={recording}>
              초기화
            </button>
          </div>
        </div>

        {chunks.length > 0 && (
          <div className="chunks" style={{ marginTop: 12 }}>
            {chunks.map((c) => (
              <div key={c.id} className={`chunk ${c.category ?? ''}`}>
                <span className="tag">
                  {c.pending ? '...' : c.error ? 'ERR' : c.category === 'main' ? '본론' : '사담'}
                </span>
                <div style={{ flex: 1 }}>
                  <div>{c.text}</div>
                  {c.summary && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>→ {c.summary}</div>}
                  {c.error && <div style={{ color: '#e24d4d', fontSize: 12 }}>{c.error}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2>최종 노트</h2>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <span className="status">녹음을 마친 뒤 전체를 하나의 문서로 정리합니다.</span>
          <button onClick={generateFinal} disabled={generating || recording || chunks.length === 0}>
            {generating ? '생성 중...' : '최종 노트 생성'}
          </button>
        </div>
        <div className="final">
          {finalNote ? <ReactMarkdown>{finalNote}</ReactMarkdown> : <span className="status">아직 생성되지 않았습니다.</span>}
        </div>
      </div>

      {error && (
        <div className="panel" style={{ marginTop: 16, borderColor: '#e24d4d', color: '#ffb3b3' }}>
          {error}
        </div>
      )}
    </main>
  );
}
