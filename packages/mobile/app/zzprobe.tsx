// TEMP probe for the empty-state layout; delete after verifying.
import { FlatList, KeyboardAvoidingView, StyleSheet, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText, TextInput } from '@/components/Themed';
import { Stack, useLocalSearchParams } from 'expo-router';

export default function Probe() {
  const { fix } = useLocalSearchParams<{ fix?: string }>();
  const fixed = fix === '1';
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1, paddingTop: 200, backgroundColor: '#fdf6e3' }} behavior="padding">
        <FlatList
          style={{ flex: 1 }}
          data={[]}
          inverted
          renderItem={() => null}
          contentContainerStyle={[{ paddingBottom: 12 }, fixed ? { flexGrow: 1 } : { flex: 1 }]}
          ListEmptyComponent={
            <RNView style={[s.emptyState, fixed && { flex: undefined, flexGrow: 1 }]}>
              <FontAwesome name="comments-o" size={32} color="#93a1a1" />
              <RNText style={s.emptyStateText}>No messages yet</RNText>
              <RNText style={s.emptyStateSubtext}>Messages will appear here as the session progresses</RNText>
            </RNView>
          }
        />
        <RNView style={{ height: 110, borderTopWidth: 1, borderColor: '#ccc', padding: 12 }}>
          <TextInput autoFocus placeholder="Type a message..." />
        </RNView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyStateText: { fontSize: 15, fontWeight: '600', color: '#586e75' },
  emptyStateSubtext: { fontSize: 12, color: '#93a1a1', textAlign: 'center', paddingHorizontal: 40 },
});
