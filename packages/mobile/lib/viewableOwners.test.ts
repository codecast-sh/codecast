// A phone list reads the owners of the rows on screen: the viewable session
// rows under the owners model, in list order, replace the list's holds whole.
import { expect, test } from 'bun:test';
import { ownerCardsKey, setViewableOwnerCards } from '@codecast/web/lib/visibleOwnerCards';
import { viewableOwnerIds } from './viewableOwners';

const id = (i: number) => `jx7${String(i).padStart(29, '0')}`;
const item = (i: number, owners = true) => ({ index: i, item: { kind: 'row', session: { _id: id(i), ...(owners ? { owners_model: true } : {}) } } });

test('of 100 mounted rows only the viewable ones under the model are read, and a scroll replaces them', () => {
  const header = { index: 0, item: { kind: 'header' } };
  const shown = [header, ...[12, 10, 11, 13].map((i) => item(i)), item(14, false)];
  expect(viewableOwnerIds(shown)).toEqual([id(10), id(11), id(12), id(13)]);
  setViewableOwnerCards('inbox', viewableOwnerIds(shown));
  expect(ownerCardsKey()).toBe([id(10), id(11), id(12), id(13)].join(','));
  setViewableOwnerCards('inbox', viewableOwnerIds([item(13), item(15)]));
  expect(ownerCardsKey()).toBe([id(13), id(15)].join(','));
  setViewableOwnerCards('inbox', []);
  expect(ownerCardsKey()).toBe('');
});

test('past 60 viewable rows the topmost 60 are read', () => {
  setViewableOwnerCards('inbox', viewableOwnerIds(Array.from({ length: 80 }, (_, i) => item(i))));
  expect(ownerCardsKey().split(',')).toEqual(Array.from({ length: 60 }, (_, i) => id(i)));
  setViewableOwnerCards('inbox', []);
});
