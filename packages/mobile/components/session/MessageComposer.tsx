// The phone's message composer: a full-width text box over a row of attach,
// status and send, the images picked for the turn, and a full-screen editor
// once the text wraps. The session screen's reply box (app/session/[id]) and
// the new session sheet's first message both draw it, so a first message can
// carry what a reply can.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, ScrollView, TouchableOpacity, KeyboardAvoidingView, Platform, View as RNView, Image, ActivityIndicator, Modal, useWindowDimensions, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useConvex } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TextInput, Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, chipText, themedStyles, useTheme } from '@/constants/Theme';
import { TYPE_SCALE } from '@codecast/shared/render/typeScale';
import { MOBILE_SESSION_STYLE as S } from '@codecast/shared/render/mobileSessionStyle';
import { mixColor } from '@/lib/solColor';
import { GestureHandlerRootView, NativePressable } from '@/lib/gestureHandler';
import { PulsingDot } from '@/components/SessionItem';
import { ImageGallery } from '@/components/ImageGallery';
import { useInboxStore, type OptimisticImage } from '@codecast/web/store/inboxStore';
import { awaitUpload, releaseUpload } from '@codecast/web/lib/pendingUploads';
import { insertImagePlaceholder, dropImagePlaceholder } from '@codecast/web/lib/imagePlaceholder';
import { startUpload, forgetUpload, chooseImageSource, pickImages } from '@/components/chat/chatUpload';
import { beginScreenRecording, discardScreenRecording, pickScreenRecording, recordingUpload, screenRecordingContent, type BegunRecording, type PickedRecording } from '@/lib/screenRecordingSend';
import { formatCallTime } from '@codecast/shared/contracts';
import type { useComposerField } from '@/lib/composerField';
import { appAlert } from '@/lib/popups';
import { useDictation } from '@/lib/dictation';
import { DictateControls } from '@/components/DictateControls';

// A send with attachments and no text carries this as its content.
export const IMAGE_ONLY_CONTENT = '[image]';

export type ComposerSuggestion = { text: string; onUse: () => void };

export type ComposerImage = { uri: string; mime: string; width?: number; height?: number; storageId?: string; uploading: boolean };

/** A screen recording attached to the turn: named by the server once
 *  `begun`, its bytes on their way until `uploaded`. */
export type ComposerRecording = PickedRecording & { begun: BegunRecording | null; uploaded: boolean };

// The optimistic-send core behind the composer's send button: pending row
// in the store instantly, fire-and-forget delivery via the outbox (after the
// create lands, when this is a session started a moment ago). An image still
// uploading rides the bubble as its local preview; the send goes out once
// the uploads settle, the same detached path as web MessageInput.
// `typed`: the words the person typed in a composer, so the server marks that
// part of the send theirs (composerChannel); product-assembled sends leave it out.
export function dispatchComposerSend(conversationId: string, content: string, images?: OptimisticImage[], typed?: string) {
  const store = useInboxStore.getState();
  const clientId = store.addOptimisticMessage(conversationId, content, images?.length ? images : undefined);
  if (!images?.some(img => img.uploading)) {
    const ids = images?.map(img => img.storage_id!) ?? [];
    store.sendMessageWhenReady(conversationId, content, ids.length ? ids : undefined, clientId, typed);
    return;
  }
  void (async () => {
    const settled = await Promise.all(images.map(async (img): Promise<OptimisticImage> =>
      img.uploading ? { media_type: img.media_type, storage_id: (await awaitUpload(img.preview_url)) ?? undefined } : img));
    images.forEach(img => releaseUpload(img.preview_url));
    const resolved = settled.filter(img => img.storage_id);
    const s = useInboxStore.getState();
    // Every upload failed and there was no text: nothing real to send.
    if (resolved.length === 0 && content === IMAGE_ONLY_CONTENT) {
      s.markOptimisticAsFailed(conversationId, clientId);
      return;
    }
    s.resolvePendingUploads(conversationId, clientId, resolved);
    s.sendMessageWhenReady(conversationId, content, resolved.length ? resolved.map(img => img.storage_id!) : undefined, clientId, typed);
  })();
}

/** The images attached to the turn being written, uploading as soon as they
 *  are picked, each with an `[Image N]` token in the text (unless
 *  `placeholders` is false: a chat message carries its images beside the
 *  words, not referenced from them). */
export function useComposerImages(setMessage: (update: (text: string) => string) => void, opts: { recordingsTo?: string; placeholders?: boolean } = {}) {
  const placeholders = opts.placeholders !== false;
  // The session a screen recording would go to; none offers no recording.
  const allowRecording = !!opts.recordingsTo;
  const convex = useConvex();
  const [selectedImages, setSelectedImages] = useState<ComposerImage[]>([]);
  // Mirrors the web composer's pastedImagesRef: the `[Image N]` token paths
  // need each image's current position, and a state read inside an async
  // callback or a state updater would be stale (or double-fire in StrictMode).
  const selectedImagesRef = useRef(selectedImages);
  selectedImagesRef.current = selectedImages;

  // Drops the image and its `[Image N]` token, renumbering the tokens above it
  // so what's left still points at the attachments the agent will receive.
  const removeImage = (uri: string) => {
    const index = selectedImagesRef.current.findIndex(img => img.uri === uri);
    if (index < 0) return;
    selectedImagesRef.current = selectedImagesRef.current.filter(img => img.uri !== uri);
    setSelectedImages(selectedImagesRef.current);
    forgetUpload(uri);
    if (placeholders) setMessage(m => dropImagePlaceholder(m, index + 1));
  };

  // Adds local image files to the turn: each gets an `[Image N]` token in
  // attach order (the order the agent receives them) and starts uploading.
  const attachImages = (picked: Array<{ uri: string; mime: string; width?: number; height?: number }>) => {
    for (const { uri, mime, width, height } of picked) {
      if (selectedImagesRef.current.some(img => img.uri === uri)) continue;
      // Ref-first so a multi-pick batch numbers sequentially: the state
      // updates are async, so `selectedImages` is still the old array here.
      // The number is taken now: the text updater runs after the whole batch,
      // when the ref already counts every image (two picks both read 2).
      selectedImagesRef.current = [...selectedImagesRef.current, { uri, mime, width, height, uploading: true }];
      setSelectedImages(selectedImagesRef.current);
      const n = selectedImagesRef.current.length;
      if (placeholders) setMessage(m => insertImagePlaceholder(m, m.length, n).text);
      // Registered in pendingImageUploads under the uri, so a send pressed
      // before the bytes land still finds the upload (dispatchComposerSend).
      startUpload(convex, { uri, mime }).then(storageId => {
        if (storageId) {
          setSelectedImages(prev => prev.map(img => img.uri === uri ? { ...img, storageId, uploading: false } : img));
          return;
        }
        removeImage(uri);
        appAlert('Upload failed', 'Could not upload image');
      });
    }
  };

  // One screen recording per turn: a second pick replaces the first.
  const [recording, setRecording] = useState<ComposerRecording | null>(null);
  const attachRecording = async () => {
    const picked = await pickScreenRecording();
    if (!picked) return;
    // A second pick replaces the first, which is taken back.
    if (recording?.begun) discardScreenRecording(convex, recording.begun);
    setRecording({ ...picked, begun: null, uploaded: false });
    const begun = await beginScreenRecording(convex, picked, opts.recordingsTo!);
    const mine = (r: ComposerRecording | null) => r?.uri === picked.uri;
    if (!begun) {
      setRecording((r) => (mine(r) ? null : r));
      return;
    }
    setRecording((r) => (mine(r) ? { ...r!, begun } : r));
    const ok = await recordingUpload(picked.uri);
    setRecording((r) => (mine(r) ? (ok ? { ...r!, uploaded: true } : null) : r));
  };

  const pickImage = async () => {
    const source = await chooseImageSource({ screenRecording: allowRecording });
    if (!source) return;
    if (source === 'screen-recording') return void attachRecording();
    const picked = await pickImages(source);
    if (picked.length) attachImages(picked);
  };

  /** The picked images as the send carries them: uploaded ones by storage id,
   *  the rest as local previews the send waits on. */
  const optimisticImages = (): OptimisticImage[] => selectedImages.map(img => img.storageId
    ? { media_type: img.mime, storage_id: img.storageId }
    : { media_type: img.mime, preview_url: img.uri, uploading: true });

  /** The turn's text with its recording, when one is attached and named. */
  const withRecording = (text: string) => (recording?.begun ? screenRecordingContent(recording.begun, recording, text) : text);

  return {
    selectedImages, pickImage, attachImages, removeImage, optimisticImages,
    recording,
    removeRecording: () => {
      if (recording?.begun) discardScreenRecording(convex, recording.begun);
      setRecording(null);
    },
    withRecording,
    /** Something besides text the send would carry. */
    attached: selectedImages.length > 0 || !!recording?.begun,
    clearImages: () => { setSelectedImages([]); setRecording(null); },
  };
}

export type ComposerStatus = { color: string; dot?: string; label: string };

const composerImageSrc = (img: ComposerImage) => img.uri;

/** A button in the composer's bottom row beside attach (chat's mention and
 *  emoji): the same size and weight as attach, lit while `on`. */
export function ComposerTool({ icon, label, onPress, on }: {
  icon: ComponentProps<typeof Feather>['name'];
  label: string;
  onPress: () => void;
  on?: boolean;
}) {
  const Theme = useTheme();
  return (
    <TouchableOpacity
      style={[styles.toolButton, on && styles.toolButtonOn]}
      onPress={onPress}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { selected: on }}
    >
      <Feather name={icon} size={18} color={on ? Theme.text : Theme.textMuted} />
    </TouchableOpacity>
  );
}

export function MessageComposer({
  field, images, placeholder, placeholderColor, canSend, onSend, sendIcon = 'arrow-up', stop, status, attach = true,
  tools, error, onDismissError, suggestion, above, cardStyle, inputStyle, onFocusChange,
}: {
  field: ReturnType<typeof useComposerField>;
  images: ReturnType<typeof useComposerImages>;
  placeholder: string;
  placeholderColor?: string;
  canSend: boolean;
  onSend: () => void;
  /** `check` while the send saves an edit. */
  sendIcon?: 'arrow-up' | 'check';
  /** Present while a turn can be stopped: an empty box's send becomes Stop. */
  stop?: { label: string; onPress: () => void } | null;
  /** Said in the otherwise empty middle of the button row. */
  status?: ComposerStatus | null;
  attach?: boolean;
  /** More buttons for the bottom row, after attach (ComposerTool). */
  tools?: ReactNode;
  error?: string | null;
  onDismissError?: () => void;
  /** A suggested reply for the empty box, shown where the words would go. */
  suggestion?: ComposerSuggestion | null;
  /** Rows that sit just above the card (slash commands). */
  above?: ReactNode;
  cardStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  /** The inline box gained or lost focus (the owners strip shows while it has it). */
  onFocusChange?: (focused: boolean) => void;
}) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winHeight } = useWindowDimensions();
  const { value: message, onChangeText, epoch, inputRef } = field;
  const [expanded, setExpanded] = useState(false);
  // Content height of the inline input; the fullscreen affordance only appears
  // once the text actually wraps, so a one-liner keeps the card minimal.
  const [inputHeight, setInputHeight] = useState(0);
  // A send remounts the box (epoch), which starts it short and inline again.
  useEffect(() => {
    setInputHeight(0);
    setExpanded(false);
  }, [epoch]);
  // Speech into the box, through the same setter typing uses. A send pressed
  // mid-recording waits for the last words, then sends what the box holds
  // (the latest onSend, whose closure has them).
  const dictation = useDictation({ value: message, onChangeText, inputRef, resetKey: epoch });
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const send = () => dictation.send(() => onSendRef.current());
  const showStop = !canSend && !!stop && !dictation.active;
  // The suggestion owns the empty box: its text is the placeholder, so it
  // wraps and grows the box like typed words, and typing replaces it.
  const ghost = !message && !showStop && !dictation.active ? suggestion ?? null : null;
  // The picked image open full screen, by its place in the strip.
  const [viewing, setViewing] = useState<number | null>(null);

  // Shared between the inline card and the fullscreen editor so both modes show
  // the same attachments/errors and drive the same send.
  const errorBannerEl = error ? (
    <RNView style={styles.errorBanner}>
      <RNText style={styles.errorBannerText}>{error}</RNText>
      <TouchableOpacity onPress={onDismissError}>
        <RNText style={styles.errorBannerDismiss}>x</RNText>
      </TouchableOpacity>
    </RNView>
  ) : null;

  // 'always', as every strip in the composer: a tap here never puts the
  // keyboard away, even on a preview between its remove buttons.
  const rec = images.recording;
  const imageStripEl = images.selectedImages.length > 0 || rec ? (
    <ScrollView horizontal style={styles.imagePreviewContainer} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
      {rec && (
        <RNView style={[styles.imagePreview, styles.recordingTile]} accessibilityLabel={`Screen recording, ${formatCallTime(rec.durationMs)}`}>
          <Feather name="video" size={18} color={Theme.text} />
          <RNText style={styles.recordingTileTime}>{formatCallTime(rec.durationMs)}</RNText>
          {!rec.uploaded && (
            <RNView style={styles.imageUploadingOverlay}>
              <ActivityIndicator size="small" color="#fff" />
            </RNView>
          )}
          <TouchableOpacity
            style={styles.removeImageButton}
            onPress={images.removeRecording}
            activeOpacity={0.7}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Remove recording"
          >
            <Feather name="x" size={12} color="#fff" />
          </TouchableOpacity>
        </RNView>
      )}
      {images.selectedImages.map((img, index) => (
        <RNView key={index} style={styles.imagePreview}>
          <TouchableOpacity activeOpacity={0.8} onPress={() => setViewing(index)} accessibilityRole="imagebutton" accessibilityLabel="View image">
            <Image source={{ uri: img.uri }} style={styles.previewImage} />
          </TouchableOpacity>
          {img.uploading && (
            <RNView style={styles.imageUploadingOverlay}>
              <ActivityIndicator size="small" color="#fff" />
            </RNView>
          )}
          <TouchableOpacity
            style={styles.removeImageButton}
            onPress={() => images.removeImage(img.uri)}
            activeOpacity={0.7}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Remove image"
          >
            <Feather name="x" size={12} color="#fff" />
          </TouchableOpacity>
        </RNView>
      ))}
    </ScrollView>
  ) : null;

  // iOS presents a modal only from the frontmost one, so the gallery opens
  // from whichever of the inline card and the fullscreen editor is showing.
  const galleryEl = (inEditor: boolean) => (
    <ImageGallery
      items={images.selectedImages}
      useSrc={composerImageSrc}
      initialIndex={viewing ?? 0}
      visible={viewing !== null && expanded === inEditor && images.selectedImages.length > 0}
      onClose={() => setViewing(null)}
    />
  );

  const actionsRowEl = (
    <RNView style={styles.composerActions}>
      {attach ? (
        <TouchableOpacity style={styles.imageButton} onPress={images.pickImage} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="Attach image">
          <Feather name="plus" size={18} color={Theme.textMuted} />
        </TouchableOpacity>
      ) : null}
      {tools}
      <RNView style={styles.composerSpacer}>
        {status && (
          <RNView style={styles.composerStatus}>
            <PulsingDot color={status.dot ?? status.color} />
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} numberOfLines={2} style={[styles.composerStatusText, { color: status.color, flexShrink: 1 }]}>
              {status.label}
            </RNText>
          </RNView>
        )}
      </RNView>
      {ghost && (
        <RNView style={styles.suggestionActions}>
          <TouchableOpacity style={styles.suggestionChip} onPress={ghost.onUse} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="Use suggestion">
            <Feather name="corner-down-left" size={12} color={Theme.text} />
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.suggestionChipText, { color: Theme.text }]}>Use</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      <DictateControls dictation={dictation} />
      {/* Never `disabled` — a disabled TouchableOpacity drops the tap, and on a
          new session the JS thread is often still catching up (create, cache
          write, keyboard) while the native field already shows text. Keep the
          grey look; onSend no-ops if the box is still empty. */}
      {/* While the agent works and the box is empty, the send slot becomes
          stop: the same interrupt web's Escape sends. Typing turns it back
          into send, so a follow-up can always be queued. */}
      <NativePressable
        style={[styles.sendButton, showStop ? styles.stopButton : !canSend && styles.sendButtonDisabled]}
        onPress={showStop ? stop!.onPress : send}
        activeOpacity={0.7}
        delayPressIn={0}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        pressRetentionOffset={{ top: 20, bottom: 20, left: 20, right: 20 }}
        accessibilityRole="button"
        accessibilityLabel={showStop ? stop!.label : 'Send'}
      >
        {showStop
          ? <FontAwesome name="stop" size={11} color="#fff" />
          : <FontAwesome name={sendIcon} size={14} color="#fff" />}
      </NativePressable>
    </RNView>
  );

  return (
    <>
      {errorBannerEl}
      {imageStripEl}
      {galleryEl(false)}
      {above}
      <RNView style={[styles.composerCard, cardStyle]}>
        <TextInput
          key={epoch}
          ref={inputRef}
          style={[
            styles.textInput,
            // Grow with the text up to a third of the screen; beyond that it scrolls.
            { maxHeight: Math.round(winHeight * 0.33) },
            inputStyle,
            inputHeight > 44 && !!message && styles.textInputWithExpand,
          ]}
          value={message}
          onChangeText={onChangeText}
          onSelectionChange={dictation.onSelectionChange}
          onFocus={onFocusChange ? () => onFocusChange(true) : undefined}
          onBlur={onFocusChange ? () => onFocusChange(false) : undefined}
          placeholder={dictation.placeholder(ghost?.text ?? placeholder)}
          placeholderTextColor={ghost ? Theme.textMuted0 : placeholderColor ?? Theme.textMuted0}
          multiline
          maxLength={10000}
          blurOnSubmit={false}
          maxFontSizeMultiplier={CHROME_FONT_CAP}
          onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
        />
        {/* Only typed text earns it: a long placeholder (a held month's
            sentence) wraps too, and has nothing to expand. */}
        {inputHeight > 44 && !!message && (
          <TouchableOpacity
            style={styles.expandButton}
            onPress={() => setExpanded(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Expand composer to full screen"
          >
            <FontAwesome name="expand" size={12} color={Theme.textMuted} />
          </TouchableOpacity>
        )}
        {actionsRowEl}
      </RNView>

      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)}>
        {/* Android renders a Modal outside the app's root view; the send
            button is a gesture-handler touchable and needs its own root. */}
        <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.expandedContainer}
        >
          <RNView style={[styles.expandedInner, { paddingTop: insets.top + 6, paddingBottom: insets.bottom || 12 }]}>
            <RNView style={styles.expandedHeader}>
              <TouchableOpacity
                style={styles.expandButtonStatic}
                onPress={() => setExpanded(false)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Collapse composer"
              >
                <FontAwesome name="compress" size={13} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
            {errorBannerEl}
            {imageStripEl}
            {galleryEl(true)}
            <TextInput
              key={epoch}
              style={styles.expandedInput}
              value={message}
              onChangeText={onChangeText}
              onSelectionChange={dictation.onSelectionChange}
              placeholder={dictation.placeholder(placeholder)}
              placeholderTextColor={placeholderColor ?? Theme.textMuted0}
              multiline
              autoFocus
              maxLength={10000}
              blurOnSubmit={false}
              maxFontSizeMultiplier={CHROME_FONT_CAP}
            />
            {actionsRowEl}
          </RNView>
        </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}

const styles = themedStyles((Theme, look) => StyleSheet.create({
  errorBanner: {
    backgroundColor: Theme.red,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: 13,
    flex: 1,
  },
  errorBannerDismiss: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    paddingLeft: 12,
  },
  imagePreviewContainer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    maxHeight: 120,
    flexGrow: 0,
  },
  imagePreview: {
    position: 'relative',
    marginRight: 8,
  },
  previewImage: {
    width: 80,
    height: 80,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  recordingTile: {
    width: 80,
    height: 80,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 4,
  },
  recordingTileTime: {
    fontSize: 11,
    color: Theme.textDim,
    fontVariant: ['tabular-nums'],
  },
  imageUploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  removeImageButton: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  imageButton: {
    ...S.imageButton,
    borderRadius: 16,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  toolButton: {
    ...S.imageButton,
    borderRadius: 16,
    marginLeft: 4,
  },
  toolButtonOn: {
    backgroundColor: Theme.bgHighlight,
  },
  // One rounded card: full-width input on top, action row underneath. Buttons
  // living below the text (not beside it) is what gives the input the whole
  // screen width, matching the web/reference composer.
  composerCard: {
    ...S.composerCard,
    backgroundColor: Theme.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  composerActions: S.composerActions,
  composerSpacer: S.composerSpacer,
  composerStatus: S.composerStatus,
  composerStatusText: chipText,
  suggestionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginRight: 8,
  },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 32,
    paddingHorizontal: 11,
    borderRadius: 16,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  suggestionChipText: {
    ...chipText,
    color: Theme.textMuted,
  },
  textInput: {
    ...S.textInput,
    color: Theme.text,
    // maxHeight is set inline from the window height (grows to ~1/3 screen).
  },
  // Keeps wrapped text clear of the floating expand button in the top-right.
  textInputWithExpand: {
    paddingRight: 44,
  },
  expandButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bgHighlight,
  },
  expandButtonStatic: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bgHighlight,
  },
  expandedContainer: {
    flex: 1,
    backgroundColor: Theme.bgAlt,
  },
  expandedInner: {
    flex: 1,
    paddingHorizontal: 6,
  },
  expandedHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 6,
    paddingBottom: 2,
  },
  expandedInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingTop: 6,
    color: Theme.text,
    fontSize: look === 'modern' ? TYPE_SCALE.read.size : 16,
    lineHeight: look === 'modern' ? TYPE_SCALE.read.lineHeight : 24,
    textAlignVertical: 'top',
  },
  sendButton: {
    ...S.sendButton,
    minWidth: 32,
    height: 32,
    borderRadius: 16,
    paddingLeft: 9,
    paddingRight: 9,
    backgroundColor: mixColor(Theme.blue, 80, Theme.text),
  },
  sendButtonDisabled: {
    backgroundColor: Theme.bgHighlight,
  },
  stopButton: {
    backgroundColor: mixColor(Theme.red, 80, Theme.text),
  },
}));
