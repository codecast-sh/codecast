// The card a file gets on the phone when an agent sends one.
//
// Same delivery as the web (the daemon uploads the bytes and stamps the tool
// call — see the CLI's userFiles.ts), rendered for a thumb: the name, what it
// is, and one tap that opens it. Opening goes through openLink, so the file
// lands in the in-app browser, where iOS previews PDFs and images and offers
// its own share sheet for saving.

import { View as RNView, TouchableOpacity, Image } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import Feather from '@expo/vector-icons/Feather';
import { fileKind, formatFileSize, fileTypeLabel, type FileKind } from '@codecast/shared/files';
import { Theme } from '@/constants/Theme';
import { openLink } from '@/lib/links';

export type SentFileData = {
  name: string;
  media_type: string;
  size?: number;
  storage_id?: string;
  tool_use_id?: string;
  caption?: string;
  display?: string;
  error?: string;
};

const KIND_COLOR: Record<FileKind, string> = {
  image: Theme.magenta,
  pdf: Theme.red,
  video: Theme.violet,
  audio: Theme.violet,
  text: Theme.cyan,
  sheet: Theme.green,
  doc: Theme.blue,
  archive: Theme.yellow,
  binary: Theme.textMuted,
};

const ERROR_TEXT: Record<string, string> = {
  too_large: 'too large to attach',
  missing: 'the file was gone when this synced',
  upload_failed: 'the upload did not go through',
};

function FileCard({ file }: { file: SentFileData }) {
  const url = useQuery(
    api.images.getImageUrl,
    file.storage_id ? { storageId: file.storage_id as Id<'_storage'> } : 'skip',
  );
  const kind = fileKind(file.media_type, file.name);
  const color = KIND_COLOR[kind];
  const label = fileTypeLabel(file.name, file.media_type);
  const meta = [label, file.size ? formatFileSize(file.size) : ''].filter(Boolean).join(' · ');
  const undelivered = !!file.error;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={!url}
      onPress={() => url && openLink(url)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginVertical: 3,
        borderRadius: 10,
        borderWidth: 0.5,
        borderColor: Theme.border + '60',
        backgroundColor: Theme.card,
      }}
    >
      {kind === 'image' && url ? (
        <Image source={{ uri: url }} style={{ width: 40, height: 40, borderRadius: 6 }} />
      ) : (
        <RNView
          style={{
            width: 40,
            height: 40,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color + '18',
            borderWidth: 0.5,
            borderColor: color + '40',
          }}
        >
          <RNText style={{ fontSize: 9, fontWeight: '700', color }}>{label.slice(0, 4)}</RNText>
        </RNView>
      )}

      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={{ fontSize: 13, fontWeight: '600', color: Theme.text }} numberOfLines={1}>
          {file.name}
        </RNText>
        <RNText style={{ fontSize: 11, color: Theme.textDim }} numberOfLines={1}>
          {undelivered ? `${meta} — ${ERROR_TEXT[file.error ?? ''] ?? 'not attached'}` : meta}
        </RNText>
      </RNView>

      {!!url && <Feather name="external-link" size={14} color={Theme.textMuted} />}
    </TouchableOpacity>
  );
}

export function SentFileBlock({ files }: { files: SentFileData[] }) {
  if (files.length === 0) return null;
  const caption = files.find(f => f.caption)?.caption;
  return (
    <RNView style={{ paddingVertical: 2 }}>
      <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Feather name="download" size={10} color={Theme.textDim} />
        <RNText style={{ fontSize: 11, color: Theme.textDim }}>
          {files.length === 1 ? 'Sent you a file' : `Sent you ${files.length} files`}
        </RNText>
      </RNView>
      {!!caption && (
        <RNText style={{ fontSize: 13, color: Theme.textMuted, marginTop: 2 }}>{caption}</RNText>
      )}
      {files.map((file, i) => (
        <FileCard key={`${file.storage_id ?? file.name}-${i}`} file={file} />
      ))}
    </RNView>
  );
}
