// Every open approval, oldest first: the things the assistant is holding
// until the person says yes (web app/simple/approvals/page.tsx).
import { View } from 'react-native';
import { Text } from '@/components/Themed';
import { useLaneData } from '@codecast/web/components/simple/useLane';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { ApprovalCard } from '@/components/simple/ApprovalCard';
import { LaneTop, useTabBarClearance } from '@/components/simple/LaneChrome';
import { Empty, LanePage, Rise } from '@/components/simple/LaneUI';
import { useLaneTheme } from '@/components/simple/laneTheme';

const WORDS = LANE_COPY.approvals;

export default function SimpleApprovals() {
  const { s } = useLaneTheme();
  const { approvals, titles, ready } = useLaneData();
  return (
    <LanePage bottomInset={useTabBarClearance()}>
      <LaneTop />
      <Rise><Text style={s.pageTitle} accessibilityRole="header">{WORDS.title}</Text></Rise>
      <Rise i={1}><Text style={s.lede}>{WORDS.lede}</Text></Rise>
      {approvals.length === 0 ? (
        <Rise i={2}>
          <Empty>{ready ? WORDS.empty : WORDS.loading}</Empty>
        </Rise>
      ) : (
        <View style={{ gap: 14 }}>
          {approvals.map((d, n) => (
            <ApprovalCard key={d._id} decision={d} from={titles.get(String(d.conversation_id))} index={n + 2} />
          ))}
        </View>
      )}
    </LanePage>
  );
}
