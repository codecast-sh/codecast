import React, { useState } from 'react';
import { StyleSheet, ScrollView, TouchableOpacity, View as RNView, Modal } from 'react-native';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { copyToClipboard } from '@/lib/clipboard';
import { useTheme } from '@/constants/Theme';
import { HighlightedCodeText } from './CodeText';
import { OutsideMessage } from './MessageLongPress';

// The fullscreen view a markdown code block expands into: every line numbered,
// scrolling both ways, with copy. MarkdownRenderer.tsx re-exports it.

export function CodeBlockFullscreen({ content, language, visible, onClose }: { content: string; language: string; visible: boolean; onClose: () => void }) {
  const Theme = useTheme();
  const [copied, setCopied] = useState(false);
  const lines = content.split('\n');
  if (!visible) return null;
  return (
<OutsideMessage>
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <RNView style={{ flex: 1, backgroundColor: '#002b36' }}>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <RNText style={{ fontSize: 12, color: '#93a1a1', fontFamily: 'JetBrainsMono-Regular', fontWeight: '500' }}>{language}</RNText>
            <RNText style={{ fontSize: 10, color: Theme.textDim }}>{lines.length} lines</RNText>
          </RNView>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => { copyToClipboard(content); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setCopied(true); setTimeout(() => setCopied(false), 1500); }} activeOpacity={0.6}>
              {copied ? <FontAwesome name="check" size={14} color={Theme.green} /> : <FontAwesome name="clipboard" size={14} color="#657b83" />}
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} activeOpacity={0.6}>
              <FontAwesome name="close" size={16} color="#93a1a1" />
            </TouchableOpacity>
          </RNView>
        </RNView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
            <RNView style={{ flexDirection: 'row' }}>
              <RNView style={codeStyles.lineNumberGutter}>
                {lines.map((_, i) => (
                  <RNText key={i} style={[codeStyles.lineNumber, { lineHeight: 20, color: '#657b83' }]}>{i + 1}</RNText>
                ))}
              </RNView>
              <HighlightedCodeText content={content} style={[codeStyles.codeText, { lineHeight: 20 }]} />
            </RNView>
          </ScrollView>
        </ScrollView>
      </RNView>
    </Modal>
    </OutsideMessage>
  );
}

const codeStyles = StyleSheet.create({
  lineNumberGutter: {
    paddingRight: 8,
    marginRight: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.1)',
  },
  lineNumber: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    textAlign: 'right',
    minWidth: 24,
  },
  codeText: {
    fontSize: 12,
    fontFamily: 'JetBrainsMono-Regular',
    color: '#93a1a1',
  },
});
