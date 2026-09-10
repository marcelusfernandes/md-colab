import type { Metadata } from 'next';
import { DocumentWorkspace } from '@/components/document-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Seus documentos — md-colab',
  description: 'Acesse seus planos Markdown privados e compartilhados.',
  robots: { index: false, follow: false },
};

export default function DocumentsPage() {
  return <DocumentWorkspace />;
}
