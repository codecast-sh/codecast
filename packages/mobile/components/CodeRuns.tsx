// A line the app composes ("4a6e413b2c landed on web dp-12") as the children
// of a Text: under Modern its code-like runs (ids, hashes, paths, files,
// flags; @codecast/shared/render/codeRuns) are set in mono inside the sans
// sentence. Classic gets the plain string, exactly as before.
import { useMemo } from 'react';
import { Text as RNText } from '@/components/Themed';
import { useActiveLook } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { splitCodeRuns } from '@codecast/shared/render/codeRuns';

export function CodeRuns({ text }: { text: string }) {
  const look = useActiveLook();
  const runs = useMemo(() => (look === 'modern' ? splitCodeRuns(text) : null), [look, text]);
  if (!runs || !runs.some((r) => r.code)) return <>{text}</>;
  return <>{runs.map((r, i) => (r.code ? <RNText key={i} style={codeFont}>{r.text}</RNText> : r.text))}</>;
}
