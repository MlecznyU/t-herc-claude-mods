import { expect, test } from 'claude-code/testing'

import { displayText, extractSpoken, splitSegments } from '../hooks/speech'

test('takes the closing spoken block, its language and plain paragraphs', async () => {
  const answer =
    'Table here.\n\n<spoken lang="en">Old</spoken>\n<spoken lang="pl-PL">Use **option B**, the `numbers`\n are in the table.\n\n\nSecond <lang code="en">pull request</lang> point.\n</spoken>'

  expect(extractSpoken(answer)).toEqual({
    language: 'pl',
    paragraphs: ['Use option B, the numbers are in the table.', 'Second <lang code="en">pull request</lang> point.'],
  })
})

test('tags mentioned in the written part are not read aloud', async () => {
  const answer =
    'The mod reads only the `<spoken lang="pl">…</spoken>` block, so I end with a proper `<spoken>` block now.\n\n<spoken lang="pl">Teraz działa.\n\nDrugi akapit.</spoken>\n'

  expect(extractSpoken(answer)).toEqual({ language: 'pl', paragraphs: ['Teraz działa.', 'Drugi akapit.'] })
})

test('a block that does not end the answer is not spoken', async () => {
  expect(extractSpoken('<spoken lang="pl">Wzmianka.</spoken> and the reply goes on.')).toBe(undefined)
  expect(extractSpoken('A mention of `</spoken>`')).toBe(undefined)
})

test('a paragraph without letters is left out', async () => {
  expect(extractSpoken('<spoken lang="pl">…\n\nTreść.</spoken>')?.paragraphs).toEqual(['Treść.'])
})

test('a block without a language leaves it to the caller', async () => {
  expect(extractSpoken('<spoken>Hello there.</spoken>')).toEqual({ language: undefined, paragraphs: ['Hello there.'] })
})

test('no spoken block or an empty one, nothing to say', async () => {
  expect(extractSpoken('Just text.')).toBe(undefined)
  expect(extractSpoken('<spoken lang="pl">  \n\n </spoken>')?.paragraphs).toEqual([])
  expect(extractSpoken('<spoken lang="pl"><lang code="en"> </lang></spoken>')?.paragraphs).toEqual([])
})

test('language inserts are shown without their tags', async () => {
  expect(displayText('Sprawdziłem <lang code="en">pull request</lang> i testy.')).toBe('Sprawdziłem pull request i testy.')
})

test('a paragraph splits into segments per language, any language', async () => {
  expect(splitSegments('Sprawdziłem <lang code="en">pull request</lang> i <lang code="de-DE">Ordnung</lang>', 'pl')).toEqual([
    { language: 'pl', text: 'Sprawdziłem' },
    { language: 'en', text: 'pull request' },
    { language: 'pl', text: 'i' },
    { language: 'de', text: 'Ordnung' },
  ])
  expect(splitSegments('Bez wstawek.', 'pl')).toEqual([{ language: 'pl', text: 'Bez wstawek.' }])
})

test('an insert in the paragraph language joins its neighbours', async () => {
  expect(splitSegments('Check the <lang code="en">pull request</lang> now.', 'en')).toEqual([
    { language: 'en', text: 'Check the pull request now.' },
  ])
})
