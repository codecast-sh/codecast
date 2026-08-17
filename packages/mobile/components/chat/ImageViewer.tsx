import { StyleSheet, View as RNView, Modal, Pressable, Image, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';

// Full-screen image viewing. A ScrollView with zoom (pinch on iOS, the
// platform's own gesture handling) inside a modal; tap anywhere outside the
// image or the ✕ to dismiss. Deliberately no share/save yet — viewing is the
// 95% case and everything else can ride the OS share sheet later.

export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  if (!uri) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <RNView style={styles.backdrop}>
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={styles.zoomContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          centerContent
        >
          <Pressable onPress={onClose}>
            <Image
              source={{ uri }}
              style={{ width, height: height * 0.82 }}
              resizeMode="contain"
            />
          </Pressable>
        </ScrollView>
        <TouchableOpacity style={styles.close} onPress={onClose} hitSlop={12}>
          <FontAwesome name="close" size={18} color="#FFFFFFAA" />
        </TouchableOpacity>
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000EE' },
  zoomContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  close: {
    position: 'absolute',
    top: 54,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF22',
  },
});
