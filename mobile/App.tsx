import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type Screen = 'setup' | 'main';

type Settings = {
  url: string;
  token: string;
};

const STORAGE_KEY = '@context_note_settings';

// ─── Setup Screen ─────────────────────────────────────────────────────────────

function SetupScreen({
  initial,
  onSave,
}: {
  initial: Settings;
  onSave: (s: Settings) => void;
}) {
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const testConnection = async () => {
    const target = url.trim();
    if (!target) return;
    setTesting(true);
    setTestResult(null);
    try {
      const headers: Record<string, string> = {};
      if (token.trim()) headers['x-api-token'] = token.trim();
      const res = await fetch(`${target}/api/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        setTestResult({ ok: false, msg: '토큰 인증 실패 — API 토큰을 확인하세요.' });
        return;
      }
      const json = (await res.json()) as { status?: string };
      if (json.status === 'ok') {
        setTestResult({ ok: true, msg: '연결 성공! 서버가 정상입니다.' });
      } else {
        setTestResult({ ok: false, msg: '서버 응답이 예상과 다릅니다.' });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: `연결 실패: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      Alert.alert('URL 필요', '백엔드 서버 주소를 입력하세요.');
      return;
    }
    onSave({ url: trimmed, token: token.trim() });
  };

  const canSave = url.trim().length > 0;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>ContextNote</Text>
        <Text style={styles.subtitle}>백엔드 서버 연결 설정</Text>

        <View style={[styles.panel, { marginTop: 32 }]}>
          <Text style={styles.label}>백엔드 URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(v) => { setUrl(v); setTestResult(null); }}
            placeholder="http://192.168.1.10:8080"
            placeholderTextColor="#6a6f79"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.hint}>
            PC와 같은 Wi-Fi에 연결된 상태에서{'\n'}
            PC의 로컬 IP + 포트 8080을 입력하세요.
          </Text>

          <Text style={[styles.label, { marginTop: 20 }]}>API 토큰</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={(v) => { setToken(v); setTestResult(null); }}
            placeholder="서버 .env의 API_TOKEN 값 (없으면 비워두기)"
            placeholderTextColor="#6a6f79"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Text style={styles.hint}>
            서버에 API_TOKEN이 설정된 경우 동일한 값을 입력하세요.
          </Text>

          {testResult && (
            <View style={[styles.testResult, testResult.ok ? styles.testOk : styles.testFail]}>
              <Text style={testResult.ok ? styles.testOkText : styles.testFailText}>
                {testResult.msg}
              </Text>
            </View>
          )}

          <View style={[styles.rowStart, { marginTop: 16 }]}>
            <Pressable
              style={[styles.secondary, (!url.trim() || testing) && styles.disabled]}
              onPress={testConnection}
              disabled={!url.trim() || testing}
            >
              {testing
                ? <ActivityIndicator color="#e6e7ea" size="small" />
                : <Text style={styles.secondaryText}>연결 테스트</Text>}
            </Pressable>
            <Pressable
              style={[styles.primary, !canSave && styles.disabled]}
              onPress={save}
              disabled={!canSave}
            >
              <Text style={styles.primaryText}>저장 후 시작</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

function MainScreen({
  settings,
  onOpenSettings,
}: {
  settings: Settings;
  onOpenSettings: () => void;
}) {
  const [agenda, setAgenda] = useState('');
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [recording, setRecording] = useState(false);
  const [finalNote, setFinalNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chunkIdRef = useRef(0);
  const agendaRef = useRef(agenda);
  agendaRef.current = agenda;

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.token) h['x-api-token'] = settings.token;
    return h;
  }, [settings.token]);

  const analyzeChunk = useCallback(
    async (id: number, text: string, agendaNow: string) => {
      try {
        const res = await fetch(`${settings.url}/api/analyze-chunk`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ agenda: agendaNow, textChunk: text }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { category: Category; summary: string };
        setChunks((prev) =>
          prev.map((c) =>
            c.id === id
              ? { ...c, category: data.category, summary: data.summary, pending: false }
              : c,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setChunks((prev) =>
          prev.map((c) => (c.id === id ? { ...c, pending: false, error: msg } : c)),
        );
      }
    },
    [settings.url, authHeaders],
  );

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
    setError(`음성 인식 오류: ${event.error ?? 'unknown'}${event.message ? ` — ${event.message}` : ''}`);
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
      const mainNotes = chunks
        .filter((c) => c.category === 'main' && c.summary)
        .map((c) => c.summary!);
      const sideNotes = chunks
        .filter((c) => c.category === 'side' && c.summary)
        .map((c) => c.summary!);
      const fullText = chunks.map((c) => c.text).join('\n');

      const res = await fetch(`${settings.url}/api/generate-final-note`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ agenda, mainNotes, sideNotes, fullText }),
      });
      if (!res.ok || !res.body) {
        throw new Error(!res.ok ? `서버 오류 (${res.status})` : '응답 스트림이 없습니다.');
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
  }, [agenda, chunks, settings.url, authHeaders]);

  const resetAll = useCallback(() => {
    if (recording) ExpoSpeechRecognitionModule.stop();
    setRecording(false);
    setChunks([]);
    setFinalNote('');
    setError(null);
    chunkIdRef.current = 0;
  }, [recording]);

  const stats = useMemo(() => ({
    mainCount: chunks.filter((c) => c.category === 'main').length,
    sideCount: chunks.filter((c) => c.category === 'side').length,
  }), [chunks]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.rowBetween}>
          <View>
            <Text style={styles.title}>ContextNote</Text>
            <Text style={styles.subtitle}>강의/회의 실시간 정리</Text>
          </View>
          <Pressable style={styles.settingsBtn} onPress={onOpenSettings}>
            <Text style={styles.settingsBtnText}>⚙</Text>
          </Pressable>
        </View>

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
            <View style={styles.rowStart}>
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
            <Text style={[styles.status, { flexShrink: 1 }]}>
              녹음을 마친 뒤 전체를 하나의 문서로 정리합니다.
            </Text>
            <Pressable
              style={[
                styles.primary,
                (generating || recording || chunks.length === 0) && styles.disabled,
              ]}
              onPress={generateFinal}
              disabled={generating || recording || chunks.length === 0}
            >
              {generating
                ? <ActivityIndicator color="#0b0c10" size="small" />
                : <Text style={styles.primaryText}>생성</Text>}
            </Pressable>
          </View>
          <View style={styles.finalBox}>
            {finalNote
              ? <Markdown style={markdownStyles}>{finalNote}</Markdown>
              : <Text style={styles.status}>아직 생성되지 않았습니다.</Text>}
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

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [settings, setSettings] = useState<Settings>({ url: '', token: '' });

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Settings;
          setSettings(parsed);
          setScreen('main');
          return;
        } catch {
          // 이전 버전(url만 저장)에 대한 호환
          setSettings({ url: saved, token: '' });
          setScreen('main');
          return;
        }
      }
      setScreen('setup');
    });
  }, []);

  const handleSave = useCallback(async (s: Settings) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    setSettings(s);
    setScreen('main');
  }, []);

  if (screen === null) {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar style="light" />
        <ActivityIndicator color="#7c9eff" />
      </View>
    );
  }

  if (screen === 'setup') {
    return <SetupScreen initial={settings} onSave={handleSave} />;
  }

  return <MainScreen settings={settings} onOpenSettings={() => setScreen('setup')} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0c10' },
  scroll: { padding: 20, paddingBottom: 80 },
  title: { color: '#e6e7ea', fontSize: 26, fontWeight: '700' },
  subtitle: { color: '#8a8f99', fontSize: 13, marginTop: 2 },
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
  label: { color: '#e6e7ea', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  input: {
    color: '#e6e7ea',
    backgroundColor: '#0f1218',
    borderColor: '#262a33',
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
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
  hint: { color: '#8a8f99', fontSize: 12, marginTop: 6, lineHeight: 18 },
  testResult: { borderRadius: 6, padding: 10, marginTop: 12 },
  testOk: { backgroundColor: '#0d2b1e' },
  testFail: { backgroundColor: '#2b0d0d' },
  testOkText: { color: '#3ecf8e', fontSize: 13 },
  testFailText: { color: '#e24d4d', fontSize: 13 },
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
  status: { color: '#8a8f99', fontSize: 13 },
  primary: {
    backgroundColor: '#7c9eff',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  primaryText: { color: '#0b0c10', fontWeight: '700', fontSize: 14 },
  secondary: {
    borderColor: '#262a33',
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  secondaryText: { color: '#e6e7ea', fontSize: 14 },
  danger: {
    backgroundColor: '#e24d4d',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  dangerText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.5 },
  settingsBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#151820',
    borderColor: '#262a33',
    borderWidth: 1,
  },
  settingsBtnText: { color: '#8a8f99', fontSize: 18 },
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
  paragraph: { color: '#e6e7ea', marginVertical: 4 },
  bullet_list: { color: '#e6e7ea' },
  ordered_list: { color: '#e6e7ea' },
  code_inline: { backgroundColor: '#262a33', color: '#e6e7ea', padding: 2, borderRadius: 3 },
  fence: { backgroundColor: '#0b0c10', color: '#e6e7ea', padding: 10, borderRadius: 6 },
  link: { color: '#7c9eff' },
};
