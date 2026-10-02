// The edition's headline and standfirst (spec 4.3): the one large prose
// element. Before prose exists the headline is the day's counts in large type
// and the standfirst keeps its height, so prose arriving never moves the page.
// Filters never rewrite it; a deterministic line under it says what is shown.
import { FadeText } from "./StoryParts";

export function EditionHead({ headline, standfirst, reserve, filterLine, onClear }: {
  headline: string;
  standfirst: string | null;
  /** Keep the standfirst's height while prose may still arrive. */
  reserve: boolean;
  filterLine: string | null;
  onClear: () => void;
}) {
  return (
    <div>
      <h2 className="chg-headline text-sol-text line-clamp-2">
        <FadeText text={headline} />
      </h2>
      {(standfirst || reserve) && (
        <p className="chg-ui chg-standfirst mt-2.5 min-h-[4.8em] text-[15px] leading-[1.6] text-sol-text/80">
          {standfirst && <FadeText text={standfirst} />}
        </p>
      )}
      {filterLine && (
        <p className="mt-2 flex items-center gap-2 font-mono text-[11px] text-sol-text/55">
          {filterLine}
          <button type="button" onClick={onClear} className="rounded px-1 text-sol-text/55 underline-offset-2 hover:text-sol-text hover:underline">
            clear
          </button>
        </p>
      )}
    </div>
  );
}
