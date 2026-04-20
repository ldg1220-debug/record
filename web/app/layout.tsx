import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ContextNote',
  description: '강의/회의 실시간 정리 노트',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
