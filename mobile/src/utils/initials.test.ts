import { firstCharacter, initials } from './initials';

test('initials from plain names', () => {
  expect(initials('Sai Nath')).toBe('SN');
  expect(initials('qa_bob')).toBe('QB');
  expect(initials('')).toBe('?');
  expect(initials(null)).toBe('?');
});

test('emoji stay whole', () => {
  expect(initials('🏠 Flat')).toBe('🏠F');
  expect(initials('🎉')).toBe('🎉');
  expect(firstCharacter('👍🏽 nice')).toBe('👍🏽'); // skin tone
  expect(firstCharacter('👨‍👩‍👧 family')).toBe('👨‍👩‍👧'); // joined
  expect(firstCharacter('🇮🇳 India')).toBe('🇮🇳'); // flag
  expect(firstCharacter('❤️ team')).toBe('❤️'); // variation selector
  expect(initials('Goa 🏖️')).toBe('G🏖️');
});

test('Indian scripts keep their vowel signs', () => {
  expect(firstCharacter('సాయి')).toBe('సా');
  expect(firstCharacter('हिंदी')).toBe('हिं'); // the nasal mark belongs to the first letter
});
