import { DocumentWorkspace } from '@/components/document-workspace';
export const dynamic = 'force-dynamic';
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DocumentWorkspace key={id} documentId={id} />;
}
