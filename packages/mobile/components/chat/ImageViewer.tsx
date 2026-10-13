import { ImageGallery } from '@/components/ImageGallery';

// Full-screen view of one chat image: the session gallery with a single page.
const identity = (uri: string) => uri;

export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  return <ImageGallery items={uri ? [uri] : []} useSrc={identity} initialIndex={0} visible={!!uri} onClose={onClose} />;
}
