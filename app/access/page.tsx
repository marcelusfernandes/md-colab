import type { Metadata } from 'next';
import { ConfirmAccess } from '@/components/email-login';

export const metadata: Metadata = {
  title: 'Confirmar acesso — md-colab',
  robots: { index: false, follow: false },
};

export default function AccessPage() {
  return <ConfirmAccess />;
}
