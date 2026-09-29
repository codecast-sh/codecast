// The cast player on published pages: which pages get it (the server injects
// its script, the CLI points the publisher at the guide) and the guide itself,
// printed by `cast publish video` so agents read it when they publish a video
// rather than carrying it in every session's instructions.

/** A page that shows a video gets the player script. */
export function pageUsesPlayer(html: string): boolean {
  return /<(cast-player|video)[\s>]/i.test(html);
}

export const CAST_PLAYER_GUIDE = `Videos on a published page play in the cast player.

A <video controls src="clip.mp4"> becomes the player by itself; its poster, title, id, class, style, width and height carry over. Add data-native to keep the browser's own player. Videos with autoplay or loop, or without controls, stay native, since they are ambient clips or driven by the page's script.

Chapters: one <cast-player> holding a <cast-chapter src="c01.mp4" title="Setup" duration="40.6"> per file plays them back to back as one film, with a segmented timeline and a chapter menu. Give each duration when you know it, so the timeline draws before the files load. A single file is <cast-player src="film.mp4" title="...">.

Style it from the page's CSS on the cast-player element:
  --cast-accent  --cast-fg  --cast-bg  --cast-panel  --cast-track
  --cast-radius  --cast-font  --cast-aspect (default 16/9)
  ::part(controls)  ::part(scrubber)  ::part(chapters)  ::part(play-button)

Script it: properties currentTime, duration, chapters (title, src, start, duration) and chapterIndex; methods play(), pause(), seek(seconds), goTo(index); events ready, chapterchange and timeupdate.

Links: #t=1:30 opens at a film time, #chapter=3 at the third chapter.

Video and audio files in a published directory (.mp4, .webm, .mov, .m4v, .mp3, .m4a, .ogg, .wav, up to 2 GB each) upload to media hosting and keep their relative paths; they do not count against the page's size limit.`;
