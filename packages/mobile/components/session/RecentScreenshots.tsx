// The screenshots taken in the last day, under the new session sheet's
// composer: a screenshot is usually why a session starts. A tap on one opens
// it full screen; its + badge attaches it.
//
// Reads the library only when the person has already granted access (the
// attach button asks for it); opening the sheet never prompts. A binary built
// before expo-media-library shipped draws nothing.
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, ScrollView, TouchableOpacity, View as RNView, Image } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { themedStyles } from '@/constants/Theme';
import { optionalNative } from '@/lib/optionalNative';
import { ImageGallery } from '@/components/ImageGallery';

const MediaLibrary: typeof import('expo-media-library') | null = optionalNative(
  'ExpoMediaLibrary',
  () => require('expo-media-library'),
);

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SHOTS = 8;

type Shot = { id: string; uri: string; mime: string };

const shotSrc = (shot: Shot) => shot.uri;

async function loadRecentScreenshots(): Promise<Shot[]> {
  // The screenshot subtype is an iOS Photos notion.
  if (!MediaLibrary || Platform.OS !== 'ios') return [];
  const perm = await MediaLibrary.getPermissionsAsync();
  if (!perm.granted) return [];
  const page = await MediaLibrary.getAssetsAsync({
    first: MAX_SHOTS,
    mediaType: MediaLibrary.MediaType.photo,
    mediaSubtypes: ['screenshot'],
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    createdAfter: Date.now() - WINDOW_MS,
  });
  // A library asset's uri is ph://, which neither Image nor the upload's fetch
  // reads; its info carries the file:// copy.
  const shots = await Promise.all(page.assets.map(async (asset) => {
    const info = await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: false }).catch(() => null);
    if (!info?.localUri) return null;
    const mime = /\.png$/i.test(asset.filename) ? 'image/png' : 'image/jpeg';
    return { id: asset.id, uri: info.localUri, mime };
  }));
  return shots.filter((s): s is Shot => !!s);
}

export function RecentScreenshots({ attachedUris, onAttach }: {
  /** Already in the composer: those drop out of the row. */
  attachedUris: string[];
  onAttach: (shot: { uri: string; mime: string }) => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    let live = true;
    loadRecentScreenshots().then((s) => { if (live) setShots(s); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const [viewing, setViewing] = useState<number | null>(null);

  const offered = shots.filter((s) => !attachedUris.includes(s.uri));
  if (offered.length === 0) return null;
  const attach = (shot: Shot) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAttach(shot);
  };
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.row} contentContainerStyle={styles.rowContent}>
        {offered.map((shot, index) => (
          <RNView key={shot.id}>
            <TouchableOpacity
              activeOpacity={0.8}
              accessibilityRole="imagebutton"
              accessibilityLabel="View screenshot"
              onPress={() => setViewing(index)}
            >
              <Image source={{ uri: shot.uri }} style={styles.thumb} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.badge}
              hitSlop={8}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Attach screenshot"
              onPress={() => attach(shot)}
            >
              <Feather name="plus" size={13} color="#fff" />
            </TouchableOpacity>
          </RNView>
        ))}
      </ScrollView>
      <ImageGallery
        items={offered}
        useSrc={shotSrc}
        initialIndex={viewing ?? 0}
        visible={viewing !== null}
        onClose={() => setViewing(null)}
      />
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  row: {
    flexGrow: 0,
    marginTop: 8,
  },
  rowContent: {
    gap: 8,
    paddingRight: 8,
  },
  thumb: {
    width: 56,
    height: 100,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  badge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
}));
