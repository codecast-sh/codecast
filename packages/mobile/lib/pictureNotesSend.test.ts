import { beforeEach, describe, expect, test } from 'bun:test';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { addImagePin, attachReviewForSend, composerMarkers, createReviewComment, quotedImages, type ComposerPicture } from '@codecast/web/lib/reviewActions';
import { base64Bytes, composePictureSend, fittedSize, snapshotPlan } from './pictureNotesSend';

const CONV = 'conv-phone-notes';

// Two transcript pictures (one pinned twice), a pin on the second composer
// picture, and a quote with a text note: the batch a phone send takes.
function seedBatch() {
  useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewEditingId: null } as any);
  const s = useInboxStore.getState();
  const shotA = { src: 'https://cdn.example/a.png', storageId: 'sA', messageId: 'm1', width: 1600, height: 900 };
  const shotB = { src: 'https://cdn.example/b.png', storageId: 'sB', messageId: 'm2', width: 800, height: 1200 };
  s.commitReviewComment(CONV, addImagePin(CONV, shotA, { x: 0.25, y: 0.5 }), 'this button is misaligned');
  s.commitReviewComment(CONV, addImagePin(CONV, shotB, { x: 0.9, y: 0.1 }), 'wrong color');
  s.commitReviewComment(CONV, addImagePin(CONV, shotA, { x: 0.75, y: 0.2 }), 'and this badge');
  s.commitReviewComment(CONV, addImagePin(CONV, { src: 'file:///pick/two.jpg', attached: true }, { x: 0.5, y: 0.25 }), 'label cut off');
  s.commitReviewComment(CONV, createReviewComment(CONV, 'm1', 0, 'a paragraph the agent wrote'), 'not this');
  // Pins made in one millisecond tie on createdAt; batch order breaks the tie
  // the same way on every seed.
  const rows = useInboxStore.getState().reviewComments[CONV];
  useInboxStore.setState({ reviewComments: { [CONV]: rows.map((c, i) => ({ ...c, createdAt: i })) } } as any);
}

// The composer as the phone holds it: the second picture's upload landed
// after it was pinned, so it matches by address and by stored file alike.
const composer = [
  { uri: 'file:///pick/one.jpg', mime: 'image/jpeg', storageId: 'c1', width: 3000, height: 2000 },
  { uri: 'file:///pick/two.jpg', mime: 'image/jpeg', storageId: 'c2', width: 1000, height: 1000 },
];

// What the web composer sends for the same batch (components/MessageInput.tsx).
function webSend(typed: string) {
  const submit: ComposerPicture[] = composer.map((img) => ({ previewUrl: img.uri, storageId: img.storageId }));
  const quoted = quotedImages(CONV, submit);
  const marked = composerMarkers(CONV, submit);
  const { text } = attachReviewForSend(CONV, typed, { composer: submit, firstQuoted: quoted.length ? submit.length + 1 : undefined });
  const attachments = [
    ...submit.map((p, i) => ({ storageId: p.storageId, markers: marked.get(i) })),
    ...quoted.map((q) => ({ storageId: q.storageId, markers: q.markers })),
  ];
  return { text, attachments };
}

describe('composePictureSend', () => {
  beforeEach(seedBatch);

  test('the text and the attachment order equal the web send of the same batch', () => {
    const web = webSend('fix these');
    seedBatch();
    const phone = composePictureSend(CONV, 'fix these', composer);
    expect(phone.content).toBe(web.text);
    expect(phone.pictures.map((p) => ({ storageId: p.storageId, markers: p.markers }))).toEqual(web.attachments);
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
  });

  test('composer pictures keep their places, the pinned one marked; quoted pictures follow as [Image 3] and [Image 4]', () => {
    const { content, pictures } = composePictureSend(CONV, 'fix these', composer);
    expect(pictures).toEqual([
      { src: 'file:///pick/one.jpg', storageId: 'c1', mime: 'image/jpeg', width: 3000, height: 2000 },
      { src: 'file:///pick/two.jpg', storageId: 'c2', mime: 'image/jpeg', width: 1000, height: 1000, markers: [{ x: 0.5, y: 0.25, number: 1 }] },
      { src: 'https://cdn.example/a.png', storageId: 'sA', mime: 'image/png', markers: [{ x: 0.25, y: 0.5, number: 1 }, { x: 0.75, y: 0.2, number: 2 }] },
      { src: 'https://cdn.example/b.png', storageId: 'sB', mime: 'image/png', markers: [{ x: 0.9, y: 0.1, number: 1 }] },
    ]);
    expect(content).toContain('> [Image 2] at marker 1\n\nlabel cut off');
    expect(content).toContain('> [Image 3] at marker 1');
    expect(content).toContain('> [Image 3] at marker 2');
    expect(content).toContain('> [Image 4] at marker 1');
    expect(content).toContain('> a paragraph the agent wrote\n\nnot this');
    expect(content.endsWith('\n\nfix these')).toBe(true);
  });

  test('notes with no typed words still make the message', () => {
    const { content } = composePictureSend(CONV, '', composer);
    expect(content).toStartWith('> ');
    expect(content).toContain('[Image 3] at marker 1');
  });

  test('with nothing pending the typed words and composer pictures go as they are', () => {
    useInboxStore.setState({ reviewComments: {} } as any);
    const { content, pictures } = composePictureSend(CONV, 'hello', composer);
    expect(content).toBe('hello');
    expect(pictures.every((p) => !p.markers)).toBe(true);
  });
});

describe('marked picture sizing', () => {
  test('the long side is capped the way the web caps it', () => {
    expect(fittedSize(5120, 2880)).toEqual({ w: 2560, h: 1440 });
    expect(fittedSize(800, 600)).toEqual({ w: 800, h: 600 });
  });

  test('iOS is asked for points at the screen scale, Android for pixels', () => {
    expect(snapshotPlan('ios', 1206, 2622, 3)).toEqual({ layout: { width: 402, height: 874 }, options: { width: 402, height: 874 } });
    expect(snapshotPlan('android', 1206, 2622, 3)).toEqual({ layout: { width: 402, height: 874 }, options: { width: 1206, height: 2622 } });
  });

  test("the snapshot's base64 decodes with iOS's line feeds in it", () => {
    expect([...base64Bytes('aGVs\nbG8=')]).toEqual([...new TextEncoder().encode('hello')]);
  });
});
