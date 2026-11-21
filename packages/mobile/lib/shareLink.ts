import { Platform, Share } from 'react-native';

/** Open the system share sheet on one link. iOS reads `url` as the link and
 *  would add `message` as a second one ("2 Links"); Android has no `url`, so
 *  there the link rides as the message. */
export function shareLink(url: string): void {
  void Share.share(Platform.OS === 'ios' ? { url } : { message: url }).catch(() => {});
}
