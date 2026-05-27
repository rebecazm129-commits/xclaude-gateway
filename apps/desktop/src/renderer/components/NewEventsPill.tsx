import styles from './NewEventsPill.module.css';

interface Props {
  count: number;
  onClick: () => void;
}

export function NewEventsPill({ count, onClick }: Props): JSX.Element {
  const label = count === 1 ? '1 new event' : `${count} new events`;
  return (
    <button
      type="button"
      className={styles['pill']}
      onClick={onClick}
      aria-label={`Scroll to top, ${label}`}
    >
      <span className={styles['arrow']} aria-hidden="true">↑</span>
      <span>{label}</span>
    </button>
  );
}
