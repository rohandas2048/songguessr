import type { Attempt } from '../game/useGame.ts';

interface Props {
  ladder: readonly number[];
  rung: number;
  attempts: Attempt[];
}

export function Ladder({ ladder, rung, attempts }: Props) {
  return (
    <ol className="ladder">
      {ladder.map((seconds, i) => {
        const attempt = attempts[i];
        const state = attempt?.correct ? 'hit' : attempt ? 'miss' : i === rung ? 'current' : 'locked';
        return (
          <li key={i} className={`rung ${state}`}>
            <span className="rung-time">{seconds}s</span>
            <span className="rung-detail">
              {attempt?.correct
                ? attempt.track?.title
                : attempt
                  ? (attempt.track?.title ?? 'skipped')
                  : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
