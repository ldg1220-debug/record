import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

type Category = 'main' | 'side';

type Chunk = {
  id: number;
  text: string;
  category?: Category;
  summary?: string;
  pending?: boolean;
  error?: string;
};

const BACKEND_URL: string =
  (Constants.expoConfig?.extra?.backendUrl as string | undefined) ?? 'http://localhost:8080';

export default function App() {
  const [agenda, setAgenda] = useState('');
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [recording, setRecording] = useState(false);
  const [finalNote, setFinalNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chunkIdRef = useRef(0);
  const agendaRef = useRef(agenda);
  agendaRef.current = agenda;

  const analyzeChunk = useCallback(async (id: number, text: string, agendaNow: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/analyze-chunk`, {
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

  useSpeechRecognitionEvent('result', (event) => {
    const last = event.results?.[event.results.length - 1];
    if (!last || !event.isFinal) return;
    const text = last.transcript?.trim();
    if (!text) return;
    const id = (chunkIdRef.current += 1);
    setChunks((prev) => [...prev, { id, text, pending: true }]);
    analyzeChunk(id, text, agendaRef.current);
  });

  useSpeechRecognitionEvent('error', (event) => {
    setError(`음성 인식 오류: ${event.error ?? 'unknown'}${event.message ? ` - ${event.message}` : ''}`);
    setRecording(false);
  });

  useSpeechRecognitionEvent('end', () => {
    setRecording(false);
  });

  const startRecording = useCallback(async () => {
    setError(null);
    if (!agenda.trim()) {
      Alert.alert('아젠다 필요', '먼저 오늘의 아젠다를 입력하세요.');
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError('마이크/음성 인식 권한이 필요합니다.');
      return;
    }
    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'ko-KR',
        interimResults: false,
        continuous: true,
        requiresOnDeviceRecognition: false,
        addsPunctuation: true,
      });
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agenda]);

  const stopRecording = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
    setRecording(false);
  }, []);

  const generateFinal = useCallback(async () => {
    if (!agenda.trim() || chunks.length === 0) {
      Alert.alert('정보 부족', '아젠다와 최소 1개의 메모가 필요합니다.');
      return;
    }
    setError(null);
    setGenerating(true);
    setFinalNote('');
    try {
      const mainNotes = chunks.filter((c) => c.category === 'main' && c.summary).map((c) => c.summary!);
      const sideNotes = chunks.filter((c) => c.category === 'side' && c.summary).map((c) => c.summary!);
      const fullText = chunks.map((c) => c.text).join('\n');

      const res = await fetch(`${BACKEND_URL}/api/generate-final-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agenda, mainNotes, sideNotes, fullText }),
      });
      if (!res.ok || !res.body) {
        throw new Error(!res.ok ? await res.text() : '응답 스트림이 없습니다.');
      }
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
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
    if (recording) ExpoSpeechRecognitionModule.stop();
    setRecording(false);
    setChunks([]);
    setFinalNote('');
    setError(null);
    chunkIdRef.current = 0;
  }, [recording]);

  const stats = useMemo(() => {
    const mainCount = chunks.filter((c) => c.category === 'main').length;
    const sideCount = chunks.filter((c) => c.category === 'side').length;
    return { mainCount, sideCount };
  }, [chunks]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>ContextNote</Text>
        <Text style={styles.subtitle}>
          강의/회의 실시간 정리 — 본론과 사담을 자동 분류합니다.
        </Text>

        <Text style={styles.section}>아젠다</Text>
        <View style={styles.panel}>
          <TextInput
            style={styles.textarea}
            value={agenda}
            onChangeText={setAgenda}
            placeholder="오늘의 메인 주제를 한두 줄로 적어주세요."
            placeholderTextColor="#6a6f79"
            multiline
            editable={!recording}
          />
        </View>

        <Text style={styles.section}>녹음</Text>
        <View style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.rowStart}>
              <View style={[styles.dot, recording && styles.dotRec]} />
              <Text style={styles.status}>
                {recording ? '녹음 중...' : '대기 중'}
                {chunks.length > 0
                  ? `  ·  본론 ${stats.mainCount} · 사담 ${stats.sideCount} · 총 ${chunks.length}`
                  : ''}
              </Text>
            </View>
          </View>
          <View style={[styles.rowStart, { marginTop: 12 }]}>
            {!recording ? (
              <Pressable style={styles.primary} onPress={startRecording}>
                <Text style={styles.primaryText}>녹음 시작</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.danger} onPress={stopRecording}>
                <Text style={styles.dangerText}>중지</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.secondary, recording && styles.disabled]}
              onPress={resetAll}
              disabled={recording}
            >
              <Text style={styles.secondaryText}>초기화</Text>
            </Pressable>
          </View>

          {chunks.map((c) => (
            <View
              key={c.id}
              style={[
                styles.chunk,
                c.category === 'main' && styles.chunkMain,
                c.category === 'side' && styles.chunkSide,
              ]}
            >
              <Text
                style={[
                  styles.tag,
                  c.category === 'main' && styles.tagMain,
                  c.category === 'side' && styles.tagSide,
                ]}
              >
                {c.pending ? '...' : c.error ? 'ERR' : c.category === 'main' ? '본론' : '사담'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.chunkText}>{c.text}</Text>
                {c.summary ? <Text style={styles.chunkSummary}>→ {c.summary}</Text> : null}
                {c.error ? <Text style={styles.chunkError}>{c.error}</Text> : null}
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.section}>최종 노트</Text>
        <View style={styles.panel}>
          <View style={styles.rowBetween}>
            <Text style={styles.status}>녹음을 마친 뒤 전체를 하나의 문서로 정리합니다.</Text>
            <Pressable
              style={[styles.primary, (generating || recording || chunks.length === 0) && styles.disabled]}
              onPress={generateFinal}
              disabled={generating || recording || chunks.length === 0}
            >
              {generating ? (
                <ActivityIndicator color="#0b0c10" />
              ) : (
                <Text style={styles.primaryText}>생성</Text>
              )}
            </Pressable>
          </View>
          <View style={styles.finalBox}>
            {finalNote ? (
              <Markdown style={markdownStyles}>{finalNote}</Markdown>
            ) : (
              <Text style={styles.status}>아직 생성되지 않았습니다.</Text>
            )}
          </View>
        </View>

        {error ? (
          <View style={[styles.panel, styles.errorPanel]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0c10' },
  scroll: { padding: 20, paddingBottom: 80 },
  title: { color: '#e6e7ea', fontSize: 26, fontWeight: '700' },
  subtitle: { color: '#8a8f99', fontSize: 13, marginTop: 4 },
  section: {
    color: '#8a8f99',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  panel: {
    backgroundColor: '#151820',
    borderColor: '#262a33',
    borderWidth: 1,
    borderRadius: 10,
    padding: 16,
  },
  textarea: {
    color: '#e6e7ea',
    backgroundColor: '#0f1218',
    borderColor: '#262a33',
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    minHeight: 80,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  rowStart: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#8a8f99' },
  dotRec: { backgroundColor: '#e24d4d' },
  status: { color: '#8a8f99', fontSize: 13, flexShrink: 1 },
  primary: { backgroundColor: '#7c9eff', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 6 },
  primaryText: { color: '#0b0c10', fontWeight: '700', fontSize: 14 },
  secondary: {
    borderColor: '#262a33',
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  secondaryText: { color: '#e6e7ea', fontSize: 14 },
  danger: { backgroundColor: '#e24d4d', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 6 },
  dangerText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.5 },
  chunk: {
    flexDirection: 'row',
    gap: 10,
    padding: 10,
    borderRadius: 6,
    backgroundColor: '#0f1218',
    borderLeftColor: '#262a33',
    borderLeftWidth: 3,
    marginTop: 8,
  },
  chunkMain: { borderLeftColor: '#3ecf8e' },
  chunkSide: { borderLeftColor: '#f0a04b' },
  tag: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8a8f99',
    width: 36,
    textTransform: 'uppercase',
  },
  tagMain: { color: '#3ecf8e' },
  tagSide: { color: '#f0a04b' },
  chunkText: { color: '#e6e7ea', fontSize: 14 },
  chunkSummary: { color: '#8a8f99', fontSize: 12, marginTop: 2 },
  chunkError: { color: '#e24d4d', fontSize: 12, marginTop: 2 },
  finalBox: {
    backgroundColor: '#0f1218',
    borderColor: '#262a33',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    minHeight: 160,
    marginTop: 12,
  },
  errorPanel: { borderColor: '#e24d4d', marginTop: 16 },
  errorText: { color: '#ffb3b3', fontSize: 13 },
});

const markdownStyles = {
  body: { color: '#e6e7ea', fontSize: 14 },
  heading1: { color: '#e6e7ea', fontSize: 20, fontWeight: '700' as const, marginTop: 8 },
  heading2: { color: '#e6e7ea', fontSize: 17, fontWeight: '700' as const, marginTop: 8 },
  heading3: { color: '#e6e7ea', fontSize: 15, fontWeight: '700' as const, marginTop: 8 },
  bullet_list: { color: '#e6e7ea' },
  ordered_list: { color: '#e6e7ea' },
  paragraph: { color: '#e6e7ea', marginVertical: 4 },
  code_inline: { backgroundColor: '#262a33', color: '#e6e7ea', padding: 2, borderRadius: 3 },
  code_block: { backgroundColor: '#0b0c10', color: '#e6e7ea', padding: 10, borderRadius: 6 },
  fence: { backgroundColor: '#0b0c10', color: '#e6e7ea', padding: 10, borderRadius: 6 },
  link: { color: '#7c9eff' },
};
