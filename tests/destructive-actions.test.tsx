/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {useConfirm} from '../apps/web/src/Confirm';
import {dayLabel,startsNewDay} from '../apps/web/src/App';

/**
 * Asking before something irreversible, without leaving the product to do it.
 *
 * `window.confirm` was why Delete room and Remove agent did nothing at all: a host that does not
 * implement the dialog returns false immediately and shows nothing, so `if (!confirm(...)) return;`
 * swallowed every click. Owning the dialog removes the dependency, and lets it do the two things
 * the browser's cannot — show that work is happening, and say so when it fails.
 */
describe('confirming something destructive', () => {
  function Harness({run}: {run: () => Promise<void>}) {
    const {confirm, dialog} = useConfirm();
    return <>
      <button onClick={() => confirm({
        title: 'Delete Launch room?', detail: 'Everyone loses access.',
        action: 'Delete room', run,
      })}>Delete room</button>
      {dialog}
    </>;
  }

  afterEach(cleanup);

  it('asks first, and does nothing until the person agrees', async () => {
    const run = vi.fn(async () => {});
    render(<Harness run={run}/>);
    fireEvent.click(screen.getByRole('button', {name: 'Delete room'}));

    expect(await screen.findByRole('alertdialog')).toBeVisible();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('does the work when they agree, and closes', async () => {
    const run = vi.fn(async () => {});
    render(<Harness run={run}/>);
    fireEvent.click(screen.getByRole('button', {name: 'Delete room'}));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', {name: 'Delete room'}));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  /** The failure mode this replaces: something went wrong and the screen said nothing. */
  it('says what went wrong instead of closing silently', async () => {
    render(<Harness run={async () => {throw new Error('Room manager access is required')}}/>);
    fireEvent.click(screen.getByRole('button', {name: 'Delete room'}));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', {name: 'Delete room'}));

    expect(await screen.findByRole('alert')).toHaveTextContent('Room manager access is required');
    // Still open, so the person can see it and decide what to do.
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });
});


/**
 * Which day something was said.
 *
 * A room keeps its history, so a column of times with no dates reads as though all of it happened
 * this afternoon. The stored timestamp is never altered — this only decides the label.
 */
describe('dating a conversation', () => {
  const now = new Date('2026-09-04T12:00:00');
  const at = (iso: string) => new Date(iso).toISOString();

  it('names today and yesterday rather than dating them', () => {
    expect(dayLabel(at('2026-09-04T09:15:00'), now)).toBe('Today');
    expect(dayLabel(at('2026-09-03T23:59:00'), now)).toBe('Yesterday');
  });

  it('dates anything older', () => {
    expect(dayLabel(at('2026-09-02T10:00:00'), now)).toMatch(/Sep\s*2/);
    // Outside this year the year is the whole point rather than noise.
    expect(dayLabel(at('2025-12-30T10:00:00'), now)).toMatch(/2025/);
  });

  it('starts a new day only when the day actually changes', () => {
    expect(startsNewDay(at('2026-09-04T09:00:00'))).toBe(true);
    expect(startsNewDay(at('2026-09-04T09:00:00'), at('2026-09-04T08:00:00'))).toBe(false);
    expect(startsNewDay(at('2026-09-04T00:05:00'), at('2026-09-03T23:55:00'))).toBe(true);
  });
});
