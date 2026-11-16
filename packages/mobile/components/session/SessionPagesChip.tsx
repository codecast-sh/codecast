// The session header's Pages chip: how many pages this session published,
// beside its Images chip, as the web header draws both. One page opens on a
// tap; several open a list to pick from, newest first.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { OptionSheet } from '@/components/OptionSheet';
import { chipShell, chipQuiet, chipText, CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { openLink } from '@/lib/links';
import { useSessionPages } from '@codecast/web/hooks/useSessionPages';
import { pageShareUrl } from '@codecast/shared/entities';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { usePageEmbedQuery, type PageInfo } from '@codecast/web/hooks/pageEmbedQuery';
import { useConvexAuth } from 'convex/react';
import { mobileRelativeTime } from '@codecast/shared/render/mobileSessionStyle';

export function SessionPagesChip({ conversationId }: { conversationId: string | null }) {
  const Theme = useTheme();
  const pages = useSessionPages(conversationId);
  // Titles for the list. Asked once Convex has the sign-in, so the rows carry
  // this viewer's gate tokens like every other embed of the same page.
  const { isAuthenticated } = useConvexAuth();
  usePageEmbedQuery(useMemo(
    () => (isAuthenticated && pages.length ? { pages: pages.map((p) => ({ slug: p.page })) } : 'skip' as const),
    [isAuthenticated, pages],
  ));
  const embeds = useInboxStore((s) => (s as any).pageEmbeds) as Record<string, PageInfo> | undefined;
  const [listVisible, setListVisible] = useState(false);
  const live = useMemo(() => pages.filter((p) => !embeds?.[p.page]?.missing).reverse(), [pages, embeds]);
  if (live.length === 0) return null;
  const open = (slug: string) => { void openLink(pageShareUrl(slug)); };
  return (
    <>
      <Pressable
        onPress={() => (live.length === 1 ? open(live[0].page) : setListVisible(true))}
        style={styles.chip}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={live.length === 1 ? 'Open the published page' : `${live.length} published pages`}
      >
        <FontAwesome name="window-maximize" size={10} color={Theme.cyan} />
        <RNText style={styles.text} maxFontSizeMultiplier={CHROME_FONT_CAP}>
          {live.length === 1 ? 'Page' : `${live.length} pages`}
        </RNText>
      </Pressable>
      <OptionSheet
        visible={listVisible}
        onClose={() => setListVisible(false)}
        title="Published pages"
        selectedKey={null}
        onSelect={open}
        options={live.map((p) => ({
          key: p.page,
          label: embeds?.[p.page]?.title || p.page,
          hint: p.timestamp ? mobileRelativeTime(p.timestamp) : undefined,
          leading: <FontAwesome name="window-maximize" size={13} color={Theme.cyan} style={styles.rowIcon} />,
        }))}
      />
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  chip: { ...chipShell, ...chipQuiet(Theme) },
  text: { ...chipText, color: Theme.textMuted },
  rowIcon: { width: 20, marginRight: 10 },
}));
