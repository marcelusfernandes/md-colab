import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing-page';

export const metadata: Metadata = {
  title: 'md-colab — Planos Markdown com crítica humana',
  description:
    'Compartilhe planos Markdown, convide pessoas para criticar e mantenha a decisão de execução com o autor.',
  robots: { index: true, follow: true },
};

export default function Home() {
  return <LandingPage />;
}
